/**
 * AMIT V1 - Super Share Core (theo "AMIT — SUPER SHARE FACEBOOK EXECUTION REQUIREMENT V1")
 *
 * Toàn bộ BUSINESS LOGIC của 5 action nằm ở đây, độc lập với trình duyệt.
 * Core chỉ nói chuyện với một "driver" (lớp thao tác UI Facebook) qua interface bên dưới,
 * nên test được bằng driver giả. Jev/DOM nằm ở driver, KHÔNG nằm ở đây (docx §11).
 *
 * DRIVER INTERFACE (mọi hàm async; lỗi UI ném DriverError):
 *   getSessionState()        -> "OK" | "EXPIRED" | "CHECKPOINT"
 *   getSessionUid()          -> uid hiện tại của session Facebook | null
 *   openAccount(actId)       -> mở TKQC và VERIFY current_ad_account_id == actId (ném ACCOUNT_NOT_FOUND ...)
 *   assertContext(actId)     -> ném nếu TKQC đang mở không phải actId (gọi trước mỗi write, docx Rule 06)
 *   readRoles()              -> [{ uid|null, name, role: "ADMIN"|"ADVERTISER"|"ANALYST"|null, roleText }]
 *   addPerson(uid, role)     -> thêm người + chọn role + confirm
 *   changeRole(uid, role)    -> đổi role của UID đang có
 *   removePerson(uid)        -> xóa người + confirm
 *   settle()                 -> chờ UI cập nhật sau write (technical wait, KHÔNG phải batch delay)
 *   probeSelfRemoval(actId, selfUid) -> { facebookConfirmed, accountGone, noAccess, stillInList } (true|false|null)
 *
 * TÙY CHỌN (driver Graph — extension/services/permission-service.js):
 *   engine                   -> "graph" | "dom" (mặc định "dom")
 *   requiresIdentity         -> true: luôn xác nhận executor_uid == chủ token trước mọi write (không chỉ action phụ thuộc SELF)
 *   readRoles() entry thêm   -> { protected: true } cho owner của TKQC (không bao giờ bị xóa)
 *   targetMeta(uid)          -> { method_used, ambiguous, ambiguous_error, ... } đính vào kết quả từng UID
 *   accountInfo()            -> { owner_id, business_id } của TKQC đang mở (dùng cho xem trước / snapshot)
 */
