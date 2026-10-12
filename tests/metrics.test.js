/**
 * Test số liệu nghiệm thu AC10 / AC11 (shared/metrics.js). Thuần JS, không cần Facebook giả.
 */
const path = require("path");
const ROOT = process.argv[2] || path.resolve(__dirname, "..");
const M = require(path.join(ROOT, "shared/metrics.js"));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  -> " + JSON.stringify(extra).slice(0, 600))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const empty = () => ({ since: "2026-10-01T00:00:00.000Z", targets: [], events: [], requests: [] });
let n = 0;
const rec = o => Object.assign({ ts: ++n, batch_id: "b", engine: "graph", is_retry: false, action: "SHARE_USER", role: "ADMIN", ad_account_id: "100", item_ms: 2000, target_ms: 2000,
  account_level: false, status: "SUCCESS", error_code: null, verify_state: "MATCH", method_used: "USERS", retryable: null, note: null }, o);
const many = (k, o) => Array.from({ length: k }, (_, i) => rec(typeof o === "function" ? o(i) : o));

(async () => {
  // ---- tiện ích ----
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  ok("percentile: nearest-rank (P50 = 50, P95 = 95, P100 = 100)", M.percentile(hundred, 50) === 50 && M.percentile(hundred, 95) === 95 && M.percentile(hundred, 100) === 100);
  ok("percentile: 1 phần tử, rỗng, không sắp xếp sẵn", M.percentile([7], 95) === 7 && M.percentile([], 95) === null && M.percentile([9, 1, 5], 50) === 5);
  ok("percentile: không làm thay đổi mảng đầu vào", (() => { const a = [3, 1, 2]; M.percentile(a, 95); return a.join() === "3,1,2"; })());
  ok("normalizeEndpoint: bỏ version, ID TKQC, UID", M.normalizeEndpoint("/v24.0/act_123456789/users/987654321") === "/act_{id}/users/{uid}" && M.normalizeEndpoint("/act_123456789/assigned_users") === "/act_{id}/assigned_users" && M.normalizeEndpoint("/me") === "/me");
  ok("maskId: che phần giữa", M.maskId("1234567890") === "123…890" && M.maskId("123") === "123");

  // ---- bản ghi target ----
  const result = { ad_account_id: "100", action: "SHARE_USER", role: "ADMIN", engine: "graph", status: "SUCCESS",
    targets: [{ uid: "555", status: "SUCCESS", verify_state: "MATCH", method_used: "USERS", error_message: "tên Nguyễn Văn A" }, { uid: "556", status: "FAILED", error_code: "ROLE_MISMATCH", verify_state: "MISMATCH", retryable: false, error_message: "x" }, { uid: "557", status: "SUCCESS", verify_state: "MATCH", method_used: "USERS" }] };
  const rs = M.targetRecords({ ts: 1, batch_id: "b1", item_ms: 9000, backoff_ms: 3000, is_retry: false }, result);
  ok("targetRecords: mỗi target một bản ghi; thời gian = (item - backoff) / số target", rs.length === 3 && rs.every(r => r.item_ms === 6000 && r.target_ms === 2000), rs);
  ok("targetRecords: KHÔNG chứa UID, tên hay nội dung lỗi (chỉ ID TKQC)", !/555|556|Nguyễn|"x"|uid|error_message/.test(JSON.stringify(rs)), rs);
  ok("targetRecords: giữ verify_state, method, mã lỗi, retryable", rs[1].verify_state === "MISMATCH" && rs[1].error_code === "ROLE_MISMATCH" && rs[1].retryable === false && rs[0].method_used === "USERS");
  const acct = M.targetRecords({ ts: 1, item_ms: 1500 }, { ad_account_id: "9", action: "REMOVE_ALL_EXCEPT_SELF", engine: "graph", status: "FAILED", error_code: "NO_OTHER_ADMIN", targets: [] });
  ok("targetRecords: lỗi mức TKQC (chưa có target) -> 1 bản ghi account_level", acct.length === 1 && acct[0].account_level && acct[0].status === "FAILED" && acct[0].error_code === "NO_OTHER_ADMIN" && acct[0].target_ms === 1500);
  ok("targetRecords: backoff lớn hơn thời gian -> không âm", M.targetRecords({ item_ms: 100, backoff_ms: 5000 }, result)[0].target_ms === 0);

  // ---- AC10 ----
  {
    const d = empty();
    d.targets = [
      ...many(38, { verify_state: "MATCH", status: "SUCCESS" }),
      ...many(2, { verify_state: "MISMATCH", status: "FAILED", error_code: "ROLE_MISMATCH" }),
      ...many(5, { verify_state: null, status: "FAILED", error_code: "INSUFFICIENT_PERMISSION" }), // lỗi trước xác minh
      ...many(10, { verify_state: "MATCH", status: "SUCCESS", is_retry: true })                     // Retry: không tính
    ];
    const s = M.summarize(d, {});
    ok("AC10: tỷ lệ xác minh = 38/40 (bỏ lỗi trước xác minh và Retry)", s.engines.graph.verifiable === 40 && Math.abs(s.engines.graph.verified_rate - 0.95) < 1e-9 && s.engines.graph.failed_before_verify === 5, s.engines.graph);
    ok("AC10: chưa đặt ngưỡng -> NO_THRESHOLD (không tự đoán PASS)", s.ac10.status === "NO_THRESHOLD");
    ok("AC10: ngưỡng 90% -> PASS; 95% -> PASS (bằng ngưỡng); 99% -> FAIL", M.summarize(d, { ac10_min_verified_rate: 0.9 }).ac10.status === "PASS" && M.summarize(d, { ac10_min_verified_rate: 0.95 }).ac10.status === "PASS" && M.summarize(d, { ac10_min_verified_rate: 0.99 }).ac10.status === "FAIL");
    ok("AC10: ít mẫu hơn mức tối thiểu -> INSUFFICIENT_DATA", M.summarize(d, { ac10_min_verified_rate: 0.5, min_samples: 100 }).ac10.status === "INSUFFICIENT_DATA");
    ok("AC10: Retry được đếm riêng, không vào mẫu", s.sample.retries === 10 && s.sample.first_attempt === 45 && s.engines.graph.targets === 45);
    const only404 = empty();
    only404.targets = [...many(40, { verify_state: "UNAVAILABLE", status: "FAILED", error_code: "VERIFY_UNAVAILABLE" })];
    ok("AC10: không đọc lại được (UNAVAILABLE) vẫn là mẫu xác minh THẤT BẠI, không bị bỏ qua", M.summarize(only404, { ac10_min_verified_rate: 0.5 }).ac10.status === "FAIL");
    ok("AC10: dữ liệu rỗng -> tỷ lệ null, không chia cho 0", M.summarize(empty(), { ac10_min_verified_rate: 0.9 }).ac10.verified_rate === null);
  }

  // ---- AC11 ----
  {
    const accts = Array.from({ length: 35 }, (_, i) => String(1000 + i));
    const build = (graphMs, domMs, extra) => {
      const d = empty();
      d.targets = [
        ...accts.map((a, i) => rec({ engine: "graph", ad_account_id: a, target_ms: graphMs(i), item_ms: graphMs(i) })),
        ...accts.map((a, i) => rec({ engine: "dom", ad_account_id: a, target_ms: domMs(i), item_ms: domMs(i), verify_state: null })),
        ...(extra || [])
      ];
      return d;
    };
    const fast = build(i => 1500 + i * 10, i => 9000 + i * 100);
    const a = M.summarize(fast, {}).ac11;
    ok("AC11: Graph P95 < DOM P95 trên cùng tập (35 cặp) -> PASS", a.status === "PASS" && a.common_sets === 35 && a.graph_p95_ms < a.dom_p95_ms, a);
    const slow = M.summarize(build(i => 12000, i => 9000), {}).ac11;
    ok("AC11: Graph chậm hơn DOM -> FAIL", slow.status === "FAIL", slow);
    const tie = M.summarize(build(i => 5000, i => 5000), {}).ac11;
    ok("AC11: bằng nhau không phải 'thấp hơn' -> FAIL", tie.status === "FAIL");

    // chỉ so trên phần giao: Graph có thêm 40 TKQC rất chậm mà DOM chưa chạy -> phải bị bỏ qua
    const extraSlow = Array.from({ length: 40 }, (_, i) => rec({ engine: "graph", ad_account_id: "x" + i, target_ms: 60000, item_ms: 60000 }));
    const common = M.summarize(build(i => 1500, i => 9000, extraSlow), {}).ac11;
    ok("AC11: chỉ so các (TKQC + action) có ở CẢ HAI engine; TKQC chỉ chạy bằng Graph bị loại", common.status === "PASS" && common.common_sets === 35 && common.graph_p95_ms === 1500, common);

    // khác action thì không phải cùng tập
    const d2 = empty();
    d2.targets = [...many(40, i => ({ engine: "graph", ad_account_id: String(i), action: "SHARE_USER", target_ms: 1000 })), ...many(40, i => ({ engine: "dom", ad_account_id: String(i), action: "REMOVE_SELF", target_ms: 9000, verify_state: null }))];
    ok("AC11: cùng TKQC nhưng khác action -> không có tập chung -> INSUFFICIENT_DATA", M.summarize(d2, {}).ac11.status === "INSUFFICIENT_DATA" && M.summarize(d2, {}).ac11.common_sets === 0);

    // chỉ target thành công; Retry không tính
    const d3 = build(i => 1500, i => 9000, [
      ...accts.map(a => rec({ engine: "graph", ad_account_id: a, status: "FAILED", error_code: "X", verify_state: null, target_ms: 90000, item_ms: 90000 })),
      ...accts.map(a => rec({ engine: "graph", ad_account_id: a, is_retry: true, target_ms: 90000, item_ms: 90000 }))
    ]);
    ok("AC11: target thất bại và Retry không làm lệch P95", M.summarize(d3, {}).ac11.graph_p95_ms === 1500);

    // ít mẫu
    const few = empty();
    few.targets = [...many(5, i => ({ engine: "graph", ad_account_id: String(i), target_ms: 1000 })), ...many(5, i => ({ engine: "dom", ad_account_id: String(i), target_ms: 9000, verify_state: null }))];
    ok("AC11: chỉ 5 cặp chung (< 30) -> INSUFFICIENT_DATA, kể cả khi Graph nhanh hơn", M.summarize(few, {}).ac11.status === "INSUFFICIENT_DATA");
    ok("AC11: hạ min_samples xuống 5 -> PASS", M.summarize(few, { min_samples: 5 }).ac11.status === "PASS");
    ok("AC11: chưa có dữ liệu DOM -> INSUFFICIENT_DATA", M.summarize((() => { const d = empty(); d.targets = many(50, i => ({ ad_account_id: String(i) })); return d; })(), {}).ac11.status === "INSUFFICIENT_DATA");
  }

  // ---- chỉ số vận hành docx §18.1 ----
  {
    const d = empty();
    d.targets = [rec({ action: "SHARE_USER", role: "ADMIN", method_used: "USERS", status: "SUCCESS" }), rec({ action: "SHARE_USER", role: "ADMIN", method_used: "USERS", status: "SUCCESS" }), rec({ action: "REMOVE_SELF", role: null, method_used: "USERS", status: "FAILED", verify_state: "MISMATCH" })];
    d.events = [
      { ts: 1, name: "batch_paused", reason: "RATE_LIMITED" }, { ts: 2, name: "batch_paused", reason: "RATE_LIMITED" }, { ts: 3, name: "batch_paused", reason: "FACEBOOK_CHECKPOINT" },
      { ts: 4, name: "retry", error_code: "NETWORK_ERROR", attempt: 2 }, { ts: 5, name: "token_refresh", slot: "token_b", reason: "ads_manager" }, { ts: 6, name: "token_refresh", slot: "token_b", reason: "invalidated" },
      { ts: 7, name: "rate_backoff", attempt: 1 }
    ];
    d.requests = [
      ...Array.from({ length: 20 }, (_, i) => ({ ts: i, endpoint: "/act_{id}/users", method: "POST", mutation: true, ms: (i + 1) * 100, ok: i !== 19, error_code: i === 19 ? "RATE_LIMITED" : null })),
      { ts: 99, endpoint: "/act_{id}/users", method: "GET", mutation: false, ms: 50, ok: true, error_code: null }
    ];
    const s = M.summarize(d, {});
    const find = (arr, o) => arr.find(r => Object.keys(o).every(k => r[k] === o[k]));
    ok("permission_requests_total: gom theo action / role / method / status", find(s.permission_requests_total, { action: "SHARE_USER", status: "SUCCESS", count: 2 }) && find(s.permission_requests_total, { action: "REMOVE_SELF", status: "FAILED", count: 1 }), s.permission_requests_total);
    ok("permission_verify_total: MATCH x2, MISMATCH x1", find(s.permission_verify_total, { verify_state: "MATCH", count: 2 }) && find(s.permission_verify_total, { verify_state: "MISMATCH", count: 1 }));
    ok("batch_paused_total: RATE_LIMITED x2, CHECKPOINT x1", find(s.batch_paused_total, { reason: "RATE_LIMITED", count: 2 }) && find(s.batch_paused_total, { reason: "FACEBOOK_CHECKPOINT", count: 1 }));
    ok("retry_total / token_refresh_total / rate_backoff_total", find(s.retry_total, { error_code: "NETWORK_ERROR", attempt: 2, count: 1 }) && find(s.token_refresh_total, { slot: "token_b", reason: "invalidated", count: 1 }) && s.token_refresh_total.length === 2 && find(s.rate_backoff_total, { attempt: 1, count: 1 }));
    const post = find(s.permission_duration_ms, { method: "POST", endpoint: "/act_{id}/users" });
    ok("permission_duration_ms: theo method + endpoint (P50 = 1000, P95 = 1900, 1 lỗi), GET tách riêng", post && post.count === 20 && post.p50_ms === 1000 && post.p95_ms === 1900 && post.errors === 1 && find(s.permission_duration_ms, { method: "GET", count: 1 }), s.permission_duration_ms);
  }

  // ---- kho lưu trữ ----
  {
    const writes = [];
    let stored;
    const mk = (o) => M.createStore(Object.assign({ read: async () => stored, write: async d => { writes.push(JSON.parse(JSON.stringify(d))); stored = JSON.parse(JSON.stringify(d)); }, now: () => Date.UTC(2026, 9, 13), flushDelayMs: 20 }, o));
    const st = mk();
    await st.add("targets", rec({})); await st.add("targets", rec({})); await st.add("events", { ts: 1, name: "retry" });
    ok("store: gộp nhiều lần ghi thành 1 lần (debounce)", writes.length === 0);
    await sleep(60);
    ok("store: sau khoảng debounce thì ghi đúng 1 lần, đủ dữ liệu", writes.length === 1 && writes[0].targets.length === 2 && writes[0].events.length === 1 && writes[0].since === "2026-10-13T00:00:00.000Z", writes);
    const st2 = mk();
    const snap = await st2.snapshot();
    ok("store: nạp lại dữ liệu đã lưu (service worker khởi động lại không mất số liệu)", snap.targets.length === 2);

    const cap = mk({ read: async () => undefined, write: async () => {} });
    for (let i = 0; i < M.CAPS.events + 50; i++) await cap.add("events", { ts: i, name: "x" });
    const cs = await cap.snapshot();
    ok("store: vượt giới hạn thì bỏ bản ghi CŨ NHẤT", cs.events.length === M.CAPS.events && cs.events[0].ts === 50 && cs.events[cs.events.length - 1].ts === M.CAPS.events + 49);

    const bad = mk({ read: async () => { throw new Error("storage hỏng"); }, write: async () => {} });
    ok("store: đọc kho lỗi -> bắt đầu rỗng, không ném lỗi", (await bad.snapshot()).targets.length === 0);
    const junk = mk({ read: async () => ({ targets: "oops", events: [1], requests: null, since: 5 }), write: async () => {} });
    const js = await junk.snapshot();
    ok("store: dữ liệu rác trong kho được làm sạch", Array.isArray(js.targets) && js.targets.length === 0 && Array.isArray(js.requests));

    const failing = mk({ write: async () => { throw new Error("quota"); } });
    let threw = false;
    try { await failing.add("targets", rec({})); await failing.flush(); } catch (_) { threw = true; }
    ok("store: ghi lỗi (đầy dung lượng) không ném ra ngoài làm hỏng batch", !threw);

    await st.clear();
    ok("store: clear -> rỗng và đã ghi xuống kho", (await st.snapshot()).targets.length === 0 && stored.targets.length === 0);
    const unk = mk({ read: async () => undefined, write: async () => {} });
    await unk.add("khong_co", { a: 1 });
    ok("store: kind lạ bị bỏ qua", Object.keys(await unk.snapshot()).every(k => k !== "khong_co"));
  }

  // ---- cấu hình và xuất ----
  ok("validateConfig: hợp lệ", M.validateConfig({ ac10_min_verified_rate: 0.95, min_samples: 50 }).value.min_samples === 50 && M.validateConfig({ ac10_min_verified_rate: null }).value.ac10_min_verified_rate === null);
  ok("validateConfig: từ chối giá trị sai (0, >1, chữ, số lẻ, quá lớn)", [{ ac10_min_verified_rate: 0 }, { ac10_min_verified_rate: 1.5 }, { ac10_min_verified_rate: "0.9" }, { ac10_min_verified_rate: NaN }, { min_samples: 0 }, { min_samples: 2.5 }, { min_samples: 1e9 }].every(p => !!M.validateConfig(p).error));
  ok("validateConfig: patch rỗng/không phải object không làm hỏng", Object.keys(M.validateConfig({}).value).length === 0 && !M.validateConfig(null).error);
  {
    const d = empty(); d.targets = [rec({ ad_account_id: "1234567890123456" })];
    const ex = M.exportData(d, M.summarize(d, {}));
    ok("export: ID TKQC được che ở giữa, vẫn có summary", ex.targets[0].ad_account_id === "123…456" && !JSON.stringify(ex.targets).includes("1234567890123456") && !!ex.summary.ac10);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("CRASH", e); process.exit(2); });
