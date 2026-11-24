/*
 * DeepSeek через Chat Completions (POST https://api.deepseek.com/chat/completions). Платный API, ключ только на сервере
 * (переменная DEEPSEEK_API_KEY). Тот же интерфейс, что у gemini.js: ask() и status(), поэтому api.js и бот не меняются.
 *
 *  - модель DEEPSEEK_MODEL (по умолчанию deepseek-flash); режим рассуждения выключен — пояснение расчёта не требует
 *    рассуждений, так быстрее и дешевле (рассуждение тратит выходные токены);
 *  - поиск в интернете — встроенный инструмент deepseek_web_search; источники приходят аннотациями url_citation;
 *  - кэш DeepSeek автоматический по совпадающему началу запроса: неизменный системный промпт идёт первым;
 *  - ошибка генерации может прийти с HTTP 200 в теле ответа ({ error }) — проверяется явно;
 *  - 402 — закончился баланс (платный API), 401 — ключ, 429 — лимит, 500/503/504 — перегрузка (повтор с паузой).
 */
const URL = "https://api.deepseek.com/chat/completions";
const MODEL = () => process.env.DEEPSEEK_MODEL || "deepseek-flash";
const RETRY_MS = () => (process.env.DEEPSEEK_RETRY_MS != null ? +process.env.DEEPSEEK_RETRY_MS : 3000);
const state = { lastErrors: [], lastOk: null, noSearch: false, lastSearch: null, usage: { requests: 0, prompt: 0, cache_hit: 0, completion: 0, searches: 0 } };
const clean = s => String(s == null ? "" : s).replace(/sk-[0-9A-Za-z_-]{8,}/g, "[ключ]").slice(0, 160);
const remember = error => { state.lastErrors = state.lastErrors.concat([{ at: new Date().toISOString(), model: MODEL(), error: clean(error) }]).slice(-12); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// DeepSeek иногда вставляет иероглифы в ответы на других языках (особенно в редких — казахском). Правило — в конце системного
// промпта (он неизменный, кэш не страдает); если символы всё же пришли — один повтор, затем они вырезаются.
const CJK = /[⺀-⿿　-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/;
const CJK_ALL = new RegExp(CJK.source, "g");
const LANG_GUARD = " Пиши только буквами языка ответа (кириллица русского или казахского алфавита) и цифрами: никаких китайских, японских, корейских символов и английских вставок.";

/**
 * Результаты встроенного поиска приходят в message.server_tool_calls (проверено на проде: annotations пустые, tool_search > 0).
 * Формат вложенности не документирован у нас — обходим дерево: объект с http(s)-url — найденная страница (url + заголовок),
 * длинные строки рядом — текст найденного (по нему проверяются числа ответа). Лимиты — чтобы не раздувать память.
 */
function walkResults(node, out, depth = 0) {
  if (!node || depth > 8 || out.texts.length > 200) return out;
  if (Array.isArray(node)) { for (const x of node) walkResults(x, out, depth + 1); return out; }
  if (typeof node === "string") {
    // аргументы и результаты инструмента иногда приходят строкой JSON
    const t = node.trim();
    if ((t[0] === "{" || t[0] === "[") && t.length < 400000) { try { return walkResults(JSON.parse(t), out, depth + 1); } catch (_) {} }
    if (t.length >= 20 && !/^https?:\/\/\S+$/.test(t)) out.texts.push(t.slice(0, 2000));
    return out;
  }
  if (typeof node !== "object") return out;
  const url = node.url || node.link || node.href;
  if (typeof url === "string" && /^https?:\/\//.test(url)) out.pages.push({ url, title: String(node.title || node.name || "").slice(0, 120) });
  for (const [k, v] of Object.entries(node)) if (!["url", "link", "href"].includes(k)) walkResults(v, out, depth + 1);
  return out;
}
/** Вид server_tool_calls без содержимого — ключи и типы (для /api/ai/status, чтобы видеть формат на проде). */
function shapeOf(node, depth = 0) {
  if (depth > 4) return "…";
  if (Array.isArray(node)) return node.length ? [shapeOf(node[0], depth + 1), node.length] : [];
  if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).slice(0, 12).map(([k, v]) => [k, shapeOf(v, depth + 1)]));
  return typeof node === "string" ? "str" + (node.length > 40 ? ":" + node.length : "") : typeof node;
}

/** Ответ DeepSeek → тот же вид, что у gemini.js: текст, источники с процитированными фрагментами, число поисков. */
function parse(d) {
  const msg = (d.choices && d.choices[0] && d.choices[0].message) || {};
  const text = String(msg.content || "").trim();
  const chars = Array.from(String(msg.content || ""));                        // индексы аннотаций — в кодовых точках Юникода
  const cites = [];
  for (const a of msg.annotations || []) {
    const u = a && a.type === "url_citation" && a.url_citation;
    if (u && /^https?:\/\//.test(u.url || "")) cites.push({ url: u.url, title: String(u.title || "").slice(0, 120), segment: chars.slice(u.start_index || 0, u.end_index || 0).join("") });
  }
  // без аннотаций — найденные страницы из server_tool_calls (сначала процитированные, затем просмотренные)
  const found = walkResults(msg.server_tool_calls || [], { pages: [], texts: [] });
  const seen = new Set(), sources = [];
  for (const c of cites.concat(found.pages)) if (!seen.has(c.url)) { seen.add(c.url); sources.push({ url: c.url, title: c.title && c.title !== c.url ? c.title : "" }); }
  const tool = (d.usage && d.usage.server_tool_use) || {};
  return { text, sources: sources.slice(0, 6), cited: cites.map(c => c.segment).filter(Boolean).concat(found.texts), searches: (tool.tool_search || 0) + (tool.tool_fetch || 0),
    finish: d.choices && d.choices[0] && d.choices[0].finish_reason, usage: d.usage || {} };
}

async function call(body, key, timeoutMs) {
  try {
    const r = await fetch(URL, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const d = await r.json().catch(() => ({}));
    if (r.ok && !d.error) return { ok: true, d };
    const msg = (d.error && (d.error.message || d.error.type || d.error.code)) || "HTTP " + r.status;
    remember(`HTTP ${r.status} ${msg}`); console.error("DeepSeek", r.status, clean(msg));
    return { ok: false, status: r.ok ? 200 : r.status, error: String(msg) };
  } catch (e) {
    const err = e.name === "TimeoutError" ? "timeout" : e.message;
    remember(err); console.error("DeepSeek", clean(err));
    return { ok: false, error: err };
  }
}

/** Причина неудачи для api.js: те же коды, что у gemini.js, плюс balance (402 — пополнить баланс). */
function classify(r) {
  if (r.status === 401 || r.status === 403) return "key";
  if (r.status === 402) return "balance";
  if (r.status === 429) return "quota";
  if ([500, 502, 503, 504].includes(r.status) || r.status === 200) return "overloaded";
  if (r.error === "timeout") return "timeout";
  return "unavailable";
}

/**
 * Запрос к DeepSeek. Повтор при перегрузке/лимите/тайм-ауте (пауза 3 с, затем 7 с), но не дольше budgetMs.
 * search: true — разрешить модели искать в интернете (если API отказал в инструменте — повтор без него и больше не пробуем).
 */
async function ask({ system, input, maxTokens = 700, temperature = 0.4, timeoutMs = 25000, budgetMs = 45000, search = false }) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return { ok: false, error: "no_key" };
  const started = Date.now(), left = () => budgetMs - (Date.now() - started);
  const body = { model: MODEL(), thinking: { type: "disabled" }, max_tokens: maxTokens, temperature, stream: false,
    messages: [{ role: "system", content: system + LANG_GUARD }, { role: "user", content: input }] };
  if (search && !state.noSearch) body.tools = [{ type: "deepseek_web_search" }];
  let last = null, spare = null;           // spare — ответ с иероглифами: если на повтор не хватит времени, отдаём его очищенным
  for (let attempt = 0; attempt < 3; attempt++) {
    // первая попытка — всегда; повторы — только если после паузы остаётся время
    if (attempt > 0) { const wait = RETRY_MS() * (attempt === 1 ? 1 : 7 / 3); if (left() < wait + 2000) break; await sleep(wait); }
    let r = await call(body, key, Math.min(timeoutMs, Math.max(2000, left())));
    if (!r.ok && r.status === 400 && body.tools && /tool|search|stream/i.test(r.error)) {   // инструмент поиска недоступен — без него
      state.noSearch = true; delete body.tools;
      r = await call(body, key, Math.min(timeoutMs, Math.max(2000, left())));
    }
    if (r.ok) {
      const out = parse(r.d);
      // диагностика поиска для /api/ai/status: что DeepSeek вернул на запрос с инструментом поиска (без текста ответа)
      if (search) {
        const m = (r.d.choices && r.d.choices[0] && r.d.choices[0].message) || {};
        state.lastSearch = { at: new Date().toISOString(), tools_sent: !!body.tools, model: (r.d && r.d.model) || MODEL(), finish: out.finish || null,
          server_tool_use: (r.d.usage && r.d.usage.server_tool_use) || null, usage_keys: Object.keys(r.d.usage || {}),
          annotations: (m.annotations || []).length, tool_calls: (m.tool_calls || []).map(t => (t && (t.type || (t.function && t.function.name))) || "?"),
          message_keys: Object.keys(m), searches: out.searches, sources: out.sources.length, found_texts: out.cited.length,
          server_tool_calls_shape: m.server_tool_calls ? shapeOf(m.server_tool_calls) : null };
      }
      if (!out.text) { remember("empty " + (out.finish || "")); last = { status: 200, error: "empty" }; continue; }
      if (CJK.test(out.text)) {
        remember("cjk in answer");
        if (attempt < 2 && left() > 8000) { spare = { text: out.text.replace(CJK_ALL, "").replace(/[ \t]{2,}/g, " ").trim(), model: (r.d && r.d.model) || MODEL() }; last = { status: 200, error: "cjk" }; continue; }
        out.text = out.text.replace(CJK_ALL, "").replace(/[ \t]{2,}/g, " ").trim();          // последняя попытка — вырезаем символы
      }
      const u = out.usage;
      state.usage.requests++; state.usage.prompt += u.prompt_tokens || 0; state.usage.cache_hit += u.prompt_cache_hit_tokens || 0;
      state.usage.completion += u.completion_tokens || 0; state.usage.searches += out.searches;
      state.lastOk = { at: new Date().toISOString(), model: (r.d && r.d.model) || MODEL(), cache_hit_tokens: u.prompt_cache_hit_tokens || 0, truncated: out.finish === "length" };
      const res = { ok: true, text: out.text, model: (r.d && r.d.model) || MODEL() };
      if (out.searches || out.sources.length) Object.assign(res, { sources: out.sources, cited: out.cited, suggestions: "", searches: out.searches });
      return res;
    }
    last = r;
    if (![429, 500, 502, 503, 504, 200].includes(r.status) && r.error !== "timeout") break;   // ключ, баланс, неверный запрос — повтор бесполезен
  }
  if (spare && spare.text) return { ok: true, text: spare.text, model: spare.model };
  return { ok: false, error: last ? (last.error === "empty" ? "empty" : classify(last)) : "timeout" };
}

/** Состояние для /api/ai/status: без ключа, только модель, ошибки и расход токенов с запуска сервера. */
async function status() {
  return { provider: "deepseek", key_configured: !!process.env.DEEPSEEK_API_KEY, configured_models: [MODEL()],
    last_ok: state.lastOk, last_errors: state.lastErrors, search_available: !state.noSearch, last_search: state.lastSearch, usage_since_start: state.usage };
}

module.exports = { ask, status, parse, classify, walkResults, shapeOf, MODELS: [MODEL()], _state: state };
