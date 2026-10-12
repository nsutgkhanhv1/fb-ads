/**
 * AMIT V1 - Logger (ghi lại mọi hành động / kết quả / lỗi để user gửi lại cho dev)
 *
 * Dùng ở MỌI ngữ cảnh: service worker, content script (executor), popup, web, trang log.
 *   AmitLog.info("batch.start", { items: 3 });   // lvl: debug | info | warn | error
 *
 * - Service worker (ctx "sw") là nơi DUY NHẤT ghi vào chrome.storage.local (chunk, có giới hạn dung lượng).
 *   Các ngữ cảnh khác gom entry rồi gửi message { action: "log_append" } tới service worker.
 * - Mọi entry đều được làm sạch: khóa nhạy cảm bị che, chuỗi giống token / API key bị che, chuỗi dài bị cắt.
 *   KHÔNG BAO GIỜ ghi access token, fb_dtsg, cookie, OpenRouter API key.
 * - Xuất file: AmitLog.buildLogText({ note }) -> một file text: 1 dòng banner + 1 dòng header JSON + mỗi entry 1 dòng JSON.
 */
(function (root) {
  "use strict";
  if (root.AmitLog && root.AmitLog.__loaded) return;

  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
  const LIMITS = {
    str: 600,          // ký tự tối đa mỗi chuỗi
    arr: 40,           // phần tử tối đa mỗi mảng
    keys: 40,          // khóa tối đa mỗi object
    depth: 4,
    entryBytes: 4000,  // kích thước tối đa mỗi entry (JSON)
    chunkSize: 300,    // entry mỗi chunk lưu trữ
    maxChunks: 200,    // ~60.000 entry; vượt thì bỏ chunk cũ nhất
    flushMs: 800,      // gom ghi xuống storage
    sendMs: 400,       // gom gửi từ ngữ cảnh khác về service worker
    maxBuffer: 500
  };
  const KEYS = { META: "amit_log_meta", CHUNK: "amit_log_c_" };

  // ============================================================
  // LÀM SẠCH
  // ============================================================
  // Khóa nhạy cảm (so khớp theo TÊN KHÓA). "noAccess", "keyHint", "hasKey" v.v. KHÔNG bị che.
  const SECRET_KEY_RE = /(token|secret|passw|authorization|cookie|dtsg|(^|[_-])lsd($|[_-])|api[_-]?key|apikey|bearer|credential)/i;

  function redactString(s) {
    return String(s)
      .replace(/EA[A-Za-z0-9]{20,}/g, "[TOKEN]")
      .replace(/sk-or-[A-Za-z0-9_\-]{6,}/g, "[API_KEY]")
      .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
      .replace(/([?&;](?:access_token|token|fb_dtsg|lsd|key|api_key)=)[^&\s"';]+/gi, "$1[REDACTED]")
      .replace(/\b(xs|fr|datr|sb|c_user_token)=[^;\s"']+/g, "$1=[REDACTED]");
  }

  function sanitize(value, depth) {
    depth = depth || 0;
    if (value === null || value === undefined) return null;
    const t = typeof value;
    if (t === "number" || t === "boolean") return value;
    if (t === "string") {
      const s = redactString(value);
      return s.length > LIMITS.str ? s.slice(0, LIMITS.str) + `…(+${s.length - LIMITS.str})` : s;
    }
    if (t === "function") return "[function]";
    if (value instanceof Error) {
      return {
        name: value.name,
        message: sanitize(value.message, depth + 1),
        code: value.code || undefined,
        stack: value.stack ? sanitize(String(value.stack).split("\n").slice(0, 5).join(" | "), depth + 1) : undefined
      };
    }
    if (depth >= LIMITS.depth) return "[depth]";
    if (Array.isArray(value)) {
      const out = value.slice(0, LIMITS.arr).map(v => sanitize(v, depth + 1));
      if (value.length > LIMITS.arr) out.push(`…(+${value.length - LIMITS.arr} mục)`);
      return out;
    }
    if (t === "object") {
      if (typeof Node !== "undefined" && value instanceof Node) return "[DOM node]";
      const out = {};
      let n = 0;
      for (const k of Object.keys(value)) {
        if (n++ >= LIMITS.keys) { out["…"] = "còn thêm khóa"; break; }
        // Giá trị đúng/sai (vd hasToken) không thể chứa bí mật: giữ lại để còn chẩn đoán được
        out[k] = (SECRET_KEY_RE.test(k) && typeof value[k] !== "boolean") ? "[REDACTED]" : sanitize(value[k], depth + 1);
      }
      return out;
    }
    return String(value);
  }

  function capEntry(entry) {
    let json;
    try { json = JSON.stringify(entry); } catch (_) { json = null; }
    if (json === null) return Object.assign({}, entry, { data: { unserializable: true } });
    if (json.length <= LIMITS.entryBytes) return entry;
    return Object.assign({}, entry, { data: { truncated: true, preview: json.slice(0, 3000) } });
  }

  // ============================================================
  // KHO LƯU TRỮ (chỉ service worker ghi)
  // ============================================================
  const store = (function () {
    let queue = Promise.resolve();
    let pending = [];
    let timer = null;
    let cache = null; // { meta, chunk } - service worker là người ghi duy nhất nên cache an toàn

    const run = fn => (queue = queue.then(fn).catch(e => {
      try { console.warn("[AMIT log] lỗi ghi:", e && e.message); } catch (_) {}
    }));

    async function loadMeta() {
      const s = await chrome.storage.local.get(KEYS.META);
      return s[KEYS.META] || { first: 0, cur: 0, curLen: 0, seq: 0, pruned: 0, created: new Date().toISOString() };
    }

    async function writePending() {
      if (!pending.length) return;
      const entries = pending;
      pending = [];
      const meta = cache ? cache.meta : await loadMeta();
      let chunk;
      if (cache) chunk = cache.chunk;
      else if (meta.curLen) {
        const k = KEYS.CHUNK + meta.cur;
        chunk = (await chrome.storage.local.get(k))[k] || [];
      } else chunk = [];

      const toSet = {};
      for (const e of entries) {
        if (chunk.length >= LIMITS.chunkSize) {
          toSet[KEYS.CHUNK + meta.cur] = chunk;
          meta.cur++;
          chunk = [];
        }
        e.n = ++meta.seq;
        chunk.push(e);
      }
      meta.curLen = chunk.length;
      toSet[KEYS.CHUNK + meta.cur] = chunk;

      const remove = [];
      while (meta.cur - meta.first + 1 > LIMITS.maxChunks) {
        const k = KEYS.CHUNK + meta.first;
        const got = (await chrome.storage.local.get(k))[k];
        meta.pruned += got ? got.length : LIMITS.chunkSize;
        remove.push(k);
        delete toSet[k];
        meta.first++;
      }
      toSet[KEYS.META] = meta;
      cache = { meta, chunk };
      await chrome.storage.local.set(toSet);
      if (remove.length) await chrome.storage.local.remove(remove);
    }

    function flushNow() {
      clearTimeout(timer);
      timer = null;
      return run(writePending);
    }

    return {
      /** entries: mảng entry. Entry đến từ ngữ cảnh khác được làm sạch lại (phòng thủ nhiều lớp). */
      append(entries, trusted) {
        let urgent = false;
        for (const raw of entries) {
          const e = trusted ? raw : capEntry(sanitize(raw));
          if (!e || typeof e !== "object") continue;
          if ((LEVELS[e.lvl] || 0) >= LEVELS.warn) urgent = true;
          pending.push(e);
        }
        if (urgent || pending.length >= 100) return flushNow();
        if (!timer) timer = setTimeout(() => { timer = null; run(writePending); }, LIMITS.flushMs);
        return Promise.resolve();
      },
      flush: flushNow,
      async clear() {
        clearTimeout(timer);
        timer = null;
        pending = [];
        await run(async () => {
          const meta = await loadMeta();
          const keys = [KEYS.META];
          for (let i = meta.first; i <= meta.cur; i++) keys.push(KEYS.CHUNK + i);
          await chrome.storage.local.remove(keys);
          cache = null;
        });
      }
    };
  })();

  /** Đọc toàn bộ log đã lưu (dùng được ở mọi trang của extension, không cần cache). */
  async function readStored() {
    const s = await chrome.storage.local.get(KEYS.META);
    const meta = s[KEYS.META];
    if (!meta) return { meta: null, entries: [] };
    const keys = [];
    for (let i = meta.first; i <= meta.cur; i++) keys.push(KEYS.CHUNK + i);
    const got = await chrome.storage.local.get(keys);
    const entries = [];
    keys.forEach(k => { if (Array.isArray(got[k])) entries.push(...got[k]); });
    return { meta, entries };
  }

  // ============================================================
  // GHI LOG
  // ============================================================
  let ctx = "unknown";
  let sink = null;        // trong service worker: ghi thẳng vào store
  let buffer = [];
  let sendTimer = null;

  function sendBuffer() {
    sendTimer = null;
    if (!buffer.length) return;
    const batch = buffer.splice(0, 200);
    try {
      const p = chrome.runtime.sendMessage({ action: "log_append", entries: batch });
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          // service worker chưa sẵn sàng: giữ lại (có giới hạn) để gửi lần sau
          buffer = batch.concat(buffer).slice(-LIMITS.maxBuffer);
        });
      }
    } catch (_) {
      buffer = batch.concat(buffer).slice(-LIMITS.maxBuffer);
    }
    if (buffer.length && !sendTimer) sendTimer = setTimeout(sendBuffer, LIMITS.sendMs * 4);
  }

  function emit(lvl, ev, data) {
    let entry;
    try {
      entry = capEntry({ ts: new Date().toISOString(), ctx, lvl, ev, data: sanitize(data) });
    } catch (_) {
      return;
    }
    if (sink) {
      try { sink(entry); } catch (_) {}
      return;
    }
    buffer.push(entry);
    if (buffer.length > LIMITS.maxBuffer) buffer.shift();
    if (LEVELS[lvl] >= LEVELS.warn) {
      clearTimeout(sendTimer);
      sendBuffer();
    } else if (!sendTimer) {
      sendTimer = setTimeout(sendBuffer, LIMITS.sendMs);
    }
  }

  function installErrorHooks() {
    if (typeof root.addEventListener !== "function") return;
    root.addEventListener("error", e => {
      emit("error", "js.error", { message: e && e.message, source: e && e.filename, line: e && e.lineno, col: e && e.colno, error: e && e.error });
    });
    root.addEventListener("unhandledrejection", e => {
      emit("error", "js.unhandled_rejection", { reason: e && e.reason });
    });
  }

  // ============================================================
  // XUẤT FILE
  // ============================================================
  function stamp(d) {
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /**
   * Dựng nội dung file log. extra: { note, header } (header: thông tin thêm do trang gọi cung cấp).
   * Trả về { text, filename, stats }.
   */
  async function buildLogText(extra) {
    extra = extra || {};
    const { meta, entries } = await readStored();
    const counts = { debug: 0, info: 0, warn: 0, error: 0 };
    entries.forEach(e => { if (counts[e.lvl] !== undefined) counts[e.lvl]++; });

    let manifest = {};
    try { manifest = chrome.runtime.getManifest(); } catch (_) {}
    let platform = null;
    try { platform = await chrome.runtime.getPlatformInfo(); } catch (_) {}
    let tz = null;
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) {}

    const header = sanitize(Object.assign({
      type: "AMIT_LOG_HEADER",
      format: 1,
      generated_at: new Date().toISOString(),
      extension: { name: manifest.name, version: manifest.version },
      browser: { ua: typeof navigator !== "undefined" ? navigator.userAgent : null, language: typeof navigator !== "undefined" ? navigator.language : null, timezone: tz },
      platform,
      log: {
        entries: entries.length,
        pruned_oldest: meta ? meta.pruned : 0,
        first_ts: entries.length ? entries[0].ts : null,
        last_ts: entries.length ? entries[entries.length - 1].ts : null,
        by_level: counts
      },
      user_note: extra.note || ""
    }, extra.header || {}));
    // header có thể chứa nhiều thông tin hơn giới hạn entry thường; không cắt ở đây
    const banner = "# AMIT V1 LOG - gửi nguyên file này cho dev. File có ID tài khoản quảng cáo và UID Facebook (đã che token / cookie / API key / tên người dùng).";
    const text = [banner, JSON.stringify(header)].concat(entries.map(e => JSON.stringify(e))).join("\n") + "\n";
    return { text, filename: `AMIT-log-${stamp(new Date())}.txt`, stats: { entries: entries.length, counts, pruned: meta ? meta.pruned : 0 } };
  }

  const api = {
    __loaded: true,
    LEVELS, LIMITS, KEYS,
    init(context, opts) {
      ctx = context || ctx;
      if (opts && opts.direct) sink = e => store.append([e], true);
      // Nhiều script có thể cùng nạp logger trong một trang (content script + executor): chỉ gắn hook lỗi một lần
      if (!api.__inited) {
        api.__inited = true;
        installErrorHooks();
      }
    },
    setContext(c) { ctx = c; },
    setSink(fn) { sink = fn; },
    debug: (ev, data) => emit("debug", ev, data),
    info: (ev, data) => emit("info", ev, data),
    warn: (ev, data) => emit("warn", ev, data),
    error: (ev, data) => emit("error", ev, data),
    /** Gửi ngay các entry đang gom (ngữ cảnh không phải service worker). */
    flush() { clearTimeout(sendTimer); sendBuffer(); },
    store, readStored, buildLogText, sanitize, redactString, capEntry
  };

  root.AmitLog = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
