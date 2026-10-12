/**
 * AMIT V1 - Trang "Log & báo lỗi": xem tóm tắt, xuất file log, xóa log.
 * Log được service worker ghi vào chrome.storage.local; trang này chỉ đọc (và nhờ service worker xóa).
 */
document.addEventListener("DOMContentLoaded", () => {
  AmitLog.init("logs");
  AmitLog.info("logs.open", {});

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const setMsg = (text, color) => { $("msg").textContent = text; $("msg").style.color = color || ""; };

  // Dữ liệu cấu hình / trạng thái đưa vào header của file (không có token, cookie, API key)
  async function collectHeader() {
    const st = await chrome.storage.local.get(["amit_batch_current", "via_sessions", "active_uid", "amit_live_accounts", "amit_last_sync", "amit_jev_config"]);
    const jev = st.amit_jev_config || {};
    const accounts = st.amit_live_accounts || [];
    const b = st.amit_batch_current;
    return {
      settings: { jev: { enabled: !!jev.enabled, model: jev.model || null, hasKey: !!jev.apiKey } },
      sessions: Object.values(st.via_sessions || {}).map(v => ({ uid: v.uid, hasToken: !!v.accessToken, hasDtsg: !!v.fb_dtsg, updatedAt: v.updatedAt })),
      active_uid: st.active_uid || null,
      accounts: { count: accounts.length, with_via_uids: accounts.filter(a => (a.viaUids || []).length).length, last_sync: st.amit_last_sync || null },
      batch: b ? {
        id: b.id, status: b.status, pause_reason: b.pause_reason, total: b.total, processed: b.processed, success: b.success, failed: b.failed,
        items: (b.items || []).slice(0, 50).map(i => ({ ad_account_id: i.ad_account_id, action: i.action, status: i.status, error_code: i.error_code }))
      } : null
    };
  }

  async function flushServiceWorker() {
    try { await chrome.runtime.sendMessage({ action: "log_flush" }); } catch (_) { /* service worker đang ngủ: dữ liệu đã được ghi */ }
  }

  async function refresh() {
    await flushServiceWorker();
    const { meta, entries } = await AmitLog.readStored();
    const counts = { debug: 0, info: 0, warn: 0, error: 0 };
    entries.forEach(e => { if (counts[e.lvl] !== undefined) counts[e.lvl]++; });
    const fmt = ts => (ts ? new Date(ts).toLocaleString("vi-VN") : "—");
    $("stats").innerHTML = [
      ["Số dòng log", entries.length.toLocaleString("vi-VN")],
      ["Lỗi", counts.error],
      ["Cảnh báo", counts.warn],
      ["Từ", fmt(entries[0] && entries[0].ts)],
      ["Đến", fmt(entries[entries.length - 1] && entries[entries.length - 1].ts)],
      ["Dòng cũ đã bị bỏ", meta ? meta.pruned : 0]
    ].map(([k, v]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join("");

    const only = $("onlyProblems").checked;
    const shown = entries.filter(e => !only || e.lvl === "warn" || e.lvl === "error").slice(-100).reverse();
    $("viewer").innerHTML = shown.length
      ? shown.map(e => `<div class="lvl-${esc(e.lvl)}">${esc(new Date(e.ts).toLocaleTimeString("vi-VN"))} [${esc(e.ctx)}] ${esc(e.ev)} ${esc(JSON.stringify(e.data || {}).slice(0, 300))}</div>`).join("")
      : `<div class="lvl-debug">Chưa có dòng log nào.</div>`;
  }

  $("exportBtn").onclick = async () => {
    $("exportBtn").disabled = true;
    try {
      await flushServiceWorker();
      const header = await collectHeader();
      const out = await AmitLog.buildLogText({ note: $("note").value.trim(), header });
      const blob = new Blob([out.text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = out.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      AmitLog.info("logs.export", { filename: out.filename, entries: out.stats.entries, errors: out.stats.counts.error, warnings: out.stats.counts.warn, note_len: $("note").value.length });
      setMsg(`Đã tải file ${out.filename} (${out.stats.entries.toLocaleString("vi-VN")} dòng). Hãy gửi file này cho người phát triển.`, "var(--ok)");
    } catch (e) {
      AmitLog.error("logs.export_failed", { error: e });
      setMsg(`Không xuất được file log: ${e && e.message ? e.message : e}`, "var(--err)");
    } finally {
      $("exportBtn").disabled = false;
    }
  };

  $("clearBtn").onclick = async () => {
    if (!confirm("Xóa toàn bộ log? Chỉ nên xóa sau khi đã gửi file log cho người phát triển.")) return;
    try {
      await chrome.runtime.sendMessage({ action: "log_clear" });
      setMsg("Đã xóa log.", "var(--ok)");
      await refresh();
    } catch (e) {
      setMsg(`Không xóa được log: ${e && e.message ? e.message : e}`, "var(--err)");
    }
  };

  $("refreshBtn").onclick = () => refresh();
  $("onlyProblems").onchange = () => refresh();

  refresh();
});
