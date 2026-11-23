// Gemini: ключ только на сервере, переход на следующую модель, тайм-ауты, пустые ответы. Сеть подменяется.
const test = require("node:test");
const assert = require("node:assert/strict");

const realFetch = global.fetch;
function withFetch(fn, body) {
  global.fetch = fn;
  return body().finally(() => { global.fetch = realFetch; });
}
process.env.GEMINI_MODELS = "m1,m2";
process.env.GEMINI_RETRY_MS = "5";
const G = require("../gemini.js");

test("без ключа запрос в Google не уходит", async () => {
  delete process.env.GEMINI_API_KEY;
  let called = false;
  await withFetch(async () => { called = true; }, async () => {
    const r = await G.ask({ system: "s", input: "i" });
    assert.deepEqual(r, { ok: false, error: "no_key" });
  });
  assert.equal(called, false);
});

test("перегрузка первой модели — ответ второй; ключ в заголовке, а не в адресе", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  const urls = [];
  await withFetch(async (url, opt) => {
    urls.push(url);
    assert.equal(opt.headers["x-goog-api-key"], "test-key");
    const model = JSON.parse(opt.body).model;
    if (model === "m1") return { ok: false, status: 503, json: async () => ({ error: { code: 503, message: "overloaded" } }) };
    return { ok: true, status: 200, json: async () => ({ steps: [{ type: "model_output", content: [{ type: "text", text: " ответ " }] }] }) };
  }, async () => {
    const r = await G.ask({ system: "s", input: "i" });
    assert.deepEqual(r, { ok: true, text: "ответ", model: "m2" });
  });
  assert.ok(urls.every(u => !u.includes("test-key")));
});

test("тайм-аут и пустой ответ у всех моделей — понятная ошибка", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  G._state.blocked.clear();
  await withFetch(async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }, async () => {
    const rt = await G.ask({ system: "s", input: "i" }); assert.equal(rt.error, "overloaded", "тайм-аут у всех моделей — перегрузка");
  });
  await withFetch(async () => ({ ok: true, status: 200, json: async () => ({ steps: [] }) }), async () => {
    const re = await G.ask({ system: "s", input: "i" }); assert.equal(re.error, "empty");
  });
  await withFetch(async () => ({ ok: false, status: 404, json: async () => { throw new Error("not json"); } }), async () => {
    const r404 = await G.ask({ system: "s", input: "i" }); assert.equal(r404.ok, false); assert.equal(r404.error, "model_not_found");
  });
});

test("ключ Gemini не попадает в файлы сайта", () => {
  const fs = require("fs"), path = require("path");
  const web = path.join(__dirname, "..", "web");
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(web).filter(f => /\.(js|html)$/.test(f))) {
    const s = fs.readFileSync(f, "utf8");
    assert.ok(!/GEMINI_API_KEY|generativelanguage\.googleapis|AIza[0-9A-Za-z_-]{20,}/.test(s), f);
  }
});

test("все модели из списка недоступны (404) — сервер находит доступную flash-модель у Google", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  G._state.discovered = null; G._state.blocked.clear();
  const asked = [];
  await withFetch(async (url, opt) => {
    if (String(url).includes("/models?")) return { ok: true, status: 200, json: async () => ({ models: [
      { name: "models/gemini-9.0-flash-lite" }, { name: "models/gemini-9.0-flash-image" }, { name: "models/text-embedding-9" }, { name: "models/gemini-9.0-pro" }] }) };
    const model = JSON.parse(opt.body).model; asked.push(model);
    if (model === "gemini-9.0-flash-lite") return { ok: true, status: 200, json: async () => ({ steps: [{ type: "model_output", content: [{ type: "text", text: "ok" }] }] }) };
    return { ok: false, status: 404, json: async () => ({ error: { code: 404, status: "NOT_FOUND", message: "model not found, key=AIzaSyFAKEFAKEFAKEFAKE" } }) };
  }, async () => {
    const r = await G.ask({ system: "s", input: "i" });
    assert.deepEqual(r, { ok: true, text: "ok", model: "gemini-9.0-flash-lite" });
  });
  assert.deepEqual(asked, ["m1", "m2", "gemini-9.0-flash-lite"], "изображения, эмбеддинги и pro не пробуются");
  const st = await G.status();
  assert.equal(st.key_configured, true);
  assert.deepEqual(st.configured_available, [{ model: "m1", available: false }, { model: "m2", available: false }]);
  assert.ok(st.last_errors.length >= 2);
  assert.ok(!JSON.stringify(st).includes("AIza"), "ключ не попадает в состояние");
  assert.equal(st.last_ok.fallback, true);
});

