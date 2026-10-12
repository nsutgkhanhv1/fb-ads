/**
 * AMIT V1 - Permission Service / Graph driver (docx "Định hướng kiến trúc AMIT Super Share" §4-§7, §11, §12)
 *
 * Cài đặt DRIVER INTERFACE của AmitSuperShareCore bằng Facebook Graph thay cho thao tác DOM:
 *   core (validate, guard, verify, plan xóa hàng loạt, REMOVE_SELF ...)  ->  driver Graph (file này)  ->  AmitGraphClient
 * Nhờ vậy toàn bộ luật nghiệp vụ hiện có giữ nguyên; chỉ lớp thực thi đổi.
 *
 * Quy tắc:
 *  - Permission Service chọn contract (USERS | ASSIGNED_USERS | USERPERMISSIONS); KHÔNG đọc DOM, KHÔNG click.
 *  - Mutation thành công khi response.success === true. Không có success rõ ràng / timeout / 5xx -> "mơ hồ":
 *    KHÔNG ném lỗi mà để core ĐỌC LẠI và xác minh (core quyết định SUCCESS / FAILED / chưa xác minh).
 *  - Fallback sang contract thứ hai CHỈ khi lỗi thuộc nhóm "target không đủ điều kiện". Lỗi quyền, session,
 *    account, rate limit KHÔNG bao giờ fallback.
 *  - Mutation tuần tự; nghỉ 1-3 giây ngẫu nhiên giữa các mutation trong cùng TKQC (docx §10.2).
 *  - REMOVE_SELF: sau khi gỡ, token của chính executor mất quyền đọc -> "access denied" khi đọc lại là BẰNG CHỨNG
 *    đã gỡ (probeSelfRemoval.noAccess), chứ không phải lỗi verify.
 *  - Token / cookie không bao giờ nằm trong log hay kết quả.
 */
