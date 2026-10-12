/**
 * AMIT V1 - Metrics service (service worker) (docx kiến trúc §17 AC10/AC11, §18.1)
 *
 * Cầu nối giữa batch controller / Graph client / token provider và shared/metrics.js. Mọi hàm ghi đều "bắn rồi quên":
 * lỗi metrics KHÔNG BAO GIỜ được làm hỏng một batch.
 *
 * Phụ thuộc toàn cục: AmitMetrics (shared/metrics.js), chrome.storage.local.
 */

const AMIT_METRICS_CONFIG_KEY = "amit_metrics_config";

const AmitMetricsRuntime = (function () {
  let store = null;
  function get() {
    if (store) return store;
    const M = globalThis.AmitMetrics;
    store = M.createStore({
      read: async () => (await chrome.storage.local.get(M.KEY))[M.KEY],
      write: data => chrome.storage.local.set({ [M.KEY]: data }),
      now: () => Date.now()
    });
    return store;
  }
  /** Dùng trong test để thay kho. */
  function setForTest(s) { store = s; }
  return { get, setForTest };
})();

const metricsSafe = fn => { try { const r = fn(); if (r && typeof r.catch === "function") r.catch(() => {}); } catch (_) { /* metrics không được làm hỏng luồng chính */ } };

/** Sự kiện đếm: batch_paused, retry, token_refresh, rate_backoff. */
function metricsEvent(name, fields) {
  if (!globalThis.AmitMetrics) return;
  metricsSafe(() => AmitMetricsRuntime.get().add("events", Object.assign({ ts: Date.now(), name }, fields)));
}

/** Một TKQC có kết quả cuối (SUCCESS / FAILED) -> bản ghi từng target. Kết quả PAUSED chưa xong nên không ghi. */
function metricsRecordItem(batch, result, timing) {
  if (!globalThis.AmitMetrics || !result || (result.status !== "SUCCESS" && result.status !== "FAILED")) return;
  metricsSafe(() => {
    const recs = globalThis.AmitMetrics.targetRecords({
      ts: Date.now(), batch_id: batch.id, engine: batch.engine, is_retry: !!batch.retry_of,
      item_ms: timing.item_ms, backoff_ms: timing.backoff_ms
    }, result);
    return AmitMetricsRuntime.get().addMany("targets", recs);
  });
}

/** Mỗi request Graph (graph-client gọi qua deps.onRequest). Endpoint đã được chuẩn hóa, không chứa ID thật. */
function metricsRequest(info) {
  if (!globalThis.AmitMetrics) return;
  metricsSafe(() => AmitMetricsRuntime.get().add("requests", {
    ts: Date.now(), endpoint: globalThis.AmitMetrics.normalizeEndpoint(info.endpoint), method: info.method, mutation: !!info.mutation,
    ms: info.ms, ok: !!info.ok, error_code: info.error_code || null
  }));
}

async function metricsConfig() {
  const M = globalThis.AmitMetrics;
  const stored = (await chrome.storage.local.get(AMIT_METRICS_CONFIG_KEY))[AMIT_METRICS_CONFIG_KEY];
  return Object.assign({}, M.DEFAULT_CONFIG, stored);
}

async function handleGetMetrics() {
  const M = globalThis.AmitMetrics;
  const cfg = await metricsConfig();
  const data = await AmitMetricsRuntime.get().snapshot();
  return { ok: true, summary: M.summarize(data, cfg), config: cfg };
}

async function handleSetMetricsConfig(patch) {
  const M = globalThis.AmitMetrics;
  const v = M.validateConfig(patch);
  if (v.error) return { ok: false, error: "INVALID_INPUT", message: v.error };
  const next = Object.assign(await metricsConfig(), v.value);
  await chrome.storage.local.set({ [AMIT_METRICS_CONFIG_KEY]: next });
  return { ok: true, config: next };
}

async function handleExportMetrics() {
  const M = globalThis.AmitMetrics;
  const cfg = await metricsConfig();
  const data = await AmitMetricsRuntime.get().snapshot();
  return { ok: true, data: M.exportData(data, M.summarize(data, cfg)) };
}

async function handleClearMetrics() {
  await AmitMetricsRuntime.get().clear();
  return { ok: true };
}
