/*
 * Gemini через Interactions API (POST /v1beta/interactions).
 * Старый метод generateContent для новых ключей Google больше не работает (пустой 404) —
 * поэтому бот раньше «не помогал». Ключ хранится только на сервере (переменная GEMINI_API_KEY).
 *
 * Надёжность:
 *  - модели пробуются по очереди (GEMINI_MODELS); перегрузка (503), лимит (429), тайм-аут — переход к следующей;
 *  - если ни одна модель из списка не ответила, сервер один раз запрашивает у Google список доступных моделей
 *    (GET /v1beta/models) и пробует подходящие «flash»-модели — список в коде мог устареть;
 *  - причина каждого сбоя запоминается без ключа (lastErrors) и видна в /api/ai/status.
 */
const BASE = "https://generativelanguage.googleapis.com/v1beta";
const URL = BASE + "/interactions";
const configured = () => (process.env.GEMINI_MODELS || "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash").split(",").map(s => s.trim()).filter(Boolean);
const MODELS = configured();

const state = { lastErrors: [], discovered: null, discoveredAt: 0, lastOk: null, blocked: new Set() };
/** Текст ошибки без ключа и без лишнего: код и начало сообщения. */
const clean = s => String(s == null ? "" : s).replace(/AIza[0-9A-Za-z_-]{10,}/g, "[ключ]").replace(/key=[^&\s]+/gi, "key=[ключ]").slice(0, 160);
function remember(model, error) {
  state.lastErrors = state.lastErrors.concat([{ at: new Date().toISOString(), model, error: clean(error) }]).slice(-12);
}