(function (root) {
  "use strict";

  const PURPOSE = "powerEditorAction";
  const MAX_PAGES = 20;
  const SETTLE_MS = 1000;
  const PACE_MS = [1000, 3000];

  const lazy = () => ({ SS: root.AmitSuperShareCore, C: root.AmitPermissionContracts, E: root.AmitFbErrors });

  /**
   * deps: { graph, tokens, sleep(ms), random(), log(level,event,data), policy:{ fallbackOnTargetError } }
   * item: AmitSuperShareCore.normalizeItem(...) (ad_account_id, executor_uid, source ...)
   */
  function createGraphDriver(deps, item) {
    const { SS, C, E } = lazy();
    const log = deps.log || (() => {});
    const sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const random = deps.random || Math.random;
    const policy = Object.assign({ fallbackOnTargetError: true }, deps.policy);
    const actId = item.ad_account_id;
    const metas = new Map();
    const state = { account: null, lastEntries: [], readOk: false, writes: 0, tokenInfo: null };

    const toDriverError = (e, step) => {
      if (e instanceof SS.DriverError) return e;
      if (e instanceof E.FbError) {
        const de = new SS.DriverError(e.error_code, e.message, step || "EXECUTE", { graph_code: e.graph_code, graph_subcode: e.graph_subcode, fbtrace_id: e.fbtrace_id, http_status: e.http_status, retry_after_ms: e.retry_after_ms || null });
        return de;
      }
      return new SS.DriverError(SS.ERR.FACEBOOK_ACTION_ERROR, e && e.message ? e.message : String(e), step || "EXECUTE");
    };

    const call = (spec, extra) => deps.graph.request(spec.path, Object.assign({
      method: spec.method, params: spec.params, tokenPurpose: PURPOSE, expectedUid: item.executor_uid || null, mutation: !!spec.mutation
    }, extra || {}));

    const metaFor = uid => {
      let m = metas.get(uid);
      if (!m) { m = { method_used: null, ambiguous: false, ambiguous_error: null }; metas.set(uid, m); }
      return m;
    };

    // ---------------- ĐỌC ----------------
    async function readPaged(spec) {
      const out = [];
      let after = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = Object.assign({}, spec.params);
        if (after) params.after = after;
        const res = await call(Object.assign({}, spec, { params }));
        if (!res || !Array.isArray(res.data)) {
          throw new E.FbError("GRAPH_RESPONSE_INVALID", "Danh sách người dùng có định dạng không như mong đợi.", { category: "contract" });
        }
        out.push(...res.data);
        const next = res.paging && res.paging.next && res.paging.cursors && res.paging.cursors.after;
        if (!next) return out;
        after = res.paging.cursors.after;
      }
      throw new E.FbError("VERIFY_UNAVAILABLE", `Danh sách người dùng quá dài (> ${MAX_PAGES} trang) nên không đọc đầy đủ được.`, { category: "contract" });
    }

    function toEntry(raw, via) {
      const uid = String(raw.id || raw.uid || (raw.user && raw.user.id) || "");
      const role = C.roleFromEntry(raw);
      return {
        uid: uid || null,
        name: raw.name || "",
        role,
        roleText: raw.role !== undefined && raw.role !== null ? String(raw.role) : (Array.isArray(raw.tasks) ? raw.tasks.join(",") : ""),
        via,
        protected: !!(uid && state.account && state.account.ownerId && uid === state.account.ownerId)
      };
    }

    // ---------------- GHI ----------------
    async function pace() {
      if (state.writes > 0) {
        const [lo, hi] = PACE_MS;
        await sleep(Math.round(lo + random() * (hi - lo)));
      }
      state.writes++;
    }

    /**
     * Gửi 1 mutation. Trả { ok:true } hoặc { ambiguous:true, error } (chưa biết kết quả -> để core đọc lại);
     * lỗi rõ ràng thì ném (FbError) cho nơi gọi quyết định có fallback hay không.
     */
    async function mutate(uid, spec, phase) {
      const m = metaFor(uid);
      m.method_used = spec.contract;
      log("info", "permission.method_selected", { request_id: `${item.request_id || ""}:${uid}`, ad_account_id: actId, uid, method: spec.contract, phase });
      await pace();
      try {
        const res = await call(spec);
        if (res && res.success === true) { m.ambiguous = false; m.ambiguous_error = null; return { ok: true }; }
        m.ambiguous = true;
        m.ambiguous_error = null;
        log("warn", "permission.response_ambiguous", { ad_account_id: actId, uid, method: spec.contract, has_success: !!(res && "success" in res) });
        return { ambiguous: true };
      } catch (e) {
        if (e instanceof E.FbError && e.ambiguous && e.category !== "rate_limit") {
          m.ambiguous = true;
          m.ambiguous_error = { code: e.error_code, message: e.message };
          return { ambiguous: true, error: e };
        }
        throw e;
      }
    }

    const businessId = () => (state.account && state.account.businessId) || null;
    const canFallback = e => policy.fallbackOnTargetError && e instanceof E.FbError && e.category === "target" && e.fallback_allowed;

    async function runContracts(uid, attempts) {
      let lastErr = null;
      for (let i = 0; i < attempts.length; i++) {
        try {
          return await mutate(uid, attempts[i](), i === 0 ? "primary" : "fallback");
        } catch (e) {
          lastErr = e;
          if (i < attempts.length - 1 && canFallback(e)) {
            log("info", "permission.fallback", { ad_account_id: actId, uid, from_error: e.error_code });
            continue;
          }
          throw toDriverError(e, "EXECUTE");
        }
      }
      throw toDriverError(lastErr, "EXECUTE");
    }

    const entryOf = uid => state.lastEntries.find(r => r.uid === uid) || null;

    const driver = {
      engine: "graph",
      requiresIdentity: true,

      async getSessionState() {
        try {
          state.tokenInfo = await deps.tokens.get(PURPOSE, {}); // chưa ép expectedUid: để core so sánh và báo EXECUTOR_IDENTITY_MISMATCH
          return "OK";
        } catch (e) {
          if (e instanceof E.FbError) {
            if (e.error_code === "SESSION_EXPIRED") return "EXPIRED";
            if (e.error_code === "FACEBOOK_CHECKPOINT") return "CHECKPOINT";
            if (e.error_code === "TOKEN_OWNER_MISMATCH") return "OK";
          }
          throw toDriverError(e, "SESSION");
        }
      },

      async getSessionUid() {
        return state.tokenInfo ? state.tokenInfo.user_id : null;
      },

      async openAccount(id) {
        try {
          const res = await call(C.contracts.account(id));
          if (!res || String(res.account_id || "").replace(/^act_/, "") !== String(id)) {
            throw new E.FbError("ACCOUNT_NOT_FOUND", `Không xác nhận được TKQC ${id} (Facebook trả về ID khác hoặc rỗng).`, { category: "account" });
          }
          const owner = res.owner !== undefined && res.owner !== null ? String(res.owner && res.owner.id ? res.owner.id : res.owner) : null;
          state.account = { id: String(id), ownerId: owner, businessId: res.owner_business && res.owner_business.id ? String(res.owner_business.id) : null };
        } catch (e) {
          if (e instanceof E.FbError && e.error_code === "INSUFFICIENT_PERMISSION") {
            throw new SS.DriverError(SS.ERR.ACCOUNT_ACCESS_DENIED, "Via không có quyền truy cập TKQC này.", "OPEN_ACCOUNT", { graph_code: e.graph_code });
          }
          throw toDriverError(e, "OPEN_ACCOUNT");
        }
      },

      async assertContext(id) {
        if (!state.account || state.account.id !== String(id)) {
          throw new SS.DriverError(SS.ERR.ACCOUNT_NOT_FOUND, `Ngữ cảnh TKQC không khớp (${id}). Không thực hiện write.`, "ASSERT_CONTEXT");
        }
      },

      async readRoles() {
        try {
          const direct = await readPaged(C.contracts.listUsers(actId));
          let entries = direct.map(r => toEntry(r, C.METHODS.USERS));
          const bm = businessId();
          if (bm) {
            try {
              const assigned = await readPaged(C.contracts.listAssignedUsers(actId, bm));
              const seen = new Set(entries.map(e => e.uid));
              assigned.forEach(r => { const e = toEntry(r, C.METHODS.ASSIGNED_USERS); if (e.uid && !seen.has(e.uid)) entries.push(e); });
            } catch (e) {
              // Chỉ làm danh sách THIẾU người (an toàn: không xóa nhầm), không làm hỏng việc đọc chính.
              if (e instanceof E.FbError && e.pause) throw e;
              log("warn", "permission.read_assigned_failed", { ad_account_id: actId, error_code: e.error_code });
            }
          }
          state.lastEntries = entries;
          state.readOk = true;
          return entries.map(e => Object.assign({}, e));
        } catch (e) {
          throw toDriverError(e, "READ_STATE");
        }
      },

      async addPerson(uid, role) {
        const bm = businessId();
        const viaBm = item.source === "BM_PICKER" && bm;
        const direct = () => C.contracts.grantDirect(actId, uid, role);
        const assigned = () => C.contracts.assignTasks(actId, uid, role);
        const attempts = viaBm ? [assigned, direct] : (bm ? [direct, assigned] : [direct]);
        return runContracts(uid, attempts);
      },

      async changeRole(uid, role) {
        const cur = entryOf(uid);
        const direct = () => C.contracts.grantDirect(actId, uid, role);
        const assigned = () => C.contracts.assignTasks(actId, uid, role);
        const attempts = cur && cur.via === C.METHODS.ASSIGNED_USERS ? [assigned] : [direct];
        return runContracts(uid, attempts);
      },

      async removePerson(uid) {
        const cur = entryOf(uid);
        if (cur && cur.protected) throw new SS.DriverError(SS.ERR.OWNER_PROTECTED, "Không thể gỡ chủ sở hữu TKQC.", "PRE_VALIDATE");
        const bm = businessId();
        const direct = () => C.contracts.revokeDirect(actId, uid);
        const viaBusiness = () => C.contracts.revokeBusinessUser(actId, uid, bm);
        const attempts = cur && cur.via === C.METHODS.ASSIGNED_USERS && bm ? [viaBusiness, direct] : (bm ? [direct, viaBusiness] : [direct]);
        return runContracts(uid, attempts);
      },

      async settle() { await sleep(SETTLE_MS); },

      /**
       * Bằng chứng REMOVE_SELF (docx fix #1): đọc lại bằng chính token của executor.
       *  - đọc được và không còn trong danh sách -> stillInList=false
       *  - đọc được và vẫn còn                   -> stillInList=true
       *  - bị từ chối quyền (đã từng đọc được)    -> noAccess=true  (đúng điều xảy ra khi tự gỡ chính mình)
       *  - lỗi khác (mạng, session, rate limit)   -> không có tín hiệu (core báo REMOVE_VERIFY_FAILED, không đoán)
       */
      async probeSelfRemoval(id, selfUid) {
        const sig = { facebookConfirmed: null, accountGone: null, noAccess: null, stillInList: null };
        try {
          const list = await readPaged(C.contracts.listUsers(id));
          sig.stillInList = list.some(r => String(r.id || r.uid) === String(selfUid));
        } catch (e) {
          if (e instanceof E.FbError && state.readOk && (e.error_code === "INSUFFICIENT_PERMISSION" || e.error_code === "ACCOUNT_NOT_FOUND")) {
            sig.noAccess = true;
          } else if (e instanceof E.FbError && e.pause) {
            throw toDriverError(e, "VERIFY");
          }
        }
        log("info", "permission.verify_result", { ad_account_id: id, self_removal: true, signals: sig });
        return sig;
      },

      targetMeta(uid) { return metas.get(uid) || null; }
    };
    return driver;
  }

  /**
   * Kết quả chuẩn cho một lệnh đơn (docx §5.1, §5.3). Dùng cho message `permission_execute`.
   */
  const ACTION_MAP = { GRANT: "SHARE_USER", CHANGE: "SHARE_USER", REVOKE: "REMOVE_BY_UID_EXCEPT_SELF" };

  function commandToItem(cmd) {
    return {
      ad_account_id: cmd.ad_account_id,
      action: ACTION_MAP[String(cmd.action || "").toUpperCase()] || String(cmd.action || ""),
      target_uids: cmd.target_uid ? [cmd.target_uid] : [],
      role: cmd.role || null,
      executor_uid: cmd.executor_uid,
      source: cmd.source || null
    };
  }

  function toPermissionResult(cmd, itemResult) {
    const t = (itemResult.targets || [])[0] || {};
    const unverified = t.verify_state === "UNAVAILABLE" || itemResult.error_code === "VERIFY_UNAVAILABLE";
    let status = itemResult.status === "SUCCESS" ? "SUCCESS" : (itemResult.status === "PAUSED" ? "FAILED" : "FAILED");
    if (unverified) status = "UNVERIFIED";
    if (itemResult.error_code === "CANCELLED") status = "CANCELLED";
    return {
      request_id: cmd.request_id || itemResult.request_id,
      ad_account_id: itemResult.ad_account_id,
      target_uid: cmd.target_uid || null,
      action: String(cmd.action || "").toUpperCase(),
      requested_role: cmd.role || undefined,
      status,
      method_used: t.method_used || undefined,
      verify_state: t.verify_state || undefined,
      note: t.note || itemResult.note || undefined,
      error_code: t.error_code || itemResult.error_code || undefined,
      error_message: t.error_message || itemResult.error_message || undefined,
      retryable: itemResult.status === "SUCCESS" ? false : (t.retryable !== undefined ? !!t.retryable : !!itemResult.retryable),
      started_at: itemResult.started_at,
      finished_at: itemResult.finished_at
    };
  }

  /** Chạy một item (một TKQC) bằng Graph engine thông qua core. Không ném lỗi. */
  async function runItem(deps, rawItem, opts) {
    const { SS } = lazy();
    const item = SS.normalizeItem(rawItem);
    const requestId = (opts && opts.requestId) || `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    item.request_id = requestId;
    const driver = createGraphDriver(deps, item);
    return SS.runItem(driver, rawItem, Object.assign({}, opts, { requestId, log: (opts && opts.log) || deps.log }));
  }

  const api = { createGraphDriver, runItem, commandToItem, toPermissionResult, PURPOSE };
  root.AmitPermissionService = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
