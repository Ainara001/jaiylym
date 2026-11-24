// DeepSeek: ключ только в заголовке, режим рассуждения выключен, ошибки и баланс, поиск с источниками, выбор провайдера. Сеть подменяется.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DEEPSEEK_RETRY_MS = "5";
const DS = require("../deepseek.js");
const AI = require("../ai.js");

const realFetch = global.fetch;
function withFetch(fn, body) { global.fetch = fn; return body().finally(() => { global.fetch = realFetch; }); }
const okBody = (content, extra = {}) => ({ ok: true, status: 200, json: async () => Object.assign({ model: "deepseek-flash",
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 60, completion_tokens: 20 } }, extra) });
const fail = (status, message) => ({ ok: false, status, json: async () => ({ error: { message } }) });
const reset = () => { DS._state.noSearch = false; DS._state.lastErrors = []; };

test("без ключа запрос не уходит", async () => {
  delete process.env.DEEPSEEK_API_KEY;
  let called = false;
  await withFetch(async () => { called = true; }, async () => assert.deepEqual(await DS.ask({ system: "s", input: "i" }), { ok: false, error: "no_key" }));
  assert.equal(called, false);
});

test("запрос: ключ в заголовке Bearer, системный промпт первым (кэш DeepSeek), рассуждение выключено", async () => {
  process.env.DEEPSEEK_API_KEY = "sk-test-123456789"; reset();
  let seen;
  await withFetch(async (url, opt) => { seen = { url, opt, body: JSON.parse(opt.body) }; return okBody(" ответ "); }, async () => {
    const r = await DS.ask({ system: "SYS", input: "IN", maxTokens: 321 });
    assert.deepEqual(r, { ok: true, text: "ответ", model: "deepseek-flash" });
  });
  assert.equal(seen.url, "https://api.deepseek.com/chat/completions");
  assert.ok(!seen.url.includes("sk-test"));
  assert.equal(seen.opt.headers.authorization, "Bearer sk-test-123456789");
  assert.equal(seen.body.model, "deepseek-flash");
  assert.deepEqual(seen.body.thinking, { type: "disabled" });
  assert.deepEqual(seen.body.messages.map(m => m.role), ["system", "user"]);
  assert.ok(seen.body.messages[0].content.startsWith("SYS "), "системный промпт + правило о символах — неизменный префикс для кэша");
  assert.equal(seen.body.max_tokens, 321);
  assert.equal(seen.body.tools, undefined, "без search — без инструмента поиска");
  assert.equal(DS._state.lastOk.cache_hit_tokens, 60);
});

test("ошибки: 402 — баланс (без повторов), 401 — ключ, 429 — лимит; ключ не попадает в журнал", async () => {
  process.env.DEEPSEEK_API_KEY = "sk-test-123456789"; reset();
  let n = 0;
  await withFetch(async () => { n++; return fail(402, "Insufficient Balance sk-test-123456789"); }, async () => assert.equal((await DS.ask({ system: "s", input: "i" })).error, "balance"));
  assert.equal(n, 1, "платный баланс — повтор бесполезен");
  assert.ok(DS._state.lastErrors.every(e => !e.error.includes("sk-test")));
  await withFetch(async () => fail(401, "bad key"), async () => assert.equal((await DS.ask({ system: "s", input: "i" })).error, "key"));
  await withFetch(async () => fail(429, "rate"), async () => assert.equal((await DS.ask({ system: "s", input: "i", budgetMs: 200 })).error, "quota"));
});

test("перегрузка 503 и ошибка в теле ответа с кодом 200 — повтор, затем ответ", async () => {
  process.env.DEEPSEEK_API_KEY = "sk-test-123456789"; reset();
  const seq = [fail(503, "Server Overloaded"), { ok: true, status: 200, json: async () => ({ error: { message: "generation failed" } }) }, okBody("готово")];
  await withFetch(async () => seq.shift(), async () => assert.equal((await DS.ask({ system: "s", input: "i" })).text, "готово"));
  await withFetch(async () => fail(503, "busy"), async () => assert.equal((await DS.ask({ system: "s", input: "i", budgetMs: 300 })).error, "overloaded"));
});

