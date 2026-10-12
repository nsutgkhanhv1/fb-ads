/**
 * SPIKE 2 — Add People có tìm được bằng UID không? + đọc UID của session hiện tại (§21, §26)
 * CHỈ ĐỌC: script chỉ gõ UID vào ô tìm kiếm và đọc kết quả. KHÔNG click gì, KHÔNG thêm ai.
 *
 * CÁCH CHẠY (trang Ads Manager đã đăng nhập, F12 -> Console):
 *   1. Mở https://adsmanager.facebook.com/adsmanager/manage/ad_account_settings/ ... và chọn đúng TKQC test.
 *   2. Dán toàn bộ file này vào Console (sẽ tạo đối tượng window.amitSpike2).
 *   3. await amitSpike2.sessionUid()        // đọc UID của session bằng nhiều cách, xem có khớp không
 *   4. await amitSpike2.dumpRoles()          // in các dòng trong mục "Vai trò trên tài khoản quảng cáo"
 *   5. Tự bấm "Thêm người" / "Add people" để mở hộp thoại (script không tự bấm).
 *   6. await amitSpike2.searchUid("UID_CUA_B")   // B phải là bạn bè của Via đang đăng nhập
 *      (lặp lại với 1 UID KHÔNG phải bạn bè và 1 UID sai để so sánh nếu muốn)
 *   7. Đóng hộp thoại bằng nút Hủy/Đóng của Facebook (đừng bấm Xác nhận).
 * Mỗi hàm tự in JSON và copy vào clipboard; dán kết quả lại cho tôi.
 */
