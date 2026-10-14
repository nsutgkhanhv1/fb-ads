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
    let metrics = null;
    try {
      const m = await chrome.runtime.sendMessage({ action: "get_metrics" });
      if (m && m.ok) metrics = { ac10: m.summary.ac10, ac11: m.summary.ac11, graph: m.summary.engines.graph, dom: m.summary.engines.dom, sample: m.summary.sample };
    } catch (_) { /* không có số liệu thì thôi */ }
    return {
      metrics,
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

  // ---------------- Số liệu nghiệm thu AC10 / AC11 ----------------
  const pct = v => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`);
  const dur = v => (v === null || v === undefined ? "—" : (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`));
  const VERDICT = {
    PASS: ["Đạt", "ok"], FAIL: ["Không đạt", "err"],
    INSUFFICIENT_DATA: ["Chưa đủ dữ liệu", "warn"], NO_THRESHOLD: ["Chưa đặt ngưỡng", "warn"]
  };
  const badge = status => { const [t, c] = VERDICT[status] || [status, "warn"]; return `<span class="badge ${c}">${esc(t)}</span>`; };
  const setMMsg = (text, color) => { $("mMsg").textContent = text; $("mMsg").style.color = color || ""; };

  function renderMetrics(res) {
    const s = res.summary, g = s.engines.graph, d = s.engines.dom, a10 = s.ac10, a11 = s.ac11;
    $("mThreshold").value = res.config.ac10_min_verified_rate === null ? "" : +(res.config.ac10_min_verified_rate * 100).toFixed(2);
    $("mMinSamples").value = res.config.min_samples;

    $("acBoxes").innerHTML = `
      <div class="ac"><b>AC10 ${badge(a10.status)}</b>
        <div class="sub" style="margin:6px 0 0">Tỷ lệ xác minh thành công (Graph): <b>${pct(a10.verified_rate)}</b>
        trên ${a10.samples} target đã đọc lại · ngưỡng: <b>${a10.threshold === null ? "chưa đặt" : pct(a10.threshold)}</b> · cần ≥ ${a10.min_samples} mẫu</div></div>
      <div class="ac"><b>AC11 ${badge(a11.status)}</b>
        <div class="sub" style="margin:6px 0 0">P95 mỗi target: Graph <b>${dur(a11.graph_p95_ms)}</b> so với DOM <b>${dur(a11.dom_p95_ms)}</b>
        · ${a11.common_sets} cặp (TKQC + action) chạy được bằng cả hai engine · mẫu ${a11.graph_samples}/${a11.dom_samples} (cần ≥ ${a11.min_samples} mỗi bên)</div></div>`;

    const row = (name, e) => `<tr><td><b>${name}</b></td><td>${e.targets}</td><td>${pct(e.success_rate)}</td>
      <td>${e.verifiable ? pct(e.verified_rate) : "—"}</td><td>${e.failed_before_verify}</td><td>${dur(e.latency.p50_ms)}</td><td>${dur(e.latency.p95_ms)}</td></tr>`;
    $("engineTable").innerHTML = `<table class="m"><thead><tr><th>Engine</th><th>Target</th><th>Thành công</th><th>Xác minh</th><th>Lỗi trước xác minh</th><th>P50 / target</th><th>P95 / target</th></tr></thead>
      <tbody>${row("Graph", g)}${row("DOM", d)}</tbody></table>
      <p class="sub" style="margin:6px 0 0">Thời gian mỗi target = thời gian TKQC chạy xong chia đều cho số target (không tính chờ backoff và delay giữa các TKQC), chỉ target thành công.
      Dữ liệu từ ${esc(s.since ? new Date(s.since).toLocaleString("vi-VN") : "—")}${s.sample.truncated ? " · đã đầy bộ nhớ, bản ghi cũ nhất bị bỏ" : ""}; ${s.sample.retries} lượt Retry không được tính.</p>`;

    const list = (title, rows, cols) => rows.length
      ? `<table class="m"><caption style="text-align:left;font-weight:600;padding-top:8px">${esc(title)}</caption><tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${esc(r[c] === null ? "—" : r[c])}</td>`).join("")}</tr>`).join("")}</tbody></table>`
      : "";
    $("opsTables").innerHTML =
      list("permission_requests_total (engine, action, role, method, status, số lượng)", s.permission_requests_total.slice(0, 15), ["engine", "action", "role", "method_used", "status", "count"]) +
      list("permission_duration_ms (method, endpoint, số request, lỗi, P50, P95)", s.permission_duration_ms.slice(0, 15), ["method", "endpoint", "count", "errors", "p50_ms", "p95_ms"]) +
      list("permission_verify_total", s.permission_verify_total, ["verify_state", "count"]) +
      list("token_refresh_total (slot, nguồn)", s.token_refresh_total, ["slot", "reason", "count"]) +
      list("batch_paused_total", s.batch_paused_total, ["reason", "count"]) +
      list("retry_total (mã lỗi, lần thử)", s.retry_total, ["error_code", "attempt", "count"]) +
      list("rate_backoff_total (lần thử)", s.rate_backoff_total, ["attempt", "count"]) || '<p class="sub">Chưa có dữ liệu.</p>';
  }

  async function refreshMetrics() {
    try {
      const res = await chrome.runtime.sendMessage({ action: "get_metrics" });
      if (!res || !res.ok) throw new Error((res && (res.message || res.error)) || "Extension không phản hồi.");
      renderMetrics(res);
    } catch (e) {
      setMMsg(`Không đọc được số liệu: ${e && e.message ? e.message : e}`, "var(--err)");
    }
  }

  $("mSave").onclick = async () => {
    const t = $("mThreshold").value.trim();
    const patch = { ac10_min_verified_rate: t === "" ? null : Number(t) / 100, min_samples: Number($("mMinSamples").value) };
    try {
      const res = await chrome.runtime.sendMessage({ action: "set_metrics_config", patch });
      if (!res || !res.ok) { setMMsg(res && res.message ? res.message : "Không lưu được cấu hình.", "var(--err)"); return; }
      AmitLog.info("metrics.config", { ac10_min_verified_rate: res.config.ac10_min_verified_rate, min_samples: res.config.min_samples });
      setMMsg("Đã lưu ngưỡng.", "var(--ok)");
      await refreshMetrics();
    } catch (e) { setMMsg(`Không lưu được: ${e && e.message ? e.message : e}`, "var(--err)"); }
  };

  $("mExport").onclick = async () => {
    try {
      const res = await chrome.runtime.sendMessage({ action: "export_metrics" });
      if (!res || !res.ok) throw new Error((res && (res.message || res.error)) || "Extension không phản hồi.");
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `AMIT-metrics-${stamp}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      AmitLog.info("metrics.export", { targets: res.data.targets.length });
      setMMsg(`Đã tải AMIT-metrics-${stamp}.json (ID TKQC đã che ở giữa).`, "var(--ok)");
    } catch (e) { setMMsg(`Không xuất được: ${e && e.message ? e.message : e}`, "var(--err)"); }
  };

  $("mClear").onclick = async () => {
    if (!confirm("Xóa toàn bộ số liệu nghiệm thu? Chỉ nên xóa khi bắt đầu một đợt đo mới (cùng tập TKQC cho cả hai engine).")) return;
    try {
      await chrome.runtime.sendMessage({ action: "clear_metrics" });
      setMMsg("Đã xóa số liệu.", "var(--ok)");
      await refreshMetrics();
    } catch (e) { setMMsg(`Không xóa được: ${e && e.message ? e.message : e}`, "var(--err)"); }
  };
  $("mRefresh").onclick = () => refreshMetrics();

  $("refreshBtn").onclick = () => refresh();
  $("onlyProblems").onchange = () => refresh();

  refresh();
  refreshMetrics();
});
