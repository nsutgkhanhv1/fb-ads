/**
 * AMIT V1 - Super Share UI Executor (DOM driver cho AmitSuperShareCore)
 *
 * Chạy trong trang adsmanager.facebook.com bằng session Facebook hiện tại (docx §1).
 * Được background inject theo yêu cầu cùng shared/super-share-core.js.
 *
 * NGUYÊN TẮC (docx §11, §19):
 *   Known DOM selector -> semantic DOM (theo nhãn hiển thị) -> Jev fallback (hook tùy chọn).
 *   Không chắc chắn thì FAIL với mã lỗi tường minh; KHÔNG đoán, KHÔNG click ngoài scope của bước hiện tại.
 *
 * !! Facebook đổi giao diện thường xuyên và code này CHƯA được kiểm chứng với DOM thật của Meta.
 * !! Mọi nhãn / pattern cần chỉnh nằm trong CONFIG ngay bên dưới. Khi lỗi UI_VARIANT_UNKNOWN /
 * !! UI_TARGET_AMBIGUOUS, result.detail chứa danh sách control nhìn thấy để chỉnh CONFIG.
 */
(function () {
  "use strict";

  if (globalThis.__AMIT_EXECUTOR_LOADED__) return;
  globalThis.__AMIT_EXECUTOR_LOADED__ = true;

  const Core = globalThis.AmitSuperShareCore;
  if (!Core) {
    console.error("[AMIT Executor] Thiếu AmitSuperShareCore.");
    return;
  }
  const { DriverError, ERR } = Core;

  // ---- Log (xem shared/logger.js). Không bao giờ làm hỏng luồng chạy nếu logger lỗi / chưa nạp. ----
  if (globalThis.AmitLog && !globalThis.AmitLog.__inited) globalThis.AmitLog.init("content");
  const log = (lvl, ev, data) => { try { if (globalThis.AmitLog) globalThis.AmitLog[lvl]("exec." + ev, data); } catch (_) {} };
  // Tên người trong danh sách vai trò: thu thập để che khỏi log và dữ liệu gửi cho Jev
  const knownNames = new Set();
  const scrub = text => { let t = String(text || ""); knownNames.forEach(nm => { if (nm.length >= 3) t = t.split(nm).join("<name>"); }); return t; };

  // ============================================================
  // CONFIG — chỉnh ở đây khi UI Meta thay đổi
  // ============================================================
  const CONFIG = {
    timeouts: {
      accountHeader: 20000,   // chờ header Ads Manager hiện ID TKQC
      section: 20000,         // chờ mục "Vai trò trên tài khoản quảng cáo" có nội dung
      dialog: 8000,           // chờ hộp thoại hiện
      results: 8000,          // chờ kết quả tìm kiếm
      dialogClose: 12000,     // chờ hộp thoại đóng sau Confirm
      settle: 1500,           // chờ UI cập nhật sau write (technical wait)
      poll: 250
    },

    // Known DOM: nếu bạn đã biết selector chắc chắn, điền vào đây (ưu tiên hơn semantic). Mỗi key là một mảng CSS selector.
    knownSelectors: {
      // rolesSection: ["[data-testid='ad_account_roles']"],
      // addPeopleButton: [],
      // accountSelector: []
    },

    labels: {
      rolesHeading: ["Vai trò trên tài khoản quảng cáo", "Ad account roles"],
      addPeople: ["Thêm người", "Add people", "Add person", "Thêm người dùng"],
      removeControl: ["Xóa", "Gỡ", "Xóa người dùng", "Gỡ người dùng", "Remove", "Remove person", "Remove user", "Delete"],
      removeConfirm: ["Xóa", "Gỡ", "Xóa người dùng", "Xác nhận", "Remove", "Confirm", "Delete"],
      // Jev KHÔNG BAO GIỜ được chọn các control này (docx §11: không click ngoài scope / không phá luồng)
      cancel: ["Hủy", "Đóng", "Không", "Quay lại", "Bỏ qua", "Cancel", "Close", "No", "Back", "Dismiss", "Not now"],
      editControl: ["Chỉnh sửa", "Sửa", "Edit", "Edit role", "Change role", "Thay đổi vai trò"],
      moreMenu: ["Xem thêm", "Thêm tùy chọn", "Tùy chọn", "Hành động", "More", "More options", "Options", "Actions"],
      // Thử lần lượt từng nhóm; nhóm đầu cho đúng 1 control thì dùng.
      confirmGroups: [
        ["Xác nhận", "Confirm"],
        ["Thêm", "Add"],
        ["Lưu thay đổi", "Lưu", "Save changes", "Save"],
        ["Gửi", "Submit"],
        ["Xong", "Done"]
      ],
      roles: {
        ADMIN: ["Quản trị viên", "Quản trị viên tài khoản quảng cáo", "Admin", "Ad account admin", "Administrator"],
        ADVERTISER: ["Nhà quảng cáo", "Nhà quảng cáo tài khoản quảng cáo", "Advertiser", "Ad account advertiser"],
        ANALYST: ["Nhà phân tích quảng cáo", "Nhà phân tích", "Analyst", "Ad account analyst", "Ads analyst"]
      },
      errorText: [/rất tiếc,? đã xảy ra lỗi/i, /something went wrong/i, /unknown error/i, /đã xảy ra sự cố/i],
      noAccessText: [/bạn không có quyền (truy cập|xem)/i, /không có quyền truy cập/i, /you (don'?t|do not) have (access|permission)/i, /no longer have access/i],
      removedToast: [/đã (xóa|gỡ) (bạn|người)/i, /(person|user|you) (was|were|has been) removed/i],
      noResultsText: [/không tìm thấy/i, /no (results|matches)/i, /không có kết quả/i],
      loginText: [/đăng nhập vào facebook/i, /log in to facebook/i],
      checkpointText: [/xác nhận danh tính/i, /confirm your identity/i, /tài khoản của bạn đã bị (khóa|tạm khóa)/i, /your account has been locked/i]
    },

    // Rút UID từ href / thuộc tính. Thứ tự: cụ thể trước, chung sau.
    uidHrefPatterns: [
      /profile\.php\?(?:[^#]*&)?id=(\d{5,})/,
      /[?&](?:user_?id|uid|id)=(\d{9,})/,
      /\/people\/[^/]+\/(\d{9,})/,
      /facebook\.com\/(\d{9,})(?:[/?#]|$)/,
      /^\/(\d{9,})(?:[/?#]|$)/
    ],
    uidAttributes: ["data-userid", "data-user-id", "data-uid", "data-profileid", "data-id"],

    // Jev (docx §11): gọi qua service worker -> OpenRouter, cấu hình ở popup. Chỉ chạy khi đã bật + có key.
    // Có thể thay bằng globalThis.AmitJev = { resolve({goal, step, candidates}) -> {index, confidence} } (dùng cho test).
    jevMinConfidence: 0.8,
    jevMaxCallsPerItem: 12
  };

  // ============================================================
  // TIỆN ÍCH
  // ============================================================
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => String(s || "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
  const labelEq = (text, labels) => { const t = norm(text); return !!t && labels.some(l => norm(l) === t); };

  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }

  async function waitFor(fn, timeout, interval) {
    const end = Date.now() + timeout;
    const step = interval || CONFIG.timeouts.poll;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(step);
    }
  }

  function realClick(el) {
    log("debug", "click", describe(el));
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const o = { bubbles: true, cancelable: true, view: window };
    if (typeof el.focus === "function") { try { el.focus({ preventScroll: true }); } catch (_) {} }
    el.dispatchEvent(new MouseEvent("mousedown", o));
    el.dispatchEvent(new MouseEvent("mouseup", o));
    el.click();
  }

  function setNativeValue(input, value) {
    log("debug", "type", { target: input.placeholder || input.getAttribute("aria-label") || input.tagName, value });
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: String(value).slice(-1) || "0" }));
  }

  const INTERACTIVE = "button,[role=button],[role=menuitem],[role=option],[role=radio],[role=checkbox],[role=tab],[role=link],[role=combobox],a[href],[aria-haspopup]";

  const labelOf = el => (el.getAttribute("aria-label") || el.innerText || el.textContent || "").trim();

  function controls(scope) {
    return [...scope.querySelectorAll(INTERACTIVE)].filter(visible);
  }

  /** Bỏ phần tử lồng nhau (giữ phần tử ngoài cùng) để tránh đếm trùng cùng một control. */
  function dedupeNested(els) {
    return els.filter(a => !els.some(b => b !== a && b.contains(a)));
  }

  // Nhãn an toàn để ghi log / gửi Jev: link profile -> "<profile link>", tên người đã biết -> "<name>"
  function describe(el) {
    const raw = (el.tagName === "A" && uidFromHref(el.getAttribute("href"))) ? "<profile link>" : labelOf(el);
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || null,
      label: scrub(raw).slice(0, 60),
      haspopup: el.getAttribute("aria-haspopup") || null
    };
  }

  function diagnostics(scope, extra) {
    const s = scope || document.body;
    return Object.assign({
      url: location.href.replace(/([?&](?:access_token|token)=)[^&]+/g, "$1…"),
      headings: [...document.querySelectorAll("h1,h2,h3,[role=heading]")].filter(visible).map(h => scrub(labelOf(h)).slice(0, 60)).slice(0, 15),
      controls: controls(s).map(c => describe(c).label.slice(0, 40)).filter(Boolean).slice(0, 40),
      dialogs: [...document.querySelectorAll("[role=dialog]")].filter(visible).length
    }, extra || {});
  }

  const uidInText = (html, uid) => new RegExp("(^|\\D)" + uid + "(\\D|$)").test(html);

  // ============================================================
  // LOCATE: known DOM -> semantic -> Jev
  // ============================================================
  async function locate(opts) {
    const { step, goal, scope, labels, knownKey, notFoundCode, ambiguousDetail } = opts;
    const root = scope || document.body;

    // 1. Known DOM
    const known = (CONFIG.knownSelectors[knownKey] || []);
    for (const sel of known) {
      const found = dedupeNested([...root.querySelectorAll(sel)].filter(visible));
      if (found.length === 1) { log("debug", "locate", { step, strategy: "known", selector: sel }); return found[0]; }
      if (found.length > 1) {
        log("warn", "locate.ambiguous", { step, strategy: "known", selector: sel, matches: found.length });
        throw new DriverError(ERR.UI_TARGET_AMBIGUOUS, `Selector đã biết "${sel}" khớp ${found.length} phần tử (bước ${step}).`, step, diagnostics(root));
      }
    }

    // 2. Semantic DOM: khớp CHÍNH XÁC nhãn hiển thị
    const all = controls(root);
    const matched = dedupeNested(all.filter(el => labelEq(labelOf(el), labels)));
    if (matched.length === 1) { log("debug", "locate", { step, strategy: "semantic", label: describe(matched[0]).label }); return matched[0]; }
    if (matched.length > 1) {
      log("warn", "locate.ambiguous", { step, strategy: "semantic", matches: matched.length, asking_jev: true });
      const viaJev = await askJev(step, goal, matched);
      if (viaJev) return viaJev;
      throw new DriverError(ERR.UI_TARGET_AMBIGUOUS, `Có ${matched.length} control cùng nhãn "${labels[0]}" (bước ${step}).`, step,
        diagnostics(root, ambiguousDetail || { matches: matched.map(m => describe(m)) }));
    }

    // 3. Jev fallback (chỉ trả candidate; code validate scope)
    log("warn", "locate.not_found", { step, wanted: labels, controls_in_scope: all.length, asking_jev: true });
    const viaJev = await askJev(step, goal, all);
    if (viaJev) return viaJev;
    throw new DriverError(notFoundCode || ERR.UI_VARIANT_UNKNOWN, `Không tìm thấy control "${labels[0]}" (bước ${step}).`, step, diagnostics(root));
  }

  // Nhật ký các lần gọi Jev của item đang chạy (đính kèm vào result.jev để kiểm tra sau)
  const jevLog = [];

  function jevClient() {
    if (globalThis.AmitJev && typeof globalThis.AmitJev.resolve === "function") return globalThis.AmitJev;
    return {
      resolve: req => chrome.runtime.sendMessage({ action: "jev_resolve", request: req })
        .then(r => (r && r.ok ? { index: r.index, confidence: r.confidence } : null))
        .catch(() => null)
    };
  }

  /**
   * Jev chỉ trả về MỘT candidate trong danh sách do code lọc theo scope; code validate lại tại đây:
   * loại nút Hủy/Đóng, ngưỡng tin cậy, giới hạn số lần gọi. Jev không quyết định gì ngoài việc "control nào".
   */
  async function askJev(step, goal, candidates) {
    if (jevLog.length >= CONFIG.jevMaxCallsPerItem) return null;
    const safe = candidates.filter(c => !labelEq(labelOf(c), CONFIG.labels.cancel));
    if (!safe.length) return null;
    let out;
    try {
      out = await jevClient().resolve({ step, goal, candidates: safe.map((c, i) => Object.assign({ index: i }, describe(c))) });
    } catch (_) {
      return null;
    }
    if (!out) { log("debug", "jev.unavailable", { step }); return null; } // Jev tắt / lỗi mạng / lỗi key: coi như không có Jev
    if (out.index === null || typeof out.index !== "number") {
      jevLog.push({ step, chosen: null, confidence: out.confidence });
      log("info", "jev.no_choice", { step, confidence: out.confidence });
      return null;
    }
    if (!(out.confidence >= CONFIG.jevMinConfidence)) {
      jevLog.push({ step, chosen: null, confidence: out.confidence, rejected: "LOW_CONFIDENCE" });
      log("warn", "jev.low_confidence", { step, confidence: out.confidence, min: CONFIG.jevMinConfidence });
      throw new DriverError(ERR.UI_TARGET_AMBIGUOUS, `Jev không đủ tự tin (${out.confidence}) ở bước ${step}.`, step);
    }
    const el = safe[out.index];
    if (!el || !el.isConnected) return null;
    jevLog.push({ step, goal: goal.slice(0, 120), chosen: describe(el).label, confidence: out.confidence });
    log("info", "jev.chosen", { step, chosen: describe(el), confidence: out.confidence, calls_so_far: jevLog.length });
    return el;
  }

  // ============================================================
  // SESSION
  // ============================================================
  const pageText = () => (document.body ? document.body.innerText : "") || "";
  const anyMatch = (patterns, text) => patterns.some(p => p.test(text));

  function sessionState() {
    const path = location.pathname;
    if (/\/checkpoint\b/.test(path) || /\/checkpoint\b/.test(location.href)) return "CHECKPOINT";
    if (/^\/(login|recover)/.test(path) || document.querySelector("form#login_form, input[name=pass][type=password]")) return "EXPIRED";
    const txt = pageText().slice(0, 4000);
    if (anyMatch(CONFIG.labels.checkpointText, txt)) return "CHECKPOINT";
    if (!/(?:^|; )c_user=\d+/.test(document.cookie)) return "EXPIRED";
    if (anyMatch(CONFIG.labels.loginText, txt) && document.querySelector("input[type=password]")) return "EXPIRED";
    return "OK";
  }

  function sessionUid() {
    const m = document.cookie.match(/(?:^|; )c_user=(\d+)/);
    const cookieUid = m ? m[1] : null;
    if (!cookieUid) return null;
    // Cross-check với UID nhúng trong trang (nếu có). Lệch nhau -> không tin.
    const html = document.documentElement.innerHTML;
    const emb = (html.match(/"USER_ID":"(\d+)"/) || html.match(/"actorID":"(\d+)"/) || [])[1];
    if (emb && emb !== "0" && emb !== cookieUid) return null;
    return cookieUid;
  }

  // ============================================================
  // TKQC CONTEXT (docx Step 3-4)
  // ============================================================
  function accountIdFromUrl() {
    const v = new URL(location.href).searchParams.get("act");
    return v ? v.replace(/^act_/, "") : null;
  }

  /** Control hiển thị TKQC hiện tại trên header: nút ở vùng trên cùng có chứa dãy số >= 8 chữ số. */
  function accountSelectorEl() {
    const known = CONFIG.knownSelectors.accountSelector || [];
    for (const sel of known) {
      const el = [...document.querySelectorAll(sel)].find(visible);
      if (el) return el;
    }
    const cands = controls(document.body).filter(el => {
      const r = el.getBoundingClientRect();
      return r.top < 140 && /\d{8,}/.test(labelOf(el));
    });
    return cands.length ? dedupeNested(cands)[0] : null;
  }

  function accountIdFromDom() {
    const el = accountSelectorEl();
    if (!el) return null;
    const m = labelOf(el).match(/\d{8,}/);
    return m ? m[0] : null;
  }

  async function selectAccountViaSearch(actId) {
    const sel = accountSelectorEl();
    if (!sel) throw new DriverError(ERR.UI_VARIANT_UNKNOWN, "Không tìm thấy bộ chọn tài khoản quảng cáo trên header.", "OPEN_ACCOUNT", diagnostics());
    const before = new Set([...document.querySelectorAll("[role=dialog],[role=listbox],[role=menu]")]);
    realClick(sel);
    let popup = await waitFor(() => [...document.querySelectorAll("[role=dialog],[role=listbox],[role=menu]")]
      .filter(visible).find(p => !before.has(p) && p.querySelector("input")), CONFIG.timeouts.dialog);
    if (!popup) {
      // Popup không có role chuẩn: chấp nhận nếu xuất hiện ô tìm kiếm rõ ràng
      const searchBox = await waitFor(() => [...document.querySelectorAll("input")].filter(visible)
        .find(i => /tìm|search/i.test(i.placeholder || i.getAttribute("aria-label") || "")), 2000);
      if (searchBox) popup = document.body;
    }
    if (!popup) throw new DriverError(ERR.UI_VARIANT_UNKNOWN, "Bộ chọn tài khoản không mở ra ô tìm kiếm.", "OPEN_ACCOUNT", diagnostics());

    const input = [...popup.querySelectorAll("input")].filter(visible).find(i => i.type !== "checkbox" && i.type !== "radio");
    if (!input) throw new DriverError(ERR.UI_VARIANT_UNKNOWN, "Không thấy ô Search trong bộ chọn tài khoản.", "OPEN_ACCOUNT", diagnostics(popup));
    input.focus();
    setNativeValue(input, actId);

    const re = new RegExp("(^|\\D)" + actId + "(\\D|$)");
    const found = await waitFor(() => {
      const opts = dedupeNested([...popup.querySelectorAll("[role=option],[role=menuitem],[role=listitem],[role=row],li,a[href]")]
        .filter(visible).filter(o => re.test(o.innerText || "")));
      return opts.length ? opts : null;
    }, CONFIG.timeouts.results);

    log(found ? "info" : "warn", "account.search_results", { actId, found: found ? found.length : 0 });
    if (!found) throw new DriverError(ERR.ACCOUNT_NOT_FOUND, `Không tìm thấy TKQC ${actId} trong bộ chọn tài khoản (Search theo ID).`, "OPEN_ACCOUNT");
    if (found.length > 1) throw new DriverError(ERR.UI_TARGET_AMBIGUOUS, `Có ${found.length} kết quả cùng chứa ID ${actId}.`, "OPEN_ACCOUNT", diagnostics(popup));
    realClick(found[0]);
    const ok = await waitFor(() => accountIdFromDom() === actId, CONFIG.timeouts.accountHeader);
    if (!ok) throw new DriverError(ERR.ACCOUNT_NOT_FOUND, `Đã chọn kết quả nhưng TKQC hiện tại không phải ${actId}.`, "OPEN_ACCOUNT");
  }

  // TKQC mục tiêu của item đang chạy (để validate lại trước mỗi write)
  const state = { actId: null };

  async function openAccount(actId) {
    state.actId = actId;
    // Chờ header tải xong
    const header = await waitFor(() => accountIdFromDom(), CONFIG.timeouts.accountHeader);
    log(header ? "info" : "warn", "account.header", { expected: actId, header, url_act: accountIdFromUrl(), match: header === actId });
    if (!header) {
      const txt = pageText();
      if (anyMatch(CONFIG.labels.noAccessText, txt)) throw new DriverError(ERR.ACCOUNT_ACCESS_DENIED, `Via không có quyền truy cập TKQC ${actId}.`, "OPEN_ACCOUNT");
      throw new DriverError(ERR.PAGE_LOAD_FAILED, "Ads Manager không hiện ID tài khoản quảng cáo trên header (trang chưa tải xong hoặc UI khác).", "OPEN_ACCOUNT", diagnostics());
    }
    // Direct navigation chỉ được dùng nếu VERIFY được (docx Step 4)
    if (accountIdFromDom() === actId) { log("info", "account.verified_direct", { actId }); return; }
    log("info", "account.select_via_search", { actId, header });
    await selectAccountViaSearch(actId);
  }

  async function assertContext(actId) {
    const dom = accountIdFromDom();
    if (dom !== actId) {
      log("error", "context.mismatch", { expected: actId, dom, url_act: accountIdFromUrl() });
      throw new DriverError(ERR.ACCOUNT_NOT_FOUND, `TKQC hiện tại (${dom || "không đọc được"}) khác TKQC mục tiêu ${actId}. Không thực hiện write action.`, "CONTEXT");
    }
    const url = accountIdFromUrl();
    if (url && url !== actId) {
      log("error", "context.url_mismatch", { expected: actId, url_act: url });
      throw new DriverError(ERR.ACCOUNT_NOT_FOUND, `URL đang trỏ tới TKQC ${url}, khác TKQC mục tiêu ${actId}. Không thực hiện write action.`, "CONTEXT");
    }
  }

  // ============================================================
  // ROLES SECTION (docx Step 5)
  // ============================================================
  const HEADING_SEL = "h1,h2,h3,h4,h5,h6,[role=heading]";

  function findRolesHeading() {
    const labels = CONFIG.labels.rolesHeading;
    const cands = [...document.querySelectorAll(HEADING_SEL + ",span,div")].filter(visible)
      .filter(e => labelEq(e.innerText, labels) && e.children.length <= 2);
    if (!cands.length) return null;
    // ưu tiên phần tử heading ngữ nghĩa; nếu không thì phần tử lá
    return cands.find(e => e.matches(HEADING_SEL)) || cands.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)[0];
  }

  function sectionBoxOf(heading) {
    let box = heading;
    while (box.parentElement && box.parentElement !== document.body) {
      const p = box.parentElement;
      const others = [...p.querySelectorAll(HEADING_SEL)].filter(h => visible(h) && !heading.contains(h) && !h.contains(heading));
      if (others.length) break;
      box = p;
    }
    return box;
  }

  function uidFromHref(href) {
    if (!href) return null;
    for (const re of CONFIG.uidHrefPatterns) {
      const m = String(href).match(re);
      if (m) return m[1];
    }
    return null;
  }

  function uidsIn(el) {
    const set = new Set();
    el.querySelectorAll("a[href]").forEach(a => { const u = uidFromHref(a.getAttribute("href")); if (u) set.add(u); });
    const sel = CONFIG.uidAttributes.map(a => `[${a}]`).join(",");
    if (sel) el.querySelectorAll(sel).forEach(n => CONFIG.uidAttributes.forEach(a => { const v = n.getAttribute(a); if (v && /^\d{9,}$/.test(v)) set.add(v); }));
    return set;
  }

  function roleFromText(text) {
    for (const [role, labels] of Object.entries(CONFIG.labels.roles)) {
      if (labelEq(text, labels)) return role;
    }
    return null;
  }

  async function jevFindRolesBox() {
    const heads = [...document.querySelectorAll(HEADING_SEL)].filter(visible).filter(h => labelOf(h));
    if (!heads.length) return null;
    const h = await askJev("LOCATE_ROLES", "Locate the section for managing people and roles of the CURRENT advertising account.", heads);
    if (!h) return null;
    const b = sectionBoxOf(h);
    // Validate: phải trông đúng là mục vai trò (có dòng người dùng / nút Thêm người / nhãn role), không thì bỏ
    const looksRight = uidsIn(b).size > 0
      || controls(b).some(c => labelEq(labelOf(c), CONFIG.labels.addPeople))
      || [...b.querySelectorAll("span,div")].some(e => e.children.length === 0 && roleFromText(e.innerText));
    return looksRight ? b : null;
  }

  async function ensureRolesBox() {
    const t0 = Date.now();
    const known = (CONFIG.knownSelectors.rolesSection || []);
    const box = await waitFor(() => {
      for (const sel of known) { const el = [...document.querySelectorAll(sel)].find(visible); if (el) return el; }
      const h = findRolesHeading();
      if (!h) return null;
      const b = sectionBoxOf(h);
      // "sẵn sàng" = có dòng người dùng hoặc có nút Thêm người
      const hasRows = uidsIn(b).size > 0;
      const hasAdd = controls(b).some(c => labelEq(labelOf(c), CONFIG.labels.addPeople));
      const hasRoleLabels = [...b.querySelectorAll("span,div")].some(e => e.children.length === 0 && roleFromText(e.innerText));
      return (hasRows || hasAdd || hasRoleLabels) ? b : null;
    }, CONFIG.timeouts.section);

    if (box) { log("debug", "roles.box_ready", { ms: Date.now() - t0 }); return box; }

    // Không thấy tiêu đề mục: Jev fallback đúng goal của docx §5 Step 5; code validate nội dung trước khi dùng.
    if (!findRolesHeading()) {
      const viaJev = await jevFindRolesBox();
      if (viaJev) { log("info", "roles.box_via_jev", { ms: Date.now() - t0 }); return viaJev; }
    }

    const txt = pageText();
    const heading = findRolesHeading();
    log("warn", "roles.box_missing", { ms: Date.now() - t0, heading_found: !!heading, facebook_error_text: anyMatch(CONFIG.labels.errorText, txt), no_access_text: anyMatch(CONFIG.labels.noAccessText, txt) });
    if (anyMatch(CONFIG.labels.noAccessText, txt)) throw new DriverError(ERR.ACCOUNT_ACCESS_DENIED, "Via không có quyền xem vai trò của TKQC này.", "LOCATE_ROLES");
    if (heading && anyMatch(CONFIG.labels.errorText, txt)) {
      throw new DriverError(ERR.PAGE_LOAD_FAILED, "Mục vai trò chưa tải được (Facebook báo lỗi).", "LOCATE_ROLES", diagnostics(heading.parentElement));
    }
    if (heading) throw new DriverError(ERR.PAGE_LOAD_FAILED, "Mục vai trò vẫn trống sau khi chờ.", "LOCATE_ROLES", diagnostics(sectionBoxOf(heading)));
    throw new DriverError(ERR.ROLE_SECTION_NOT_FOUND, "Không thấy mục \"Vai trò trên tài khoản quảng cáo\" / \"Ad account roles\".", "LOCATE_ROLES", diagnostics());
  }

  /** Dòng của một UID = tổ tiên lớn nhất chỉ chứa đúng UID đó (trong phạm vi section). */
  function rowOfLink(link, box) {
    const uid = uidFromHref(link.getAttribute("href"));
    let el = link;
    while (el.parentElement && el.parentElement !== box && box.contains(el.parentElement)) {
      const set = uidsIn(el.parentElement);
      if (set.size > 1 || (set.size === 1 && !set.has(uid))) break;
      el = el.parentElement;
    }
    return el;
  }

  function rowRole(row) {
    // 1) text lá khớp nhãn role; 2) giá trị combobox/select
    const leaves = [...row.querySelectorAll("*")].filter(e => e.children.length === 0 && visible(e));
    for (const e of leaves) {
      const r = roleFromText(e.innerText);
      if (r) return { role: r, roleText: e.innerText.trim() };
    }
    for (const c of row.querySelectorAll("select")) {
      const t = c.options[c.selectedIndex] ? c.options[c.selectedIndex].text : "";
      const r = roleFromText(t);
      if (r) return { role: r, roleText: t };
    }
    for (const c of controls(row)) {
      const r = roleFromText(labelOf(c));
      if (r) return { role: r, roleText: labelOf(c) };
    }
    return { role: null, roleText: null };
  }

  async function readRolesWithRows() {
    const box = await ensureRolesBox();
    const out = [];
    const seen = new Set();
    box.querySelectorAll("a[href]").forEach(a => {
      const uid = uidFromHref(a.getAttribute("href"));
      if (!uid || seen.has(uid) || !visible(a)) return;
      seen.add(uid);
      const row = rowOfLink(a, box);
      const rr = rowRole(row);
      out.push({ uid, name: (a.innerText || a.getAttribute("aria-label") || "").trim(), role: rr.role, roleText: rr.roleText, _row: row });
    });
    // Dòng có data-uid nhưng không có link
    if (!out.length && uidsIn(box).size) {
      uidsIn(box).forEach(uid => {
        const n = box.querySelector(CONFIG.uidAttributes.map(a => `[${a}="${uid}"]`).join(","));
        if (n && !seen.has(uid)) { seen.add(uid); const rr = rowRole(n); out.push({ uid, name: "", role: rr.role, roleText: rr.roleText, _row: n }); }
      });
    }
    if (!out.length) {
      const hasRoleLabels = [...box.querySelectorAll("span,div")].some(e => e.children.length === 0 && roleFromText(e.innerText));
      if (hasRoleLabels) {
        // Có hiển thị vai trò nhưng không rút được UID: KHÔNG đoán theo tên (docx §26)
        throw new DriverError(ERR.UI_VARIANT_UNKNOWN,
          "Thấy danh sách vai trò nhưng không rút được UID từ DOM (không có link profile / thuộc tính UID). Cần chỉnh CONFIG.uidHrefPatterns / uidAttributes.",
          "READ_STATE", diagnostics(box, { sampleLinks: [...box.querySelectorAll("a[href]")].slice(0, 8).map(a => a.getAttribute("href")) }));
      }
    }
    out.forEach(r => { if (r.name) knownNames.add(r.name); });
    log("debug", "roles.read", { count: out.length, rows: out.map(r => ({ uid: r.uid, role: r.role, role_text: r.roleText })) });
    return { box, rows: out };
  }

  async function readRoles() {
    const { rows } = await readRolesWithRows();
    return rows.map(({ _row, ...r }) => r);
  }

  async function rowFor(uid) {
    const { rows } = await readRolesWithRows();
    const r = rows.find(x => x.uid === uid);
    if (!r) throw new DriverError(ERR.UI_TARGET_AMBIGUOUS, `Không tìm thấy dòng của UID ${uid} (DOM có thể đã đổi sau thao tác trước).`, "LOCATE_ROW");
    return r._row;
  }

  // ============================================================
  // DIALOG HELPERS
  // ============================================================
  const dialogSet = () => new Set([...document.querySelectorAll("[role=dialog]")].filter(visible));

  async function waitNewDialog(before, code, msg, step) {
    const t0 = Date.now();
    const dlg = await waitFor(() => [...dialogSet()].find(d => !before.has(d)), CONFIG.timeouts.dialog);
    log(dlg ? "debug" : "warn", "dialog.wait", { step, opened: !!dlg, ms: Date.now() - t0 });
    if (!dlg) throw new DriverError(code, msg, step, diagnostics());
    return dlg;
  }

  function dialogError(dlg) {
    const t = dlg && dlg.innerText ? dlg.innerText : "";
    return anyMatch(CONFIG.labels.errorText, t);
  }

  const enabledControl = c => c.getAttribute("aria-disabled") !== "true" && !c.disabled;

  async function clickConfirm(dlg, groups, step, goal) {
    for (const g of groups) {
      const cands = dedupeNested(controls(dlg).filter(c => labelEq(labelOf(c), g) && enabledControl(c)));
      if (cands.length === 1) { log("info", "confirm.click", { step, group: g[0], label: describe(cands[0]).label }); realClick(cands[0]); return true; }
      if (cands.length > 1) throw new DriverError(ERR.UI_TARGET_AMBIGUOUS, `Có ${cands.length} nút xác nhận cùng nhãn "${g[0]}".`, step, diagnostics(dlg));
    }
    // Jev fallback (docx §11): chỉ chọn control trong hộp thoại hiện tại, không bao giờ là Hủy/Đóng
    const viaJev = await askJev(step, goal || "Locate the primary button that confirms and submits the current dialog (not cancel or close).",
      dedupeNested(controls(dlg).filter(enabledControl)));
    if (viaJev) { log("info", "confirm.click_jev", { step, label: describe(viaJev).label }); realClick(viaJev); return true; }
    log("warn", "confirm.not_found", { step, tried_groups: groups.map(g => g[0]) });
    return false;
  }

  async function waitDialogClosed(dlg, step) {
    const t0 = Date.now();
    const closed = await waitFor(() => !dlg.isConnected || !visible(dlg), CONFIG.timeouts.dialogClose);
    log(closed ? "debug" : "warn", "dialog.closed", { step, closed: !!closed, ms: Date.now() - t0 });
    if (!closed) {
      if (dialogError(dlg)) throw new DriverError(ERR.FACEBOOK_ACTION_ERROR, "Facebook báo lỗi trong hộp thoại.", step, diagnostics(dlg));
      throw new DriverError(ERR.CONFIRM_NOT_AVAILABLE, "Hộp thoại không đóng sau khi bấm xác nhận (có thể cần bước khác).", step, diagnostics(dlg));
    }
  }

  /**
   * Chọn role trong một vùng (dialog/menu). Hỗ trợ radio/option/menuitem hoặc dropdown.
   * Sau khi chọn PHẢI đọc lại và khớp role yêu cầu (docx Share Step 4).
   */
  async function selectRole(scope, role, step) {
    const wanted = CONFIG.labels.roles[role];
    log("debug", "role.select", { step, role, controls_in_scope: controls(scope).length });
    const isSelected = el => el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true" || (el.matches("input[type=radio],input[type=checkbox]") && el.checked);

    // (a) Control hiển thị đúng role yêu cầu
    let cands = dedupeNested(controls(scope).filter(c => labelEq(labelOf(c), wanted)));
    if (cands.length > 1) throw new DriverError(ERR.UI_TARGET_AMBIGUOUS, `Có ${cands.length} control cho role ${role}.`, step, diagnostics(scope));
    if (cands.length === 1) {
      if (!isSelected(cands[0])) realClick(cands[0]);
      await sleep(300);
      return verifySelectedRole(scope, role, step);
    }

    // (b) Dropdown đang hiển thị một role khác -> mở rồi chọn (nhánh này return/throw; nhánh Jev đặt ở cuối hàm)
    const dropdowns = dedupeNested(controls(scope).filter(c => {
      const r = roleFromText(labelOf(c));
      return r && r !== role && (c.getAttribute("aria-haspopup") || c.getAttribute("role") === "combobox");
    }));
    if (dropdowns.length === 1) {
      const before = new Set([...document.querySelectorAll("[role=menu],[role=listbox]")]);
      realClick(dropdowns[0]);
      const menu = await waitFor(() => [...document.querySelectorAll("[role=menu],[role=listbox]")].filter(visible).find(m => !before.has(m)), CONFIG.timeouts.dialog);
      if (!menu) throw new DriverError(ERR.ROLE_NOT_AVAILABLE, `Không mở được danh sách role để chọn ${role}.`, step, diagnostics(scope));
      cands = dedupeNested(controls(menu).filter(c => labelEq(labelOf(c), wanted)));
      if (cands.length !== 1) throw new DriverError(cands.length ? ERR.UI_TARGET_AMBIGUOUS : ERR.ROLE_NOT_AVAILABLE, `Role ${role} ${cands.length ? "khớp nhiều lựa chọn" : "không có trong danh sách"}.`, step, diagnostics(menu));
      realClick(cands[0]);
      await sleep(300);
      return verifySelectedRole(scope, role, step);
    }

    // Jev fallback: role đã cố định bởi input; Jev chỉ chỉ ra control tương ứng. Vẫn phải verify bên dưới.
    const viaJev = await askJev(step, `Locate the option that sets the access role to "${wanted[0]}" (${role}).`, dedupeNested(controls(scope).filter(enabledControl)));
    if (viaJev) {
      if (!isSelected(viaJev)) realClick(viaJev);
      await sleep(300);
      return verifySelectedRole(scope, role, step);
    }

    throw new DriverError(ERR.ROLE_NOT_AVAILABLE, `Không tìm thấy lựa chọn role ${role} trong giao diện.`, step, diagnostics(scope));
  }

  function verifySelectedRole(scope, role, step) {
    const wanted = CONFIG.labels.roles[role];
    const sel = [...scope.querySelectorAll("[aria-checked=true],[aria-selected=true],input:checked")].filter(visible);
    const selectedRoles = sel.map(e => roleFromText(labelOf(e) || (e.closest("label") && e.closest("label").innerText) || "")).filter(Boolean);
    const shown = controls(scope).map(c => roleFromText(labelOf(c))).filter(Boolean);
    const ok = selectedRoles.includes(role) || (!selectedRoles.length && shown.length === 1 && shown[0] === role);
    log(ok ? "info" : "warn", "role.verify", { step, wanted_role: role, selected_roles: selectedRoles, shown_roles: shown, ok });
    if (!ok) {
      throw new DriverError(ERR.ROLE_NOT_AVAILABLE, `Sau khi chọn, role đang chọn không xác nhận được là ${role}. Không bấm xác nhận.`, step,
        diagnostics(scope, { selectedRoles, shownRoles: shown, wanted }));
    }
  }

  // ============================================================
  // WRITE ACTIONS
  // ============================================================
  async function addPerson(uid, role) {
    const box = await ensureRolesBox();
    const btn = await locate({
      step: "ADD_PEOPLE", goal: "Locate the Add People control inside the Ad Account Roles section of the current account.",
      scope: box, labels: CONFIG.labels.addPeople, knownKey: "addPeopleButton", notFoundCode: ERR.ADD_PEOPLE_NOT_AVAILABLE
    });
    const before = dialogSet();
    realClick(btn);
    const dlg = await waitNewDialog(before, ERR.ADD_PEOPLE_NOT_AVAILABLE, "Bấm Thêm người nhưng hộp thoại không hiện.", "ADD_PEOPLE");

    const input = await waitFor(() => [...dlg.querySelectorAll("input")].filter(visible).find(i => !["checkbox", "radio", "hidden"].includes(i.type)), CONFIG.timeouts.dialog);
    if (!input) throw new DriverError(ERR.UI_VARIANT_UNKNOWN, "Hộp thoại Thêm người không có ô tìm kiếm.", "FIND_USER", diagnostics(dlg));
    input.focus();
    setNativeValue(input, uid);

    // Tìm user: chỉ chọn khi có đủ căn cứ kết quả chính là UID (docx Share Step 2)
    const resultSel = "[role=option],[role=listitem],[role=row],[role=menuitem],[role=checkbox],[role=radio],li,label";
    // Lựa chọn role nằm cùng hộp thoại không phải kết quả tìm kiếm
    const candidates = () => dedupeNested([...dlg.querySelectorAll(resultSel)].filter(visible)
      .filter(e => !e.contains(input) && !roleFromText(labelOf(e))));
    const confirmed = await waitFor(() => {
      const all = candidates();
      const hits = all.filter(e => uidInText(e.outerHTML, uid));
      return hits.length ? { hits, all } : null;
    }, CONFIG.timeouts.results);

    log(confirmed ? "info" : "warn", "add.search_result", { uid, hits_with_uid: confirmed ? confirmed.hits.length : 0, candidates: candidates().length });
    if (!confirmed) {
      const all = candidates();
      if (all.length) {
        throw new DriverError(ERR.UI_TARGET_AMBIGUOUS,
          "Facebook trả kết quả nhưng không xác nhận được kết quả nào chính là UID đã nhập (không tìm thấy UID trong markup). Không chọn theo tên.",
          "FIND_USER", diagnostics(dlg, { results: all.length, result_shapes: all.slice(0, 5).map(e => ({ tag: e.tagName.toLowerCase(), role: e.getAttribute("role"), has_link: !!e.querySelector("a[href]"), text_len: (e.innerText || "").length })) }));
      }
      throw new DriverError(ERR.DESTINATION_NOT_FOUND, `Không tìm thấy người dùng với UID ${uid} (không đoán theo tên).`, "FIND_USER");
    }
    if (confirmed.hits.length > 1) {
      throw new DriverError(ERR.UI_TARGET_AMBIGUOUS, `Có ${confirmed.hits.length} kết quả cùng chứa UID ${uid}.`, "FIND_USER", diagnostics(dlg));
    }
    realClick(confirmed.hits[0]);
    await sleep(400);

    // Role: chỉ đến từ input (docx Share Step 3), rồi verify
    await selectRole(dlg, role, "SELECT_ROLE");

    // Validate trước khi Confirm: TKQC (đã mở đúng) + role đã verify ở selectRole (docx Share Step 4)
    await assertContext(state.actId);
    const ok = await clickConfirm(dlg, CONFIG.labels.confirmGroups, "CONFIRM");
    if (!ok) throw new DriverError(ERR.CONFIRM_NOT_AVAILABLE, "Không tìm thấy nút xác nhận trong hộp thoại Thêm người.", "CONFIRM", diagnostics(dlg));
    await waitDialogClosed(dlg, "CONFIRM");
    log("info", "add.submitted", { uid, role });
  }

  async function changeRole(uid, role) {
    const row = await rowFor(uid);
    log("info", "role.change.start", { uid, role });
    // (a) dropdown role ngay trên dòng
    const dd = dedupeNested(controls(row).filter(c => roleFromText(labelOf(c)) && (c.getAttribute("aria-haspopup") || c.getAttribute("role") === "combobox")));
    if (dd.length === 1) {
      log("debug", "role.change.path", { path: "row_dropdown" });
      const before = new Set([...document.querySelectorAll("[role=menu],[role=listbox]")]);
      realClick(dd[0]);
      const menu = await waitFor(() => [...document.querySelectorAll("[role=menu],[role=listbox]")].filter(visible).find(m => !before.has(m)), CONFIG.timeouts.dialog);
      if (!menu) throw new DriverError(ERR.ROLE_CHANGE_NOT_AVAILABLE, "Không mở được danh sách role trên dòng.", "CHANGE_ROLE", diagnostics(row));
      await selectRoleFromMenu(menu, role);
      return;
    }
    // (b) nút Chỉnh sửa -> hộp thoại
    const editBtns = dedupeNested(controls(row).filter(c => labelEq(labelOf(c), CONFIG.labels.editControl)));
    if (editBtns.length === 1) {
      log("debug", "role.change.path", { path: "edit_dialog" });
      const before = dialogSet();
      realClick(editBtns[0]);
      const dlg = await waitNewDialog(before, ERR.ROLE_CHANGE_NOT_AVAILABLE, "Bấm Chỉnh sửa nhưng hộp thoại không hiện.", "CHANGE_ROLE");
      await selectRole(dlg, role, "CHANGE_ROLE");
      const ok = await clickConfirm(dlg, CONFIG.labels.confirmGroups, "CONFIRM");
      if (!ok) throw new DriverError(ERR.CONFIRM_NOT_AVAILABLE, "Không thấy nút lưu khi đổi role.", "CONFIRM", diagnostics(dlg));
      await waitDialogClosed(dlg, "CONFIRM");
      return;
    }
    // (c) Jev fallback: chỉ trong phạm vi dòng của UID này
    const viaJev = await askJev("CHANGE_ROLE", "Locate the control that edits or changes this person's role on the ad account.", dedupeNested(controls(row).filter(enabledControl)));
    if (viaJev) {
      log("debug", "role.change.path", { path: "jev" });
      const beforeD = dialogSet();
      const beforeM = new Set([...document.querySelectorAll("[role=menu],[role=listbox]")]);
      realClick(viaJev);
      const opened = await waitFor(() => {
        const d = [...dialogSet()].find(x => !beforeD.has(x));
        if (d) return { dialog: d };
        const m = [...document.querySelectorAll("[role=menu],[role=listbox]")].filter(visible).find(x => !beforeM.has(x));
        return m ? { menu: m } : null;
      }, CONFIG.timeouts.dialog);
      if (opened && opened.dialog) {
        await selectRole(opened.dialog, role, "CHANGE_ROLE");
        const ok = await clickConfirm(opened.dialog, CONFIG.labels.confirmGroups, "CONFIRM");
        if (!ok) throw new DriverError(ERR.CONFIRM_NOT_AVAILABLE, "Không thấy nút lưu khi đổi role.", "CONFIRM", diagnostics(opened.dialog));
        await waitDialogClosed(opened.dialog, "CONFIRM");
        return;
      }
      if (opened && opened.menu) {
        await selectRoleFromMenu(opened.menu, role);
        return;
      }
    }
    throw new DriverError(ERR.ROLE_CHANGE_NOT_AVAILABLE, "Facebook UI không cung cấp thao tác đổi role cho dòng này.", "CHANGE_ROLE", diagnostics(row));
  }

  async function selectRoleFromMenu(menu, role) {
    const cands = dedupeNested(controls(menu).filter(c => labelEq(labelOf(c), CONFIG.labels.roles[role])));
    if (cands.length !== 1) {
      throw new DriverError(cands.length ? ERR.UI_TARGET_AMBIGUOUS : ERR.ROLE_CHANGE_NOT_AVAILABLE, `Role ${role} ${cands.length ? "khớp nhiều lựa chọn" : "không có trong menu"}.`, "CHANGE_ROLE", diagnostics(menu));
    }
    realClick(cands[0]);
    // Một số UI có nút Lưu sau khi chọn; không bắt buộc. Có dialog xác nhận thì xử lý ở bước sau.
    const dlg = await waitFor(() => [...dialogSet()][0], 1500);
    if (dlg) {
      const ok = await clickConfirm(dlg, CONFIG.labels.confirmGroups, "CONFIRM");
      if (ok) await waitDialogClosed(dlg, "CONFIRM");
    }
  }

  async function removePerson(uid) {
    const row = await rowFor(uid);
    const isSelf = uid === sessionUid();
    const notAvail = isSelf ? ERR.SELF_REMOVE_NOT_AVAILABLE : ERR.INSUFFICIENT_PERMISSION;

    // Tìm control Xóa trên dòng; nếu không có thì thử menu "…" của dòng
    let ctl = dedupeNested(controls(row).filter(c => labelEq(labelOf(c), CONFIG.labels.removeControl)));
    if (ctl.length > 1) throw new DriverError(ERR.UI_TARGET_AMBIGUOUS, `Dòng ${uid} có ${ctl.length} control Xóa.`, "REMOVE", diagnostics(row));
    if (!ctl.length) {
      const more = dedupeNested(controls(row).filter(c => labelEq(labelOf(c), CONFIG.labels.moreMenu) || (c.getAttribute("aria-haspopup") && !roleFromText(labelOf(c)))));
      if (more.length === 1) {
        const before = new Set([...document.querySelectorAll("[role=menu]")]);
        realClick(more[0]);
        const menu = await waitFor(() => [...document.querySelectorAll("[role=menu]")].filter(visible).find(m => !before.has(m)), CONFIG.timeouts.dialog);
        if (menu) ctl = dedupeNested(controls(menu).filter(c => labelEq(labelOf(c), CONFIG.labels.removeControl)));
      } else if (more.length > 1) {
        throw new DriverError(ERR.UI_TARGET_AMBIGUOUS, `Dòng ${uid} có ${more.length} menu "…" không phân biệt được.`, "REMOVE", diagnostics(row));
      }
    }
    if (ctl.length === 0) {
      // Jev fallback: chỉ trong phạm vi dòng của đúng UID này
      const viaJev = await askJev("REMOVE", "Locate the control that removes this person from the ad account (remove or delete).", dedupeNested(controls(row).filter(enabledControl)));
      if (viaJev) ctl = [viaJev];
    }
    if (ctl.length !== 1) {
      throw new DriverError(notAvail, isSelf ? "Facebook UI không cung cấp thao tác xóa cho chính Via này." : "Facebook UI không cung cấp thao tác xóa cho user này (có thể không đủ quyền).", "REMOVE", diagnostics(row));
    }

    log("info", "remove.control", { uid, self: isSelf, control: describe(ctl[0]) });
    const before = dialogSet();
    const beforeMenus = new Set([...document.querySelectorAll("[role=menu]")]);
    realClick(ctl[0]);
    // Control Jev chọn có thể là menu "…": nếu menu mới mở ra thì tìm mục Xóa trong đó
    const menuOpened = await waitFor(() => [...document.querySelectorAll("[role=menu]")].filter(visible).find(m => !beforeMenus.has(m)), 600);
    if (menuOpened && !dialogSet().size) {
      let item = dedupeNested(controls(menuOpened).filter(c => labelEq(labelOf(c), CONFIG.labels.removeControl)));
      if (item.length === 0) {
        const j = await askJev("REMOVE", "Locate the menu item that removes this person from the ad account.", dedupeNested(controls(menuOpened).filter(enabledControl)));
        if (j) item = [j];
      }
      if (item.length !== 1) throw new DriverError(notAvail, "Không tìm thấy mục Xóa trong menu của dòng.", "REMOVE", diagnostics(menuOpened));
      realClick(item[0]);
    }
    // Xác nhận nếu Facebook yêu cầu
    const dlg = await waitFor(() => [...dialogSet()].find(d => !before.has(d)), 3000);
    log("debug", "remove.confirm_dialog", { uid, present: !!dlg });
    if (dlg) {
      await assertContext(state.actId);
      const ok = await clickConfirm(dlg, [CONFIG.labels.removeConfirm], "CONFIRM");
      if (!ok) throw new DriverError(ERR.CONFIRM_NOT_AVAILABLE, "Không thấy nút xác nhận xóa.", "CONFIRM", diagnostics(dlg));
      await waitDialogClosed(dlg, "CONFIRM");
    }
  }

  async function settle() {
    await sleep(CONFIG.timeouts.settle);
    await waitFor(() => !document.querySelector("[role=progressbar][aria-busy=true],[aria-busy=true][role=progressbar]"), 5000);
  }

  // ============================================================
  // REMOVE_SELF VERIFICATION (docx §28)
  // ============================================================
  async function probeSelfRemoval(actId, selfUid) {
    const end = Date.now() + 12000;
    let last = { facebookConfirmed: null, accountGone: null, noAccess: null, stillInList: null };
    while (Date.now() < end) {
      const txt = pageText();
      const sig = { facebookConfirmed: null, accountGone: null, noAccess: null, stillInList: null };

      const dom = accountIdFromDom();
      if (dom && dom !== actId) sig.accountGone = true;
      if (anyMatch(CONFIG.labels.noAccessText, txt)) sig.noAccess = true;

      try {
        const roles = await readRoles();
        sig.stillInList = roles.some(r => r.uid === selfUid);
      } catch (e) {
        sig.stillInList = null; // không đọc được (có thể đã mất quyền)
      }
      // Toast xác nhận chỉ có giá trị khi không thấy SELF còn trong danh sách
      if (sig.stillInList !== true) {
        const alerts = [...document.querySelectorAll("[role=alert],[role=status]")].map(e => e.innerText || "").join(" ");
        if (anyMatch(CONFIG.labels.removedToast, alerts)) sig.facebookConfirmed = true;
      }
      last = sig;
      log("info", "self.probe", { signals: sig, ms_left: end - Date.now() });
      if (sig.stillInList === false || sig.accountGone || sig.noAccess || sig.facebookConfirmed) return sig;
      await sleep(600);
    }
    return last;
  }

  // ============================================================
  // DRIVER + MESSAGE HANDLER
  // ============================================================
  // Mọi lời gọi driver (do core gọi) đều được ghi: tham số, thời gian, kết quả hoặc lỗi + chẩn đoán.
  const summarizeDriverResult = {
    readRoles: r => ({ count: r.length, roles: r.map(x => ({ uid: x.uid, role: x.role, role_text: x.roleText })) })
  };
  function traced(name, fn) {
    return async (...args) => {
      const t0 = Date.now();
      log("debug", "driver." + name, { args });
      try {
        const r = await fn(...args);
        log("debug", "driver." + name + ".ok", { ms: Date.now() - t0, result: summarizeDriverResult[name] ? summarizeDriverResult[name](r) : r });
        return r;
      } catch (e) {
        log("warn", "driver." + name + ".error", { ms: Date.now() - t0, code: e && e.code, message: e && e.message, step: e && e.step, detail: e && e.detail });
        throw e;
      }
    };
  }
  const rawDriver = {
    getSessionState: async () => sessionState(),
    getSessionUid: async () => sessionUid(),
    openAccount,
    assertContext,
    readRoles,
    addPerson,
    changeRole,
    removePerson,
    settle,
    probeSelfRemoval
  };
  const driver = Object.fromEntries(Object.entries(rawDriver).map(([k, fn]) => [k, traced(k, fn)]));

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== "AMIT_EXECUTOR") return false;
    log("info", "cmd", { cmd: msg.cmd, item: msg.item ? { ad_account_id: msg.item.ad_account_id, action: msg.item.action, target_uids: msg.item.target_uids, role: msg.item.role, executor_uid: msg.item.executor_uid } : undefined });
    (async () => {
      try {
        switch (msg.cmd) {
          case "PING":
            sendResponse({ ok: true, url: location.href, session: sessionState(), uid: sessionUid() });
            break;
          case "RUN_ITEM": {
            jevLog.length = 0;
            knownNames.clear();
            // Ảnh chụp trang lúc bắt đầu: URL, tiêu đề, các control nhìn thấy (đã che tên) -> biết UI thật trông thế nào
            log("info", "page.snapshot", diagnostics(document.body, { session: sessionState(), page_uid: sessionUid(), account_dom: accountIdFromDom(), account_url: accountIdFromUrl() }));
            const result = await Core.runItem(driver, msg.item, { log });
            if (jevLog.length) result.jev = jevLog.slice(); // nhật ký mọi lần Jev được dùng trong item này
            sendResponse({ ok: true, result });
            break;
          }
          case "PROBE_SELF":
            sendResponse({ ok: true, signals: await probeSelfRemoval(msg.actId, msg.selfUid) });
            break;
          case "DIAG":
            sendResponse({ ok: true, diag: diagnostics(document.body, { session: sessionState(), uid: sessionUid(), accountDom: accountIdFromDom(), accountUrl: accountIdFromUrl() }) });
            break;
          default:
            sendResponse({ ok: false, error: "Lệnh không hợp lệ" });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    })();
    return true;
  });

  if (globalThis.__AMIT_TEST__) {
    globalThis.__AmitExecutorInternals = { CONFIG, driver, locate, uidFromHref, roleFromText, findRolesHeading, sectionBoxOf, readRolesWithRows, accountIdFromDom, sessionState, jevLog, askJev };
  }
})();
