/**
 * AMIT V1 - Chrome Extension Background Service Worker
 * Xử lý Declarative Net Request, Session Management tự động từ Cookie, Proxy CORS và Sequential Super Share Engine
 */

importScripts(
  "../shared/logger.js", "../shared/constants.js", "../shared/fb-api.js", "../shared/super-share-core.js",
  "../shared/facebook/error-classifier.js", "../shared/facebook/permission-contracts.js",
  "../shared/facebook/token-provider.js", "../shared/facebook/graph-client.js",
  "services/permission-service.js", "services/permission-message-handler.js",
  "batch-controller.js", "jev.js"
);

// Service worker là nơi duy nhất ghi log vào storage (các ngữ cảnh khác gửi message log_append)
AmitLog.init("sw", { direct: true });
AmitLog.info("sw.loaded", { version: chrome.runtime.getManifest().version });
console.log("[AMIT V1] Background Service Worker loaded");

// Cấu hình Declarative Net Request để lách CORS Facebook
chrome.runtime.onInstalled.addListener(details => {
  AmitLog.info("sw.onInstalled", { reason: details && details.reason, previous: details && details.previousVersion });
  setupDnrRules();
  injectIntoExistingFacebookTabs();
  resolveFacebookSession(true);
  setupAutoSyncAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  AmitLog.info("sw.onStartup", {});
  injectIntoExistingFacebookTabs();
  resolveFacebookSession(true);
  setupAutoSyncAlarm();
});

function setupAutoSyncAlarm() {
  chrome.alarms.create("auto_sync_fb", { periodInMinutes: 15 });
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "auto_sync_fb") {
    AmitLog.debug("sw.alarm.auto_sync", {});
    console.log("[AMIT V1] Triggering background auto-sync…");
    resolveFacebookSession(false);
  }
});

function setupDnrRules() {
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: {
        type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
        requestHeaders: [{
          header: "origin",
          operation: chrome.declarativeNetRequest.HeaderOperation.SET,
          value: "https://business.facebook.com"
        }]
      },
      condition: {
        urlFilter: "*facebook.com*",
        // Chỉ áp dụng cho request do CHÍNH extension phát ra (service worker / trang extension), không đụng vào
        // XHR của các trang facebook.com mà người dùng đang duyệt (docx Graph architecture §13, §19).
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST]
      }
    }]
  });
  AmitLog.info("sw.dnr.configured", {});
  console.log("[AMIT V1] DNR Header Rewrite Rules configured");
}

/**
 * Tự động inject script vào tất cả các tab Facebook đã mở sẵn
 * (Người dùng không cần phải F5 lại trang Facebook)
 */
async function injectIntoExistingFacebookTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: "*://*.facebook.com/*" });
    for (const tab of tabs) {
      if (tab.id) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: [
            "shared/logger.js",
            "shared/constants.js",
            "extension/content-scripts/fb-injector.js",
            "extension/content-scripts/floating-widget.js"
          ]
        }).catch(e => AmitLog.warn("sw.inject.failed", { tabId: tab.id, error: e }));
      }
    }
    AmitLog.info("sw.inject.existing_tabs", { tabs: tabs.length });
    console.log(`[AMIT V1] Auto-injected content scripts into ${tabs.length} existing Facebook tabs.`);
  } catch (err) {
    AmitLog.warn("sw.inject.skipped", { error: err });
    console.log("[AMIT V1] Auto-inject skipped:", err.message);
  }
}

// Super Share batch: xem extension/batch-controller.js (currentBatch, startBatch, resumeBatch, retryFailed)

// ============================================================
// MESSAGE DISPATCHER
// AMIT chỉ nằm trong extension: không có trang web bên ngoài nào được gọi extension
// (không có onMessageExternal / externally_connectable).
// ============================================================

// Các message tần suất cao / chính là log: không ghi lại (tránh log đệ quy và nhiễu)
const QUIET_ACTIONS = new Set(["log_append", "log_flush", "get_execution_status", "execution_progress_update"]);

function senderKind(sender) {
  if (sender.tab) {
    let host = "";
    try { host = new URL(sender.url || sender.tab.url).hostname; } catch (_) {}
    return `content:${host}`;
  }
  const u = sender.url || "";
  if (u.includes("/popup/")) return "popup";
  if (u.includes("/logs/")) return "logs";
  if (u.includes("/web/")) return "web";
  return "extension";
}

