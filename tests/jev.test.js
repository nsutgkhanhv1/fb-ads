const path = require("path");
const ROOT = process.argv[2] || path.resolve(__dirname, "..");

// chrome.storage giả (service worker)
const mem = {};
global.chrome = { storage: { local: {
  get: async k => (typeof k === "string" ? { [k]: mem[k] } : { ...mem }),
  set: async o => { Object.assign(mem, JSON.parse(JSON.stringify(o))); }
} } };
const J = require(path.join(ROOT, "extension/jev.js"));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  -> " + JSON.stringify(extra).slice(0, 400))); };
const KEY = "sk-or-v1-SECRETKEY1234567890abcd";
const cands = [{ index: 0, tag: "button", role: null, label: "Hủy" }, { index: 1, tag: "button", role: null, label: "Thêm người" }];
const okFetch = (content, status) => async (url, opts) => {
  okFetch.last = { url, opts, body: JSON.parse(opts.body) };
  return { ok: (status || 200) < 400, status: status || 200, json: async () => ({ model: "m/x", choices: [{ message: { content } }] }) };
};

(async () => {
  // --- sanitize / build ---
  ok("sanitize: che dãy số >= 6 chữ số và email, cắt 60 ký tự",
    J.jevSanitizeLabel("Nguyen 100058927816176 a@b.com") === "Nguyen # <email>" && J.jevSanitizeLabel("x".repeat(100)).length === 60, J.jevSanitizeLabel("Nguyen 100058927816176 a@b.com"));
  const msgs = J.buildJevMessages({ step: "ADD_PEOPLE", goal: "Locate Add people", candidates: [{ index: 0, tag: "button", label: "Via 100058927816176", html: "<script>secret</script>", token: "EAAB123" }] }, 40);
  const userMsg = msgs[1].content;
  ok("build: chỉ gồm goal + tag/role/label; không HTML/token; số dài bị che", !userMsg.includes("secret") && !userMsg.includes("EAAB") && !userMsg.includes("100058927816176") && userMsg.includes("Locate Add people"), userMsg);
  ok("build: system prompt cấm Jev quyết định nghiệp vụ và cấm chọn Hủy/Đóng", /never decide business logic/i.test(msgs[0].content) && /cancel, close/i.test(msgs[0].content));

  // --- parse ---
  ok("parse: JSON hợp lệ", JSON.stringify(J.parseJevResponse('{"index": 1, "confidence": 0.9}', 3)) === '{"index":1,"confidence":0.9}');
  ok("parse: có chữ thừa quanh JSON", J.parseJevResponse('Sure! {"index": 2, "confidence": 0.85} done', 3).index === 2);
  ok("parse: index null = Jev không chọn", J.parseJevResponse('{"index": null, "confidence": 0.2}', 3).index === null);
  ok("parse: index ngoài phạm vi / không nguyên -> bỏ", J.parseJevResponse('{"index": 5, "confidence": 1}', 3) === null && J.parseJevResponse('{"index": 1.5, "confidence": 1}', 3) === null && J.parseJevResponse('{"index": -1, "confidence": 1}', 3) === null);
  ok("parse: thiếu confidence / không phải JSON -> bỏ", J.parseJevResponse('{"index": 1}', 3) === null && J.parseJevResponse("no json", 3) === null && J.parseJevResponse(undefined, 3) === null);
  ok("parse: confidence được kẹp về 0..1", J.parseJevResponse('{"index": 0, "confidence": 7}', 3).confidence === 1);

  // --- cấu hình ---
  let r = await J.saveJevConfig({ enabled: true });
  ok("config: bật Jev khi chưa có key bị từ chối", r.ok === false, r);
  r = await J.saveJevConfig({ enabled: true, apiKey: `  ${KEY}  `, model: "anthropic/claude-x" });
  ok("config: lưu key + model; kết quả trả về KHÔNG chứa key", r.ok && r.config.hasKey && r.config.keyHint === "…abcd" && r.config.model === "anthropic/claude-x" && !JSON.stringify(r).includes("SECRETKEY"), r);
  ok("config: key được lưu trong storage (chỉ service worker đọc)", mem[J.JEV_CONFIG_KEY].apiKey === KEY);
  r = await J.saveJevConfig({ apiKey: "", model: "m/y" });
  ok("config: apiKey rỗng = giữ key cũ", (await J.getJevConfig()).apiKey === KEY && (await J.getJevConfig()).model === "m/y");
  ok("config: publicJevConfig không lộ key", !JSON.stringify(J.publicJevConfig(await J.getJevConfig())).includes("SECRETKEY"));

  // --- resolve ---
  const resp = await J.jevResolve({ step: "ADD_PEOPLE", goal: "Locate Add people", candidates: cands }, okFetch('{"index": 1, "confidence": 0.93}'));
  ok("resolve: trả index + confidence", resp.ok && resp.index === 1 && resp.confidence === 0.93, resp);
  const sent = okFetch.last;
  ok("resolve: gọi đúng OpenRouter, Bearer key, model, temperature 0", sent.url === "https://openrouter.ai/api/v1/chat/completions" && sent.opts.headers.Authorization === `Bearer ${KEY}` && sent.body.model === "m/y" && sent.body.temperature === 0 && sent.opts.method === "POST", { url: sent.url, model: sent.body.model });
  ok("resolve: kết quả trả về không chứa key", !JSON.stringify(resp).includes("SECRETKEY"));
  ok("resolve: HTTP 401 -> lỗi key, không ném", (await J.jevResolve({ goal: "g", candidates: cands }, okFetch("", 401))).message === "API key không hợp lệ.");
  ok("resolve: phản hồi không phải JSON -> BAD_RESPONSE", (await J.jevResolve({ goal: "g", candidates: cands }, okFetch("xin chào"))).reason === "BAD_RESPONSE");
  ok("resolve: lỗi mạng -> NETWORK_ERROR (không ném)", (await J.jevResolve({ goal: "g", candidates: cands }, async () => { throw new Error("boom"); })).reason === "NETWORK_ERROR");
  ok("resolve: request sai (không goal / không candidate) -> BAD_REQUEST", (await J.jevResolve({ candidates: cands }, okFetch("{}"))).reason === "BAD_REQUEST" && (await J.jevResolve({ goal: "g", candidates: [] }, okFetch("{}"))).reason === "BAD_REQUEST");
  ok("resolve: quá nhiều candidate -> từ chối, không gọi mạng", (await J.jevResolve({ goal: "g", candidates: Array.from({ length: 41 }, (_, i) => ({ index: i, tag: "a", label: "x" })) }, async () => { throw new Error("không được gọi"); })).reason === "TOO_MANY_CANDIDATES");

  // timeout (rút ngắn)
  mem[J.JEV_CONFIG_KEY].timeoutMs = 50;
  const to = await J.jevResolve({ goal: "g", candidates: cands }, (url, opts) => new Promise((_, rej) => opts.signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; rej(e); })));
  ok("resolve: quá thời gian -> TIMEOUT", to.reason === "TIMEOUT", to);
  delete mem[J.JEV_CONFIG_KEY].timeoutMs;

  // --- tắt Jev ---
  r = await J.saveJevConfig({ enabled: false });
  let called = false;
  const off = await J.jevResolve({ goal: "g", candidates: cands }, async () => { called = true; });
  ok("tắt Jev: không gọi mạng, trả JEV_DISABLED", off.ok === false && off.reason === "JEV_DISABLED" && !called, off);

  // --- test kết nối ---
  await J.saveJevConfig({ enabled: true });
  const t1 = await J.jevTest(okFetch('{"index": 1, "confidence": 0.99}'));
  const t2 = await J.jevTest(okFetch('{"index": 0, "confidence": 0.99}'));
  ok("jevTest: đáp án đúng -> passed; đáp án sai -> passed=false", t1.ok && t1.passed === true && t2.ok && t2.passed === false, { t1, t2 });

  // --- xóa key ---
  r = await J.saveJevConfig({ clearKey: true, enabled: false });
  ok("xóa key: không còn key trong storage", r.ok && mem[J.JEV_CONFIG_KEY].apiKey === "" && r.config.hasKey === false, r);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("CRASH", e); process.exit(2); });
