/**
 * SPIKE 3 — Kiểm chứng contract GHI của Graph engine trên TKQC THỬ NGHIỆM (có POST / DELETE thật!)
 *
 * Trả lời những điều đặc tả chưa có bằng chứng từ SMIT (xem shared/facebook/permission-contracts.js):
 *   1. POST /act_{id}/users (cấp + đổi role) có trả success:true và đọc lại khớp không?
 *   2. POST /act_{id}/assigned_users (tasks) có hoạt động với target là người dùng BM không?
 *   3. Gỡ direct: POST /act_{id}/users/{uid} method=DELETE có hoạt động không? Nếu không, userpermissions (cần business)?
 *   4. Mẫu thông báo lỗi "target không đủ điều kiện" thực tế là gì (để chỉnh error-classifier.js)?
 *   5. Mã lỗi rate limit / đọc-lại-bị-từ-chối thực tế khi tự gỡ chính mình (xem Spike 2 / REMOVE_SELF).
 *
 * CÁCH CHẠY: chrome://extensions -> AMIT V1 -> "service worker" (Inspect) -> Console -> dán toàn bộ file này.
 * TRƯỚC KHI CHẠY: sửa 3 hằng số bên dưới. KHÔNG dùng TKQC thật của khách. UID mục tiêu phải là tài khoản thử nghiệm
 * của bạn (đủ điều kiện được share). Token KHÔNG bị in ra; UID/ID được che bớt. Kết quả copy vào clipboard (nếu được).
 */
(async () => {
  const ACT_ID = "";          // ID TKQC thử nghiệm (chỉ số, không có act_)
  const TARGET_UID = "";      // UID thử nghiệm sẽ được cấp rồi gỡ
  const I_UNDERSTAND_THIS_WRITES_TO_FACEBOOK = false; // đổi thành true để chạy thật

  if (!I_UNDERSTAND_THIS_WRITES_TO_FACEBOOK) return console.warn("Đặt I_UNDERSTAND_THIS_WRITES_TO_FACEBOOK = true sau khi kiểm tra ACT_ID / TARGET_UID.");
  if (!/^\d+$/.test(ACT_ID) || !/^\d+$/.test(TARGET_UID)) return console.error("ACT_ID và TARGET_UID chỉ gồm chữ số.");
  if (typeof AmitPermissionRuntime === "undefined") return console.error("Chạy trong console của service worker AMIT.");

  const mask = id => (String(id).length > 6 ? `${String(id).slice(0, 3)}…${String(id).slice(-3)}` : String(id));
  const C = AmitPermissionContracts;
  const { graph, tokens } = AmitPermissionRuntime.get();
  const report = { act: mask(ACT_ID), target: mask(TARGET_UID), steps: [] };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const owner = await tokens.get("powerEditorAction");
  report.executor = mask(owner.user_id);
  report.token = { slot: owner.slot, via_type: owner.via_type };

  const run = async (name, spec) => {
    const step = { name, contract: spec.contract, method: spec.method, path: spec.path.replace(ACT_ID, mask(ACT_ID)).replace(TARGET_UID, mask(TARGET_UID)) };
    try {
      const res = await graph.request(spec.path, { method: spec.method, params: spec.params, expectedUid: owner.user_id, mutation: !!spec.mutation });
      step.ok = true;
      step.success_field = res && res.success;
      step.response_keys = res ? Object.keys(res).slice(0, 8) : [];
    } catch (e) {
      step.ok = false;
      step.error_code = e.error_code; step.category = e.category; step.fallback_allowed = !!e.fallback_allowed;
      step.http_status = e.http_status; step.graph_code = e.graph_code; step.graph_subcode = e.graph_subcode;
      step.message = String(e.message).replace(/\d{6,}/g, m => mask(m)).slice(0, 200); // để chỉnh mẫu trong error-classifier.js
    }
    report.steps.push(step);
    return step;
  };
  const roleNow = async () => {
    const res = await graph.request(C.contracts.listUsers(ACT_ID).path, { method: "GET", params: C.contracts.listUsers(ACT_ID).params, expectedUid: owner.user_id });
    const row = (res.data || []).find(r => String(r.id) === TARGET_UID);
    return row ? { role: C.roleFromEntry(row), raw_role: row.role, has_tasks: Array.isArray(row.tasks) } : null;
  };

  const acct = await graph.request(`/act_${ACT_ID}`, { params: { fields: "account_id,owner,owner_business{id}" }, expectedUid: owner.user_id });
  const bm = acct && acct.owner_business && acct.owner_business.id;
  report.has_business = !!bm;

  await run("grant ANALYST (users)", C.contracts.grantDirect(ACT_ID, TARGET_UID, "ANALYST")); await sleep(1500);
  report.after_grant = await roleNow();
  await run("change -> ADVERTISER (users)", C.contracts.grantDirect(ACT_ID, TARGET_UID, "ADVERTISER")); await sleep(1500);
  report.after_change = await roleNow();
  if (bm) {
    await run("change -> ANALYST (assigned_users)", C.contracts.assignTasks(ACT_ID, TARGET_UID, "ANALYST")); await sleep(1500);
    report.after_assigned = await roleNow();
  }
  const del = await run("revoke direct (POST method=DELETE /users/{uid})", C.contracts.revokeDirect(ACT_ID, TARGET_UID)); await sleep(1500);
  report.after_revoke_direct = await roleNow();
  if (report.after_revoke_direct && bm) {
    await run("revoke via userpermissions (method=delete)", C.contracts.revokeBusinessUser(ACT_ID, TARGET_UID, bm)); await sleep(1500);
    report.after_revoke_business = await roleNow();
  }

  report.verdict = {
    users_grant_change: !!(report.after_grant && report.after_grant.role === "ANALYST" && report.after_change && report.after_change.role === "ADVERTISER"),
    revoke_direct: del.ok && report.after_revoke_direct === null,
    revoke_userpermissions: report.after_revoke_business === null ? true : (bm ? false : "chưa thử (không có business)"),
    note: "Chỉ bật engine graph cho người dùng khi cả 3 contract cần dùng đều true. Dán các `message` lỗi vào error-classifier.js (TARGET_RE / ACCOUNT_RE) nếu mẫu khác dự đoán."
  };
  console.log(JSON.stringify(report, null, 2));
  try { copy(JSON.stringify(report, null, 2)); } catch (_) {}
})();
