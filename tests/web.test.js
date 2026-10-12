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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("CRASH", e); process.exit(2); });
