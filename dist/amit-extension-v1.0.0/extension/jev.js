/**
 * AMIT V1 - Jev (UI element locator) qua OpenRouter
 *
 * Jev CHỈ được dùng để xác định control UI khi selector đã biết / nhãn hiển thị không đủ (docx §11):
 *   - Nhận: goal theo từng bước + danh sách candidate (tag, role, label) đã được code lọc theo scope.
 *   - Trả:  index của một candidate + confidence. KHÔNG quyết định TKQC, UID, role, action, ai giữ / ai xóa.
 *   - Code (executor) luôn validate: index nằm trong danh sách, confidence >= ngưỡng, không phải nút Hủy/Đóng.
 *
 * CẤU HÌNH Ở MỘT NƠI DUY NHẤT: popup của extension -> mục "Jev (OpenRouter)".
 * Lưu trong chrome.storage.local[amit_jev_config]. Key chỉ được đọc trong service worker; không bao giờ trả về
 * cho content script / trang web (chỉ trả `hasKey` và 4 ký tự cuối).
 *
 * Dữ liệu gửi ra ngoài: goal + nhãn các control (cắt 60 ký tự, dãy số >= 6 chữ số và email bị che).
 * KHÔNG gửi HTML, token, cookie hay dữ liệu form.
 */

const JEV_CONFIG_KEY = "amit_jev_config";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const JEV_DEFAULTS = Object.freeze({
  enabled: false,
  apiKey: "",
  model: "openai/gpt-4o-mini", // đổi trong popup; mọi model OpenRouter hỗ trợ chat completions đều dùng được
  timeoutMs: 15000,
  maxCandidates: 40
});

const JEV_SYSTEM_PROMPT = [
  "You are a UI element locator for a browser automation tool.",
  "You receive a GOAL and a numbered list of CANDIDATE controls (tag, role, label).",
  "Pick the single candidate that best matches the goal.",
  "Rules:",
  "- You only locate controls. You never decide business logic: which account, user, role or action to use is already fixed by the goal text.",
  "- Never choose a control whose purpose is to cancel, close, go back or dismiss unless the goal explicitly asks for it.",
  "- If no candidate clearly matches, or several match equally well, answer null for index.",
  "- Labels may be Vietnamese or English.",
  'Reply with ONLY a JSON object, no prose: {"index": <integer or null>, "confidence": <number between 0 and 1>}'
].join("\n");

function jevSanitizeLabel(s) {
  return String(s === undefined || s === null ? "" : s)
    .replace(/\s+/g, " ")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/\d{6,}/g, "#")
    .trim()
    .slice(0, 60);
}

function buildJevMessages(req, maxCandidates) {
  const list = (req.candidates || []).slice(0, maxCandidates).map((c, i) => ({
    index: typeof c.index === "number" ? c.index : i,
    tag: String(c.tag || "").slice(0, 20),
    role: c.role ? String(c.role).slice(0, 20) : null,
    label: jevSanitizeLabel(c.label)
  }));
  return [
    { role: "system", content: JEV_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify({ step: String(req.step || "").slice(0, 40), goal: String(req.goal || "").slice(0, 400), candidates: list }) }
  ];
}

/** Trả { index, confidence } hợp lệ, hoặc null nếu phản hồi không dùng được. index=null nghĩa là Jev không chọn. */
function parseJevResponse(text, candidateCount) {
  if (typeof text !== "string") return null;
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch (_) { return null; }
  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence)) return null;
  confidence = Math.min(1, Math.max(0, confidence));
  if (obj.index === null) return { index: null, confidence };
  const idx = Number(obj.index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= candidateCount) return null;
  return { index: idx, confidence };
}

async function getJevConfig() {
  const store = await chrome.storage.local.get(JEV_CONFIG_KEY);
  return Object.assign({}, JEV_DEFAULTS, store[JEV_CONFIG_KEY] || {});
}

/** Cấu hình trả cho UI: KHÔNG chứa key. */
function publicJevConfig(cfg) {
  return {
    enabled: !!cfg.enabled,
    hasKey: !!cfg.apiKey,
    keyHint: cfg.apiKey ? `…${cfg.apiKey.slice(-4)}` : "",
    model: cfg.model
  };
}

