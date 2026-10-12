/**
 * AMIT V1 - Super Share Batch Controller (service worker)
 *
 * Điều phối batch theo "SUPER SHARE FACEBOOK EXECUTION REQUIREMENT V1":
 *   - Mỗi TKQC là một đơn vị xử lý, chạy TUẦN TỰ (docx §12, §37).
 *   - Một TKQC FAILED không dừng batch; SESSION_EXPIRED / FACEBOOK_CHECKPOINT thì PAUSE (§14, §15).
 *   - Gửi kết quả NGAY sau mỗi TKQC rồi mới delay (§29, §38, §53). Delay chỉ giữa các TKQC (§36, §49).
 *   - Không có Stop thủ công (§43). Có RESUME sau khi session được khôi phục (§15) và RETRY target lỗi (§42, §55).
 *   - Logic nghiệp vụ nằm ở AmitSuperShareCore. Có HAI engine thực thi, chọn bằng feature flag `super_share_engine`:
 *       "dom"   : thao tác UI Ads Manager qua content-scripts/executor.js (mặc định cho tới khi Graph đạt nghiệm thu)
 *       "graph" : Facebook Graph trong service worker (extension/services/permission-service.js), không mở tab / cửa sổ
 *     Engine được chốt lúc tạo batch (batch.engine) nên resume / retry trong cùng batch không đổi engine giữa chừng.
 *
 * Phụ thuộc (đã có trong background.js): AmitSuperShareCore, getFacebookCookie().
 */

const SS = AmitSuperShareCore;
const SS_BATCH_KEY = "amit_batch_current";
const SS_ADS_MANAGER_ROOT = "https://adsmanager.facebook.com/";
const SS_ITEM_TIMEOUT_MS = 6 * 60 * 1000;
const SS_PAGE_LEVEL_CODES = ["PAGE_LOAD_FAILED", "ROLE_SECTION_NOT_FOUND"];

// Graph engine, khi Facebook báo rate limit (docx kiến trúc §10.2, §12): đợi theo Retry-After, nếu không có thì lùi cấp số nhân,
// chạy lại CHÍNH TKQC đó (an toàn: core luôn đọc lại state trước khi ghi). Hết số lần thì PAUSED như cũ để người dùng bấm Tiếp tục.
// Retry-After dài hơn maxMs thì không đứng chờ trong service worker mà PAUSED ngay.
const SS_RATE_BACKOFF = { maxAttempts: 3, baseMs: 30000, minMs: 5000, maxMs: 5 * 60 * 1000, jitter: 0.2 };

let currentBatch = null;
let runnerWindowId = null;
let runnerTabId = null;
let runnerPrimed = false;
let heartbeatTimer = null;

const ssNow = () => new Date().toISOString();
const ssSleep = ms => new Promise(r => setTimeout(r, ms));

// Ghi log (không bao giờ làm hỏng luồng chạy nếu logger lỗi / chưa nạp)
const clog = (lvl, ev, data) => { try { if (globalThis.AmitLog) globalThis.AmitLog[lvl](ev, data); } catch (_) {} };

/** Tóm tắt kết quả một TKQC để ghi log (đầy đủ trạng thái, từng UID, lỗi, chẩn đoán, Jev). */
function summarizeItemResult(r) {
  return {
    ad_account_id: r.ad_account_id, action: r.action, status: r.status, step: r.step,
    error_code: r.error_code, error_message: r.error_message, failed_uid: r.failed_uid, note: r.note,
    role: r.role, executor_uid: r.executor_uid, started_at: r.started_at, finished_at: r.finished_at,
    targets: (r.targets || []).map(t => ({ uid: t.uid, status: t.status, note: t.note, error_code: t.error_code, error_message: t.error_message })),
    detail: r.detail || null, jev: r.jev || null
  };
}

// ============================================================
// PERSIST / BROADCAST
// ============================================================

