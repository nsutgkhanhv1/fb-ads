/**
 * AMIT V1 - Ads Check Data Table Manager
 * Xử lý bảng 30 chỉ số, 3 cột cố định (Sticky), Sort, Filter, Search, Pagination, Scale & Currency.
 */

const AmitAdsTable = {
  containerId: "adsTable",
  searchQuery: "",
  sortColumn: null,
  sortDirection: 1, // 1: asc, -1: desc
  currentPage: 1,
  pageSize: 50,
  currencyMode: "MIX",
  scale: 100,
  selectedIds: new Set(),
  activeFilters: {
    status: new Set(["Hoạt động", "Vô hiệu hóa", "Nợ tiền / HOLD", "Không đủ quyền"]),
    bm: new Set(["all"])
  },
  hiddenColumns: new Set(),
  exchangeRate: 25400, // Tỷ giá USD/VND tham chiếu
  activeSession: null,

  async init() {
    await this.checkActiveSession();
    const settings = AmitStorage.getSettings();
    this.currencyMode = settings.currency || "MIX";
    this.scale = settings.scale || 100;

    const savedHiddenCols = AmitStorage.getColumnPrefs();
    if (savedHiddenCols && Array.isArray(savedHiddenCols)) {
      this.hiddenColumns = new Set(savedHiddenCols);
    }

    // Thiết lập tỷ lệ ban đầu
    const tableEl = document.getElementById(this.containerId);
    if (tableEl) {
      tableEl.style.fontSize = `${13 * (this.scale / 100)}px`;
    }

    this.bindEvents();
    this.render();
  },

  async checkActiveSession() {
    try {
      const res = await AmitBridge.sendMessage("get_active_session");
      if (res && res.success && res.session) {
        this.activeSession = res.session;
      } else {
        this.activeSession = null;
      }
    } catch {
      this.activeSession = null;
    }
  },

  isViaOnline(viaName) {
    if (!this.activeSession || !this.activeSession.uid) return false;
    const uid = String(this.activeSession.uid);
    const uName = (this.activeSession.userName || "").toLowerCase();
    const target = (viaName || "").toLowerCase();

    return target.includes(uid) || (uName && target.includes(uName)) || (uName && uName.includes(target));
  },

  bindEvents() {
    const searchInput = document.getElementById("adsSearch");
    if (searchInput) {
      searchInput.oninput = () => {
        this.searchQuery = searchInput.value.trim().toLowerCase();
        this.currentPage = 1;
        this.render();
      };
    }

    const currencySelect = document.getElementById("currency");
    if (currencySelect) {
      currencySelect.value = `Currency: ${this.currencyMode}`;
      currencySelect.onchange = () => {
        this.currencyMode = currencySelect.value.replace("Currency: ", "");
        AmitStorage.saveSettings({ currency: this.currencyMode });
        this.render();
      };
    }

    const zoomSelect = document.getElementById("zoom");
    if (zoomSelect) {
      zoomSelect.value = `Scale ${this.scale}%`;
      zoomSelect.onchange = () => {
        const val = parseInt(zoomSelect.value.replace(/[^0-9]/g, "")) || 100;
        this.scale = val;
        AmitStorage.saveSettings({ scale: val });
        const el = document.getElementById(this.containerId);
        if (el) el.style.fontSize = `${13 * (val / 100)}px`;
      };
    }

    const syncBtn = document.getElementById("syncBtn");
    if (syncBtn) {
      syncBtn.onclick = async () => {
        AmitApp.log("info", "sync.click", {});
        AmitApp.toast("Đang đồng bộ dữ liệu live từ Facebook…");
        const res = await AmitBridge.sendMessage("discovery_accounts");
        if (res && res.success && res.data) {
          // Hợp nhất dữ liệu tránh trùng lặp TKQC giữa nhiều Via
          const merged = AmitStorage.mergeAccounts(res.data, res.viaName || `Via ${res.via}`);
          AmitApp.log("info", "sync.done", { received: res.data.length, via: res.via, total_after_merge: merged.length, with_via_uids: merged.filter(a => (a.viaUids || []).length).length });
          AmitStorage.saveLastSyncTime();
          await this.checkActiveSession();
          this.render();
          AmitSuperShare.reloadFromStorage();
          AmitApp.toast(`Đã đồng bộ thành công ${res.data.length} TKQC từ ${res.viaName || "Via"}!`);
        } else {
          AmitApp.log("error", "sync.failed", { error: res && res.error });
          AmitApp.toast(`Đồng bộ thất bại: ${res?.error || "Lỗi không xác định"}`);
        }
      };
    }

    // Nút Xóa TKQC đã chọn khỏi bảng
    const delBtn = document.getElementById("deleteSelectedBtn");
    if (delBtn) {
      delBtn.onclick = () => {
        const count = this.selectedIds.size;
        if (!count) return;
        AmitApp.openModal(
          "Xóa tài khoản khỏi bảng",
          `<p>Bạn có chắc muốn xóa <b>${count}</b> TKQC đã chọn ra khỏi bảng Ads Check?</p><p class="hint">Dữ liệu ghi chú và snapshot của các TKQC này sẽ bị xóa khỏi bộ nhớ máy.</p>`,
          () => {
            AmitStorage.removeAccounts([...this.selectedIds]);
            this.selectedIds.clear();
            this.render();
            AmitSuperShare.reloadFromStorage();
            AmitApp.toast(`Đã xóa ${count} TKQC khỏi bảng.`);
          }
        );
      };
    }

    // Pagination events
    const pageSelect = document.querySelector("#ads .pagination select");
    if (pageSelect) {
      pageSelect.onchange = e => {
        this.pageSize = parseInt(e.target.value) || 50;
        this.currentPage = 1;
        this.render();
      };
    }

    const prevBtn = document.querySelector("#ads .pagination button:first-of-type");
    if (prevBtn) {
      prevBtn.onclick = () => {
        if (this.currentPage > 1) {
          this.currentPage--;
          this.render();
        }
      };
    }

    const nextBtn = document.querySelector("#ads .pagination button:last-of-type");
    if (nextBtn) {
      nextBtn.onclick = () => {
        const rawAccounts = AmitStorage.getAccounts();
        const filtered = this.filterData(rawAccounts);
        const totalPages = Math.max(1, Math.ceil(filtered.length / this.pageSize));
        if (this.currentPage < totalPages) {
          this.currentPage++;
          this.render();
        }
      };
    }
  },

  toggleColumn(colKey, isVisible) {
    if (isVisible) {
      this.hiddenColumns.delete(colKey);
    } else {
      this.hiddenColumns.add(colKey);
    }
    AmitStorage.saveColumnPrefs([...this.hiddenColumns]);
    this.render();
  },

  setFilterStatus(statusKey, isChecked) {
    if (isChecked) this.activeFilters.status.add(statusKey);
    else this.activeFilters.status.delete(statusKey);
    this.currentPage = 1;
    this.render();
  },

  formatMoney(val, origCurrency) {
    if (val === "—" || val === null || val === undefined) return "—";
    const num = Number(val);
    if (isNaN(num)) return val;

    if (this.currencyMode === "MIX") {
      return num.toLocaleString("vi-VN");
    }
    if (this.currencyMode === "VND") {
      if (origCurrency === "USD") {
        return (num * this.exchangeRate).toLocaleString("vi-VN");
      }
      return num.toLocaleString("vi-VN");
    }
    if (this.currencyMode === "USD") {
      if (origCurrency === "VND") {
        return (num / this.exchangeRate).toFixed(2);
      }
      return num.toLocaleString("en-US");
    }
    return num.toLocaleString("vi-VN");
  },

  getDisplayCurrency(origCurrency) {
    if (this.currencyMode === "MIX") return origCurrency;
    return this.currencyMode;
  },

  filterData(rawList) {
    let list = [...rawList];

    // 1. Status Filter
    if (this.activeFilters.status && this.activeFilters.status.size > 0) {
      list = list.filter(item => {
        // Nếu status rỗng, mặc định là Hoạt động
        const st = item.status || "Hoạt động";
        return this.activeFilters.status.has(st);
      });
    }

    // 2. Search Query
    if (this.searchQuery) {
      const q = this.searchQuery;
      list = list.filter(item => {
        const id = (item.id || item.account_id || "").toString().toLowerCase();
        const name = (item.name || "").toLowerCase();
        const viaStr = Array.isArray(item.via) ? item.via.join(" ").toLowerCase() : (item.via || "").toLowerCase();
        const bm = (item.bm || item.owner_business?.name || "").toLowerCase();
        const status = (item.status || "").toLowerCase();
        const role = (item.role || "").toLowerCase();
        const disReason = (item.disableReason || "").toLowerCase();
        const tz = this.formatTimezone(item).toLowerCase();
        return id.includes(q) || name.includes(q) || viaStr.includes(q) || bm.includes(q) || status.includes(q) || role.includes(q) || disReason.includes(q) || tz.includes(q);
      });
    }

    // 3. Sort Column
    if (this.sortColumn) {
      const col = this.sortColumn;
      const dir = this.sortDirection;
      list.sort((a, b) => {
        let vA = a[col] ?? "";
        let vB = b[col] ?? "";
        if (typeof vA === "number" && typeof vB === "number") {
          return (vA - vB) * dir;
        }
        return String(vA).localeCompare(String(vB), "vi", { numeric: true }) * dir;
      });
    }

    return list;
  },

  /** "Asia/Ho_Chi_Minh (UTC+7)"; thiếu dữ liệu (TKQC sync trước khi có cột này) thì "—". */
  formatTimezone(x) {
    const name = x && x.timezone ? String(x.timezone).replace(/_/g, " ") : "";
    const off = x && x.timezoneOffset !== undefined && x.timezoneOffset !== null && x.timezoneOffset !== "" ? Number(x.timezoneOffset) : null;
    let utc = "";
    if (off !== null && Number.isFinite(off)) {
      const sign = off < 0 ? "-" : "+";
      const abs = Math.abs(off);
      const h = Math.floor(abs);
      const m = Math.round((abs - h) * 60);
      utc = `UTC${sign}${h}${m ? ":" + String(m).padStart(2, "0") : ""}`;
    }
    if (name && utc) return `${name} (${utc})`;
    return name || utc || "";
  },

  sortBy(colName) {
    if (this.sortColumn === colName) {
      this.sortDirection = this.sortDirection === 1 ? -1 : 1;
    } else {
      this.sortColumn = colName;
      this.sortDirection = 1;
    }
    this.render();
  },

  render() {
    const rawAccounts = AmitStorage.getAccounts();
    const filtered = this.filterData(rawAccounts);

    // Tính toán số lượng Via độc nhất đã kết nối trong dataset
    const viaSet = new Set();
    rawAccounts.forEach(acc => {
      if (Array.isArray(acc.via)) acc.via.forEach(v => viaSet.add(v));
      else if (acc.via) viaSet.add(acc.via);
    });
    const subEl = document.querySelector("#ads .top .sub");
    if (subEl) {
      const syncTime = AmitStorage.getLastSyncTime();
      const timeStr = syncTime ? ` · Snapshot gần nhất: ${syncTime}` : "";
      subEl.textContent = `Dataset hiện tại (${rawAccounts.length} TKQC từ ${viaSet.size} Via)${timeStr}`;
    }

    // Hiển thị/Ẩn nút Xóa đã chọn
    const delBtn = document.getElementById("deleteSelectedBtn");
    const delCount = document.getElementById("delCount");
    if (delBtn) {
      delBtn.style.display = this.selectedIds.size > 0 ? "inline-flex" : "none";
      if (delCount) delCount.textContent = this.selectedIds.size;
    }

    const totalPages = Math.max(1, Math.ceil(filtered.length / this.pageSize));
    if (this.currentPage > totalPages) this.currentPage = totalPages;
    const startIndex = (this.currentPage - 1) * this.pageSize;
    const pageData = filtered.slice(startIndex, startIndex + this.pageSize);

    // Cập nhật Pagination UI
    const pageInfo = document.querySelector("#ads .pagination span:nth-of-type(2)");
    if (pageInfo) pageInfo.textContent = `Trang ${this.currentPage} / ${totalPages}`;
    const prevBtn = document.querySelector("#ads .pagination button:first-of-type");
    if (prevBtn) prevBtn.disabled = this.currentPage <= 1;
    const nextBtn = document.querySelector("#ads .pagination button:last-of-type");
    if (nextBtn) nextBtn.disabled = this.currentPage >= totalPages;

    const countEl = document.getElementById("adsCount");
    if (countEl) {
      countEl.textContent = `${filtered.length} TKQC (Trang ${this.currentPage}/${totalPages})`;
    }

    const tableWrap = document.getElementById(this.containerId);
    if (!tableWrap) return;

    if (!filtered.length) {
      tableWrap.innerHTML = `
        <div style="padding: 40px; text-align: center; color: #888;">
          <div style="font-size: 24px; margin-bottom: 8px;">∅</div>
          <b>Không tìm thấy tài khoản quảng cáo phù hợp</b>
          <div class="hint" style="margin-top: 4px;">Hãy thử xóa bớt điều kiện tìm kiếm hoặc đổi bộ lọc trạng thái.</div>
        </div>
      `;
      return;
    }

    // Header Sort Icon helper
    const sortIcon = col => {
      if (this.sortColumn !== col) return "↕";
      return this.sortDirection === 1 ? "▲" : "▼";
    };

    const isColHidden = col => this.hiddenColumns.has(col) ? 'style="display:none"' : '';

    // Render Table HTML
    const html = `
      <table class="grid">
        <thead>
          <tr>
            <th class="c0"><input type="checkbox" id="adsSelectAll"></th>
            <th class="c1" onclick="AmitAdsTable.sortBy('via')" style="cursor:pointer">Via ${sortIcon('via')}</th>
            <th class="c2" onclick="AmitAdsTable.sortBy('id')" style="cursor:pointer">ID TKQC ${sortIcon('id')}</th>
            <th ${isColHidden('name')} onclick="AmitAdsTable.sortBy('name')" style="cursor:pointer">Tài khoản ${sortIcon('name')}</th>
            <th ${isColHidden('role')} onclick="AmitAdsTable.sortBy('role')" style="cursor:pointer">Quyền TKQC ${sortIcon('role')}</th>
            <th ${isColHidden('status')} onclick="AmitAdsTable.sortBy('status')" style="cursor:pointer">Trạng thái ${sortIcon('status')}</th>
            <th ${isColHidden('disableReason')} onclick="AmitAdsTable.sortBy('disableReason')" style="cursor:pointer">Lý do khóa ${sortIcon('disableReason')}</th>
            <th ${isColHidden('origin')}>ID gốc</th>
            <th ${isColHidden('bm')} onclick="AmitAdsTable.sortBy('bm')" style="cursor:pointer">Đang thuộc BM ${sortIcon('bm')}</th>
            <th ${isColHidden('balance')} class="num" onclick="AmitAdsTable.sortBy('balance')" style="cursor:pointer">Số dư ${sortIcon('balance')}</th>
            <th ${isColHidden('limit')} class="num" onclick="AmitAdsTable.sortBy('limit')" style="cursor:pointer">Limit ${sortIcon('limit')}</th>
            <th ${isColHidden('currency')} onclick="AmitAdsTable.sortBy('currency')" style="cursor:pointer">Tiền tệ ${sortIcon('currency')}</th>
            <th ${isColHidden('country')} onclick="AmitAdsTable.sortBy('country')" style="cursor:pointer" title="Suy ra từ múi giờ của TKQC (không phải quốc gia của doanh nghiệp)">Quốc gia ${sortIcon('country')}</th>
            <th ${isColHidden('timezone')} onclick="AmitAdsTable.sortBy('timezoneOffset')" style="cursor:pointer">Múi giờ ${sortIcon('timezoneOffset')}</th>
            <th ${isColHidden('pay')}>Phương thức thanh toán</th>
            <th ${isColHidden('card')}>Add thẻ</th>
            <th ${isColHidden('admin')} class="num" onclick="AmitAdsTable.sortBy('admin')" style="cursor:pointer">SL QTV ${sortIcon('admin')}</th>
            <th ${isColHidden('partner')} class="num" onclick="AmitAdsTable.sortBy('partner')" style="cursor:pointer">SL Đối tác ${sortIcon('partner')}</th>
            <th ${isColHidden('note')}>Note</th>
          </tr>
        </thead>
        <tbody>
          ${pageData.map(x => this.renderRow(x)).join("")}
        </tbody>
      </table>
    `;

    tableWrap.innerHTML = html;

    // Bind checkbox Select All
    const selectAll = document.getElementById("adsSelectAll");
    if (selectAll) {
      selectAll.checked = pageData.length > 0 && pageData.every(x => this.selectedIds.has(x.id));
      selectAll.onchange = e => {
        pageData.forEach(x => {
          if (e.target.checked) this.selectedIds.add(x.id);
          else this.selectedIds.delete(x.id);
        });
        this.render();
      };
    }

    // Bind từng checkbox row
    tableWrap.querySelectorAll(".row-check").forEach(chk => {
      chk.onchange = () => {
        const id = chk.dataset.id;
        if (chk.checked) this.selectedIds.add(id);
        else this.selectedIds.delete(id);
      };
    });

    // Bind note inputs
    tableWrap.querySelectorAll(".note-input").forEach(inp => {
      inp.onblur = () => {
        const id = inp.dataset.id;
        AmitStorage.saveNote(id, inp.value);
      };
    });
  },

  renderRow(x) {
    const isChecked = this.selectedIds.has(x.id);
    const noteVal = AmitStorage.getNote(x.id) || x.note || "";

    // Xử lý hiển thị nhiều Via (mỗi Via 1 dòng) kèm trạng thái Online / Offline
    const viaList = Array.isArray(x.via) ? x.via : [x.via || "—"];
    const viaHtml = viaList.map(v => {
      const online = this.isViaOnline(v);
      return `
        <div class="via-tag">
          <span class="${online ? 'dot-online' : 'dot-offline'}" title="${online ? 'Via đang Online trên Chrome (Sẵn sàng thao tác)' : 'Via đang Offline / Đã đăng xuất (Chỉ xem Snapshot)'}"></span>
          <span>${v}</span>
          ${online ? '' : '<span style="font-size:10px;color:#999">(Offline)</span>'}
        </div>
      `;
    }).join("");

    // Trạng thái badge
    const badgeClass = x.status === "Hoạt động"
      ? "badge-active"
      : (x.status === "Vô hiệu hóa" ? "badge-disabled" : "badge-hold");

    // Quyền TKQC badge
    const roleBadgeClass = x.role === "Quản trị viên"
      ? "badge-role-admin"
      : (x.role === "Nhà quảng cáo" ? "badge-role-advertiser" : "badge-role-analyst");

    // Lý do khóa
    const reasonHtml = x.disableReason && x.disableReason !== "—"
      ? `<span class="badge badge-reason">${x.disableReason}</span>`
      : "—";

    const cur = x.currency || "USD";
    const dispCur = this.getDisplayCurrency(cur);
    const isColHidden = col => this.hiddenColumns.has(col) ? 'style="display:none"' : '';

    return `
      <tr>
        <td class="c0">
          <input type="checkbox" class="row-check" data-id="${x.id}" ${isChecked ? "checked" : ""}>
        </td>
        <td class="c1">${viaHtml}</td>
        <td class="c2">
          <span>${x.id}</span>
          <span class="copy-icon" onclick="AmitAdsTable.copyId('${x.id}')" title="Sao chép ID">📋</span>
        </td>
        <td ${isColHidden('name')}><b>${x.name || "—"}</b></td>
        <td ${isColHidden('role')}><span class="badge ${roleBadgeClass}">${x.role || "Quản trị viên"}</span></td>
        <td ${isColHidden('status')}><span class="badge ${badgeClass}">${x.status || "—"}</span></td>
        <td ${isColHidden('disableReason')}>${reasonHtml}</td>
        <td ${isColHidden('origin')}>${x.origin || "—"}</td>
        <td ${isColHidden('bm')}>${x.bm || "—"}</td>
        <td ${isColHidden('balance')} class="num">${this.formatMoney(x.balance, cur)}</td>
        <td ${isColHidden('limit')} class="num">${this.formatMoney(x.limit, cur)}</td>
        <td ${isColHidden('currency')}>${dispCur}</td>
        <td ${isColHidden('country')}>${x.country || "—"}</td>
        <td ${isColHidden('timezone')}>${this.formatTimezone(x) || "—"}</td>
        <td ${isColHidden('pay')}>${x.pay || "—"}</td>
        <td ${isColHidden('card')}>${x.card || "—"}</td>
        <td ${isColHidden('admin')} class="num">${x.admin ?? "—"}</td>
        <td ${isColHidden('partner')} class="num">${x.partner ?? "—"}</td>
        <td ${isColHidden('note')}>
          <input class="note-input" data-id="${x.id}" value="${noteVal}" placeholder="Thêm note…">
        </td>
      </tr>
    `;
  },

  copyId(id) {
    navigator.clipboard.writeText(id).then(() => {
      AmitApp.toast(`Đã chép ID TKQC: ${id}`);
    });
  }
};
