/**
 * Test Graph engine (docx "Định hướng kiến trúc AMIT Super Share"): contracts, classifier, token provider, graph client,
 * Permission Service (qua core thật) và batch controller với engine = graph. Dùng Facebook giả, không có mạng.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = process.argv[2] || path.resolve(__dirname, "..");
const { makeFacebook, TOKEN } = require("./helpers/fake-facebook");

const src = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  -> " + JSON.stringify(extra, (k, v) => (v instanceof Error ? v.message : v)).slice(0, 600))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const FILES = [
  "shared/super-share-core.js", "shared/facebook/error-classifier.js", "shared/facebook/permission-contracts.js",
  "shared/facebook/token-provider.js", "shared/facebook/graph-client.js", "extension/services/permission-service.js"
];

function load(extra) {
  const ctx = vm.createContext(Object.assign({ console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, JSON, Math, URL, URLSearchParams, AbortController }, extra || {}));
  FILES.forEach(f => vm.runInContext(src(f), ctx, { filename: f }));
  return ctx;
}

/** Dựng deps cho Permission Service trên Facebook giả. */
function build(fb, o) {
  o = o || {};
  const ctx = load();
  const logs = [];
  const sleeps = [];
  const log = (lvl, ev, data) => logs.push({ lvl, ev, data });
  const tokens = ctx.AmitTokenProvider.create({
    getCookie: async () => fb.cookieUid,
    fetchPage: async url => { const r = await fb.fetch(url); return { url: r.url, status: r.status, text: await r.text() }; },
    loadLegacySession: async () => null,
    verifyOwner: async token => {
      const r = await fb.fetch(`https://graph.facebook.com/v24.0/me?fields=id&access_token=${token}`);
      const j = JSON.parse(await r.text());
      if (j.error) throw ctx.AmitFbErrors.classifyGraphError(r.status, j.error, r.headers);
      return j.id;
    },
    log, ttlMs: o.ttlMs
  });
  const graph = ctx.AmitGraphClient.create({ fetch: fb.fetch, tokens, log, sleep: async () => {}, timeoutMs: o.timeoutMs });
  const deps = { graph, tokens, log, sleep: async ms => { sleeps.push(ms); }, random: () => 0.5, policy: o.policy };
  const run = (item, opts) => ctx.AmitPermissionService.runItem(deps, item, opts);
  return { ctx, deps, tokens, graph, logs, sleeps, run };
}

const item = (act, extra) => Object.assign({ ad_account_id: act, action: "SHARE_USER", target_uids: ["5"], role: "ADMIN", executor_uid: "1" }, extra || {});
const posts = fb => fb.calls.filter(c => c.method === "POST");
const roleOf = (fb, act, uid) => { const u = fb.acts[act].users.get(uid); return u ? u.role : null; };