/** Service worker có thể bị tắt giữa chừng: batch đang RUNNING được chuyển sang PAUSED để user RESUME (không chạy lại item đã xong). */
const batchReady = (async function restoreBatch() {
  try {
    const store = await chrome.storage.local.get(SS_BATCH_KEY);
    const b = store[SS_BATCH_KEY];
    if (!b) { clog("debug", "batch.restore", { found: false }); return; }
    const wasRunning = b.status === SS.BATCH_STATUS.RUNNING;
    if (wasRunning) {
      b.status = SS.BATCH_STATUS.PAUSED;
      b.pause_reason = "EXTENSION_RESTARTED";
      b.backoff = null;
      b.items.forEach(i => { if (i.status === SS.STATUS.RUNNING) i.status = SS.STATUS.PAUSED; });
      await chrome.storage.local.set({ [SS_BATCH_KEY]: b });
    }
    currentBatch = b;
    clog(wasRunning ? "warn" : "info", "batch.restore", { found: true, id: b.id, status: b.status, was_running: wasRunning, total: b.total, processed: b.processed });
  } catch (e) {
    clog("error", "batch.restore_failed", { error: e });
    console.warn("[AMIT SuperShare] Không khôi phục được batch:", e.message);
  }
})();

async function commitBatch() {
  SS.recount(currentBatch);
  clog("debug", "batch.commit", { id: currentBatch.id, status: currentBatch.status, pause_reason: currentBatch.pause_reason, total: currentBatch.total, processed: currentBatch.processed, success: currentBatch.success, failed: currentBatch.failed });
  try { await chrome.storage.local.set({ [SS_BATCH_KEY]: currentBatch }); } catch (e) { clog("error", "batch.persist_failed", { error: e }); console.warn("[AMIT SuperShare] persist:", e.message); }
  chrome.runtime.sendMessage({ action: "execution_progress_update", batch: currentBatch }).catch(() => {});
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
}
function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// ============================================================
// KẾT QUẢ DO CONTROLLER TẠO RA (khi chưa tới được executor)
// ============================================================
const inputOf = it => ({
  ad_account_id: it.ad_account_id,
  action: it.action,
  target_uids: it.target_uids,
  role: it.role,
  executor_uid: it.executor_uid,
  source: it.source || null,
  snapshot: it.snapshot || null
});

function failedResult(input, code, message, step) {
  const r = SS.newItemResult(SS.normalizeItem(input));
  r.status = SS.STATUS.FAILED;
  r.error_code = code;
  r.error_message = message;
  r.step = step;
  r.started_at = r.finished_at = ssNow();
  return r;
}

function pausedResult(input, code, message) {
  const r = failedResult(input, code, message, "SESSION");
  r.status = SS.STATUS.PAUSED;
  return r;
}

// ============================================================
// API CHO MESSAGE HANDLER
// ============================================================
async function hasFacebookSession() {
  return !!(await getFacebookCookie("c_user"));
}

