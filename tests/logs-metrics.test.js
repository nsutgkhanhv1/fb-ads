/**
 * Test giao diện số liệu nghiệm thu ở trang Log (extension/logs/logs.html + logs.js) bằng jsdom và chrome giả.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const ROOT = process.argv[2] || path.resolve(__dirname, "..");
const M = require(path.join(ROOT, "shared/metrics.js"));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  -> " + JSON.stringify(extra).slice(0, 500))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const html = fs.readFileSync(path.join(ROOT, "extension/logs/logs.html"), "utf8").replace(/<script src="[^"]+"><\/script>/g, "");
  const loggerSrc = fs.readFileSync(path.join(ROOT, "shared/logger.js"), "utf8");
  const logsSrc = fs.readFileSync(path.join(ROOT, "extension/logs/logs.js"), "utf8");

  // dữ liệu: Graph nhanh, DOM chậm, 35 cặp chung
  const rec = (engine, i, ms) => ({ ts: i, engine, is_retry: false, action: "SHARE_USER", role: "ADMIN", ad_account_id: "act" + (1000 + i), item_ms: ms, target_ms: ms, status: "SUCCESS", error_code: null, verify_state: engine === "graph" ? "MATCH" : null, method_used: engine === "graph" ? "USERS" : null });
  const data = { since: "2026-10-01T00:00:00.000Z", targets: [], events: [{ ts: 1, name: "batch_paused", reason: "RATE_LIMITED" }], requests: [{ ts: 1, endpoint: "/act_{id}/users", method: "POST", ms: 800, ok: true }] };
  for (let i = 0; i < 35; i++) { data.targets.push(rec("graph", i, 1500 + i)); data.targets.push(rec("dom", i, 9000 + i)); }
  let config = Object.assign({}, M.DEFAULT_CONFIG);
  const sent = [];

  const dom = new JSDOM(html, { runScripts: "outside-only", url: "chrome-extension://abc/extension/logs/logs.html", pretendToBeVisual: true });
  const w = dom.window;
  w.confirm = () => true;
  let blobText = null;
  w.Blob = function (parts) { blobText = parts.join(""); };
  w.URL.createObjectURL = () => "blob:x"; w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { this.__downloaded = this.download; w.__download = this.download; };
  const store = {};
  w.chrome = {
    storage: { local: {
      get: async () => ({}),
      set: async o => { Object.assign(store, o); },
      remove: async () => {}
    } },
    runtime: {
      id: "abc",
      sendMessage: async msg => {
        sent.push(msg.action);
        switch (msg.action) {
          case "get_metrics": return { ok: true, summary: M.summarize(data, config), config };
          case "set_metrics_config": { const v = M.validateConfig(msg.patch); if (v.error) return { ok: false, error: "INVALID_INPUT", message: v.error }; config = Object.assign({}, config, v.value); return { ok: true, config }; }
          case "export_metrics": return { ok: true, data: M.exportData(data, M.summarize(data, config)) };
          case "clear_metrics": data.targets = []; data.events = []; data.requests = []; return { ok: true };
          default: return { ok: true };
        }
      }
    }
  };
  w.eval(loggerSrc + "\n;\n" + logsSrc);
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  await sleep(150);
  const $ = id => w.document.getElementById(id);

  ok("logs: card số liệu có đủ ô ngưỡng, nút Lưu / Làm mới / Xuất / Xóa", ["mThreshold", "mMinSamples", "mSave", "mRefresh", "mExport", "mClear", "acBoxes", "engineTable"].every(id => !!$(id)));
  ok("logs: lúc đầu chưa đặt ngưỡng -> AC10 'Chưa đặt ngưỡng'; ô ngưỡng để trống; mẫu tối thiểu 30", $("acBoxes").textContent.includes("AC10") && $("acBoxes").textContent.includes("Chưa đặt ngưỡng") && $("mThreshold").value === "" && $("mMinSamples").value === "30", $("acBoxes").textContent);
  ok("logs: AC11 hiển thị 'Đạt' với P95 Graph và DOM (35 cặp chung)", /AC11\s*Đạt/.test($("acBoxes").textContent) && $("acBoxes").textContent.includes("35 cặp") && $("acBoxes").textContent.includes("1.5 s") && $("acBoxes").textContent.includes("9.0 s"), $("acBoxes").textContent);
  ok("logs: bảng so sánh hai engine (35 target, 100.0% thành công)", $("engineTable").textContent.includes("Graph") && $("engineTable").textContent.includes("DOM") && $("engineTable").textContent.includes("100.0%"), $("engineTable").textContent.slice(0, 200));
  ok("logs: chỉ số vận hành hiển thị batch_paused_total và permission_duration_ms", $("opsTables").textContent.includes("batch_paused_total") && $("opsTables").textContent.includes("RATE_LIMITED") && $("opsTables").textContent.includes("/act_{id}/users"));

  // đặt ngưỡng 95% -> PASS (verified_rate = 100%)
  $("mThreshold").value = "95"; $("mMinSamples").value = "30";
  $("mSave").onclick(); await sleep(80);
  ok("logs: lưu ngưỡng 95% -> AC10 'Đạt'", config.ac10_min_verified_rate === 0.95 && /AC10\s*Đạt/.test($("acBoxes").textContent) && $("mMsg").textContent.includes("Đã lưu"), { cfg: config, t: $("acBoxes").textContent });

  // ngưỡng sai -> báo lỗi, không đổi
  $("mThreshold").value = "150";
  $("mSave").onclick(); await sleep(80);
  ok("logs: ngưỡng 150% bị từ chối với thông báo, cấu hình giữ nguyên 95%", config.ac10_min_verified_rate === 0.95 && $("mMsg").textContent.includes("Ngưỡng AC10"), $("mMsg").textContent);

  // để trống = bỏ ngưỡng
  $("mThreshold").value = "";
  $("mSave").onclick(); await sleep(80);
  ok("logs: để trống ô ngưỡng -> gỡ ngưỡng (NO_THRESHOLD)", config.ac10_min_verified_rate === null && $("acBoxes").textContent.includes("Chưa đặt ngưỡng"));

  // xuất
  $("mExport").onclick(); await sleep(80);
  const exported = blobText ? JSON.parse(blobText) : null;
  ok("logs: xuất JSON tên AMIT-metrics-*.json, ID TKQC đã che, có summary", /^AMIT-metrics-.*\.json$/.test(w.__download || "") && exported && exported.targets.length === 70 && exported.targets.every(r => /…/.test(r.ad_account_id)) && !!exported.summary.ac11, { dl: w.__download });

  // xóa
  $("mClear").onclick(); await sleep(80);
  ok("logs: xóa số liệu -> bảng về 0, AC11 chưa đủ dữ liệu", data.targets.length === 0 && $("acBoxes").textContent.includes("Chưa đủ dữ liệu"), $("acBoxes").textContent);

  // an toàn HTML: giá trị lạ không chèn được thẻ
  data.events = [{ ts: 1, name: "batch_paused", reason: "<img src=x onerror=alert(1)>" }];
  $("mRefresh").onclick(); await sleep(80);
  ok("logs: dữ liệu lạ được escape, không tạo thẻ HTML", $("opsTables").querySelector("img") === null && $("opsTables").textContent.includes("<img"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("CRASH", e); process.exit(2); });
