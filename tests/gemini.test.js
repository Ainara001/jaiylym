// Gemini: ключ только на сервере, переход на следующую модель, тайм-ауты, пустые ответы. Сеть подменяется.
const test = require("node:test");
const assert = require("node:assert/strict");

const realFetch = global.fetch;
function withFetch(fn, body) {
  global.fetch = fn;
  return body().finally(() => { global.fetch = realFetch; });
}
process.env.GEMINI_MODELS = "m1,m2";
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
  await withFetch(async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }, async () => {
    const rt = await G.ask({ system: "s", input: "i" }); assert.equal(rt.error, "timeout");
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
  G._state.discovered = null;
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
  G._state.discovered = [];  G._state.discoveredAt = Date.now();
  await withFetch(async () => ({ ok: false, status: 429, json: async () => ({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }) }), async () => {
    const r = await G.ask({ system: "s", input: "i" });
    assert.equal(r.ok, false); assert.equal(r.error, "quota");
  });
});