(() => {
  const mask = id => (id && String(id).length > 6 ? `${String(id).slice(0, 3)}…${String(id).slice(-3)}` : String(id));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const emit = (name, obj) => {
    const text = JSON.stringify(obj, null, 2);
    console.log(`[spike2:${name}]\n${text}`);
    try { copy(text); console.log("(Đã copy vào clipboard)"); } catch {}
    return obj;
  };

  // ---- 3. UID của session ----
  async function sessionUid() {
    const html = document.documentElement.outerHTML;
    const methods = {};
    const m1 = document.cookie.match(/(?:^|; )c_user=(\d+)/);
    methods.cookie_c_user = m1 ? m1[1] : null;
    try {
      methods.require_CurrentUserInitialData = (typeof require === "function" && require("CurrentUserInitialData")?.USER_ID) || null;
    } catch { methods.require_CurrentUserInitialData = null; }
    const m2 = html.match(/"USER_ID":"(\d+)"/);
    methods.html_USER_ID = m2 ? m2[1] : null;
    const m3 = html.match(/"actorID":"(\d+)"/);
    methods.html_actorID = m3 ? m3[1] : null;
    const m4 = html.match(/"ACCOUNT_ID":"(\d+)"/);
    methods.html_ACCOUNT_ID = m4 ? m4[1] : null;

    const found = Object.entries(methods).filter(([, v]) => v && v !== "0");
    const distinct = [...new Set(found.map(([, v]) => String(v)))];
    return emit("sessionUid", {
      page: location.href.split("?")[0],
      methods: Object.fromEntries(Object.entries(methods).map(([k, v]) => [k, v ? mask(v) : null])),
      distinctValues: distinct.map(mask),
      allAgree: distinct.length === 1,
      verdict: distinct.length === 1
        ? "Đọc được UID session và các cách khớp nhau."
        : (distinct.length === 0 ? "KHÔNG đọc được UID session bằng cách nào -> destructive action phụ thuộc SELF bị chặn (§26)." : "Các cách trả UID khác nhau -> không tin cậy, cần xem lại.")
    });
  }

  // ---- 4. Mục vai trò ----
  function dumpRoles() {
    const heading = [...document.querySelectorAll("*")].find(e =>
      e.children.length === 0 && /^(Vai trò trên tài khoản quảng cáo|Ad account roles)$/i.test((e.textContent || "").trim()));
    if (!heading) {
      return emit("dumpRoles", { found: false, note: "Không thấy tiêu đề mục. Kiểm tra đã ở trang Cài đặt tài khoản quảng cáo và đúng TKQC chưa." });
    }
    // Đi lên đến khối chứa nhiều dòng hơn tiêu đề
    let box = heading;
    for (let i = 0; i < 8 && box.parentElement; i++) {
      box = box.parentElement;
      if (box.innerText && box.innerText.split("\n").length > 6) break;
    }
    const lines = box.innerText.split("\n").map(s => s.trim()).filter(Boolean).slice(0, 80);
    const links = [...box.querySelectorAll("a[href]")].map(a => a.getAttribute("href")).filter(Boolean).slice(0, 40);
    const buttons = [...box.querySelectorAll("[role=button], button")].map(b => (b.innerText || b.getAttribute("aria-label") || "").trim()).filter(Boolean).slice(0, 40);
    const idsInMarkup = [...new Set((box.outerHTML.match(/\b\d{9,17}\b/g) || []))].slice(0, 30).map(mask);
    return emit("dumpRoles", {
      found: true,
      headingTag: heading.tagName,
      lineCount: lines.length,
      lines: lines.map(l => (/\d{9,}/.test(l) ? l.replace(/\d{9,}/g, mask) : l)),
      linkSamples: links.map(h => h.replace(/\d{9,}/g, mask)),
      buttons,
      numericIdsFoundInMarkup: idsInMarkup,
      note: "numericIdsFoundInMarkup cho biết UID của từng dòng có nằm trong DOM hay không (cần cho nhận diện row bằng UID)."
    });
  }

  // ---- 6. Tìm bằng UID ----
  async function searchUid(uid) {
    if (!/^\d+$/.test(String(uid))) return emit("searchUid", { error: "UID chỉ gồm số." });

    const dialogs = [...document.querySelectorAll("[role=dialog]")].filter(visible);
    if (!dialogs.length) {
      return emit("searchUid", { error: "Chưa thấy hộp thoại nào đang mở. Hãy tự bấm 'Thêm người' / 'Add people' trước." });
    }
    const dlg = dialogs[dialogs.length - 1];
    const inputs = [...dlg.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), [contenteditable=true], [role=combobox], [role=searchbox]")].filter(visible);
    if (!inputs.length) {
      return emit("searchUid", { error: "Hộp thoại không có ô nhập nào.", dialogText: dlg.innerText.slice(0, 600) });
    }
    const input = inputs[0];
    const before = dlg.innerText;

    // Gõ giá trị theo cách React nhận biết được
    input.focus();
    if (input.isContentEditable) {
      input.textContent = String(uid);
    } else {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, String(uid));
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "0" }));

    // Chờ kết quả tối đa ~6s, dừng khi nội dung hộp thoại thay đổi và ổn định
    let last = dlg.innerText;
    let stable = 0;
    for (let i = 0; i < 24 && stable < 3; i++) {
      await sleep(250);
      const cur = dlg.innerText;
      if (cur !== last) { stable = 0; last = cur; } else if (cur !== before) { stable++; }
    }

    const opts = [...dlg.querySelectorAll("[role=option], [role=listbox] > *, [role=listitem], [role=row], li")].filter(visible);
    const results = opts.slice(0, 10).map(o => {
      const html = o.outerHTML;
      return {
        text: (o.innerText || "").trim().replace(/\d{9,}/g, mask).slice(0, 120),
        uidInMarkup: html.includes(String(uid)),
        hasLink: !!o.querySelector("a[href]"),
        hrefSample: (o.querySelector("a[href]")?.getAttribute("href") || "").replace(/\d{9,}/g, mask).slice(0, 80),
        imgAlt: o.querySelector("img")?.getAttribute("alt") || null
      };
    });

    const afterText = dlg.innerText;
    const out = {
      uidTested: mask(uid),
      inputsFound: inputs.length,
      dialogChangedAfterTyping: afterText !== before,
      resultCount: results.length,
      anyResultContainsUidInMarkup: results.some(r => r.uidInMarkup),
      results,
      dialogTextAfter: afterText.replace(/\d{9,}/g, mask).slice(0, 700),
      verdict: results.length === 0
        ? "Không thấy kết quả cho UID này -> theo §21 CASE B: KHÔNG tự đổi sang tìm tên."
        : (results.some(r => r.uidInMarkup)
            ? "CASE A: có kết quả và markup chứa đúng UID -> xác nhận được đúng người."
            : "Có kết quả nhưng KHÔNG thấy UID trong markup -> chưa đủ căn cứ để xác nhận đúng người (xem text/ảnh)."),
      note: "Script không bấm gì. Hãy tự đóng hộp thoại bằng nút Hủy/Đóng."
    };

    // Dọn ô nhập để không để lại giá trị
    if (input.isContentEditable) input.textContent = "";
    else Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));

    return emit("searchUid", out);
  }

  window.amitSpike2 = { sessionUid, dumpRoles, searchUid };
  console.log("amitSpike2 sẵn sàng: sessionUid(), dumpRoles(), searchUid('UID'). Xem hướng dẫn ở đầu file.");
})();
