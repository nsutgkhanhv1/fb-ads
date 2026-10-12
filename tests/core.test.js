const path = require("path");
const C = require(path.join((process.argv[2] || require("path").resolve(__dirname, "..")), "shared/super-share-core.js"));
const { DriverError, ERR } = C;
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  -> " + JSON.stringify(extra))); };

function fake(initial, o = {}) {
  const st = {
    roles: initial.map(r => ({ uid: r[0], name: "n" + r[0], role: r[1], roleText: r[1] })),
    sessionUid: o.sessionUid || "1", sessionState: o.sessionState || "OK",
    writes: [], account: null, removeBroken: new Set(o.removeBroken || []),
    notFound: new Set(o.notFound || []), noSelfRemove: !!o.noSelfRemove, selfGone: false
  };
  const d = {
    st,
    getSessionState: async () => st.sessionState,
    getSessionUid: async () => st.sessionUid,
    openAccount: async id => { if (o.noAccount) throw new DriverError(ERR.ACCOUNT_NOT_FOUND, "no", "OPEN_ACCOUNT"); st.account = id; },
    assertContext: async id => { if (st.account !== id) throw new DriverError(ERR.ACCOUNT_NOT_FOUND, "ctx"); },
    readRoles: async () => st.roles.map(r => ({ ...r })),
    addPerson: async (uid, role) => {
      if (st.notFound.has(uid)) throw new DriverError(ERR.DESTINATION_NOT_FOUND, "nf");
      st.writes.push(["add", uid, role]);
      if (!o.addNoop) st.roles.push({ uid, name: "n" + uid, role: o.addWrongRole || role, roleText: role });
    },
    changeRole: async (uid, role) => { st.writes.push(["change", uid, role]); st.roles.find(r => r.uid === uid).role = role; },
    removePerson: async uid => {
      if (uid === st.sessionUid && st.noSelfRemove) throw new DriverError(ERR.SELF_REMOVE_NOT_AVAILABLE, "x");
      if (st.removeBroken.has(uid)) throw new DriverError(ERR.INSUFFICIENT_PERMISSION, "fb refuses");
      st.writes.push(["remove", uid]);
      if (o.removeNoop) return;
      st.roles = st.roles.filter(r => r.uid !== uid);
      if (uid === st.sessionUid) st.selfGone = true;
    },
    settle: async () => {},
    probeSelfRemoval: async () => o.probe || { facebookConfirmed: null, accountGone: null, noAccess: null, stillInList: st.selfGone ? false : true }
  };
  return d;
}
const item = (action, extra = {}) => ({ ad_account_id: "111", action, executor_uid: "1", ...extra });
const writes = d => d.st.writes.length;

