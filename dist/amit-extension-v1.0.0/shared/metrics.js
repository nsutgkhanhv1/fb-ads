/**
 * AMIT V1 - Metrics (docx kiến trúc §17 AC10 / AC11, §18.1)
 *
 * Ghi lại kết quả từng target và tính số liệu nghiệm thu để so Graph engine với DOM engine:
 *   AC10  tỷ lệ xác minh thành công của Graph engine  >= ngưỡng do đội sản phẩm đặt (cấu hình, KHÔNG có mặc định)
 *   AC11  P95 thời gian mỗi target của Graph engine   <  P95 của DOM engine trên CÙNG tập (TKQC + action)
 *
 * Quy ước đo (ghi rõ để con số không bị hiểu sai):
 *  - Thời gian mỗi target = thời gian TKQC chạy xong (từ lúc bắt đầu đến lúc có kết quả, gồm điều hướng / inject với DOM,
 *    gồm nghỉ 1-3 giây giữa các UID với Graph) chia đều cho số target; KHÔNG gồm thời gian chờ backoff rate limit
 *    và KHÔNG gồm delay giữa các TKQC (hai engine đều không tính).
 *  - Tỷ lệ xác minh = target có đọc lại (verify_state MATCH / MISSING / MISMATCH / UNAVAILABLE) mà MATCH và SUCCESS.
 *    Lỗi trước khi tới bước xác minh (input, quyền, danh tính...) được đếm riêng, không làm giảm tỷ lệ này.
 *  - Mọi phép so sánh chỉ lấy lần chạy đầu (bỏ qua Retry); AC11 chỉ lấy target SUCCESS để so cùng loại với cùng loại.
 *  - Chưa đủ mẫu (mặc định 30 mỗi bên) hoặc chưa đặt ngưỡng thì trả INSUFFICIENT_DATA / NO_THRESHOLD, không đoán PASS.
 *
 * Dữ liệu KHÔNG chứa token, cookie, UID, tên người dùng hay nội dung lỗi; chỉ có ID TKQC (cần để ghép "cùng tập TKQC").
 */
