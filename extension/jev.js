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
 * HAI ENDPOINT (OpenRouter):
 *   - Model "decisions" (Jev: jev-latest, typesafe/jev-1.13...) KHÔNG dùng được với chat/completions; phải gọi
 *     POST /api/alpha/decisions với một câu hỏi kiểu "choice" (state + questions -> answers). Đây là đường chính của Jev.
 *   - Model chat thường (vd openai/gpt-4o-mini) vẫn đi chat/completions.
 *   Chọn endpoint theo tên model; nếu OpenRouter báo "is a decisions model" thì tự chuyển sang decisions và nhớ lại.
 *
 * Dữ liệu gửi ra ngoài: goal + nhãn các control (cắt 60 ký tự, dãy số >= 6 chữ số và email bị che).
 * KHÔNG gửi HTML, token, cookie hay dữ liệu form.
 */

const JEV_CONFIG_KEY = "amit_jev_config";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const JEV_DEFAULTS = Object.freeze({
  enabled: false,
  apiKey: "",
  model: "~typesafe/jev-latest", // model decisions của Jev; đổi trong popup (model chat thường như openai/gpt-4o-mini vẫn dùng được)
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

/**
 * Model "decisions" của Jev: jev-latest, ~typesafe/jev-latest, typesafe/jev-1.13[-yyyymmdd]...
 * Không khớp typesafe/jev-router (đó là model chat, đi chat/completions).
 */
function isDecisionsModel(model) {
  return /(^|\/)jev-(latest|\d[\w.-]*)$/i.test(String(model || "").trim());
}

// Model nào OpenRouter đã báo là decisions (dù tên không khớp mẫu trên): nhớ trong vòng đời service worker để khỏi gọi sai lần nữa.
const jevDecisionsModels = new Set();
const usesDecisions = model => isDecisionsModel(model) || jevDecisionsModels.has(model);

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

const JEV_QUESTION = "control";
const JEV_NONE = "none";

/**
 * Body cho POST /api/alpha/decisions: MỘT câu hỏi kiểu "choice" (mỗi candidate là một lựa chọn "c<index>", thêm "none").
 * state = nội dung cần đánh giá (goal + step); criteria = mô tả từng control (nhãn đã che số dài / email).
 */
function buildDecisionsRequest(req, model, maxCandidates) {
  const criteria = {};
  (req.candidates || []).slice(0, maxCandidates).forEach((c, i) => {
    const idx = typeof c.index === "number" ? c.index : i;
    const tag = String(c.tag || "").slice(0, 20);
    const role = c.role ? ` (role: ${String(c.role).slice(0, 20)})` : "";
    criteria[`c${idx}`] = `${tag}${role}: "${jevSanitizeLabel(c.label)}"`;
  });
  criteria[JEV_NONE] = "No candidate clearly matches the goal, or several match equally well.";
  return {
    model,
    state: { step: String(req.step || "").slice(0, 40), goal: String(req.goal || "").slice(0, 400) },
    questions: {
      [JEV_QUESTION]: {
        type: "choice",
        instructions: [
          "Which UI control best matches state.goal? You only locate controls; which account, user, role or action to use is already fixed by the goal.",
          "Never choose a control whose purpose is to cancel, close, go back or dismiss unless the goal explicitly asks for it.",
          "Labels may be Vietnamese or English."
        ].join(" "),
        criteria
      }
    }
  };
}

/**
 * Trả { index, confidence } hợp lệ, hoặc null nếu phản hồi không dùng được (cùng hợp đồng với parseJevResponse).
 * confidence lấy từ answer.confidence; thiếu thì dùng xác suất của lựa chọn; thiếu cả hai thì bỏ (không bịa).
 */
function parseDecisionsResponse(json, candidateCount) {
  const a = json && json.answers && json.answers[JEV_QUESTION];
  if (!a || a.type !== "choice" || typeof a.choice !== "string") return null;
  let confidence = Number.isFinite(a.confidence) ? a.confidence
    : (a.probabilities && Number.isFinite(a.probabilities[a.choice]) ? a.probabilities[a.choice] : null);
  if (confidence === null) return null;
  confidence = Math.min(1, Math.max(0, confidence));
  if (a.choice === JEV_NONE) return { index: null, confidence };
  const m = /^c(\d+)$/.exec(a.choice);
  if (!m) return null;
  const idx = Number(m[1]);
  if (!Number.isInteger(idx) || idx < 0 || idx >= candidateCount) return null;
  return { index: idx, confidence };
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
  jlog(result.ok ? "info" : "warn", "jev.response", { step: req.step, ms: Date.now() - t0, ok: result.ok, index: result.index, confidence: result.confidence, reason: result.reason, message: result.message, model: result.model || cfg.model, mode: result.mode });
  return result;
}

/** Lý do lỗi do OpenRouter trả về (body {error:{message}}), cắt gọn; không bao giờ chứa key. */
async function jevErrorDetail(res) {
  try {
    const j = await res.json();
    const m = j && j.error && (j.error.message || j.error);
    return typeof m === "string" ? m.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  } catch (_) { return ""; }
}

function jevHttpMessage(status, detail) {
  if (status === 401) return "API key không hợp lệ.";
  if (status === 402) return "OpenRouter báo hết credit (402).";
  return `OpenRouter trả lỗi ${status}${detail ? `: ${detail}` : "."}`;
}

async function jevCall(url, cfg, body, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    return await doFetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Authorization": `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "AMIT V1 Super Share"
      },
      body: JSON.stringify(body)
    });
  } finally {
    clearTimeout(timer);
  }
}

async function jevResolveInner(req, cfg, cands, fetchImpl) {
  let mode = usesDecisions(cfg.model) ? "decisions" : "chat";
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = mode === "decisions"
        ? await jevCall(OPENROUTER_DECISIONS_URL, cfg, buildDecisionsRequest(req, cfg.model, cfg.maxCandidates), fetchImpl)
        : await jevCall(OPENROUTER_URL, cfg, { model: cfg.model, messages: buildJevMessages(req, cfg.maxCandidates), temperature: 0, max_tokens: 60 }, fetchImpl);
      if (!res.ok) {
        const detail = await jevErrorDetail(res);
        // "<model> is a decisions model and cannot be used with the chat/completions endpoint": đổi endpoint một lần rồi nhớ.
        if (mode === "chat" && attempt === 0 && /decisions model/i.test(detail)) {
          jevDecisionsModels.add(cfg.model);
          jlog("info", "jev.endpoint_switch", { model: cfg.model, to: "decisions" });
          mode = "decisions";
          continue;
        }
        return { ok: false, reason: `HTTP_${res.status}`, message: jevHttpMessage(res.status, detail), mode };
      }
      const json = await res.json();
      const parsed = mode === "decisions"
        ? parseDecisionsResponse(json, cands.length)
        : parseJevResponse(json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content, cands.length);
      if (!parsed) return { ok: false, reason: "BAD_RESPONSE", mode };
      return { ok: true, index: parsed.index, confidence: parsed.confidence, model: json.model || cfg.model, mode };
    }
    return { ok: false, reason: "BAD_RESPONSE", mode };
  } catch (e) {
    return { ok: false, reason: e && e.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR", mode };
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
  module.exports = { buildJevMessages, parseJevResponse, buildDecisionsRequest, parseDecisionsResponse, isDecisionsModel, jevSanitizeLabel, getJevConfig, saveJevConfig, publicJevConfig, jevResolve, jevTest, JEV_CONFIG_KEY, OPENROUTER_URL, OPENROUTER_DECISIONS_URL, JEV_DEFAULTS };
}
