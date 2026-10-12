/**
 * AMIT V1 - Token Provider (docx §9)
 *
 * - Cấp token THEO MỤC ĐÍCH (tokenPurpose -> slot). Super Share dùng `powerEditorAction` -> slot token_b.
 * - Mỗi token kèm user_id (đã xác minh bằng /me), obtained_at, expires_at, via_type, generation.
 * - Chỉ dùng lại token khi user_id == c_user hiện tại; nếu truyền expectedUid thì phải == chủ token (TOKEN_OWNER_MISMATCH).
 * - Cache nằm trong bộ nhớ service worker (không ghi thêm token ra storage). SW bị tắt -> cache mất -> resolve lại.
 * - generation: bumpGeneration() vô hiệu hóa cache và promise đang bay, token cũ không ghi đè cache mới.
 * - Token KHÔNG bao giờ rời service worker: provider chỉ được graph-client gọi.
 * - Trang đăng nhập / checkpoint / reauth -> ném FbError có pause=true (batch chuyển PAUSED).
 *
 * deps: {
 *   getCookie(name) -> Promise<string|null>,
 *   fetchPage(url)  -> Promise<{ url, status, text }>      // fetch credentials:"include", trả URL cuối sau redirect
 *   loadLegacySession() -> Promise<{ uid, accessToken }|null>   // token đã bóc bởi resolveFacebookSession (dự phòng)
 *   verifyOwner(token) -> Promise<string|null>             // GET /me?fields=id
 *   now(), log(level, event, data), ttlMs
 * }
 */
(function (root) {
  "use strict";

  const SLOT_BY_PURPOSE = Object.freeze({
    session: "session",
    powerEditorAction: "token_b",
    businessAction: "token_g",
    autoRead: "token_i",
    graphql: "token_graphql"
  });
  const SUPPORTED_SLOTS = Object.freeze(["token_b"]); // các slot khác: chưa có resolver, trả TOKEN_UNAVAILABLE rõ ràng
  const DEFAULT_TTL_MS = 50 * 60 * 1000;
  const ADS_MANAGER_PAGES = [
    "https://adsmanager.facebook.com/adsmanager/manage/accounts",
    "https://www.facebook.com/adsmanager/manage/accounts"
  ];

  /**
   * Chỉ chấp nhận token có nguồn rõ ràng (window.__accessToken của Ads Manager), KHÔNG bắt mọi chuỗi "EA...".
   */
  function extractAccessToken(html) {
    const m = String(html || "").match(/__accessToken["']?\s*[=:]\s*["'](EA[A-Za-z0-9]{20,})["']/);
    return m ? m[1] : null;
  }

  function create(deps) {
    const Err = () => root.AmitFbErrors;
    const now = deps.now || (() => Date.now());
    const log = deps.log || (() => {});
    const ttlMs = deps.ttlMs || DEFAULT_TTL_MS;
    const cache = new Map();
    const inflight = new Map();
    let generation = 1;

    const fail = (code, message, extra) => new (Err().FbError)(code, message, extra);

    async function resolveTokenB(uid) {
      let token = null;
      let viaType = null;

      for (const url of ADS_MANAGER_PAGES) {
        let page;
        try { page = await deps.fetchPage(url); } catch (e) { throw Err().classifyTransport(e, false); }
        const redirected = Err().classifyUrl(page.url);
        if (redirected) throw redirected;
        token = extractAccessToken(page.text);
        if (token) { viaType = "ads_manager"; break; }
      }

      if (!token && deps.loadLegacySession) {
        const legacy = await deps.loadLegacySession();
        if (legacy && legacy.accessToken && String(legacy.uid) === String(uid)) {
          token = legacy.accessToken;
          viaType = "legacy_session";
          log("warn", "token.legacy_fallback", { uid });
        }
      }
      if (!token) throw fail("TOKEN_UNAVAILABLE", "Không lấy được token Ads Manager (token_b). Mở Ads Manager một lần rồi thử lại.", { category: "session", pause: true });

      // Danh tính do Facebook xác nhận (không tin regex hay cache)
      const owner = await deps.verifyOwner(token);
      if (!owner) throw fail("TOKEN_UNAVAILABLE", "Không xác minh được chủ sở hữu của token.", { category: "session", pause: true });
      if (String(owner) !== String(uid)) {
        log("warn", "token.owner_mismatch", { cookie_uid: uid, token_uid: owner });
        throw fail("TOKEN_OWNER_MISMATCH", "Token không thuộc về tài khoản Facebook đang đăng nhập.", { category: "identity" });
      }
      return { token, user_id: String(owner), via_type: viaType };
    }

    async function get(purpose, opts) {
      opts = opts || {};
      const slot = SLOT_BY_PURPOSE[purpose];
      if (!slot) throw fail("TOKEN_UNAVAILABLE", `tokenPurpose không hợp lệ: ${purpose}`, { category: "input" });
      if (!SUPPORTED_SLOTS.includes(slot)) throw fail("TOKEN_UNAVAILABLE", `Slot ${slot} chưa được hỗ trợ cho Super Share.`, { category: "input" });

      const uid = await deps.getCookie("c_user");
      if (!uid) throw fail("SESSION_EXPIRED", "Chưa đăng nhập Facebook.", { category: "session", pause: true });
      if (opts.expectedUid && String(opts.expectedUid) !== String(uid)) {
        log("warn", "token.owner_mismatch", { expected_uid: opts.expectedUid, cookie_uid: uid });
        throw fail("TOKEN_OWNER_MISMATCH", "Facebook đang đăng nhập không khớp executor AMIT dự kiến.", { category: "identity" });
      }

      const key = `${slot}:${uid}`;
      const hit = cache.get(key);
      if (!opts.forceRefresh && hit && hit.generation === generation && hit.expires_at > now() && hit.user_id === String(uid)) {
        log("debug", "token.cache_hit", { slot, uid });
        return hit;
      }

      const flightKey = `${key}:${generation}`;
      if (!inflight.has(flightKey)) {
        const gen = generation;
        const p = resolveTokenB(uid).then(r => {
          const t = now();
          const entry = { slot, token: r.token, user_id: r.user_id, via_type: r.via_type, obtained_at: t, expires_at: t + ttlMs, generation: gen };
          if (gen === generation) cache.set(key, entry); // token của thế hệ cũ không ghi đè cache mới
          log("info", "token.refreshed", { slot, uid: r.user_id, via_type: r.via_type, ttl_s: Math.round(ttlMs / 1000) });
          return entry;
        }).finally(() => inflight.delete(flightKey));
        inflight.set(flightKey, p);
      }
      return inflight.get(flightKey);
    }

    /** Hủy đúng slot của purpose (khi Graph báo token lỗi). */
    function invalidate(purpose, seenGeneration) {
      const slot = SLOT_BY_PURPOSE[purpose];
      for (const [k, v] of cache) {
        if (v.slot === slot && (seenGeneration === undefined || v.generation === seenGeneration)) cache.delete(k);
      }
      log("info", "token.invalidated", { slot });
    }

    /** Chuyển VIA: vô hiệu hóa cache và các promise đang bay. */
    function bumpGeneration() {
      generation++;
      cache.clear();
      inflight.clear();
      return generation;
    }

    return { get, invalidate, bumpGeneration, get generation() { return generation; } };
  }

  const api = { create, extractAccessToken, SLOT_BY_PURPOSE, DEFAULT_TTL_MS };
  root.AmitTokenProvider = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
