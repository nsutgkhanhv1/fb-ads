const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const ROOT = (process.argv[2] || require("path").resolve(__dirname, ".."));
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  -> " + JSON.stringify(extra).slice(0, 400))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const html = fs.readFileSync(path.join(ROOT, "web/index.html"), "utf8").replace(/<script src="[^"]+"><\/script>/g, "");
const scripts = ["shared/constants.js", "shared/super-share-core.js", "web/js/storage.js", "web/js/bridge.js", "web/js/ads-table.js", "web/js/super-share.js", "web/js/app.js"]
  .map(f => fs.readFileSync(path.join(ROOT, f), "utf8"));

(async () => {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://localhost/web/index.html", pretendToBeVisual: true });
  const w = dom.window;
  const sent = [];
  let batchState = null;
  let engine = "dom";                       // engine do extension báo về (get_super_share_engine)
  let previewReply = () => ({ success: false }); // trả lời super_share_preview
  w.chrome = {
    runtime: {
      id: "test-ext",
      onMessage: { addListener() {} },
      sendMessage(msg, cb) {
        sent.push(msg);
        const reply = (() => {
          switch (msg.action) {
            case "get_execution_status": return { success: true, batch: batchState };
            case "ensure_session": case "get_active_session": return { success: true, session: { uid: "100000000000001", userName: "Via Minh" } };
            case "execute_super_share_batch": return handleExec(msg);
            case "resume_batch": return { success: true };
            case "get_super_share_engine": return { ok: true, engine };
            case "super_share_preview": return previewReply(msg);
            case "retry_failed": return { success: true, batch: mkBatch([{ id: "222", status: "RUNNING" }], "RUNNING") };
            default: return { success: true };
          }
        })();
        if (cb) cb(reply);
      }
    }
  };
  const mkItem = (id, status, extra) => Object.assign({ ad_account_id: id, action: "SHARE_USER", status, target_uids: ["5"], targets: [], error_code: null, error_message: null }, extra);
  const mkBatch = (list, status, extra) => Object.assign({ id: "b1", status, pause_reason: null, total: list.length, processed: list.filter(i => ["SUCCESS", "FAILED"].includes(i.status)).length,
    success: list.filter(i => i.status === "SUCCESS").length, failed: list.filter(i => i.status === "FAILED").length, items: list.map(i => mkItem(i.id, i.status, i)) }, extra);
  function handleExec(msg) { batchState = mkBatch(msg.items.map(i => ({ id: i.ad_account_id, status: "PENDING" })), "RUNNING"); return { success: true, batchId: "b1", batch: batchState }; }

  w.eval(scripts.join("\n;\n") + "\nwindow.__G={AmitBridge,AmitStorage,AmitSuperShare,AmitAdsTable,AmitApp};");
  const { AmitBridge, AmitStorage, AmitSuperShare, AmitAdsTable } = w.__G;
  await AmitBridge.init();
  // Dữ liệu: 3 TKQC
  AmitStorage.saveAccounts([
    { id: "111", name: "A", via: ["Via Minh"], viaUids: ["100000000000001"], role: "Quản trị viên", status: "Hoạt động" },
    { id: "222", name: "B", via: ["Via Minh"], viaUids: ["100000000000001"], role: "Quản trị viên", status: "Hoạt động" },
    { id: "333", name: "C", via: ["Via Cũ"], viaUids: [], role: "Quản trị viên", status: "Hoạt động" }
  ]);
  const SS = AmitSuperShare;
  SS.init();
  SS.renderTable(AmitStorage.getAccounts());
  const $ = id => w.document.getElementById(id);

  // 1. Dropdown + tùy chọn
  const opts = [...$("actionSelect").options].map(o => o.value).filter(Boolean);
  ok("ui: dropdown có đúng 5 action theo tên docx", opts.join() === "SHARE_USER,REMOVE_BY_UID_EXCEPT_SELF,REMOVE_ALL_EXCEPT_UIDS_AND_SELF,REMOVE_ALL_EXCEPT_SELF,REMOVE_SELF", opts);
  ok("ui: không còn nút Stop; delay mặc định 3, min 3 max 10", !$("stopBtn") && $("delay").value === "3" && $("delay").min === "3" && $("delay").max === "10");

  // 2. SHARE_USER: build request đúng hợp đồng
  SS.selectedAccounts = new Set(["111", "222"]);
  $("actionSelect").value = "SHARE_USER"; $("actionSelect").onchange();
  $("uidField").value = "1000111\n1000222";
  ok("share: ô role mặc định ADMIN", $("roleField").value === "ADMIN");
  const req = SS.buildRequest(["111", "222"]);
  ok("request: items {ad_account_id, action, target_uids, role, executor_uid} + delay_seconds=3",
    req.items.length === 2 && req.items[0].action === "SHARE_USER" && req.items[0].target_uids.join() === "1000111,1000222" && req.items[0].role === "ADMIN" && req.items[0].executor_uid === "100000000000001" && req.delay_seconds === 3, req);

  // 3. Validate UID theo luật docx
  ok("validate: >3 UID bị chặn cho SHARE", !SS.checkUids("SHARE_USER", "1\n2\n3\n4").ok);
  ok("validate: >3 UID bị chặn cho REMOVE_BY_UID (trước đây không giới hạn)", !SS.checkUids("REMOVE_BY_UID_EXCEPT_SELF", "1\n2\n3\n4").ok);
  ok("validate: keep-list cho phép 0 UID", SS.checkUids("REMOVE_ALL_EXCEPT_UIDS_AND_SELF", "").ok);
  ok("validate: REMOVE_BY_UID cần >=1 UID", !SS.checkUids("REMOVE_BY_UID_EXCEPT_SELF", "").ok);

  // 4. Chạy batch: UI hiển thị progress
  sent.length = 0;
  await SS.startExecution();
  ok("start: gửi execute_super_share_batch đúng hợp đồng mới (items, delay_seconds)", sent.some(m => m.action === "execute_super_share_batch" && m.items && m.delay_seconds === 3 && !m.targetAccounts), sent.map(m => m.action));
  ok("start: UI chuyển sang Running", $("execState").textContent === "Đang thực hiện" && !$("progress").classList.contains("hidden"));
  clearInterval(SS._pollTimer);

  // 5. Tiến trình thời gian thực: 1 OK, 1 FAILED có chi tiết UID
  SS.applyBatch(mkBatch([
    { id: "111", status: "SUCCESS", targets: [{ uid: "1000111", status: "SUCCESS" }, { uid: "1000222", status: "SUCCESS" }] },
    { id: "222", status: "FAILED", error_code: "DESTINATION_NOT_FOUND", error_message: "Không tìm thấy UID 1000222", step: "FIND_USER", finished_at: new Date().toISOString(),
      targets: [{ uid: "1000111", status: "SUCCESS" }, { uid: "1000222", status: "FAILED", error_code: "DESTINATION_NOT_FOUND", error_message: "Không tìm thấy UID" }] }
  ], "RUNNING"));
  ok("progress: 1/2 đã xử lý, 1 thành công, 1 thất bại", $("processed").textContent.includes("2 / 2") && $("okStat").textContent.includes("1") && $("failStat").textContent.includes("1"), $("processed").textContent);
  ok("progress: ô TKQC hiển thị số UID thành công (2/2 UID) và mã lỗi + nút retry riêng", $("progress-111").innerHTML.includes("2/2 UID") && $("progress-222").innerHTML.includes("DESTINATION_NOT_FOUND") && $("progress-222").innerHTML.includes("retrySingle"), $("progress-222").innerHTML);
  ok("failed detail: hiện TKQC ID, action, UID lỗi, error code, bước", !$("failedBox").classList.contains("hidden") && $("failedList").textContent.includes("222") && $("failedList").textContent.includes("1000222") && $("failedList").textContent.includes("FIND_USER"), $("failedList").textContent);

  // 6. Kết thúc: lịch sử, retry
  SS.applyBatch(mkBatch([{ id: "111", status: "SUCCESS" }, { id: "222", status: "FAILED", error_code: "DESTINATION_NOT_FOUND", error_message: "x", step: "FIND_USER", targets: [{ uid: "9", status: "FAILED", error_code: "DESTINATION_NOT_FOUND", error_message: "y" }] }], "FINISHED"));
  ok("final: '1/2 thành công · 1 thất bại' (không có nhãn PARTIAL_SUCCESS)", $("execState").textContent === "1/2 thành công · 1 thất bại", $("execState").textContent);
  ok("final: hiện nút Retry và lưu lịch sử kèm chi tiết thất bại", !$("retryBox").classList.contains("hidden") && AmitStorage.getHistory()[0].failed_items[0].targets[0].uid === "9", AmitStorage.getHistory()[0]);
  const histCount = AmitStorage.getHistory().length;
  SS.applyBatch(batchState = mkBatch([{ id: "111", status: "SUCCESS" }, { id: "222", status: "FAILED" }], "FINISHED"));
  ok("final: không ghi lịch sử trùng khi nhận lại cùng batch", AmitStorage.getHistory().length === histCount);

  sent.length = 0;
  await SS.retryAllFailed();
  ok("retry: gọi retry_failed (Extension tự xác định đúng target lỗi)", sent.some(m => m.action === "retry_failed"), sent);
  clearInterval(SS._pollTimer);
  sent.length = 0;
  SS.batch = mkBatch([{ id: "222", status: "FAILED" }], "FINISHED");
  await SS.retrySingle("222");
  ok("retry riêng 1 TKQC: gửi kèm ad_account_id", sent.some(m => m.action === "retry_failed" && m.ad_account_id === "222"), sent);
  clearInterval(SS._pollTimer);

  // 7. PAUSED -> chỉ có nút Tiếp tục
  SS.batch = null;
  SS.applyBatch(mkBatch([{ id: "111", status: "SUCCESS" }, { id: "222", status: "PAUSED" }], "PAUSED", { pause_reason: "SESSION_EXPIRED" }));
  ok("pause: hiện hộp Tiếp tục + thông điệp đăng nhập lại; không hiện Retry", !$("resumeBox").classList.contains("hidden") && $("pauseMsg").textContent.includes("đăng nhập") && $("retryBox").classList.contains("hidden"), $("pauseMsg").textContent);
  ok("pause: ô TKQC bị tạm dừng hiển thị 'Tạm dừng', không phải 'Thất bại'", $("progress-222").textContent.includes("Tạm dừng"));
  sent.length = 0;
  await SS.resumeBatch();
  ok("resume: gọi resume_batch", sent.some(m => m.action === "resume_batch"));
  clearInterval(SS._pollTimer);

  // 8. SELF-dependent action thiếu executor_uid -> chặn từ Web, không gửi
  SS.batch = null;
  SS.selectedAccounts = new Set(["333"]);
  $("actionSelect").value = "REMOVE_SELF"; $("actionSelect").onchange();
  sent.length = 0;
  await SS.startExecution();
  ok("self-dependent: TKQC chưa có UID Via -> chặn, không gửi execute", !sent.some(m => m.action === "execute_super_share_batch"), sent);

  // 9. REMOVE_SELF thành công -> TKQC biến mất khỏi dataset Via này
  SS.selectedAccounts = new Set(["111"]);
  SS.applyBatch(mkBatch([{ id: "111", status: "SUCCESS", note: "SELF_REMOVED", executor_uid: "100000000000001", action: "REMOVE_SELF" }], "FINISHED", { id: "b9" }));
  ok("remove_self: TKQC 111 bị gỡ khỏi dataset vì không còn Via nào có quyền", !AmitStorage.getAccounts().some(a => a.id === "111") && AmitStorage.getAccounts().length === 2, AmitStorage.getAccounts().map(a => a.id));

  // 10. Không có extension -> không chạy giả
  AmitBridge.isExtensionAvailable = false;
  SS.batch = null; SS.selectedAccounts = new Set(["222"]); $("actionSelect").value = "REMOVE_ALL_EXCEPT_SELF"; $("actionSelect").onchange();
  sent.length = 0;
  await SS.startExecution();
  ok("no-extension: không gửi gì, không mô phỏng", sent.length === 0 && !SS.isRunning);

  // 11. Nguồn TKQC (docx §45)
  AmitBridge.isExtensionAvailable = true;
  AmitStorage.saveAccounts([
    { id: "111", name: "A", via: ["V"], viaUids: ["100000000000001"], status: "Hoạt động" },
    { id: "222", name: "B", via: ["V"], viaUids: ["100000000000001"], status: "Hoạt động" },
    { id: "333", name: "C", via: ["V"], viaUids: ["100000000000001"], status: "Hoạt động" }
  ]);
  const radio = v => w.document.querySelector(`input[name="src"][value="${v}"]`);
  ok("source: có 3 nguồn all / ads / ids", ["all", "ads", "ids"].every(v => !!radio(v)));

  // 11a. Theo ID: không khớp ID nào thì KHÔNG được nạp tất cả (lỗi cũ)
  radio("ids").checked = true; radio("all").checked = false; radio("ids").onchange();
  $("idInput").value = "999999999\n888888888";
  SS.selectedAccounts = new Set();
  $("sourceView").classList.remove("hidden"); $("workspace").classList.remove("active");
  $("loadBtn").onclick();
  ok("source ids: không khớp ID nào -> ở lại màn chọn nguồn, không nạp TKQC nào", !$("sourceView").classList.contains("hidden") && !$("workspace").classList.contains("active") && $("loadMsg").textContent.includes("Không tìm thấy: 2"), $("loadMsg").textContent);
  $("idInput").value = "222\n999999999";
  $("loadBtn").onclick();
  ok("source ids: khớp 1/2 -> chỉ nạp đúng TKQC 222", $("ssTable").querySelectorAll("tbody tr").length === 1 && $("ssTable").textContent.includes("222") && !$("ssTable").textContent.includes("111"), $("ssTable").querySelectorAll("tbody tr").length);

  // 11b. Từ Ads Check
  $("sourceView").classList.remove("hidden"); $("workspace").classList.remove("active");
  radio("ads").checked = true; radio("ids").checked = false;
  AmitAdsTable.selectedIds.clear();
  SS.refreshAdsSourceHint();
  ok("source ads: gợi ý 'Chưa chọn TKQC nào' khi Ads Check chưa chọn", $("adsSelHint").textContent.includes("Chưa chọn"));
  $("loadBtn").onclick();
  ok("source ads: chưa chọn gì -> ở lại màn chọn nguồn", !$("sourceView").classList.contains("hidden") && $("loadMsg").textContent.includes("Chưa chọn"), $("loadMsg").textContent);
  AmitAdsTable.selectedIds.add("111"); AmitAdsTable.selectedIds.add("333");
  SS.refreshAdsSourceHint();
  ok("source ads: gợi ý số TKQC đang chọn", $("adsSelHint").textContent.includes("2 TKQC"), $("adsSelHint").textContent);
  $("loadBtn").onclick();
  ok("source ads: nạp đúng 2 TKQC đã chọn ở Ads Check và chọn sẵn", $("ssTable").querySelectorAll("tbody tr").length === 2 && SS.selectedAccounts.size === 2 && SS.selectedAccounts.has("111") && SS.selectedAccounts.has("333") && $("workspace").classList.contains("active"), { rows: $("ssTable").querySelectorAll("tbody tr").length, sel: [...SS.selectedAccounts] });

  // 12. Lịch sử TỪNG TKQC (docx §22): thành công lẫn thất bại + export CSV
  SS.batch = null; SS._endedBatchId = null;
  const hbefore = AmitStorage.getHistory().length;
  SS.applyBatch(mkBatch([
    { id: "111", status: "SUCCESS", targets: [{ uid: "5", status: "SUCCESS" }] },
    { id: "222", status: "FAILED", error_code: "DESTINATION_NOT_FOUND", error_message: "Không tìm thấy UID", step: "FIND_USER", targets: [{ uid: "6", status: "FAILED", error_code: "DESTINATION_NOT_FOUND", error_message: "Không tìm thấy UID 6" }] },
    { id: "333", status: "SUCCESS", targets: [{ uid: "5", status: "SUCCESS" }, { uid: "6", status: "SUCCESS" }] }
  ], "FINISHED", { id: "bh1" }));
  const hist = AmitStorage.getHistory();
  ok("history: thêm đúng 1 mục và lưu kết quả của CẢ 3 TKQC (không chỉ TKQC lỗi)", hist.length === hbefore + 1 && hist[0].results.length === 3 && hist[0].results.map(r => r[1]).join() === "S,F,S", hist[0].results);
  ok("history: lưu số UID thành công/tổng cho từng TKQC", hist[0].results[2][3] === 2 && hist[0].results[2][4] === 2 && hist[0].results[1][3] === 0 && hist[0].results[1][4] === 1);
  SS.showHistoryDetail(0);
  const modal = $("modalBody").textContent;
  ok("history detail: liệt kê TKQC thành công lẫn thất bại + chi tiết UID lỗi", modal.includes("111") && modal.includes("333") && modal.includes("Thành công") && modal.includes("Thất bại") && modal.includes("DESTINATION_NOT_FOUND") && modal.includes("Không tìm thấy UID 6"), modal.slice(0, 300));

  let csv = "";
  w.Blob = function (parts) { csv = parts.join(""); };
  w.URL.createObjectURL = () => "blob:x"; w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () {};
  SS.exportHistory();
  const lines = csv.replace(/^﻿/, "").split("\n");
  ok("export: mỗi TKQC một dòng (kể cả thành công), TKQC lỗi kèm UID + mã lỗi", lines[0].includes("TKQC") && lines.some(l => l.includes('"111"') && l.includes("Thành công")) && lines.some(l => l.includes('"222"') && l.includes('"6"') && l.includes("DESTINATION_NOT_FOUND")) && lines.some(l => l.includes('"333"') && l.includes("2/2")), lines);

  // 13. Lịch sử đầy dung lượng không được làm hỏng luồng
  const realSet = w.Storage.prototype.setItem; let calls = 0;
  w.Storage.prototype.setItem = function (k, v) { if (k === "amit_exec_history" && v.length > 2000 && calls++ < 3) throw new Error("QuotaExceeded"); return realSet.call(this, k, v); };
  let threw13 = null; try { AmitStorage.addHistoryItem({ action: "x", total: 1, ok: 1, fail: 0, state: "s", results: [] }); } catch (e) { threw13 = e.message; }
  w.Storage.prototype.setItem = realSet;
  ok("history: hết dung lượng localStorage -> bỏ mục cũ, không ném lỗi", threw13 === null, threw13);

  // 14. Cột "Múi giờ" ở Ads Check
  AmitStorage.saveAccounts([
    { id: "111", name: "A", via: ["V"], viaUids: ["1"], status: "Hoạt động", currency: "USD", timezone: "Asia/Ho_Chi_Minh", timezoneOffset: 7 },
    { id: "222", name: "B", via: ["V"], viaUids: ["1"], status: "Hoạt động", currency: "USD", timezone: "America/Los_Angeles", timezoneOffset: -8 },
    { id: "333", name: "C", via: ["V"], viaUids: ["1"], status: "Hoạt động", currency: "USD" } // sync trước khi có cột này
  ]);
  AmitAdsTable.hiddenColumns.clear();
  AmitAdsTable.render();
  const adsHtml = $("adsTable").textContent;
  ok("ads check: có cột 'Múi giờ' cạnh 'Quốc gia'", adsHtml.includes("Quốc gia") && adsHtml.includes("Múi giờ") && adsHtml.indexOf("Quốc gia") < adsHtml.indexOf("Múi giờ"));
  ok("ads check: hiển thị tên múi giờ + UTC (UTC+7, UTC-8)", adsHtml.includes("Asia/Ho Chi Minh (UTC+7)") && adsHtml.includes("America/Los Angeles (UTC-8)"), adsHtml.slice(0, 200));
  const rows3 = [...$("adsTable").querySelectorAll("tbody tr")];
  ok("ads check: TKQC chưa có dữ liệu múi giờ hiển thị '—' (cần Sync lại), không lỗi", rows3.length === 3 && rows3[2].textContent.includes("—"));
  const ths = [...$("adsTable").querySelectorAll("thead th")];
  const tzIdx = ths.findIndex(t => t.textContent.includes("Múi giờ"));
  ok("ads check: số cột tiêu đề khớp số ô dữ liệu (không lệch cột)", ths.length === rows3[0].querySelectorAll("td").length && tzIdx > 0, { th: ths.length, td: rows3[0].querySelectorAll("td").length });
  AmitAdsTable.searchQuery = "utc-8";
  ok("ads check: tìm theo múi giờ (vd 'utc-8') ra đúng TKQC", AmitAdsTable.filterData(AmitStorage.getAccounts()).map(a => a.id).join() === "222");
  AmitAdsTable.searchQuery = "";
  AmitAdsTable.hiddenColumns.add("timezone");
  AmitAdsTable.render();
  ok("ads check: ẩn cột 'Múi giờ' qua mục Cột hiển thị", $("adsTable").querySelector("th[style*='display:none']") !== null);
  AmitAdsTable.hiddenColumns.clear();

  // 15. Bảng Super Share cũng có cột "Múi giờ"
  AmitStorage.saveAccounts([
    { id: "111", name: "A", via: ["V"], viaUids: ["1"], status: "Hoạt động", country: "VN", timezone: "Asia/Ho_Chi_Minh", timezoneOffset: 7 },
    { id: "333", name: "C", via: ["V"], viaUids: ["1"], status: "Hoạt động" }
  ]);
  SS.renderTable(AmitStorage.getAccounts());
  const ssThs = [...$("ssTable").querySelectorAll("thead th")];
  const ssRow = $("ssTable").querySelector("tbody tr");
  const ssTz = ssThs.findIndex(t => t.textContent.includes("Múi giờ"));
  ok("super share: có cột 'Múi giờ' ngay sau 'Quốc gia', số cột khớp số ô", ssTz > 0 && ssThs[ssTz - 1].textContent.includes("Quốc gia") && ssThs.length === ssRow.querySelectorAll("td").length, { th: ssThs.length, td: ssRow.querySelectorAll("td").length });
  ok("super share: hiển thị 'Asia/Ho Chi Minh (UTC+7)' và '—' khi chưa có dữ liệu", ssRow.querySelectorAll("td")[ssTz].textContent === "Asia/Ho Chi Minh (UTC+7)" && $("ssTable").querySelectorAll("tbody tr")[1].querySelectorAll("td")[ssTz].textContent === "—");

  // 16. Xem trước kế hoạch xóa (Graph engine; docx kiến trúc §7.3, §11.2)
  {
    const AmitApp = w.__G.AmitApp;
    const mkAcc = id => ({ id, name: id, via: ["V"], viaUids: ["100000000000001"], status: "Hoạt động" });
    AmitStorage.saveAccounts(["111", "222", "333"].map(mkAcc));
    SS.batch = null; batchState = null; AmitBridge.isExtensionAvailable = true;
    SS.selectedAccounts = new Set(["111", "222", "333"]);
    $("actionSelect").value = "REMOVE_ALL_EXCEPT_SELF"; $("actionSelect").onchange();
    const plan = (id, over) => Object.assign({
      ad_account_id: id, action: "REMOVE_ALL_EXCEPT_SELF", status: "OK", error_code: null, error_message: null, remove_uids: ["5", "6"], other_admins: null,
      users: [{ uid: "100000000000001", name: "Via", role: "ADMIN", mark: "SELF" }, { uid: "5", name: "An <b>x</b>", role: "ANALYST", mark: "REMOVE" }, { uid: "6", name: "Bình", role: "ADVERTISER", mark: "REMOVE" }],
      snapshot: { created_at: new Date().toISOString(), remove_uids: ["5", "6"], keep_uids: ["100000000000001"], users: [] }
    }, over);
    const errPlan = id => plan(id, { status: "ERROR", error_code: "ACCOUNT_NOT_FOUND", error_message: "Không có quyền", snapshot: null, remove_uids: [], users: [] });

    // a. DOM engine: giữ luồng một CTA, không xem trước
    engine = "dom"; sent.length = 0;
    await SS.executeWithPreview();
    ok("preview: DOM engine -> chạy thẳng, không xem trước", sent.some(m => m.action === "execute_super_share_batch") && !sent.some(m => m.action === "super_share_preview"), sent.map(m => m.action));
    clearInterval(SS._pollTimer); SS.batch = null; batchState = null;

    // b. Graph engine: hiện kế hoạch, CHƯA gửi execute
    engine = "graph";
    previewReply = msg => ({ success: true, complete: true, previews: msg.items.map(i => (i.ad_account_id === "333" ? errPlan("333") : plan(i.ad_account_id))) });
    sent.length = 0;
    await SS.executeWithPreview();
    const modalText = $("modalBody").textContent;
    ok("preview: Graph -> gọi super_share_preview và CHƯA gửi execute", sent.some(m => m.action === "super_share_preview") && !sent.some(m => m.action === "execute_super_share_batch"), sent.map(m => m.action));
    ok("preview: modal hiện ai bị xóa (tên, UID, vai trò) và tổng số", $("modalBg").style.display === "flex" && modalText.includes("Xóa 2 người") && modalText.includes("Bình") && modalText.includes("Nhà phân tích") && modalText.includes("tổng cộng 4"), modalText.slice(0, 300));
    ok("preview: tên người dùng được escape (không chèn HTML)", $("modalBody").querySelector("table b") === null || !$("modalBody").innerHTML.includes("<b>x</b>"), $("modalBody").innerHTML.slice(0, 200));
    ok("preview: TKQC không đọc được hiện 'Bỏ qua' kèm lý do; giữ lại self được liệt kê", modalText.includes("Bỏ qua") && modalText.includes("ACCOUNT_NOT_FOUND") && modalText.includes("Via này"));
    ok("preview: nút xác nhận ghi rõ số TKQC sẽ chạy (2)", $("modalConfirmBtn").style.display !== "none" && $("modalConfirmBtn").textContent.includes("(2 TKQC)"), $("modalConfirmBtn").textContent);

    // c. Đóng modal (Hủy) -> không có gì được gửi
    sent.length = 0; AmitApp.closeModal(); await sleep(20);
    ok("preview: Hủy -> không gửi execute", !sent.some(m => m.action === "execute_super_share_batch"));

    // d. Xác nhận -> execute chỉ các TKQC có kế hoạch, kèm snapshot
    await SS.executeWithPreview();
    sent.length = 0; $("modalConfirmBtn").onclick(); await sleep(30);
    const exec = sent.find(m => m.action === "execute_super_share_batch");
    ok("preview: xác nhận -> execute đúng 111,222; mỗi item kèm snapshot đã xem", exec && exec.items.map(i => i.ad_account_id).join() === "111,222" && exec.items.every(i => i.snapshot && i.snapshot.remove_uids.join() === "5,6" && i.action === "REMOVE_ALL_EXCEPT_SELF"), exec);
    ok("preview: TKQC bỏ qua hiển thị 'Bỏ qua' trong bảng tiến trình", $("progress-333").textContent.includes("Bỏ qua"), $("progress-333").textContent);
    clearInterval(SS._pollTimer); SS.batch = null; batchState = null;

    // e. Gặp PAUSED giữa chừng: dừng, không modal, không execute
    previewReply = msg => ({ success: true, complete: false, previews: [Object.assign(plan("111"), { status: "PAUSED", error_code: "FACEBOOK_CHECKPOINT", error_message: "cp", snapshot: null, remove_uids: [], users: [] })] });
    AmitApp.closeModal(); sent.length = 0;
    await SS.executeWithPreview();
    ok("preview: checkpoint giữa chừng -> báo, KHÔNG mở modal xác nhận, KHÔNG execute", $("modalBg").style.display !== "flex" && !sent.some(m => m.action === "execute_super_share_batch") && /checkpoint/i.test($("toast").textContent), $("toast").textContent);

    // f. Extension báo lỗi -> không chạy
    previewReply = () => ({ success: false, error: "ENGINE_NOT_GRAPH", message: "Xem trước kế hoạch chỉ có ở Graph engine." });
    sent.length = 0;
    await SS.executeWithPreview();
    ok("preview: extension từ chối -> không modal, không execute", $("modalBg").style.display !== "flex" && !sent.some(m => m.action === "execute_super_share_batch"));

    // g. Tất cả TKQC đều lỗi -> modal chỉ để đọc, không có nút xác nhận
    previewReply = msg => ({ success: true, complete: true, previews: msg.items.map(i => errPlan(i.ad_account_id)) });
    await SS.executeWithPreview();
    ok("preview: không TKQC nào chạy được -> không có nút xác nhận", $("modalBg").style.display === "flex" && $("modalConfirmBtn").style.display === "none");
    AmitApp.closeModal();

    // h. REMOVE_SELF: cảnh báo mất quyền + tiêu đề riêng
    SS.selectedAccounts = new Set(["111"]);
    $("actionSelect").value = "REMOVE_SELF"; $("actionSelect").onchange();
    previewReply = msg => ({ success: true, complete: true, previews: msg.items.map(i => plan(i.ad_account_id, { action: "REMOVE_SELF", remove_uids: ["100000000000001"], other_admins: 2, users: [{ uid: "100000000000001", name: "Via", role: "ADMIN", mark: "REMOVE" }, { uid: "7", name: "Khác", role: "ADMIN", mark: "KEEP" }] })) });
    await SS.executeWithPreview();
    ok("preview REMOVE_SELF: tiêu đề xác nhận riêng, cảnh báo mất quyền + còn 2 admin khác", $("modalTitle").textContent.includes("chính Via") && $("modalBody").textContent.includes("mất quyền truy cập") && $("modalBody").textContent.includes("còn 2 Quản trị viên"), $("modalBody").textContent.slice(0, 300));
    AmitApp.closeModal();

    // i. Chia lô 10 TKQC mỗi lần gọi extension
    const many = Array.from({ length: 25 }, (_, i) => String(5000 + i));
    AmitStorage.saveAccounts(many.map(mkAcc));
    SS.selectedAccounts = new Set(many);
    $("actionSelect").value = "REMOVE_ALL_EXCEPT_SELF"; $("actionSelect").onchange();
    previewReply = msg => ({ success: true, complete: true, previews: msg.items.map(i => plan(i.ad_account_id)) });
    sent.length = 0;
    await SS.executeWithPreview();
    const calls = sent.filter(m => m.action === "super_share_preview");
    ok("preview: 25 TKQC được chia 10 + 10 + 5", calls.map(m => m.items.length).join() === "10,10,5", calls.map(m => m.items.length));
    ok("preview: gom đủ 25 TKQC vào một modal xác nhận", $("modalConfirmBtn").textContent.includes("(25 TKQC)"));
    AmitApp.closeModal();

    // j. Thiếu executor_uid -> chặn trước khi xem trước
    AmitStorage.saveAccounts([{ id: "7000", name: "x", via: ["V"], viaUids: [], status: "Hoạt động" }]);
    SS.selectedAccounts = new Set(["7000"]);
    sent.length = 0;
    await SS.executeWithPreview();
    ok("preview: TKQC chưa có UID Via -> chặn, không gọi extension", !sent.some(m => m.action === "super_share_preview" || m.action === "execute_super_share_batch"));

    // k. Backoff rate limit hiển thị trên tiến trình
    SS.batch = null;
    SS.applyBatch(mkBatch([{ id: "111", status: "RUNNING" }], "RUNNING", { id: "bk1", backoff: { reason: "RATE_LIMITED", ad_account_id: "111", attempt: 1, max: 3, wait_ms: 30000, until: new Date(Date.now() + 30000).toISOString() } }));
    const st = $("execState").textContent;
    const secs = Number((st.match(/sau (\d+) giây/) || [])[1]);
    ok("backoff: hiển thị 'giới hạn tốc độ', TKQC, đếm ngược giây và lần 1/3", st.includes("giới hạn tốc độ") && st.includes("111") && st.includes("lần 1/3") && secs >= 28 && secs <= 30, st);
    SS.applyBatch(mkBatch([{ id: "111", status: "RUNNING" }], "RUNNING", { id: "bk1", backoff: null }));
    ok("backoff: hết chờ -> quay lại 'Đang thực hiện'", $("execState").textContent === "Đang thực hiện");
    clearInterval(SS._pollTimer);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("CRASH", e); process.exit(2); });
