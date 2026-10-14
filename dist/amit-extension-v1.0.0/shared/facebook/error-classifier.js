/**
 * AMIT V1 - Facebook error classifier (docx "Định hướng kiến trúc AMIT Super Share" §12)
 *
 * Chuẩn hóa MỌI lỗi từ Graph / mạng / trang đăng nhập thành FbError có:
 *   error_code (khớp ERR của super-share-core), category, retryable, pause, fallback_allowed.
 *
 * LƯU Ý về nguồn gốc: mã lỗi Graph (4, 17, 32, 190, 200-299 ...) là mã công khai của Meta; còn các mẫu
 * thông báo dùng để nhận ra "target không đủ điều kiện" / "TKQC không tồn tại" là SUY ĐOÁN từ hành vi quan sát
 * được. Mẫu lạ -> FACEBOOK_GRAPH_ERROR (không fallback, không đoán). Cần chỉnh khi có log thật.
 *
 * Rate limit: Graph báo qua MÃ LỖI trong body (thường HTTP 200/400), KHÔNG chỉ HTTP 429.
 */
(function (root) {
  "use strict";

  // category -> hành vi
  //   input | identity | session | permission | account | target | rate_limit | temporary | ambiguous | contract | token
  class FbError extends Error {
    constructor(error_code, message, extra) {
      super(message || error_code);
      this.name = "FbError";
      this.error_code = error_code;
      this.code = error_code; // tương thích DriverError
      Object.assign(this, { category: "contract", retryable: false, pause: false, fallback_allowed: false, ambiguous: false }, extra || {});
    }
  }

  // Mã Graph báo giới hạn tốc độ / quá tải (công khai trong tài liệu lỗi của Meta)
  const RATE_CODES = new Set([4, 17, 32, 341, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);
  // 1 = unknown, 2 = service temporarily unavailable
  const TEMPORARY_CODES = new Set([1, 2]);

  const TARGET_RE = /(invalid|not (a )?valid|unknown|không hợp lệ)[^.]{0,30}(user|uid|người dùng)|(user|uid|người dùng)[^.]{0,40}(not eligible|ineligible|cannot be (added|assigned|shared)|not found|does not exist|not part of|not a (friend|member))/i;
  const ACCOUNT_RE = /(act_\d+|ad account|tài khoản quảng cáo)[^.]{0,80}(does not exist|cannot be loaded|not exist|missing permissions)|unsupported (get|post|delete) request/i;
  const CHECKPOINT_RE = /checkpoint/i;

  function pick(error) {
    const e = error || {};
    return {
      graph_code: typeof e.code === "number" ? e.code : (e.code !== undefined ? Number(e.code) : null),
      graph_subcode: e.error_subcode !== undefined ? Number(e.error_subcode) : null,
      fbtrace_id: e.fbtrace_id || null,
      message: String(e.error_user_msg || e.message || "Facebook Graph error")
    };
  }

  /** Lỗi do Graph trả trong body: { error: { message, type, code, error_subcode, fbtrace_id } } */
  function classifyGraphError(status, error, headers) {
    const g = pick(error);
    const base = { http_status: status || null, graph_code: g.graph_code, graph_subcode: g.graph_subcode, fbtrace_id: g.fbtrace_id };
    const msg = g.message;
    const code = g.graph_code;

    if (status === 429 || RATE_CODES.has(code)) {
      let retryAfter = null;
      const h = headers && (typeof headers.get === "function" ? headers.get("retry-after") : headers["retry-after"]);
      if (h && Number.isFinite(Number(h))) retryAfter = Number(h) * 1000;
      return new FbError("RATE_LIMITED", msg, Object.assign(base, { category: "rate_limit", retryable: true, pause: true, retry_after_ms: retryAfter }));
    }
    if (code === 190 || code === 102) {
      if (g.graph_subcode === 459 || CHECKPOINT_RE.test(msg)) {
        return new FbError("FACEBOOK_CHECKPOINT", msg, Object.assign(base, { category: "session", pause: true }));
      }
      if (g.graph_subcode === 460 || g.graph_subcode === 458) {
        // 460: đổi mật khẩu / phiên bị hủy; 458: app chưa được cấp quyền -> cần đăng nhập / cấp lại
        return new FbError("FACEBOOK_REAUTH_REQUIRED", msg, Object.assign(base, { category: "session", pause: true }));
      }
      // 190 chung (hết hạn / không hợp lệ): graph-client invalidate token rồi thử lại đúng một lần
      return new FbError("SESSION_EXPIRED", msg, Object.assign(base, { category: "token", pause: true }));
    }
    if (code === 10 || (code >= 200 && code <= 299)) {
      return new FbError("INSUFFICIENT_PERMISSION", msg, Object.assign(base, { category: "permission" }));
    }
    if (code === 100 || code === 803 || code === 33) {
      if (ACCOUNT_RE.test(msg) || g.graph_subcode === 33) {
        return new FbError("ACCOUNT_NOT_FOUND", msg, Object.assign(base, { category: "account" }));
      }
      if (TARGET_RE.test(msg)) {
        return new FbError("TARGET_NOT_ELIGIBLE", msg, Object.assign(base, { category: "target", fallback_allowed: true }));
      }
      return new FbError("FACEBOOK_GRAPH_ERROR", msg, Object.assign(base, { category: "contract" }));
    }
    if (TEMPORARY_CODES.has(code) || (status && status >= 500)) {
      return new FbError("FACEBOOK_GRAPH_ERROR", msg, Object.assign(base, { category: "temporary", retryable: true, ambiguous: true }));
    }
    return new FbError("FACEBOOK_GRAPH_ERROR", msg, Object.assign(base, { category: "contract" }));
  }

  /** HTTP không có body lỗi Graph hợp lệ. */
  function classifyHttp(status, headers) {
    if (status === 429) return classifyGraphError(429, { message: "HTTP 429" }, headers);
    if (status >= 500) return new FbError("FACEBOOK_GRAPH_ERROR", `HTTP ${status}`, { category: "temporary", retryable: true, ambiguous: true, http_status: status });
    return new FbError("GRAPH_RESPONSE_INVALID", `HTTP ${status} không có body Graph hợp lệ.`, { category: "contract", http_status: status });
  }

  function classifyTransport(err, timedOut) {
    if (timedOut || (err && err.name === "AbortError")) {
      return new FbError("REQUEST_TIMEOUT", "Hết thời gian chờ phản hồi từ Facebook.", { category: "ambiguous", retryable: true, ambiguous: true });
    }
    return new FbError("NETWORK_ERROR", err && err.message ? err.message : "Lỗi mạng.", { category: "ambiguous", retryable: true, ambiguous: true });
  }

  /** URL cuối cùng của một trang Facebook: login / checkpoint / reauth -> FbError (pause), ngược lại null. */
  function classifyUrl(url) {
    const u = String(url || "");
    if (/facebook\.com\/(checkpoint|checkpoint\/)/i.test(u)) return new FbError("FACEBOOK_CHECKPOINT", "Facebook yêu cầu xác minh bảo mật (checkpoint).", { category: "session", pause: true });
    if (/facebook\.com\/(sensitive_action|two_step_verification|reauth|login\/reauth)/i.test(u) || /[?&]next=.*reauth/i.test(u)) {
      return new FbError("FACEBOOK_REAUTH_REQUIRED", "Facebook yêu cầu xác thực lại.", { category: "session", pause: true });
    }
    if (/facebook\.com\/(login|recover)/i.test(u)) return new FbError("SESSION_EXPIRED", "Facebook yêu cầu đăng nhập lại.", { category: "session", pause: true });
    return null;
  }

  const api = { FbError, classifyGraphError, classifyHttp, classifyTransport, classifyUrl, RATE_CODES };
  root.AmitFbErrors = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
