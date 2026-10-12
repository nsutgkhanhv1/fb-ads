const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = (process.argv[2] || require("path").resolve(__dirname, ".."));
const coreSrc = fs.readFileSync(path.join(ROOT, "shared/super-share-core.js"), "utf8");
const ctrlSrc = fs.readFileSync(path.join(ROOT, "extension/batch-controller.js"), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  -> " + JSON.stringify(extra).slice(0, 500))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Dựng một "service worker" giả: chrome API giả + core + controller thật. */
function build({ cookie = "1", storage = {}, driverFor }) {
  const events = [];
  const store = { ...storage };
  let url = "about:blank";
  const listeners = new Set();
  const windows = [];
  const chrome = {
    storage: { local: {
      get: async k => (typeof k === "string" ? { [k]: store[k] } : { ...store }),
      set: async o => { Object.assign(store, JSON.parse(JSON.stringify(o))); }
    } },
    runtime: {
      sendMessage: async m => { if (m && m.batch) events.push(["BROADCAST", m.batch.processed, m.batch.status]); },
      getPlatformInfo: async () => ({})
    },
    windows: { create: async () => { const w = { id: windows.length + 1, tabs: [{ id: 10 }] }; windows.push(w); events.push(["WINDOW_OPEN"]); return w; }, remove: async () => { events.push(["WINDOW_CLOSE"]); } },
    tabs: {
      get: async id => ({ id, url }),
      update: async (id, o) => { url = o.url; events.push(["NAV", o.url]); setTimeout(() => listeners.forEach(l => l(id, { status: "complete" })), 5); },
      onUpdated: { addListener: l => listeners.add(l), removeListener: l => listeners.delete(l) },
      sendMessage: async (tabId, msg) => {
        if (msg.cmd === "PING") return { ok: true };
        if (msg.cmd === "RUN_ITEM") {
          events.push(["RUN_ITEM", msg.item.ad_account_id]);
          const drv = driverFor(msg.item, url, ctx);
          return { ok: true, result: await ctx.AmitSuperShareCore.runItem(drv, msg.item) };
        }
        if (msg.cmd === "PROBE_SELF") return { ok: true, signals: { noAccess: true } };
        return { ok: false };
      }
    },
    scripting: { executeScript: async () => {} }
  };
  const ctx = vm.createContext({ chrome, console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, JSON, Math, Error, URL });
  ctx.getFacebookCookie = async () => ctx.__cookie;
  ctx.__cookie = cookie;
  vm.runInContext(coreSrc, ctx);
  vm.runInContext(ctrlSrc, ctx);
  return { ctx, events, store, setCookie: c => { ctx.__cookie = c; }, windows,
    batch: () => vm.runInContext("currentBatch", ctx) };
}

// driver giả (một TKQC: danh sách vai trò theo actId)
function driverFactory(world) {
  return (item, url, ctx) => {
    const w = world[item.ad_account_id] || {};
    const st = w; st.__ctx = ctx;
    return {
      getSessionState: async () => (st.expired ? "EXPIRED" : "OK"),
      getSessionUid: async () => "1",
      openAccount: async id => { if (st.noAccount) { throw new (vm.runInContext("AmitSuperShareCore", st.__ctx).DriverError)("ACCOUNT_NOT_FOUND", "no"); } },
      assertContext: async () => {},
      readRoles: async () => (st.roles || [["1", "ADMIN"]]).map(r => ({ uid: r[0], name: r[0], role: r[1], roleText: r[1] })),
      addPerson: async (uid, role) => { (st.roles = st.roles || [["1", "ADMIN"]]).push([uid, role]); },
      changeRole: async () => {}, removePerson: async uid => { st.roles = st.roles.filter(r => r[0] !== uid); }, settle: async () => {},
      probeSelfRemoval: async () => ({})
    };
  };
}
const it = (id, extra) => Object.assign({ ad_account_id: id, action: "SHARE_USER", target_uids: ["5"], role: "ADMIN", executor_uid: "1" }, extra || {});
const waitFinished = async (sw, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const b = sw.batch(); if (b && b.status !== "RUNNING") return b; await sleep(50); } return sw.batch(); };

