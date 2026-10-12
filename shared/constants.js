/**
 * AMIT V1 - Shared Constants
 * Hằng số dùng chung giữa Extension và Web App (phần Ads Check).
 *
 * Action / role / mã lỗi / giới hạn của Super Share KHÔNG nằm ở đây:
 * nguồn sự thật duy nhất là shared/super-share-core.js (AmitSuperShareCore).
 */

const AMIT_CONSTANTS = {
  APP_NAME: "AMIT V1",
  VERSION: "1.0.0",

  // Trạng thái tài khoản Facebook Ads
  ACCOUNT_STATUS: {
    1: { code: "ACTIVE", label: "Hoạt động", badgeClass: "status-active" },
    2: { code: "DISABLED", label: "Vô hiệu hóa", badgeClass: "status-disabled" },
    3: { code: "UNSETTLED", label: "Nợ tiền / HOLD", badgeClass: "status-hold" },
    7: { code: "PENDING_RISK_REVIEW", label: "Chờ duyệt rủi ro", badgeClass: "status-risk" },
    8: { code: "PENDING_SETTLEMENT", label: "Chờ thanh toán", badgeClass: "status-pending" },
    9: { code: "IN_GRACE_PERIOD", label: "Thời gian ân hạn", badgeClass: "status-grace" },
    100: { code: "PENDING_CLOSURE", label: "Chờ đóng", badgeClass: "status-closure" },
    101: { code: "CLOSED", label: "Đã đóng", badgeClass: "status-closed" }
  },

  // Danh sách tiền tệ không dùng đơn vị cent (chia 1)
  NON_CENT_CURRENCIES: [
    "VND", "IDR", "KRW", "JPY", "TWD", "PYG", "CLP", "COP", "CRC", "HUF", "ISK"
  ]
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = AMIT_CONSTANTS;
}
