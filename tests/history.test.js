// Прошлое лето: вода по классу SCL, расчёт сезона без сети, сравнение двух лет (web/pipeline.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const PL = require("../web/pipeline.js");

test("SCL из каналов: класс пикселя, 0 там, где нет данных", () => {
  const N = 3, d = new Uint16Array(4 * N);
  d.set([6, 4, 9], 2 * N);      // SCL
  d.set([1, 0, 1], 3 * N);      // маска данных
  assert.deepEqual([...PL.sclFromBands(d, N)], [6, 0, 9]);
});

test("вода: устойчивая — пиксель водой на ≥ половине снимков, где его видно; тень на одном снимке — не вода", () => {
  // 1 участок из 4 пикселей, площадь пикселя 1 га
  const idx = Int8Array.from([0, 0, 0, 0]);
  const a = Uint8Array.from([6, 6, 4, 4]);   // пиксели 0,1 — вода
  const b = Uint8Array.from([6, 4, 4, 6]);   // пиксель 3 — «вода» один раз (тень/лужа)
  const c = Uint8Array.from([6, 6, 4, 4]);
  const [w] = PL.plotWater([a, b, c], idx, 1, 1);
  assert.equal(w.water_ha, 2, "устойчиво: пиксели 0 и 1");
  assert.equal(w.water_max_ha, 3, "хоть раз: 0, 1 и 3");
  assert.equal(w.water_obs, 3);
});

test("вода: облака не считаются ни водой, ни сушей; участок без видимых снимков — null", () => {
  const idx = Int8Array.from([0, 0, 1, 1]);
  const cloudy = Uint8Array.from([9, 9, 9, 9]);
  const half = Uint8Array.from([6, 9, 9, 9]);
  const r = PL.plotWater([cloudy, half], idx, 1, 2);
  assert.equal(r[0].water_obs, 1, "второй снимок видит половину участка 0");
  assert.equal(r[0].water_ha, 0, "виден один раз — устойчивой воды нет");
  assert.deepEqual(r[1], { water_ha: null, water_max_ha: null, water_obs: 0 });
});

test("сезон без сети: 16 участков, NDVI по пастбищному покрову, вода, даты по порядку", () => {
  const lat = 43.02, lon = 79.22, bbox = PL.bboxFor(lat, lon), N = PL.SIZE * PL.SIZE;
  const nd = new Float32Array(N).fill(0.3), scl = new Uint8Array(N).fill(4);
  const land = new Uint8Array(N).fill(30);
  const s = PL.seasonFromArrays({ lat, lon, bbox, year: 2025, per: [nd, nd], scls: [scl, scl], dates: ["2025-08-01", "2025-06-01"], land });
  assert.equal(s.plots.length, 16);
  assert.deepEqual(s.dates, ["2025-06-01", "2025-08-01"]);
  assert.equal(s.status, "measured");
  for (const p of s.plots) { assert.equal(p.ndvi, 0.3); assert.equal(p.water_ha, 0); assert.equal(p.obs_count, 2); }
});

const season = (year, dates, rows) => ({ year, dates, plots: rows.map(([id, ndvi, water_ha]) => ({ id, ndvi, water_ha })) });
const D6 = n => Array.from({ length: n }, (_, i) => `x-0${i + 1}`);

test("сравнение лет: изменение в %, порог «без изменений», вода, итог по селу", () => {
  const prev = season(2025, D6(6), [["Б-С", 0.30, 2], ["Б-В", 0.40, 1], ["Д-С", 0.20, null], ["Д-В", null, 3]]);
  const cur = season(2026, D6(5), [["Б-С", 0.27, 3], ["Б-В", 0.408, 1], ["Д-С", 0.25, 1], ["Д-В", 0.3, 4]]);
  const c = PL.compareSeasons(cur, prev);
  const by = Object.fromEntries(c.plots.map(p => [p.id, p]));
  assert.deepEqual(c.years, [2025, 2026]);
  assert.equal(by["Б-С"].ndvi_change_pct, -10); assert.equal(by["Б-С"].trend, "browner");
  assert.equal(by["Б-В"].ndvi_change_pct, 2); assert.equal(by["Б-В"].trend, "same", "меньше 5 % — без изменений");
  assert.equal(by["Д-С"].trend, "greener");
  assert.equal(by["Д-В"].ndvi_change_pct, null, "нет NDVI прошлого года — не сравниваем");
  assert.equal(by["Б-С"].water_change_ha, 1);
  assert.equal(by["Д-С"].water_change_ha, null);
  assert.deepEqual(c.summary.water_total_ha, [6, 9]);
  assert.equal(c.summary.greener + c.summary.browner + c.summary.same, 3);
  assert.equal(c.reliable, true);
});

test("сравнение лет ненадёжно: мало дат в одном году или мало общих участков", () => {
  const prev = season(2025, D6(2), [["Б-С", 0.3, 1], ["Б-В", null, 1], ["Д-С", null, 1]]);
  const cur = season(2026, D6(6), [["Б-С", 0.3, 1], ["Б-В", 0.3, 1], ["Д-С", 0.3, 1]]);
  const c = PL.compareSeasons(cur, prev);
  assert.equal(c.reliable, false);
  assert.ok(c.reasons.some(r => r.startsWith("prev_dates")));
  assert.ok(c.reasons.some(r => r.startsWith("plots")));
});

test("Кеген: прошлое лето посчитано заранее и сравнимо с текущим", () => {
  const D = require("../web/data/plots.json");
  assert.equal(D.prev_season.year, D.source.year - 1);
  assert.equal(D.prev_season.plots.length, 16);
  const c = PL.compareSeasons({ year: D.source.year, dates: D.source.dates, plots: D.plots.map(p => ({ id: p.id, ndvi: p.ndvi, water_ha: p.water_obs_ha })) }, D.prev_season);
  assert.ok(c.plots.filter(p => p.ndvi_change_pct != null).length >= 8);
});
