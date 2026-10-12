const path = require("path");
const ROOT = process.argv[2] || path.resolve(__dirname, "..");

// chrome giả
const mem = {};
global.chrome = {
  storage: { local: {
    get: async k => {
      if (typeof k === "string") return { [k]: mem[k] };
      if (Array.isArray(k)) return Object.fromEntries(k.map(x => [x, mem[x]]));
      return { ...mem };
    },
    set: async o => { Object.assign(mem, JSON.parse(JSON.stringify(o))); },
    remove: async keys => { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete mem[k]); }
  } },
  runtime: {
    getManifest: () => ({ name: "AMIT V1", version: "1.2.3" }),
    getPlatformInfo: async () => ({ os: "win", arch: "x86-64" }),
    sendMessage: async m => { sent.push(m); }
  }
};
const sent = [];
const L = require(path.join(ROOT, "shared/logger.js"));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  -> " + JSON.stringify(extra).slice(0, 400))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FB_TOKEN = "EAABsbCS1iHgBO" + "ZBabcdefghijklmnop12345";
const OR_KEY = "sk-or-v1-abcdef1234567890abcdef";

(async () => {
  // ---- làm sạch ----
  const s = L.sanitize({ accessToken: FB_TOKEN, fb_dtsg: "AQx", apiKey: OR_KEY, cookie: "c_user=1; xs=abc", authorization: "Bearer zzz", lsd: "x",
    noAccess: true, keyHint: "…abcd", hasKey: true, ok: 1, nested: { password: "p", fine: "v" } });
  ok("sanitize: che khóa nhạy cảm theo tên", s.accessToken === "[REDACTED]" && s.fb_dtsg === "[REDACTED]" && s.apiKey === "[REDACTED]" && s.cookie === "[REDACTED]" && s.authorization === "[REDACTED]" && s.lsd === "[REDACTED]" && s.nested.password === "[REDACTED]", s);
  ok("sanitize: KHÔNG che các khóa vô hại (noAccess, keyHint, hasKey)", s.noAccess === true && s.keyHint === "…abcd" && s.hasKey === true && s.nested.fine === "v", s);
  const sb = L.sanitize({ hasToken: true, hasDtsg: false, gotToken: true, accessToken: FB_TOKEN, token: "x" });
  ok("sanitize: khóa kiểu hasToken/hasDtsg (đúng/sai) được GIỮ để chẩn đoán, còn giá trị chuỗi thì bị che", sb.hasToken === true && sb.hasDtsg === false && sb.gotToken === true && sb.accessToken === "[REDACTED]" && sb.token === "[REDACTED]", sb);
  const s2 = L.sanitize(`GET https://graph.facebook.com/v19.0/me?access_token=${FB_TOKEN}&fields=id Authorization: Bearer abc.def-123 key ${OR_KEY} ${FB_TOKEN} xs=SECRETXS`);
  ok("sanitize: che token / API key / Bearer / query access_token / cookie trong CHUỖI", !s2.includes("EAAB") && !s2.includes("sk-or-") && !s2.includes("abc.def") && !s2.includes("SECRETXS") && s2.includes("[TOKEN]") && s2.includes("[API_KEY]"), s2);
  ok("sanitize: cắt chuỗi dài, mảng dài", L.sanitize("x".repeat(2000)).length < 700 && L.sanitize(Array.from({ length: 100 }, (_, i) => i)).length === 41);
  const e = L.sanitize({ err: Object.assign(new Error("lỗi " + FB_TOKEN), { code: "X" }) });
  ok("sanitize: Error -> name/message/code/stack, token trong message bị che", e.err.name === "Error" && e.err.code === "X" && !JSON.stringify(e).includes("EAAB") && typeof e.err.stack === "string", e);
  const cyc = {}; cyc.self = cyc;
  ok("sanitize: object vòng tròn không gây treo/ném", JSON.stringify(L.sanitize(cyc)).length > 0);
  ok("capEntry: entry quá lớn bị thu gọn", L.capEntry({ ts: "t", data: { big: "y".repeat(9000) } }).data.truncated === true);

  // ---- ngữ cảnh KHÔNG phải service worker: gom rồi gửi message log_append ----
  L.init("web");
  L.info("web.click", { what: "execute", accessToken: FB_TOKEN });
  L.debug("web.debug", { n: 1 });
  L.flush();
  await sleep(20);
  const msg = sent.find(m => m.action === "log_append");
  ok("web/popup/content: gửi entry về service worker qua log_append (đã che token)", msg && msg.entries.length === 2 && msg.entries[0].ctx === "web" && msg.entries[0].ev === "web.click" && !JSON.stringify(msg).includes("EAAB"), msg);
  const before = sent.length;
  L.warn("web.warn", { x: 1 });
  await sleep(10);
  ok("warn/error được gửi ngay, không chờ gom", sent.length === before + 1 && sent[sent.length - 1].entries[0].lvl === "warn");

  // ---- service worker: ghi thẳng vào storage ----
  L.setSink(null);
  L.init("sw", { direct: true });
  L.info("sw.start", { v: 1 });
  L.debug("sw.dbg", {});
  ok("sw: debug/info được gom, chưa ghi ngay (tránh ghi liên tục)", !mem[L.KEYS.META]);
  L.warn("sw.problem", { reason: "x" });
  await L.store.flush();
  const stored = await L.readStored();
  ok("sw: warn kích hoạt ghi ngay, các entry trước đó được ghi theo thứ tự", stored.entries.map(x => x.ev).join() === "sw.start,sw.dbg,sw.problem", stored.entries.map(x => x.ev));
  ok("sw: mỗi entry có số thứ tự n tăng dần, ts ISO, ctx", stored.entries.every((x, i) => x.n === i + 1 && /^\d{4}-\d\d-\d\dT/.test(x.ts) && x.ctx === "sw"), stored.entries);

  // entry từ ngữ cảnh khác đi qua append() không tin cậy -> làm sạch lại
  await L.store.append([{ ts: new Date().toISOString(), ctx: "exec", lvl: "info", ev: "exec.x", data: { fb_dtsg: "AAA", note: `token ${FB_TOKEN}` } }]);
  await L.store.flush();
  const st2 = await L.readStored();
  const last = st2.entries[st2.entries.length - 1];
  ok("store: entry đến từ ngữ cảnh khác được làm sạch lại ở lớp lưu trữ", last.data.fb_dtsg === "[REDACTED]" && !JSON.stringify(last).includes("EAAB"), last);

  // ---- giới hạn dung lượng ----
  const many = [];
  for (let i = 0; i < L.LIMITS.chunkSize * (L.LIMITS.maxChunks + 3); i++) many.push({ ts: "t", ctx: "sw", lvl: "debug", ev: "bulk", data: { i } });
  await L.store.append(many, true);
  await L.store.flush();
  const big = await L.readStored();
  const chunkKeys = Object.keys(mem).filter(k => k.startsWith(L.KEYS.CHUNK));
  ok("giới hạn: không vượt maxChunks, chunk cũ nhất bị bỏ và được đếm vào pruned", chunkKeys.length <= L.LIMITS.maxChunks && big.meta.pruned > 0 && big.entries.length <= L.LIMITS.chunkSize * L.LIMITS.maxChunks, { chunks: chunkKeys.length, pruned: big.meta.pruned, n: big.entries.length });
  ok("giới hạn: entry mới nhất vẫn còn, thứ tự giữ nguyên", big.entries[big.entries.length - 1].n === big.meta.seq && big.entries.every((x, i, a) => i === 0 || x.n === a[i - 1].n + 1));

  // ---- file xuất ----
  const out = await L.buildLogText({ note: "Không thêm được người", header: { settings: { jev: { enabled: true, hasKey: true, apiKey: OR_KEY } } } });
  const lines = out.text.trim().split("\n");
  const header = JSON.parse(lines[1]);
  ok("file: dòng 1 là banner, dòng 2 là header JSON, còn lại mỗi entry một dòng JSON", lines[0].startsWith("# AMIT V1 LOG") && header.type === "AMIT_LOG_HEADER" && lines.slice(2).every(l => { try { JSON.parse(l); return true; } catch { return false; } }) && lines.length - 2 === out.stats.entries, lines.slice(0, 2));
  ok("file: header có version, hệ điều hành, múi giờ, ghi chú của user, số entry, số entry bị bỏ", header.extension.version === "1.2.3" && header.platform.os === "win" && header.user_note === "Không thêm được người" && header.log.entries === out.stats.entries && header.log.pruned_oldest > 0, header);
  ok("file: header không chứa API key dù trang gọi lỡ truyền vào", !out.text.includes("sk-or-") && header.settings.jev.apiKey === "[REDACTED]");
  ok("file: tên file theo mẫu AMIT-log-YYYYMMDD-HHMMSS.txt", /^AMIT-log-\d{8}-\d{6}\.txt$/.test(out.filename), out.filename);
  ok("file: toàn bộ file không chứa token / key / cookie nào", !/EAAB[A-Za-z0-9]{10,}|sk-or-v1|SECRETXS/.test(out.text));

  // ---- xóa ----
  await L.store.clear();
  const after = await L.readStored();
  ok("clear: xóa sạch log và meta", after.entries.length === 0 && Object.keys(mem).filter(k => k.startsWith("amit_log")).length === 0, Object.keys(mem));
  L.info("sw.after_clear", {});
  await L.store.flush();
  ok("clear: ghi tiếp sau khi xóa vẫn hoạt động, đánh số lại từ 1", (await L.readStored()).entries[0].n === 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("CRASH", e); process.exit(2); });
