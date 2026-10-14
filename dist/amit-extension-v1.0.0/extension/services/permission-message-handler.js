/**
 * AMIT V1 - Permission runtime + message handler (docx §4, §14.1)
 *
 * - Dựng các singleton của Graph engine trong service worker: Token Provider, Graph Client, deps cho Permission Service.
 * - Feature flag `super_share_engine` ("dom" | "graph") lưu ở chrome.storage.local[amit_flags]. Mặc định "dom"
 *   cho tới khi Graph engine đạt tiêu chí nghiệm thu (docx §15, AC12).
 * - Message `permission_execute`: chạy MỘT lệnh PermissionCommand (GRANT | CHANGE | REVOKE) và trả PermissionResult chuẩn.
 *   Chỉ nhận từ trang của chính extension; token không bao giờ có trong response.
 *
 * Phụ thuộc toàn cục (đã có trong background.js): getFacebookCookie(), resolveFacebookSession(), AmitLog.
 */

const AMIT_FLAGS_KEY = "amit_flags";
const AMIT_ENGINES = ["dom", "graph"];

const AmitPermissionRuntime = (function () {
  let runtime = null;

  const plog = (lvl, ev, data) => {
    try { if (globalThis.AmitLog) globalThis.AmitLog[lvl](ev, data); } catch (_) {}
    // token_refresh_total (docx §18.1): làm mới theo nguồn, và hủy do Graph báo token lỗi
    if (ev === "token.refreshed" && typeof metricsEvent === "function") metricsEvent("token_refresh", { slot: data && data.slot, reason: data && data.via_type });
    if (ev === "token.invalidated" && typeof metricsEvent === "function") metricsEvent("token_refresh", { slot: data && data.slot, reason: "invalidated" });
  };

  async function verifyOwner(token) {
    const C = globalThis.AmitPermissionContracts;
    const E = globalThis.AmitFbErrors;
    let res;
    try {
      res = await fetch(`https://graph.facebook.com/${C.VERSION}/me?fields=id&access_token=${encodeURIComponent(token)}`, { credentials: "include" });
    } catch (e) {
      throw E.classifyTransport(e, false);
    }
    let json = null;
    try { json = JSON.parse(await res.text()); } catch (_) { /* không phải JSON */ }
    if (json && json.error) throw E.classifyGraphError(res.status, json.error, res.headers);
    return json && json.id ? String(json.id) : null;
  }

  function get() {
    if (runtime) return runtime;
    const tokens = globalThis.AmitTokenProvider.create({
      getCookie: name => getFacebookCookie(name),
      fetchPage: async url => {
        const res = await fetch(url, { credentials: "include" });
        return { url: res.url, status: res.status, text: await res.text() };
      },
      loadLegacySession: async () => {
        const s = await resolveFacebookSession(false);
        return s && s.accessToken ? { uid: s.uid, accessToken: s.accessToken } : null;
      },
      verifyOwner,
      log: plog
    });
    const graph = globalThis.AmitGraphClient.create({
      fetch: (u, i) => fetch(u, i), tokens, log: plog,
      onRequest: info => { if (typeof metricsRequest === "function") metricsRequest(info); }
    });
    runtime = {
      tokens,
      graph,
      deps: {
        graph, tokens, log: plog,
        sleep: ms => new Promise(r => setTimeout(r, ms)),
        random: Math.random,
        policy: { fallbackOnTargetError: true }
      }
    };
    return runtime;
  }

  /** Dùng trong test để thay thế fetch / token. */
  function setForTest(rt) { runtime = rt; }

  return { get, setForTest };
})();

async function getSuperShareEngine() {
  try {
    const store = await chrome.storage.local.get(AMIT_FLAGS_KEY);
    const v = store[AMIT_FLAGS_KEY] && store[AMIT_FLAGS_KEY].super_share_engine;
    return AMIT_ENGINES.includes(v) ? v : "dom";
  } catch (_) {
    return "dom";
  }
}

async function setSuperShareEngine(engine) {
  if (!AMIT_ENGINES.includes(engine)) return { ok: false, error: "INVALID_INPUT", message: "engine phải là dom hoặc graph." };
  const store = await chrome.storage.local.get(AMIT_FLAGS_KEY);
  const flags = Object.assign({}, store[AMIT_FLAGS_KEY], { super_share_engine: engine });
  await chrome.storage.local.set({ [AMIT_FLAGS_KEY]: flags });
  return { ok: true, engine };
}

const PREVIEW_MAX_ITEMS = 20; // mỗi lần gọi; Web chia nhỏ để service worker không bị tắt giữa chừng

/**
 * super_share_preview: dựng kế hoạch xóa (chỉ ĐỌC) cho các TKQC trước khi người dùng xác nhận.
 * Chỉ Graph engine mới đọc được state mà không mở Ads Manager; DOM engine trả ENGINE_NOT_GRAPH.
 * Dừng sớm khi gặp PAUSED (session, checkpoint, rate limit) để không đọc tiếp khi Facebook đang chặn.
 */
async function handleSuperSharePreview(items) {
  const SS = globalThis.AmitSuperShareCore;
  const PS = globalThis.AmitPermissionService;
  if (!Array.isArray(items) || !items.length) return { success: false, error: "INVALID_INPUT", message: "Danh sách TKQC rỗng." };
  if (items.length > PREVIEW_MAX_ITEMS) return { success: false, error: "INVALID_INPUT", message: `Tối đa ${PREVIEW_MAX_ITEMS} TKQC mỗi lần xem trước.` };
  if ((await getSuperShareEngine()) !== "graph") {
    return { success: false, error: "ENGINE_NOT_GRAPH", message: "Xem trước kế hoạch chỉ có ở Graph engine." };
  }
  for (const raw of items) {
    const n = SS.normalizeItem(raw || {});
    const bad = SS.validateItem(n);
    if (bad) return { success: false, error: bad.error_code, message: `TKQC ${n.ad_account_id || "?"}: ${bad.message}` };
    if (!SS.ACTION_DEFS[n.action].preview) return { success: false, error: "INVALID_INPUT", message: `Action ${n.action} không cần xem trước.` };
  }

  const rt = AmitPermissionRuntime.get();
  const previews = [];
  for (const raw of items) {
    const p = await PS.previewItem(rt.deps, raw, {});
    previews.push(p);
    if (p.status === "PAUSED") break;
  }
  return { success: true, previews, complete: previews.length === items.length };
}

/** permission_execute: validate lại toàn bộ command trong service worker (không tin workspace). */
async function handlePermissionExecute(command) {
  const SS = globalThis.AmitSuperShareCore;
  const PS = globalThis.AmitPermissionService;
  const cmd = command && typeof command === "object" ? command : {};
  const raw = PS.commandToItem(cmd);
  const bad = SS.validateItem(SS.normalizeItem(raw));
  if (!/^(GRANT|CHANGE|REVOKE)$/i.test(String(cmd.action || ""))) {
    return { success: false, error: "INVALID_INPUT", message: "action phải là GRANT, CHANGE hoặc REVOKE." };
  }
  if (!/^\d+$/.test(String(cmd.target_uid || ""))) return { success: false, error: "INVALID_INPUT", message: "target_uid không hợp lệ." };
  if (bad) return { success: false, error: bad.error_code, message: bad.message };

  const rt = AmitPermissionRuntime.get();
  const itemResult = await PS.runItem(rt.deps, raw, { requestId: cmd.request_id });
  return { success: true, result: PS.toPermissionResult(cmd, itemResult) };
}
