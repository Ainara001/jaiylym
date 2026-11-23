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
    assert.deepEqual(await G.ask({ system: "s", input: "i" }), { ok: false, error: "timeout" });
  });
  await withFetch(async () => ({ ok: true, status: 200, json: async () => ({ steps: [] }) }), async () => {
    assert.deepEqual(await G.ask({ system: "s", input: "i" }), { ok: false, error: "empty" });
  });
  await withFetch(async () => ({ ok: false, status: 404, json: async () => { throw new Error("not json"); } }), async () => {
    assert.deepEqual(await G.ask({ system: "s", input: "i" }), { ok: false, error: "HTTP 404" });
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
