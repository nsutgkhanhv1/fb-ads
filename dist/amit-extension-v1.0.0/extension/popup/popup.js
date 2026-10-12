/**
 * AMIT V1 - Extension Popup Script
 */

document.addEventListener("DOMContentLoaded", async () => {
  AmitLog.init("popup");
  const plog = (lvl, ev, data) => { try { AmitLog[lvl]("popup." + ev, data); } catch (_) {} };
  plog("info", "open", {});
  const viaUidEl = document.getElementById("viaUid");
  const viaNameEl = document.getElementById("viaName");
  const tokenStatusEl = document.getElementById("tokenStatus");
  const statusMsgEl = document.getElementById("statusMsg");
  const openWebAppBtn = document.getElementById("openWebApp");
  const discoveryBtn = document.getElementById("discoveryBtn");

  async function checkSession(forceRefresh = false) {
    statusMsgEl.textContent = "Đang kiểm tra session Facebook…";
    chrome.runtime.sendMessage({ action: "ensure_session", forceRefresh }, res => {
      plog(res && res.success ? "info" : "warn", "session.check", { forceRefresh, ok: !!(res && res.success), uid: res && res.session && res.session.uid, hasToken: !!(res && res.session && res.session.accessToken), error: res && res.error });
      if (res && res.success && res.session) {
        const s = res.session;
        viaUidEl.textContent = s.uid || "—";
        viaNameEl.textContent = s.userName || `Via ${s.uid}`;
        tokenStatusEl.textContent = s.accessToken ? "Đã kết nối" : "Chỉ có dtsg (Thiếu Ads Token)";
        tokenStatusEl.style.color = s.accessToken ? "#00c853" : "#ff9800";
        statusMsgEl.textContent = s.accessToken ? "Sẵn sàng đồng bộ TKQC." : "Đang lấy Token Ads…";
      } else {
        viaUidEl.textContent = "Chưa kết nối";
        viaNameEl.textContent = "—";
        tokenStatusEl.textContent = "Không tìm thấy";
        tokenStatusEl.style.color = "#e53935";
        statusMsgEl.textContent = "Chưa đăng nhập Facebook trên trình duyệt này.";
      }
      renderSavedVias();
    });
  }

  async function renderSavedVias() {
    chrome.storage.local.get(["via_sessions", "active_uid"], store => {
      const sessions = store.via_sessions || {};
      const activeUid = store.active_uid;
      const list = Object.values(sessions);
      const card = document.getElementById("savedViasCard");
      const countEl = document.getElementById("savedViasCount");
      const listEl = document.getElementById("savedViasList");

      if (list.length > 0) {
        card.style.display = "block";
        countEl.textContent = list.length;
        listEl.innerHTML = list.map(v => {
          const isActive = v.uid === activeUid;
          return `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:12px">
              <div>
                <b>${v.userName || `Via ${v.uid}`}</b>
                <div style="color:#777;font-size:11px">${v.uid}</div>
              </div>
              <div>
                ${isActive
                  ? `<span style="background:#e3fcef;color:#006644;padding:2px 6px;border-radius:10px;font-size:10px;font-weight:700">Online</span>`
                  : `<button class="btn" style="padding:2px 8px;font-size:10px;height:22px;margin:0" onclick="switchVia('${v.uid}')">Chọn</button>`
                }
              </div>
            </div>
          `;
        }).join("");
      } else {
        card.style.display = "none";
      }
    });
  }

  window.switchVia = uid => {
    plog("info", "switch_via", { uid });
    chrome.storage.local.set({ active_uid: uid }, () => {
      checkSession(false);
    });
  };

  // ---- Jev (OpenRouter): cấu hình ở đây, lưu trong chrome.storage.local ----
  const jevEnabledEl = document.getElementById("jevEnabled");
  const jevKeyEl = document.getElementById("jevKey");
  const jevModelEl = document.getElementById("jevModel");
  const jevMsgEl = document.getElementById("jevMsg");
  const jevMsg = (text, color) => { jevMsgEl.textContent = text; jevMsgEl.style.color = color || "#555"; };

  function loadJev() {
    chrome.runtime.sendMessage({ action: "jev_get_config" }, res => {
      if (!res || !res.ok) return jevMsg("Không đọc được cấu hình Jev.", "#e53935");
      jevEnabledEl.checked = res.config.enabled;
      jevModelEl.value = res.config.model;
      jevKeyEl.value = "";
      jevKeyEl.placeholder = res.config.hasKey ? `Đã lưu key (${res.config.keyHint}). Nhập key mới để thay.` : "sk-or-…";
    });
  }

  document.getElementById("jevSave").onclick = () => {
    const patch = { enabled: jevEnabledEl.checked, model: jevModelEl.value };
    if (jevKeyEl.value.trim()) patch.apiKey = jevKeyEl.value;
    plog("info", "jev.save", { enabled: patch.enabled, model: patch.model, key_changed: !!patch.apiKey });
    chrome.runtime.sendMessage({ action: "jev_save_config", patch }, res => {
      if (res && res.ok) { jevMsg("Đã lưu cấu hình Jev.", "#00875a"); loadJev(); }
      else jevMsg((res && res.error) || "Không lưu được.", "#e53935");
    });
  };

  document.getElementById("jevClear").onclick = () => {
    plog("info", "jev.clear_key", {});
    chrome.runtime.sendMessage({ action: "jev_save_config", patch: { clearKey: true, enabled: false } }, res => {
      if (res && res.ok) { jevMsg("Đã xóa key và tắt Jev.", "#00875a"); loadJev(); }
      else jevMsg((res && res.error) || "Không xóa được.", "#e53935");
    });
  };

  document.getElementById("jevTest").onclick = () => {
    jevMsg("Đang kiểm tra kết nối OpenRouter…");
    // Lưu trước (nếu đã nhập key mới) rồi mới kiểm tra
    const patch = { enabled: true, model: jevModelEl.value };
    if (jevKeyEl.value.trim()) patch.apiKey = jevKeyEl.value;
    chrome.runtime.sendMessage({ action: "jev_save_config", patch }, saved => {
      if (!saved || !saved.ok) return jevMsg((saved && saved.error) || "Cần nhập API key.", "#e53935");
      chrome.runtime.sendMessage({ action: "jev_test" }, res => {
        plog(res && res.ok && res.passed ? "info" : "warn", "jev.test_result", { ok: !!(res && res.ok), passed: !!(res && res.passed), model: res && res.model, reason: res && (res.reason || res.message) });
        loadJev();
        if (!res || !res.ok) jevMsg(`Lỗi: ${(res && (res.message || res.reason)) || "không phản hồi"}`, "#e53935");
        else if (!res.passed) jevMsg(`Kết nối được nhưng model ${res.model} trả đáp án sai. Thử model khác.`, "#ff9800");
        else jevMsg(`OK. Jev hoạt động (${res.model}).`, "#00875a");
      });
    });
  };

  loadJev();

  // Tự động kiểm tra ngay khi mở popup
  checkSession();

  openWebAppBtn.onclick = () => {
    plog("info", "open_workspace", {});
    // Mở trang web/index.html của Extension
    const webUrl = chrome.runtime.getURL("web/index.html");
    chrome.tabs.create({ url: webUrl });
  };

  document.getElementById("openLogs").onclick = () => {
    plog("info", "open_logs_page", {});
    chrome.tabs.create({ url: chrome.runtime.getURL("extension/logs/logs.html") });
  };

  discoveryBtn.onclick = () => {
    plog("info", "discovery.click", {});
    statusMsgEl.textContent = "Đang quét danh sách TKQC từ Facebook…";
    discoveryBtn.disabled = true;

    chrome.runtime.sendMessage({ action: "discovery_accounts" }, res => {
      discoveryBtn.disabled = false;
      plog(res && res.success ? "info" : "warn", "discovery.result", { ok: !!(res && res.success), count: res && res.data && res.data.length, error: res && res.error });
      if (res && res.success) {
        statusMsgEl.textContent = `Thành công! Đã tìm thấy ${res.data.length} TKQC từ Via.`;
        checkSession(false);
      } else {
        statusMsgEl.textContent = `Lỗi: ${res?.error || "Không thể lấy TKQC"}`;
      }
    });
  };
});
