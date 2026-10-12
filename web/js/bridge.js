/**
 * AMIT V1 - Extension Communication Bridge
 * Kết nối hai chiều giữa Web App và Chrome Extension.
 * Có cơ chế Mock Data dự phòng để Web App hoạt động độc lập ngay cả khi chưa nạp Extension.
 */

const AmitBridge = {
  extensionId: null,
  isExtensionAvailable: false,

  // Dữ liệu mẫu ban đầu khớp với Facebook thật trong ảnh
  INITIAL_MOCK_DATA: [
    {
      id: "1288013719961305",
      name: "Cà Tuấn",
      via: ["Cà Tuấn"],
      role: "Quản trị viên",
      disableReason: "—",
      status: "Hoạt động",
      statusCode: 1,
      origin: "100058927816176",
      bm: "BM 847201",
      balance: 0,
      limit: 1640156,
      limitStr: "1.640.156 VND",
      currency: "VND",
      country: "VN",
      timezone: "Asia/Ho_Chi_Minh",
      timezoneOffset: 7,
      pay: "Visa •••• 1820",
      card: "Có",
      admin: 2,
      partner: 1,
      note: "Ưu tiên",
      progress: "Chờ"
    },
    {
      id: "2603901939705585",
      name: "văn phi vô nướng 39",
      via: ["văn phi vô nướng 39"],
      role: "Quản trị viên",
      disableReason: "Chính sách (Policy)",
      status: "Vô hiệu hóa",
      statusCode: 2,
      origin: "100010788904014",
      bm: "Không thuộc BM",
      balance: 0,
      limit: 315.42,
      limitStr: "315.42 USD",
      currency: "USD",
      country: "US",
      timezone: "America/Los_Angeles",
      timezoneOffset: -8,
      pay: "—",
      card: "Có",
      admin: 1,
      partner: 0,
      note: "Cần kiểm tra",
      progress: "Chờ"
    },
    {
      id: "86851031",
      name: "văn phi vô nướng 5",
      via: ["văn phi vô nướng 5"],
      role: "Nhà quảng cáo",
      disableReason: "—",
      status: "Hoạt động",
      statusCode: 1,
      origin: "100000909653472",
      bm: "BM 88201",
      balance: 0,
      limit: 217.31,
      limitStr: "217.31 USD",
      currency: "USD",
      country: "VN",
      timezone: "Asia/Ho_Chi_Minh",
      timezoneOffset: 7,
      pay: "Mastercard •••• 4412",
      card: "Có",
      admin: 3,
      partner: 1,
      note: "",
      progress: "Chờ"
    },
    {
      id: "10009988776655",
      name: "Tài khoản đối tác Agency",
      via: ["Via Agency"],
      role: "Nhà phân tích quảng cáo",
      disableReason: "Thanh toán bất thường (Risk Payment)",
      status: "Nợ tiền / HOLD",
      statusCode: 3,
      origin: "10009900112233",
      bm: "BM 99201",
      balance: 550000,
      limit: 5000000,
      limitStr: "5.000.000 VND",
      currency: "VND",
      country: "VN",
      timezone: "Asia/Ho_Chi_Minh",
      timezoneOffset: 7,
      pay: "Visa •••• 9912",
      card: "Có",
      admin: 2,
      partner: 2,
      note: "Chờ verify",
      progress: "Chờ"
    }
  ],

  async init() {
    // Kiểm tra xem có đang chạy trong context của Chrome Extension không
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
      this.isExtensionAvailable = true;
      this.extensionId = chrome.runtime.id;
      console.log("[AMIT Bridge] Running inside Extension Context ID:", this.extensionId);
    } else {
      console.log("[AMIT Bridge] Running in Standalone Web Mode (Mock fallback ready)");
    }
    AmitApp.log(this.isExtensionAvailable ? "info" : "warn", "bridge.init", { extension: this.isExtensionAvailable, id: this.extensionId });

    // Nạp dữ liệu ban đầu nếu storage trống hoặc chuẩn hóa dữ liệu cũ
    const current = AmitStorage.getAccounts();
    if (!current || !current.length) {
      AmitStorage.saveAccounts(this.INITIAL_MOCK_DATA);
    } else {
      let modified = false;
      current.forEach(acc => {
        if (acc.id === "1288013719961305" && acc.name === "1288013719961305") {
          acc.name = "Cà Tuấn";
          modified = true;
        }
        if (!acc.role) {
          acc.role = "Quản trị viên";
          modified = true;
        }
      });
      if (modified) AmitStorage.saveAccounts(current);
    }
  },

  /**
   * Gửi message tới Extension Service Worker
   */
  async sendMessage(action, payload = {}) {
    if (!this.isExtensionAvailable) {
      return this.handleMockFallback(action, payload);
    }

    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ action, ...payload }, response => {
          if (chrome.runtime.lastError) {
            console.warn("[AMIT Bridge] Extension connection error, fallback to mock:", chrome.runtime.lastError.message);
            AmitApp.log("error", "bridge.connection_error", { action, error: chrome.runtime.lastError.message });
            resolve(this.handleMockFallback(action, payload));
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        AmitApp.log("error", "bridge.exception", { action, error: e });
        resolve(this.handleMockFallback(action, payload));
      }
    });
  },

  /**
   * Xử lý giả lập khi chưa kết nối Extension thật
   */
  handleMockFallback(action, payload) {
    console.log(`[AMIT Bridge Mock] Handling '${action}'`, payload);

    switch (action) {
      case "ping":
        return { success: true, message: "AMIT Mock Active" };

      case "discovery_accounts": {
        const stored = AmitStorage.getAccounts();
        return {
          success: true,
          data: stored,
          via: "10008812001",
          viaName: "Via Minh"
        };
      }

      // Thao tác ghi lên Facebook tuyệt đối không được giả lập thành công.
      case "execute_super_share_batch":
      case "get_execution_status":
        return { success: false, error: "EXTENSION_UNAVAILABLE" };

      default:
        return { success: true };
    }
  }
};
