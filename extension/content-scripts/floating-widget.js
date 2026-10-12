/**
 * AMIT V1 - Floating Ads Check Widget on Facebook Ads Manager
 * Hiển thị nút nổi và panel drawer xem nhanh thông số TKQC bằng Shadow DOM
 */

(function () {
  // Chỉ kích hoạt trên Ads Manager hoặc Billing Hub
  if (!window.location.href.includes("adsmanager.facebook.com") && !window.location.href.includes("billing_hub")) {
    return;
  }

  try {
    if (globalThis.AmitLog && !globalThis.AmitLog.__inited) globalThis.AmitLog.init("content");
    if (globalThis.AmitLog) globalThis.AmitLog.debug("widget.init", { page: window.location.origin + window.location.pathname });
  } catch (_) {}
  console.log("[AMIT V1] Floating Ads Check initialized");

  let currentActId = null;
  let shadowRoot = null;
  let container = null;
  let isOpen = false;
  let isExpanded = false;
  let cachedData = null;

  function getAccountIdFromUrl() {
    const href = window.location.href;
    const matchAct = href.match(/act=(\d+)/);
    if (matchAct) return matchAct[1];
    const matchAsset = href.match(/asset_id=(\d+)/);
    if (matchAsset) return matchAsset[1];
    const matchPay = href.match(/payment_account_id=(\d+)/);
    if (matchPay) return matchPay[1];
    return null;
  }

  function initWidget() {
    currentActId = getAccountIdFromUrl();
    if (!currentActId) return;

    if (container) return; // Đã tồn tại

    container = document.createElement("div");
    container.id = "amit-floating-host";
    container.style.position = "fixed";
    container.style.zIndex = "2147483647";
    container.style.right = "24px";
    container.style.bottom = "24px";
    document.body.appendChild(container);

    shadowRoot = container.attachShadow({ mode: "open" });

    renderWidget();
    fetchAccountData(currentActId);
  }

  function renderWidget() {
    if (!shadowRoot) return;

    shadowRoot.innerHTML = `
      <style>
        :host { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 13px; color: #1c1e21; }
        * { box-sizing: border-box; }
        
        .float-btn {
          width: 52px; height: 52px; border-radius: 50%;
          background: #1877f2; color: #fff;
          display: flex; align-items: center; justify-content: center;
          font-weight: 800; font-size: 16px; cursor: pointer;
          box-shadow: 0 4px 14px rgba(0,0,0,0.25);
          transition: transform 0.2s, background 0.2s;
          border: 2px solid #fff;
        }
        .float-btn:hover { transform: scale(1.06); background: #166fe5; }
        
        .drawer {
          position: fixed; right: 24px; bottom: 84px;
          width: 340px; max-height: calc(100vh - 120px);
          background: #fff; border-radius: 10px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.25);
          border: 1px solid #ddd;
          display: ${isOpen ? "flex" : "none"};
          flex-direction: column; overflow: hidden;
        }
        .drawer.expanded { width: 440px; }

        .drawer-head {
          background: #202020; color: #fff; padding: 12px 16px;
          display: flex; align-items: center; justify-content: space-between;
        }
        .drawer-head b { font-size: 14px; letter-spacing: 0.5px; }
        .head-actions { display: flex; gap: 8px; align-items: center; }
        .icon-btn { background: transparent; border: 0; color: #ccc; cursor: pointer; font-size: 16px; padding: 2px 6px; border-radius: 4px; }
        .icon-btn:hover { color: #fff; background: #333; }

        .drawer-body { padding: 14px; overflow-y: auto; flex: 1; }
        .stat-row { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid #f0f0f0; }
        .stat-row span:first-child { color: #65676b; }
        .stat-row b { font-weight: 600; text-align: right; }
        
        .badge { display: inline-block; padding: 2px 7px; border-radius: 10px; font-size: 11px; font-weight: 600; }
        .badge-active { background: #e7f3ff; color: #1877f2; }
        .badge-disabled { background: #ffebee; color: #e53935; }
        .badge-hold { background: #fff8e1; color: #f57f17; }

        .btn-expand {
          width: 100%; margin-top: 12px; padding: 8px;
          background: #f0f2f5; border: 1px solid #ccd0d5;
          border-radius: 6px; font-weight: 600; cursor: pointer;
          color: #050505; text-align: center;
        }
        .btn-expand:hover { background: #e4e6e9; }

        .full-info { display: ${isExpanded ? "block" : "none"}; margin-top: 10px; padding-top: 10px; border-top: 2px dashed #ddd; }
        .loading { text-align: center; padding: 20px; color: #888; }
      </style>

      <div class="float-btn" id="amitTrigger" title="AMIT V1 - Ads Check">AC</div>

      <div class="drawer ${isExpanded ? "expanded" : ""}" id="amitDrawer">
        <div class="drawer-head">
          <b>AMIT V1 Ads Check</b>
          <div class="head-actions">
            <button class="icon-btn" id="amitRefresh" title="Lấy lại dữ liệu">↻</button>
            <button class="icon-btn" id="amitClose" title="Đóng">×</button>
          </div>
        </div>
        <div class="drawer-body">
          ${renderDrawerContent()}
        </div>
      </div>
    `;

    shadowRoot.getElementById("amitTrigger").onclick = () => {
      isOpen = !isOpen;
      renderWidget();
    };

    shadowRoot.getElementById("amitClose").onclick = () => {
      isOpen = false;
      renderWidget();
    };

    const refBtn = shadowRoot.getElementById("amitRefresh");
    if (refBtn) {
      refBtn.onclick = () => fetchAccountData(currentActId, true);
    }

    const expBtn = shadowRoot.getElementById("amitExpand");
    if (expBtn) {
      expBtn.onclick = () => {
        isExpanded = !isExpanded;
        renderWidget();
      };
    }
  }

  function renderDrawerContent() {
    if (!cachedData) {
      return `<div class="loading">Đang tải dữ liệu TKQC ${currentActId}…</div>`;
    }

    const d = cachedData;
    const statusBadge = d.account_status === 1
      ? `<span class="badge badge-active">Hoạt động</span>`
      : (d.account_status === 2 ? `<span class="badge badge-disabled">Vô hiệu hóa</span>` : `<span class="badge badge-hold">Nợ tiền / HOLD</span>`);

    return `
      <div class="stat-row"><span>Tài khoản</span><b>${d.name || "—"}</b></div>
      <div class="stat-row"><span>ID TKQC</span><b>${d.account_id || currentActId}</b></div>
      <div class="stat-row"><span>Trạng thái</span>${statusBadge}</div>
      <div class="stat-row"><span>Limit ngày</span><b>${d.limitStr || "No limit"}</b></div>
      <div class="stat-row"><span>Ngưỡng</span><b>${d.thresholdStr || "—"}</b></div>
      <div class="stat-row"><span>Số dư / Dư nợ</span><b>${d.balanceStr || "0"}</b></div>
      <div class="stat-row"><span>Tổng tiêu</span><b>${d.spendStr || "0"}</b></div>
      <div class="stat-row"><span>Tiền tệ</span><b>${d.currency || "USD"}</b></div>
      <div class="stat-row"><span>Thẻ liên kết</span><b>${d.cardStr || "—"}</b></div>

      <button class="btn-expand" id="amitExpand">${isExpanded ? "Thu gọn thông số" : "Xem đầy đủ thông số"}</button>

      <div class="full-info">
        <div class="stat-row"><span>ID gốc</span><b>${d.owner || "—"}</b></div>
        <div class="stat-row"><span>Thuộc BM</span><b>${d.bmName || "—"}</b></div>
        <div class="stat-row"><span>Múi giờ</span><b>${d.timezone_name || "—"}</b></div>
        <div class="stat-row"><span>Ngày lập HĐ</span><b>${d.next_bill_date ? d.next_bill_date.substring(0, 10) : "—"}</b></div>
        <div class="stat-row"><span>SL Admin</span><b>${d.adminCount || 1}</b></div>
        <div class="stat-row"><span>Add thẻ</span><b>${d.hasCard ? "Có" : "Không"}</b></div>
      </div>
    `;
  }

  function fetchAccountData(actId, force = false) {
    if (cachedData && !force) return;
    cachedData = null;
    renderWidget();

    chrome.runtime.sendMessage({
      action: "inspect_single_account",
      accountId: actId
    }, response => {
      if (response && response.success && response.data) {
        const raw = response.data;
        const cur = raw.currency || "USD";
        const isNonCent = ["VND", "IDR", "KRW", "JPY", "TWD"].includes(cur);

        const threshRaw = raw.adspaymentcycle?.data?.[0]?.threshold_amount;
        const thresh = threshRaw ? (isNonCent ? threshRaw : threshRaw / 100) : null;

        const balRaw = raw.balance;
        const balance = balRaw ? (isNonCent ? balRaw : balRaw / 100) : 0;

        const spendRaw = raw.insights?.data?.[0]?.spend || 0;
        const limitRaw = raw.adtrust_dsl;

        const cardObj = raw.all_payment_methods?.pm_credit_card;

        cachedData = {
          ...raw,
          limitStr: limitRaw === -1 ? "No limit" : (limitRaw ? `${limitRaw.toLocaleString()} ${cur}` : "No limit"),
          thresholdStr: thresh ? `${thresh.toLocaleString()} ${cur}` : "—",
          balanceStr: `${balance.toLocaleString()} ${cur}`,
          spendStr: `${Number(spendRaw).toLocaleString()} ${cur}`,
          cardStr: cardObj ? cardObj.display_string : (raw.cards?.[0] ? `${raw.cards[0].association} •••• ${raw.cards[0].last4}` : "—"),
          hasCard: !!(cardObj || raw.cards?.length),
          bmName: raw.owner_business?.name || "Cá nhân",
          adminCount: raw.userpermissions?.data?.length || 1
        };
      } else {
        cachedData = {
          name: "Không thể đọc dữ liệu",
          account_id: actId,
          account_status: 2,
          limitStr: "—",
          thresholdStr: "—",
          balanceStr: "—",
          spendStr: "—",
          currency: "—",
          cardStr: "—"
        };
      }
      renderWidget();
    });
  }

  // Khởi động
  initWidget();

  // Kiểm tra URL thay đổi khi chuyển tài khoản trong Ads Manager
  setInterval(() => {
    const newAct = getAccountIdFromUrl();
    if (newAct && newAct !== currentActId) {
      currentActId = newAct;
      fetchAccountData(currentActId, true);
    }
  }, 2000);
})();