async function startBatch(req, meta) {
  await batchReady;
  const reject = (error, message) => {
    clog("warn", "batch.start.rejected", { error, message });
    return { success: false, error, message };
  };
  if (currentBatch && currentBatch.status === SS.BATCH_STATUS.RUNNING) {
    return reject("BATCH_RUNNING", "Đang có một Execution khác đang chạy.");
  }
  const items = req && Array.isArray(req.items) ? req.items : [];
  if (!items.length) return reject("INVALID_INPUT", "Danh sách TKQC rỗng.");
  if (items.length > 2000) return reject("INVALID_INPUT", "Tối đa 2000 TKQC mỗi batch.");

  // Validate toàn bộ input trước khi bắt đầu (docx §51)
  for (let i = 0; i < items.length; i++) {
    const n = SS.normalizeItem(items[i] || {});
    const bad = SS.validateItem(n);
    if (bad) {
      return reject(bad.error_code, `TKQC ${n.ad_account_id || `#${i + 1}`}: ${bad.message}`);
    }
  }

  // Graph engine: xóa hàng loạt / tự gỡ phải có snapshot đã xem trước và xác nhận (docx kiến trúc §7.3, §11.2).
  const engine = typeof getSuperShareEngine === "function" ? await getSuperShareEngine() : "dom";
  if (engine === "graph") {
    const missing = items.map(i => SS.normalizeItem(i || {})).filter(SS.needsPreview);
    if (missing.length) {
      return reject("PREVIEW_REQUIRED", `${missing.length} TKQC chưa có kế hoạch xem trước đã xác nhận (ví dụ ${missing[0].ad_account_id}). Hãy xem trước rồi xác nhận trước khi chạy.`);
    }
  }

  const batch = SS.newBatch({ items, delay_seconds: req.delay_seconds }, `batch_${Date.now()}`, ssNow());
  if (meta && meta.retry_of) batch.retry_of = meta.retry_of;
  batch.attempt = (meta && meta.attempt) || 1;
  batch.engine = engine;
  currentBatch = batch;
  clog("info", "batch.created", {
    id: batch.id, retry_of: batch.retry_of || null, engine: batch.engine, total: batch.total, delay_seconds: batch.delay_seconds,
    action: batch.items[0] && batch.items[0].action, role: batch.items[0] && batch.items[0].role,
    target_uids: batch.items[0] && batch.items[0].target_uids,
    accounts: batch.items.map(i => ({ id: i.ad_account_id, action: i.action, uids: i.target_uids, executor_uid: i.executor_uid }))
  });

  // Precondition (docx §4): chưa đăng nhập Facebook -> KHÔNG tiếp tục, PAUSED + SESSION_EXPIRED
  if (!(await hasFacebookSession())) {
    batch.status = SS.BATCH_STATUS.PAUSED;
    batch.pause_reason = SS.ERR.SESSION_EXPIRED;
    clog("warn", "batch.precondition.no_session", { id: batch.id });
    await commitBatch();
    return { success: true, batchId: batch.id, batch };
  }

  await commitBatch();
  runBatchLoop(batch); // chạy nền, không await
  return { success: true, batchId: batch.id, batch };
}

async function resumeBatch() {
  await batchReady;
  if (!currentBatch || currentBatch.status !== SS.BATCH_STATUS.PAUSED) {
    clog("warn", "batch.resume.rejected", { reason: "NOT_PAUSED", status: currentBatch && currentBatch.status });
    return { success: false, error: "NOT_PAUSED", message: "Không có batch nào đang PAUSED." };
  }
  if (!(await hasFacebookSession())) {
    clog("warn", "batch.resume.rejected", { reason: "SESSION_EXPIRED", id: currentBatch.id });
    return { success: false, error: SS.ERR.SESSION_EXPIRED, message: "Facebook chưa đăng nhập. Đăng nhập lại rồi bấm Tiếp tục." };
  }
  clog("info", "batch.resume", { id: currentBatch.id, pause_reason: currentBatch.pause_reason, resumable: currentBatch.items.filter(SS.isResumable).length });
  runBatchLoop(currentBatch);
  return { success: true, batchId: currentBatch.id };
}

async function retryFailed(onlyAdAccountId) {
  await batchReady;
  if (!currentBatch) return { success: false, error: "NO_BATCH", message: "Chưa có batch nào." };
  let items = SS.buildRetryItems(currentBatch);
  if (onlyAdAccountId) items = items.filter(i => i.ad_account_id === String(onlyAdAccountId));
  clog("info", "batch.retry", { from: currentBatch.id, only: onlyAdAccountId || null, items: items.map(i => ({ id: i.ad_account_id, action: i.action, uids: i.target_uids })) });
  if (!items.length) return { success: false, error: "NOTHING_TO_RETRY", message: "Không có target thất bại nào để Retry." };
  const attempt = (currentBatch.attempt || 1) + 1;
  const failedBy = new Map(currentBatch.items.map(i => [i.ad_account_id, i.error_code]));
  const res = await startBatch({ items, delay_seconds: currentBatch.delay_seconds }, { retry_of: currentBatch.id, attempt });
  // retry_total (docx §18.1): theo lớp lỗi và số lần thử; chỉ đếm khi batch Retry thật sự được tạo
  if (res && res.success && typeof metricsEvent === "function") items.forEach(i => metricsEvent("retry", { error_code: failedBy.get(i.ad_account_id) || null, attempt }));
  return res;
}

// ============================================================
// VÒNG LẶP BATCH
// ============================================================
async function runBatchLoop(batch) {
  startHeartbeat();
  const tBatch = Date.now();
  try {
    batch.status = SS.BATCH_STATUS.RUNNING;
    batch.pause_reason = null;
    clog("info", "batch.loop.start", { id: batch.id, resumable: batch.items.filter(SS.isResumable).length, total: batch.total });
    await commitBatch();

    for (let i = 0; i < batch.items.length; i++) {
      if (currentBatch !== batch) { clog("warn", "batch.loop.superseded", { id: batch.id }); return; } // bị batch khác thay thế
      const item = batch.items[i];
      if (!SS.isResumable(item)) continue; // không chạy lại item SUCCESS/FAILED (docx §15)

      if (!(await hasFacebookSession())) {
        clog("warn", "batch.session.lost", { id: batch.id, before_item: item.ad_account_id });
        await pauseBatch(batch, SS.ERR.SESSION_EXPIRED);
        return;
      }

      item.status = SS.STATUS.RUNNING;
      item.started_at = ssNow();
      clog("info", "item.start", { batch: batch.id, index: i, ad_account_id: item.ad_account_id, action: item.action, target_uids: item.target_uids, role: item.role, executor_uid: item.executor_uid });
      await commitBatch();

      const tItem = Date.now();
      let result;
      let backoffMs = 0; // thời gian chờ rate limit không tính vào thời gian xử lý (AC11)
      for (let rateAttempt = 0; ; rateAttempt++) {
        try {
          result = batch.engine === "graph" ? await executeItemViaGraph(inputOf(item)) : await executeItemOnTab(inputOf(item));
        } catch (e) {
          clog("error", "item.exception", { ad_account_id: item.ad_account_id, error: e });
          result = failedResult(inputOf(item), SS.ERR.FACEBOOK_ACTION_ERROR, e && e.message ? e.message : String(e), "CONTROLLER");
        }
        const wait = rateBackoffWaitMs(batch, result, rateAttempt);
        if (wait === null) break;
        clog("warn", "batch.backoff", { id: batch.id, ad_account_id: item.ad_account_id, attempt: rateAttempt + 1, max: SS_RATE_BACKOFF.maxAttempts, wait_ms: wait, retry_after_ms: (result.detail && result.detail.retry_after_ms) || null });
        batch.backoff = { reason: SS.ERR.RATE_LIMITED, ad_account_id: item.ad_account_id, attempt: rateAttempt + 1, max: SS_RATE_BACKOFF.maxAttempts, wait_ms: wait, until: new Date(Date.now() + wait).toISOString() };
        await commitBatch();
        if (typeof metricsEvent === "function") metricsEvent("rate_backoff", { attempt: rateAttempt + 1 });
        await ssSleep(wait);
        backoffMs += wait;
        batch.backoff = null;
        if (currentBatch !== batch) { clog("warn", "batch.loop.superseded", { id: batch.id }); return; }
      }
      batch.backoff = null;
      batch.items[i] = result;
      if (typeof metricsRecordItem === "function") metricsRecordItem(batch, result, { item_ms: Date.now() - tItem, backoff_ms: backoffMs });
      clog(result.status === SS.STATUS.SUCCESS ? "info" : "warn", "item.finish", Object.assign({ batch: batch.id, index: i, ms: Date.now() - tItem }, summarizeItemResult(result)));
      await commitBatch(); // báo kết quả NGAY, trước delay (docx §38, §53)

      if (result.status === SS.STATUS.PAUSED) {
        await pauseBatch(batch, result.error_code);
        return;
      }
      if (result.status === SS.STATUS.SUCCESS && result.note === "SELF_REMOVED") {
        await syncAfterSelfRemoval(result.ad_account_id, result.executor_uid);
      }

      if (batch.items.slice(i + 1).some(SS.isResumable)) {
        const delayMs = batch.engine === "graph" ? graphDelayMs(batch) : batch.delay_seconds * 1000;
        clog("debug", "batch.delay", { seconds: Math.round(delayMs / 100) / 10, after: item.ad_account_id, engine: batch.engine });
        await ssSleep(delayMs); // delay giữa các TKQC
      }
    }

    batch.status = SS.BATCH_STATUS.FINISHED;
    batch.finished_at = ssNow();
    clog("info", "batch.finished", { id: batch.id, ms: Date.now() - tBatch, total: batch.total, success: batch.items.filter(i => i.status === SS.STATUS.SUCCESS).length, failed: batch.items.filter(i => i.status === SS.STATUS.FAILED).length });
    await commitBatch();
    await closeRunnerWindow();
    clog("debug", "log.flush", {});
    try { await globalThis.AmitLog.store.flush(); } catch (_) {}
  } catch (e) {
    console.error("[AMIT SuperShare] Batch controller lỗi:", e);
    clog("error", "batch.controller_error", { id: batch.id, error: e });
    batch.status = SS.BATCH_STATUS.PAUSED;
    batch.pause_reason = "CONTROLLER_ERROR";
    batch.items.forEach(i => { if (i.status === SS.STATUS.RUNNING) i.status = SS.STATUS.PAUSED; });
    await commitBatch();
  } finally {
    stopHeartbeat();
  }
}

async function pauseBatch(batch, reason) {
  batch.status = SS.BATCH_STATUS.PAUSED;
  batch.backoff = null;
  if (typeof metricsEvent === "function") metricsEvent("batch_paused", { reason }); // batch_paused_total theo login / checkpoint / reauth / rate limit
  batch.pause_reason = reason;
  clog("warn", "batch.paused", { id: batch.id, reason, processed: batch.processed, total: batch.total });
  await commitBatch();
  // Giữ cửa sổ runner mở để user thấy màn hình đăng nhập / checkpoint và xử lý.
}

// ============================================================
// GRAPH ENGINE (docx "Định hướng kiến trúc AMIT Super Share" §10)
// ============================================================
/** Giữa các TKQC: ngẫu nhiên 2-5 giây (giá trị khởi đầu cấu hình được); nếu người dùng chọn delay lớn hơn 5 giây thì tôn trọng. */
function graphDelayMs(batch) {
  const chosen = Number(batch.delay_seconds) || 0;
  if (chosen > 5) return chosen * 1000;
  return Math.round(2000 + Math.random() * 3000);
}

/** Thời gian chờ (ms) trước lần chạy lại thứ `attempt` sau rate limit; Retry-After của Facebook được tôn trọng làm mức tối thiểu. */
function rateBackoffMs(attempt, retryAfterMs) {
  const c = SS_RATE_BACKOFF;
  const hinted = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0;
  const base = Math.max(hinted, c.baseMs * Math.pow(2, attempt));
  return Math.round(Math.min(c.maxMs, Math.max(c.minMs, base * (1 + Math.random() * c.jitter))));
}

/** null = không tự chờ (PAUSED như cũ); số = chờ chừng đó ms rồi chạy lại TKQC. */
function rateBackoffWaitMs(batch, result, attempt) {
  if (batch.engine !== "graph" || !result || result.status !== SS.STATUS.PAUSED || result.error_code !== SS.ERR.RATE_LIMITED) return null;
  if (attempt >= SS_RATE_BACKOFF.maxAttempts) return null;
  const hinted = result.detail && result.detail.retry_after_ms;
  if (Number.isFinite(hinted) && hinted > SS_RATE_BACKOFF.maxMs) return null; // Facebook bảo chờ quá lâu: để người dùng quyết định
  return rateBackoffMs(attempt, hinted);
}

/** Chạy một TKQC bằng Graph: không mở tab, không click DOM, không gọi Jev. Không ném lỗi (lỗi được chuẩn hóa trong result). */
async function executeItemViaGraph(input) {
  const rt = AmitPermissionRuntime.get();
  clog("info", "permission.start", { ad_account_id: input.ad_account_id, action: input.action, target_uids: input.target_uids, role: input.role, executor_uid: input.executor_uid, source: input.source });
  const result = await AmitPermissionService.runItem(rt.deps, input, { log: clog });
  clog(result.status === SS.STATUS.SUCCESS ? "info" : "warn", "permission.finished", {
    request_id: result.request_id, ad_account_id: result.ad_account_id, status: result.status, error_code: result.error_code, retryable: result.retryable,
    targets: (result.targets || []).map(t => ({ uid: t.uid, status: t.status, method_used: t.method_used, verify_state: t.verify_state, error_code: t.error_code, retryable: t.retryable }))
  });
  return result;
}

/** REMOVE_SELF thành công: TKQC phải biến mất khỏi dataset của Via này (docx §28). */
async function syncAfterSelfRemoval(actId, viaUid) {
  try {
    const store = await chrome.storage.local.get("amit_live_accounts");
    const list = store.amit_live_accounts || [];
    const next = [];
    for (const a of list) {
      if (String(a.id) !== String(actId)) { next.push(a); continue; }
      const uids = (a.viaUids || []).filter(u => String(u) !== String(viaUid));
      if (uids.length) next.push({ ...a, viaUids: uids });
      // không còn Via nào có quyền -> bỏ khỏi dataset
    }
    await chrome.storage.local.set({ amit_live_accounts: next });
    clog("info", "dataset.self_removed", { ad_account_id: actId, via_uid: viaUid, accounts_before: list.length, accounts_after: next.length });
  } catch (e) {
    clog("error", "dataset.self_removed_failed", { ad_account_id: actId, error: e });
    console.warn("[AMIT SuperShare] syncAfterSelfRemoval:", e.message);
  }
}

// ============================================================
// TAB / CỬA SỔ RUNNER
// ============================================================
async function ensureRunnerTab() {
  if (runnerTabId !== null) {
    try {
      const t = await chrome.tabs.get(runnerTabId);
      if (t) return t.id;
    } catch (_) { /* tab đã bị đóng */ }
    runnerTabId = null;
    runnerWindowId = null;
    runnerPrimed = false;
  }
  // Cửa sổ thường (không minimize) để Facebook render đầy đủ; không cướp focus.
  const win = await chrome.windows.create({ url: "about:blank", focused: false, type: "normal", width: 1280, height: 900 });
  runnerWindowId = win.id;
  runnerTabId = win.tabs[0].id;
  runnerPrimed = false;
  clog("info", "runner.window.created", { windowId: runnerWindowId, tabId: runnerTabId });
  return runnerTabId;
}

async function closeRunnerWindow() {
  if (runnerWindowId !== null) {
    try { await chrome.windows.remove(runnerWindowId); } catch (_) {}
    clog("info", "runner.window.closed", { windowId: runnerWindowId });
  }
  runnerWindowId = null;
  runnerTabId = null;
  runnerPrimed = false;
}

function navigateAndWait(tabId, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = err => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => finish(new Error("hết thời gian tải trang")), timeoutMs || 45000);
    const listener = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch(e => finish(e));
  });
}

