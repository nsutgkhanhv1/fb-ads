/**
 * Kiểm tra tính năng LOG đầu-cuối:
 *  A. Executor (trang giả jsdom): ghi đủ sự kiện, che tên người, không lộ token/key.
 *  B. Controller + kho log thật: ghi đủ vòng đời batch, kết quả từng TKQC, lỗi; file xuất ra đọc được và sạch bí mật.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = process.argv[2] || path.resolve(__dirname, "..");
const { makeSetup } = require("./helpers/fake-ads-page.js");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  -> " + JSON.stringify(extra).slice(0, 500))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FB_TOKEN = "EAABsbCS1iHgBO" + "ZBabcdefghijklmnop12345";
const OR_KEY = "sk-or-v1-abcdef1234567890abcdef";
const SECRET_RE = /EAAB[A-Za-z0-9]{10,}|sk-or-v1-[A-Za-z0-9]{6,}|fb_dtsg"?:\s*"[A-Za-z0-9]/;

const { setup } = makeSetup(ROOT, { withLogger: true });
const U = (uid, name, role) => ({ uid, name, role });
const NAMES = ["Nguyen Van Bi Mat", "Tran Thi Rieng Tu", "Le Van Ca Nhan", "Via Chinh Chu"];
const base = () => [U("1", NAMES[3], "ADMIN"), U("2", NAMES[0], "ADMIN"), U("3", NAMES[1], "ADVERTISER"), U("4", NAMES[2], "ANALYST")];
const item = (action, extra) => Object.assign({ ad_account_id: "1288013719961305", action, executor_uid: "1" }, extra || {});
const evs = w => w.__logs.map(e => e.ev);
const has = (w, ev) => w.__logs.some(e => e.ev === ev);

(async () => {
  // =============== A. EXECUTOR ===============
  let { w, I, C } = await setup({ users: base() });
  const resp = await new Promise(res => w.__listener({ target: "AMIT_EXECUTOR", cmd: "RUN_ITEM", item: item("REMOVE_BY_UID_EXCEPT_SELF", { target_uids: ["3"] }) }, null, res));
  ok("exec: chạy item thành công qua message handler", resp.ok && resp.result.status === "SUCCESS", resp);
  const text = JSON.stringify(w.__logs);
  ok("exec: ghi đủ vòng đời: cmd, page.snapshot, core.item.start, core.step, driver.*, core.target, core.item.end",
    ["exec.cmd", "exec.page.snapshot", "exec.core.item.start", "exec.core.step", "exec.driver.openAccount", "exec.driver.readRoles.ok", "exec.driver.removePerson.ok", "exec.core.target", "exec.core.item.end"].every(e => has(w, e)), evs(w).filter((e, i, a) => a.indexOf(e) === i));
  ok("exec: log từng click (nhãn control) và quyết định xóa", has(w, "exec.click") && has(w, "exec.remove.control") && has(w, "exec.core.remove.decision"));
  const readOk = w.__logs.find(e => e.ev === "exec.driver.readRoles.ok");
  ok("exec: readRoles ghi UID + role của từng dòng", readOk.data.result.count >= 3 && readOk.data.result.roles.some(r => r.uid === "3" && r.role === "ADVERTISER"), readOk.data);
  ok("exec: KHÔNG lộ tên người dùng (kể cả trong snapshot, nhãn click, chẩn đoán)", NAMES.every(n => !text.includes(n)), NAMES.filter(n => text.includes(n)));
  ok("exec: link profile được ghi là <profile link>, tên được che thành <name>", text.includes("<profile link>") || text.includes("<name>"));
  ok("exec: mọi entry có ts ISO, ctx, lvl, ev", w.__logs.every(e => /^\d{4}-\d\d-\d\dT/.test(e.ts) && e.ctx && e.lvl && e.ev));

  // lỗi UI: chẩn đoán đi vào log
  ({ w, I, C } = await setup({ users: base(), mode: "nouid" }));
  await C.runItem(I.driver, item("REMOVE_ALL_EXCEPT_SELF"), { log: (l, e, d) => w.AmitLog[l]("exec." + e, d) });
  const bad = w.__logs.find(e => e.ev === "exec.driver.readRoles.error");
  ok("exec: lỗi UI ghi mã lỗi + chẩn đoán (headings, controls) để dev chỉnh selector", bad && bad.lvl === "warn" && bad.data.code === "UI_VARIANT_UNKNOWN" && bad.data.detail && bad.data.detail.headings && bad.data.detail.controls, bad);
  ok("exec: core.item.error được ghi mức error kèm bước", w.__logs.some(e => e.ev === "exec.core.item.error" && e.lvl === "error" && e.data.step === "READ_STATE"));
  ok("exec: lỗi của item nhưng tên vẫn không lộ", NAMES.every(n => !JSON.stringify(w.__logs).includes(n)));

  // Jev được dùng: ghi nhận, không lộ tên
  ({ w, I, C } = await setup({ users: base(), addLabel: "Mời thêm thành viên" }));
  w.AmitJev = { resolve: async req => ({ index: req.candidates.find(c => c.label === "Mời thêm thành viên").index, confidence: 0.95 }) };
  await C.runItem(I.driver, item("SHARE_USER", { target_uids: ["50"] }), { log: (l, e, d) => w.AmitLog[l]("exec." + e, d) });
  ok("exec: lần dùng Jev được ghi (jev.chosen) kèm bước và confidence", w.__logs.some(e => e.ev === "exec.jev.chosen" && e.data.step === "ADD_PEOPLE" && e.data.confidence === 0.95));
  ok("exec: Add People ghi kết quả tìm kiếm (số kết quả có UID) và add.submitted", has(w, "exec.add.search_result") && has(w, "exec.add.submitted"));

  // =============== B. CONTROLLER + KHO LOG THẬT ===============
  const mem = {};
  const events = [];
  let url = "about:blank";
  const listeners = new Set();
  const chrome = {
    storage: { local: {
      get: async k => (typeof k === "string" ? { [k]: mem[k] } : Array.isArray(k) ? Object.fromEntries(k.map(x => [x, mem[x]])) : { ...mem }),
      set: async o => { Object.assign(mem, JSON.parse(JSON.stringify(o))); },
      remove: async keys => { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete mem[k]); }
    } },
    runtime: { sendMessage: async () => {}, getPlatformInfo: async () => ({ os: "win" }), getManifest: () => ({ name: "AMIT V1", version: "9.9.9" }) },
    windows: { create: async () => ({ id: 1, tabs: [{ id: 10 }] }), remove: async () => {} },
    tabs: {
      get: async id => ({ id, url }),
      update: async (id, o) => { url = o.url; setTimeout(() => listeners.forEach(l => l(id, { status: "complete" })), 5); },
      onUpdated: { addListener: l => listeners.add(l), removeListener: l => listeners.delete(l) },
      sendMessage: async (tabId, msg) => {
        if (msg.cmd === "PING") return { ok: true, url, session: "OK", uid: "1" };
        if (msg.cmd === "RUN_ITEM") {
          const acc = msg.item.ad_account_id;
          if (acc === "200") return { ok: true, result: failedItem(msg.item, "DESTINATION_NOT_FOUND", "Không tìm thấy UID " + FB_TOKEN) };
          if (acc === "300" && !events.includes("expired_once")) { events.push("expired_once"); return { ok: true, result: pausedItem(msg.item) }; }
          return { ok: true, result: okItem(msg.item) };
        }
        return { ok: false };
      }
    },
    scripting: { executeScript: async () => {} }
  };
  const ctx = vm.createContext({ chrome, console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, JSON, Math, Error, URL, AbortController, Intl, navigator: { userAgent: "TestBrowser/1.0", language: "vi" } });
  ctx.getFacebookCookie = async () => "1";
  ["shared/logger.js", "shared/super-share-core.js", "extension/batch-controller.js"].forEach(f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f }));
  vm.runInContext('AmitLog.init("sw", { direct: true });', ctx);
  const Core = vm.runInContext("AmitSuperShareCore", ctx);
  const mk = (it, status, extra) => Object.assign(Core.newItemResult(Core.normalizeItem(it)), { status, started_at: "t0", finished_at: "t1" }, extra);
  function okItem(it) { const r = mk(it, "SUCCESS"); r.targets = (it.target_uids || []).map(u => ({ uid: u, status: "SUCCESS", note: "ADDED" })); return r; }
  function failedItem(it, code, msg) { const r = mk(it, "FAILED", { error_code: code, error_message: msg, step: "FIND_USER", failed_uid: (it.target_uids || [])[0] }); r.targets = (it.target_uids || []).map(u => ({ uid: u, status: "FAILED", error_code: code, error_message: msg })); return r; }
  function pausedItem(it) { return mk(it, "PAUSED", { error_code: "SESSION_EXPIRED", error_message: "Facebook yêu cầu đăng nhập lại.", step: "SESSION" }); }
  const mkItem = id => ({ ad_account_id: id, action: "SHARE_USER", target_uids: ["555"], role: "ADMIN", executor_uid: "1" });
  const waitStatus = async (target, ms) => { const end = Date.now() + ms; for (;;) { const b = vm.runInContext("currentBatch", ctx); if (b && target.includes(b.status)) return b; if (Date.now() > end) return b; await sleep(50); } };

  await vm.runInContext("batchReady", ctx);
  await vm.runInContext(`startBatch({ items: ${JSON.stringify([mkItem("100"), mkItem("200"), mkItem("300")])}, delay_seconds: 3 })`, ctx);
  let b = await waitStatus(["PAUSED", "FINISHED"], 20000);
  ok("ctrl: batch dừng PAUSED ở TKQC 300 (SESSION_EXPIRED)", b.status === "PAUSED" && b.pause_reason === "SESSION_EXPIRED", b);
  await vm.runInContext("resumeBatch()", ctx);
  b = await waitStatus(["FINISHED"], 20000);
  ok("ctrl: resume xong batch", b.status === "FINISHED", b.status);

  await vm.runInContext("AmitLog.store.flush()", ctx);
  const { text: fileText, filename, stats } = await vm.runInContext('AmitLog.buildLogText({ note: "Test: user ghi chú", header: { settings: { jev: { enabled: true, hasKey: true, apiKey: "' + OR_KEY + '" } } } })', ctx);
  const lines = fileText.trim().split("\n");
  const entries = lines.slice(2).map(l => JSON.parse(l));
  const evList = entries.map(e => e.ev);
  const need = ["batch.created", "batch.loop.start", "item.start", "item.finish", "runner.window.created", "runner.navigate.start", "runner.navigate.done", "runner.inject.ready", "runner.exec.reply", "batch.delay", "batch.paused", "batch.resume", "batch.finished", "batch.commit"];
  ok("file: có đủ sự kiện vòng đời batch / runner / delay / pause / resume / finish", need.every(e => evList.includes(e)), need.filter(e => !evList.includes(e)));
  const fin200 = entries.find(e => e.ev === "item.finish" && e.data.ad_account_id === "200");
  ok("file: item.finish của TKQC lỗi ghi mã lỗi, bước, UID lỗi, từng target", fin200 && fin200.lvl === "warn" && fin200.data.error_code === "DESTINATION_NOT_FOUND" && fin200.data.step === "FIND_USER" && fin200.data.failed_uid === "555" && fin200.data.targets[0].status === "FAILED", fin200);
  const created = entries.find(e => e.ev === "batch.created");
  ok("file: batch.created ghi action, role, UID, danh sách TKQC, delay", created.data.action === "SHARE_USER" && created.data.role === "ADMIN" && created.data.target_uids[0] === "555" && created.data.accounts.length === 3 && created.data.delay_seconds === 3, created.data);
  ok("file: item.finish của TKQC bị tạm dừng ghi mức warn + SESSION_EXPIRED", entries.some(e => e.ev === "item.finish" && e.data.status === "PAUSED" && e.data.error_code === "SESSION_EXPIRED"));
  ok("file: thứ tự thời gian tăng dần và số thứ tự n liên tục", entries.every((e, i, a) => i === 0 || (e.n === a[i - 1].n + 1 && e.ts >= a[i - 1].ts)));
  const header = JSON.parse(lines[1]);
  ok("file: header có version, UA, ghi chú của user, số entry khớp", header.extension.version === "9.9.9" && header.browser.ua === "TestBrowser/1.0" && header.user_note === "Test: user ghi chú" && header.log.entries === entries.length && header.log.by_level.warn >= 1, header);
  ok("file: TOÀN BỘ file không chứa token Facebook / OpenRouter key (kể cả khi lỡ nằm trong thông báo lỗi hay header)", !SECRET_RE.test(fileText) && !fileText.includes(FB_TOKEN) && !fileText.includes(OR_KEY), fileText.match(SECRET_RE));
  ok("file: thông báo lỗi chứa token bị che thành [TOKEN]", fin200.data.error_message.includes("[TOKEN]") && !fin200.data.error_message.includes("EAAB"), fin200.data.error_message);
  ok("file: tên file đúng mẫu", /^AMIT-log-\d{8}-\d{6}\.txt$/.test(filename), filename);

  // Controller vẫn hoạt động khi logger không có (không làm hỏng luồng chạy)
  const ctx2 = vm.createContext({ chrome, console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, JSON, Math, Error, URL });
  ctx2.getFacebookCookie = async () => "1";
  ["shared/super-share-core.js", "extension/batch-controller.js"].forEach(f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx2, { filename: f }));
  await vm.runInContext("batchReady", ctx2);
  const r2 = await vm.runInContext(`startBatch({ items: ${JSON.stringify([mkItem("100")])}, delay_seconds: 3 })`, ctx2);
  ok("ctrl: không có logger vẫn chạy bình thường (log không bao giờ làm hỏng luồng)", r2.success === true, r2);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("CRASH", e); process.exit(2); });
