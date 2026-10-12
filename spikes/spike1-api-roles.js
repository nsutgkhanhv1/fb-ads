/**
 * SPIKE 1 — Kiểm chứng Graph API vai trò TKQC (CHỈ ĐỌC, không POST/DELETE)
 *
 * Trả lời:
 *   1. Token cào từ session còn dùng được không?
 *   2. GET /act_{id}/users còn hoạt động không?
 *   3. Response có role/tasks không? (cần cho NO_OTHER_ADMIN và keep-list)
 *   4. Xác định được SELF trong danh sách không?
 *
 * CÁCH CHẠY (chọn 1):
 *   A. (Khuyến nghị) Service worker của extension:
 *        chrome://extensions -> AMIT V1 -> "service worker" (Inspect) -> tab Console -> dán toàn bộ file này.
 *        Chạy đúng đường code của extension (resolveFacebookSession).
 *   B. Trang Ads Manager: mở https://adsmanager.facebook.com đang đăng nhập -> F12 -> Console -> dán.
 *        Nếu bị CORS thì dùng cách A.
 *
 * TRƯỚC KHI CHẠY: sửa ACT_ID bên dưới thành ID một TKQC mà Via này đang có quyền (nên là TKQC test).
 * Token KHÔNG bị in ra. UID trong kết quả được che bớt; kết quả được copy vào clipboard (nếu được).
 */
