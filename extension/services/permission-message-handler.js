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

  const plog = (lvl, ev, data) => { try { if (globalThis.AmitLog) globalThis.AmitLog[lvl](ev, data); } catch (_) {} };

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
    const graph = globalThis.AmitGraphClient.create({ fetch: (u, i) => fetch(u, i), tokens, log: plog });
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