test("лимит Google у всех моделей — понятная причина quota", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  G._state.discovered = [];  G._state.discoveredAt = Date.now(); G._state.blocked.clear();
  await withFetch(async () => ({ ok: false, status: 429, json: async () => ({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }) }), async () => {
    const r = await G.ask({ system: "s", input: "i" });
    assert.equal(r.ok, false); assert.equal(r.error, "quota");
  });
});

test("перегрузка Google (503): запрос повторяется после паузы, причина — overloaded", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  G._state.discovered = []; G._state.discoveredAt = Date.now(); G._state.blocked.clear();
  let n = 0;
  await withFetch(async (url, opt) => {
    n++;
    if (n <= 2) return { ok: false, status: 503, json: async () => ({ error: { code: 503, status: "UNAVAILABLE", message: "high demand" } }) };
    return { ok: true, status: 200, json: async () => ({ steps: [{ type: "model_output", content: [{ type: "text", text: "со второго круга" }] }] }) };
  }, async () => {
    const r = await G.ask({ system: "s", input: "i" });
    assert.equal(r.ok, true); assert.equal(r.text, "со второго круга"); assert.equal(n, 3);
  });
  assert.equal(G._state.lastOk.round, 2);
  await withFetch(async () => ({ ok: false, status: 503, json: async () => ({ error: { code: 503 } }) }), async () => {
    const r = await G.ask({ system: "s", input: "i" });
    assert.equal(r.error, "overloaded", "503 у всех — «перегрузка», а не not_found");
  });
});

test("смесь 503 и 404: причина overloaded; закрытая модель (404) больше не пробуется", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  G._state.discovered = []; G._state.discoveredAt = Date.now(); G._state.blocked.clear();
  const asked = [];
  await withFetch(async (url, opt) => {
    const model = JSON.parse(opt.body).model; asked.push(model);
    return model === "m1" ? { ok: false, status: 404, json: async () => ({ error: { code: 404 } }) } : { ok: false, status: 503, json: async () => ({ error: { code: 503 } }) };
  }, async () => {
    const r = await G.ask({ system: "s", input: "i" });
    assert.equal(r.error, "overloaded");
  });
  assert.equal(asked.filter(m => m === "m1").length, 1, "m1 после 404 не повторялся");
  assert.ok(asked.filter(m => m === "m2").length >= 2, "m2 повторялся");
  assert.deepEqual((await G.status()).blocked_models, ["m1"]);
});

test("повторы укладываются в бюджет времени", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  G._state.blocked.clear();
  const t0 = Date.now();
  await withFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }), async () => {
    const r = await G.ask({ system: "s", input: "i", budgetMs: 3000 });
    assert.equal(r.ok, false);
  });
  assert.ok(Date.now() - t0 < 3500);
});

test("классификация причин", () => {
  assert.equal(G.classify([429, 429], ["429", "429"]), "quota");
  assert.equal(G.classify([403, 503], []), "key");
  assert.equal(G.classify([404, 404], []), "model_not_found");
  assert.equal(G.classify([404, 503], []), "overloaded");
  assert.equal(G.classify([undefined], ["timeout"]), "overloaded");
});