/** Mở URL và kiểm tra có bị đẩy sang màn hình login / checkpoint không (docx §5 Step 1). */
async function openPage(tabId, url) {
  const t0 = Date.now();
  clog("debug", "runner.navigate.start", { tabId, url: url.split("?")[0], query: url.includes("?") ? url.split("?")[1] : "" });
  try {
    await navigateAndWait(tabId, url);
  } catch (e) {
    clog("warn", "runner.navigate.failed", { tabId, url: url.split("?")[0], ms: Date.now() - t0, error: e });
    return { error: `Không tải được trang: ${e.message}` };
  }
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch (_) { clog("warn", "runner.tab.closed", { tabId }); return { error: "Tab runner đã bị đóng." }; }
  const u = tab.url || "";
  clog("debug", "runner.navigate.done", { tabId, ms: Date.now() - t0, final_url: u.split("?")[0], redirected: u.split("?")[0] !== url.split("?")[0] });
  if (/facebook\.com\/checkpoint/i.test(u)) {
    clog("warn", "runner.checkpoint", { final_url: u.split("?")[0] });
    return { pause: SS.ERR.FACEBOOK_CHECKPOINT, message: "Facebook yêu cầu xác minh bảo mật (checkpoint)." };
  }
  if (/facebook\.com\/(login|recover)/i.test(u)) {
    clog("warn", "runner.login_required", { final_url: u.split("?")[0] });
    return { pause: SS.ERR.SESSION_EXPIRED, message: "Facebook yêu cầu đăng nhập lại." };
  }
  return { ok: true };
}