(function (root) {
  "use strict";

  // ============================================================
  // HẰNG SỐ
  // ============================================================
  const ACTIONS = Object.freeze({
    SHARE_USER: "SHARE_USER",
    REMOVE_BY_UID_EXCEPT_SELF: "REMOVE_BY_UID_EXCEPT_SELF",
    REMOVE_ALL_EXCEPT_UIDS_AND_SELF: "REMOVE_ALL_EXCEPT_UIDS_AND_SELF",
    REMOVE_ALL_EXCEPT_SELF: "REMOVE_ALL_EXCEPT_SELF",
    REMOVE_SELF: "REMOVE_SELF"
  });

  const ROLES = Object.freeze({ ADMIN: "ADMIN", ADVERTISER: "ADVERTISER", ANALYST: "ANALYST" });
  const DEFAULT_ROLE = ROLES.ADMIN;

  // uid: null = action không nhận UID; min/max số UID. (docx §3, §8, §47)
  const ACTION_DEFS = Object.freeze({
    SHARE_USER: { uid: { min: 1, max: 3 }, role: true, selfDependent: false, destructive: false, retryByTarget: true },
    REMOVE_BY_UID_EXCEPT_SELF: { uid: { min: 1, max: 3 }, role: false, selfDependent: true, destructive: true, retryByTarget: true },
    // preview: true = kế hoạch xóa phụ thuộc state hiện tại nên Graph engine bắt buộc xem trước + xác nhận (docx kiến trúc §7.3, §11.2)
    REMOVE_ALL_EXCEPT_UIDS_AND_SELF: { uid: { min: 0, max: 3 }, role: false, selfDependent: true, destructive: true, retryByTarget: false, preview: true },
    REMOVE_ALL_EXCEPT_SELF: { uid: null, role: false, selfDependent: true, destructive: true, retryByTarget: false, preview: true },
    REMOVE_SELF: { uid: null, role: false, selfDependent: true, destructive: true, retryByTarget: false, preview: true }
  });

  // Snapshot xem trước chỉ có giá trị trong khoảng này; quá hạn thì phải xem trước lại (docx kiến trúc §11.2).
  const SNAPSHOT_TTL_MS = 30 * 60 * 1000;
  const SNAPSHOT_FUTURE_SKEW_MS = 60 * 1000;

  // docx §16 + §34 + §60; ba mã cuối KHÔNG có trong docx (§35: trả lỗi tường minh thay vì đoán).
  const ERROR_CODES = [
    "SESSION_EXPIRED", "FACEBOOK_CHECKPOINT", "PAGE_LOAD_FAILED", "ACCOUNT_NOT_FOUND",
    "ACCOUNT_ACCESS_DENIED", "ROLE_SECTION_NOT_FOUND", "ADD_PEOPLE_NOT_AVAILABLE",
    "DESTINATION_NOT_FOUND", "ROLE_NOT_AVAILABLE", "INSUFFICIENT_PERMISSION",
    "SELF_REMOVE_NOT_AVAILABLE", "CONFIRM_NOT_AVAILABLE", "UI_TARGET_AMBIGUOUS",
    "UI_VARIANT_UNKNOWN", "FACEBOOK_ACTION_ERROR", "SHARE_VERIFY_FAILED",
    "REMOVE_VERIFY_FAILED", "TIMEOUT",
    "KEEP_UID_NOT_FOUND", "EXECUTOR_IDENTITY_MISMATCH", "NO_OTHER_ADMIN",
    "ROLE_CHANGE_NOT_AVAILABLE", "ROLE_CHANGE_VERIFY_FAILED",
    // ngoài docx:
    "SELF_NOT_IDENTIFIED", "TARGET_IS_SELF", "INVALID_INPUT",
    // Graph engine (docx "Định hướng kiến trúc AMIT Super Share" §12.1)
    "FACEBOOK_REAUTH_REQUIRED", "TOKEN_UNAVAILABLE", "TOKEN_OWNER_MISMATCH", "TARGET_NOT_ELIGIBLE", "TARGET_NOT_FOUND",
    "OWNER_PROTECTED", "RATE_LIMITED", "NETWORK_ERROR", "REQUEST_TIMEOUT", "FACEBOOK_GRAPH_ERROR", "GRAPH_RESPONSE_INVALID",
    "VERIFY_UNAVAILABLE", "VERIFY_MISMATCH", "ROLE_MISMATCH", "CANCELLED",
    // xem trước / snapshot cho thao tác xóa (docx kiến trúc §7.3, §11.2)
    "PREVIEW_REQUIRED", "SNAPSHOT_EXPIRED", "SNAPSHOT_CHANGED"
  ];
  const ERR = Object.freeze(Object.fromEntries(ERROR_CODES.map(c => [c, c])));

  // Lỗi làm PAUSE cả batch (docx §15; Graph engine thêm reauth / token / rate limit)
  const PAUSE_CODES = Object.freeze([
    ERR.SESSION_EXPIRED, ERR.FACEBOOK_CHECKPOINT, ERR.FACEBOOK_REAUTH_REQUIRED, ERR.TOKEN_UNAVAILABLE, ERR.RATE_LIMITED
  ]);

  // Chỉ dùng cho Graph engine: lỗi tạm thời hoặc target CHƯA XÁC MINH mới được Retry (docx §11, AC09).
  const RETRYABLE_CODES = Object.freeze([
    ERR.NETWORK_ERROR, ERR.REQUEST_TIMEOUT, ERR.RATE_LIMITED, ERR.FACEBOOK_GRAPH_ERROR, ERR.GRAPH_RESPONSE_INVALID,
    ERR.VERIFY_UNAVAILABLE, ERR.SHARE_VERIFY_FAILED, ERR.REMOVE_VERIFY_FAILED, ERR.ROLE_CHANGE_VERIFY_FAILED
  ]);

  const STATUS = Object.freeze({
    PENDING: "PENDING", RUNNING: "RUNNING", SUCCESS: "SUCCESS", FAILED: "FAILED", PAUSED: "PAUSED"
  });

  const BATCH_STATUS = Object.freeze({ RUNNING: "RUNNING", PAUSED: "PAUSED", FINISHED: "FINISHED" });

  // Delay giữa các TKQC (docx §49)
  const DELAY = Object.freeze({ MIN: 3, MAX: 10, DEFAULT: 3 });

  // ============================================================
  // LỖI
  // ============================================================
  class DriverError extends Error {
    constructor(code, message, step, detail) {
      super(message || code);
      this.name = "DriverError";
      this.code = code;
      this.step = step || null;
      this.detail = detail || null;
    }
  }

  const isPauseCode = code => PAUSE_CODES.includes(code);

  // Log (tùy chọn): runItem nhận opts.log(lvl, event, data) từ nơi gọi. Một TKQC chạy một lần tại một thời điểm nên dùng biến chung là an toàn.
  let LOG = () => {};
  const setStep = (result, step) => {
    result.step = step;
    LOG("debug", "core.step", { ad_account_id: result.ad_account_id, step });
  };

  // ============================================================
  // INPUT
  // ============================================================
  const uidStr = x => String(x === undefined || x === null ? "" : x).trim();

  function normalizeItem(raw) {
    const action = String(raw.action || "").toUpperCase();
    const def = ACTION_DEFS[action];
    const seen = new Set();
    const uids = (Array.isArray(raw.target_uids) ? raw.target_uids : [])
      .map(uidStr).filter(u => u && !seen.has(u) && seen.add(u));
    let role = null;
    if (def && def.role) role = raw.role ? String(raw.role).toUpperCase() : DEFAULT_ROLE;
    return {
      ad_account_id: uidStr(raw.ad_account_id).replace(/^act_/, ""),
      action,
      target_uids: def && def.uid ? uids : [],
      _rawUidCount: uids.length,
      role,
      executor_uid: uidStr(raw.executor_uid) || null,
      source: raw.source ? String(raw.source).toUpperCase() : null, // "UID" | "BM_PICKER" (chỉ Graph engine dùng để chọn contract)
      snapshot: def && def.preview ? normalizeSnapshot(raw.snapshot) : null
    };
  }

  /**
   * Snapshot đến từ Web nên KHÔNG được tin: chỉ làm sạch hình dạng. Snapshot chỉ được dùng để CHẶN (hết hạn, danh sách xóa
   * thực tế vượt quá danh sách đã xem trước), không bao giờ quyết định ai bị xóa; danh sách xóa luôn tính lại từ state thật.
   */
  function normalizeSnapshot(raw) {
    if (!raw || typeof raw !== "object") return null;
    const isUid = u => /^\d+$/.test(u);
    const uidList = a => (Array.isArray(a) ? a : []).slice(0, 2000).map(uidStr).filter(isUid);
    const users = (Array.isArray(raw.users) ? raw.users : []).slice(0, 2000).map(u => {
      const x = u && typeof u === "object" ? u : {};
      const role = String(x.role || "").toUpperCase();
      return { uid: uidStr(x.uid), role: ROLES[role] ? role : null, via: x.via ? String(x.via).slice(0, 24) : null, protected: !!x.protected };
    }).filter(u => isUid(u.uid));
    return {
      created_at: String(raw.created_at || "").slice(0, 40),
      executor_uid: raw.executor_uid ? uidStr(raw.executor_uid) : null,
      owner_id: raw.owner_id ? uidStr(raw.owner_id) : null,
      business_id: raw.business_id ? uidStr(raw.business_id) : null,
      users,
      keep_uids: uidList(raw.keep_uids),
      remove_uids: uidList(raw.remove_uids)
    };
  }

  /** Item có hành động xóa theo state mà chưa có snapshot xem trước. */
  const needsPreview = item => !!(ACTION_DEFS[item.action] && ACTION_DEFS[item.action].preview && !item.snapshot);

  /** Trả về null nếu hợp lệ, hoặc { error_code, message }. */
  function validateItem(item) {
    const bad = message => ({ error_code: ERR.INVALID_INPUT, message });
    if (!/^\d+$/.test(item.ad_account_id)) return bad("ad_account_id không hợp lệ.");
    const def = ACTION_DEFS[item.action];
    if (!def) return bad(`Action không hợp lệ: ${item.action || "(trống)"}`);
    if (def.uid === null) {
      if (item._rawUidCount > 0) return bad("Action này không nhận UID.");
    } else {
      if (!item.target_uids.every(u => /^\d+$/.test(u))) return bad("UID chỉ được gồm chữ số.");
      if (item.target_uids.length < def.uid.min) return bad(`Cần ít nhất ${def.uid.min} UID.`);
      if (item.target_uids.length > def.uid.max) return bad(`Tối đa ${def.uid.max} UID.`);
    }
    if (def.role && !ROLES[item.role]) return bad(`Role không hợp lệ: ${item.role}`);
    if (item.executor_uid !== null && !/^\d+$/.test(item.executor_uid)) return bad("executor_uid không hợp lệ.");
    return null;
  }

  function clampDelay(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DELAY.DEFAULT;
    return Math.min(DELAY.MAX, Math.max(DELAY.MIN, n));
  }

  // ============================================================
  // RESULT MODEL (docx §17, §30)
  // ============================================================
  function newItemResult(item) {
    return {
      ad_account_id: item.ad_account_id,
      action: item.action,
      status: STATUS.PENDING,
      target_uids: item.target_uids.slice(),
      role: item.role,
      executor_uid: item.executor_uid,
      source: item.source || null,
      snapshot: item.snapshot || null,
      engine: null,
      request_id: null,
      retryable: null,
      started_at: null,
      finished_at: null,
      step: null,
      error_code: null,
      error_message: null,
      failed_uid: null,
      note: null,
      detail: null, // chẩn đoán do driver đính kèm (vd danh sách control nhìn thấy) để chỉnh selector khi UI đổi
      targets: [] // [{ uid, status, note, error_code, error_message }]
    };
  }

  function setTarget(result, uid, status, note, code, message, extra) {
    let t = result.targets.find(x => x.uid === uid);
    if (!t) { t = { uid }; result.targets.push(t); }
    t.status = status;
    t.note = note || null;
    t.error_code = code || null;
    t.error_message = message || null;
    if (extra) Object.assign(t, extra); // request_id, method_used, verify_state, retryable (Graph engine)
    LOG(status === STATUS.FAILED ? "warn" : "info", "core.target", { ad_account_id: result.ad_account_id, uid, status, note: t.note, error_code: t.error_code, error_message: t.error_message, method_used: t.method_used, verify_state: t.verify_state, request_id: t.request_id });
    return t;
  }

  function finalizeResult(result, now) {
    result.finished_at = now();
    if (result.status === STATUS.PAUSED) return result;
    const failed = result.targets.filter(t => t.status === STATUS.FAILED);
    if (result.error_code || failed.length) {
      result.status = STATUS.FAILED;
      if (result.engine === "graph") {
        const codes = result.error_code ? [result.error_code] : failed.map(t => t.error_code);
        result.retryable = codes.some(c => RETRYABLE_CODES.includes(c));
      }
      if (!result.error_code) {
        result.error_code = failed[0].error_code;
        result.failed_uid = failed[0].uid;
      }
      if (!result.error_message) {
        result.error_message = failed.length
          ? `${failed.length}/${result.targets.length} target thất bại: ${failed[0].error_message || failed[0].error_code}`
          : result.error_code;
      }
    } else {
      result.status = STATUS.SUCCESS;
    }
    return result;
  }

  // ============================================================
  // TRỢ GIÚP ĐỌC STATE
  // ============================================================
  const findRole = (roles, uid) => roles.find(r => r.uid === uid) || null;
  const isGraph = driver => !!driver && driver.engine === "graph";
  const metaOf = (driver, uid) => (driver && typeof driver.targetMeta === "function" ? driver.targetMeta(uid) : null) || null;

  /** Đọc lại sau write. Graph engine: không đọc được -> VERIFY_UNAVAILABLE (UNVERIFIED), không coi là thành công. */
  async function verifyRead(driver, ctx) {
    try {
      return await readRolesChecked(driver, false);
    } catch (e) {
      if (!isGraph(driver) || (e instanceof DriverError && isPauseCode(e.code))) throw e;
      if (ctx) ctx.verify_state = "UNAVAILABLE";
      throw new DriverError(ERR.VERIFY_UNAVAILABLE,
        `Đã gửi yêu cầu nhưng không đọc lại được trạng thái để xác minh (${e && e.message ? e.message : e}).`, "VERIFY", { verify_state: "UNAVAILABLE" });
    }
  }

  async function readRolesChecked(driver, requireAllUids) {
    const roles = await driver.readRoles();
    if (requireAllUids && roles.some(r => !r.uid)) {
      throw new DriverError(ERR.UI_VARIANT_UNKNOWN,
        "Không đọc được UID của một số dòng trong danh sách vai trò nên không thể xác định đúng người cần giữ/xóa. Không thực hiện xóa.",
        "READ_STATE");
    }
    return roles;
  }

  // ============================================================
  // SHARE_USER (docx §6, §40, §59)
  // ============================================================
  async function shareOne(driver, item, uid, ctx) {
    ctx = ctx || {};
    const role = item.role;
    let roles = await readRolesChecked(driver, false);
    const cur = findRole(roles, uid);

    LOG("info", "core.share.decision", { uid, wanted_role: role, current: cur ? { role: cur.role, role_text: cur.roleText } : null, plan: !cur ? "ADD" : (cur.role === null ? "UNKNOWN_ROLE" : (cur.role === role ? "NO_ACTION" : "CHANGE_ROLE")) });
    if (cur) {
      if (cur.role === null) {
        throw new DriverError(ERR.UI_VARIANT_UNKNOWN, `Không đọc được role hiện tại của UID ${uid} nên không thể quyết định đổi role.`, "READ_STATE");
      }
      if (cur.role === role) { ctx.verify_state = "MATCH"; return "NO_ACTION_REQUIRED"; } // §40
      await driver.assertContext(item.ad_account_id);
      await driver.changeRole(uid, role);
      await driver.settle();
      roles = await verifyRead(driver, ctx);
      const after = findRole(roles, uid);
      if (!after || after.role !== role) {
        ctx.verify_state = !after ? "MISSING" : "MISMATCH";
        throw new DriverError(isGraph(driver) && after ? ERR.ROLE_MISMATCH : ERR.ROLE_CHANGE_VERIFY_FAILED,
          `Đã đổi role nhưng sau khi đọc lại role hiện tại là ${after ? after.role || after.roleText : "(không còn)"}.`, "VERIFY");
      }
      ctx.verify_state = "MATCH";
      return verifiedNote(driver, uid, "ROLE_CHANGED");
    }

    await driver.assertContext(item.ad_account_id);
    await driver.addPerson(uid, role);
    await driver.settle();
    roles = await verifyRead(driver, ctx);
    const added = findRole(roles, uid);
    if (!added || added.role !== role) {
      ctx.verify_state = !added ? "MISSING" : "MISMATCH";
      throw new DriverError(isGraph(driver) && added ? ERR.ROLE_MISMATCH : ERR.SHARE_VERIFY_FAILED,
        added ? `UID đã xuất hiện nhưng role là ${added.role || added.roleText}, khác role yêu cầu ${role}.` : "UID chưa xuất hiện trong danh sách vai trò sau khi thêm.",
        "VERIFY");
    }
    ctx.verify_state = "MATCH";
    return verifiedNote(driver, uid, "ADDED");
  }

  /** Phản hồi mutation mơ hồ nhưng đọc lại khớp -> ghi rõ (docx §11.1). */
  function verifiedNote(driver, uid, note) {
    const m = metaOf(driver, uid);
    return m && m.ambiguous ? "VERIFIED_AFTER_AMBIGUOUS_RESPONSE" : note;
  }

  // ============================================================
  // REMOVE (docx §7, §41)
  // ============================================================
  async function removeOne(driver, item, uid, ctx) {
    ctx = ctx || {};
    const roles = await readRolesChecked(driver, false);
    const cur = findRole(roles, uid);
    LOG("info", "core.remove.decision", { uid, present: !!cur, roles_now: roles.length });
    if (!cur) { ctx.verify_state = "MATCH"; return "NO_ACTION_REQUIRED"; }
    if (cur.protected) {
      throw new DriverError(ERR.OWNER_PROTECTED, `UID ${uid} là chủ sở hữu của TKQC nên không thể bị gỡ quyền.`, "PRE_VALIDATE");
    }
    await driver.assertContext(item.ad_account_id);
    await driver.removePerson(uid);
    await driver.settle();
    const after = await verifyRead(driver, ctx);
    if (findRole(after, uid)) {
      ctx.verify_state = "MISMATCH";
      throw new DriverError(ERR.REMOVE_VERIFY_FAILED, `UID ${uid} vẫn còn trong danh sách vai trò sau khi xóa.`, "VERIFY");
    }
    ctx.verify_state = "MATCH";
    return verifiedNote(driver, uid, "REMOVED");
  }

  const toTargetFailure = e => ({
    code: e instanceof DriverError ? e.code : ERR.FACEBOOK_ACTION_ERROR,
    message: e && e.message ? e.message : String(e)
  });

  /** Thông tin Graph engine đính vào từng UID (request_id, method_used, verify_state, retryable). Rỗng với DOM engine. */
  function graphExtras(driver, result, uid, ctx, failedCode) {
    if (!isGraph(driver)) return null;
    const m = metaOf(driver, uid) || {};
    const extra = { request_id: result.request_id ? `${result.request_id}:${uid}` : null, method_used: m.method_used || null, verify_state: ctx.verify_state || null };
    if (failedCode) extra.retryable = RETRYABLE_CODES.includes(failedCode);
    return extra;
  }

  /** Mỗi UID xử lý riêng; lỗi một UID không dừng UID còn lại, trừ lỗi PAUSE (docx §39, §41). */
  async function forEachTarget(result, uids, fn, driver) {
    for (const uid of uids) {
      const ctx = {};
      try {
        const note = await fn(uid, ctx);
        setTarget(result, uid, STATUS.SUCCESS, note, null, null, graphExtras(driver, result, uid, ctx, null));
      } catch (e) {
        if (e instanceof DriverError && isPauseCode(e.code)) throw e;
        let f = toTargetFailure(e);
        if (e instanceof DriverError && e.detail && e.detail.verify_state && !ctx.verify_state) ctx.verify_state = e.detail.verify_state;
        // Mutation bị timeout / lỗi mạng rồi verify cũng không khớp: báo lỗi GỐC (có thể retry), không phải "verify failed" chung chung.
        const m = metaOf(driver, uid);
        if (m && m.ambiguous_error && /VERIFY/.test(f.code)) {
          f = { code: m.ambiguous_error.code, message: `${m.ambiguous_error.message} (đã đọc lại: trạng thái chưa như yêu cầu)` };
        }
        setTarget(result, uid, STATUS.FAILED, null, f.code, f.message, graphExtras(driver, result, uid, ctx, f.code));
        if (e instanceof DriverError && e.detail && !result.detail) result.detail = e.detail;
      }
    }
  }

  async function runRemoveByUid(driver, item, result) {
    const self = item.executor_uid;
    setStep(result, "EXECUTE");
    const uids = [];
    for (const uid of item.target_uids) {
      if (uid === self) {
        // §24: không REMOVE SELF bằng action này
        setTarget(result, uid, STATUS.FAILED, null, ERR.TARGET_IS_SELF,
          "UID này là chính Via đang thực thi. Dùng action REMOVE_SELF để xóa chính mình.");
      } else {
        uids.push(uid);
      }
    }
    await forEachTarget(result, uids, (uid, ctx) => removeOne(driver, item, uid, ctx), driver);
  }

  // ============================================================
  // KẾ HOẠCH XÓA (dùng chung cho xem trước và thực thi: một nguồn sự thật)
  // ============================================================
  /** Ném DriverError nếu kế hoạch không thực hiện được (không có thao tác ghi nào ở đây). */
  function planRemoveAll(roles, item, validateKeep) {
    const self = item.executor_uid;
    if (!findRole(roles, self)) {
      throw new DriverError(ERR.SELF_NOT_IDENTIFIED,
        "Không thấy Via đang thực thi (SELF) trong danh sách vai trò của TKQC nên không thể xác định SELF. Không thực hiện xóa.", "READ_STATE");
    }

    const keep = item.target_uids;
    if (validateKeep) {
      // §25: validate 100% TRƯỚC khi xóa bất kỳ ai
      const missing = keep.filter(u => !findRole(roles, u));
      if (missing.length) {
        throw new DriverError(ERR.KEEP_UID_NOT_FOUND,
          `Keep UID không tồn tại: ${missing.join(", ")}. Không có user nào bị xóa.`, "PRE_VALIDATE", { failed_uids: missing });
      }
    }

    const keepSet = new Set([self, ...keep]);
    const existedKeep = [...keepSet].filter(u => findRole(roles, u));
    const protectedUids = roles.filter(r => r.protected).map(r => r.uid);
    const removeUids = roles.map(r => r.uid).filter(u => !keepSet.has(u) && !protectedUids.includes(u)); // owner không bao giờ bị xóa
    return { self, keep, keepSet, existedKeep, protectedUids, removeUids };
  }

  function planRemoveSelf(roles, item) {
    const self = item.executor_uid;
    const me = findRole(roles, self);
    if (!me) {
      throw new DriverError(ERR.SELF_NOT_IDENTIFIED,
        "Không thấy Via đang thực thi (SELF) trong danh sách vai trò của TKQC. Không thực hiện xóa.", "READ_STATE");
    }
    if (me.role === null) {
      throw new DriverError(ERR.UI_VARIANT_UNKNOWN, "Không đọc được role hiện tại của SELF nên không thể áp dụng rule Admin. Không thực hiện xóa.", "READ_STATE");
    }
    if (me.protected) {
      throw new DriverError(ERR.OWNER_PROTECTED, "Via đang thực thi là chủ sở hữu của TKQC nên không thể tự gỡ quyền.", "PRE_VALIDATE");
    }

    LOG("info", "core.removeself.check", { self_role: me.role, roles: roles.map(r => ({ uid: r.uid, role: r.role })) });
    let otherAdmins = null;
    if (me.role === ROLES.ADMIN) {
      const others = roles.filter(r => r.uid !== self);
      if (others.some(r => r.role === null)) {
        throw new DriverError(ERR.UI_VARIANT_UNKNOWN, "Không đọc được role của một số user khác nên không thể kiểm tra Admin khác. Không thực hiện xóa.", "READ_STATE");
      }
      otherAdmins = others.filter(r => r.role === ROLES.ADMIN).length;
      if (otherAdmins === 0) {
        throw new DriverError(ERR.NO_OTHER_ADMIN,
          "Không thể xóa chính mình vì tài khoản quảng cáo không còn Quản trị viên nào khác.", "PRE_VALIDATE");
      }
    }
    return { me, otherAdmins };
  }

  /**
   * Snapshot chặn thao tác xóa khi kế hoạch đã cũ hoặc state thật đã đổi so với lúc người dùng xem trước (docx kiến trúc §11.2).
   * Không có snapshot (DOM engine, hoặc item cũ) thì không kiểm tra. Danh sách xóa thật ít hơn danh sách đã xem trước là an toàn.
   */
  function checkSnapshot(item, removeUids, nowIso) {
    const s = item.snapshot;
    if (!s) return;
    const age = Date.parse(nowIso) - Date.parse(s.created_at);
    if (!Number.isFinite(age) || age > SNAPSHOT_TTL_MS || age < -SNAPSHOT_FUTURE_SKEW_MS) {
      throw new DriverError(ERR.SNAPSHOT_EXPIRED,
        `Kế hoạch xem trước đã hết hạn (quá ${Math.round(SNAPSHOT_TTL_MS / 60000)} phút) hoặc không hợp lệ. Không có user nào bị xóa. Hãy xem trước lại.`, "PRE_VALIDATE");
    }
    const extra = removeUids.filter(u => !s.remove_uids.includes(u));
    const wrongExecutor = s.executor_uid && item.executor_uid && s.executor_uid !== item.executor_uid;
    if (extra.length || wrongExecutor) {
      throw new DriverError(ERR.SNAPSHOT_CHANGED,
        wrongExecutor
          ? "Via thực thi khác với lúc xem trước. Không có user nào bị xóa. Hãy xem trước lại."
          : `Danh sách người dùng của TKQC đã thay đổi từ lúc xem trước (sẽ xóa thêm ${extra.length} UID chưa từng được xác nhận: ${extra.slice(0, 5).join(", ")}${extra.length > 5 ? "…" : ""}). Không có user nào bị xóa. Hãy xem trước lại.`,
        "PRE_VALIDATE", { extra_uids: extra });
    }
  }

  // REMOVE_ALL_EXCEPT_UIDS_AND_SELF (03) và REMOVE_ALL_EXCEPT_SELF (04) dùng chung (docx §9)
  async function runRemoveAllExcept(driver, item, result, validateKeep, now) {
    setStep(result, "READ_STATE");
    const roles = await readRolesChecked(driver, true);

    let plan;
    try {
      plan = planRemoveAll(roles, item, validateKeep);
    } catch (e) {
      if (e instanceof DriverError && e.code === ERR.KEEP_UID_NOT_FOUND) {
        const missing = (e.detail && e.detail.failed_uids) || [];
        missing.forEach(u => setTarget(result, u, STATUS.FAILED, null, ERR.KEEP_UID_NOT_FOUND, `Keep UID ${u} không tồn tại trong vai trò TKQC.`));
        result.failed_uid = missing[0];
      }
      throw e;
    }
    const { self, keep, existedKeep, protectedUids, removeUids } = plan;
    LOG("info", "core.removeall.plan", { self, keep, protected_owner: protectedUids, keep_validated: validateKeep, roles: roles.map(r => ({ uid: r.uid, role: r.role })), remove_set: removeUids });

    setStep(result, "EXECUTE");
    if (!removeUids.length) {
      result.note = "NO_ACTION_REQUIRED";
      return;
    }
    checkSnapshot(item, removeUids, now());
    // Mỗi lần xóa đều đọc lại state (removeOne), không dùng index cố định (docx §8, §33)
    await forEachTarget(result, removeUids, (uid, ctx) => removeOne(driver, item, uid, ctx), driver);

    // Final verification (docx §8)
    setStep(result, "VERIFY");
    const final = await readRolesChecked(driver, true);
    const lost = existedKeep.filter(u => !findRole(final, u));
    if (lost.length) {
      throw new DriverError(ERR.REMOVE_VERIFY_FAILED, `Sau khi xóa, các UID cần giữ không còn trong danh sách: ${lost.join(", ")}.`, "VERIFY", { lost });
    }
  }

  // ============================================================
  // REMOVE_SELF (docx §10, §27, §28)
  // ============================================================
  async function runRemoveSelf(driver, item, result, now) {
    const self = item.executor_uid;
    setStep(result, "READ_STATE");
    const roles = await readRolesChecked(driver, false);
    planRemoveSelf(roles, item);
    checkSnapshot(item, [self], now());

    setStep(result, "EXECUTE");
    await driver.assertContext(item.ad_account_id);
    await driver.removePerson(self); // ném SELF_REMOVE_NOT_AVAILABLE nếu UI không có control

    // Verification không phụ thuộc duy nhất vào reload (docx §28)
    setStep(result, "VERIFY");
    await driver.settle();
    const sig = await driver.probeSelfRemoval(item.ad_account_id, self);
    LOG("info", "core.removeself.signals", { signals: sig });
    const confirmed = sig && (sig.facebookConfirmed === true || sig.accountGone === true || sig.noAccess === true || sig.stillInList === false);
    if (!confirmed) {
      throw new DriverError(ERR.REMOVE_VERIFY_FAILED,
        sig && sig.stillInList === true
          ? "SELF vẫn còn trong danh sách vai trò sau khi xóa."
          : "Không có tín hiệu nào xác nhận SELF đã bị xóa (Facebook không xác nhận, TKQC vẫn truy cập được).",
        "VERIFY", { signals: sig || null });
    }
    setTarget(result, self, STATUS.SUCCESS, "REMOVED", null, null, graphExtras(driver, result, self, { verify_state: "MATCH" }, null));
    result.note = "SELF_REMOVED"; // AMIT phải sync lại dataset (docx §28)
  }

  // ============================================================
  // SESSION -> IDENTITY -> OPEN_ACCOUNT (dùng chung cho runItem và previewItem)
  // ============================================================
  async function openContext(driver, item, def, result) {
    setStep(result, "SESSION");
    const state = await driver.getSessionState();
    if (state === "EXPIRED") throw new DriverError(ERR.SESSION_EXPIRED, "Facebook yêu cầu đăng nhập lại.", "SESSION");
    if (state === "CHECKPOINT") throw new DriverError(ERR.FACEBOOK_CHECKPOINT, "Facebook yêu cầu xác minh bảo mật (checkpoint).", "SESSION");

    if (def.selfDependent || driver.requiresIdentity) {
      // §26: không đoán SELF. Graph engine: mọi write đều phải biết token thuộc ai (AC05)
      setStep(result, "IDENTITY");
      const current = await driver.getSessionUid();
      if (!item.executor_uid) {
        throw new DriverError(ERR.EXECUTOR_IDENTITY_MISMATCH, "Thiếu executor_uid nên không thể xác nhận SELF. Không thực hiện write action.", "IDENTITY");
      }
      if (!current) {
        throw new DriverError(ERR.EXECUTOR_IDENTITY_MISMATCH, "Không đọc được UID của session Facebook hiện tại. Không thực hiện write action.", "IDENTITY");
      }
      if (current !== item.executor_uid) {
        throw new DriverError(ERR.EXECUTOR_IDENTITY_MISMATCH,
          "Facebook đang đăng nhập trên browser không khớp executor AMIT dự kiến. Không thực hiện write action.", "IDENTITY");
      }
    }

    setStep(result, "OPEN_ACCOUNT");
    await driver.openAccount(item.ad_account_id);
  }

  // ============================================================
  // PREVIEW (chỉ ĐỌC; docx kiến trúc §7.3, §11.2)
  // ============================================================
  /**
   * Dựng kế hoạch xóa cho 1 TKQC mà không ghi gì. Luôn trả về object, không ném lỗi.
   *   status: OK (có kế hoạch) | BLOCKED (kế hoạch bị luật chặn, vd NO_OTHER_ADMIN; vẫn có snapshot) |
   *           ERROR (không đọc được state) | PAUSED (session / checkpoint / rate limit)
   */
  async function previewItem(driver, rawItem, opts) {
    opts = opts || {};
    LOG = typeof opts.log === "function" ? opts.log : () => {};
    const now = opts.now || (() => new Date().toISOString());
    const item = normalizeItem(rawItem);
    const out = {
      ad_account_id: item.ad_account_id, action: item.action, status: "OK", step: null,
      error_code: null, error_message: null,
      self_uid: item.executor_uid, owner_id: null, business_id: null,
      users: [], remove_uids: [], keep_uids: [], other_admins: null, snapshot: null
    };
    const stop = (status, code, message) => { out.status = status; out.error_code = code; out.error_message = message; return out; };

    const invalid = validateItem(item);
    if (invalid) return stop("ERROR", invalid.error_code, invalid.message);
    const def = ACTION_DEFS[item.action];
    if (!def.preview) return stop("ERROR", ERR.INVALID_INPUT, "Action này không cần xem trước.");

    try {
      await openContext(driver, item, def, out);
      setStep(out, "READ_STATE");
      const roles = await readRolesChecked(driver, true);
      const info = typeof driver.accountInfo === "function" ? driver.accountInfo() : null;
      out.owner_id = (info && info.owner_id) || (roles.find(r => r.protected) || {}).uid || null;
      out.business_id = (info && info.business_id) || null;

      try {
        if (item.action === ACTIONS.REMOVE_SELF) {
          out.other_admins = planRemoveSelf(roles, item).otherAdmins;
          out.remove_uids = [item.executor_uid];
        } else {
          out.remove_uids = planRemoveAll(roles, item, item.action === ACTIONS.REMOVE_ALL_EXCEPT_UIDS_AND_SELF).removeUids;
        }
      } catch (e) {
        if (!(e instanceof DriverError) || isPauseCode(e.code)) throw e;
        out.step = e.step || out.step;
        stop("BLOCKED", e.code, e.message);
        out.remove_uids = [];
      }

      const removing = new Set(out.remove_uids);
      out.keep_uids = roles.map(r => r.uid).filter(u => !removing.has(u));
      out.users = roles.map(r => ({
        uid: r.uid, name: r.name || "", role: r.role, via: r.via || null, protected: !!r.protected,
        mark: removing.has(r.uid) ? "REMOVE" : (r.uid === item.executor_uid ? "SELF" : (r.protected ? "OWNER" : "KEEP"))
      }));
      out.snapshot = {
        created_at: now(), executor_uid: item.executor_uid, owner_id: out.owner_id, business_id: out.business_id,
        users: out.users.map(u => ({ uid: u.uid, role: u.role, via: u.via, protected: u.protected })),
        keep_uids: out.keep_uids, remove_uids: out.remove_uids
      };
    } catch (e) {
      const code = e instanceof DriverError ? e.code : ERR.FACEBOOK_ACTION_ERROR;
      if (e instanceof DriverError && e.step) out.step = e.step;
      stop(isPauseCode(code) ? "PAUSED" : "ERROR", code, e && e.message ? e.message : String(e));
    }
    LOG(out.status === "ERROR" || out.status === "PAUSED" ? "warn" : "info", "core.preview", {
      ad_account_id: out.ad_account_id, action: out.action, status: out.status, error_code: out.error_code,
      users: out.users.length, remove: out.remove_uids.length, keep: out.keep_uids.length
    });
    return out;
  }

  // ============================================================
  // RUN ITEM
  // ============================================================
  /**
   * Chạy 1 TKQC (một "execution item"). Luôn trả về result; không ném lỗi.
   * result.status === "PAUSED" nghĩa là gặp SESSION_EXPIRED / FACEBOOK_CHECKPOINT và batch phải PAUSE.
   */
  async function runItem(driver, rawItem, opts) {
    opts = opts || {};
    LOG = typeof opts.log === "function" ? opts.log : () => {};
    const now = opts.now || (() => new Date().toISOString());
    const item = normalizeItem(rawItem);
    const result = newItemResult(item);
    result.status = STATUS.RUNNING;
    result.started_at = now();
    result.engine = driver && driver.engine ? driver.engine : "dom";
    result.request_id = opts.requestId || `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    LOG("info", "core.item.start", { ad_account_id: item.ad_account_id, action: item.action, target_uids: item.target_uids, role: item.role, executor_uid: item.executor_uid });

    const invalid = validateItem(item);
    if (invalid) {
      setStep(result, "VALIDATE");
      result.error_code = invalid.error_code;
      result.error_message = invalid.message;
      return finalizeResult(result, now);
    }
    const def = ACTION_DEFS[item.action];

    try {
      await openContext(driver, item, def, result);

      switch (item.action) {
        case ACTIONS.SHARE_USER: {
          setStep(result, "EXECUTE");
          const self = item.executor_uid;
          const uids = [];
          for (const uid of item.target_uids) {
            if (self && uid === self) {
              // docx không định nghĩa (§35): trả lỗi tường minh, không đoán
              setTarget(result, uid, STATUS.FAILED, null, ERR.TARGET_IS_SELF, "UID này là chính Via đang thực thi; requirement chưa định nghĩa việc share cho chính mình.");
            } else {
              uids.push(uid);
            }
          }
          await forEachTarget(result, uids, (uid, ctx) => shareOne(driver, item, uid, ctx), driver);
          break;
        }
        case ACTIONS.REMOVE_BY_UID_EXCEPT_SELF:
          await runRemoveByUid(driver, item, result);
          break;
        case ACTIONS.REMOVE_ALL_EXCEPT_UIDS_AND_SELF:
          await runRemoveAllExcept(driver, item, result, true, now);
          break;
        case ACTIONS.REMOVE_ALL_EXCEPT_SELF:
          await runRemoveAllExcept(driver, item, result, false, now);
          break;
        case ACTIONS.REMOVE_SELF:
          await runRemoveSelf(driver, item, result, now);
          break;
      }
    } catch (e) {
      const code = e instanceof DriverError ? e.code : ERR.FACEBOOK_ACTION_ERROR;
      if (isPauseCode(code)) {
        result.status = STATUS.PAUSED;
      }
      result.error_code = code;
      result.error_message = e && e.message ? e.message : String(e);
      if (e instanceof DriverError && e.step) result.step = e.step;
      if (e instanceof DriverError && e.detail) result.detail = e.detail;
      LOG(isPauseCode(code) ? "warn" : "error", "core.item.error", { ad_account_id: item.ad_account_id, step: result.step, error_code: code, error_message: result.error_message, detail: result.detail });
    }
    finalizeResult(result, now);
    LOG(result.status === STATUS.SUCCESS ? "info" : "warn", "core.item.end", { ad_account_id: item.ad_account_id, status: result.status, error_code: result.error_code, note: result.note, targets: result.targets.length, failed_targets: result.targets.filter(t => t.status === STATUS.FAILED).length });
    return result;
  }

  // ============================================================
  // BATCH (docx §12-§15, §29, §42, §55)
  // ============================================================
  /** request: { items:[{ad_account_id, action, target_uids, role, executor_uid}], delay_seconds } */
  function newBatch(request, id, nowIso) {
    const items = (request.items || []).map(normalizeItem);
    return {
      id,
      created_at: nowIso,
      status: BATCH_STATUS.RUNNING,
      pause_reason: null,
      delay_seconds: clampDelay(request.delay_seconds),
      total: items.length,
      processed: 0,
      success: 0,
      failed: 0,
      items: items.map(newItemResult)
    };
  }

  function recount(batch) {
    batch.total = batch.items.length;
    batch.success = batch.items.filter(i => i.status === STATUS.SUCCESS).length;
    batch.failed = batch.items.filter(i => i.status === STATUS.FAILED).length;
    batch.processed = batch.success + batch.failed;
    return batch;
  }

  const isResumable = item => item.status === STATUS.PENDING || item.status === STATUS.PAUSED || item.status === STATUS.RUNNING;

  /**
   * Retry chỉ phần FAILED, không chạy lại SUCCESS (docx §42, §55).
   * - SHARE_USER / REMOVE_BY_UID: chỉ các UID FAILED.
   * - Lỗi mức TKQC trước khi có target, hoặc action dạng "REMOVE_ALL_*"/"REMOVE_SELF": retry cả TKQC
   *   (các action này dựa trên state hiện tại nên chạy lại là idempotent: người đã xóa sẽ không còn trong remove-set).
   */
  function buildRetryItems(batch) {
    const out = [];
    for (const it of batch.items) {
      if (it.status !== STATUS.FAILED) continue;
      if (it.retryable === false) continue; // Graph engine: lỗi không tạm thời (quyền, target không hợp lệ...) -> Retry không giúp ích
      const def = ACTION_DEFS[it.action];
      // Graph engine: target retryable === false (vd INSUFFICIENT_PERMISSION) bị bỏ qua; DOM engine không có cờ này nên giữ hành vi cũ.
      const failedUids = it.targets.filter(t => t.status === STATUS.FAILED && it.target_uids.includes(t.uid) && t.retryable !== false).map(t => t.uid);
      if (it.targets.some(t => t.status === STATUS.FAILED) && !failedUids.length && def && def.retryByTarget) continue;
      const byTarget = def && def.retryByTarget && failedUids.length > 0;
      out.push({
        ad_account_id: it.ad_account_id,
        action: it.action,
        target_uids: byTarget ? failedUids : it.target_uids.slice(),
        role: it.role,
        executor_uid: it.executor_uid,
        source: it.source || null,
        snapshot: it.snapshot || null
      });
    }
    return out;
  }

  const api = {
    ACTIONS, ROLES, DEFAULT_ROLE, ACTION_DEFS, ERR, ERROR_CODES, PAUSE_CODES, RETRYABLE_CODES, STATUS, BATCH_STATUS, DELAY,
    DriverError, isPauseCode,
    normalizeItem, validateItem, clampDelay, needsPreview, SNAPSHOT_TTL_MS,
    newItemResult, newBatch, recount, isResumable, buildRetryItems,
    runItem, previewItem
  };

  root.AmitSuperShareCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
