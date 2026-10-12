/**
 * AMIT V1 - Super Share Module (theo SUPER SHARE FACEBOOK EXECUTION REQUIREMENT V1)
 * Web chỉ cấu hình + hiển thị. Extension thực thi và là nguồn sự thật của batch:
 *   Configure -> THỰC HIỆN -> Running -> Finished (không có Stop, không có xác nhận lần 2).
 * Không có Extension thì không chạy; tuyệt đối không mô phỏng kết quả.
 */

const AmitSuperShare = {
  selectedAccounts: new Set(),
  currentAction: "",
  batch: null, // batch mới nhất do Extension báo về
  currentPage: 1,
  pageSize: 50,
  currentAccountsList: [],
  _pollTimer: null,
  _endedBatchId: null,

  get isRunning() { return !!this.batch && this.batch.status === "RUNNING"; },
  get isPaused() { return !!this.batch && this.batch.status === "PAUSED"; },

  init() {
    this.bindSourceEvents();
    this.bindActionPanelEvents();
    this.bindHistoryEvents();
    this.bindPaginationEvents();
    this.renderHistory();
    this.listenExtensionMessages();
    this.recoverBatch();
  },

  bindPaginationEvents() {
    const pageSelect = document.querySelector("#workspace .pagination select");
    if (pageSelect) {
      pageSelect.onchange = e => {
        this.pageSize = parseInt(e.target.value) || 50;
        this.currentPage = 1;
        this.renderTable(this.currentAccountsList);
      };
    }
  },

  listenExtensionMessages() {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(msg => {
        if (msg && msg.action === "execution_progress_update" && msg.batch) {
          this.applyBatch(msg.batch);
        }
      });
    }
  },

  /** Mở lại Web khi batch vẫn đang chạy / đang PAUSED: lấy lại trạng thái từ Extension. */
  async recoverBatch() {
    if (!AmitBridge.isExtensionAvailable) return;
    const res = await AmitBridge.sendMessage("get_execution_status");
    if (res && res.success && res.batch) {
      this._endedBatchId = res.batch.status === "FINISHED" ? res.batch.id : null; // không ghi lại lịch sử cũ
      this.applyBatch(res.batch);
      if (res.batch.status === "RUNNING") this.startPolling();
    }
  },

  startPolling() {
    clearInterval(this._pollTimer);
    this._pollTimer = setInterval(async () => {
      const res = await AmitBridge.sendMessage("get_execution_status");
      if (res && res.success && res.batch) this.applyBatch(res.batch);
      if (!this.isRunning) clearInterval(this._pollTimer);
    }, 1000);
  },

  esc(s) {
    return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },

  // ==========================================
  // PROGRESS / RESULT (docx §29-§31, §52-§54)
  // ==========================================
  PAUSE_TEXT: {
    SESSION_EXPIRED: "Facebook đã hết phiên đăng nhập. Đăng nhập lại Facebook trên Chrome rồi bấm Tiếp tục.",
    FACEBOOK_CHECKPOINT: "Facebook yêu cầu xác minh bảo mật (checkpoint). Xử lý xong trên Chrome rồi bấm Tiếp tục.",
    FACEBOOK_REAUTH_REQUIRED: "Facebook yêu cầu xác thực lại (reauth). Xử lý xong trên Chrome rồi bấm Tiếp tục.",
    TOKEN_UNAVAILABLE: "Chưa lấy được token Ads Manager. Mở https://adsmanager.facebook.com một lần trên Chrome rồi bấm Tiếp tục.",
    RATE_LIMITED: "Facebook vẫn đang giới hạn tốc độ dù đã tự chờ và thử lại. Chờ vài phút rồi bấm Tiếp tục (các TKQC chưa xong được giữ nguyên trong hàng đợi).",
    EXTENSION_RESTARTED: "Extension vừa khởi động lại giữa chừng. Bấm Tiếp tục để chạy các TKQC chưa xong (TKQC đã xong không chạy lại).",
    CONTROLLER_ERROR: "Hệ thống gặp lỗi nội bộ. Bấm Tiếp tục để thử lại các TKQC chưa xong."
  },

  /** Graph engine: phương thức đã dùng, trạng thái xác minh, có Retry được không (rỗng với DOM engine). */
  targetTech(t) {
    const bits = [];
    if (t.method_used) bits.push(this.esc(t.method_used));
    if (t.verify_state) bits.push("verify: " + this.esc(t.verify_state));
    if (t.retryable === false) bits.push("không thể Retry");
    return bits.length ? ` <span style="color:#888">(${bits.join(" · ")})</span>` : "";
  },

  applyBatch(batch) {
    const prev = this.batch;
    this.batch = batch;
    if (!prev || prev.id !== batch.id || prev.status !== batch.status || prev.processed !== batch.processed) {
      AmitApp.log("info", "batch.update", { id: batch.id, status: batch.status, pause_reason: batch.pause_reason, total: batch.total, processed: batch.processed, success: batch.success, failed: batch.failed });
    }
    const $ = id => document.getElementById(id);

    $("progress").classList.remove("hidden");

    const total = batch.total || 0;
    const done = batch.processed || 0;
    const pending = batch.items.filter(i => i.status === "PENDING" || i.status === "RUNNING" || i.status === "PAUSED").length;
    $("barFill").style.width = `${total ? (done / total) * 100 : 0}%`;
    $("processed").textContent = `Đã xử lý: ${done} / ${total}`;
    $("okStat").textContent = `Thành công: ${batch.success || 0}`;
    $("failStat").textContent = `Thất bại: ${batch.failed || 0}`;
    $("queueStat").textContent = `Chờ: ${pending}`;

    const stateText = {
      RUNNING: batch.backoff ? this.backoffText(batch.backoff) : "Đang thực hiện",
      PAUSED: `Tạm dừng — ${this.PAUSE_TEXT[batch.pause_reason] ? "" : (batch.pause_reason || "")}`.replace(/ — $/, ""),
      FINISHED: this.finalSummary(batch)
    };
    $("execState").textContent = stateText[batch.status] || batch.status;

    $("resumeBox").classList.toggle("hidden", batch.status !== "PAUSED");
    $("pauseMsg").textContent = this.PAUSE_TEXT[batch.pause_reason] || batch.pause_reason || "";

    batch.items.forEach(it => {
      const cell = document.getElementById(`progress-${it.ad_account_id}`);
      if (cell) cell.innerHTML = this.progressCellHtml(it);
    });

    this.renderFailedList(batch);

    const hasFailed = batch.items.some(i => i.status === "FAILED");
    $("retryBox").classList.toggle("hidden", !(batch.status === "FINISHED" && hasFailed));

    if (batch.status === "FINISHED" && this._endedBatchId !== batch.id) {
      this._endedBatchId = batch.id;
      this.onBatchFinished(batch);
    }
    this.validateAction();
  },

  /** Graph engine đang chờ Facebook hết giới hạn tốc độ rồi tự chạy lại TKQC (docx kiến trúc §10.2). */
  backoffText(b) {
    const s = Math.max(0, Math.ceil((Date.parse(b.until) - Date.now()) / 1000));
    return `Facebook đang giới hạn tốc độ. Tự thử lại TKQC ${b.ad_account_id} sau ${s} giây (lần ${b.attempt}/${b.max})`;
  },

  /** Docx §31/§54: hiển thị số thực tế, không cần nhãn PARTIAL_SUCCESS. */
  finalSummary(b) {
    if (b.failed === 0) return `${b.success}/${b.total} thành công`;
    return `${b.success}/${b.total} thành công · ${b.failed} thất bại`;
  },

  progressCellHtml(it) {
    const tg = it.targets || [];
    const okN = tg.filter(t => t.status === "SUCCESS").length;
    const frac = tg.length > 1 ? ` (${okN}/${tg.length} UID)` : "";
    switch (it.status) {
      case "PENDING": return "Chờ";
      case "RUNNING": return "Đang thực hiện…";
      case "PAUSED": return `<span style="color:#ff9900">Tạm dừng</span>`;
      case "SUCCESS": return `<span style="color:#00875a">Thành công${frac}</span>`;
      case "FAILED":
        return `<span style="color:#de350b" title="${this.esc(it.error_message)}">Thất bại${frac}</span>`
          + ` <code style="font-size:10px">${this.esc(it.error_code)}</code>`
          + ` <button class="btn" style="padding:1px 5px;font-size:10px;margin-left:4px;height:20px" onclick="AmitSuperShare.retrySingle('${this.esc(it.ad_account_id)}')" title="Retry riêng TKQC này (chỉ phần thất bại)">↻</button>`;
      default: return this.esc(it.status);
    }
  },

  /** Chi tiết lỗi: TKQC ID, action, UID, error, reason (docx §14, §29, §54). */
  renderFailedList(batch) {
    const box = document.getElementById("failedBox");
    const list = document.getElementById("failedList");
    const failed = batch.items.filter(i => i.status === "FAILED");
    box.classList.toggle("hidden", failed.length === 0);
    if (!failed.length) { list.innerHTML = ""; return; }
    list.innerHTML = failed.map(it => {
      const bad = (it.targets || []).filter(t => t.status === "FAILED");
      const targets = bad.length
        ? `<ul style="margin:2px 0 0 16px;padding:0">${bad.map(t => `<li>UID <b>${this.esc(t.uid)}</b>: <code>${this.esc(t.error_code)}</code> — ${this.esc(t.error_message)}${this.targetTech(t)}</li>`).join("")}</ul>`
        : "";
      return `<div style="padding:6px 0;border-bottom:1px solid #eee">
        <b>TKQC ${this.esc(it.ad_account_id)}</b> · ${this.esc(it.action)}<br>
        <code>${this.esc(it.error_code)}</code> — ${this.esc(it.error_message)}
        <span style="color:#888">(bước ${this.esc(it.step || "?")}${it.finished_at ? ", " + this.esc(new Date(it.finished_at).toLocaleTimeString("vi-VN")) : ""})</span>
        ${targets}
      </div>`;
    }).join("");
  },

  /** Khi batch FINISHED: lưu lịch sử + đồng bộ dataset nếu có REMOVE_SELF thành công (docx §28). */
  onBatchFinished(batch) {
    AmitApp.log("info", "batch.finished", { id: batch.id, summary: this.finalSummary(batch) });
    this.syncDatasetAfterSelfRemoval(batch);

    const label = this.actionLabel(batch.items[0] && batch.items[0].action);
    AmitStorage.addHistoryItem({
      batch_id: batch.id,
      action: label,
      total: batch.total,
      ok: batch.success,
      fail: batch.failed,
      state: this.finalSummary(batch),
      // Kết quả TỪNG TKQC (thành công lẫn thất bại) - docx §22. Dạng gọn: [id, S|F|P, error_code, uid_thành_công, tổng_uid]
      results: batch.items.map(i => [
        i.ad_account_id,
        i.status === "SUCCESS" ? "S" : (i.status === "FAILED" ? "F" : "P"),
        i.error_code || "",
        (i.targets || []).filter(t => t.status === "SUCCESS").length,
        (i.targets || []).length
      ]),
      failed_items: batch.items.filter(i => i.status === "FAILED").map(i => ({
        ad_account_id: i.ad_account_id,
        action: i.action,
        error_code: i.error_code,
        error_message: i.error_message,
        step: i.step,
        finished_at: i.finished_at,
        targets: (i.targets || []).filter(t => t.status === "FAILED").map(t => ({ uid: t.uid, error_code: t.error_code, error_message: t.error_message }))
      }))
    });
    this.renderHistory();
    AmitApp.toast(`Execution hoàn tất: ${this.finalSummary(batch)}.`);
  },

  actionLabel(action) {
    const opt = [...document.querySelectorAll("#actionSelect option")].find(o => o.value === action);
    return opt ? opt.text : (action || "Super Share");
  },

  syncDatasetAfterSelfRemoval(batch) {
    const removed = batch.items.filter(i => i.status === "SUCCESS" && i.note === "SELF_REMOVED");
    if (!removed.length) return;
    let accs = AmitStorage.getAccounts();
    removed.forEach(it => {
      accs = accs.flatMap(a => {
        if (String(a.id) !== String(it.ad_account_id)) return [a];
        const uids = (a.viaUids || []).filter(u => String(u) !== String(it.executor_uid));
        return uids.length ? [{ ...a, viaUids: uids }] : []; // không còn Via nào có quyền -> biến mất khỏi dataset
      });
      this.selectedAccounts.delete(String(it.ad_account_id));
    });
    AmitStorage.saveAccounts(accs);
    AmitAdsTable.render();
    this.reloadFromStorage();
  },

  // ==========================================
  // 1. CHỌN NGUỒN (SOURCE SELECTION)
  // ==========================================
  bindSourceEvents() {
    const radioAll = document.querySelector('input[name="src"][value="all"]');
    const radioIds = document.querySelector('input[name="src"][value="ids"]');
    const idArea = document.getElementById("idArea");
    const loadBtn = document.getElementById("loadBtn");
    const changeSourceBtn = document.getElementById("changeSource");

    document.querySelectorAll('input[name="src"]').forEach(r => {
      r.onchange = () => {
        const byId = radioIds.checked;
        idArea.classList.toggle("hidden", !byId);
        document.querySelectorAll(".radio-row").forEach(row => row.classList.remove("selected"));
        r.closest(".radio-row").classList.add("selected");
      };
    });

    this.refreshAdsSourceHint();

    loadBtn.onclick = () => {
      const byId = radioIds.checked;
      const byAds = !!document.querySelector('input[name="src"][value="ads"]:checked');
      const allAccounts = AmitStorage.getAccounts();
      const loadMsg = document.getElementById("loadMsg");
      const idErr = document.getElementById("idErr");
      this.selectedAccounts = new Set();
      const source = byId ? "ids" : (byAds ? "ads" : "all");
      AmitApp.log("info", "source.load.click", { source, dataset: allAccounts.length });

      if (byId) {
        const text = document.getElementById("idInput").value;
        const parsed = this.parseIds(text);
        if (!parsed.good) {
          idErr.textContent = "Danh sách phải có ít nhất 1 ID hợp lệ, mỗi dòng 1 ID (chỉ chứa số).";
          idErr.classList.remove("hidden");
          return;
        }
        idErr.classList.add("hidden");

        const targetSet = new Set(parsed.list);
        const matched = allAccounts.filter(a => targetSet.has(String(a.id || a.account_id)));
        const notFound = parsed.list.length - matched.length;

        loadMsg.textContent = `Đã tải: ${matched.length} TKQC · Không tìm thấy: ${notFound} ID trong dataset`;
        // Không bao giờ nạp TKQC mà người dùng không liệt kê: không khớp ID nào thì ở lại màn chọn nguồn.
        if (!matched.length) { AmitApp.log("warn", "source.load.no_match", { source, wanted: parsed.list.length }); return; }
        this.renderTable(matched);
      } else if (byAds) {
        // Docx §45: nguồn = TKQC đã chọn ở Ads Check; được chọn sẵn để thao tác
        idErr.classList.add("hidden");
        const picked = new Set([...AmitAdsTable.selectedIds].map(String));
        const matched = allAccounts.filter(a => picked.has(String(a.id)));
        if (!matched.length) {
          AmitApp.log("warn", "source.load.no_selection", { source });
          loadMsg.textContent = "Chưa chọn TKQC nào ở Ads Check. Hãy tích chọn ở màn Ads Check rồi quay lại.";
          return;
        }
        matched.forEach(a => this.selectedAccounts.add(String(a.id)));
        loadMsg.textContent = `Đã tải ${matched.length} TKQC đã chọn ở Ads Check.`;
        this.renderTable(matched);
      } else {
        idErr.classList.add("hidden");
        loadMsg.textContent = `Đã tải toàn bộ ${allAccounts.length} TKQC khả dụng.`;
        this.renderTable(allAccounts);
      }

      AmitApp.log("info", "source.loaded", { source, rendered: this.currentAccountsList.length, preselected: this.selectedAccounts.size, message: loadMsg.textContent });
      // Chuyển sang Workspace
      document.getElementById("sourceView").classList.add("hidden");
      document.getElementById("workspace").classList.add("active");
    };

    if (changeSourceBtn) {
      changeSourceBtn.onclick = () => {
        if (this.isRunning) {
          AmitApp.toast("Không thể đổi nguồn khi Execution đang chạy.");
          return;
        }
        document.getElementById("workspace").classList.remove("active");
        document.getElementById("sourceView").classList.remove("hidden");
      };
    }

    // Nút Xóa TKQC khỏi Workspace Super Share
    const ssDelBtn = document.getElementById("ssDeleteSelectedBtn");
    if (ssDelBtn) {
      ssDelBtn.onclick = () => {
        const count = this.selectedAccounts.size;
        if (!count) return;
        AmitApp.openModal(
          "Xóa khỏi Workspace",
          `<p>Bạn có chắc muốn xóa <b>${count}</b> TKQC đã chọn ra khỏi Workspace?</p><p class="hint">Dữ liệu sẽ được xóa khỏi bộ nhớ máy.</p>`,
          () => {
            AmitStorage.removeAccounts([...this.selectedAccounts]);
            this.selectedAccounts.clear();
            const updated = AmitStorage.getAccounts();
            this.renderTable(updated);
            AmitAdsTable.render();
            AmitApp.toast(`Đã xóa ${count} TKQC khỏi Workspace.`);
          }
        );
      };
    }
  },

  /** Cập nhật dòng gợi ý của nguồn "TKQC đã chọn ở Ads Check". */
  refreshAdsSourceHint() {
    const n = (typeof AmitAdsTable !== "undefined" && AmitAdsTable.selectedIds) ? AmitAdsTable.selectedIds.size : 0;
    const hint = document.getElementById("adsSelHint");
    if (hint) hint.textContent = n > 0 ? `Đang chọn ${n} TKQC ở Ads Check.` : "Chưa chọn TKQC nào ở Ads Check.";
  },

  parseIds(text, max = null) {
    const list = [...new Set(text.split(/\n/).map(x => x.trim()).filter(Boolean))];
    const allNumeric = list.every(x => /^\d+$/.test(x));
    const good = allNumeric && list.length > 0 && (!max || list.length <= max);
    return { list, good };
  },

  // ==========================================
  // 2. BẢNG SUPER SHARE (CENTER WORKSPACE)
  // ==========================================
  renderTable(accounts) {
    this.currentAccountsList = accounts;
    const tableWrap = document.getElementById("ssTable");
    if (!tableWrap) return;

    const totalPages = Math.max(1, Math.ceil(accounts.length / this.pageSize));
    if (this.currentPage > totalPages) this.currentPage = totalPages;
    const startIndex = (this.currentPage - 1) * this.pageSize;
    const pageData = accounts.slice(startIndex, startIndex + this.pageSize);

    // Cập nhật Pagination UI Super Share
    const pageInfo = document.querySelector("#workspace .pagination span:nth-of-type(2)");
    if (pageInfo) pageInfo.textContent = `Trang ${this.currentPage} / ${totalPages}`;

    tableWrap.innerHTML = `
      <table class="grid">
        <thead>
          <tr>
            <th class="c0"><input type="checkbox" id="ssSelectAll"></th>
            <th class="c1">Via ↕</th>
            <th class="c2">ID TKQC ↕</th>
            <th>Tài khoản ↕</th>
            <th>Quyền TKQC</th>
            <th>Trạng thái TKQC ↕</th>
            <th>Lý do khóa</th>
            <th>ID gốc</th>
            <th>Đang thuộc BM ↕</th>
            <th class="num">Số dư</th>
            <th class="num">Limit</th>
            <th>Tiền tệ ↕</th>
            <th title="Suy ra từ múi giờ của TKQC (không phải quốc gia của doanh nghiệp)">Quốc gia ↕</th>
            <th>Múi giờ</th>
            <th>Phương thức thanh toán</th>
            <th>Add thẻ</th>
            <th class="num">SL QTV</th>
            <th class="num">SL Đối tác</th>
            <th>Tiến trình</th>
          </tr>
        </thead>
        <tbody id="ssTableBody">
          ${pageData.map(x => this.renderTableRow(x)).join("")}
        </tbody>
      </table>
    `;

    // Bind Select All
    const selectAll = document.getElementById("ssSelectAll");
    if (selectAll) {
      selectAll.checked = pageData.length > 0 && pageData.every(x => this.selectedAccounts.has(String(x.id)));
      selectAll.onchange = e => {
        pageData.forEach(x => {
          if (x.status === "Không đủ quyền") return; // Bỏ qua con không đủ quyền
          if (e.target.checked) this.selectedAccounts.add(String(x.id));
          else this.selectedAccounts.delete(String(x.id));
        });
        this.renderTable(accounts);
        this.updateSelectionStats();
      };
    }

    // Bind row checkbox
    tableWrap.querySelectorAll(".ss-check").forEach(chk => {
      chk.onchange = () => {
        const id = chk.dataset.id;
        if (chk.checked) this.selectedAccounts.add(id);
        else this.selectedAccounts.delete(id);
        this.updateSelectionStats();
      };
    });

    this.updateSelectionStats();
  },

  renderTableRow(x) {
    const isChecked = this.selectedAccounts.has(String(x.id));
    const isPermDisabled = x.status === "Không đủ quyền";
    const viaList = Array.isArray(x.via) ? x.via : [x.via || "—"];
    const viaHtml = viaList.map(v => {
      const online = AmitAdsTable.isViaOnline(v);
      return `
        <div class="via-tag">
          <span class="${online ? 'dot-online' : 'dot-offline'}" title="${online ? 'Via đang Online' : 'Via đang Offline'}"></span>
          <span>${v}</span>
          ${online ? '' : '<span style="font-size:10px;color:#999">(Offline)</span>'}
        </div>
      `;
    }).join("");

    const badgeClass = x.status === "Hoạt động"
      ? "badge-active"
      : (x.status === "Vô hiệu hóa" ? "badge-disabled" : "badge-hold");

    const roleBadgeClass = x.role === "Quản trị viên"
      ? "badge-role-admin"
      : (x.role === "Nhà quảng cáo" ? "badge-role-advertiser" : "badge-role-analyst");

    const reasonHtml = x.disableReason && x.disableReason !== "—"
      ? `<span class="badge badge-reason">${x.disableReason}</span>`
      : "—";

    return `
      <tr>
        <td class="c0">
          <input type="checkbox" class="ss-check" data-id="${x.id}"
            ${isChecked ? "checked" : ""}
            ${isPermDisabled ? 'disabled title="Không đủ quyền thao tác"' : ""}>
        </td>
        <td class="c1">${viaHtml}</td>
        <td class="c2">
          <span>${x.id}</span>
          <span class="copy-icon" onclick="AmitAdsTable.copyId('${x.id}')">📋</span>
        </td>
        <td><b>${x.name || "—"}</b></td>
        <td><span class="badge ${roleBadgeClass}">${x.role || "Quản trị viên"}</span></td>
        <td><span class="badge ${badgeClass}">${x.status || "—"}</span></td>
        <td>${reasonHtml}</td>
        <td>${x.origin || "—"}</td>
        <td>${x.bm || "—"}</td>
        <td class="num">${Number(x.balance || 0).toLocaleString("vi-VN")}</td>
        <td class="num">${typeof x.limit === "number" ? x.limit.toLocaleString("vi-VN") : x.limit}</td>
        <td>${x.currency || "USD"}</td>
        <td>${x.country || "—"}</td>
        <td>${AmitAdsTable.formatTimezone(x) || "—"}</td>
        <td>${x.pay || "—"}</td>
        <td>${x.card || "—"}</td>
        <td class="num" id="ss-admin-${x.id}">${x.admin ?? "—"}</td>
        <td class="num">${x.partner ?? "—"}</td>
        <td id="progress-${x.id}">${this.renderProgressCell(x)}</td>
      </tr>
    `;
  },

  renderProgressCell(x) {
    const it = this.batch && this.batch.items.find(i => String(i.ad_account_id) === String(x.id));
    if (it) return this.progressCellHtml(it);
    return x.progress || "—";
  },

  reloadFromStorage() {
    const allAccounts = AmitStorage.getAccounts();
    const ws = document.getElementById("workspace");
    if (ws && ws.classList.contains("active")) {
      this.renderTable(allAccounts);
    }
  },

  // ==========================================
  // 3. ACTION PANEL (5 ACTIONS V1)
  // ==========================================

  /** Luật UID theo docx (§3, §8, §47), lấy từ Core để Web và Extension không lệch nhau. */
  uidRule(action) {
    const def = AmitSuperShareCore.ACTION_DEFS[action];
    return def && def.uid ? def.uid : null;
  },

  readDelay() {
    const { MIN, MAX, DEFAULT } = AmitSuperShareCore.DELAY;
    const raw = document.getElementById("delay")?.value;
    if (raw === "" || raw === undefined) return DEFAULT;
    const n = Number(raw);
    return Number.isFinite(n) && n >= MIN && n <= MAX ? n : NaN;
  },

  // Trả về { ok, message } cho UID của action hiện tại (ok=true nếu action không nhập UID).
  checkUids(action, text) {
    const rule = this.uidRule(action);
    if (!rule) return { ok: true, message: "" };
    const list = [...new Set(text.split(/\n/).map(x => x.trim()).filter(Boolean))];
    if (!list.every(x => /^\d+$/.test(x))) {
      return { ok: false, message: "UID chỉ được gồm chữ số, mỗi dòng 1 UID." };
    }
    if (list.length < rule.min || list.length > rule.max) {
      return {
        ok: false,
        message: rule.min === 0
          ? `Nhập tối đa ${rule.max} UID (có thể để trống).`
          : `Cần ${rule.min}–${rule.max} UID hợp lệ.`
      };
    }
    return { ok: true, message: "" };
  },

  /** UID Via thực thi cho một TKQC (docx §26): Via đang online nếu nằm trong danh sách, ngược lại Via đầu tiên. */
  pickExecutorUid(acc) {
    const uids = (acc && acc.viaUids || []).map(String);
    if (!uids.length) return null;
    const active = AmitAdsTable.activeSession && AmitAdsTable.activeSession.uid ? String(AmitAdsTable.activeSession.uid) : null;
    return active && uids.includes(active) ? active : uids[0];
  },

  buildRequest(accountIds) {
    const action = this.currentAction;
    const uids = this.uidRule(action) ? this.parseIds(document.getElementById("uidField")?.value || "").list : [];
    const role = action === "SHARE_USER" ? (document.getElementById("roleField")?.value || "ADMIN") : null;
    const accounts = AmitStorage.getAccounts();
    return {
      items: accountIds.map(id => ({
        ad_account_id: String(id),
        action,
        target_uids: uids,
        role,
        executor_uid: this.pickExecutorUid(accounts.find(a => String(a.id) === String(id)))
      })),
      delay_seconds: this.readDelay()
    };
  },

  updateSelectionStats() {
    const count = this.selectedAccounts.size;
    const targetEl = document.getElementById("targetCount");
    const topEl = document.getElementById("selectedTop");
    const ssDelBtn = document.getElementById("ssDeleteSelectedBtn");

    if (targetEl) targetEl.textContent = `Đã chọn: ${count} TKQC`;
    if (topEl) topEl.textContent = `Đã chọn: ${count} TKQC`;
    if (ssDelBtn) ssDelBtn.style.display = count > 0 ? "inline-flex" : "none";
    this.validateAction();
  },

  bindActionPanelEvents() {
    const actionSelect = document.getElementById("actionSelect");
    const delayInput = document.getElementById("delay");
    const execBtn = document.getElementById("execute");

    actionSelect.onchange = () => {
      AmitApp.log("info", "action.select", { action: actionSelect.value });
      this.currentAction = actionSelect.value;
      this.renderDynamicInputs();
      this.validateAction();
    };

    delayInput.oninput = () => this.validateAction();

    execBtn.onclick = () => {
      AmitApp.log("info", "execute.click", { action: this.currentAction, selected: this.selectedAccounts.size, running: this.isRunning, paused: this.isPaused,
        uids: (document.getElementById("uidField") || {}).value ? this.parseIds(document.getElementById("uidField").value).list : [], role: (document.getElementById("roleField") || {}).value || null, delay: document.getElementById("delay") && document.getElementById("delay").value });
      if (this.isRunning) {
        AmitApp.toast("⚠️ Đang có tiến trình chạy. Vui lòng chờ hệ thống hoàn tất.");
        return;
      }

      if (this.selectedAccounts.size === 0) {
        AmitApp.toast("⚠️ Vui lòng tích chọn ít nhất 1 TKQC trên bảng bên trái!");
        const tableWrap = document.getElementById("ssTable");
        if (tableWrap) {
          tableWrap.style.boxShadow = "0 0 0 3px #de350b";
          setTimeout(() => tableWrap.style.boxShadow = "", 1500);
        }
        return;
      }

      if (!this.currentAction) {
        AmitApp.toast("⚠️ Vui lòng chọn Hành động cần thực hiện từ menu!");
        actionSelect.focus();
        actionSelect.style.borderColor = "#de350b";
        setTimeout(() => actionSelect.style.borderColor = "", 1500);
        return;
      }

      const uidField = document.getElementById("uidField");
      const uidCheck = this.checkUids(this.currentAction, uidField?.value || "");
      if (!uidCheck.ok) {
        AmitApp.toast(`⚠️ ${uidCheck.message}`);
        if (uidField) {
          uidField.focus();
          uidField.style.borderColor = "#de350b";
          setTimeout(() => uidField.style.borderColor = "", 1500);
        }
        return;
      }

      if (Number.isNaN(this.readDelay())) {
        AmitApp.toast("⚠️ Delay phải từ 3 đến 10 giây!");
        return;
      }

      // Docx §51: một CTA duy nhất. Riêng Graph engine + action xóa theo state: xem trước và xác nhận kế hoạch (docx kiến trúc §7.3).
      this.executeWithPreview();
    };

    // Tab switcher
    document.querySelectorAll(".panel .tab").forEach(tab => {
      tab.onclick = () => {
        document.querySelectorAll(".panel .tab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        const isAction = tab.dataset.tab === "action";
        document.getElementById("actionPanel").classList.toggle("hidden", !isAction);
        document.getElementById("historyPanel").classList.toggle("hidden", isAction);
      };
    });

    document.getElementById("retryAll").onclick = () => this.retryAllFailed();
    document.getElementById("resumeBtn").onclick = () => this.resumeBatch();
  },

  renderDynamicInputs() {
    const container = document.getElementById("dynamicFields");
    const a = this.currentAction;
    let html = "";

    if (this.uidRule(a)) {
      const labels = {
        SHARE_USER: "UID FACEBOOK (Tối đa 3 UID)",
        REMOVE_BY_UID_EXCEPT_SELF: "UID CẦN XÓA (Tối đa 3 UID)",
        REMOVE_ALL_EXCEPT_UIDS_AND_SELF: "UID CẦN GIỮ (Keep-list, tối đa 3 UID)"
      };
      const placeholders = {
        SHARE_USER: "Nhập tối đa 3 UID, mỗi dòng 1 UID\nVí dụ:\n1000123456\n1000789012",
        REMOVE_BY_UID_EXCEPT_SELF: "Nhập tối đa 3 UID cần xóa, mỗi dòng 1 UID",
        REMOVE_ALL_EXCEPT_UIDS_AND_SELF: "Nhập tối đa 3 UID muốn giữ lại, mỗi dòng 1 UID (có thể để trống)"
      };

      html += `
        <label class="label">${labels[a]}</label>
        <textarea id="uidField" class="control textarea" style="min-height:75px" placeholder="${placeholders[a]}"></textarea>
        <div id="uidErr" class="hint" style="color:#d32f2f"></div>
      `;
    }

    if (a === "SHARE_USER") {
      html += `
        <label class="label">VAI TRÒ (ROLE)</label>
        <select id="roleField" class="control">
          <option value="ADMIN">Quản trị viên</option>
          <option value="ADVERTISER">Nhà quảng cáo</option>
          <option value="ANALYST">Nhà phân tích quảng cáo</option>
        </select>
      `;
    }

    container.innerHTML = html;

    container.querySelectorAll("input, textarea, select").forEach(el => {
      el.oninput = () => this.validateAction();
    });
  },

  validateAction() {
    const a = this.currentAction;
    const targetSize = this.selectedAccounts.size;
    let inputOk = true;
    let errorMsg = "";

    // 1. Kiểm tra Delay (3–10 giây, mặc định 3)
    const delayOk = !Number.isNaN(this.readDelay());
    const delayErr = document.getElementById("delayErr");
    if (delayErr) {
      delayErr.textContent = delayOk ? "" : "Delay cần từ 3 đến 10 giây.";
      delayErr.style.color = delayOk ? "#777" : "#d32f2f";
    }

    // 2. Kiểm tra UID Inputs
    if (this.uidRule(a)) {
      const check = this.checkUids(a, document.getElementById("uidField")?.value || "");
      inputOk = check.ok;
      const uidErr = document.getElementById("uidErr");
      if (uidErr) uidErr.textContent = check.message;
    }

    // 3. Đánh giá tính hợp lệ tổng thể
    const canExecute = targetSize > 0 && !!a && inputOk && delayOk && !this.isRunning;
    const execBtn = document.getElementById("execute");
    const hintEl = document.getElementById("configHint");

    if (execBtn) execBtn.style.opacity = canExecute ? "1" : "0.8";

    if (targetSize === 0) errorMsg = "Chọn ít nhất 1 TKQC để thực hiện.";
    else if (!a) errorMsg = "Chọn Hành động.";
    else if (!inputOk) errorMsg = "Kiểm tra lại input bắt buộc.";
    else if (!delayOk) errorMsg = "Kiểm tra lại thời gian Delay.";

    if (hintEl) {
      hintEl.textContent = errorMsg;
      hintEl.style.color = errorMsg ? "#d32f2f" : "#777";
    }

    // 4. Cảnh báo nếu có TKQC thuộc Via Offline
    const allAccs = AmitStorage.getAccounts();
    const selectedAccs = allAccs.filter(acc => this.selectedAccounts.has(String(acc.id)));
    const offlineAccs = selectedAccs.filter(acc => {
      const vList = Array.isArray(acc.via) ? acc.via : [acc.via || ""];
      return !vList.some(v => AmitAdsTable.isViaOnline(v));
    });

    const warnEl = document.getElementById("offlineWarning");
    if (warnEl) {
      if (offlineAccs.length > 0 && targetSize > 0) {
        warnEl.classList.remove("hidden");
        warnEl.innerHTML = `⚠️ Có <b>${offlineAccs.length}</b> TKQC thuộc Via đang Offline.<div style="font-size:11px;margin-top:2px;">Cần đăng nhập lại Via tương ứng trên Chrome để có quyền thực hiện.</div>`;
      } else {
        warnEl.classList.add("hidden");
      }
    }
  },

  // ==========================================
  // 4a. XEM TRƯỚC KẾ HOẠCH XÓA (Graph engine; docx kiến trúc §7.3, §11.2)
  // ==========================================
  PREVIEW_CHUNK: 10, // mỗi lần gọi extension; chia nhỏ để service worker không bị tắt giữa chừng
  _previewing: false,

  ROLE_LABEL: { ADMIN: "Quản trị viên", ADVERTISER: "Nhà quảng cáo", ANALYST: "Nhà phân tích" },

  /**
   * Graph engine: 3 action xóa theo state (và REMOVE_SELF) phải được xem trước + xác nhận rồi mới chạy.
   * DOM engine không đọc được state nếu không mở Ads Manager nên giữ luồng một CTA của docx gốc (§51).
   */
  async executeWithPreview() {
    const def = AmitSuperShareCore.ACTION_DEFS[this.currentAction];
    if (!(def && def.preview) || !AmitBridge.isExtensionAvailable) return this.startExecution();
    const eng = await AmitBridge.sendMessage("get_super_share_engine");
    if (!(eng && eng.ok && eng.engine === "graph")) return this.startExecution();
    if (this._previewing) return;

    const req = this.buildRequest([...this.selectedAccounts]);
    const missing = req.items.filter(i => !i.executor_uid);
    if (missing.length) {
      AmitApp.toast(`⚠️ ${missing.length} TKQC chưa có UID của Via thực thi. Bấm Sync ở Ads Check để cập nhật rồi thử lại.`);
      return;
    }

    this._previewing = true;
    try {
      const previews = [];
      for (let i = 0; i < req.items.length; i += this.PREVIEW_CHUNK) {
        this.setPreviewProgress(previews.length, req.items.length);
        const res = await AmitBridge.sendMessage("super_share_preview", { items: req.items.slice(i, i + this.PREVIEW_CHUNK) });
        if (!res || !res.success) {
          AmitApp.log("warn", "preview.failed", { error: res && res.error });
          AmitApp.toast(`⚠️ Không xem trước được: ${res && (res.message || res.error) ? (res.message || res.error) : "Extension không phản hồi."}`);
          return;
        }
        previews.push(...res.previews);
        if (!res.complete) break; // gặp PAUSED: không đọc tiếp khi Facebook đang chặn
      }
      const paused = previews.find(p => p.status === "PAUSED");
      if (paused) {
        AmitApp.log("warn", "preview.paused", { error_code: paused.error_code, read: previews.length, total: req.items.length });
        AmitApp.toast(`⚠️ ${this.PAUSE_TEXT[paused.error_code] || paused.error_message} (đã dừng xem trước, chưa có gì bị thay đổi).`);
        return;
      }
      AmitApp.log("info", "preview.done", {
        action: this.currentAction, accounts: previews.length,
        ok: previews.filter(p => p.status === "OK").length, blocked: previews.filter(p => p.status === "BLOCKED").length,
        error: previews.filter(p => p.status === "ERROR").length, to_remove: previews.reduce((n, p) => n + p.remove_uids.length, 0)
      });
      this.showPreview(previews, req);
    } finally {
      this._previewing = false;
      this.setPreviewProgress(null);
    }
  },

  setPreviewProgress(done, total) {
    const hint = document.getElementById("configHint");
    if (!hint) return;
    if (done === null) { this.validateAction(); return; }
    hint.textContent = `Đang đọc danh sách người dùng để lập kế hoạch… ${done}/${total}`;
    hint.style.color = "#777";
  },

  /** Modal kế hoạch: người dùng thấy CHÍNH XÁC ai sẽ bị xóa ở từng TKQC rồi mới xác nhận. */
  showPreview(previews, req) {
    const runnable = previews.filter(p => p.snapshot); // OK + BLOCKED (BLOCKED vẫn chạy để ghi lỗi tường minh vào lịch sử)
    const skipped = previews.filter(p => !p.snapshot);
    const okPlans = previews.filter(p => p.status === "OK");
    const totalRemove = okPlans.reduce((n, p) => n + p.remove_uids.length, 0);
    const isSelf = this.currentAction === "REMOVE_SELF";
    const e = s => this.esc(s);
    const who = u => `${u.name ? e(u.name) + " " : ""}<span style="color:#888">(${e(u.uid)}${u.role ? ", " + e(this.ROLE_LABEL[u.role] || u.role) : ""})</span>`;

    const rows = previews.map(p => {
      let result, detail = "";
      if (p.status === "OK") {
        const gone = p.users.filter(u => u.mark === "REMOVE");
        result = p.remove_uids.length
          ? `<span style="color:#de350b;font-weight:600">${isSelf ? "Gỡ chính Via" : `Xóa ${p.remove_uids.length} người`}</span>`
          : `<span style="color:#00875a">Không có gì để xóa</span>`;
        detail = gone.slice(0, 8).map(u => `<div>– ${who(u)}</div>`).join("") + (gone.length > 8 ? `<div style="color:#888">…và ${gone.length - 8} người khác</div>` : "");
        const kept = p.users.filter(u => u.mark !== "REMOVE");
        detail += `<div style="color:#888;margin-top:2px">Giữ lại ${kept.length}: ${kept.slice(0, 6).map(u => e(u.uid) + (u.mark === "SELF" ? " (Via này)" : u.mark === "OWNER" ? " (chủ sở hữu)" : "")).join(", ")}${kept.length > 6 ? "…" : ""}</div>`;
        if (isSelf) detail += `<div style="color:#b35c00">Via này sẽ <b>mất quyền truy cập</b> TKQC${p.other_admins !== null ? ` (còn ${p.other_admins} Quản trị viên khác)` : ""}.</div>`;
      } else if (p.status === "BLOCKED") {
        result = `<span style="color:#d32f2f;font-weight:600">Bị chặn</span>`;
        detail = `<code>${e(p.error_code)}</code> — ${e(p.error_message)}<div style="color:#888">Sẽ ghi thất bại, không ai bị xóa.</div>`;
      } else {
        result = `<span style="color:#b35c00;font-weight:600">Bỏ qua</span>`;
        detail = `<code>${e(p.error_code)}</code> — ${e(p.error_message)}<div style="color:#888">Không đọc được danh sách người dùng nên không chạy TKQC này.</div>`;
      }
      return `<tr style="border-bottom:1px solid #eee;vertical-align:top">
        <td style="padding:6px"><b>${e(p.ad_account_id)}</b></td><td style="padding:6px;white-space:nowrap">${result}</td><td style="padding:6px">${detail}</td></tr>`;
    }).join("");

    const html = `
      <div style="line-height:1.55;font-size:13px">
        <div style="padding:8px 10px;border-radius:6px;background:#fff4e5;border:1px solid #ffd59a;margin-bottom:10px">
          ${isSelf ? "<b>Gỡ quyền chính Via thực thi.</b> " : ""}Sẽ xóa tổng cộng <b style="color:#de350b">${totalRemove}</b> người ở <b>${okPlans.filter(p => p.remove_uids.length).length}</b> TKQC.
          Thao tác này <b>không hoàn tác được</b>.
        </div>
        <div class="hint" style="margin-bottom:8px">
          ${runnable.length} TKQC sẽ chạy${skipped.length ? ` · <span style="color:#b35c00">${skipped.length} TKQC bỏ qua</span>` : ""}.
          Kế hoạch có hiệu lực ${Math.round(AmitSuperShareCore.SNAPSHOT_TTL_MS / 60000)} phút. Nếu danh sách người dùng của một TKQC thay đổi trước khi chạy tới nó,
          TKQC đó sẽ dừng với mã <code>SNAPSHOT_CHANGED</code> và không ai bị xóa.
        </div>
        <div style="max-height:340px;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="text-align:left;color:#707070"><th style="padding:4px 6px">TKQC</th><th style="padding:4px 6px">Kế hoạch</th><th style="padding:4px 6px">Chi tiết</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
      </div>`;

    if (!runnable.length) {
      AmitApp.openModal("Kế hoạch xóa — không có TKQC nào chạy được", html);
      return;
    }
    const items = req.items.filter(i => runnable.some(p => p.ad_account_id === i.ad_account_id))
      .map(i => Object.assign({}, i, { snapshot: runnable.find(p => p.ad_account_id === i.ad_account_id).snapshot }));
    AmitApp.openModal(
      isSelf ? "Xác nhận gỡ quyền chính Via" : "Xác nhận kế hoạch xóa",
      html,
      () => this.startExecution({ req: { items, delay_seconds: req.delay_seconds }, skipped: skipped.map(p => p.ad_account_id) }),
      `Xác nhận và thực hiện (${runnable.length} TKQC)`
    );
  },

  // ==========================================
  // 4. EXECUTION (do Extension chạy)
  // ==========================================
  /** opts.req: request đã dựng và đã xem trước (kèm snapshot); opts.skipped: TKQC không xem trước được nên không chạy. */
  async startExecution(opts) {
    opts = opts || {};
    if (!AmitBridge.isExtensionAvailable) {
      AmitApp.toast("⚠️ Chưa kết nối AMIT Extension nên không thể thực hiện. Vui lòng mở Web từ extension đã cài.");
      return;
    }

    const req = opts.req || this.buildRequest([...this.selectedAccounts]);
    const ids = req.items.map(i => i.ad_account_id);
    (opts.skipped || []).forEach(id => {
      const pEl = document.getElementById(`progress-${id}`);
      if (pEl) { pEl.textContent = "Bỏ qua (không xem trước được)"; pEl.style.color = "#b35c00"; }
    });
    AmitApp.log("info", "execute.request", { action: this.currentAction, accounts: ids.length, delay_seconds: req.delay_seconds,
      without_executor_uid: req.items.filter(i => !i.executor_uid).length, sample: req.items.slice(0, 3) });

    // Các action phụ thuộc SELF cần biết Via nào thực thi (docx §26): không đoán.
    const def = AmitSuperShareCore.ACTION_DEFS[this.currentAction];
    if (def && def.selfDependent) {
      const missing = req.items.filter(i => !i.executor_uid);
      if (missing.length) {
        AmitApp.toast(`⚠️ ${missing.length} TKQC chưa có UID của Via thực thi. Bấm Sync ở Ads Check để cập nhật rồi thử lại.`);
        return;
      }
    }

    ids.forEach(id => {
      const pEl = document.getElementById(`progress-${id}`);
      if (pEl) { pEl.textContent = "Chờ"; pEl.style.color = "#777"; }
    });

    const res = await AmitBridge.sendMessage("execute_super_share_batch", req);
    if (!res || !res.success) {
      AmitApp.toast(`⚠️ ${res && (res.message || res.error) ? (res.message || res.error) : "Extension không phản hồi."}`);
      return;
    }
    AmitApp.toast(`🚀 Bắt đầu thực thi: ${this.actionLabel(this.currentAction)}…`);
    this._endedBatchId = null;
    this.applyBatch(res.batch);
    if (res.batch.status === "RUNNING") this.startPolling();
  },

  async resumeBatch() {
    AmitApp.log("info", "resume.click", { pause_reason: this.batch && this.batch.pause_reason });
    const res = await AmitBridge.sendMessage("resume_batch");
    if (!res || !res.success) {
      AmitApp.toast(`⚠️ ${res && (res.message || res.error) ? (res.message || res.error) : "Extension không phản hồi."}`);
      return;
    }
    AmitApp.toast("Tiếp tục thực hiện các TKQC chưa xong…");
    const st = await AmitBridge.sendMessage("get_execution_status");
    if (st && st.batch) this.applyBatch(st.batch);
    this.startPolling();
  },

  async retryAllFailed() {
    await this.retry(null);
  },

  async retrySingle(actId) {
    await this.retry(actId);
  },

  /** Retry đúng phần FAILED (docx §42, §55); Extension tự xác định target nào cần chạy lại. */
  async retry(actId) {
    AmitApp.log("info", "retry.click", { only: actId || null, running: this.isRunning });
    if (this.isRunning) {
      AmitApp.toast("⚠️ Đang có tiến trình chạy.");
      return;
    }
    const res = await AmitBridge.sendMessage("retry_failed", actId ? { ad_account_id: actId } : {});
    if (!res || !res.success) {
      AmitApp.toast(`⚠️ ${res && (res.message || res.error) ? (res.message || res.error) : "Extension không phản hồi."}`);
      return;
    }
    AmitApp.toast(`Đang Retry ${res.batch.total} TKQC thất bại…`);
    this._endedBatchId = null;
    this.applyBatch(res.batch);
    if (res.batch.status === "RUNNING") this.startPolling();
  },

  // ==========================================
  // 5. LỊCH SỬ (HISTORY) & EXPORT
  // ==========================================
  bindHistoryEvents() {
    const exportBtn = document.getElementById("exportBtn");
    if (exportBtn) {
      exportBtn.onclick = () => this.exportHistory();
    }
  },

  renderHistory() {
    const historyList = document.getElementById("historyList");
    if (!historyList) return;

    const items = AmitStorage.getHistory();
    if (!items.length) {
      historyList.innerHTML = `<div class="hint" style="text-align:center;padding:20px;">Chưa có Execution nào trong phiên này.</div>`;
      return;
    }

    historyList.innerHTML = items.map((h, i) => `
      <div class="history-item">
        <strong>${this.esc(h.action)}</strong>
        <div style="color:#555;font-size:12px;">${this.esc(h.time)} · <span style="font-weight:600;">${this.esc(h.state)}</span></div>
        <div class="hint" style="margin-top:3px;">
          Target: <b>${h.total}</b> · Thành công: <b>${h.ok}</b> · Thất bại: <b>${h.fail}</b>
        </div>
        <button class="btn" style="margin-top:8px;font-size:12px;height:28px" onclick="AmitSuperShare.showHistoryDetail(${i})">Xem chi tiết</button>
      </div>
    `).join("");
  },

  showHistoryDetail(idx) {
    const items = AmitStorage.getHistory();
    const h = items[idx];
    if (!h) return;
    AmitApp.log("info", "history.detail", { batch_id: h.batch_id, state: h.state });

    const failedById = new Map((h.failed_items || []).map(f => [String(f.ad_account_id), f]));
    const statusText = { S: ["Thành công", "#00875a"], F: ["Thất bại", "#d32f2f"], P: ["Chưa xong", "#ff9900"] };

    const rows = (h.results || []).map(([id, s, code, okN, total]) => {
      const [text, color] = statusText[s] || [s, "#555"];
      const frac = total > 1 ? ` (${okN}/${total} UID)` : "";
      const f = failedById.get(String(id));
      const bad = f && (f.targets || []).length
        ? `<ul style="margin:2px 0 0 16px;padding:0">${f.targets.map(t => `<li>UID <b>${this.esc(t.uid)}</b>: <code>${this.esc(t.error_code)}</code> — ${this.esc(t.error_message)}${this.targetTech(t)}</li>`).join("")}</ul>`
        : "";
      return `<tr style="border-bottom:1px solid #eee;vertical-align:top">
        <td style="padding:4px 6px"><b>${this.esc(id)}</b></td>
        <td style="padding:4px 6px;color:${color};font-weight:600">${text}${frac}</td>
        <td style="padding:4px 6px">${code ? `<code>${this.esc(code)}</code>` : ""}${f ? ` ${this.esc(f.error_message)}` : ""}${bad}</td>
      </tr>`;
    }).join("");

    // Lịch sử cũ (trước khi có results) chỉ có danh sách thất bại
    const legacy = !h.results ? (h.failed_items || []).map(f => `
      <div style="padding:6px 0;border-bottom:1px solid #eee">
        <b>TKQC ${this.esc(f.ad_account_id)}</b> · ${this.esc(f.action)}<br>
        <code>${this.esc(f.error_code)}</code> — ${this.esc(f.error_message)}
      </div>`).join("") : "";

    AmitApp.openModal(
      `Chi tiết Execution: ${h.action}`,
      `
        <div style="line-height:1.6;font-size:13px">
          <p><b>Thời gian:</b> ${this.esc(h.time)}</p>
          <p><b>Kết quả:</b> ${this.esc(h.state)}</p>
          <p><b>Thành công:</b> <span style="color:#00875a;font-weight:700">${h.ok}</span> / ${h.total}
             · <b>Thất bại:</b> <span style="color:#d32f2f;font-weight:700">${h.fail}</span></p>
          <hr style="border:0;border-top:1px solid #eee;margin:12px 0">
          ${rows
            ? `<div style="max-height:320px;overflow-y:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">
                 <thead><tr style="text-align:left;color:#707070"><th style="padding:4px 6px">TKQC</th><th style="padding:4px 6px">Kết quả</th><th style="padding:4px 6px">Chi tiết</th></tr></thead>
                 <tbody>${rows}</tbody></table></div>`
            : (legacy || '<div class="hint">Không có dữ liệu chi tiết.</div>')}
        </div>
      `
    );
  },

  exportHistory() {
    AmitApp.log("info", "history.export", {});
    const items = AmitStorage.getHistory();
    if (!items.length) {
      AmitApp.toast("Lịch sử trống, không có dữ liệu để export.");
      return;
    }

    // Mỗi TKQC một dòng (thành công lẫn thất bại); TKQC có nhiều UID lỗi thì mỗi UID lỗi một dòng.
    const q = v => `"${String(v === undefined || v === null ? "" : v).replace(/"/g, '""')}"`;
    const label = { S: "Thành công", F: "Thất bại", P: "Chưa xong" };
    const rows = ["Batch,Action,Time,Kết quả batch,TKQC,Trạng thái,UID thành công/tổng,UID lỗi,Mã lỗi,Thông báo lỗi,Bước"];
    items.forEach(h => {
      const base = [q(h.batch_id || h.id), q(h.action), q(h.time), q(h.state)];
      const failedById = new Map((h.failed_items || []).map(f => [String(f.ad_account_id), f]));
      const results = h.results || (h.failed_items || []).map(f => [f.ad_account_id, "F", f.error_code, 0, (f.targets || []).length]);
      results.forEach(([id, s, code, okN, total]) => {
        const f = failedById.get(String(id));
        const frac = total ? `${okN}/${total}` : "";
        if (f && (f.targets || []).length) {
          f.targets.forEach(t => rows.push([...base, q(id), q(label[s]), q(frac), q(t.uid), q(t.error_code), q(t.error_message), q(f.step)].join(",")));
        } else {
          rows.push([...base, q(id), q(label[s] || s), q(frac), "", q(code), q(f ? f.error_message : ""), q(f ? f.step : "")].join(","));
        }
      });
    });

    const blob = new Blob(["﻿" + rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `amit_execution_history_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    AmitApp.toast("Đã xuất file CSV lịch sử thành công!");
  }
};