const settingsUrl = actId => `${SS_ADS_MANAGER_ROOT}adsmanager/manage/ad_account_settings?act=${actId}`;

async function injectExecutor(tabId) {
  const t0 = Date.now();
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["shared/logger.js", "shared/super-share-core.js", "extension/content-scripts/executor.js"]
    });
  } catch (e) {
    clog("error", "runner.inject.failed", { tabId, error: e });
    throw e;
  }
  for (let i = 0; i < 10; i++) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { target: "AMIT_EXECUTOR", cmd: "PING" });
      if (r && r.ok) {
        clog("debug", "runner.inject.ready", { tabId, attempts: i + 1, ms: Date.now() - t0, page: r.url && r.url.split("?")[0], session: r.session, page_uid: r.uid });
        return r;
      }
    } catch (_) {}
    await ssSleep(400);
  }
  clog("error", "runner.inject.not_ready", { tabId, ms: Date.now() - t0 });
  throw new Error("Executor chưa sẵn sàng trong trang.");
}

function sendToTab(tabId, payload, timeoutMs) {
  const t0 = Date.now();
  return Promise.race([
    chrome.tabs.sendMessage(tabId, Object.assign({ target: "AMIT_EXECUTOR" }, payload)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("EXECUTOR_TIMEOUT")), timeoutMs))
  ]).then(r => {
    clog("debug", "runner.exec.reply", { cmd: payload.cmd, ms: Date.now() - t0, ok: !!(r && r.ok) });
    return r;
  }, e => {
    clog("error", "runner.exec.channel_error", { cmd: payload.cmd, ms: Date.now() - t0, error: e });
    throw e;
  });
}