(async () => {
  // ID TKQC (không phải UID Facebook của Via!). Để trống = tự liệt kê /me/adaccounts và chọn TKQC đầu tiên.
  let ACT_ID = "";
  const GRAPH = "https://graph.facebook.com/v19.0";

  if (ACT_ID && !/^\d+$/.test(ACT_ID)) {
    console.error("ACT_ID chỉ gồm số (bỏ tiền tố act_).");
    return;
  }

  const mask = id => (id && String(id).length > 6 ? `${String(id).slice(0, 3)}…${String(id).slice(-3)}` : String(id));
  const report = { where: null, token: {}, calls: {}, verdict: {} };

  // ---- 1. Lấy token + uid giống extension ----
  let token = null;
  let selfUid = null;
  if (typeof resolveFacebookSession === "function") {
    report.where = "extension-service-worker";
    const s = await resolveFacebookSession(false);
    token = s && s.accessToken;
    selfUid = s && s.uid;
  } else {
    report.where = "page:" + location.hostname;
    const m = document.cookie.match(/(?:^|; )c_user=(\d+)/);
    selfUid = m ? m[1] : null;
    const html = document.documentElement.outerHTML;
    const all = html.match(/"(EA[A-Za-z0-9]{20,})"/g) || [];
    const clean = all.map(x => x.replace(/"/g, ""));
    token = clean.find(x => x.startsWith("EAAB") || x.startsWith("EAAI")) || clean[0] || null;
  }
  report.token = { found: !!token, prefix: token ? token.slice(0, 4) : null, selfUidMasked: selfUid ? mask(selfUid) : null };

  if (!token) {
    report.verdict = { tokenFound: false, note: "Không lấy được access token. Mở một tab Ads Manager đã đăng nhập rồi chạy lại." };
    console.log(JSON.stringify(report, null, 2));
    try { copy(JSON.stringify(report, null, 2)); } catch {}
    return;
  }

  // ---- helper ----
  async function get(path, params = {}) {
    const url = `${GRAPH}/${path}?${new URLSearchParams({ ...params, access_token: token })}`;
    try {
      const r = await fetch(url, { credentials: "include" });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
      return { status: r.status, body };
    } catch (e) {
      return { fetchError: String(e) };
    }
  }

  // Cùng quy tắc với AmitFbApi.isAdminUser
  function isAdminUser(u) {
    if (u.role === undefined && !Array.isArray(u.tasks)) return null;
    if (u.role === "ADMINISTER" || u.role === "ADMIN" || u.role === 1001) return true;
    if (Array.isArray(u.tasks) && u.tasks.includes("MANAGE")) return true;
    return false;
  }

  function summarizeUsers(res) {
    if (res.fetchError) return { ok: false, fetchError: res.fetchError };
    if (res.body && res.body.error) {
      return { ok: false, status: res.status, error: { code: res.body.error.code, type: res.body.error.type, message: res.body.error.message } };
    }
    const data = (res.body && res.body.data) || [];
    const keys = [...new Set(data.flatMap(u => Object.keys(u)))];
    return {
      ok: true,
      status: res.status,
      count: data.length,
      hasNextPage: !!(res.body.paging && res.body.paging.next),
      keysSeen: keys,
      users: data.map(u => ({
        id: mask(u.id),
        isSelf: selfUid ? String(u.id) === String(selfUid) : null,
        role: u.role,
        tasks: u.tasks,
        isAdmin: isAdminUser(u)
      }))
    };
  }

  // ---- 2. Chọn TKQC để thử ----
  report.warnings = [];
  if (ACT_ID && selfUid && String(ACT_ID) === String(selfUid)) {
    report.warnings.push("ACT_ID trùng UID Facebook của Via -> đây không phải ID TKQC. Bỏ qua và tự chọn TKQC.");
    ACT_ID = "";
  }
  const list = await get("me/adaccounts", { fields: "account_id,name,account_status", limit: "25" });
  const accounts = (list.body && list.body.data) || [];
  report.availableAdAccounts = list.body && list.body.error
    ? { ok: false, error: list.body.error.message }
    : { ok: true, count: accounts.length, items: accounts.map(a => ({ id: a.account_id, name: a.name, status: a.account_status })) };
  if (!ACT_ID) {
    if (!accounts.length) {
      report.verdict = { note: "Via này không có TKQC nào trong /me/adaccounts nên không thể thử /users. Điền ACT_ID thủ công." };
      const t = JSON.stringify(report, null, 2);
      console.log(t);
      try { copy(t); } catch {}
      return;
    }
    ACT_ID = String(accounts[0].account_id).replace(/^act_/, "");
  }
  report.testedAdAccount = ACT_ID;

  // ---- 3. Các lời gọi (chỉ GET) ----
  const me = await get("me", { fields: "id,name" });
  report.calls.me = me.body && me.body.error
    ? { ok: false, error: me.body.error.message }
    : { ok: !!(me.body && me.body.id), idMatchesCookie: me.body && me.body.id ? String(me.body.id) === String(selfUid) : null };

  report.calls.usersDefault = summarizeUsers(await get(`act_${ACT_ID}/users`));
  report.calls.usersRoleTasks = summarizeUsers(await get(`act_${ACT_ID}/users`, { fields: "id,name,role,tasks" }));
  report.calls.usersTasksOnly = summarizeUsers(await get(`act_${ACT_ID}/users`, { fields: "id,name,tasks" }));
  report.calls.usersRoleOnly = summarizeUsers(await get(`act_${ACT_ID}/users`, { fields: "id,name,role" }));

  const perms = await get(`act_${ACT_ID}`, { fields: "userpermissions" });
  report.calls.userpermissions = perms.body && perms.body.error
    ? { ok: false, error: { code: perms.body.error.code, message: perms.body.error.message } }
    : { ok: true, sample: JSON.stringify((perms.body.userpermissions && perms.body.userpermissions.data || []).slice(0, 3)).slice(0, 400) };

  // ---- 3. Kết luận ----
  const candidates = [report.calls.usersDefault, report.calls.usersRoleTasks, report.calls.usersTasksOnly, report.calls.usersRoleOnly].filter(c => c.ok);
  const best = candidates.find(c => c.users.every(u => u.isAdmin !== null)) || candidates[0] || null;
  report.verdict = {
    tokenFound: true,
    tokenValid: report.calls.me.ok === true,
    usersEndpointWorks: candidates.length > 0,
    roleOrTasksReturned: !!best && best.users.some(u => u.role !== undefined || Array.isArray(u.tasks)),
    selfIdentifiable: !!best && best.users.some(u => u.isSelf === true),
    canDetermineAdminForEveryone: !!best && best.users.length > 0 && best.users.every(u => u.isAdmin !== null),
    hasNextPage: !!best && best.hasNextPage,
    note: "usersEndpointWorks=false hoặc canDetermineAdminForEveryone=false nghĩa là hướng Graph API không đủ cho NO_OTHER_ADMIN -> càng cần executor UI."
  };

  const text = JSON.stringify(report, null, 2);
  console.log(text);
  try { copy(text); console.log("(Đã copy kết quả vào clipboard)"); } catch {}
})();
