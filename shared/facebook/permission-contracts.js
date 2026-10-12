/**
 * AMIT V1 - Permission contracts (docx §5.2, §8): ánh xạ vai trò <-> role ID / tasks và dựng request Graph.
 *
 * Hai contract KHÔNG được trộn trong một request:
 *   - USERS           : POST /act_{id}/users           uid + role (1001|1002|1003)
 *   - ASSIGNED_USERS  : POST /act_{id}/assigned_users  user + tasks (JSON)
 * Revoke:
 *   - USERS (ưu tiên)         : DELETE /act_{id}/users/{uid}      (gửi dạng POST + method=DELETE)
 *   - USERPERMISSIONS (dự phòng, cần business): POST /act_{id}/userpermissions  method=delete
 *
 * ⚠ Bằng chứng từ bundle SMIT chỉ có `users` (cấp) và `assigned_users` (cấp/đổi). Hai contract REVOKE là theo đặc tả
 * AMIT chứ CHƯA được quan sát trong SMIT -> phải chạy spikes/spike3-graph-contracts.js trên TKQC thử nghiệm trước khi
 * bật graph engine cho người dùng.
 */
(function (root) {
  "use strict";

  const VERSION = "v24.0";
  const ROLE_IDS = Object.freeze({ ADMIN: 1001, ADVERTISER: 1002, ANALYST: 1003 });
  const TASKS_BY_ROLE = Object.freeze({
    ADMIN: Object.freeze(["MANAGE", "ADVERTISE", "ANALYZE"]),
    ADVERTISER: Object.freeze(["ADVERTISE", "ANALYZE"]),
    ANALYST: Object.freeze(["ANALYZE"])
  });
  const METHODS = Object.freeze({ USERS: "USERS", ASSIGNED_USERS: "ASSIGNED_USERS", USERPERMISSIONS: "USERPERMISSIONS" });

  const ROLE_BY_ID = Object.freeze({ 1001: "ADMIN", 1002: "ADVERTISER", 1003: "ANALYST" });
  const ROLE_BY_NAME = Object.freeze({
    ADMIN: "ADMIN", ADMINISTER: "ADMIN",
    ADVERTISER: "ADVERTISER", GENERAL_USER: "ADVERTISER",
    ANALYST: "ANALYST", REPORTS_ONLY: "ANALYST"
  });

  const cleanAct = id => String(id === undefined || id === null ? "" : id).replace(/^act_/, "");

  /** Đọc vai trò (ADMIN|ADVERTISER|ANALYST|null) từ một dòng của edge `users` hoặc `assigned_users`. */
  function roleFromEntry(entry) {
    if (!entry) return null;
    const r = entry.role;
    if (r !== undefined && r !== null) {
      if (ROLE_BY_ID[Number(r)]) return ROLE_BY_ID[Number(r)];
      const byName = ROLE_BY_NAME[String(r).toUpperCase()];
      if (byName) return byName;
    }
    const tasks = Array.isArray(entry.tasks) ? entry.tasks.map(t => String(t).toUpperCase()) : null;
    if (tasks && tasks.length) {
      if (tasks.includes("MANAGE")) return "ADMIN";
      if (tasks.includes("ADVERTISE")) return "ADVERTISER";
      if (tasks.includes("ANALYZE")) return "ANALYST";
    }
    return null;
  }

  const form = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === "string" ? v : String(v)]));

  const contracts = {
    listUsers: adId => ({ method: "GET", path: `/act_${cleanAct(adId)}/users`, params: { limit: "500" }, contract: METHODS.USERS }),
    listAssignedUsers: (adId, businessId) => ({
      method: "GET", path: `/act_${cleanAct(adId)}/assigned_users`,
      params: { business: String(businessId), fields: "id,name,tasks", limit: "500" }, contract: METHODS.ASSIGNED_USERS
    }),
    grantDirect: (adId, uid, role) => {
      if (!ROLE_IDS[role]) throw new Error(`Role không hợp lệ: ${role}`);
      return { method: "POST", path: `/act_${cleanAct(adId)}/users`, params: form({ uid, role: ROLE_IDS[role] }), contract: METHODS.USERS, mutation: true };
    },
    assignTasks: (adId, uid, role) => {
      if (!TASKS_BY_ROLE[role]) throw new Error(`Role không hợp lệ: ${role}`);
      return { method: "POST", path: `/act_${cleanAct(adId)}/assigned_users`, params: form({ user: uid, tasks: JSON.stringify(TASKS_BY_ROLE[role]) }), contract: METHODS.ASSIGNED_USERS, mutation: true };
    },
    revokeDirect: (adId, uid) => ({
      method: "POST", path: `/act_${cleanAct(adId)}/users/${encodeURIComponent(uid)}`, params: { method: "DELETE" }, contract: METHODS.USERS, mutation: true
    }),
    revokeBusinessUser: (adId, uid, businessId) => ({
      method: "POST", path: `/act_${cleanAct(adId)}/userpermissions`,
      params: form({ accountId: cleanAct(adId), business: businessId, method: "delete", user: uid }), contract: METHODS.USERPERMISSIONS, mutation: true
    }),
    account: adId => ({ method: "GET", path: `/act_${cleanAct(adId)}`, params: { fields: "account_id,owner,owner_business{id}" } })
  };

  /** verify_state (docx §5.3): so một dòng đọc lại với vai trò mong muốn (null = mong muốn "không còn"). */
  function verifyState(entry, expectedRole) {
    if (expectedRole === null || expectedRole === undefined) return entry ? "MISMATCH" : "MATCH";
    if (!entry) return "MISSING";
    return entry.role === expectedRole ? "MATCH" : "MISMATCH";
  }

  const api = { VERSION, ROLE_IDS, TASKS_BY_ROLE, METHODS, roleFromEntry, contracts, verifyState, cleanAct };
  root.AmitPermissionContracts = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
