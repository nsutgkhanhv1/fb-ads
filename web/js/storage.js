/**
 * AMIT V1 - Local-First Storage Manager
 * Lưu trữ bền vững (Persistence) không phụ thuộc Web Login:
 * - Dữ liệu Live (TKQC, Via)
 * - Dữ liệu AMIT (Ghi chú Note, Cấu hình cột, Lịch sử Super Share)
 */

const AmitStorage = {
  KEYS: {
    ACCOUNTS: "amit_live_accounts",
    NOTES: "amit_account_notes",
    COLUMN_PREFS: "amit_column_prefs",
    HISTORY: "amit_exec_history",
    SETTINGS: "amit_user_settings",
    LAST_SYNC: "amit_last_sync_time"
  },

  // ==========================================
  // 1. LIVE ACCOUNTS DATASET
  // ==========================================
  getAccounts() {
    try {
      const data = localStorage.getItem(this.KEYS.ACCOUNTS);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  saveAccounts(accounts) {
    try {
      localStorage.setItem(this.KEYS.ACCOUNTS, JSON.stringify(accounts));
    } catch (e) {
      console.warn("[AMIT Storage] Không thể lưu accounts:", e);
    }
  },

  removeAccounts(idsToRemove) {
    const removeSet = new Set(idsToRemove.map(String));
    const current = this.getAccounts();
    const updated = current.filter(acc => !removeSet.has(String(acc.id)));
    this.saveAccounts(updated);
    return updated;
  },

  getLastSyncTime() {
    return localStorage.getItem(this.KEYS.LAST_SYNC) || null;
  },

  saveLastSyncTime(timeStr) {
    localStorage.setItem(this.KEYS.LAST_SYNC, timeStr || new Date().toLocaleString("vi-VN"));
  },

  /**
   * Hợp nhất TKQC từ nhiều Via khác nhau (Khử trùng lặp: 1 ID = 1 Row)
   */
  mergeAccounts(newAccounts, currentViaName = null) {
    const current = this.getAccounts();
    const map = new Map();

    current.forEach(acc => {
      map.set(String(acc.id), { ...acc });
    });

    newAccounts.forEach(newAcc => {
      const id = String(newAcc.id);
      if (map.has(id)) {
        const existing = map.get(id);
        const viaSet = new Set(Array.isArray(existing.via) ? existing.via : [existing.via]);
        if (Array.isArray(newAcc.via)) {
          newAcc.via.forEach(v => viaSet.add(v));
        } else if (newAcc.via) {
          viaSet.add(newAcc.via);
        }

        // UID các Via đang giữ TKQC (executor_uid cho Super Share)
        const uidSet = new Set([...(existing.viaUids || []), ...(newAcc.viaUids || [])].map(String));

        // Cập nhật các chỉ số live mới nhất, bảo vệ các giá trị đã chuẩn xác
        map.set(id, {
          ...existing,
          ...newAcc,
          viaUids: Array.from(uidSet),
          name: (newAcc.name && !newAcc.name.startsWith("TKQC ") && newAcc.name !== id) ? newAcc.name : existing.name,
          role: (newAcc.hasRealPerms && newAcc.role) ? newAcc.role : (existing.role || newAcc.role || "Quản trị viên"),
          disableReason: (newAcc.disableReason && newAcc.disableReason !== "—") ? newAcc.disableReason : (existing.disableReason || "—"),
          note: existing.note || newAcc.note || "",
          via: Array.from(viaSet)
        });
      } else {
        map.set(id, newAcc);
      }
    });

    const merged = Array.from(map.values());
    this.saveAccounts(merged);
    return merged;
  },

  // ==========================================
  // 2. AMIT NOTES (Ghi chú không bị xóa khi sync)
  // ==========================================
  getNotes() {
    try {
      const data = localStorage.getItem(this.KEYS.NOTES);
      return data ? JSON.parse(data) : {};
    } catch {
      return {};
    }
  },

  getNote(actId) {
    const notes = this.getNotes();
    return notes[actId] || "";
  },

  saveNote(actId, noteText) {
    const notes = this.getNotes();
    if (!noteText || !noteText.trim()) {
      delete notes[actId];
    } else {
      notes[actId] = noteText.trim();
    }
    localStorage.setItem(this.KEYS.NOTES, JSON.stringify(notes));
  },

  // ==========================================
  // 3. COLUMN PREFERENCES
  // ==========================================
  getColumnPrefs() {
    try {
      const data = localStorage.getItem(this.KEYS.COLUMN_PREFS);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  },

  saveColumnPrefs(prefs) {
    localStorage.setItem(this.KEYS.COLUMN_PREFS, JSON.stringify(prefs));
  },

  // ==========================================
  // 4. EXECUTION HISTORY & EXPORT
  // ==========================================
  getHistory() {
    try {
      const data = localStorage.getItem(this.KEYS.HISTORY);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  addHistoryItem(item) {
    const history = this.getHistory();
    history.unshift({
      id: `hist_${Date.now()}`,
      time: new Date().toLocaleTimeString("vi-VN") + " " + new Date().toLocaleDateString("vi-VN"),
      ...item
    });
    // Giữ tối đa 50 item lịch sử
    while (history.length > 50) history.pop();
    // Lịch sử có kết quả từng TKQC nên có thể lớn: hết dung lượng thì bỏ bớt mục cũ nhất, không để làm hỏng luồng chạy
    while (history.length) {
      try {
        localStorage.setItem(this.KEYS.HISTORY, JSON.stringify(history));
        return;
      } catch (e) {
        if (history.length === 1) { console.warn("[AMIT Storage] Không lưu được lịch sử:", e); return; }
        history.pop();
      }
    }
  },

  clearHistory() {
    localStorage.removeItem(this.KEYS.HISTORY);
  },

  // ==========================================
  // 5. USER SETTINGS (Scale, Currency Mode)
  // ==========================================
  getSettings() {
    try {
      const data = localStorage.getItem(this.KEYS.SETTINGS);
      return data ? JSON.parse(data) : { currency: "MIX", scale: 100 };
    } catch {
      return { currency: "MIX", scale: 100 };
    }
  },

  saveSettings(newSettings) {
    const current = this.getSettings();
    localStorage.setItem(this.KEYS.SETTINGS, JSON.stringify({ ...current, ...newSettings }));
  }
};