const isPageLevelFailure = r =>
  r.status === SS.STATUS.FAILED
  && SS_PAGE_LEVEL_CODES.includes(r.error_code)
  && r.targets.every(t => t.status === SS.STATUS.FAILED && SS_PAGE_LEVEL_CODES.includes(t.error_code));

// ============================================================
// THỰC THI MỘT TKQC TRÊN TAB
// ============================================================
async function executeItemOnTab(input) {
  const tabId = await ensureRunnerTab();

  // Docx §5 Step 2: mở Ads Manager bằng session hiện tại (một lần mỗi batch/cửa sổ)
  if (!runnerPrimed) {
    const p = await openPage(tabId, SS_ADS_MANAGER_ROOT);
    if (p.pause) return pausedResult(input, p.pause, p.message);
    if (p.error) return failedResult(input, SS.ERR.PAGE_LOAD_FAILED, p.error, "OPEN_ADS_MANAGER");
    runnerPrimed = true;
  }

  let last = null;
  // Tối đa 2 lần: trang vai trò tải lỗi/rỗng thì tải lại 1 lần (chưa có write nào xảy ra) rồi mới báo lỗi.
  for (let attempt = 0; attempt < 2; attempt++) {
    // Step 3: trang Cài đặt tài khoản quảng cáo. Executor vẫn phải VERIFY TKQC (Step 4).
    const nav = await openPage(tabId, settingsUrl(input.ad_account_id));
    if (nav.pause) return pausedResult(input, nav.pause, nav.message);
    if (nav.error) { last = failedResult(input, SS.ERR.PAGE_LOAD_FAILED, nav.error, "OPEN_SETTINGS"); continue; }

    try {
      await injectExecutor(tabId);
    } catch (e) {
      last = failedResult(input, SS.ERR.PAGE_LOAD_FAILED, e.message, "INJECT");
      continue;
    }

    let resp;
    try {
      resp = await sendToTab(tabId, { cmd: "RUN_ITEM", item: input }, SS_ITEM_TIMEOUT_MS);
    } catch (e) {
      return handleLostChannel(tabId, input, e);
    }
    if (!resp || !resp.ok || !resp.result) {
      return failedResult(input, SS.ERR.FACEBOOK_ACTION_ERROR, (resp && resp.error) || "Executor không trả kết quả.", "EXECUTOR");
    }
    const r = resp.result;
    if (attempt === 0 && isPageLevelFailure(r)) {
      clog("warn", "runner.retry_page", { ad_account_id: input.ad_account_id, error_code: r.error_code, message: r.error_message });
      last = r;
      continue;
    }
    return r;
  }
  return last || failedResult(input, SS.ERR.PAGE_LOAD_FAILED, "Không tải được trang cài đặt TKQC.", "OPEN_SETTINGS");
}