function summarizeParams(request) {
  const r = Object.assign({}, request);
  delete r.action; delete r.cmd;
  if (Array.isArray(r.items)) {
    r.items = { count: r.items.length, action: r.items[0] && r.items[0].action, role: r.items[0] && r.items[0].role,
      uids_per_item: r.items[0] && Array.isArray(r.items[0].target_uids) ? r.items[0].target_uids.length : 0,
      accounts: r.items.slice(0, 20).map(i => i && i.ad_account_id) };
  }
  if (Array.isArray(r.accounts)) r.accounts = { count: r.accounts.length };
  if (r.session) r.session = { uid: r.session.uid, hasToken: !!r.session.accessToken, hasDtsg: !!r.session.fb_dtsg };
  return r;
}

function summarizeResponse(res) {
  if (!res || typeof res !== "object") return res;
  const o = { success: res.success, ok: res.ok, error: res.error, message: res.message };
  if (res.batch) {
    o.batch = { id: res.batch.id, status: res.batch.status, total: res.batch.total, processed: res.batch.processed, success: res.batch.success, failed: res.batch.failed };
  }
  if (Array.isArray(res.data)) o.data_len = res.data.length;
  if (res.session) o.session = { uid: res.session.uid, hasToken: !!res.session.accessToken, hasDtsg: !!res.session.fb_dtsg };
  return o;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Chỉ nhận message từ chính extension này (popup, content script, trang web/ trong extension).
  if (sender.id !== chrome.runtime.id) {
    AmitLog.warn("sw.msg.rejected", { action: request && (request.action || request.cmd), senderId: sender.id });
    sendResponse({ success: false, error: "Sender không hợp lệ" });
    return false;
  }

  const act = request && (request.action || request.cmd);

  // Log từ các ngữ cảnh khác: gắn thêm tab rồi ghi vào kho
  if (act === "log_append") {
    const entries = Array.isArray(request.entries) ? request.entries.slice(0, 200) : [];
    if (sender.tab) entries.forEach(e => { if (e && typeof e === "object") e.tab = sender.tab.id; });
    AmitLog.store.append(entries).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (act === "log_flush") {
    AmitLog.store.flush().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (act === "log_clear") {
    AmitLog.store.clear().then(() => {
      AmitLog.info("sw.log.cleared", { by: senderKind(sender) });
      sendResponse({ ok: true });
    }, () => sendResponse({ ok: false }));
    return true;
  }

  const quiet = QUIET_ACTIONS.has(act);
  const t0 = Date.now();
  if (!quiet) AmitLog.info("sw.msg.in", { action: act, from: senderKind(sender), params: summarizeParams(request) });
  const wrapped = res => {
    if (!quiet) {
      const failed = res && (res.success === false || res.ok === false);
      AmitLog[failed ? "warn" : "info"]("sw.msg.out", { action: act, ms: Date.now() - t0, response: summarizeResponse(res) });
    }
    sendResponse(res);
  };
  handleMessage(request, sender, wrapped);
  return true; // Giữ kênh async
});

async function handleMessage(request, sender, sendResponse) {
  const { action, cmd } = request;
  const act = action || cmd;

  try {
    switch (act) {
      case "ping":
        sendResponse({ success: true, message: "AMIT Extension Active", version: "1.0.0" });
        break;

      case "save_session":
        await saveViaSession(request.session);
        sendResponse({ success: true });
        break;

      case "save_discovered_accounts": {
        const { accounts, via, viaName } = request;
        if (accounts && accounts.length) {
          const store = await chrome.storage.local.get(["amit_live_accounts"]);
          const current = store.amit_live_accounts || [];

          const map = new Map();
          current.forEach(a => map.set(String(a.id), { ...a }));

          accounts.forEach(a => {
            const id = String(a.id);
            const holdingVia = (a.name && !a.name.startsWith("TKQC ") && a.name !== id) ? a.name : viaName;
            if (map.has(id)) {
              const existing = map.get(id);
              const viaSet = new Set(Array.isArray(existing.via) ? existing.via : [existing.via]);
              if (holdingVia) viaSet.add(holdingVia);
              const uidSet = new Set((existing.viaUids || []).map(String));
              if (via) uidSet.add(String(via));
              map.set(id, {
                ...existing,
                name: (a.name && !a.name.startsWith("TKQC ")) ? a.name : existing.name,
                via: Array.from(viaSet),
                viaUids: Array.from(uidSet)
              });
            } else {
              map.set(id, AmitFbApi.transformFbAccount({
                account_id: id,
                name: a.name || `TKQC ${id}`
              }, holdingVia, via));
            }
          });

          const merged = Array.from(map.values());
          await chrome.storage.local.set({ amit_live_accounts: merged });
          AmitLog.info("sw.accounts.discovered_dom", { count: accounts.length, total_after_merge: merged.length, via });
          console.log(`[AMIT V1] Auto-saved ${accounts.length} accounts from Ads Manager DOM for Via:`, viaName);
        }
        sendResponse({ success: true });
        break;
      }

      case "ensure_session":
      case "get_active_session": {
        const session = await resolveFacebookSession(request.forceRefresh || false);
        if (session && session.uid) {
          sendResponse({ success: true, session });
        } else {
          sendResponse({
            success: false,
            error: "Chưa nhận diện được Facebook. Vui lòng đăng nhập Facebook trên trình duyệt Chrome này."
          });
        }
        break;
      }

      case "discovery_accounts": {
        const session = await resolveFacebookSession(false);
        if (!session || !session.uid) {
          AmitLog.warn("sw.discovery.no_session", {});
          sendResponse({
            success: false,
            error: "Chưa nhận diện được Session Facebook. Vui lòng đăng nhập Facebook trên Chrome."
          });
          return;
        }

        // Nếu có UID nhưng thiếu token Ads, thử quét lại Ads Manager
        if (!session.accessToken) {
          AmitLog.warn("sw.discovery.no_token", { uid: session.uid });
          const freshSession = await resolveFacebookSession(true);
          if (!freshSession || !freshSession.accessToken) {
            // Thử fallback trực tiếp từ trang /adsmanager/manage/accounts
            const fallbackAccs = await fallbackDiscoveryFromAdsManager(session);
            AmitLog.info("sw.discovery.fallback_html", { found: fallbackAccs ? fallbackAccs.length : 0 });
            if (fallbackAccs && fallbackAccs.length > 0) {
              await chrome.storage.local.set({
                amit_live_accounts: fallbackAccs,
                amit_last_sync: Date.now()
              });
              sendResponse({
                success: true,
                data: fallbackAccs,
                via: session.uid,
                viaName: session.userName
              });
              return;
            }

            sendResponse({
              success: false,
              error: "Không thể trích xuất Token Ads Manager. Hãy mở tab Ads Manager (https://adsmanager.facebook.com) 1 lần rồi bấm Sync lại."
            });
            return;
          }
        }

        try {
          const accounts = await AmitFbApi.discoveryAccounts(
            session.accessToken,
            session.userName,
            session.uid
          );

          // Lưu accounts vào storage local của extension để Web App dùng
          await chrome.storage.local.set({
            amit_live_accounts: accounts,
            amit_last_sync: Date.now()
          });
          AmitLog.info("sw.discovery.graph_ok", { count: accounts.length, uid: session.uid });

          sendResponse({
            success: true,
            data: accounts,
            via: session.uid,
            viaName: session.userName
          });
        } catch (apiErr) {
          console.warn("[AMIT V1] Graph API discovery error, attempting Ads Manager HTML fallback:", apiErr.message);
          AmitLog.warn("sw.discovery.graph_error", { error: apiErr });
          const fallbackAccs = await fallbackDiscoveryFromAdsManager(session);
          AmitLog.info("sw.discovery.fallback_html", { found: fallbackAccs ? fallbackAccs.length : 0 });
          if (fallbackAccs && fallbackAccs.length > 0) {
            await chrome.storage.local.set({
              amit_live_accounts: fallbackAccs,
              amit_last_sync: Date.now()
            });
            sendResponse({
              success: true,
              data: fallbackAccs,
              via: session.uid,
              viaName: session.userName
            });
          } else {
            sendResponse({
              success: false,
              error: apiErr.message || "Lỗi discovery TKQC từ Facebook"
            });
          }
        }
        break;
      }

      case "inspect_single_account": {
        const session = await resolveFacebookSession(false);
        if (!session || !session.accessToken) {
          sendResponse({ success: false, error: "Mất session Facebook" });
          return;
        }
        const detail = await AmitFbApi.inspectAccount(request.accountId, session.accessToken);
        sendResponse({ success: true, data: detail });
        break;
      }

      // ---- Graph engine (docx "Định hướng kiến trúc AMIT Super Share") ----
      case "permission_execute":
        sendResponse(await handlePermissionExecute(request.command));
        break;

      // Engine Super Share: chỉ đổi được từ trang của chính extension (popup / web), không phải content script trên facebook.com.
      case "get_super_share_engine":
      case "set_super_share_engine": {
        if (!sender.url || !sender.url.startsWith(chrome.runtime.getURL(""))) {
          sendResponse({ ok: false, error: "Không được phép" });
          break;
        }
        sendResponse(act === "get_super_share_engine"
          ? { ok: true, engine: await getSuperShareEngine() }
          : await setSuperShareEngine(request.engine));
        break;
      }

      case "execute_super_share_batch":
        sendResponse(await startBatch({ items: request.items, delay_seconds: request.delay_seconds }));
        break;

      case "resume_batch":
        sendResponse(await resumeBatch());
        break;

      case "retry_failed":
        sendResponse(await retryFailed(request.ad_account_id));
        break;

      case "get_execution_status": {
        await batchReady;
        sendResponse({ success: true, batch: currentBatch });
        break;
      }

      // ---- Jev (OpenRouter) ----
      // Cấu hình chỉ thao tác được từ trang của chính extension (popup / web), không phải content script trên facebook.com.
      case "jev_get_config":
      case "jev_save_config":
      case "jev_test": {
        if (!sender.url || !sender.url.startsWith(chrome.runtime.getURL(""))) {
          sendResponse({ ok: false, error: "Không được phép" });
          break;
        }
        if (act === "jev_get_config") sendResponse({ ok: true, config: publicJevConfig(await getJevConfig()) });
        else if (act === "jev_save_config") sendResponse(await saveJevConfig(request.patch || {}));
        else sendResponse(await jevTest());
        break;
      }

      // Executor (content script) hỏi Jev chọn control. Key không bao giờ rời service worker.
      case "jev_resolve":
        sendResponse(await jevResolve(request.request));
        break;

      case "fetch_fb": {
        // Chỉ nội bộ extension, và chỉ tới host Facebook.
        let host = "";
        try { host = new URL(request.url).hostname; } catch {}
        const isFbHost = host === "facebook.com" || host.endsWith(".facebook.com");
        if (sender.id !== chrome.runtime.id || !isFbHost) {
          sendResponse({ success: false, error: "fetch_fb không được phép" });
          break;
        }
        const res = await AmitFbApi.request(request.url, request.options || {});
        sendResponse({ success: true, data: res });
        break;
      }

      default:
        sendResponse({ success: false, error: "Action không xác định" });
    }
  } catch (err) {
    console.error("[AMIT V1] Error handling action:", act, err);
    AmitLog.error("sw.msg.exception", { action: act, error: err });
    sendResponse({ success: false, error: err.message });
  }
}

// ============================================================
// AUTOMATIC SESSION RESOLVER (TỰ ĐỘNG BÓC TÁCH KHÔNG CẦN F5)
// ============================================================

async function getFacebookCookie(name) {
  return new Promise(resolve => {
    chrome.cookies.get({ url: "https://www.facebook.com", name }, c1 => {
      if (c1 && c1.value) return resolve(c1.value);
      chrome.cookies.get({ url: "https://facebook.com", name }, c2 => {
        resolve(c2 ? c2.value : null);
      });
    });
  });
}

/**
 * Tự động phân giải session Facebook từ Cookie và HTML nền
 */
async function resolveFacebookSession(forceRefresh = false) {
  // 1. Kiểm tra session hiện hành nếu chưa hết hạn (1 tiếng)
  if (!forceRefresh) {
    const store = await chrome.storage.local.get(["via_sessions", "active_uid"]);
    const existing = store.via_sessions && store.active_uid ? store.via_sessions[store.active_uid] : null;
    if (existing && existing.uid && existing.accessToken && (Date.now() - (existing.updatedAt || 0) < 3600000)) {
      AmitLog.debug("sw.session.cached", { uid: existing.uid, age_s: Math.round((Date.now() - (existing.updatedAt || 0)) / 1000) });
      return existing;
    }
  }

  // 2. Kiểm tra Cookie c_user trực tiếp trên Chrome
  const uid = await getFacebookCookie("c_user");
  if (!uid) {
    AmitLog.warn("sw.session.no_cookie", { forceRefresh });
    console.log("[AMIT V1] Không tìm thấy cookie c_user. Người dùng chưa đăng nhập Facebook.");
    return null;
  }

  AmitLog.info("sw.session.resolving", { uid, forceRefresh });
  console.log("[AMIT V1] Phát hiện Cookie c_user:", uid, "- Bắt đầu quét token nền…");

  let sessionData = {
    uid,
    userName: `Via ${uid}`,
    accessToken: null,
    fb_dtsg: null,
    lsd: null,
    updatedAt: Date.now()
  };

  // 3. Tự động fetch Ads Manager và Facebook nền để bóc tách token & TKQC
  const targetEndpoints = [
    "https://adsmanager.facebook.com/adsmanager/manage/accounts",
    "https://adsmanager.facebook.com/adsmanager/manage/campaigns",
    "https://www.facebook.com/adsmanager/manage/accounts",
    "https://business.facebook.com/content_management",
    "https://www.facebook.com"
  ];

  for (const url of targetEndpoints) {
    try {
      const res = await fetch(url, { credentials: "include" });
      const html = await res.text();
      const parsed = parseTokensFromHtml(html);

      if (parsed.accessToken && !sessionData.accessToken) {
        sessionData.accessToken = parsed.accessToken;
      }
      if (parsed.fb_dtsg && !sessionData.fb_dtsg) {
        sessionData.fb_dtsg = parsed.fb_dtsg;
      }
      if (parsed.lsd && !sessionData.lsd) {
        sessionData.lsd = parsed.lsd;
      }
      if (parsed.userName && sessionData.userName.startsWith("Via ")) {
        sessionData.userName = parsed.userName;
      }

      AmitLog.debug("sw.session.scan", { url: url.split("?")[0], status: res.status, gotToken: !!parsed.accessToken, gotDtsg: !!parsed.fb_dtsg });

      // Nếu đã lấy đủ Access Token và DTSG thì hoàn tất
      if (sessionData.accessToken && sessionData.fb_dtsg) {
        break;
      }
    } catch (err) {
      AmitLog.warn("sw.session.scan_error", { url: url.split("?")[0], error: err });
      console.warn("[AMIT V1] Background scan error for", url, err.message);
    }
  }

  // 4. Nếu vẫn chưa có accessToken, thử đọc trực tiếp từ tab Facebook đang mở
  if (!sessionData.accessToken) {
    try {
      const tabs = await chrome.tabs.query({ url: "*://*.facebook.com/*" });
      for (const tab of tabs) {
        if (tab.id) {
          const res = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const html = document.documentElement.outerHTML;
              // Ưu tiên window.__accessToken (nguồn rõ ràng); regex chung chỉ là dự phòng
              const m = html.match(/__accessToken["']?\s*[=:]\s*["'](EA[A-Za-z0-9]{20,})["']/) || html.match(/"(EA[A-Za-z0-9]{20,})"/);
              let dtsg = null;
              if (html.includes('["DTSGInitData",[],{"token":"')) {
                dtsg = html.split('["DTSGInitData",[],{"token":"')[1]?.split('"')[0];
              }
              return { token: m ? m[1] : null, dtsg };
            }
          });
          if (res && res[0] && res[0].result) {
            if (res[0].result.token) sessionData.accessToken = res[0].result.token;
            if (res[0].result.dtsg && !sessionData.fb_dtsg) sessionData.fb_dtsg = res[0].result.dtsg;
            if (sessionData.accessToken) break;
          }
        }
      }
    } catch (e) {
      AmitLog.warn("sw.session.tab_extract_error", { error: e });
      console.warn("[AMIT V1] Direct tab script token extract:", e.message);
    }
  }

  await saveViaSession(sessionData);
  AmitLog.info("sw.session.resolved", { uid: sessionData.uid, hasToken: !!sessionData.accessToken, hasDtsg: !!sessionData.fb_dtsg, hasLsd: !!sessionData.lsd });
  return sessionData;
}

