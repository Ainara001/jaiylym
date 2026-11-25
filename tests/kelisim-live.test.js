// Келісім, общая карта и чат (kelisim.js «живой слой»): места участников, голоса, чат, кто в сети, оценка ИИ, сводка.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const AI = require("../ai.js");
const { createApi } = require("../api.js");
const { memoryKv } = require("../store.js");
const NG = require("../web/nograze.js");
const K = require("../web/kelisim.js");
const { loadExamples } = require("../data");

const [, KEG] = loadExamples();
const V = KEG.village, kx = 111.32 * Math.cos(V.lat * Math.PI / 180);
/** Точка в km км от села по азимуту deg. */
const at = (km, deg) => ({ lat: +(V.lat + km * Math.cos(deg * Math.PI / 180) / 110.57).toFixed(5), lon: +(V.lon + km * Math.sin(deg * Math.PI / 180) / kx).toFixed(5) });
const vkey = (lat, lon) => `${(+lat).toFixed(3)},${(+lon).toFixed(3)}`;
let base, server;
const kv = memoryKv();
test.before(async () => {
  const api = createApi({ getState: () => ({ users: {}, villages: {} }), save() {}, kv, vkey, botUsername: "x", onFarmSaved() {}, allowedOrigins: ["http://site"], kelisimSecret: "s" });
  server = http.createServer((q, r) => api.handle(q, r).then(d => { if (!d) r.writeHead(404).end(); }));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port + "/api/kelisim";
});
test.after(() => server.close());
let ipn = 0;
async function call(method, p, key, body) {
  const ip = "10.7." + (++ipn >> 8) + "." + (ipn & 255);
  const r = await fetch(base + p, { method, headers: Object.assign({ origin: "http://site", "x-forwarded-for": ip }, key ? { authorization: "Kelisim " + key } : {}, body ? { "content-type": "application/json" } : {}), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, d: await r.json().catch(() => null) };
}
async function make() {
  const r = await call("POST", "", null, { title: "Карта", snapshot: { village: V, plots: NG.apply(KEG.plots, KEG.nograze), params: {}, source: { year: KEG.source.year, dates: KEG.source.dates } },
    households: [{ name: "Асан", herd: { sheep: 800 } }, { name: "Ерлан", herd: { sheep: 1200, horses: 60 } }, { name: "Гульнар", herd: { cattle: 40 }, daily_return: true }] });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  return { id: r.d.id, org: r.d.organizer_key, keys: Object.fromEntries(r.d.links.map(l => [l.id, l.key])) };
}
const live = (k, key, since = 0) => call("GET", `/${k.id}/live?since=${since}`, key);
const pin = (k, key, b) => call("POST", `/${k.id}/pin`, key, b);

test("места на общей карте: участок по точке, плюсы и минусы, кто ещё здесь; rev плана не меняется", async () => {
  const k = await make();
  const rev0 = (await call("GET", "/" + k.id, k.org)).d.rev;
  let r = await pin(k, k.keys.h1, Object.assign({ op: "set", r: 500 }, at(5, 45)));
  assert.equal(r.status, 200, JSON.stringify(r.d));
  let p1 = r.d.live.pins.find(p => p.hid === "h1");
  assert.equal(p1.facts.plot, "Д-СВ");
  assert.ok(["good", "mixed", "poor"].includes(p1.verdict));
  assert.ok(p1.pros.length + p1.cons.length > 0);
  assert.equal(r.d.live.chat.slice(-1)[0].kind, "pin", "в чате — запись «отметил место»");
  // второй участник на том же участке: оба видят друг друга
  r = await pin(k, k.keys.h2, Object.assign({ op: "set", r: 1000 }, at(5.5, 50)));
  p1 = r.d.live.pins.find(p => p.hid === "h1");
  assert.ok(p1.cons.concat(p1.info).some(x => (x.k === "shared" || x.k === "crowd") && x.names.includes("Ерлан")), JSON.stringify(p1));
  // дойное стадо далеко — минус
  r = await pin(k, k.keys.h3, Object.assign({ op: "set", r: 250 }, at(6, 180)));
  assert.ok(r.d.live.pins.find(p => p.hid === "h3").cons.some(x => x.k === "dairyFar"));
  // само село — не пастбище; дальше 12 км — нельзя
  r = await pin(k, k.keys.h3, Object.assign({ op: "set", r: 250 }, at(0.2, 10)));
  assert.equal(r.d.live.pins.find(p => p.hid === "h3").verdict, "bad");
  assert.equal((await pin(k, k.keys.h3, Object.assign({ op: "set", r: 250 }, at(14, 10)))).status, 400);
  assert.equal((await pin(k, k.keys.h3, Object.assign({ op: "set", r: 777 }, at(4, 10)))).status, 400, "радиус только 250/500/1000");
  // организатор места не ставит, но видит
  assert.equal((await pin(k, k.org, Object.assign({ op: "set", r: 500 }, at(4, 90)))).status, 403);
  assert.equal((await live(k, k.org)).d.pins.length, 3);
  // карта и чат не меняют rev плана — организатору не приходится «обновлять страницу»
  assert.equal((await call("GET", "/" + k.id, k.org)).d.rev, rev0);
  // первое действие на карте — участник «зашёл»
  assert.equal((await call("GET", "/" + k.id, k.org)).d.households.find(h => h.id === "h2").joined, true);
});

test("голоса, чат, кто в сети, подтверждение места", async () => {
  const k = await make();
  await pin(k, k.keys.h1, Object.assign({ op: "set", r: 500 }, at(4, 0)));
  // голос за чужое место; за своё — нельзя
  let r = await pin(k, k.keys.h2, { op: "vote", target: "h1", v: 1 });
  assert.equal(r.status, 200);
  r = await pin(k, k.org, { op: "vote", target: "h1", v: -1 });
  assert.deepEqual(r.d.live.pins[0].votes, { h2: 1, org: -1 });
  assert.equal((await pin(k, k.keys.h1, { op: "vote", target: "h1", v: 1 })).status, 400);
  // чат: участник и организатор; телефон и пустое — нельзя
  r = await call("POST", `/${k.id}/chat`, k.keys.h2, { text: "Там хорошая трава, но воды нет", about: "h1" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const m = r.d.live.chat.slice(-1)[0];
  assert.deepEqual([m.by, m.text, m.about], ["h2", "Там хорошая трава, но воды нет", "h1"]);
  assert.equal((await call("POST", `/${k.id}/chat`, k.keys.h3, { text: "звоните 8 701 123 45 67" })).status, 400, "телефон в чате не принимается");
  assert.equal((await call("POST", `/${k.id}/chat`, k.keys.h3, { text: "   " })).status, 400);
  assert.equal((await call("POST", `/${k.id}/chat`, k.org, { text: "Обсудим до пятницы" })).status, 200);
  // новые сообщения — по номеру
  const seq = (await live(k, k.keys.h1)).d.seq;
  await call("POST", `/${k.id}/chat`, k.keys.h1, { text: "Согласен, вода нужна" });
  const fresh = (await live(k, k.keys.h3, seq)).d;
  assert.deepEqual(fresh.chat.map(x => x.text), ["Согласен, вода нужна"]);
  // кто в сети: открывали живой слой в последние 25 секунд
  assert.ok(["h1", "h3", "org"].every(x => fresh.online.includes(x)), JSON.stringify(fresh.online));
  assert.ok(fresh.seen.h1 && fresh.seen.h3);
  // подтверждение места
  r = await pin(k, k.keys.h1, { op: "confirm" });
  assert.ok(r.d.live.pins[0].confirmed);
  assert.equal(r.d.live.chat.slice(-1)[0].kind, "confirm");
  assert.equal((await pin(k, k.keys.h2, { op: "confirm" })).status, 400, "нечего подтверждать без места");
  // чужая ссылка не работает
  assert.equal((await live(k, "x".repeat(24))).status, 403);
});

test("оценка ИИ: по фактам расчёта, кэш до изменения фактов; без ключа — шаблон на сайте; сводка по всем местам", async () => {
  const k = await make();
  await pin(k, k.keys.h1, Object.assign({ op: "set", r: 500 }, at(5, 45)));
  await pin(k, k.keys.h2, Object.assign({ op: "set", r: 500 }, at(4, 180)));
  const orig = AI.ask, key = process.env.DEEPSEEK_API_KEY;
  const seen = [];
  process.env.DEEPSEEK_API_KEY = "test";
  AI.ask = async o => { seen.push(o); return { ok: true, text: "**Есть минусы.**\n— трава гуще средней\nСовет: проверьте воду на месте.", model: "t" }; };
  try {
    let r = await call("POST", `/${k.id}/assess`, k.keys.h1, { lang: "ru" });
    assert.equal(r.status, 200, JSON.stringify(r.d));
    assert.match(r.d.ai.text, /^Есть минусы\./, "без разметки markdown");
    assert.match(seen[0].input, /"участок":"Д-СВ"/);
    assert.match(seen[0].system, /Совет:/);
    // повтор — из кэша, пока факты не изменились
    r = await call("POST", `/${k.id}/assess`, k.keys.h1, { lang: "ru" });
    assert.equal(seen.length, 1);
    assert.equal((await live(k, k.keys.h2)).d.pins.find(p => p.hid === "h1").ai.text.slice(0, 11), "Есть минусы");
    // организатор может попросить оценку чужого места; на казахском — отдельно
    r = await call("POST", `/${k.id}/assess`, k.org, { target: "h2", lang: "kk" });
    assert.equal(r.status, 200);
    assert.match(seen[1].system, /ТЕК қазақ/);
    // место сдвинули — оценка сброшена
    await pin(k, k.keys.h1, Object.assign({ op: "set", r: 500 }, at(2, 90)));
    assert.equal((await live(k, k.keys.h1)).d.pins.find(p => p.hid === "h1").ai, null);
    // сводка
    r = await call("POST", `/${k.id}/summary`, k.keys.h2, { lang: "ru" });
    assert.equal(r.status, 200, JSON.stringify(r.d));
    assert.ok(r.d.summary.text);
    assert.match(seen[seen.length - 1].input, /"участник":"Асан"/);
    const n = seen.length;
    await call("POST", `/${k.id}/summary`, k.keys.h1, { lang: "ru" });
    assert.equal(seen.length, n, "сводка не чаще раза в минуту");
    // ИИ не ответил — ai: null, сайт покажет оценку расчёта
    AI.ask = async () => ({ ok: false, error: "overloaded" });
    await pin(k, k.keys.h1, Object.assign({ op: "set", r: 500 }, at(3.5, 270)));
    r = await call("POST", `/${k.id}/assess`, k.keys.h1, { lang: "ru" });
    assert.equal(r.d.ai, null);
    assert.ok(r.d.facts.verdict);
  } finally { AI.ask = orig; if (key === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = key; }
  // без ключа ИИ
  const k2 = await make();
  await pin(k2, k2.keys.h1, Object.assign({ op: "set", r: 500 }, at(5, 45)));
  const r = await call("POST", `/${k2.id}/assess`, k2.keys.h1, { lang: "ru" });
  if (!process.env.DEEPSEEK_API_KEY && !process.env.GEMINI_API_KEY) assert.equal(r.d.error, "no_key");
});

test("удаление согласования удаляет карту и чат", async () => {
  const k = await make();
  await pin(k, k.keys.h1, Object.assign({ op: "set", r: 500 }, at(5, 45)));
  assert.ok(await kv.get("kellive:" + k.id));
  assert.equal((await call("DELETE", "/" + k.id, k.org)).status, 200);
  assert.equal(await kv.get("kellive:" + k.id), null);
});

test("место → участок: кольца 0,5–3 и 3–8 км, восемь направлений", () => {
  const p = (km, deg) => K.pinPlace(V, at(km, deg).lat, at(km, deg).lon);
  assert.equal(p(2, 0).plot, "Б-С");
  assert.equal(p(2, 90).plot, "Б-В");
  assert.equal(p(5, 225).plot, "Д-ЮЗ");
  assert.equal(p(7.9, 315).plot, "Д-СЗ");
  assert.equal(p(0.3, 0).ring, "village");
  assert.equal(p(9, 0).ring, "outside");
});