/** Список моделей, доступных этому ключу (кэш 6 часов). Возвращает имена без префикса models/. */
async function listModels({ force = false } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { ok: false, error: "no_key", models: [] };
  if (!force && state.discovered && Date.now() - state.discoveredAt < 6 * 3600e3) return { ok: true, models: state.discovered, cached: true };
  try {
    const all = [];
    let token = "";
    for (let page = 0; page < 5; page++) {
      const r = await fetch(`${BASE}/models?pageSize=200${token ? "&pageToken=" + encodeURIComponent(token) : ""}`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(15000) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: clean((d.error && (d.error.status || d.error.message)) || "HTTP " + r.status), models: [] };
      for (const m of d.models || []) all.push({ name: String(m.name || "").replace(/^models\//, ""), methods: m.supportedGenerationMethods || [] });
      token = d.nextPageToken; if (!token) break;
    }
    state.discovered = all.map(m => m.name);
    state.discoveredAt = Date.now();
    return { ok: true, models: state.discovered };
  } catch (e) { return { ok: false, error: clean(e.name === "TimeoutError" ? "timeout" : e.message), models: [] }; }
}

/** Запасные модели из доступных: текстовые «flash», без экспериментальных и не для изображений/речи/эмбеддингов. */
function fallbackModels(available, tried) {
  const bad = /(image|vision|tts|audio|live|embed|aqa|imagen|veo|learnlm|exp|preview-tts|robotics|computer)/i;
  return available.filter(n => /^gemini-/.test(n) && /flash/.test(n) && !bad.test(n) && !tried.includes(n))
    .sort((a, b) => (/lite/.test(b) - /lite/.test(a)) || b.localeCompare(a, "en", { numeric: true }))
    .slice(0, 3);
}

async function tryModel(model, body, key, timeoutMs) {
  try {
    const r = await fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(Object.assign({ model }, body)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      const text = (d.steps || []).filter(s => s.type === "model_output")
        .flatMap(s => s.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
      if (text) return { ok: true, text, model };
      remember(model, "empty"); return { ok: false, error: "empty" };
    }
    const err = (d.error && (d.error.code || d.error.status || d.error.message)) || "HTTP " + r.status;
    const detail = `HTTP ${r.status} ${d.error && d.error.status ? d.error.status + " " : ""}${d.error && d.error.message ? d.error.message : ""}`.trim();
    remember(model, detail);
    console.error("Gemini", model, clean(detail));
    return { ok: false, error: String(err), status: r.status };
  } catch (e) {
    const err = e.name === "TimeoutError" ? "timeout" : e.message;
    remember(model, err); console.error("Gemini", model, clean(err));
    return { ok: false, error: err };
  }
}

/**
 * Классификация неудачи по HTTP-кодам всех попыток. Перегрузка Google (503) и тайм-аут — «overloaded»,
 * только 429 — «quota», 401/403 — «key», только 404 — «model_not_found».
 */
function classify(statuses, errors) {
  if (statuses.some(s => s === 401 || s === 403)) return "key";
  if (statuses.some(s => s === 503 || s === 500 || s === 502 || s === 504) || errors.includes("timeout")) return "overloaded";
  if (statuses.length && statuses.every(s => s === 429)) return "quota";
  if (statuses.length && statuses.every(s => s === 404)) return "model_not_found";
  return errors[errors.length - 1] || "unavailable";
}
const RETRY_MS = () => (process.env.GEMINI_RETRY_MS != null ? +process.env.GEMINI_RETRY_MS : 3000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Запрос к Gemini. Круг 1 — модели из GEMINI_MODELS, затем запасные из списка Google.
 * Если причина — перегрузка (503) или лимит (429), ждём и повторяем круг (до 3 кругов: пауза 3 с и 7 с),
 * но не дольше budgetMs, чтобы сайт (тайм-аут 90 с) получил ответ. Модели, которые Google закрыл (404), больше не пробуем.
 */
async function ask({ system, input, maxTokens = 700, temperature = 0.4, timeoutMs = 20000, budgetMs = 45000 }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { ok: false, error: "no_key" };
  const body = { input, system_instruction: system, generation_config: { max_output_tokens: maxTokens, temperature } };
  const started = Date.now(), tried = [], statuses = [], errors = [];
  const left = () => budgetMs - (Date.now() - started);
  let fallback = null;
  for (let round = 0; round < 3; round++) {
    if (round > 0) {
      const wait = RETRY_MS() * (round === 1 ? 1 : 7 / 3);
      if (left() < wait + 3000) break;
      await sleep(wait);
    }
    let roundStatuses = [];
    const models = MODELS.concat(fallback || []).filter(m => !state.blocked.has(m));
    for (const model of models) {
      if (left() < 2000) break;
      if (!tried.includes(model)) tried.push(model);
      const r = await tryModel(model, body, key, Math.min(timeoutMs, Math.max(2000, left())));
      if (r.ok) { state.lastOk = { at: new Date().toISOString(), model, fallback: !MODELS.includes(model), round: round + 1 }; return r; }
      statuses.push(r.status); errors.push(r.error); roundStatuses.push(r.status);
      if (r.status === 404) state.blocked.add(model);                 // модель закрыта — в следующих кругах не пробуем
    }
    // после первого круга подключаем запасные модели из списка Google (имена в настройках могли устареть)
    if (fallback === null) {
      const list = await listModels();
      fallback = list.ok ? fallbackModels(list.models, MODELS).filter(m => !state.blocked.has(m)) : [];
      if (round === 0 && fallback.length) {                         // запасные — сразу, без паузы
        for (const model of fallback) {
          if (left() < 2000) break;
          tried.push(model);
          const r = await tryModel(model, body, key, Math.min(timeoutMs, Math.max(2000, left())));
          if (r.ok) { state.lastOk = { at: new Date().toISOString(), model, fallback: true, round: 1 }; return r; }
          statuses.push(r.status); errors.push(r.error); roundStatuses.push(r.status);
          if (r.status === 404) state.blocked.add(model);
        }
      }
    }
    // повтор имеет смысл только при временной перегрузке или лимите
    const transient = roundStatuses.some(s => s === 503 || s === 500 || s === 502 || s === 504 || s === 429 || s === undefined);
    if (!transient) break;
  }
  return { ok: false, error: classify(statuses, errors), tried };
}

/** Состояние ИИ для /api/ai/status: без ключа, только имена моделей и коды ошибок. */
async function status() {
  const key = !!process.env.GEMINI_API_KEY;
  const list = key ? await listModels() : { ok: false, error: "no_key", models: [] };
  return {
    key_configured: key, configured_models: MODELS,
    configured_available: list.ok ? MODELS.map(m => ({ model: m, available: list.models.includes(m) })) : null,
    fallback_candidates: list.ok ? fallbackModels(list.models, MODELS) : [],
    models_list: list.ok ? "ok" : list.error,
    last_ok: state.lastOk, last_errors: state.lastErrors, blocked_models: [...state.blocked],
  };
}

module.exports = { ask, status, listModels, fallbackModels, classify, MODELS, _state: state };