function parseTokensFromHtml(html) {
  let accessToken = null;
  let fb_dtsg = null;
  let lsd = null;
  let userName = null;

  // 1. Access Token. Ưu tiên nguồn rõ ràng (window.__accessToken của Ads Manager); regex "EA..." chung chung chỉ là dự phòng
  //    cho Ads Check (có thể bắt nhầm token của module khác nên Super Share Graph luôn xác minh chủ token bằng /me).
  const strictToken = globalThis.AmitTokenProvider ? globalThis.AmitTokenProvider.extractAccessToken(html) : null;
  const tokenMatches = strictToken ? null : html.match(/"(EA[A-Za-z0-9]{20,})"/g) || html.match(/access_token:"(EA[A-Za-z0-9]+)"/g);
  if (strictToken) accessToken = strictToken;
  if (tokenMatches && tokenMatches.length) {
    for (const m of tokenMatches) {
      const clean = m.replace(/["\s]|access_token:/g, "");
      if (clean.startsWith("EAAB") || clean.startsWith("EAAI")) {
        accessToken = clean;
        break;
      }
      if (!accessToken && clean.startsWith("EA")) {
        accessToken = clean;
      }
    }
  }

  // 2. fb_dtsg
  if (html.includes('["DTSGInitData",[],{"token":"')) {
    fb_dtsg = html.split('["DTSGInitData",[],{"token":"')[1]?.split('"')[0];
  } else {
    const dtsgMatch = html.match(/"DTSGInitialData"[^>]*"token":"([^"]+)"/)
                   || html.match(/name="fb_dtsg"\s+value="([^"]+)"/)
                   || html.match(/"dtsg":\{"token":"([^"]+)"/);
    if (dtsgMatch) fb_dtsg = dtsgMatch[1];
  }

  // 3. LSD
  if (html.includes('["LSD",[],{"token":"')) {
    lsd = html.split('["LSD",[],{"token":"')[1]?.split('"')[0];
  } else {
    const lsdMatch = html.match(/"LSD"[^>]*"token":"([^"]+)"/);
    if (lsdMatch) lsd = lsdMatch[1];
  }

  // 4. User Name
  const nameMatch = html.match(/"NAME":"([^"]+)"/) || html.match(/"name":"([^"]+)"/);
  if (nameMatch) {
    try {
      userName = decodeURIComponent(JSON.parse(`"${nameMatch[1]}"`));
    } catch {
      userName = nameMatch[1];
    }
  }

  return { accessToken, fb_dtsg, lsd, userName };
}

