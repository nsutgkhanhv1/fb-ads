const path = require("path");
const ROOT = process.argv[2] || path.resolve(__dirname, "..");
const Api = require(path.join(ROOT, "shared/fb-api.js"));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  -> " + JSON.stringify(extra).slice(0, 300))); };
const acc = raw => Api.transformFbAccount(Object.assign({ account_id: "1", name: "A" }, raw), "Via", "100");

ok("country: Asia/Ho_Chi_Minh -> VN (không còn là tên thành phố 'Ho_Chi_Minh')", acc({ timezone_name: "Asia/Ho_Chi_Minh" }).country === "VN");
ok("country: các múi giờ Mỹ -> US", ["America/Los_Angeles", "America/New_York", "America/Chicago", "Pacific/Honolulu"].every(z => acc({ timezone_name: z }).country === "US"));
ok("country: một số múi giờ phổ biến khác", acc({ timezone_name: "Asia/Bangkok" }).country === "TH" && acc({ timezone_name: "Europe/London" }).country === "GB" && acc({ timezone_name: "Asia/Kolkata" }).country === "IN" && acc({ timezone_name: "Australia/Sydney" }).country === "AU");
ok("country: múi giờ không có trong bảng -> null (không đoán, không dùng tên thành phố)", acc({ timezone_name: "Mars/Olympus_Mons" }).country === null && acc({ timezone_name: "UTC" }).country === null);
ok("country: thiếu múi giờ -> null (trước đây mặc định 'VN' là đoán sai)", acc({}).country === null);
ok("timezone: lưu tên + độ lệch giờ từ Facebook", (() => { const a = acc({ timezone_name: "Asia/Kolkata", timezone_offset_hours_utc: 5.5 }); return a.timezone === "Asia/Kolkata" && a.timezoneOffset === 5.5; })());
ok("timezone: độ lệch 0 (UTC+0) được giữ, không bị coi là thiếu", acc({ timezone_name: "Europe/London", timezone_offset_hours_utc: 0 }).timezoneOffset === 0);
ok("timezone: thiếu dữ liệu -> null", (() => { const a = acc({}); return a.timezone === null && a.timezoneOffset === null; })());
ok("viaUids vẫn được ghi (executor_uid cho Super Share)", acc({}).viaUids[0] === "100");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