(async () => {
  // 1. SHARE_USER
  let d = fake([["1", "ADMIN"], ["2", "ADMIN"], ["3", "ADVERTISER"]], { notFound: ["9"] });
  let r = await C.runItem(d, item("SHARE_USER", { target_uids: ["2", "3", "9"], role: "ADMIN" }));
  ok("share: UID đã đúng role -> SUCCESS/NO_ACTION_REQUIRED", r.targets[0].status === "SUCCESS" && r.targets[0].note === "NO_ACTION_REQUIRED", r.targets[0]);
  ok("share: UID role khác -> ROLE_CHANGED + verify", r.targets[1].status === "SUCCESS" && r.targets[1].note === "ROLE_CHANGED", r.targets[1]);
  ok("share: UID không tìm thấy -> FAILED DESTINATION_NOT_FOUND, vẫn chạy hết", r.targets[2].error_code === "DESTINATION_NOT_FOUND", r.targets[2]);
  ok("share: account FAILED vì 1/3 lỗi, failed_uid=9", r.status === "FAILED" && r.failed_uid === "9", r);

  d = fake([["1", "ADMIN"]]);
  r = await C.runItem(d, item("SHARE_USER", { target_uids: ["5"] }));
  ok("share: role mặc định ADMIN, thêm mới", r.status === "SUCCESS" && r.role === "ADMIN" && d.st.writes[0][2] === "ADMIN", r);

  d = fake([["1", "ADMIN"]], { addWrongRole: "ANALYST" });
  r = await C.runItem(d, item("SHARE_USER", { target_uids: ["5"], role: "ADVERTISER" }));
  ok("share: role sai sau khi thêm -> SHARE_VERIFY_FAILED", r.targets[0].error_code === "SHARE_VERIFY_FAILED", r.targets[0]);
  d = fake([["1", "ADMIN"]], { addNoop: true });
  r = await C.runItem(d, item("SHARE_USER", { target_uids: ["5"] }));
  ok("share: click xong nhưng UID không xuất hiện -> SHARE_VERIFY_FAILED", r.targets[0].error_code === "SHARE_VERIFY_FAILED", r.targets[0]);

  d = fake([["1", "ADMIN"]]);
  r = await C.runItem(d, item("SHARE_USER", { target_uids: ["1"] }));
  ok("share: target là SELF -> TARGET_IS_SELF, không write", r.targets[0].error_code === "TARGET_IS_SELF" && writes(d) === 0, r);

  // 2. KEEP
  d = fake([["1", "ADMIN"], ["2", "ADMIN"], ["3", "ADVERTISER"], ["4", "ANALYST"]]);
  r = await C.runItem(d, item("REMOVE_ALL_EXCEPT_UIDS_AND_SELF", { target_uids: ["2", "999"] }));
  ok("keep: UID giữ thiếu -> KEEP_UID_NOT_FOUND, 0 write", r.error_code === "KEEP_UID_NOT_FOUND" && r.failed_uid === "999" && writes(d) === 0, { r, w: d.st.writes });

  d = fake([["1", "ADMIN"], ["2", "ADMIN"], ["3", "ADVERTISER"], ["4", "ANALYST"]]);
  r = await C.runItem(d, item("REMOVE_ALL_EXCEPT_UIDS_AND_SELF", { target_uids: ["2"] }));
  ok("keep: xóa đúng 3,4; giữ SELF và 2", r.status === "SUCCESS" && d.st.roles.map(x => x.uid).join() === "1,2", { r, roles: d.st.roles });

  // 3. REMOVE_ALL_EXCEPT_SELF với 1 lỗi
  d = fake([["1", "ADMIN"], ["2", "ADMIN"], ["3", "ADVERTISER"], ["4", "ANALYST"]], { removeBroken: ["3"] });
  r = await C.runItem(d, item("REMOVE_ALL_EXCEPT_SELF"));
  ok("removeall: 1 target lỗi không dừng các target còn lại", d.st.roles.map(x => x.uid).join() === "1,3", d.st.roles);
  ok("removeall: account FAILED, failed_uid=3, INSUFFICIENT_PERMISSION", r.status === "FAILED" && r.failed_uid === "3" && r.error_code === "INSUFFICIENT_PERMISSION", r);
  const retry = C.buildRetryItems({ items: [r] });
  ok("retry: REMOVE_ALL_* retry cả TKQC", retry.length === 1 && retry[0].action === "REMOVE_ALL_EXCEPT_SELF", retry);

  // 4. REMOVE_BY_UID
  d = fake([["1", "ADMIN"], ["2", "ADMIN"], ["3", "ADVERTISER"]]);
  r = await C.runItem(d, item("REMOVE_BY_UID_EXCEPT_SELF", { target_uids: ["1", "3", "77"] }));
  ok("removeby: self bị từ chối TARGET_IS_SELF", r.targets.find(t => t.uid === "1").error_code === "TARGET_IS_SELF", r.targets);
  ok("removeby: UID không còn quyền -> SUCCESS/NO_ACTION_REQUIRED", r.targets.find(t => t.uid === "77").note === "NO_ACTION_REQUIRED", r.targets);
  ok("removeby: SELF vẫn còn, 3 đã xóa", d.st.roles.map(x => x.uid).join() === "1,2", d.st.roles);
  d = fake([["1", "ADMIN"], ["3", "ADVERTISER"]], { removeNoop: true });
  r = await C.runItem(d, item("REMOVE_BY_UID_EXCEPT_SELF", { target_uids: ["3"] }));
  ok("removeby: click xong nhưng vẫn còn -> REMOVE_VERIFY_FAILED", r.targets[0].error_code === "REMOVE_VERIFY_FAILED", r.targets[0]);
  const retry2 = C.buildRetryItems({ items: [r] });
  ok("retry: REMOVE_BY_UID chỉ retry UID lỗi", retry2[0].target_uids.join() === "3", retry2);

  // 5. REMOVE_SELF
  d = fake([["1", "ADMIN"], ["2", "ADVERTISER"]]);
  r = await C.runItem(d, item("REMOVE_SELF"));
  ok("removeself: SELF admin cuối -> NO_OTHER_ADMIN, 0 write", r.error_code === "NO_OTHER_ADMIN" && writes(d) === 0, r);
  d = fake([["1", "ADMIN"], ["2", "ADMIN"]]);
  r = await C.runItem(d, item("REMOVE_SELF"));
  ok("removeself: có admin khác -> SUCCESS", r.status === "SUCCESS" && r.note === "SELF_REMOVED", r);
  d = fake([["1", "ADMIN"], ["2", "ADMIN"]], { removeNoop: true, probe: { stillInList: true } });
  r = await C.runItem(d, item("REMOVE_SELF"));
  ok("removeself: SELF vẫn còn -> REMOVE_VERIFY_FAILED", r.error_code === "REMOVE_VERIFY_FAILED", r);
  d = fake([["1", "ADMIN"], ["2", "ADMIN"]], { removeNoop: true, probe: { noAccess: true } });
  r = await C.runItem(d, item("REMOVE_SELF"));
  ok("removeself: mất quyền truy cập TKQC (signal) -> SUCCESS", r.status === "SUCCESS", r);
  d = fake([["1", "ADVERTISER"], ["2", "ADMIN"]], { noSelfRemove: true });
  r = await C.runItem(d, item("REMOVE_SELF"));
  ok("removeself: SELF không phải admin, UI không cho -> SELF_REMOVE_NOT_AVAILABLE", r.error_code === "SELF_REMOVE_NOT_AVAILABLE", r);
  d = fake([["1", "ADMIN"], ["2", "ADMIN"]], { removeNoop: true, probe: {} });
  r = await C.runItem(d, item("REMOVE_SELF"));
  ok("removeself: không có tín hiệu nào -> REMOVE_VERIFY_FAILED", r.error_code === "REMOVE_VERIFY_FAILED", r);

  // 6. Identity
  d = fake([["1", "ADMIN"], ["2", "ADMIN"]], { sessionUid: "999" });
  r = await C.runItem(d, item("REMOVE_ALL_EXCEPT_SELF"));
  ok("identity: session khác executor -> EXECUTOR_IDENTITY_MISMATCH, 0 write", r.error_code === "EXECUTOR_IDENTITY_MISMATCH" && writes(d) === 0, r);
  d = fake([["1", "ADMIN"], ["2", "ADMIN"]]);
  r = await C.runItem(d, item("REMOVE_ALL_EXCEPT_SELF", { executor_uid: null }));
  ok("identity: thiếu executor_uid ở action phụ thuộc SELF -> chặn", r.error_code === "EXECUTOR_IDENTITY_MISMATCH" && writes(d) === 0, r);
  d = fake([["1", "ADMIN"]]);
  r = await C.runItem(d, item("SHARE_USER", { target_uids: ["5"], executor_uid: null }));
  ok("identity: SHARE_USER chạy được không cần executor_uid", r.status === "SUCCESS", r);

  // 7. Session / checkpoint
  d = fake([["1", "ADMIN"]], { sessionState: "EXPIRED" });
  r = await C.runItem(d, item("SHARE_USER", { target_uids: ["5"] }));
  ok("session: hết hạn -> PAUSED SESSION_EXPIRED", r.status === "PAUSED" && r.error_code === "SESSION_EXPIRED", r);
  d = fake([["1", "ADMIN"]], { sessionState: "CHECKPOINT" });
  r = await C.runItem(d, item("SHARE_USER", { target_uids: ["5"] }));
  ok("session: checkpoint -> PAUSED FACEBOOK_CHECKPOINT", r.status === "PAUSED" && r.error_code === "FACEBOOK_CHECKPOINT", r);

  // 8. Pause giữa chừng khi đang xử lý UID thứ 2 của SHARE
  d = fake([["1", "ADMIN"]]);
  let calls = 0;
  const origRead = d.readRoles;
  d.readRoles = async () => { calls++; if (calls > 3) throw new DriverError(ERR.SESSION_EXPIRED, "login"); return origRead(); };
  r = await C.runItem(d, item("SHARE_USER", { target_uids: ["5", "6"] }));
  ok("pause: hết session giữa chừng -> PAUSED, không biến thành FAILED target", r.status === "PAUSED", r);

  // 9. Dòng không đọc được UID / SELF thiếu
  d = fake([["1", "ADMIN"], ["2", "ADMIN"]]);
  d.readRoles = async () => [{ uid: "1", role: "ADMIN" }, { uid: null, name: "x", role: "ADMIN" }];
  r = await C.runItem(d, item("REMOVE_ALL_EXCEPT_SELF"));
  ok("removeall: dòng không đọc được UID -> UI_VARIANT_UNKNOWN, 0 write", r.error_code === "UI_VARIANT_UNKNOWN" && writes(d) === 0, r);
  d = fake([["1", "ADMIN"], ["2", "ADMIN"]], { sessionUid: "5" });
  r = await C.runItem(d, item("REMOVE_ALL_EXCEPT_SELF", { executor_uid: "5" }));
  ok("removeall: SELF không có trong danh sách -> SELF_NOT_IDENTIFIED, 0 write", r.error_code === "SELF_NOT_IDENTIFIED" && writes(d) === 0, r);

  // 10. Validate input
  r = await C.runItem(fake([["1", "ADMIN"]]), item("SHARE_USER", { target_uids: ["1", "2", "3", "4"] }));
  ok("validate: >3 UID -> INVALID_INPUT", r.error_code === "INVALID_INPUT", r);
  r = await C.runItem(fake([["1", "ADMIN"]]), item("REMOVE_SELF", { target_uids: ["2"] }));
  ok("validate: REMOVE_SELF không nhận UID", r.error_code === "INVALID_INPUT", r);
  r = await C.runItem(fake([["1", "ADMIN"]]), item("SHARE_USER", { target_uids: ["2"], role: "BOSS" }));
  ok("validate: role lạ -> INVALID_INPUT", r.error_code === "INVALID_INPUT", r);
  r = await C.runItem(fake([["1", "ADMIN"]]), item("KEEP_ALL"));
  ok("validate: action lạ -> INVALID_INPUT", r.error_code === "INVALID_INPUT", r);
  d = fake([["1", "ADMIN"], ["2", "ADMIN"]]);
  r = await C.runItem(d, item("REMOVE_ALL_EXCEPT_UIDS_AND_SELF", { target_uids: [] }));
  ok("validate: keep-list rỗng hợp lệ (0-3 UID)", r.error_code !== "INVALID_INPUT", r);

  // 11. Không mở được TKQC
  d = fake([["1", "ADMIN"]], { noAccount: true });
  r = await C.runItem(d, item("SHARE_USER", { target_uids: ["5"] }));
  ok("account: không chọn được TKQC -> ACCOUNT_NOT_FOUND, 0 write", r.error_code === "ACCOUNT_NOT_FOUND" && writes(d) === 0, r);

  // 12. Batch helpers
  const batch = C.newBatch({ delay_seconds: 1, items: [item("SHARE_USER", { target_uids: ["5"] }), item("REMOVE_SELF")] }, "b1", "now");
  ok("batch: delay kẹp 3-10, mặc định 3", batch.delay_seconds === 3 && C.clampDelay(99) === 10 && C.clampDelay("x") === 3 && C.clampDelay(7) === 7);
  ok("batch: total=2, tất cả resumable", C.recount(batch).total === 2 && batch.items.every(C.isResumable));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