/**
 * Trích xuất danh sách TKQC dự phòng trực tiếp từ trang /adsmanager/manage/accounts
 */
async function fallbackDiscoveryFromAdsManager(session) {
  const accounts = [];
  const foundIds = new Set();

  const urls = [
    "https://adsmanager.facebook.com/adsmanager/manage/accounts",
    "https://adsmanager.facebook.com/adsmanager/manage/campaigns"
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { credentials: "include" });
      const html = await res.text();

      // Bắt các pattern ID tài khoản quảng cáo
      const patterns = [
        /act=(\d+)/g,
        /"account_id":"(\d+)"/g,
        /"adAccountID":"act_(\d+)"/g,
        /"accountID":"act_(\d+)"/g,
        /ID tài khoản quảng cáo[:\s]+(\d+)/gi
      ];

      for (const pat of patterns) {
        let m;
        while ((m = pat.exec(html)) !== null) {
          const actId = m[1];
          if (actId && !foundIds.has(actId) && actId.length >= 8) {
            foundIds.add(actId);

            // Tìm tên tương ứng nếu có
            let accName = `TKQC ${actId}`;
            const namePattern = new RegExp(`"account_id":"${actId}"[^}]*"name":"([^"]+)"`);
            const nameMatch = html.match(namePattern);
            if (nameMatch) {
              try {
                accName = decodeURIComponent(JSON.parse(`"${nameMatch[1]}"`));
              } catch {
                accName = nameMatch[1];
              }
            }

            accounts.push(AmitFbApi.transformFbAccount({
              account_id: actId,
              name: accName
            }, session.userName, session.uid));
          }
        }
      }

      if (accounts.length > 0) break;
    } catch (e) {
      console.warn("[AMIT V1] Fallback discovery fetch error:", e.message);
    }
  }

  return accounts;
}

async function saveViaSession(sessionData) {
  const store = await chrome.storage.local.get(["via_sessions", "active_uid"]);
  const sessions = store.via_sessions || {};
  sessions[sessionData.uid] = sessionData;

  await chrome.storage.local.set({
    via_sessions: sessions,
    active_uid: sessionData.uid
  });
  console.log("[AMIT V1] Session saved for Via:", sessionData.userName, `(${sessionData.uid})`);
}

async function getActiveSession() {
  return resolveFacebookSession(false);
}

