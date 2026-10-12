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
    REMOVE_ALL_EXCEPT_UIDS_AND_SELF: { uid: { min: 0, max: 3 }, role: false, selfDependent: true, destructive: true, retryByTarget: false },
    REMOVE_ALL_EXCEPT_SELF: { uid: null, role: false, selfDependent: true, destructive: true, retryByTarget: false },
    REMOVE_SELF: { uid: null, role: false, selfDependent: true, destructive: true, retryByTarget: false }
  });

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
    "SELF_NOT_IDENTIFIED", "TARGET_IS_SELF", "INVALID_INPUT"
  ];
  const ERR = Object.freeze(Object.fromEntries(ERROR_CODES.map(c => [c, c])));

  // Lỗi làm PAUSE cả batch (docx §15)
  const PAUSE_CODES = Object.freeze([ERR.SESSION_EXPIRED, ERR.FACEBOOK_CHECKPOINT]);

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
      executor_uid: uidStr(raw.executor_uid) || null
    };
  }

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

  function setTarget(result, uid, status, note, code, message) {
    let t = result.targets.find(x => x.uid === uid);
    if (!t) { t = { uid }; result.targets.push(t); }
    t.status = status;
    t.note = note || null;
    t.error_code = code || null;
    t.error_message = message || null;
    LOG(status === STATUS.FAILED ? "warn" : "info", "core.target", { ad_account_id: result.ad_account_id, uid, status, note: t.note, error_code: t.error_code, error_message: t.error_message });
    return t;
  }

  function finalizeResult(result, now) {
    result.finished_at = now();
    if (result.status === STATUS.PAUSED) return result;
    const failed = result.targets.filter(t => t.status === STATUS.FAILED);
    if (result.error_code || failed.length) {
      result.status = STATUS.FAILED;
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
  async function shareOne(driver, item, uid) {
    const role = item.role;
    let roles = await readRolesChecked(driver, false);
    const cur = findRole(roles, uid);

    LOG("info", "core.share.decision", { uid, wanted_role: role, current: cur ? { role: cur.role, role_text: cur.roleText } : null, plan: !cur ? "ADD" : (cur.role === null ? "UNKNOWN_ROLE" : (cur.role === role ? "NO_ACTION" : "CHANGE_ROLE")) });
    if (cur) {
      if (cur.role === null) {
        throw new DriverError(ERR.UI_VARIANT_UNKNOWN, `Không đọc được role hiện tại của UID ${uid} nên không thể quyết định đổi role.`, "READ_STATE");
      }
      if (cur.role === role) return "NO_ACTION_REQUIRED"; // §40
      await driver.assertContext(item.ad_account_id);
      await driver.changeRole(uid, role);
      await driver.settle();
      roles = await readRolesChecked(driver, false);
      const after = findRole(roles, uid);
      if (!after || after.role !== role) {
        throw new DriverError(ERR.ROLE_CHANGE_VERIFY_FAILED,
          `Đã đổi role nhưng sau khi đọc lại role hiện tại là ${after ? after.role || after.roleText : "(không còn)"}.`, "VERIFY");
      }
      return "ROLE_CHANGED";
    }

    await driver.assertContext(item.ad_account_id);
    await driver.addPerson(uid, role);
    await driver.settle();
    roles = await readRolesChecked(driver, false);
    const added = findRole(roles, uid);
    if (!added || added.role !== role) {
      throw new DriverError(ERR.SHARE_VERIFY_FAILED,
        added ? `UID đã xuất hiện nhưng role là ${added.role || added.roleText}, khác role yêu cầu ${role}.` : "UID chưa xuất hiện trong danh sách vai trò sau khi thêm.",
        "VERIFY");
    }
    return "ADDED";
  }

  // ============================================================
  // REMOVE (docx §7, §41)
  // ============================================================
  async function removeOne(driver, item, uid) {
    const roles = await readRolesChecked(driver, false);
    LOG("info", "core.remove.decision", { uid, present: !!findRole(roles, uid), roles_now: roles.length });
    if (!findRole(roles, uid)) return "NO_ACTION_REQUIRED";
    await driver.assertContext(item.ad_account_id);
    await driver.removePerson(uid);
    await driver.settle();
    const after = await readRolesChecked(driver, false);
    if (findRole(after, uid)) {
      throw new DriverError(ERR.REMOVE_VERIFY_FAILED, `UID ${uid} vẫn còn trong danh sách vai trò sau khi xóa.`, "VERIFY");
    }
    return "REMOVED";
  }

  const toTargetFailure = e => ({
    code: e instanceof DriverError ? e.code : ERR.FACEBOOK_ACTION_ERROR,
    message: e && e.message ? e.message : String(e)
  });

  /** Mỗi UID xử lý riêng; lỗi một UID không dừng UID còn lại, trừ lỗi PAUSE (docx §39, §41). */
  async function forEachTarget(result, uids, fn) {
    for (const uid of uids) {
      try {
        const note = await fn(uid);
        setTarget(result, uid, STATUS.SUCCESS, note);
      } catch (e) {
        if (e instanceof DriverError && isPauseCode(e.code)) throw e;
        const f = toTargetFailure(e);
        setTarget(result, uid, STATUS.FAILED, null, f.code, f.message);
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
    await forEachTarget(result, uids, uid => removeOne(driver, item, uid));
  }

  // REMOVE_ALL_EXCEPT_UIDS_AND_SELF (03) và REMOVE_ALL_EXCEPT_SELF (04) dùng chung (docx §9)
  async function runRemoveAllExcept(driver, item, result, validateKeep) {
    const self = item.executor_uid;
    setStep(result, "READ_STATE");
    const roles = await readRolesChecked(driver, true);

    if (!findRole(roles, self)) {
      throw new DriverError(ERR.SELF_NOT_IDENTIFIED,
        "Không thấy Via đang thực thi (SELF) trong danh sách vai trò của TKQC nên không thể xác định SELF. Không thực hiện xóa.", "READ_STATE");
    }

    const keep = item.target_uids;
    if (validateKeep) {
      // §25: validate 100% TRƯỚC khi xóa bất kỳ ai
      const missing = keep.filter(u => !findRole(roles, u));
      if (missing.length) {
        missing.forEach(u => setTarget(result, u, STATUS.FAILED, null, ERR.KEEP_UID_NOT_FOUND, `Keep UID ${u} không tồn tại trong vai trò TKQC.`));
        result.failed_uid = missing[0];
        throw new DriverError(ERR.KEEP_UID_NOT_FOUND,
          `Keep UID không tồn tại: ${missing.join(", ")}. Không có user nào bị xóa.`, "PRE_VALIDATE", { failed_uids: missing });
      }
    }

    const keepSet = new Set([self, ...keep]);
    const existedKeep = [...keepSet].filter(u => findRole(roles, u));
    const removeUids = roles.map(r => r.uid).filter(u => !keepSet.has(u));
    LOG("info", "core.removeall.plan", { self, keep, keep_validated: validateKeep, roles: roles.map(r => ({ uid: r.uid, role: r.role })), remove_set: removeUids });

    setStep(result, "EXECUTE");
    if (!removeUids.length) {
      result.note = "NO_ACTION_REQUIRED";
      return;
    }
    // Mỗi lần xóa đều đọc lại state (removeOne), không dùng index cố định (docx §8, §33)
    await forEachTarget(result, removeUids, uid => removeOne(driver, item, uid));

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
  async function runRemoveSelf(driver, item, result) {
    const self = item.executor_uid;
    setStep(result, "READ_STATE");
    const roles = await readRolesChecked(driver, false);
    const me = findRole(roles, self);
    if (!me) {
      throw new DriverError(ERR.SELF_NOT_IDENTIFIED,
        "Không thấy Via đang thực thi (SELF) trong danh sách vai trò của TKQC. Không thực hiện xóa.", "READ_STATE");
    }
    if (me.role === null) {
      throw new DriverError(ERR.UI_VARIANT_UNKNOWN, "Không đọc được role hiện tại của SELF nên không thể áp dụng rule Admin. Không thực hiện xóa.", "READ_STATE");
    }

    LOG("info", "core.removeself.check", { self_role: me.role, roles: roles.map(r => ({ uid: r.uid, role: r.role })) });
    if (me.role === ROLES.ADMIN) {
      const others = roles.filter(r => r.uid !== self);
      if (others.some(r => r.role === null)) {
        throw new DriverError(ERR.UI_VARIANT_UNKNOWN, "Không đọc được role của một số user khác nên không thể kiểm tra Admin khác. Không thực hiện xóa.", "READ_STATE");
      }
      const otherAdmins = others.filter(r => r.role === ROLES.ADMIN).length;
      if (otherAdmins === 0) {
        throw new DriverError(ERR.NO_OTHER_ADMIN,
          "Không thể xóa chính mình vì tài khoản quảng cáo không còn Quản trị viên nào khác.", "PRE_VALIDATE");
      }
    }

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
    setTarget(result, self, STATUS.SUCCESS, "REMOVED");
    result.note = "SELF_REMOVED"; // AMIT phải sync lại dataset (docx §28)
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
      setStep(result, "SESSION");
      const state = await driver.getSessionState();
      if (state === "EXPIRED") throw new DriverError(ERR.SESSION_EXPIRED, "Facebook yêu cầu đăng nhập lại.", "SESSION");
      if (state === "CHECKPOINT") throw new DriverError(ERR.FACEBOOK_CHECKPOINT, "Facebook yêu cầu xác minh bảo mật (checkpoint).", "SESSION");

      if (def.selfDependent) {
        // §26: không đoán SELF
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
          await forEachTarget(result, uids, uid => shareOne(driver, item, uid));
          break;
        }
        case ACTIONS.REMOVE_BY_UID_EXCEPT_SELF:
          await runRemoveByUid(driver, item, result);
          break;
        case ACTIONS.REMOVE_ALL_EXCEPT_UIDS_AND_SELF:
          await runRemoveAllExcept(driver, item, result, true);
          break;
        case ACTIONS.REMOVE_ALL_EXCEPT_SELF:
          await runRemoveAllExcept(driver, item, result, false);
          break;
        case ACTIONS.REMOVE_SELF:
          await runRemoveSelf(driver, item, result);
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
      const def = ACTION_DEFS[it.action];
      const failedUids = it.targets.filter(t => t.status === STATUS.FAILED && it.target_uids.includes(t.uid)).map(t => t.uid);
      const byTarget = def && def.retryByTarget && failedUids.length > 0;
      out.push({
        ad_account_id: it.ad_account_id,
        action: it.action,
        target_uids: byTarget ? failedUids : it.target_uids.slice(),
        role: it.role,
        executor_uid: it.executor_uid
      });
    }
    return out;
  }

  const api = {
    ACTIONS, ROLES, DEFAULT_ROLE, ACTION_DEFS, ERR, ERROR_CODES, PAUSE_CODES, STATUS, BATCH_STATUS, DELAY,
    DriverError, isPauseCode,
    normalizeItem, validateItem, clampDelay,
    newItemResult, newBatch, recount, isResumable, buildRetryItems,
    runItem
  };

  root.AmitSuperShareCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