(function (root) {
  "use strict";

  const KEY = "amit_metrics";
  const CAPS = Object.freeze({ targets: 5000, events: 2000, requests: 8000 });
  const VERIFY_STATES = Object.freeze(["MATCH", "MISSING", "MISMATCH", "UNAVAILABLE"]);
  const DEFAULT_CONFIG = Object.freeze({ ac10_min_verified_rate: null, min_samples: 30 });
  const FLUSH_DELAY_MS = 500;

  // ---------------- tiện ích ----------------
  /** Nearest-rank percentile; null nếu không có dữ liệu. */
  function percentile(values, p) {
    if (!values.length) return null;
    const a = values.slice().sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1))];
  }
  const ratio = (n, d) => (d ? n / d : null);
  const maskId = id => { const s = String(id === undefined || id === null ? "" : id); return s.length > 6 ? `${s.slice(0, 3)}…${s.slice(-3)}` : s; };

  /** /v24.0/act_123/users/456 -> /act_{id}/users/{uid} (không để ID thật lọt vào nhãn endpoint). */
  function normalizeEndpoint(path) {
    return String(path || "").replace(/^\/v\d+\.\d+/, "").replace(/act_\d+/g, "act_{id}")
      .replace(/\/(users|assigned_users)\/\d+/, "/$1/{uid}").replace(/\/\d{5,}/g, "/{id}");
  }

  /** Đếm theo bộ trường: [{...fields, count}] giảm dần theo count. */
  function tally(list, fields) {
    const m = new Map();
    list.forEach(r => {
      const key = JSON.stringify(fields.map(f => (r[f] === undefined ? null : r[f])));
      const cur = m.get(key) || Object.assign(Object.fromEntries(fields.map(f => [f, r[f] === undefined ? null : r[f]])), { count: 0 });
      cur.count++;
      m.set(key, cur);
    });
    return [...m.values()].sort((a, b) => b.count - a.count);
  }

  // ---------------- ghi nhận ----------------
  /**
   * Một TKQC đã có kết quả cuối (SUCCESS / FAILED) -> các bản ghi target.
   * ctx: { ts, batch_id, engine, is_retry, item_ms, backoff_ms }. KHÔNG gọi cho kết quả PAUSED (chưa xong).
   */
  function targetRecords(ctx, result) {
    const targets = result.targets || [];
    const n = Math.max(1, targets.length);
    const net = Math.max(0, Math.round((ctx.item_ms || 0) - (ctx.backoff_ms || 0)));
    const base = {
      ts: ctx.ts, batch_id: ctx.batch_id || null, engine: result.engine || ctx.engine || "dom", is_retry: !!ctx.is_retry,
      action: result.action, role: result.role || null, ad_account_id: result.ad_account_id,
      item_ms: net, target_ms: Math.round(net / n)
    };
    if (!targets.length) {
      // lỗi mức TKQC (chưa có target) hoặc không có gì để làm
      return [Object.assign(base, {
        account_level: true, status: result.status === "SUCCESS" ? "SUCCESS" : "FAILED", error_code: result.error_code || null,
        verify_state: null, method_used: null, retryable: result.retryable === undefined ? null : result.retryable, note: result.note || null
      })];
    }
    return targets.map(t => Object.assign({}, base, {
      account_level: false, status: t.status === "SUCCESS" ? "SUCCESS" : "FAILED", error_code: t.error_code || null,
      verify_state: t.verify_state || null, method_used: t.method_used || null,
      retryable: t.retryable === undefined ? null : t.retryable, note: t.note || null
    }));
  }

  // ---------------- tổng hợp ----------------
  function engineStats(rs) {
    const success = rs.filter(r => r.status === "SUCCESS");
    const failed = rs.filter(r => r.status !== "SUCCESS");
    const verifiable = rs.filter(r => VERIFY_STATES.includes(r.verify_state));
    const verifiedOk = verifiable.filter(r => r.status === "SUCCESS" && r.verify_state === "MATCH");
    const beforeVerify = failed.filter(r => !VERIFY_STATES.includes(r.verify_state));
    const ms = success.map(r => r.target_ms);
    const itemMs = success.map(r => r.item_ms);
    return {
      targets: rs.length,
      success: success.length,
      failed: failed.length,
      success_rate: ratio(success.length, rs.length),
      verifiable: verifiable.length,
      verified_ok: verifiedOk.length,
      verified_rate: ratio(verifiedOk.length, verifiable.length), // chỉ có ý nghĩa với Graph engine (DOM không có verify_state)
      failed_before_verify: beforeVerify.length,
      top_errors: tally(failed, ["error_code"]).slice(0, 8),
      latency: { samples: ms.length, p50_ms: percentile(ms, 50), p95_ms: percentile(ms, 95), item_p95_ms: percentile(itemMs, 95) }
    };
  }

  function judgeAc10(g, cfg) {
    const out = { id: "AC10", samples: g.verifiable, verified_rate: g.verified_rate, threshold: cfg.ac10_min_verified_rate, min_samples: cfg.min_samples, status: null };
    if (cfg.ac10_min_verified_rate === null || cfg.ac10_min_verified_rate === undefined) out.status = "NO_THRESHOLD";
    else if (g.verifiable < cfg.min_samples) out.status = "INSUFFICIENT_DATA";
    else out.status = g.verified_rate >= cfg.ac10_min_verified_rate ? "PASS" : "FAIL";
    return out;
  }

  function judgeAc11(graphRs, domRs, cfg) {
    const key = r => `${r.ad_account_id}|${r.action}`;
    const ok = rs => rs.filter(r => r.status === "SUCCESS");
    const g = ok(graphRs), d = ok(domRs);
    const dKeys = new Set(d.map(key));
    const common = new Set(g.map(key).filter(k => dKeys.has(k)));
    const gMs = g.filter(r => common.has(key(r))).map(r => r.target_ms);
    const dMs = d.filter(r => common.has(key(r))).map(r => r.target_ms);
    const out = {
      id: "AC11", common_sets: common.size, graph_samples: gMs.length, dom_samples: dMs.length, min_samples: cfg.min_samples,
      graph_p95_ms: percentile(gMs, 95), dom_p95_ms: percentile(dMs, 95), graph_p50_ms: percentile(gMs, 50), dom_p50_ms: percentile(dMs, 50), status: null
    };
    if (!common.size || Math.min(gMs.length, dMs.length) < cfg.min_samples) out.status = "INSUFFICIENT_DATA";
    else out.status = out.graph_p95_ms < out.dom_p95_ms ? "PASS" : "FAIL";
    return out;
  }

  /** data: { targets, events, requests, since }. Trả số liệu cho Web/Log; không có gì nhạy cảm. */
  function summarize(data, config) {
    const cfg = Object.assign({}, DEFAULT_CONFIG, config);
    const first = data.targets.filter(r => !r.is_retry);
    const byEngine = e => first.filter(r => r.engine === e);
    const graph = engineStats(byEngine("graph"));
    const dom = engineStats(byEngine("dom"));
    const durations = new Map();
    data.requests.forEach(r => {
      const k = `${r.method} ${r.endpoint}`;
      if (!durations.has(k)) durations.set(k, { endpoint: r.endpoint, method: r.method, ms: [], errors: 0 });
      const d = durations.get(k);
      d.ms.push(r.ms);
      if (!r.ok) d.errors++;
    });
    const events = name => data.events.filter(e => e.name === name);
    return {
      generated_at: new Date().toISOString(),
      since: data.since || null,
      config: cfg,
      sample: { targets: data.targets.length, first_attempt: first.length, retries: data.targets.length - first.length, truncated: data.targets.length >= CAPS.targets },
      engines: { graph, dom },
      ac10: judgeAc10(graph, cfg),
      ac11: judgeAc11(byEngine("graph"), byEngine("dom"), cfg),
      // docx §18.1
      permission_requests_total: tally(data.targets, ["engine", "action", "role", "method_used", "status"]),
      permission_duration_ms: [...durations.values()].map(d => ({ endpoint: d.endpoint, method: d.method, count: d.ms.length, errors: d.errors, p50_ms: percentile(d.ms, 50), p95_ms: percentile(d.ms, 95) }))
        .sort((a, b) => b.count - a.count),
      permission_verify_total: tally(data.targets.filter(r => r.verify_state), ["verify_state"]),
      token_refresh_total: tally(events("token_refresh"), ["slot", "reason"]),
      batch_paused_total: tally(events("batch_paused"), ["reason"]),
      retry_total: tally(events("retry"), ["error_code", "attempt"]),
      rate_backoff_total: tally(events("rate_backoff"), ["attempt"])
    };
  }

  // ---------------- lưu trữ ----------------
  function emptyData(now) { return { version: 1, since: new Date(now).toISOString(), targets: [], events: [], requests: [] }; }

  function normalizeData(v, now) {
    const d = emptyData(now);
    if (!v || typeof v !== "object") return d;
    ["targets", "events", "requests"].forEach(k => { if (Array.isArray(v[k])) d[k] = v[k].slice(-CAPS[k]); });
    if (v.since) d.since = v.since;
    return d;
  }

  /** deps: { read() -> Promise<data|undefined>, write(data) -> Promise, now() }. Ghi gộp (debounce) để không ghi mỗi request. */
  function createStore(deps) {
    const now = deps.now || (() => Date.now());
    let data = null, loading = null, timer = null, writing = Promise.resolve();

    const load = () => {
      if (data) return Promise.resolve(data);
      if (!loading) loading = Promise.resolve(deps.read()).catch(() => undefined).then(v => { data = normalizeData(v, now()); return data; });
      return loading;
    };
    const flush = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      writing = writing.then(() => (data ? deps.write(data) : undefined)).catch(() => {});
      return writing;
    };
    const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; flush(); }, deps.flushDelayMs === undefined ? FLUSH_DELAY_MS : deps.flushDelayMs); };

    async function add(kind, rec) {
      const d = await load();
      if (!d[kind]) return;
      d[kind].push(rec);
      if (d[kind].length > CAPS[kind]) d[kind].splice(0, d[kind].length - CAPS[kind]);
      schedule();
    }
    async function addMany(kind, recs) { for (const r of recs) await add(kind, r); }
    async function snapshot() { return load(); }
    async function clear() { data = emptyData(now()); loading = Promise.resolve(data); await flush(); }

    return { add, addMany, snapshot, clear, flush };
  }

  /** Bản xuất cho đội sản phẩm: che ID TKQC ở giữa. */
  function exportData(data, summary) {
    return {
      exported_at: new Date().toISOString(), since: data.since,
      summary,
      targets: data.targets.map(r => Object.assign({}, r, { ad_account_id: maskId(r.ad_account_id) })),
      events: data.events, requests: data.requests
    };
  }

  /** Cấu hình do người dùng nhập: kiểm tra chặt, giá trị sai bị từ chối thay vì âm thầm sửa. */
  function validateConfig(patch) {
    const out = {};
    if (patch && "ac10_min_verified_rate" in patch) {
      const v = patch.ac10_min_verified_rate;
      if (v === null) out.ac10_min_verified_rate = null;
      else if (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1) out.ac10_min_verified_rate = v;
      else return { error: "Ngưỡng AC10 phải nằm trong (0, 1] hoặc để trống." };
    }
    if (patch && "min_samples" in patch) {
      const v = patch.min_samples;
      if (Number.isInteger(v) && v >= 1 && v <= 100000) out.min_samples = v;
      else return { error: "Số mẫu tối thiểu phải là số nguyên từ 1 đến 100000." };
    }
    return { value: out };
  }

  const api = { KEY, CAPS, DEFAULT_CONFIG, VERIFY_STATES, percentile, maskId, normalizeEndpoint, tally, targetRecords, summarize, createStore, exportData, validateConfig };
  root.AmitMetrics = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
