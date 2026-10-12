/**
 * Đóng gói extension để gửi cho user chạy thử:  npm run pack
 *  - Chỉ copy file extension cần (manifest, icons, extension, shared, web), không gồm tests / docs / spikes / docx / ảnh.
 *  - Kiểm tra mọi file mà manifest và background.js tham chiếu đều có mặt trong gói.
 *  - Tạo dist/amit-extension-v<version>.zip (Windows: PowerShell Compress-Archive; macOS/Linux: zip).
 *  - Kèm HUONG_DAN_TEST.txt cho user.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const NAME = `amit-extension-v${manifest.version}`;
const DIST = path.join(ROOT, "dist");
const STAGE = path.join(DIST, NAME);
const INCLUDE = ["manifest.json", "icons", "extension", "shared", "web"];

function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function copyRec(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    fs.readdirSync(src).forEach(f => copyRec(path.join(src, f), path.join(dst, f)));
  } else {
    fs.copyFileSync(src, dst);
  }
}

rmrf(STAGE);
fs.mkdirSync(STAGE, { recursive: true });
INCLUDE.forEach(p => copyRec(path.join(ROOT, p), path.join(STAGE, p)));

// ---- kiểm tra tham chiếu ----
const missing = [];
const need = rel => { if (!fs.existsSync(path.join(STAGE, rel))) missing.push(rel); };
Object.values(manifest.icons || {}).forEach(need);
need(manifest.action.default_popup);
need(manifest.background.service_worker);
(manifest.content_scripts || []).forEach(cs => cs.js.forEach(need));
(manifest.web_accessible_resources || []).forEach(r => r.resources.forEach(need));

const bgDir = path.dirname(manifest.background.service_worker);
const bgSrc = fs.readFileSync(path.join(STAGE, manifest.background.service_worker), "utf8");
(bgSrc.match(/importScripts\(([^)]*)\)/) || [, ""])[1].split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
  .forEach(rel => need(path.join(bgDir, rel).replace(/\\/g, "/")));

// file được inject động bằng chrome.scripting.executeScript({ files: [...] })
const scan = f => {
  const src = fs.readFileSync(path.join(STAGE, f), "utf8");
  (src.match(/files:\s*\[[^\]]*\]/g) || []).forEach(m => (m.match(/"([^"]+\.js)"/g) || []).forEach(x => need(x.replace(/"/g, ""))));
};
["extension/background.js", "extension/batch-controller.js"].forEach(scan);

// script tag trong các trang html
["extension/popup/popup.html", "extension/logs/logs.html", "web/index.html"].forEach(htmlRel => {
  const html = fs.readFileSync(path.join(STAGE, htmlRel), "utf8");
  (html.match(/<script[^>]+src="([^"]+)"/g) || []).forEach(tag => {
    const src = tag.match(/src="([^"]+)"/)[1];
    need(path.posix.normalize(path.posix.join(path.posix.dirname(htmlRel), src)));
  });
});

if (missing.length) {
  console.error("THIẾU file được tham chiếu trong gói:\n  - " + [...new Set(missing)].join("\n  - "));
  process.exit(1);
}

fs.writeFileSync(path.join(STAGE, "HUONG_DAN_TEST.txt"), fs.readFileSync(path.join(ROOT, "docs", "HUONG_DAN_TEST.md"), "utf8"));

// ---- nén ----
const zipPath = path.join(DIST, `${NAME}.zip`);
rmrf(zipPath);
try {
  if (process.platform === "win32") {
    execFileSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${zipPath}' -Force`], { stdio: "inherit" });
  } else {
    execFileSync("zip", ["-qr", zipPath, "."], { cwd: STAGE, stdio: "inherit" });
  }
} catch (e) {
  console.warn("Không nén được tự động (" + e.message + "). Hãy tự nén thư mục:", STAGE);
}

const count = d => fs.readdirSync(d, { withFileTypes: true }).reduce((n, f) => n + (f.isDirectory() ? count(path.join(d, f.name)) : 1), 0);
console.log(`OK: ${count(STAGE)} file -> ${STAGE}`);
if (fs.existsSync(zipPath)) console.log(`ZIP: ${zipPath} (${(fs.statSync(zipPath).size / 1024).toFixed(0)} KB)`);
console.log("Phiên bản:", manifest.version);
