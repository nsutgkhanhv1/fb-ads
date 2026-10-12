/**
 * AMIT V1 - Facebook Session Injector & Extractor
 * Tự động bóc tách Access Token, fb_dtsg, LSD và UID của Via từ context Facebook
 */

(function () {
  if (globalThis.AmitLog && !globalThis.AmitLog.__inited) globalThis.AmitLog.init("content");
  const log = (lvl, ev, data) => { try { if (globalThis.AmitLog) globalThis.AmitLog[lvl]("inject." + ev, data); } catch (_) {} };
  log("debug", "init", { page: window.location.origin + window.location.pathname });
  console.log("[AMIT V1] Facebook Session Injector initialized on:", window.location.href);

  function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return null;
  }

  function extractSession() {
    const html = document.documentElement.outerHTML;

    // 1. Trích xuất Access Token nội bộ của Ads Manager (EAAB... / EAAI...)
    const tokenMatch = html.match(/"EA[A-Za-z0-9]{20,}/);
    const accessToken = tokenMatch ? tokenMatch[0].substr(1) : null;

    // 2. Trích xuất fb_dtsg
    let fb_dtsg = null;
    if (html.includes('["DTSGInitData",[],{"token":"')) {
      fb_dtsg = html.split('["DTSGInitData",[],{"token":"')[1]?.split('"')[0];
    } else {
      const dtsgMatch = html.match(/"DTSGInitialData"[^>]*"token":"([^"]+)"/);
      if (dtsgMatch) fb_dtsg = dtsgMatch[1];
    }

    // 3. Trích xuất LSD
    let lsd = null;
    if (html.includes('["LSD",[],{"token":"')) {
      lsd = html.split('["LSD",[],{"token":"')[1]?.split('"')[0];
    }

    // 4. Lấy UID của Via từ Cookie c_user
    const uid = getCookie("c_user");

    // Lấy tên người dùng nếu có thể
    let userName = null;
    try {
      const nameMatch = html.match(/"NAME":"([^"]+)"/);
      if (nameMatch) userName = decodeURIComponent(JSON.parse(`"${nameMatch[1]}"`));
    } catch {}

    if (uid && (accessToken || fb_dtsg)) {
      const sessionData = {
        uid,
        userName: userName || `Via ${uid}`,
        accessToken,
        fb_dtsg,
        lsd,
        updatedAt: Date.now()
      };

      log("info", "session_extracted", { uid, hasToken: !!accessToken, hasDtsg: !!fb_dtsg, hasLsd: !!lsd, page: window.location.pathname });
      console.log("[AMIT V1] Extracted Facebook Session for Via:", uid);
      chrome.runtime.sendMessage({
        action: "save_session",
        session: sessionData
      });

      // Tự động quét các tài khoản con mà Via này đang cầm từ DOM Ads Manager
      scanAndSendAccounts(uid, sessionData.userName);
    }
  }

  function scanAndSendAccounts(viaUid, viaName) {
    if (!window.location.href.includes("adsmanager.facebook.com") && !window.location.href.includes("manage/accounts")) {
      return;
    }

    const discovered = extractAccountsFromAdsManager();
    if (discovered.length > 0) {
      log("info", "accounts_found_dom", { count: discovered.length, via: viaUid });
      console.log(`[AMIT V1] Discovered ${discovered.length} accounts from Ads Manager Overview:`, discovered);
      chrome.runtime.sendMessage({
        action: "save_discovered_accounts",
        accounts: discovered,
        via: viaUid,
        viaName: viaName
      });
    }
  }

  function extractAccountsFromAdsManager() {
    const accounts = [];
    const foundIds = new Set();

    // 1. Quét từ text node trên giao diện "Tổng quan tài khoản"
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    const textNodes = [];
    while ((node = walker.nextNode())) {
      const val = (node.nodeValue || "").trim();
      if (val) textNodes.push({ node, text: val });
    }

    for (let i = 0; i < textNodes.length; i++) {
      const item = textNodes[i];
      const m = item.text.match(/ID t(?:à|a)i kho(?:ả|a)n qu(?:ả|a)ng c(?:á|a)o[:\s]+(\d+)/i);
      if (m && m[1] && !foundIds.has(m[1]) && m[1].length >= 8) {
        const actId = m[1];
        foundIds.add(actId);

        // Tìm tên ở các dòng text phía trước
        let accName = `TKQC ${actId}`;
        for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
          const prevText = textNodes[j].text;
          if (prevText && !prevText.toLowerCase().includes("tài khoản quảng cáo") && !prevText.includes("ID") && prevText.length < 60) {
            accName = prevText;
            break;
          }
        }

        accounts.push({ id: actId, name: accName });
      }
    }

    // 2. Quét từ mã nguồn JSON nhúng trong trang
    const html = document.documentElement.outerHTML;
    const jsonMatches = html.matchAll(/"account_id":"(\d+)"[^}]*"name":"([^"]+)"/g);
    for (const jm of jsonMatches) {
      const actId = jm[1];
      if (actId && !foundIds.has(actId) && actId.length >= 8) {
        foundIds.add(actId);
        let accName = jm[2];
        try { accName = decodeURIComponent(JSON.parse(`"${accName}"`)); } catch {}
        accounts.push({ id: actId, name: accName });
      }
    }

    // 3. Quét link act=\d+
    const actLinks = html.matchAll(/act=(\d+)/g);
    for (const lm of actLinks) {
      const actId = lm[1];
      if (actId && !foundIds.has(actId) && actId.length >= 8) {
        foundIds.add(actId);
        accounts.push({ id: actId, name: `TKQC ${actId}` });
      }
    }

    return accounts;
  }

  // Quét ngay khi nạp script
  setTimeout(extractSession, 1000);

  // Lắng nghe khi user click mở menu "Tổng quan tài khoản"
  document.addEventListener("click", () => {
    const uid = getCookie("c_user");
    if (uid) {
      setTimeout(() => scanAndSendAccounts(uid, `Via ${uid}`), 800);
    }
  });

  // Quét lại nếu trang cập nhật qua Ajax hoặc điều hướng SPA
  window.addEventListener("popstate", () => setTimeout(extractSession, 1500));
})();