test("поиск: инструмент deepseek_web_search, источники из url_citation с индексами в кодовых точках", async () => {
  process.env.DEEPSEEK_API_KEY = "sk-test-123456789"; reset();
  const content = "Шөп бағасы — 45 000 ₸. Қалғаны.";
  let body;
  await withFetch(async (u, opt) => { body = JSON.parse(opt.body); return okBody(content, { usage: { server_tool_use: { tool_search: 2 } },
    choices: [{ message: { content, annotations: [
      { type: "url_citation", url_citation: { url: "https://a.kz/x", title: "a.kz", start_index: 0, end_index: 22 } },
      { type: "url_citation", url_citation: { url: "javascript:alert(1)", title: "x", start_index: 0, end_index: 3 } }] }, finish_reason: "stop" }] }); }, async () => {
    const r = await DS.ask({ system: "s", input: "i", search: true });
    assert.deepEqual(body.tools, [{ type: "deepseek_web_search" }]);
    assert.deepEqual(r.sources, [{ url: "https://a.kz/x", title: "a.kz" }], "только http(s)");
    assert.deepEqual(r.cited, ["Шөп бағасы — 45 000 ₸."]);
    assert.equal(r.searches, 2);
  });
  // диагностика для /api/ai/status: инструмент передан, вызовы поиска и аннотации посчитаны, текста ответа нет
  const ls = (await DS.status()).last_search;
  assert.equal(ls.tools_sent, true);
  assert.deepEqual(ls.server_tool_use, { tool_search: 2 });
  assert.equal(ls.annotations, 2);
  assert.equal(ls.sources, 1);
  assert.doesNotMatch(JSON.stringify(ls), /Шөп/);
});

test("поиск недоступен (400 об инструменте) — повтор без него, больше не пробуем", async () => {
  process.env.DEEPSEEK_API_KEY = "sk-test-123456789"; reset();
  const tools = [];
  await withFetch(async (u, opt) => { const b = JSON.parse(opt.body); tools.push(!!b.tools); return b.tools ? fail(400, "web search tool requires stream") : okBody("ок"); }, async () => {
    assert.equal((await DS.ask({ system: "s", input: "i", search: true })).text, "ок");
    await DS.ask({ system: "s", input: "i", search: true });
  });
  assert.deepEqual(tools, [true, false, false]);
  reset();
});

test("выбор провайдера: AI_PROVIDER, иначе DeepSeek при ключе, иначе Gemini", async () => {
  const keep = { p: process.env.AI_PROVIDER, d: process.env.DEEPSEEK_API_KEY };
  delete process.env.AI_PROVIDER; process.env.DEEPSEEK_API_KEY = "sk-x";
  assert.equal(AI.name(), "deepseek");
  delete process.env.DEEPSEEK_API_KEY;
  assert.equal(AI.name(), "gemini");
  process.env.AI_PROVIDER = "deepseek";
  assert.equal(AI.name(), "deepseek");
  assert.equal((await AI.status()).provider, "deepseek");
  if (keep.p == null) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = keep.p;
  if (keep.d == null) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = keep.d;
  assert.ok(typeof AI.SCOPE === "string" && AI.SCOPE.length > 100, "рамка ассистента общая");
});

test("иероглифы в ответе: правило в системном промпте, повтор; если снова — символы вырезаются", async () => {
  process.env.DEEPSEEK_API_KEY = "sk-test-123456789"; reset();
  let sys, n = 0;
  await withFetch(async (u, opt) => { n++; sys = JSON.parse(opt.body).messages[0].content; return okBody(n === 1 ? "Жем жетеді 草原 жақсы" : "Жем жетеді, жайылым жақсы"); }, async () => {
    assert.equal((await DS.ask({ system: "SYS", input: "i", budgetMs: 60000 })).text, "Жем жетеді, жайылым жақсы");
  });
  assert.equal(n, 2); assert.match(sys, /^SYS Пиши только буквами языка ответа/);
  n = 0;
  await withFetch(async () => { n++; return okBody("Жем 草原 жетеді"); }, async () => assert.equal((await DS.ask({ system: "S", input: "i", budgetMs: 60000 })).text, "Жем жетеді"));
  assert.equal(n, 3);
});

test("поиск: найденные страницы и тексты из message.server_tool_calls (без аннотаций; объектами и строкой JSON)", async () => {
  const m = { content: "В среду до +3 °C.", server_tool_calls: [
    { type: "web_search", name: "search", arguments: "{\"query\":\"погода Кеген\"}",
      results: [{ url: "https://pogoda.kz/kegen", title: "Погода в Кегене", snippet: "Среда: днём до +3 °C, ночью −8 °C, без осадков." },
        { url: "javascript:void(0)", title: "x", snippet: "не ссылка" }] },
    { type: "web_search", output: JSON.stringify({ items: [{ link: "https://meteo.example/kz", name: "Meteo", content: "Прогноз для Райымбекского района на 7 дней" }] }) }] };
  const out = DS.parse({ model: "deepseek-flash", choices: [{ message: m, finish_reason: "stop" }], usage: { server_tool_use: { tool_search: 2 } } });
  assert.deepEqual(out.sources, [{ url: "https://pogoda.kz/kegen", title: "Погода в Кегене" }, { url: "https://meteo.example/kz", title: "Meteo" }]);
  assert.ok(out.cited.some(t => /\+3 °C/.test(t)), "текст найденного — для проверки чисел");
  assert.equal(out.searches, 2);
  const sh = DS.shapeOf(m.server_tool_calls);
  assert.doesNotMatch(JSON.stringify(sh), /Кеген|pogoda/, "вид без содержимого");
});