(async () => {
  // 1. Batch 3 TKQC: ok / fail / ok. Delay chỉ giữa các TKQC; kết quả báo TRƯỚC delay
  let world = { "100": {}, "200": { noAccount: true }, "300": {} };
  let sw = build({ driverFor: driverFactory(world) });
  const t0 = Date.now();
  let r = await sw.ctx.startBatch({ items: [it("100"), it("200"), it("300")], delay_seconds: 3 });
  ok("start: nhận batch hợp lệ", r.success === true && r.batch.total === 3, r);
  let b = await waitFinished(sw, 20000);
  const elapsed = (Date.now() - t0) / 1000;
  ok("batch: FINISHED, 2 success 1 failed, processed 3", b.status === "FINISHED" && b.success === 2 && b.failed === 1 && b.processed === 3, b);
  ok("batch: 1 TKQC FAILED không làm dừng batch (TKQC 300 vẫn chạy)", b.items[2].status === "SUCCESS" && b.items[1].error_code === "ACCOUNT_NOT_FOUND", b.items.map(i => i.status));
  ok("delay: đúng 2 khoảng delay (3 TKQC) ~6s, không delay sau TKQC cuối", elapsed >= 5.8 && elapsed < 9, elapsed);
  const iRun2 = sw.events.findIndex(e => e[0] === "RUN_ITEM" && e[1] === "200");
  const iBc1 = sw.events.findIndex(e => e[0] === "BROADCAST" && e[1] === 1);
  ok("progress: gửi kết quả TKQC 1 TRƯỚC khi chạy TKQC 2 (trước delay)", iBc1 !== -1 && iBc1 < iRun2, { iBc1, iRun2 });
  ok("runner: mở Ads Manager gốc 1 lần rồi tới trang settings theo act=", sw.events.filter(e => e[0] === "NAV")[0][1] === "https://adsmanager.facebook.com/" && sw.events.some(e => e[0] === "NAV" && /ad_account_settings\?act=300$/.test(e[1])));
  ok("runner: đóng cửa sổ khi xong", sw.events.some(e => e[0] === "WINDOW_CLOSE"));
  ok("store: batch được lưu bền vững", sw.store.amit_batch_current && sw.store.amit_batch_current.status === "FINISHED");

  // 2. Retry chỉ phần lỗi (TKQC 200)
  world["200"].noAccount = false;
  r = await sw.ctx.retryFailed();
  ok("retry: tạo batch mới chỉ gồm TKQC lỗi", r.success && r.batch.total === 1 && r.batch.items[0].ad_account_id === "200" && r.batch.retry_of, r);
  b = await waitFinished(sw, 15000);
  ok("retry: TKQC 200 chạy lại thành công, 100/300 không chạy lại", b.status === "FINISHED" && b.items[0].status === "SUCCESS" && sw.events.filter(e => e[0] === "RUN_ITEM" && e[1] === "100").length === 1, b);

  // 3. Hết session ở TKQC 2 -> PAUSED; resume không chạy lại TKQC đã xong
  world = { "100": {}, "200": { expired: true }, "300": {} };
  sw = build({ driverFor: driverFactory(world) });
  await sw.ctx.startBatch({ items: [it("100"), it("200"), it("300")], delay_seconds: 3 });
  b = await waitFinished(sw, 20000);
  ok("pause: SESSION_EXPIRED -> batch PAUSED, TKQC 200 PAUSED, TKQC 300 chưa chạy", b.status === "PAUSED" && b.pause_reason === "SESSION_EXPIRED" && b.items[0].status === "SUCCESS" && b.items[1].status === "PAUSED" && b.items[2].status === "PENDING", b);
  ok("pause: giữ cửa sổ runner để user đăng nhập", !sw.events.some(e => e[0] === "WINDOW_CLOSE"));
  world["200"].expired = false;
  r = await sw.ctx.resumeBatch();
  ok("resume: được chấp nhận", r.success === true, r);
  b = await waitFinished(sw, 20000);
  ok("resume: FINISHED 3/3 thành công", b.status === "FINISHED" && b.success === 3, b);
  ok("resume: TKQC 100 (đã SUCCESS) không chạy lại", sw.events.filter(e => e[0] === "RUN_ITEM" && e[1] === "100").length === 1, sw.events.filter(e => e[0] === "RUN_ITEM"));

  // 4. Chưa đăng nhập khi bắt đầu -> PAUSED ngay, không mở cửa sổ (docx §4)
  sw = build({ cookie: null, driverFor: driverFactory({}) });
  r = await sw.ctx.startBatch({ items: [it("100")], delay_seconds: 3 });
  ok("precondition: chưa login -> PAUSED SESSION_EXPIRED, không điều khiển trình duyệt", r.success && r.batch.status === "PAUSED" && r.batch.pause_reason === "SESSION_EXPIRED" && !sw.events.some(e => e[0] === "WINDOW_OPEN"), r);
  r = await sw.ctx.resumeBatch();
  ok("resume: vẫn chưa login -> từ chối", r.success === false && r.error === "SESSION_EXPIRED", r);
  sw.setCookie("1");
  r = await sw.ctx.resumeBatch();
  b = await waitFinished(sw, 15000);
  ok("resume: sau khi login -> chạy tiếp", r.success && b.status === "FINISHED" && b.success === 1, b);

  // 5. Validate input -> từ chối cả batch trước khi chạy
  sw = build({ driverFor: driverFactory({}) });
  r = await sw.ctx.startBatch({ items: [it("100"), it("200", { target_uids: ["1", "2", "3", "4"] })], delay_seconds: 3 });
  ok("validate: >3 UID -> từ chối cả batch, chưa mở trình duyệt", r.success === false && r.error === "INVALID_INPUT" && !sw.events.some(e => e[0] === "WINDOW_OPEN"), r);
  r = await sw.ctx.startBatch({ items: [], delay_seconds: 3 });
  ok("validate: batch rỗng bị từ chối", r.success === false, r);

  // 6. Không cho chạy 2 batch cùng lúc
  world = { "100": {}, "200": {} };
  sw = build({ driverFor: driverFactory(world) });
  await sw.ctx.startBatch({ items: [it("100"), it("200")], delay_seconds: 3 });
  r = await sw.ctx.startBatch({ items: [it("100")], delay_seconds: 3 });
  ok("concurrency: batch thứ 2 khi đang RUNNING bị từ chối", r.success === false && r.error === "BATCH_RUNNING", r);
  await waitFinished(sw, 15000);

  // 7. Trang lỗi cấp trang -> tải lại 1 lần rồi chạy được
  let calls = 0;
  sw = build({ driverFor: item => { const d = driverFactory({ "100": {} })(item); const orig = d.readRoles; d.readRoles = async () => { if (calls++ === 0) { throw new (vm.runInContext("AmitSuperShareCore", sw.ctx).DriverError)("PAGE_LOAD_FAILED", "lỗi tải"); } return orig(); }; return d; } });
  await sw.ctx.startBatch({ items: [it("100")], delay_seconds: 3 });
  b = await waitFinished(sw, 15000);
  ok("page-level: PAGE_LOAD_FAILED -> tải lại 1 lần rồi thành công", b.status === "FINISHED" && b.items[0].status === "SUCCESS" && sw.events.filter(e => e[0] === "NAV" && /act=100$/.test(e[1])).length === 2, { b, nav: sw.events.filter(e => e[0] === "NAV") });

  // 8. Service worker bị tắt giữa chừng -> khôi phục PAUSED, không chạy lại item xong
  const saved = { amit_batch_current: { id: "b", status: "RUNNING", pause_reason: null, delay_seconds: 3, total: 2, processed: 1, success: 1, failed: 0,
    items: [{ ad_account_id: "100", action: "SHARE_USER", status: "SUCCESS", target_uids: ["5"], targets: [] }, { ad_account_id: "200", action: "SHARE_USER", status: "RUNNING", target_uids: ["5"], targets: [] }] } };
  sw = build({ storage: saved, driverFor: driverFactory({ "100": {}, "200": {} }) });
  await vm.runInContext("batchReady", sw.ctx);
  b = sw.batch();
  ok("restart: batch RUNNING -> PAUSED EXTENSION_RESTARTED, item RUNNING -> PAUSED", b.status === "PAUSED" && b.pause_reason === "EXTENSION_RESTARTED" && b.items[1].status === "PAUSED", b);
  r = await sw.ctx.resumeBatch();
  b = await waitFinished(sw, 15000);
  ok("restart: resume chỉ chạy TKQC chưa xong", b.status === "FINISHED" && sw.events.filter(e => e[0] === "RUN_ITEM").map(e => e[1]).join() === "200", sw.events.filter(e => e[0] === "RUN_ITEM"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("CRASH", e); process.exit(2); });