(async () => {
  // =========================================================
  // 1. CONTRACTS
  // =========================================================
  {
    const { ctx } = build(makeFacebook());
    const C = ctx.AmitPermissionContracts;
    ok("contracts: role ID 1001/1002/1003", C.ROLE_IDS.ADMIN === 1001 && C.ROLE_IDS.ADVERTISER === 1002 && C.ROLE_IDS.ANALYST === 1003);
    ok("contracts: tasks theo role", JSON.stringify(C.TASKS_BY_ROLE.ADMIN) === '["MANAGE","ADVERTISE","ANALYZE"]' && JSON.stringify(C.TASKS_BY_ROLE.ADVERTISER) === '["ADVERTISE","ANALYZE"]' && JSON.stringify(C.TASKS_BY_ROLE.ANALYST) === '["ANALYZE"]');
    const g = C.contracts.grantDirect("123", "5", "ADVERTISER"), a = C.contracts.assignTasks("act_123", "5", "ANALYST");
    ok("contracts: users dùng role ID, KHÔNG có tasks", g.path === "/act_123/users" && g.params.role === "1002" && g.params.uid === "5" && !("tasks" in g.params), g);
    ok("contracts: assigned_users dùng tasks, KHÔNG có role", a.path === "/act_123/assigned_users" && a.params.tasks === '["ANALYZE"]' && a.params.user === "5" && !("role" in a.params), a);
    ok("contracts: revoke direct + userpermissions", C.contracts.revokeDirect("1", "5").path === "/act_1/users/5" && C.contracts.revokeBusinessUser("1", "5", "77").params.method === "delete" && C.contracts.revokeBusinessUser("1", "5", "77").params.business === "77");
    ok("contracts: roleFromEntry hiểu số / chuỗi / tasks", C.roleFromEntry({ role: 1001 }) === "ADMIN" && C.roleFromEntry({ role: "GENERAL_USER" }) === "ADVERTISER" && C.roleFromEntry({ role: "REPORTS_ONLY" }) === "ANALYST" && C.roleFromEntry({ tasks: ["ADVERTISE", "ANALYZE"] }) === "ADVERTISER" && C.roleFromEntry({ tasks: ["MANAGE"] }) === "ADMIN" && C.roleFromEntry({ role: 7 }) === null);
    ok("contracts: verifyState", C.verifyState({ role: "ADMIN" }, "ADMIN") === "MATCH" && C.verifyState(null, "ADMIN") === "MISSING" && C.verifyState({ role: "ANALYST" }, "ADMIN") === "MISMATCH" && C.verifyState(null, null) === "MATCH");
  }

  // =========================================================
  // 2. ERROR CLASSIFIER
  // =========================================================
  {
    const { ctx } = build(makeFacebook());
    const E = ctx.AmitFbErrors;
    const cls = (st, err, h) => E.classifyGraphError(st, err, h);
    ok("classifier: Graph code 4/17/613 -> RATE_LIMITED (HTTP 200/400, không chỉ 429), pause", [4, 17, 32, 613, 80004].every(c => { const e = cls(400, { code: c, message: "x" }); return e.error_code === "RATE_LIMITED" && e.pause && e.retryable; }));
    ok("classifier: HTTP 429 + Retry-After", (() => { const e = E.classifyHttp(429, { get: () => "30" }); return e.error_code === "RATE_LIMITED" && e.retry_after_ms === 30000; })());
    ok("classifier: 190 chung -> SESSION_EXPIRED category token (retry 1 lần ở client)", (() => { const e = cls(400, { code: 190, message: "expired" }); return e.error_code === "SESSION_EXPIRED" && e.category === "token"; })());
    ok("classifier: 190/459 -> FACEBOOK_CHECKPOINT, 190/460 -> REAUTH", cls(400, { code: 190, error_subcode: 459, message: "x" }).error_code === "FACEBOOK_CHECKPOINT" && cls(400, { code: 190, error_subcode: 460, message: "x" }).error_code === "FACEBOOK_REAUTH_REQUIRED");
    ok("classifier: 10 / 200 / 299 -> INSUFFICIENT_PERMISSION, không fallback", [10, 200, 299].every(c => { const e = cls(403, { code: c, message: "x" }); return e.error_code === "INSUFFICIENT_PERMISSION" && !e.fallback_allowed && !e.retryable; }));
    ok("classifier: code 100 + 'invalid user' -> TARGET_NOT_ELIGIBLE (được fallback)", (() => { const e = cls(400, { code: 100, message: "Invalid user id" }); return e.error_code === "TARGET_NOT_ELIGIBLE" && e.fallback_allowed; })());
    ok("classifier: code 100 mẫu lạ -> FACEBOOK_GRAPH_ERROR, KHÔNG fallback", (() => { const e = cls(400, { code: 100, message: "Something unexpected" }); return e.error_code === "FACEBOOK_GRAPH_ERROR" && !e.fallback_allowed; })());
    ok("classifier: act_ không tồn tại -> ACCOUNT_NOT_FOUND", cls(400, { code: 100, message: "Object with ID 'act_1' does not exist, cannot be loaded due to missing permissions" }).error_code === "ACCOUNT_NOT_FOUND");
    ok("classifier: 5xx / code 2 -> tạm thời, mơ hồ", (() => { const e = E.classifyHttp(503); const f = cls(200, { code: 2, message: "x" }); return e.retryable && e.ambiguous && f.retryable && f.ambiguous; })());
    ok("classifier: URL login / checkpoint / reauth", E.classifyUrl("https://www.facebook.com/login/?next=x").error_code === "SESSION_EXPIRED" && E.classifyUrl("https://www.facebook.com/checkpoint/1/").error_code === "FACEBOOK_CHECKPOINT" && E.classifyUrl("https://www.facebook.com/sensitive_action/").error_code === "FACEBOOK_REAUTH_REQUIRED" && E.classifyUrl("https://adsmanager.facebook.com/adsmanager/manage/accounts") === null);
  }

  // =========================================================
  // 3. TOKEN PROVIDER
  // =========================================================
  {
    const fb = makeFacebook();
    const b = build(fb);
    const T = b.ctx.AmitTokenProvider;
    ok("token: chỉ lấy __accessToken, KHÔNG bắt chuỗi EA... bất kỳ", T.extractAccessToken(`<script>"EAAZ${"z".repeat(30)}"</script>`) === null && T.extractAccessToken(`window.__accessToken="${TOKEN}";`) === TOKEN);
    const t1 = await b.tokens.get("powerEditorAction");
    ok("token: slot token_b, user_id do /me xác nhận, có TTL", t1.slot === "token_b" && t1.user_id === "1" && t1.expires_at > t1.obtained_at && t1.via_type === "ads_manager", { slot: t1.slot, u: t1.user_id });
    const before = fb.tokenHits;
    await b.tokens.get("powerEditorAction");
    ok("token: lần 2 dùng cache (không gọi /me nữa)", fb.tokenHits === before);
    try { await b.tokens.get("powerEditorAction", { expectedUid: "999" }); ok("token: expectedUid khác chủ -> TOKEN_OWNER_MISMATCH", false); }
    catch (e) { ok("token: expectedUid khác chủ -> TOKEN_OWNER_MISMATCH", e.error_code === "TOKEN_OWNER_MISMATCH", e.error_code); }
    try { await b.tokens.get("businessAction"); ok("token: slot chưa hỗ trợ -> TOKEN_UNAVAILABLE", false); }
    catch (e) { ok("token: slot chưa hỗ trợ -> TOKEN_UNAVAILABLE (không đoán)", e.error_code === "TOKEN_UNAVAILABLE"); }
    b.tokens.invalidate("powerEditorAction");
    const h0 = fb.tokenHits; await b.tokens.get("powerEditorAction");
    ok("token: invalidate đúng slot -> resolve lại", fb.tokenHits > h0);

    // chủ token khác cookie
    const fb2 = makeFacebook({ cookieUid: "1", tokenOwner: "2" });
    const b2 = build(fb2);
    try { await b2.tokens.get("powerEditorAction"); ok("token: token của người khác -> TOKEN_OWNER_MISMATCH", false); }
    catch (e) { ok("token: token của người khác -> TOKEN_OWNER_MISMATCH", e.error_code === "TOKEN_OWNER_MISMATCH", e.error_code); }

    // redirect
    for (const [url, code] of [["https://www.facebook.com/login/?next=a", "SESSION_EXPIRED"], ["https://www.facebook.com/checkpoint/123/", "FACEBOOK_CHECKPOINT"], ["https://www.facebook.com/sensitive_action/", "FACEBOOK_REAUTH_REQUIRED"]]) {
      const f3 = makeFacebook(); f3.pageRedirect = url; const b3 = build(f3);
      try { await b3.tokens.get("powerEditorAction"); ok("token: redirect " + code, false); }
      catch (e) { ok("token: redirect -> " + code + " (pause)", e.error_code === code && e.pause === true, e.error_code); }
    }
    const f4 = makeFacebook({ cookieUid: null }); const b4 = build(f4);
    try { await b4.tokens.get("powerEditorAction"); ok("token: không có c_user -> SESSION_EXPIRED", false); } catch (e) { ok("token: không có c_user -> SESSION_EXPIRED", e.error_code === "SESSION_EXPIRED"); }

    // TTL + generation
    let clock = 1000; const f5 = makeFacebook(); const ctx5 = load(); let hits5 = 0;
    const tp = ctx5.AmitTokenProvider.create({ getCookie: async () => "1", fetchPage: async u => { hits5++; const r = await f5.fetch(u); return { url: r.url, text: await r.text() }; }, verifyOwner: async () => "1", now: () => clock, ttlMs: 500 });
    await tp.get("powerEditorAction"); await tp.get("powerEditorAction"); clock += 600; await tp.get("powerEditorAction");
    ok("token: hết TTL -> lấy lại", hits5 === 2, hits5);
    let release; const slow = new Promise(r => { release = r; });
    const tp2 = ctx5.AmitTokenProvider.create({ getCookie: async () => "1", fetchPage: async u => { await slow; const r = await f5.fetch(u); return { url: r.url, text: await r.text() }; }, verifyOwner: async () => "1", now: () => clock, ttlMs: 5000 });
    const inflight = tp2.get("powerEditorAction"); tp2.bumpGeneration(); release(); await inflight;
    ok("token: bumpGeneration -> promise cũ không ghi đè cache mới", tp2.generation === 2);
    const again = await tp2.get("powerEditorAction");
    ok("token: sau bump lấy token thế hệ mới", again.generation === 2, again.generation);
  }

  // =========================================================
  // 4. GRAPH CLIENT
  // =========================================================
  {
    const fb = makeFacebook(); fb.act("100", {}); fb.addUser("100", "1", 1001);
    const b = build(fb);
    await b.graph.request("/act_100/users", { method: "GET", expectedUid: "1" });
    await b.graph.request("/act_100/users", { method: "POST", params: { uid: "5", role: "1001" }, expectedUid: "1" });
    const g = fb.calls[fb.calls.length - 2], p = fb.calls[fb.calls.length - 1];
    ok("client: v24.0 mặc định", /\/v24\.0\//.test(g.url));
    ok("client: GET token trong query; POST token trong BODY, không trong URL", g.urlHasToken && !p.urlHasToken && p.bodyHasToken);
    const serialized = JSON.stringify(b.logs);
    ok("client: log không chứa access token và URL không có access_token", !serialized.includes(TOKEN) && !/access_token=/.test(serialized), serialized.slice(0, 200));

    // timeout mutation: không retry
    const f2 = makeFacebook(); f2.act("100", {});
    const b2 = build(f2);
    f2.hook(c => c.method === "POST", () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; });
    try { await b2.graph.request("/act_100/users", { method: "POST", params: { uid: "5", role: "1001" } }); ok("client: timeout mutation", false); }
    catch (e) { ok("client: timeout mutation -> REQUEST_TIMEOUT, ambiguous, KHÔNG tự retry", e.error_code === "REQUEST_TIMEOUT" && e.ambiguous && posts(f2).length === 1, { c: e.error_code, n: posts(f2).length }); }

    // GET lỗi mạng: retry 1 lần
    const f3 = makeFacebook(); f3.act("100", {}); const b3 = build(f3);
    f3.hook(c => c.path === "/act_100/users", () => { throw new TypeError("fetch failed"); });
    await b3.graph.request("/act_100/users", { method: "GET" });
    ok("client: GET lỗi mạng -> retry đúng 1 lần rồi thành công", f3.calls.filter(c => c.path === "/act_100/users").length === 2);

    // 190 -> invalidate + retry 1 lần với token mới
    const f4 = makeFacebook(); f4.act("100", {}); const b4 = build(f4);
    f4.hook(c => c.path === "/act_100/users", () => f4.gerr(190, "Error validating access token: expired", 400));
    await b4.graph.request("/act_100/users", { method: "POST", params: { uid: "5", role: "1001" } });
    ok("client: token lỗi -> invalidate + retry ĐÚNG MỘT LẦN (kể cả mutation vì đã bị từ chối)", f4.calls.filter(c => c.path === "/act_100/users").length === 2 && roleOf(f4, "100", "5") === 1001);
    const f5 = makeFacebook(); f5.act("100", {}); const b5 = build(f5);
    f5.hook(c => c.path === "/act_100/users", () => f5.gerr(190, "expired", 400), false);
    try { await b5.graph.request("/act_100/users", { method: "GET" }); ok("client: 190 hai lần", false); }
    catch (e) { ok("client: 190 hai lần liên tiếp -> SESSION_EXPIRED, không retry vô hạn", e.error_code === "SESSION_EXPIRED" && f5.calls.filter(c => c.path === "/act_100/users").length === 2); }

    // rate limit: không retry
    const f6 = makeFacebook(); f6.act("100", {}); const b6 = build(f6);
    f6.hook(c => c.path === "/act_100/users", () => f6.gerr(17, "User request limit reached", 400));
    try { await b6.graph.request("/act_100/users", { method: "GET" }); ok("client: rate limit", false); }
    catch (e) { ok("client: rate limit -> RATE_LIMITED, không retry", e.error_code === "RATE_LIMITED" && f6.calls.filter(c => c.path === "/act_100/users").length === 1); }
  }

  // =========================================================
  // 5. PERMISSION SERVICE (qua core thật)
  // =========================================================
  const world = () => { const fb = makeFacebook(); fb.act("100", {}); fb.addUser("100", "1", 1001); return fb; };

  { // GRANT
    const fb = world(); const b = build(fb);
    const r = await b.run(item("100", { target_uids: ["5", "6"], role: "ANALYST" }));
    const t = r.targets;
    ok("grant: SUCCESS cả 2 UID bằng POST /users, đã verify", r.status === "SUCCESS" && t.length === 2 && t.every(x => x.status === "SUCCESS" && x.method_used === "USERS" && x.verify_state === "MATCH" && x.note === "ADDED") && roleOf(fb, "100", "5") === 1003, r);
    ok("grant: có request_id cho item và từng target", /^req_/.test(r.request_id) && t.every(x => x.request_id === `${r.request_id}:${x.uid}`) && r.engine === "graph");
    ok("grant: nghỉ 1-3 giây giữa 2 mutation cùng TKQC (không nghỉ trước mutation đầu)", b.sleeps.filter(ms => ms >= 1000 && ms <= 3000 && ms !== 1000).length >= 1 && b.sleeps.length >= 2, b.sleeps);
    ok("grant: mutation chạy tuần tự; token không có trong kết quả/log", !JSON.stringify([r, b.logs]).includes(TOKEN));
  }
  { // NO ACTION
    const fb = world(); fb.addUser("100", "5", 1001); const b = build(fb);
    const r = await b.run(item("100"));
    ok("grant: đã đúng role -> SUCCESS NO_ACTION_REQUIRED, KHÔNG gửi mutation", r.status === "SUCCESS" && r.targets[0].note === "NO_ACTION_REQUIRED" && r.targets[0].verify_state === "MATCH" && posts(fb).length === 0);
  }
  { // CHANGE direct + assigned
    const fb = world(); fb.addUser("100", "5", 1003); const b = build(fb);
    const r = await b.run(item("100", { role: "ADVERTISER" }));
    ok("change: direct user -> POST /users role mới, ROLE_CHANGED", r.status === "SUCCESS" && r.targets[0].note === "ROLE_CHANGED" && roleOf(fb, "100", "5") === 1002 && posts(fb)[0].path === "/act_100/users");
    const fb2 = world(); fb2.acts["100"].business = "77"; fb2.addUser("100", "5", 1003, "assigned"); const b2 = build(fb2);
    const r2 = await b2.run(item("100", { role: "ADVERTISER" }));
    ok("change: BM user -> POST /assigned_users với tasks", r2.status === "SUCCESS" && r2.targets[0].method_used === "ASSIGNED_USERS" && posts(fb2)[0].path === "/act_100/assigned_users" && JSON.parse(posts(fb2)[0].params.tasks).join() === "ADVERTISE,ANALYZE", r2);
  }
  { // BM_PICKER
    const fb = world(); fb.acts["100"].business = "77"; const b = build(fb);
    const r = await b.run(item("100", { source: "BM_PICKER", role: "ANALYST" }));
    ok("grant: source=BM_PICKER + có business -> dùng assigned_users trước", r.status === "SUCCESS" && r.targets[0].method_used === "ASSIGNED_USERS" && posts(fb).length === 1 && posts(fb)[0].path === "/act_100/assigned_users", posts(fb).map(p => p.path));
  }
  { // ambiguous: không có success
    const fb = world(); const b = build(fb);
    fb.hook(c => c.method === "POST" && c.path === "/act_100/users", (c, init) => { fb.acts["100"].users.set("5", { role: 1001, via: "users" }); return fb.res({}); });
    const r = await b.run(item("100"));
    ok("ambiguous: response không có success nhưng đọc lại khớp -> SUCCESS VERIFIED_AFTER_AMBIGUOUS_RESPONSE", r.status === "SUCCESS" && r.targets[0].note === "VERIFIED_AFTER_AMBIGUOUS_RESPONSE" && r.targets[0].verify_state === "MATCH", r);
    const fb2 = world(); const b2 = build(fb2);
    fb2.hook(c => c.method === "POST", () => fb2.res({ success: false }));
    const r2 = await b2.run(item("100"));
    ok("ambiguous: success:false và đọc lại KHÔNG khớp -> FAILED (không coi là thành công), retryable", r2.status === "FAILED" && r2.targets[0].status === "FAILED" && r2.targets[0].verify_state === "MISSING" && r2.targets[0].retryable === true, r2);
  }
  { // timeout mutation
    const fb = world(); const b = build(fb);
    fb.hook(c => c.method === "POST", () => { fb.acts["100"].users.set("5", { role: 1001, via: "users" }); const e = new Error("a"); e.name = "AbortError"; throw e; });
    const r = await b.run(item("100"));
    ok("timeout: mutation đã áp dụng nhưng client timeout -> verify thấy khớp -> SUCCESS, chỉ 1 POST", r.status === "SUCCESS" && r.targets[0].note === "VERIFIED_AFTER_AMBIGUOUS_RESPONSE" && posts(fb).length === 1, r);
    const fb2 = world(); const b2 = build(fb2);
    fb2.hook(c => c.method === "POST", () => { const e = new Error("a"); e.name = "AbortError"; throw e; });
    const r2 = await b2.run(item("100"));
    ok("timeout: không áp dụng -> FAILED REQUEST_TIMEOUT (mã gốc), retryable, KHÔNG tự retry", r2.status === "FAILED" && r2.targets[0].error_code === "REQUEST_TIMEOUT" && r2.targets[0].retryable === true && posts(fb2).length === 1, r2);
  }
  { // verify unavailable
    const fb = world(); const b = build(fb);
    let posted = false;
    fb.hook(c => c.method === "POST", c => { posted = true; fb.acts["100"].users.set("5", { role: 1001, via: "users" }); return fb.res({ success: true }); });
    fb.hook(c => c.method === "GET" && c.path === "/act_100/users" && posted, () => fb.res("<html>oops</html>", 502), false);
    const r = await b.run(item("100"));
    ok("verify: mutation success nhưng không đọc lại được -> FAILED VERIFY_UNAVAILABLE, verify_state UNAVAILABLE, retryable (UNVERIFIED)", r.status === "FAILED" && r.targets[0].error_code === "VERIFY_UNAVAILABLE" && r.targets[0].verify_state === "UNAVAILABLE" && r.targets[0].retryable === true, r);
  }
  { // role mismatch
    const fb = world(); const b = build(fb);
    fb.hook(c => c.method === "POST", () => { fb.acts["100"].users.set("5", { role: 1003, via: "users" }); return fb.res({ success: true }); });
    const r = await b.run(item("100", { role: "ADMIN" }));
    ok("verify: đọc lại thấy role khác -> FAILED ROLE_MISMATCH, MISMATCH, không retry", r.targets[0].error_code === "ROLE_MISMATCH" && r.targets[0].verify_state === "MISMATCH" && r.targets[0].retryable === false, r.targets[0]);
  }
  { // fallback
    const fb = world(); fb.acts["100"].business = "77"; const b = build(fb);
    fb.hook(c => c.method === "POST" && c.path === "/act_100/users", () => fb.gerr(100, "Invalid user id", 400));
    const r = await b.run(item("100", { role: "ANALYST" }));
    ok("fallback: users báo target không đủ điều kiện -> thử assigned_users", r.status === "SUCCESS" && r.targets[0].method_used === "ASSIGNED_USERS" && posts(fb).map(p => p.path).join() === "/act_100/users,/act_100/assigned_users", posts(fb).map(p => p.path));
    const fb2 = world(); fb2.acts["100"].business = "77"; const b2 = build(fb2);
    fb2.hook(c => c.method === "POST" && c.path === "/act_100/users", () => fb2.gerr(200, "(#200) Requires ads_management permission", 403));
    const r2 = await b2.run(item("100"));
    ok("fallback: lỗi quyền (200) -> KHÔNG fallback, FAILED INSUFFICIENT_PERMISSION, không retryable", r2.targets[0].error_code === "INSUFFICIENT_PERMISSION" && r2.targets[0].retryable === false && posts(fb2).length === 1, r2.targets[0]);
    const fb3 = world(); const b3 = build(fb3);
    fb3.hook(c => c.method === "POST" && c.path === "/act_100/users", () => fb3.gerr(100, "Invalid user id", 400));
    const r3 = await b3.run(item("100"));
    ok("fallback: không có business -> không có contract thứ hai, FAILED TARGET_NOT_ELIGIBLE", r3.targets[0].error_code === "TARGET_NOT_ELIGIBLE" && posts(fb3).length === 1);
    const b4 = build((() => { const f = world(); f.acts["100"].business = "77"; f.hook(c => c.method === "POST" && c.path === "/act_100/users", () => f.gerr(100, "Invalid user id", 400)); fb4 = f; return f; })(), { policy: { fallbackOnTargetError: false } });
    var fb4; const r4 = await b4.run(item("100"));
    ok("fallback: policy tắt fallback -> không thử contract thứ hai", r4.targets[0].error_code === "TARGET_NOT_ELIGIBLE" && posts(fb4).length === 1);
  }
  { // REVOKE
    const fb = world(); fb.addUser("100", "5", 1002); const b = build(fb);
    const r = await b.run(item("100", { action: "REMOVE_BY_UID_EXCEPT_SELF", role: null }));
    ok("revoke: DELETE direct (POST method=DELETE /users/{uid}), verify đã biến mất", r.status === "SUCCESS" && r.targets[0].note === "REMOVED" && r.targets[0].verify_state === "MATCH" && !fb.acts["100"].users.has("5") && posts(fb)[0].path === "/act_100/users/5" && posts(fb)[0].params.method === "DELETE", r);
    const fb2 = world(); fb2.acts["100"].business = "77"; fb2.addUser("100", "5", 1002); const b2 = build(fb2);
    fb2.hook(c => c.path === "/act_100/users/5", () => fb2.gerr(100, "Invalid user id", 400));
    const r2 = await b2.run(item("100", { action: "REMOVE_BY_UID_EXCEPT_SELF", role: null }));
    ok("revoke: direct báo target lỗi + có business -> userpermissions (method=delete)", r2.status === "SUCCESS" && r2.targets[0].method_used === "USERPERMISSIONS" && posts(fb2).some(p => p.path === "/act_100/userpermissions" && p.params.business === "77" && p.params.method === "delete"), r2);
    const fb3 = world(); const b3 = build(fb3);
    const r3 = await b3.run(item("100", { action: "REMOVE_BY_UID_EXCEPT_SELF", target_uids: ["1"], role: null }));
    ok("revoke: UID = SELF bằng action này -> TARGET_IS_SELF, không gửi request", r3.targets[0].error_code === "TARGET_IS_SELF" && posts(fb3).length === 0);
  }
  { // owner
    const fb = world(); fb.acts["100"].owner = "900"; fb.addUser("100", "900", 1001); fb.addUser("100", "5", 1002); fb.addUser("100", "6", 1003); const b = build(fb);
    const r = await b.run(item("100", { action: "REMOVE_ALL_EXCEPT_SELF", target_uids: [], role: null }));
    ok("owner: REMOVE_ALL_EXCEPT_SELF xóa 5,6 nhưng GIỮ self (1) và owner (900)", r.status === "SUCCESS" && fb.acts["100"].users.has("900") && fb.acts["100"].users.has("1") && !fb.acts["100"].users.has("5") && !fb.acts["100"].users.has("6"), [...fb.acts["100"].users.keys()]);
    const fb2 = world(); fb2.addUser("100", "900", 1001); const b2 = build(fb2);
    const r2 = await b2.run(item("100", { action: "REMOVE_BY_UID_EXCEPT_SELF", target_uids: ["900"], role: null }));
    ok("owner: gỡ trực tiếp owner -> FAILED OWNER_PROTECTED, không gửi request", r2.targets[0].error_code === "OWNER_PROTECTED" && r2.targets[0].retryable === false && posts(fb2).length === 0, r2.targets[0]);
  }
  { // REMOVE_SELF (fix #1)
    const fb = world(); fb.addUser("100", "7", 1001); const b = build(fb);
    fb.hook(c => c.method === "GET" && c.path === "/act_100/users" && !fb.acts["100"].users.has("1"), () => fb.gerr(200, "(#200) You do not have permission to view this ad account", 403), false);
    const r = await b.run(item("100", { action: "REMOVE_SELF", target_uids: [], role: null }));
    ok("REMOVE_SELF: sau khi gỡ, đọc lại bị từ chối quyền = BẰNG CHỨNG đã gỡ -> SUCCESS SELF_REMOVED", r.status === "SUCCESS" && r.note === "SELF_REMOVED" && !fb.acts["100"].users.has("1"), r);
    const fb2 = world(); fb2.addUser("100", "7", 1001); const b2 = build(fb2);
    fb2.hook(c => c.method === "POST" && c.path === "/act_100/users/1", () => fb2.res({ success: true }));
    const r2 = await b2.run(item("100", { action: "REMOVE_SELF", target_uids: [], role: null }));
    ok("REMOVE_SELF: Facebook nói success nhưng SELF vẫn còn trong danh sách -> FAILED REMOVE_VERIFY_FAILED", r2.status === "FAILED" && r2.error_code === "REMOVE_VERIFY_FAILED", r2);
    const fb3 = world(); fb3.addUser("100", "7", 1001); const b3 = build(fb3);
    fb3.hook(c => c.method === "GET" && c.path === "/act_100/users" && !fb3.acts["100"].users.has("1"), () => { throw new TypeError("fetch failed"); }, false);
    const r3 = await b3.run(item("100", { action: "REMOVE_SELF", target_uids: [], role: null }));
    ok("REMOVE_SELF: đọc lại lỗi mạng -> KHÔNG có tín hiệu -> FAILED (không đoán là đã gỡ)", r3.status === "FAILED" && r3.error_code === "REMOVE_VERIFY_FAILED", r3);
    const fb4 = world(); const b4 = build(fb4);
    const r4 = await b4.run(item("100", { action: "REMOVE_SELF", target_uids: [], role: null }));
    ok("REMOVE_SELF: không còn admin khác -> NO_OTHER_ADMIN, không gửi request", r4.error_code === "NO_OTHER_ADMIN" && posts(fb4).length === 0);
    const fb5 = world(); fb5.acts["100"].owner = "1"; fb5.addUser("100", "7", 1001); const b5 = build(fb5);
    const r5 = await b5.run(item("100", { action: "REMOVE_SELF", target_uids: [], role: null }));
    ok("REMOVE_SELF: executor là owner TKQC -> OWNER_PROTECTED", r5.error_code === "OWNER_PROTECTED" && posts(fb5).length === 0, r5);
  }
  { // identity
    const fb = world(); const b = build(fb);
    const r = await b.run(item("100", { executor_uid: "2" }));
    ok("identity: executor_uid != chủ token/cookie -> EXECUTOR_IDENTITY_MISMATCH, KHÔNG gửi request nào tới TKQC", r.status === "FAILED" && r.error_code === "EXECUTOR_IDENTITY_MISMATCH" && fb.calls.filter(c => /act_/.test(c.path)).length === 0, r);
    const r2 = await b.run(item("100", { executor_uid: null }));
    ok("identity: thiếu executor_uid cũng bị chặn với SHARE_USER (Graph engine luôn cần danh tính)", r2.error_code === "EXECUTOR_IDENTITY_MISMATCH" && posts(fb).length === 0);
    const f3 = world(); f3.tokenOwner = "2"; const b3 = build(f3);
    const r3 = await b3.run(item("100"));
    ok("identity: token thuộc người khác cookie -> chặn (TOKEN_OWNER_MISMATCH -> mismatch), không mutation", r3.status === "FAILED" && posts(f3).length === 0, r3.error_code);
  }
  { // pause
    const fb = world(); fb.addUser("100", "5", 1003); const b = build(fb);
    fb.hook(c => c.method === "POST", () => fb.gerr(17, "User request limit reached", 400));
    const r = await b.run(item("100", { target_uids: ["5", "6"], role: "ADMIN" }));
    ok("rate limit giữa chừng -> PAUSED RATE_LIMITED (giữ hàng đợi), không biến thành FAILED target", r.status === "PAUSED" && r.error_code === "RATE_LIMITED" && !r.targets.some(t => t.status === "FAILED"), r);
    const f2 = world(); f2.pageRedirect = "https://www.facebook.com/checkpoint/1/"; const b2 = build(f2);
    const r2 = await b2.run(item("100"));
    ok("checkpoint -> PAUSED FACEBOOK_CHECKPOINT, không gửi request nào tới TKQC", r2.status === "PAUSED" && r2.error_code === "FACEBOOK_CHECKPOINT" && f2.calls.filter(c => /act_/.test(c.path)).length === 0, r2);
    const f3 = world(); f3.pageRedirect = "https://www.facebook.com/login/"; const b3 = build(f3);
    const r3 = await b3.run(item("100"));
    ok("login -> PAUSED SESSION_EXPIRED", r3.status === "PAUSED" && r3.error_code === "SESSION_EXPIRED");
    const f4 = world(); f4.pageRedirect = "https://www.facebook.com/sensitive_action/"; const b4 = build(f4);
    const r4 = await b4.run(item("100"));
    ok("reauth -> PAUSED FACEBOOK_REAUTH_REQUIRED", r4.status === "PAUSED" && r4.error_code === "FACEBOOK_REAUTH_REQUIRED");
  }
  { // account
    const fb = world(); const b = build(fb);
    const r = await b.run(item("999"));
    ok("account không tồn tại / không truy cập được -> FAILED ACCOUNT_NOT_FOUND, không mutation", r.status === "FAILED" && r.error_code === "ACCOUNT_NOT_FOUND" && posts(fb).length === 0, r.error_code);
    const f2 = world(); f2.hook(c => c.path === "/act_100", () => f2.gerr(200, "(#200) permission", 403)); const b2 = build(f2);
    const r2 = await b2.run(item("100"));
    ok("account bị từ chối quyền -> ACCOUNT_ACCESS_DENIED", r2.error_code === "ACCOUNT_ACCESS_DENIED", r2.error_code);
  }
  { // retry rules
    const SS = load().AmitSuperShareCore;
    const batch = SS.newBatch({ items: [
      { ad_account_id: "1", action: "SHARE_USER", target_uids: ["5", "6"], role: "ADMIN", executor_uid: "1" },
      { ad_account_id: "2", action: "SHARE_USER", target_uids: ["5"], role: "ADMIN", executor_uid: "1" },
      { ad_account_id: "3", action: "REMOVE_SELF", target_uids: [], executor_uid: "1" }
    ] }, "b", "t");
    const [a, c, d] = batch.items;
    a.status = "FAILED"; a.targets = [{ uid: "5", status: "FAILED", error_code: "REQUEST_TIMEOUT", retryable: true }, { uid: "6", status: "FAILED", error_code: "INSUFFICIENT_PERMISSION", retryable: false }];
    c.status = "FAILED"; c.targets = [{ uid: "5", status: "FAILED", error_code: "INSUFFICIENT_PERMISSION", retryable: false }];
    d.status = "FAILED"; d.error_code = "NO_OTHER_ADMIN"; d.retryable = false;
    const items = SS.buildRetryItems(batch);
    ok("retry: chỉ gửi lại target tạm thời/chưa xác minh; bỏ target và TKQC không retry được", items.length === 1 && items[0].ad_account_id === "1" && items[0].target_uids.join() === "5", items);
    const dom = SS.newBatch({ items: [{ ad_account_id: "9", action: "SHARE_USER", target_uids: ["5"], role: "ADMIN", executor_uid: "1" }] }, "b", "t");
    dom.items[0].status = "FAILED"; dom.items[0].targets = [{ uid: "5", status: "FAILED", error_code: "ACCOUNT_NOT_FOUND" }];
    ok("retry: DOM engine (không có cờ retryable) giữ hành vi cũ", SS.buildRetryItems(dom).length === 1);
  }

  // =========================================================
  // 6. BATCH CONTROLLER + MESSAGE HANDLER với engine = graph
  // =========================================================
  {
    const fb = world(); fb.act("200", {}); fb.addUser("200", "1", 1001);
    const store = {};
    const events = [];
    const chrome = {
      storage: { local: {
        get: async k => (typeof k === "string" ? { [k]: store[k] } : Array.isArray(k) ? Object.fromEntries(k.map(x => [x, store[x]])) : { ...store }),
        set: async o => { Object.assign(store, JSON.parse(JSON.stringify(o))); }
      } },
      runtime: { sendMessage: async m => { if (m && m.batch) events.push(["BROADCAST", m.batch.processed, m.batch.status]); }, getPlatformInfo: async () => ({}) },
      windows: { create: async () => { events.push(["WINDOW_OPEN"]); return { id: 1, tabs: [{ id: 1 }] }; }, remove: async () => {} },
      tabs: { get: async id => ({ id, url: "x" }), update: async () => { events.push(["NAV"]); }, onUpdated: { addListener() {}, removeListener() {} }, sendMessage: async () => { events.push(["TAB_MSG"]); return { ok: false }; } },
      scripting: { executeScript: async () => { events.push(["INJECT"]); } }
    };
    const ctx = load({ chrome, fetch: fb.fetch });
    ctx.getFacebookCookie = async () => fb.cookieUid;
    ctx.resolveFacebookSession = async () => null;
    vm.runInContext(src("extension/services/permission-message-handler.js"), ctx, { filename: "permission-message-handler.js" });
    vm.runInContext(src("extension/batch-controller.js"), ctx, { filename: "batch-controller.js" });
    vm.runInContext("graphDelayMs = () => 5;", ctx);
    const batch = () => vm.runInContext("currentBatch", ctx);
    const waitDone = async () => { const end = Date.now() + 15000; while (Date.now() < end) { const bt = batch(); if (bt && bt.status !== "RUNNING") return bt; await sleep(40); } return batch(); };

    const g0 = await vm.runInContext("getSuperShareEngine()", ctx);
    ok("engine: mặc định là dom (Graph chỉ bật bằng feature flag)", g0 === "dom");
    const rBad = await vm.runInContext("setSuperShareEngine('x')", ctx);
    ok("engine: giá trị lạ bị từ chối", rBad.ok === false);

    // dom mặc định vẫn đi đường cũ (mở cửa sổ runner)
    await vm.runInContext("setSuperShareEngine('graph')", ctx);
    ok("engine: set graph", (await vm.runInContext("getSuperShareEngine()", ctx)) === "graph");

    // Lưu ý: runner Graph dùng sleep thật của deps (1-3 giây giữa mutation) -> mỗi TKQC chỉ 1 UID để test nhanh
    const r = await ctx.startBatch({ items: [item("100"), item("200", { target_uids: ["8"], role: "ANALYST" })], delay_seconds: 3 });
    ok("controller graph: batch.engine = graph", r.success && r.batch.engine === "graph", r);
    const done = await waitDone();
    ok("controller graph: 2 TKQC SUCCESS, không mở cửa sổ/tab/inject, không gọi executor", done.status === "FINISHED" && done.success === 2 && done.failed === 0 && !events.some(e => ["WINDOW_OPEN", "NAV", "TAB_MSG", "INJECT"].includes(e[0])), { s: done.status, ok: done.success, ev: events.filter(e => e[0] !== "BROADCAST") });
    ok("controller graph: kết quả từng UID có method_used / verify_state / request_id", done.items.every(i => i.engine === "graph" && i.targets.every(t => t.method_used === "USERS" && t.verify_state === "MATCH" && t.request_id)), done.items[0]);
    ok("controller graph: không rò token vào batch đã lưu", !JSON.stringify(store).includes(TOKEN));

    // pause khi rate limit, resume chạy tiếp
    const fb2 = fb; let limited = true;
    fb2.hook(c => c.method === "POST" && limited, () => fb2.gerr(17, "User request limit reached", 400), false);
    const r2 = await ctx.startBatch({ items: [item("100", { target_uids: ["20"] }), item("200", { target_uids: ["21"] })], delay_seconds: 3 });
    const paused = await waitDone();
    ok("controller graph: RATE_LIMITED -> batch PAUSED, TKQC sau chưa chạy", paused.status === "PAUSED" && paused.pause_reason === "RATE_LIMITED" && paused.items[1].status === "PENDING", { s: paused.status, r: paused.pause_reason, i: paused.items.map(i => i.status) });
    limited = false;
    const rr = await ctx.resumeBatch();
    const fin = await waitDone();
    ok("controller graph: Tiếp tục sau rate limit -> hoàn tất cả 2 TKQC", rr.success && fin.status === "FINISHED" && fin.success === 2, { s: fin.status, i: fin.items.map(i => i.status) });

    // permission_execute (lệnh đơn chuẩn)
    const pe = await vm.runInContext("handlePermissionExecute", ctx)({ request_id: "rq1", action: "GRANT", ad_account_id: "100", target_uid: "31", role: "ADVERTISER", executor_uid: "1" });
    ok("permission_execute: GRANT -> PermissionResult SUCCESS có method_used & verify_state MATCH", pe.success && pe.result.status === "SUCCESS" && pe.result.request_id === "rq1" && pe.result.method_used === "USERS" && pe.result.verify_state === "MATCH" && pe.result.retryable === false && roleOf(fb, "100", "31") === 1002, pe);
    const pe2 = await vm.runInContext("handlePermissionExecute", ctx)({ action: "GRANT", ad_account_id: "100", target_uid: "abc", role: "ADMIN", executor_uid: "1" });
    ok("permission_execute: input sai bị từ chối trước khi gọi Facebook", pe2.success === false && pe2.error === "INVALID_INPUT");
    const pe3 = await vm.runInContext("handlePermissionExecute", ctx)({ action: "DROP", ad_account_id: "100", target_uid: "31", executor_uid: "1" });
    ok("permission_execute: action lạ bị từ chối", pe3.success === false);
    const pe4 = await vm.runInContext("handlePermissionExecute", ctx)({ action: "REVOKE", ad_account_id: "100", target_uid: "31", executor_uid: "1" });
    ok("permission_execute: REVOKE -> SUCCESS REMOVED", pe4.result.status === "SUCCESS" && pe4.result.note === "REMOVED" && !fb.acts["100"].users.has("31"), pe4);
    const pe5 = await vm.runInContext("handlePermissionExecute", ctx)({ action: "GRANT", ad_account_id: "100", target_uid: "32", role: "ADMIN", executor_uid: "2" });
    ok("permission_execute: executor sai -> FAILED EXECUTOR_IDENTITY_MISMATCH", pe5.result.status === "FAILED" && pe5.result.error_code === "EXECUTOR_IDENTITY_MISMATCH" && pe5.result.retryable === false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("CRASH", e); process.exit(2); });
