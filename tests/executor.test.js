const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const ROOT = (process.argv[2] || require("path").resolve(__dirname, ".."));
const coreSrc = fs.readFileSync(path.join(ROOT, "shared/super-share-core.js"), "utf8");
const execSrc = fs.readFileSync(path.join(ROOT, "extension/content-scripts/executor.js"), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  -> " + JSON.stringify(extra, null, 0).slice(0, 600))); };

const { makeSetup } = require("./helpers/fake-ads-page.js");
const { setup } = makeSetup(ROOT);

const U = (uid, name, role) => ({ uid, name, role });
const base = () => [U("1", "Via Minh", "ADMIN"), U("2", "Nguoi Hai", "ADMIN"), U("3", "Nguoi Ba", "ADVERTISER"), U("4", "Nguoi Bon", "ANALYST")];
const item = (action, extra) => Object.assign({ ad_account_id: "1288013719961305", action, executor_uid: "1" }, extra || {});
const uids = w => w.users.map(u => u.uid).join();

(async () => {
  // 1. Đọc danh sách vai trò
  let { w, I, C } = await setup({ users: base() });
  let roles = await I.driver.readRoles();
  ok("read: rút đúng UID, tên, role từ DOM", roles.length === 4 && roles[0].uid === "1" && roles[2].role === "ADVERTISER" && roles[3].role === "ANALYST", roles);
  ok("session: cookie c_user được đọc", (await I.driver.getSessionUid()) === "1" && (await I.driver.getSessionState()) === "OK");

  // 2. Share user mới + role
  let r = await C.runItem(I.driver, item("SHARE_USER", { target_uids: ["50"], role: "ADVERTISER" }));
  ok("share: thêm UID 50 role ADVERTISER (tìm bằng UID, xác nhận bằng markup, verify)", r.status === "SUCCESS" && w.users.find(u => u.uid === "50").role === "ADVERTISER", r);

  // 3. Share UID không tồn tại trong directory
  r = await C.runItem(I.driver, item("SHARE_USER", { target_uids: ["999"] }));
  ok("share: UID không có kết quả -> DESTINATION_NOT_FOUND", r.targets[0].error_code === "DESTINATION_NOT_FOUND", r);

  // 4. Remove by UID
  r = await C.runItem(I.driver, item("REMOVE_BY_UID_EXCEPT_SELF", { target_uids: ["3", "4"] }));
  ok("remove: xóa 3 và 4 qua dialog xác nhận, verify", r.status === "SUCCESS" && uids(w) === "1,2,50", { r, u: uids(w) });

  // 5. Keep list thiếu -> không xóa gì
  r = await C.runItem(I.driver, item("REMOVE_ALL_EXCEPT_UIDS_AND_SELF", { target_uids: ["2", "777"] }));
  ok("keep: UID giữ 777 không có -> KEEP_UID_NOT_FOUND, không xóa ai", r.error_code === "KEEP_UID_NOT_FOUND" && uids(w) === "1,2,50", { r, u: uids(w) });

  // 6. Keep hợp lệ
  r = await C.runItem(I.driver, item("REMOVE_ALL_EXCEPT_UIDS_AND_SELF", { target_uids: ["2"] }));
  ok("keep: giữ SELF + 2, xóa 50", r.status === "SUCCESS" && uids(w) === "1,2", { r, u: uids(w) });

  // 7. REMOVE_SELF có admin khác; sau đó trang báo mất quyền -> signal noAccess
  r = await C.runItem(I.driver, item("REMOVE_SELF"));
  ok("removeself: thành công nhờ tín hiệu mất quyền/không còn trong list", r.status === "SUCCESS" && r.note === "SELF_REMOVED", r);

  // 8. REMOVE_SELF là admin cuối -> NO_OTHER_ADMIN, không click
  ({ w, I, C } = await setup({ users: [U("1", "Via", "ADMIN"), U("3", "Ba", "ADVERTISER")] }));
  r = await C.runItem(I.driver, item("REMOVE_SELF"));
  ok("removeself: admin cuối -> NO_OTHER_ADMIN, danh sách nguyên vẹn", r.error_code === "NO_OTHER_ADMIN" && uids(w) === "1,3", { r, u: uids(w) });

  // 9. Một target bị Facebook từ chối -> tiếp tục
  ({ w, I, C } = await setup({ users: base() }));
  w.refuse = "3";
  r = await C.runItem(I.driver, item("REMOVE_ALL_EXCEPT_SELF"));
  ok("removeall: UID 3 bị từ chối vẫn xóa 2,4; account FAILED failed_uid=3", r.status === "FAILED" && r.failed_uid === "3" && uids(w) === "1,3", { r, u: uids(w) });

  // 10. Chọn TKQC qua Search ID khi header đang là TKQC khác
  ({ w, I, C } = await setup({ users: base() }));
  w.cur = "86851031"; w.document.getElementById("acct").textContent = "86851031 (Van phi)";
  await I.driver.openAccount("1288013719961305");
  ok("account: header khác -> Search theo ID, exact match, verify", I.accountIdFromDom() === "1288013719961305", I.accountIdFromDom());
  let threw = null; try { await I.driver.openAccount("55555555"); } catch (e) { threw = e.code; }
  ok("account: ID không có trong kết quả -> ACCOUNT_NOT_FOUND", threw === "ACCOUNT_NOT_FOUND", threw);

  // 11. Chặn write khi context sai
  threw = null; w.cur = "86851031"; w.document.getElementById("acct").textContent = "86851031 (Van phi)";
  try { await I.driver.assertContext("1288013719961305"); } catch (e) { threw = e.code; }
  ok("context: TKQC hiện tại khác mục tiêu -> chặn write", threw === "ACCOUNT_NOT_FOUND", threw);

  // 12. DOM không có UID -> không đoán theo tên
  ({ w, I, C } = await setup({ users: base(), mode: "nouid" }));
  r = await C.runItem(I.driver, item("REMOVE_ALL_EXCEPT_SELF"));
  ok("nouid: có role nhưng không rút được UID -> UI_VARIANT_UNKNOWN, không xóa", r.error_code === "UI_VARIANT_UNKNOWN" && w.users.length === 4 && r.detail && r.detail.headings, r);

  // 13. Mục vai trò báo lỗi / mất quyền
  ({ w, I, C } = await setup({ users: base(), mode: "error" }));
  r = await C.runItem(I.driver, item("SHARE_USER", { target_uids: ["50"] }));
  ok("error: mục vai trò lỗi tải -> PAGE_LOAD_FAILED (không báo ROLE_SECTION_NOT_FOUND)", r.error_code === "PAGE_LOAD_FAILED", r);
  ({ w, I, C } = await setup({ users: base(), mode: "noaccess" }));
  r = await C.runItem(I.driver, item("SHARE_USER", { target_uids: ["50"] }));
  ok("noaccess: -> ACCOUNT_ACCESS_DENIED", r.error_code === "ACCOUNT_ACCESS_DENIED", r);

  // 14. Kết quả không xác nhận được là UID -> UI_TARGET_AMBIGUOUS, không chọn gần giống
  ({ w, I, C } = await setup({ users: base(), mode: "ambiguous" }));
  r = await C.runItem(I.driver, item("SHARE_USER", { target_uids: ["999"] }));
  ok("ambiguous: kết quả không chứa UID -> UI_TARGET_AMBIGUOUS, không thêm ai", r.targets[0].error_code === "UI_TARGET_AMBIGUOUS" && w.users.length === 4, r);

  // ===== JEV (docx §11): chỉ tìm control, code validate, không quyết định nghiệp vụ =====
  // "Model" giả: chọn candidate có nhãn khớp `want`; ghi lại candidate được gửi đi.
  const jevStub = (w, want, confidence) => {
    w.__jevCalls = [];
    w.AmitJev = { resolve: async req => {
      w.__jevCalls.push(req);
      const c = req.candidates.find(x => x.label === want);
      return c ? { index: c.index, confidence: confidence === undefined ? 0.95 : confidence } : { index: null, confidence: 0.1 };
    } };
  };

  // J1. Nút "Thêm người" có nhãn lạ -> Jev tìm; luồng vẫn xác nhận UID + verify như thường
  ({ w, I, C } = await setup({ users: base(), addLabel: "Mời thêm thành viên" }));
  jevStub(w, "Mời thêm thành viên");
  r = await C.runItem(I.driver, item("SHARE_USER", { target_uids: ["50"], role: "ANALYST" }));
  ok("jev: nút Thêm người nhãn lạ -> Jev chọn đúng, share vẫn verify role", r.status === "SUCCESS" && w.users.find(u => u.uid === "50").role === "ANALYST", r);
  ok("jev: goal đúng như docx (Add People trong mục Ad Account Roles)", /Add People control inside the Ad Account Roles section/.test(w.__jevCalls[0].goal) && w.__jevCalls[0].step === "ADD_PEOPLE", w.__jevCalls[0]);
  ok("jev: candidate gửi cho Jev KHÔNG chứa nút Hủy/Đóng", w.__jevCalls.every(c => !c.candidates.some(x => ["Hủy", "Đóng", "Cancel", "Close"].includes(x.label))), w.__jevCalls.map(c => c.candidates.map(x => x.label)));
  ok("jev: không gửi HTML hay dữ liệu thừa (chỉ index/tag/role/label/haspopup)", w.__jevCalls.every(c => c.candidates.every(x => Object.keys(x).every(k => ["index", "tag", "role", "label", "haspopup"].includes(k)))));

  // J2. Nhật ký sử dụng Jev được đính kèm khi chạy qua message handler (RUN_ITEM)
  ({ w, I, C } = await setup({ users: base(), addLabel: "Mời thêm thành viên" }));
  jevStub(w, "Mời thêm thành viên");
  const viaMsg = await new Promise(res => w.__listener({ target: "AMIT_EXECUTOR", cmd: "RUN_ITEM", item: item("SHARE_USER", { target_uids: ["50"] }) }, null, res));
  ok("jev: kết quả RUN_ITEM có result.jev ghi lại bước, nhãn được chọn, confidence", viaMsg.ok && viaMsg.result.jev && viaMsg.result.jev[0].step === "ADD_PEOPLE" && viaMsg.result.jev[0].chosen === "Mời thêm thành viên" && viaMsg.result.jev[0].confidence === 0.95, viaMsg);

  // J3. Confidence thấp -> không click, UI_TARGET_AMBIGUOUS
  ({ w, I, C } = await setup({ users: base(), addLabel: "Mời thêm thành viên" }));
  jevStub(w, "Mời thêm thành viên", 0.5);
  r = await C.runItem(I.driver, item("SHARE_USER", { target_uids: ["50"] }));
  ok("jev: confidence 0.5 < 0.8 -> UI_TARGET_AMBIGUOUS, không thêm ai", r.targets[0].error_code === "UI_TARGET_AMBIGUOUS" && w.users.length === 4, r);

  // J4. Jev không chọn (index null) hoặc không có Jev -> lỗi tường minh ADD_PEOPLE_NOT_AVAILABLE
  ({ w, I, C } = await setup({ users: base(), addLabel: "Mời thêm thành viên" }));
  jevStub(w, "không có nhãn này");
  r = await C.runItem(I.driver, item("SHARE_USER", { target_uids: ["50"] }));
  ok("jev: Jev không chọn được -> ADD_PEOPLE_NOT_AVAILABLE, không đoán", r.targets[0].error_code === "ADD_PEOPLE_NOT_AVAILABLE" && w.users.length === 4, r);
  ({ w, I, C } = await setup({ users: base(), addLabel: "Mời thêm thành viên" }));
  w.chrome.runtime.sendMessage = () => Promise.resolve({ ok: false, reason: "JEV_DISABLED" });
  r = await C.runItem(I.driver, item("SHARE_USER", { target_uids: ["50"] }));
  ok("jev: Jev tắt (JEV_DISABLED qua service worker) -> ADD_PEOPLE_NOT_AVAILABLE", r.targets[0].error_code === "ADD_PEOPLE_NOT_AVAILABLE" && w.users.length === 4, r);
  ({ w, I, C } = await setup({ users: base(), addLabel: "Mời thêm thành viên" }));
  r = await C.runItem(I.driver, item("SHARE_USER", { target_uids: ["50"] }));
  ok("jev: không có kênh tới service worker -> không ném lỗi, báo ADD_PEOPLE_NOT_AVAILABLE", r.targets[0].error_code === "ADD_PEOPLE_NOT_AVAILABLE", r);

  // J5. Qua service worker: executor gửi đúng message jev_resolve và dùng index trả về
  ({ w, I, C } = await setup({ users: base(), addLabel: "Mời thêm thành viên" }));
  const swCalls = [];
  w.chrome.runtime.sendMessage = async m => { swCalls.push(m); const c = m.request.candidates.find(x => x.label === "Mời thêm thành viên"); return { ok: true, index: c.index, confidence: 0.9 }; };
  r = await C.runItem(I.driver, item("SHARE_USER", { target_uids: ["50"] }));
  ok("jev: executor gọi service worker bằng action jev_resolve và dùng kết quả", r.status === "SUCCESS" && swCalls.length >= 1 && swCalls[0].action === "jev_resolve", { r, swCalls: swCalls.length });

  // J6. Nút xác nhận nhãn lạ -> Jev chọn trong hộp thoại; vẫn có verify
  ({ w, I, C } = await setup({ users: base(), okLabel: "Hoàn tất" }));
  jevStub(w, "Hoàn tất");
  r = await C.runItem(I.driver, item("SHARE_USER", { target_uids: ["50"] }));
  ok("jev: nút xác nhận nhãn lạ -> Jev chọn trong hộp thoại, kết quả verify", r.status === "SUCCESS" && w.users.some(u => u.uid === "50") && w.__jevCalls.some(c => c.step === "CONFIRM"), r);
  ok("jev: candidate bước CONFIRM không chứa Hủy", w.__jevCalls.filter(c => c.step === "CONFIRM").every(c => !c.candidates.some(x => x.label === "Hủy")));

  // J7. Control Xóa nhãn lạ trên dòng: Jev chỉ thấy control của ĐÚNG dòng đó
  ({ w, I, C } = await setup({ users: base(), removeLabel: "Gỡ bỏ quyền" }));
  I.CONFIG.labels.removeControl = ["Xóa"]; // nhãn thực tế "Gỡ bỏ quyền" không nằm trong danh sách đã biết
  jevStub(w, "Gỡ bỏ quyền");
  r = await C.runItem(I.driver, item("REMOVE_BY_UID_EXCEPT_SELF", { target_uids: ["3"] }));
  ok("jev: control Xóa nhãn lạ -> Jev chọn, xóa đúng UID 3 và verify", r.status === "SUCCESS" && w.users.map(u => u.uid).join() === "1,2,4", { r, u: w.users.map(u => u.uid) });
  const rmCall = w.__jevCalls.find(c => c.step === "REMOVE");
  ok("jev: candidate bước REMOVE chỉ thuộc dòng của UID đó (không thấy nút của dòng khác)", rmCall && rmCall.candidates.filter(x => x.label === "Gỡ bỏ quyền").length === 1, rmCall);

  // J8. Không tìm thấy tiêu đề mục vai trò -> Jev tìm theo goal của docx; code validate nội dung
  ({ w, I, C } = await setup({ users: base(), heading: "Quản lý quyền truy cập" }));
  jevStub(w, "Quản lý quyền truy cập");
  roles = await I.driver.readRoles();
  ok("jev: tiêu đề mục vai trò lạ -> Jev tìm đúng, đọc được danh sách", roles.length === 4 && /Locate the section for managing people and roles of the CURRENT advertising account/.test(w.__jevCalls[0].goal), roles);
  ({ w, I, C } = await setup({ users: base(), heading: "Quản lý quyền truy cập" }));
  jevStub(w, "Lựa chọn báo cáo với nhà phát hành"); // Jev chọn nhầm mục khác
  threw = null; try { await I.driver.readRoles(); } catch (e) { threw = e.code; }
  ok("jev: Jev chọn nhầm mục khác -> code validate nội dung và từ chối (ROLE_SECTION_NOT_FOUND)", threw === "ROLE_SECTION_NOT_FOUND", threw);

  // J9. Giới hạn số lần gọi Jev mỗi item
  ({ w, I, C } = await setup({ users: base(), addLabel: "Mời thêm thành viên" }));
  jevStub(w, "Mời thêm thành viên");
  for (let i = 0; i < I.CONFIG.jevMaxCallsPerItem; i++) I.jevLog.push({ step: "x" });
  r = await C.runItem(I.driver, item("SHARE_USER", { target_uids: ["50"] }));
  ok("jev: vượt giới hạn số lần gọi mỗi item -> không gọi nữa, báo lỗi", r.targets[0].error_code === "ADD_PEOPLE_NOT_AVAILABLE" && w.__jevCalls.length === 0, r);

  // 15. Session
  ({ w, I, C } = await setup({ users: base() }));
  w.document.cookie = "c_user=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  r = await C.runItem(I.driver, item("SHARE_USER", { target_uids: ["50"] }));
  ok("session: mất cookie c_user -> PAUSED SESSION_EXPIRED", r.status === "PAUSED" && r.error_code === "SESSION_EXPIRED", r);
  ({ w, I, C } = await setup({ users: base() }));
  w.document.cookie = "c_user=999";
  r = await C.runItem(I.driver, item("REMOVE_ALL_EXCEPT_SELF"));
  ok("identity: c_user khác executor_uid -> EXECUTOR_IDENTITY_MISMATCH, không xóa", r.error_code === "EXECUTOR_IDENTITY_MISMATCH" && w.users.length === 4, r);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("CRASH", e); process.exit(2); });
