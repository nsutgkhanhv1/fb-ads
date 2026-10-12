/**
 * AMIT V1 - Main Web App Controller & Orchestrator
 */

const AmitApp = {
  currentScreen: "ads",

  /** Ghi log (không bao giờ làm hỏng UI nếu logger lỗi / chưa nạp). Sự kiện của Web đều có tiền tố "web.". */
  log(lvl, ev, data) {
    try { if (typeof AmitLog !== "undefined") AmitLog[lvl]("web." + ev, data); } catch (_) {}
  },

  async init() {
    if (typeof AmitLog !== "undefined") AmitLog.init("web");
    this.log("info", "init", { url: location.pathname, screen: this.currentScreen });
    console.log("[AMIT V1] Web App Workspace initializing…");

    await AmitBridge.init();
    AmitAdsTable.init();
    AmitSuperShare.init();

    this.bindNavigation();
    this.bindGlobalPopovers();
  },

  bindNavigation() {
    document.querySelectorAll(".nav").forEach(btn => {
      if (!btn.dataset.screen) return; // nút không phải màn hình (vd Log & báo lỗi) có handler riêng
      btn.onclick = () => {
        const target = btn.dataset.screen;
        this.switchScreen(target);
      };
    });

    const logsBtn = document.getElementById("openLogs");
    if (logsBtn) {
      logsBtn.onclick = () => {
        this.log("info", "open_logs_page", {});
        const url = chrome.runtime.getURL("extension/logs/logs.html");
        if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url });
        else window.open(url, "_blank");
      };
    }
  },

  switchScreen(screenName) {
    this.log("info", "screen", { from: this.currentScreen, to: screenName });
    this.currentScreen = screenName;

    // Cập nhật class active cho nav buttons
    document.querySelectorAll(".nav").forEach(b => {
      b.classList.toggle("active", b.dataset.screen === screenName);
    });

    // Ẩn/Hiện màn hình
    document.querySelectorAll("main > .screen").forEach(s => {
      s.classList.remove("active");
    });

    const targetScreen = document.getElementById(screenName);
    if (targetScreen) targetScreen.classList.add("active");

    // ĐỒNG BỘ DỮ LIỆU TỨC THÌ 100% GIỮA HAI MÀN HÌNH
    if (screenName === "ads") {
      AmitAdsTable.render();
    } else if (screenName === "super") {
      AmitSuperShare.reloadFromStorage();
      AmitSuperShare.refreshAdsSourceHint();
    }
  },

  // Popover filter & columns
  bindGlobalPopovers() {
    const filterBtn = document.getElementById("filterBtn");
    if (filterBtn) {
      filterBtn.onclick = e => {
        const isAct = AmitAdsTable.activeFilters.status.has("Hoạt động") ? "checked" : "";
        const isDis = AmitAdsTable.activeFilters.status.has("Vô hiệu hóa") ? "checked" : "";
        const isHold = AmitAdsTable.activeFilters.status.has("Nợ tiền / HOLD") ? "checked" : "";

        this.popover(e.currentTarget, `
          <div style="font-weight:700;margin-bottom:8px">Lọc trạng thái TKQC</div>
          <div class="checklist">
            <label><input type="checkbox" ${isAct} onchange="AmitAdsTable.setFilterStatus('Hoạt động', this.checked)"> Hoạt động</label>
            <label><input type="checkbox" ${isDis} onchange="AmitAdsTable.setFilterStatus('Vô hiệu hóa', this.checked)"> Vô hiệu hóa</label>
            <label><input type="checkbox" ${isHold} onchange="AmitAdsTable.setFilterStatus('Nợ tiền / HOLD', this.checked)"> Nợ tiền / HOLD</label>
          </div>
        `);
      };
    }

    const columnsBtn = document.getElementById("columnsBtn");
    if (columnsBtn) {
      columnsBtn.onclick = e => {
        const cols = [
          { key: "name", label: "Tài khoản (Tên TKQC)" },
          { key: "role", label: "Quyền TKQC (QTV/QC/Phân tích)" },
          { key: "status", label: "Trạng thái" },
          { key: "disableReason", label: "Lý do khóa" },
          { key: "origin", label: "ID gốc" },
          { key: "bm", label: "Đang thuộc BM" },
          { key: "balance", label: "Số dư" },
          { key: "limit", label: "Limit" },
          { key: "currency", label: "Tiền tệ" },
          { key: "country", label: "Quốc gia" },
          { key: "timezone", label: "Múi giờ" },
          { key: "pay", label: "Phương thức thanh toán" },
          { key: "card", label: "Add thẻ" },
          { key: "admin", label: "SL QTV" },
          { key: "partner", label: "SL Đối tác" },
          { key: "note", label: "Note" }
        ];

        const checklistHtml = cols.map(c => {
          const isChecked = !AmitAdsTable.hiddenColumns.has(c.key) ? "checked" : "";
          return `<label><input type="checkbox" ${isChecked} onchange="AmitAdsTable.toggleColumn('${c.key}', this.checked)"> ${c.label}</label>`;
        }).join("");

        this.popover(e.currentTarget, `
          <div style="font-weight:700;margin-bottom:8px">Tùy chỉnh cột hiển thị</div>
          <div class="checklist" style="max-height:240px;overflow-y:auto">
            <label><input type="checkbox" checked disabled> Chọn TKQC (Cố định)</label>
            <label><input type="checkbox" checked disabled> Via (Cố định)</label>
            <label><input type="checkbox" checked disabled> ID TKQC (Cố định)</label>
            ${checklistHtml}
          </div>
        `);
      };
    }

    const ssFilterBtn = document.getElementById("ssFilter");
    if (ssFilterBtn) {
      ssFilterBtn.onclick = e => {
        this.popover(e.currentTarget, `
          <div style="font-weight:700;margin-bottom:8px">Lọc TKQC Super Share</div>
          <div class="checklist">
            <label><input type="checkbox" checked onchange="AmitApp.toast('Đã cập nhật bộ lọc')"> Chỉ hiển thị TKQC đủ quyền</label>
            <label><input type="checkbox" checked onchange="AmitApp.toast('Đã cập nhật bộ lọc')"> Hiển thị tài khoản có thẻ</label>
          </div>
        `);
      };
    }
  },

  toggleQuickFilter(type, isChecked) {
    this.toast(`Đã cập nhật bộ lọc: ${type}`);
  },

  toast(message) {
    // Mọi thông báo người dùng nhìn thấy đều được ghi lại (lỗi / cảnh báo là warn)
    this.log(/⚠|thất bại|lỗi|không thể|chưa/i.test(String(message)) ? "warn" : "info", "toast", { message });
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.style.display = "block";
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      el.style.display = "none";
    }, 2200);
  },

  openModal(title, contentHtml, onConfirm = null) {
    this.log("info", "modal", { title, confirm: !!onConfirm });
    const modalBg = document.getElementById("modalBg");
    const modalTitle = document.getElementById("modalTitle");
    const modalBody = document.getElementById("modalBody");
    const modalConfirmBtn = document.getElementById("modalConfirmBtn");

    modalTitle.textContent = title;
    modalBody.innerHTML = contentHtml;

    if (modalConfirmBtn) {
      modalConfirmBtn.style.display = onConfirm ? "inline-block" : "none";
      modalConfirmBtn.onclick = () => {
        this.closeModal();
        if (onConfirm) onConfirm();
      };
    }

    modalBg.style.display = "flex";
  },

  closeModal() {
    const modalBg = document.getElementById("modalBg");
    if (modalBg) modalBg.style.display = "none";
  },

  popover(anchorEl, html) {
    document.querySelectorAll(".popover").forEach(p => p.remove());

    const p = document.createElement("div");
    p.className = "popover";
    p.innerHTML = html;

    const r = anchorEl.getBoundingClientRect();
    p.style.left = `${r.left}px`;
    p.style.top = `${r.bottom + 6}px`;

    document.body.appendChild(p);

    const onDocClick = e => {
      if (!p.contains(e.target) && e.target !== anchorEl) {
        p.remove();
        document.removeEventListener("click", onDocClick);
      }
    };
    setTimeout(() => document.addEventListener("click", onDocClick), 0);
  }
};

document.addEventListener("DOMContentLoaded", () => {
  AmitApp.init();
});
