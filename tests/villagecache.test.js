// Общий кэш сёл: считает только сервер, один расчёт на село, неполный расчёт не сохраняется, лимиты, только Казахстан.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const zlib = require("zlib");
const { createVillageCache, ndviPng } = require("../villagecache.js");
const { createApi } = require("../api.js");
const { memoryKv } = require("../store.js");
const { loadExamples } = require("../data");

const vkey = (lat, lon) => `${(+lat).toFixed(3)},${(+lon).toFixed(3)}`;
const [BES] = loadExamples();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function fakeBuild(opts = {}) {
  const calls = [];
  const build = async ({ lat, lon }) => {
    calls.push([lat, lon]);
    await sleep(opts.ms || 20);
    if (opts.fail) throw new Error("снимки недоступны");
    const data = JSON.parse(JSON.stringify(BES));
    data.village = Object.assign({}, data.village, { name: "", lat, lon });
    if (opts.ngError) data.nograze = { status: "error", error: "Overpass" };
    return { data, png: "data:image/png;base64,AAAA" };
  };
  return { build, calls };
}
const fresh = d => d.land_rule === BES.land_rule;

test("первый запрос запускает расчёт, второй получает готовое; одно село — один расчёт", async () => {
  const kv = memoryKv(), f = fakeBuild({ ms: 60 }), c = createVillageCache({ kv, vkey, build: f.build, fresh });
  assert.equal((await c.get(51.1, 71.4)).status, "building");
  assert.equal((await c.get(51.1001, 71.4002)).status, "building", "та же точка с точностью до 100 м — тот же расчёт");
  while (c.pending) await sleep(10);
  assert.equal(f.calls.length, 1);
  const r = await c.get("51.1", "71.4");
  assert.equal(r.status, "ok");
  assert.equal(r.data.plots.length, 16);
  assert.match(r.png, /^data:image\/png;base64,/);
});

test("неполный расчёт (зоны OSM не пришли) и сбой не сохраняются — в следующий раз считаем заново", async () => {
  for (const opts of [{ ngError: true }, { fail: true }]) {
    const kv = memoryKv(), f = fakeBuild(opts), c = createVillageCache({ kv, vkey, build: f.build, fresh });
    const ce = console.error; console.error = () => {};
    try {
      await c.get(50, 70); while (c.pending) await sleep(5);
      assert.equal((await c.get(50, 70)).status, "building", JSON.stringify(opts));
      while (c.pending) await sleep(5);
      assert.equal(f.calls.length, 2);
    } finally { console.error = ce; }
  }
});

test("старый расчёт (другое правило земли или лето) — пересчёт; вне Казахстана и мусор — отказ; лимит в час и очередь", async () => {
  const kv = memoryKv(), f = fakeBuild(), c = createVillageCache({ kv, vkey, build: f.build, fresh: () => false, perHour: 3, queueMax: 1 });
  await kv.set("vc:" + vkey(48, 68), { data: BES, png: "x" });
  assert.equal((await c.get(48, 68)).status, "building", "устаревший расчёт не отдаём");
  for (const [a, b] of [[60, 70], [45, 100], ["abc", 70], [null, null], [NaN, 70], [{}, []]]) assert.equal((await c.get(a, b)).status, "outside", `${a},${b}`);
  assert.equal((await c.get(49, 69)).status, "building");
  assert.equal((await c.get(47, 67)).status, "busy", "очередь полна");
  while (c.pending) await sleep(5);
  assert.equal((await c.get(46, 66)).status, "building");
  while (c.pending) await sleep(5);
  assert.equal((await c.get(45, 65)).status, "busy", "больше 3 расчётов в час не запускаем");
});

test("API: /api/village/cache — 202 пока считается, 200 с селом, 400 вне Казахстана, без кэша — 404", async () => {
  const kv = memoryKv(), f = fakeBuild(), villageCache = createVillageCache({ kv, vkey, build: f.build, fresh });
  const mk = vc => createApi({ getState: () => ({ users: {}, villages: {} }), save() {}, kv, vkey, botUsername: "x", onFarmSaved() {}, onDeleted() {}, allowedOrigins: [], kelisimSecret: "s", villageCache: vc });
  const srv = http.createServer((q, r) => mk(villageCache).handle(q, r).then(d => d || r.writeHead(404).end()));
  const srv2 = http.createServer((q, r) => mk(null).handle(q, r).then(d => d || r.writeHead(404).end()));
  await new Promise(r => srv.listen(0, "127.0.0.1", r)); await new Promise(r => srv2.listen(0, "127.0.0.1", r));
  const get = (s, q) => fetch(`http://127.0.0.1:${s.address().port}/api/village/cache?${q}`).then(async r => ({ s: r.status, d: await r.json(), cors: r.headers.get("access-control-allow-origin") }));
  try {
    let r = await get(srv, "lat=51.1&lon=71.4");
    assert.equal(r.s, 202); assert.equal(r.cors, "*");
    while (villageCache.pending) await sleep(5);
    r = await get(srv, "lat=51.1&lon=71.4");
    assert.equal(r.s, 200); assert.equal(r.d.data.plots.length, 16);
    assert.equal((await get(srv, "lat=10&lon=10")).s, 400);
    assert.equal((await get(srv, "lat=__proto__&lon=constructor")).s, 400);
    assert.equal((await get(srv2, "lat=51.1&lon=71.4")).s, 404);
  } finally { srv.close(); srv2.close(); }
});

test("картинка NDVI: настоящий PNG с прозрачностью там, где не пастбище", () => {
  const n = 4, grid = { size: n, ndvi: Float32Array.from({ length: n * n }, (_, i) => (i % 3 ? 0.4 : NaN)), pasture: Uint8Array.from({ length: n * n }, (_, i) => (i < 8 ? 1 : 0)) };
  const b = ndviPng(grid);
  assert.deepEqual([...b.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(b.readUInt32BE(16), n); assert.equal(b.readUInt32BE(20), n);
  const at = b.indexOf("IDAT"), len = b.readUInt32BE(at - 4), raw = zlib.inflateSync(b.subarray(at + 4, at + 4 + len));
  assert.equal(raw.length, n * (n + 1));
  assert.equal(raw[1 + 0], 0, "NaN — прозрачно");
  assert.ok(raw[1 + 1] > 0, "пастбище с NDVI — цвет");
  assert.equal(raw[3 * (n + 1) + 1 + 1], 0, "не пастбище — прозрачно");
});

test("храним не больше keep последних сёл: старые удаляются", async () => {
  const kv = memoryKv(), f = fakeBuild({ ms: 1 }), c = createVillageCache({ kv, vkey, build: f.build, fresh, keep: 2 });
  for (const lat of [50, 50.1, 50.2]) { await c.get(lat, 70); while (c.pending) await sleep(2); }
  assert.equal(await kv.get("vc:" + vkey(50, 70)), null, "самое старое удалено");
  assert.equal((await c.get(50.2, 70)).status, "ok");
  assert.deepEqual(await kv.get("vc:list"), [vkey(50.1, 70), vkey(50.2, 70)]);
});