/**
 * Kênh tới trang bị đứt giữa chừng (trang điều hướng, tab đóng, hoặc timeout).
 * REMOVE_SELF có thể làm Via mất quyền ngay nên cần xác minh riêng (docx §28); action khác báo lỗi tường minh.
 */
async function handleLostChannel(tabId, input, err) {
  clog("error", "runner.channel_lost", { ad_account_id: input.ad_account_id, action: input.action, error: err });
  if (input.action === SS.ACTIONS.REMOVE_SELF && input.executor_uid) {
    try {
      await ssSleep(2000);
      const nav = await openPage(tabId, settingsUrl(input.ad_account_id));
      if (nav.pause) return pausedResult(input, nav.pause, nav.message);
      let signals = null;
      if (nav.ok) {
        try {
          await injectExecutor(tabId);
          const r = await sendToTab(tabId, { cmd: "PROBE_SELF", actId: input.ad_account_id, selfUid: input.executor_uid }, 30000);
          signals = r && r.signals;
        } catch (_) { /* không probe được */ }
      }
      const confirmed = signals && (signals.facebookConfirmed || signals.accountGone || signals.noAccess || signals.stillInList === false);
      if (confirmed) {
        const r = SS.newItemResult(SS.normalizeItem(input));
        r.status = SS.STATUS.SUCCESS;
        r.step = "VERIFY";
        r.note = "SELF_REMOVED";
        r.started_at = r.finished_at = ssNow();
        r.targets.push({ uid: input.executor_uid, status: SS.STATUS.SUCCESS, note: "REMOVED", error_code: null, error_message: null });
        return r;
      }
      return failedResult(input, SS.ERR.REMOVE_VERIFY_FAILED,
        "Mất kết nối với trang sau khi xóa và không có tín hiệu nào xác nhận SELF đã bị xóa.", "VERIFY");
    } catch (e) {
      return failedResult(input, SS.ERR.REMOVE_VERIFY_FAILED, `Không xác minh được REMOVE_SELF: ${e.message}`, "VERIFY");
    }
  }
  return failedResult(input, SS.ERR.TIMEOUT,
    `Mất kết nối với trang giữa chừng (${err && err.message}). Trạng thái thực tế chưa xác định; hãy kiểm tra lại TKQC trước khi Retry.`, "EXECUTE");
}