/** patch: { enabled?, apiKey? (chuỗi rỗng = giữ nguyên), clearKey?, model? } */
async function saveJevConfig(patch) {
  const cur = await getJevConfig();
  const next = { enabled: cur.enabled, apiKey: cur.apiKey, model: cur.model };
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (patch.clearKey === true) next.apiKey = "";
  else if (typeof patch.apiKey === "string" && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim();
  if (typeof patch.model === "string" && patch.model.trim()) next.model = patch.model.trim().slice(0, 100);
  if (next.enabled && !next.apiKey) {
    return { ok: false, error: "Cần nhập OpenRouter API key trước khi bật Jev." };
  }
  await chrome.storage.local.set({ [JEV_CONFIG_KEY]: next });
  return { ok: true, config: publicJevConfig(Object.assign({}, JEV_DEFAULTS, next)) };
}

/**
 * Gọi OpenRouter để chọn candidate. Không ném lỗi: trả { ok, index, confidence } hoặc { ok:false, reason }.
 * fetchImpl chỉ để test.
 */
const jlog = (lvl, ev, data) => { try { if (typeof AmitLog !== "undefined") AmitLog[lvl](ev, data); } catch (_) {} };

async function jevResolve(req, fetchImpl) {
  const cfg = await getJevConfig();
  if (!cfg.enabled || !cfg.apiKey) { jlog("debug", "jev.skipped", { reason: "JEV_DISABLED", step: req && req.step }); return { ok: false, reason: "JEV_DISABLED" }; }

  const cands = req && Array.isArray(req.candidates) ? req.candidates : [];
  if (!req || typeof req.goal !== "string" || !cands.length) { jlog("warn", "jev.bad_request", { step: req && req.step }); return { ok: false, reason: "BAD_REQUEST" }; }
  if (cands.length > cfg.maxCandidates) { jlog("warn", "jev.too_many_candidates", { step: req.step, n: cands.length }); return { ok: false, reason: "TOO_MANY_CANDIDATES" }; }

  const t0 = Date.now();
  // Ghi đúng những gì được gửi ra ngoài (đã che số dài / email) để kiểm tra lại
  jlog("info", "jev.request", {
    step: req.step, goal: req.goal, model: cfg.model,
    candidates: cands.map((c, i) => ({ index: typeof c.index === "number" ? c.index : i, tag: c.tag, role: c.role || null, label: jevSanitizeLabel(c.label) }))
  });
  const result = await jevResolveInner(req, cfg, cands, fetchImpl);
  jlog(result.ok ? "info" : "warn", "jev.response", { step: req.step, ms: Date.now() - t0, ok: result.ok, index: result.index, confidence: result.confidence, reason: result.reason, message: result.message, model: result.model || cfg.model });
  return result;
}

async function jevResolveInner(req, cfg, cands, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await doFetch(OPENROUTER_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Authorization": `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "AMIT V1 Super Share"
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: buildJevMessages(req, cfg.maxCandidates),
        temperature: 0,
        max_tokens: 60
      })
    });
    if (!res.ok) {
      return { ok: false, reason: `HTTP_${res.status}`, message: res.status === 401 ? "API key không hợp lệ." : `OpenRouter trả lỗi ${res.status}.` };
    }
    const json = await res.json();
    const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    const parsed = parseJevResponse(content, cands.length);
    if (!parsed) return { ok: false, reason: "BAD_RESPONSE" };
    return { ok: true, index: parsed.index, confidence: parsed.confidence, model: json.model || cfg.model };
  } catch (e) {
    return { ok: false, reason: e && e.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR" };
  } finally {
    clearTimeout(timer);
  }
}

/** Nút "Kiểm tra kết nối" trong popup: một câu hỏi cố định có đáp án biết trước. */
async function jevTest(fetchImpl) {
  const r = await jevResolve({
    step: "TEST",
    goal: 'Locate the button that adds people ("Add people").',
    candidates: [
      { index: 0, tag: "button", role: null, label: "Cancel" },
      { index: 1, tag: "button", role: null, label: "Add people" },
      { index: 2, tag: "button", role: null, label: "Remove" }
    ]
  }, fetchImpl);
  if (!r.ok) return { ok: false, reason: r.reason, message: r.message || r.reason };
  return { ok: true, passed: r.index === 1, model: r.model, confidence: r.confidence };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildJevMessages, parseJevResponse, jevSanitizeLabel, getJevConfig, saveJevConfig, publicJevConfig, jevResolve, jevTest, JEV_CONFIG_KEY, OPENROUTER_URL, JEV_DEFAULTS };
}
