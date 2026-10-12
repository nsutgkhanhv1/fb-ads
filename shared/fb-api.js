/**
 * AMIT V1 - Facebook API Client (Client-Side & Reverse-Engineered Endpoints)
 * Tích hợp toàn bộ API nội bộ & Graph API giải mã từ SMIT và FFB.
 */

const AmitFbApi = {
  GRAPH_URL: "https://graph.facebook.com/v19.0",
  GRAPHQL_URL: "https://adsmanager.facebook.com/api/graphql/",

  /**
   * Helper fetch có xử lý lỗi và JSON
   */
  async request(url, options = {}) {
    const config = {
      credentials: "include",
      headers: {
        "Accept": "application/json",
        ...(options.headers || {})
      },
      ...options
    };

    const res = await fetch(url, config);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  },

  /**
   * 1. Discovery: Quét toàn bộ danh sách TKQC của Via
   */
  async discoveryAccounts(accessToken, viaName = null, viaUid = null) {
    const fields = [
      "account_id",
      "name",
      "account_status",
      "disable_reason",
      "currency",
      "timezone_name",
      "timezone_offset_hours_utc",
      "balance",
      "amount_spent",
      "adspaymentcycle",
      "adtrust_dsl",
      "owner_business",
      "owner",
      "created_time",
      "next_bill_date",
      "userpermissions",
      "all_payment_methods{pm_credit_card{display_string,exp_month,exp_year,is_verified}}"
    ].join(",");

    const url = `${this.GRAPH_URL}/me/adaccounts?fields=${fields}&limit=1000&access_token=${accessToken}`;
    const res = await this.request(url);
    if (res.error) {
      throw new Error(res.error.message || "Lỗi discovery TKQC từ Facebook");
    }
    const rawList = res.data || [];
    return rawList.map(raw => this.transformFbAccount(raw, viaName, viaUid));
  },

  // Múi giờ IANA -> mã quốc gia (ISO 3166-1 alpha-2). Chỉ gồm các múi giờ phổ biến của TKQC; không có trong bảng thì không đoán.
  TZ_COUNTRY: {
    "Asia/Ho_Chi_Minh": "VN", "Asia/Saigon": "VN", "Asia/Bangkok": "TH", "Asia/Phnom_Penh": "KH", "Asia/Vientiane": "LA",
    "Asia/Yangon": "MM", "Asia/Rangoon": "MM", "Asia/Jakarta": "ID", "Asia/Makassar": "ID", "Asia/Jayapura": "ID",
    "Asia/Singapore": "SG", "Asia/Kuala_Lumpur": "MY", "Asia/Kuching": "MY", "Asia/Manila": "PH", "Asia/Brunei": "BN",
    "Asia/Shanghai": "CN", "Asia/Chongqing": "CN", "Asia/Urumqi": "CN", "Asia/Hong_Kong": "HK", "Asia/Macau": "MO",
    "Asia/Taipei": "TW", "Asia/Tokyo": "JP", "Asia/Seoul": "KR", "Asia/Kolkata": "IN", "Asia/Calcutta": "IN",
    "Asia/Dhaka": "BD", "Asia/Karachi": "PK", "Asia/Colombo": "LK", "Asia/Kathmandu": "NP", "Asia/Dubai": "AE",
    "Asia/Riyadh": "SA", "Asia/Qatar": "QA", "Asia/Kuwait": "KW", "Asia/Baghdad": "IQ", "Asia/Tehran": "IR",
    "Asia/Jerusalem": "IL", "Asia/Tel_Aviv": "IL", "Asia/Amman": "JO", "Asia/Beirut": "LB", "Asia/Tashkent": "UZ",
    "Asia/Almaty": "KZ", "Asia/Ulaanbaatar": "MN", "Asia/Baku": "AZ", "Asia/Tbilisi": "GE", "Asia/Yerevan": "AM",
    "Europe/London": "GB", "Europe/Dublin": "IE", "Europe/Paris": "FR", "Europe/Berlin": "DE", "Europe/Madrid": "ES",
    "Europe/Rome": "IT", "Europe/Amsterdam": "NL", "Europe/Brussels": "BE", "Europe/Vienna": "AT", "Europe/Zurich": "CH",
    "Europe/Stockholm": "SE", "Europe/Oslo": "NO", "Europe/Copenhagen": "DK", "Europe/Helsinki": "FI", "Europe/Warsaw": "PL",
    "Europe/Prague": "CZ", "Europe/Budapest": "HU", "Europe/Bucharest": "RO", "Europe/Sofia": "BG", "Europe/Athens": "GR",
    "Europe/Lisbon": "PT", "Europe/Kiev": "UA", "Europe/Kyiv": "UA", "Europe/Moscow": "RU", "Europe/Istanbul": "TR",
    "Europe/Belgrade": "RS", "Europe/Zagreb": "HR", "Europe/Vilnius": "LT", "Europe/Riga": "LV", "Europe/Tallinn": "EE",
    "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US", "America/Phoenix": "US", "America/Los_Angeles": "US",
    "America/Anchorage": "US", "America/Detroit": "US", "America/Boise": "US", "Pacific/Honolulu": "US",
    "America/Toronto": "CA", "America/Vancouver": "CA", "America/Edmonton": "CA", "America/Winnipeg": "CA", "America/Halifax": "CA",
    "America/Mexico_City": "MX", "America/Monterrey": "MX", "America/Bogota": "CO", "America/Lima": "PE", "America/Santiago": "CL",
    "America/Caracas": "VE", "America/Sao_Paulo": "BR", "America/Argentina/Buenos_Aires": "AR", "America/Buenos_Aires": "AR",
    "America/Montevideo": "UY", "America/Guayaquil": "EC", "America/Panama": "PA", "America/Costa_Rica": "CR",
    "America/Santo_Domingo": "DO", "America/Puerto_Rico": "PR", "America/Jamaica": "JM",
    "Australia/Sydney": "AU", "Australia/Melbourne": "AU", "Australia/Brisbane": "AU", "Australia/Perth": "AU",
    "Australia/Adelaide": "AU", "Australia/Darwin": "AU", "Australia/Hobart": "AU", "Pacific/Auckland": "NZ",
    "Pacific/Fiji": "FJ", "Pacific/Port_Moresby": "PG",
    "Africa/Lagos": "NG", "Africa/Cairo": "EG", "Africa/Johannesburg": "ZA", "Africa/Nairobi": "KE", "Africa/Casablanca": "MA",
    "Africa/Algiers": "DZ", "Africa/Tunis": "TN", "Africa/Accra": "GH", "Africa/Addis_Ababa": "ET", "Africa/Dar_es_Salaam": "TZ",
    "Africa/Kampala": "UG", "Africa/Kinshasa": "CD", "Africa/Abidjan": "CI", "Africa/Dakar": "SN"
  },

  countryFromTimezone(tzName) {
    if (!tzName) return null;
    return this.TZ_COUNTRY[String(tzName)] || null;
  },

  /**
   * Chuyển đổi dữ liệu thô Facebook sang cấu trúc bảng chuẩn AMIT V1
   */
  transformFbAccount(raw, viaName, viaUid) {
    const cur = raw.currency || "USD";
    const isNonCent = ["VND", "IDR", "KRW", "JPY", "TWD", "PYG"].includes(cur);

    // Trạng thái TKQC
    const statusMap = {
      1: "Hoạt động",
      2: "Vô hiệu hóa",
      3: "Nợ tiền / HOLD",
      7: "Chờ duyệt rủi ro",
      8: "Chờ thanh toán",
      9: "Thời gian ân hạn",
      100: "Chờ đóng",
      101: "Đã đóng"
    };
    const statusLabel = statusMap[raw.account_status] || "Hoạt động";

    // 1. Quyền trong TKQC (Quản trị viên / Nhà quảng cáo / Nhà phân tích quảng cáo)
    let userRole = raw.role || "Quản trị viên";
    let hasRealPerms = !!raw.role;
    const perms = raw.userpermissions?.data || raw.userpermissions || [];
    if (Array.isArray(perms) && perms.length > 0) {
      hasRealPerms = true;
      let matchedPerm = null;
      if (viaUid) {
        matchedPerm = perms.find(p => (p.user?.id || p.id || p.uid) == viaUid);
      }
      if (!matchedPerm) matchedPerm = perms[0];

      const r = matchedPerm?.role || matchedPerm?.key || "";
      const tasks = matchedPerm?.tasks || [];

      if (r === "ADMINISTER" || r === "ADMIN" || r === 1001 || tasks.includes("MANAGE")) {
        userRole = "Quản trị viên";
      } else if (r === "GENERAL_USER" || r === "ADVERTISER" || r === 1002 || tasks.includes("ADVERTISE")) {
        userRole = "Nhà quảng cáo";
      } else if (r === "REPORTS_ONLY" || r === "ANALYST" || r === 1003 || tasks.includes("ANALYZE")) {
        userRole = "Nhà phân tích quảng cáo";
      }
    }

    // 2. Lý do khóa (Disable Reason)
    let disableReasonStr = "—";
    if (raw.account_status !== 1) {
      const dCode = raw.disable_reason;
      const reasonMap = {
        0: "—",
        1: "Chính sách (Policy)",
        2: "Xem xét IP",
        3: "Thanh toán bất thường (Risk Payment)",
        4: "Vi phạm nghiêm trọng",
        5: "Xét duyệt gian lận",
        6: "Bảo mật doanh nghiệp",
        7: "Đã đóng vĩnh viễn",
        8: "Không hoạt động lâu ngày"
      };

      if (dCode !== undefined && dCode !== null && reasonMap[dCode]) {
        disableReasonStr = reasonMap[dCode];
      } else if (raw.account_status === 2) {
        disableReasonStr = "Chính sách quảng cáo";
      } else if (raw.account_status === 3) {
        disableReasonStr = "Nợ tiền / HOLD thẻ";
      } else if (raw.account_status === 7) {
        disableReasonStr = "Chờ xét duyệt rủi ro";
      }
    }

    // Ngưỡng
    const threshRaw = raw.adspaymentcycle?.data?.[0]?.threshold_amount;
    const thresh = threshRaw ? (isNonCent ? threshRaw : threshRaw / 100) : null;

    // Số dư
    const balRaw = raw.balance;
    const balance = balRaw ? (isNonCent ? balRaw : balRaw / 100) : 0;

    // Limit ngày
    let limitVal = "—";
    let limitStr = "No limit";
    if (raw.adtrust_dsl !== undefined && raw.adtrust_dsl !== null) {
      if (raw.adtrust_dsl === -1) {
        limitVal = "No limit";
        limitStr = "No limit";
      } else {
        limitVal = raw.adtrust_dsl;
        limitStr = `${Number(raw.adtrust_dsl).toLocaleString("vi-VN")} ${cur}`;
      }
    }

    // Thẻ thanh toán
    const cardObj = raw.all_payment_methods?.pm_credit_card;
    const cardStr = cardObj?.display_string || "—";
    const hasCard = !!cardObj;

    // SL Admin
    const adminCount = Array.isArray(perms)
      ? perms.filter(p => p.role === "ADMINISTER" || p.role === 1001 || p.key === "ADMINISTER" || (p.tasks && p.tasks.includes("MANAGE"))).length || 1
      : 1;

    const actId = String(raw.account_id || raw.id || "").replace(/^act_/, "");

    // 3. Tên tài khoản thực tế (Account Name) & Tên Via cầm
    const accName = raw.name || `TKQC ${actId}`;

    let viaList = [];
    if (Array.isArray(raw.via) && raw.via.length > 0) {
      viaList = [...raw.via];
    } else if (raw.via) {
      viaList = [raw.via];
    } else if (viaName) {
      viaList = [viaName];
    } else {
      viaList = [`Via ${viaUid || "Chính"}`];
    }

    // UID Facebook của Via đang giữ TKQC: Super Share dùng làm executor_uid (docx §26)
    const viaUids = Array.isArray(raw.viaUids) && raw.viaUids.length
      ? raw.viaUids.map(String)
      : (viaUid ? [String(viaUid)] : []);

    return {
      id: actId,
      name: accName,
      via: viaList,
      viaUids,
      role: userRole,
      hasRealPerms,
      disableReason: disableReasonStr,
      status: statusLabel,
      statusCode: raw.account_status || 1,
      origin: raw.owner || "—",
      bm: raw.owner_business?.name || (raw.owner_business?.id ? `BM ${raw.owner_business.id}` : "Không thuộc BM"),
      balance: balance,
      limit: limitVal,
      limitStr: limitStr,
      threshold: thresh,
      currency: cur,
      // Quốc gia SUY RA từ múi giờ (không phải quốc gia của doanh nghiệp). Múi giờ lạ/thiếu -> null (hiển thị "—"), không đoán.
      country: this.countryFromTimezone(raw.timezone_name),
      // Múi giờ của TKQC (Facebook trả tên IANA + độ lệch giờ so với UTC)
      timezone: raw.timezone_name || null,
      timezoneOffset: (raw.timezone_offset_hours_utc !== undefined && raw.timezone_offset_hours_utc !== null) ? Number(raw.timezone_offset_hours_utc) : null,
      pay: cardStr,
      card: hasCard ? "Có" : "Không",
      admin: adminCount,
      partner: 0,
      note: "",
      progress: "Chờ"
    };
  },

  /**
   * 2. Inspect 1 TKQC chi tiết
   */
  async inspectAccount(accountId, accessToken) {
    const cleanId = accountId.toString().replace(/^act_/, "");
    const fields = [
      "balance",
      "owner_business",
      "owner",
      "name",
      "account_id",
      "account_status",
      "currency",
      "adspaymentcycle",
      "adtrust_dsl",
      "created_time",
      "next_bill_date",
      "timezone_name",
      "timezone_offset_hours_utc",
      "insights.date_preset(maximum){spend}",
      "all_payment_methods{pm_credit_card{display_string,exp_month,exp_year,is_verified}}",
      "userpermissions"
    ].join(",");

    const url = `${this.GRAPH_URL}/act_${cleanId}?fields=${fields}&access_token=${accessToken}`;
    const res = await this.request(url);
    if (res.error) {
      throw new Error(res.error.message);
    }
    return res;
  },

  /**
   * 3. Lấy Limit ẩn (Formatted DSL) qua GraphQL nội bộ
   * Doc ID giải mã từ SMIT & FFB: 6401661393282937
   */
  async getFormattedDsl(accountId, fbDtsg) {
    const cleanId = accountId.toString().replace(/^act_/, "");
    const body = new URLSearchParams({
      fb_dtsg: fbDtsg,
      doc_id: "6401661393282937",
      variables: JSON.stringify({ assetID: cleanId }),
      locale: "en_US"
    });

    const res = await this.request(this.GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });

    const data = res?.data?.billable_account_by_asset_id;
    return {
      formattedDsl: data?.formatted_dsl || null,
      balance: data?.account_balance || null,
      currency: data?.currency || null
    };
  },

  /**
   * 4. Lấy danh sách thẻ thanh toán chi tiết qua GraphQL
   * Doc ID giải mã: 5746473718752934
   */
  async getPaymentCards(accountId, fbDtsg) {
    const cleanId = accountId.toString().replace(/^act_/, "");
    const body = new URLSearchParams({
      fb_dtsg: fbDtsg,
      doc_id: "5746473718752934",
      variables: JSON.stringify({ paymentAccountID: cleanId }),
      locale: "en_US"
    });

    const res = await this.request(this.GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });

    const methods = res?.data?.billable_account_by_payment_account?.billing_payment_account?.billing_payment_methods || [];
    return methods.map(m => ({
      isPrimary: !!m.is_primary,
      association: m.credential?.card_association_name || "",
      last4: m.credential?.last_four_digits || "",
      cardId: m.credential_id || ""
    }));
  },

  /**
   * 5. Lấy danh sách users có quyền trên TKQC
   */
  async getAccountUsers(accountId, accessToken) {
    const cleanId = accountId.toString().replace(/^act_/, "");
    const url = `${this.GRAPH_URL}/act_${cleanId}/users?access_token=${accessToken}`;
    const res = await this.request(url);
    if (res.error) {
      if (res.error.code === 200 || res.error.code === 10) {
        throw new Error("NOT_ENOUGH_PERM");
      }
      throw new Error(res.error.message);
    }
    return res.data || [];
  }
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = AmitFbApi;
}
