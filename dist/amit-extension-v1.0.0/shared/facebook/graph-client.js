/**
 * AMIT V1 - Graph client (docx §8)
 *
 * - Mặc định Graph v24.0; ngoại lệ phiên bản đặt ở từng contract (opts.version).
 * - Mutation gửi dạng application/x-www-form-urlencoded; access_token đi trong body (POST) hoặc query (GET) và
 *   KHÔNG BAO GIỜ xuất hiện trong log / telemetry / lỗi.
 * - Timeout mặc định 60 giây; hỗ trợ AbortSignal từ nơi gọi.
 * - Token lỗi: invalidate đúng slot rồi thử lại TỐI ĐA MỘT LẦN (request đã bị Facebook từ chối nên an toàn kể cả mutation).
 * - Mutation gặp timeout / mạng / 5xx: KHÔNG tự thử lại (trạng thái chưa xác định). FbError.ambiguous = true để
 *   Permission Service đọc lại và xác minh trước khi quyết định.
 * - GET gặp lỗi tạm thời / mạng: thử lại một lần sau khoảng nghỉ ngắn.
 * - Rate limit: không thử lại; ném RATE_LIMITED (pause=true) để batch giữ hàng đợi.
 *
 * deps: { fetch, tokens (AmitTokenProvider instance), sleep(ms), log(level,event,data), timeoutMs, baseUrl,
 *         onRequest({ endpoint, method, mutation, ms, ok, error_code, http_status }) }  // tùy chọn: số liệu cho AC11 / docx §18.1
 */
(function (root) {
  "use strict";

  const DEFAULT_VERSION = "v24.0";
  const DEFAULT_BASE = "https://graph.facebook.com";
  const DEFAULT_TIMEOUT_MS = 60000;

  let seq = 0;

  function create(deps) {
    const Err = () => root.AmitFbErrors;
    const log = deps.log || (() => {});
    const sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const fetchImpl = deps.fetch;
    const baseUrl = deps.baseUrl || DEFAULT_BASE;
    const report = info => { if (deps.onRequest) { try { deps.onRequest(info); } catch (_) { /* số liệu không được làm hỏng request */ } } };
    const defaultTimeout = deps.timeoutMs || DEFAULT_TIMEOUT_MS;

    async function send(tk, path, o) {
      const url = new URL(`${baseUrl}/${o.version}${path}`);
      const init = { method: o.method === "GET" ? "GET" : "POST", credentials: "include", headers: { Accept: "application/json" } };
      const params = Object.assign({}, o.params);
      if (o.method === "GET") {
        Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
        url.searchParams.set("access_token", tk.token);
      } else {
        const body = new URLSearchParams(params);
        body.set("access_token", tk.token);
        init.body = body;
        init.headers["Content-Type"] = "application/x-www-form-urlencoded";
      }

      const ctl = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, o.timeoutMs);
      const onAbort = () => ctl.abort();
      if (o.signal) {
        if (o.signal.aborted) ctl.abort(); else o.signal.addEventListener("abort", onAbort, { once: true });
      }
      init.signal = ctl.signal;

      let res, text;
      try {
        res = await fetchImpl(url.toString(), init);
        text = await res.text();
      } catch (e) {
        if (o.signal && o.signal.aborted && !timedOut) {
          throw new (Err().FbError)("CANCELLED", "Đã hủy.", { category: "input", ambiguous: !!o.mutation });
        }
        const fe = Err().classifyTransport(e, timedOut);
        fe.ambiguous = !!o.mutation || fe.ambiguous;
        throw fe;
      } finally {
        clearTimeout(timer);
        if (o.signal) o.signal.removeEventListener("abort", onAbort);
      }

      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* không phải JSON */ }

      if (json && json.error) throw Err().classifyGraphError(res.status, json.error, res.headers);
      if (!res.ok) throw Err().classifyHttp(res.status, res.headers);
      if (json === null) {
        // HTML (ví dụ trang đăng nhập) thay vì JSON
        const redirected = Err().classifyUrl(res.url);
        if (redirected) throw redirected;
        throw new (Err().FbError)("GRAPH_RESPONSE_INVALID", "Facebook trả về nội dung không phải JSON.", { category: "contract" });
      }
      return json;
    }

    /**
     * request(path, { method, params, tokenPurpose, expectedUid, version, timeoutMs, signal, mutation, requestId })
     * Trả về body JSON. Lỗi luôn là FbError.
     */
    async function request(path, opts) {
      const o = Object.assign({ method: "GET", params: {}, tokenPurpose: "powerEditorAction", version: DEFAULT_VERSION, timeoutMs: defaultTimeout }, opts || {});
      o.mutation = o.mutation !== undefined ? o.mutation : o.method !== "GET";
      const id = o.requestId || `g${++seq}`;
      let tokenRetried = false;
      let transientRetried = false;

      for (;;) {
        const tk = await deps.tokens.get(o.tokenPurpose, { expectedUid: o.expectedUid || null });
        log("debug", "permission.request_sent", { request_id: id, method: o.method, path, mutation: o.mutation, version: o.version, token_slot: tk.slot });
        const t0 = Date.now();
        try {
          const json = await send(tk, path, o);
          log("debug", "permission.response_classified", { request_id: id, ok: true, ms: Date.now() - t0, success: json && json.success });
          report({ endpoint: path, method: o.method, mutation: o.mutation, ms: Date.now() - t0, ok: true });
          return json;
        } catch (e) {
          if (!(e instanceof Err().FbError)) throw e;
          report({ endpoint: path, method: o.method, mutation: o.mutation, ms: Date.now() - t0, ok: false, error_code: e.error_code, http_status: e.http_status });
          log(e.pause ? "warn" : "debug", "permission.response_classified", { request_id: id, ok: false, ms: Date.now() - t0, error_code: e.error_code, category: e.category, http_status: e.http_status, graph_code: e.graph_code, graph_subcode: e.graph_subcode, fbtrace_id: e.fbtrace_id });

          if (e.category === "token") {
            deps.tokens.invalidate(o.tokenPurpose, tk.generation);
            if (!tokenRetried) { tokenRetried = true; continue; }
            throw e; // vẫn SESSION_EXPIRED sau khi lấy token mới -> pause
          }
          // Chỉ GET (idempotent) mới được thử lại khi lỗi tạm thời / mạng; timeout và hủy thì không.
          const transient = e.category === "temporary" || e.error_code === "NETWORK_ERROR";
          if (!o.mutation && transient && !transientRetried) { transientRetried = true; await sleep(700); continue; }
          throw e;
        }
      }
    }

    return { request, DEFAULT_VERSION };
  }

  const api = { create, DEFAULT_VERSION, DEFAULT_TIMEOUT_MS };
  root.AmitGraphClient = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
