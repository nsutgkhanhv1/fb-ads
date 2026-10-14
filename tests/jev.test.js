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

  // =========================================================
  // JEV = model "decisions": POST /api/alpha/decisions (không dùng chat/completions)
  // =========================================================
  const DEC_URL = "https://openrouter.ai/api/alpha/decisions";
  const decFetch = (answer, status) => async (url, opts) => {
    decFetch.calls.push({ url, opts, body: JSON.parse(opts.body) });
    return { ok: (status || 200) < 400, status: status || 200, json: async () => ({ id: "gen-dec-1", model: "typesafe/jev-1.13-20260917", provider: "TypeSafe", answers: { control: answer }, usage: { input_tokens: 10, output_tokens: 2 } }) };
  };
  decFetch.calls = [];
  const errFetch = (status, message) => async () => ({ ok: false, status, json: async () => ({ error: { code: status, message } }) });

  // --- chọn endpoint theo tên model ---
  ok("isDecisionsModel: jev-latest, ~typesafe/jev-latest, typesafe/jev-1.13[-ngày] là decisions",
    ["jev-latest", "~typesafe/jev-latest", "typesafe/jev-latest", "typesafe/jev-1.13", "typesafe/jev-1.13-20260917"].every(J.isDecisionsModel));
  ok("isDecisionsModel: model chat (gpt-4o-mini, claude, typesafe/jev-router) KHÔNG phải decisions",
    !["openai/gpt-4o-mini", "anthropic/claude-x", "typesafe/jev-router", "", undefined, "my-jev-latest-clone/foo"].some(J.isDecisionsModel));
  ok("mặc định cho cài đặt mới là model Jev (decisions)", J.isDecisionsModel(J.JEV_DEFAULTS.model), J.JEV_DEFAULTS.model);

  // --- dựng request ---
  const dreq = J.buildDecisionsRequest({ step: "ADD_PEOPLE", goal: "Locate Add people", candidates: [
    { index: 0, tag: "button", role: null, label: "Hủy" },
    { index: 1, tag: "button", role: "menuitem", label: "Thêm người 100058927816176 a@b.com", html: "<script>secret</script>", token: "EAAB123" }
  ] }, "~typesafe/jev-latest", 40);
  const q = dreq.questions.control;
  ok("decisions body: model, state{step,goal}, MỘT câu hỏi kiểu choice", dreq.model === "~typesafe/jev-latest" && dreq.state.goal === "Locate Add people" && dreq.state.step === "ADD_PEOPLE" && Object.keys(dreq.questions).join() === "control" && q.type === "choice" && typeof q.instructions === "string", dreq);
  ok("decisions body: mỗi candidate là lựa chọn c<index> + 'none'; nhãn đã che số dài/email; không HTML/token", Object.keys(q.criteria).join() === "c0,c1,none" && q.criteria.c1.includes("role: menuitem") && q.criteria.c1.includes("Thêm người # <email>") && !JSON.stringify(dreq).match(/secret|EAAB|100058927816176|a@b\.com/), q.criteria);
  ok("decisions body: có luật cấm chọn Hủy/Đóng và cấm quyết định nghiệp vụ; không có messages/temperature", /cancel, close/i.test(q.instructions) && /only locate controls/i.test(q.instructions) && !("messages" in dreq) && !("temperature" in dreq));

  // --- parse ---
  const pc = (a, n) => J.parseDecisionsResponse({ answers: { control: a } }, n == null ? 3 : n);
  ok("decisions parse: choice c1 + confidence", JSON.stringify(pc({ type: "choice", choice: "c1", confidence: 0.93, probabilities: { c1: 0.9 } })) === '{"index":1,"confidence":0.93}');
  ok("decisions parse: 'none' = Jev không chọn (index null)", pc({ type: "choice", choice: "none", confidence: 0.7 }).index === null);
  ok("decisions parse: thiếu confidence thì dùng xác suất của lựa chọn; thiếu cả hai -> bỏ (không bịa)", pc({ type: "choice", choice: "c2", probabilities: { c2: 0.88 } }).confidence === 0.88 && pc({ type: "choice", choice: "c2" }) === null);
  ok("decisions parse: confidence được kẹp về 0..1", pc({ type: "choice", choice: "c0", confidence: 4 }).confidence === 1);
  ok("decisions parse: choice lạ / ngoài phạm vi / sai kiểu / thiếu answers -> bỏ",
    pc({ type: "choice", choice: "c9", confidence: 1 }) === null && pc({ type: "choice", choice: "x1", confidence: 1 }) === null && pc({ type: "choice", choice: "c-1", confidence: 1 }) === null
    && pc({ type: "score", score: 1, confidence: 1 }) === null && pc({ type: "noul", noul: 0.9 }) === null && J.parseDecisionsResponse({}, 3) === null && J.parseDecisionsResponse(null, 3) === null);

  // --- gọi thật (fetch giả) ---
  await J.saveJevConfig({ enabled: true, apiKey: KEY, model: "jev-latest" });
  decFetch.calls.length = 0;
  const dr = await J.jevResolve({ step: "ADD_PEOPLE", goal: "Locate Add people", candidates: cands }, decFetch({ type: "choice", choice: "c1", confidence: 0.95, probabilities: { c0: 0.02, c1: 0.95, none: 0.03 } }));
  const dc = decFetch.calls[0];
  ok("decisions resolve: model jev-latest -> POST /api/alpha/decisions, KHÔNG chat/completions", dr.ok && dc && dc.url === DEC_URL && decFetch.calls.length === 1 && dr.mode === "decisions", { url: dc && dc.url, dr });
  ok("decisions resolve: trả index + confidence; model thực tế lấy từ phản hồi", dr.index === 1 && dr.confidence === 0.95 && dr.model === "typesafe/jev-1.13-20260917", dr);
  ok("decisions resolve: Bearer key, JSON, body gửi đúng model đã cấu hình; kết quả không chứa key", dc.opts.headers.Authorization === `Bearer ${KEY}` && dc.opts.headers["Content-Type"] === "application/json" && dc.body.model === "jev-latest" && dc.opts.method === "POST" && !JSON.stringify(dr).includes("SECRETKEY"));
  const dn = await J.jevResolve({ goal: "g", candidates: cands }, decFetch({ type: "choice", choice: "none", confidence: 0.8 }));
  ok("decisions resolve: 'none' -> ok, index null (executor sẽ coi là không tìm thấy)", dn.ok && dn.index === null && dn.confidence === 0.8, dn);
  ok("decisions resolve: phản hồi sai hình dạng -> BAD_RESPONSE", (await J.jevResolve({ goal: "g", candidates: cands }, decFetch({ type: "choice", choice: "c7", confidence: 1 }))).reason === "BAD_RESPONSE");
  ok("decisions resolve: lỗi mạng -> NETWORK_ERROR, không ném", (await J.jevResolve({ goal: "g", candidates: cands }, async () => { throw new Error("boom"); })).reason === "NETWORK_ERROR");
  ok("decisions resolve: quá nhiều candidate vẫn bị từ chối trước khi gọi mạng", (await J.jevResolve({ goal: "g", candidates: Array.from({ length: 41 }, (_, i) => ({ index: i, tag: "a", label: "x" })) }, async () => { throw new Error("không được gọi"); })).reason === "TOO_MANY_CANDIDATES");

  // --- lý do lỗi thật được hiển thị ---
  const e400 = await J.jevResolve({ goal: "g", candidates: cands }, errFetch(400, "Invalid request parameters: questions.control.criteria"));
  ok("lỗi 400: hiện lý do thật từ OpenRouter (không chỉ 'lỗi 400')", e400.reason === "HTTP_400" && e400.message.includes("Invalid request parameters"), e400);
  ok("lỗi 401 / 402 có thông báo riêng", (await J.jevResolve({ goal: "g", candidates: cands }, errFetch(401, "x"))).message === "API key không hợp lệ." && (await J.jevResolve({ goal: "g", candidates: cands }, errFetch(402, "x"))).message.includes("hết credit"));
  const longMsg = await J.jevResolve({ goal: "g", candidates: cands }, errFetch(500, "x".repeat(900)));
  ok("lỗi: thông báo được cắt gọn (<= 200 ký tự lý do)", longMsg.message.length < 260, longMsg.message.length);
  ok("lỗi: body lỗi không phải JSON vẫn ra thông báo, không ném", (await J.jevResolve({ goal: "g", candidates: cands }, async () => ({ ok: false, status: 502, json: async () => { throw new Error("html"); } }))).message === "OpenRouter trả lỗi 502.");

  // --- tự chuyển endpoint khi OpenRouter báo 'decisions model' ---
  await J.saveJevConfig({ model: "acme/futuristic-1" }); // tên không khớp mẫu nhưng thực ra là model decisions
  const seen = [];
  const switching = async (url, opts) => {
    seen.push(url);
    if (url === J.OPENROUTER_URL) return { ok: false, status: 400, json: async () => ({ error: { message: "acme/futuristic-1 is a decisions model and cannot be used with the chat/completions endpoint. Use the /api/alpha/decisions endpoint instead." } }) };
    return { ok: true, status: 200, json: async () => ({ model: "acme/futuristic-1", answers: { control: { type: "choice", choice: "c0", confidence: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } }) };
  };
  const sw1 = await J.jevResolve({ goal: "g", candidates: cands }, switching);
  ok("tự chuyển: chat báo 'is a decisions model' -> gọi lại bằng /api/alpha/decisions và thành công", sw1.ok && sw1.index === 0 && sw1.mode === "decisions" && seen.join() === `${J.OPENROUTER_URL},${DEC_URL}`, { sw1, seen });
  seen.length = 0;
  const sw2 = await J.jevResolve({ goal: "g", candidates: cands }, switching);
  ok("tự chuyển: lần sau đi thẳng decisions (đã nhớ), không gọi chat nữa", sw2.ok && seen.join() === DEC_URL, seen);
  seen.length = 0;
  const nl = await J.jevResolve({ goal: "g", candidates: cands }, async url => { seen.push(url); return { ok: false, status: 400, json: async () => ({ error: { message: "model not found" } }) }; });
  ok("lỗi 400 khác không gây chuyển endpoint, không lặp vô hạn", nl.reason === "HTTP_400" && seen.length === 1);
  await J.saveJevConfig({ model: "m/y" });
  seen.length = 0;
  await J.jevResolve({ goal: "g", candidates: cands }, okFetch('{"index": 1, "confidence": 0.9}'));
  ok("model chat khác vẫn đi chat/completions như cũ", okFetch.last.url === J.OPENROUTER_URL);

  // --- Kiểm tra kết nối (nút trong popup) với model decisions ---
  await J.saveJevConfig({ model: "~typesafe/jev-latest" });
  decFetch.calls.length = 0;
  const jt = await J.jevTest(decFetch({ type: "choice", choice: "c1", confidence: 0.99 }));
  ok("jevTest với Jev: gọi decisions, đáp án 'Add people' đúng -> passed", jt.ok && jt.passed === true && decFetch.calls[0].url === DEC_URL && decFetch.calls[0].body.model === "~typesafe/jev-latest", jt);
  const jt2 = await J.jevTest(decFetch({ type: "choice", choice: "c0", confidence: 0.99 }));
  ok("jevTest với Jev: đáp án sai -> passed=false", jt2.ok && jt2.passed === false);
  await J.saveJevConfig({ model: "m/y" });

  // --- xóa key ---
  r = await J.saveJevConfig({ clearKey: true, enabled: false });
  ok("xóa key: không còn key trong storage", r.ok && mem[J.JEV_CONFIG_KEY].apiKey === "" && r.config.hasKey === false, r);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("CRASH", e); process.exit(2); });
