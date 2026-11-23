// Спутниковый анализ без сети: классы WorldCover, состав площади, NDVI, облака, даты, дубли сцен, контуры.
// Реальные запросы к Planetary Computer — отдельно: npm run test:net
const test = require("node:test");
const assert = require("node:assert/strict");
const PL = require("../web/pipeline.js");
const M = require("../web/model.js");

const N = PL.SIZE * PL.SIZE;

test("классы ESA WorldCover: пастбищный покров, исключённые и неопределённые", () => {
  const exp = { 10: "excluded", 20: "pasture", 30: "pasture", 40: "excluded", 50: "excluded", 60: "pasture", 70: "excluded",
    80: "excluded", 90: "uncertain", 95: "excluded", 100: "uncertain", 0: "uncertain", 255: "uncertain", 42: "uncertain" };
  for (const [code, cat] of Object.entries(exp)) assert.equal(PL.classifyLandcover(+code), cat, "класс " + code);
  assert.equal(PL.classifyLandcover(10), "excluded", "лес — не пастбище");
  assert.equal(PL.classifyLandcover(40), "excluded", "пашня — не пастбище");
});

test("состав площади по всем основным классам: суммы и единицы (га)", () => {
  const codes = [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100, 0];
  const land = new Uint8Array(codes.length * 100);
  codes.forEach((c, i) => land.fill(c, i * 100, (i + 1) * 100));
  const c = PL.landcoverComposition(land, null, 0.01);          // пиксель 10 м = 0,01 га → 100 пикселей = 1 га
  assert.equal(c.total_ha, 12);
  assert.equal(c.pasture_ha, 3);                                 // 20, 30, 60
  assert.equal(c.excluded_ha, 6);                                // 10, 40, 50, 70, 80, 95
  assert.equal(c.uncertain_ha, 3);                               // 90, 100, 0
  assert.equal(c.water_ha, 1);
  assert.ok(Math.abs(c.pasture_ha + c.excluded_ha + c.uncertain_ha - c.total_ha) < 1e-9);
  assert.equal(c.by_class.length, codes.length);
  for (const k of c.by_class) assert.equal(k.ha, 1);
  // маска: считаем только внутри контура
  const inside = new Uint8Array(land.length); inside.fill(1, 100, 300);   // только 20 и 30
  const ci = PL.landcoverComposition(land, inside, 0.01);
  assert.equal(ci.total_ha, 2); assert.equal(ci.pasture_ha, 2); assert.equal(ci.excluded_ha, 0);
});

test("контур фермера и село считают пастбище по одним правилам (лес и пашня не корм)", () => {
  const ring = PL.closeRing([[79.2, 43.0], [79.21, 43.0], [79.21, 43.008], [79.2, 43.008]]);
  const area = PL.polygonAreaHa(ring), bbox = PL.ringBbox(ring);
  const land = new Uint8Array(N).fill(10);                         // весь участок — лес
  const nd = new Float32Array(N).fill(0.6);
  const r = PL.polygonFromArrays({ ring, area, bbox, per: [nd, nd], dates: ["2026-07-01", "2026-07-11"], land, year: 2026 });
  assert.equal(r.pasture_ha, 0, "лес не засчитан как пастбище");
  assert.ok(r.excluded_ha > 0);
  assert.equal(r.ndvi, null, "NDVI леса не выдаётся за NDVI пастбища");
  assert.equal(r.meta.data_status, "no_data");
  land.fill(30);
  const g = PL.polygonFromArrays({ ring, area, bbox, per: [nd, nd], dates: ["2026-07-01", "2026-07-11"], land, year: 2026 });
  assert.ok(Math.abs(g.pasture_ha - g.area_ha) < 0.2);
  assert.equal(g.ndvi, 0.6);
  // в режиме села та же функция классов
  const idx = new Int8Array(N).fill(0);
  const vm = PL.plotMeans(nd, new Uint8Array(N).fill(10), idx);
  assert.equal(vm[0].ndvi, null);
});

test("нет доступных снимков: NDVI неизвестен, статус no_data, предупреждение", () => {
  const ring = PL.closeRing([[79.2, 43.0], [79.21, 43.0], [79.21, 43.008], [79.2, 43.008]]);
  const r = PL.polygonFromArrays({ ring, area: PL.polygonAreaHa(ring), bbox: PL.ringBbox(ring), per: [], dates: [], land: new Uint8Array(N).fill(30), year: 2026 });
  assert.equal(r.ndvi, null);
  assert.equal(r.meta.data_status, "no_data");
  assert.equal(r.meta.imagery_count, 0);
  assert.ok(r.meta.warnings.some(w => /Нет безоблачных/.test(w)));
  assert.equal(M.dataStatus(r), "no_data");
});

test("часть участка под облаками: доля валидных пикселей и предупреждение", () => {
  const ring = PL.closeRing([[79.2, 43.0], [79.21, 43.0], [79.21, 43.008], [79.2, 43.008]]);
  const bbox = PL.ringBbox(ring);
  const land = new Uint8Array(N).fill(30);
  const inside = PL.insideMask(ring, bbox);
  const nd = new Float32Array(N).fill(0.4);
  let k = 0; for (let i = 0; i < N; i++) if (inside[i] && (k++ % 10) < 7) nd[i] = NaN;   // 70 % закрыто
  const r = PL.polygonFromArrays({ ring, area: PL.polygonAreaHa(ring), bbox, per: [nd], dates: ["2026-07-01"], land, year: 2026 });
  assert.ok(r.valid_fraction > 0.25 && r.valid_fraction < 0.35, "валидно ≈ 30 %: " + r.valid_fraction);
  assert.ok(r.meta.warnings.some(w => /Валидными пикселями/.test(w)));
  assert.equal(r.series.length, 0, "снимок, где облака закрыли больше половины, не попадает в ряд");
  assert.equal(M.satelliteQuality(Object.assign({}, r)), "low");
});

test("NDVI из каналов: B04 — красный, B08 — ИК; облака, тени, снег, вода и no-data отбрасываются", () => {
  const n = 8, d = new Uint16Array(4 * n);
  const set = (i, red, nir, scl, ok = 1) => { d[i] = red; d[n + i] = nir; d[2 * n + i] = scl; d[3 * n + i] = ok; };
  set(0, 1000, 3000, 4);        // растительность: (3000−1000)/(4000) = 0.5
  set(1, 1000, 3000, 9);        // облако
  set(2, 1000, 3000, 3);        // тень облака
  set(3, 1000, 3000, 11);       // снег
  set(4, 1000, 3000, 6);        // вода
  set(5, 1000, 3000, 4, 0);     // no-data
  set(6, 0, 3000, 5);           // нулевой красный
  set(7, 2000, 2000, 5);        // голая почва: 0
  const nd = PL.ndviFromBands(d, n, 0);
  assert.ok(Math.abs(nd[0] - 0.5) < 1e-6);
  for (const i of [1, 2, 3, 4, 5, 6]) assert.ok(Number.isNaN(nd[i]), "пиксель " + i);
  assert.equal(nd[7], 0);
  // смещение +1000 для baseline 04.00
  const d2 = new Uint16Array(4); d2[0] = 2000; d2[1] = 4000; d2[2] = 4; d2[3] = 1;
  assert.ok(Math.abs(PL.ndviFromBands(d2, 1, 1000)[0] - (3000 - 1000) / 4000) < 1e-6);
});

test("processing baseline: смещение 1000 с 04.00 или по дате, если baseline не указан", () => {
  assert.equal(PL.boaOffset({ "s2:processing_baseline": "05.10", datetime: "2026-07-01" }), 1000);
  assert.equal(PL.boaOffset({ "s2:processing_baseline": "03.01", datetime: "2021-07-01" }), 0);
  assert.equal(PL.boaOffset({ datetime: "2023-07-01T06:00:00Z" }), 1000, "нет baseline, но сцена после 25.01.2022");
  assert.equal(PL.boaOffset({ datetime: "2019-07-01T06:00:00Z" }), 0);
});

test("неправильная дата снимка и повторяющиеся сцены отбрасываются", () => {
  const it = (id, dt, cc = 5) => ({ id, properties: { datetime: dt, "eo:cloud_cover": cc } });
  const { items, dropped } = PL.sanitizeScenes([
    it("a", "2026-07-01T06:00:00Z"), it("a", "2026-07-01T06:00:00Z"), it("b", "не дата"), it("c", "2030-01-01T00:00:00Z"),
    it("d", "2026-04-01T00:00:00Z"), it("e", "2026-08-15T06:00:00Z"),
  ], { from: "2026-06-01", to: "2026-08-31", now: new Date("2026-11-01") });
  assert.deepEqual(items.map(x => x.id), ["a", "e"]);
  assert.deepEqual(dropped, ["a", "b", "c", "d"]);
  // тайлы одной даты — одно наблюдение
  const pick = PL.pickScenes([it("t1", "2026-07-01T06:00:00Z", 2), it("t2", "2026-07-01T06:00:00Z", 3), it("u", "2026-07-11T06:00:00Z", 1)]);
  assert.equal(new Set(pick.map(x => x.properties.datetime.slice(0, 10))).size, 2);
});

test("склейка тайлов одной даты и медиана: повтор не удваивает вес наблюдения", () => {
  const a = Float32Array.from([0.2, NaN, 0.4]), b = Float32Array.from([NaN, 0.3, 0.9]), c = Float32Array.from([0.6, 0.6, 0.6]);
  const m = PL.mergeSameDate([a, b, c], ["2026-07-01", "2026-07-01", "2026-07-11"]);
  assert.deepEqual(m.dates, ["2026-07-01", "2026-07-11"]);
  assert.deepEqual(Array.from(m.per[0]).map(x => +x.toFixed(2)), [0.2, 0.3, 0.4], "первый валидный пиксель даты");
  const med = PL.medianComposite(m.per, 3);
  assert.deepEqual(Array.from(med).map(x => +x.toFixed(2)), [0.4, 0.45, 0.5]);
});

test("пустой, самопересекающийся, крошечный и огромный контуры отклоняются", () => {
  assert.throws(() => PL.checkRing(PL.closeRing([[79, 43], [79.01, 43]])), /минимум 3/);
  const bow = PL.closeRing([[79.2, 43.0], [79.21, 43.008], [79.21, 43.0], [79.2, 43.008]]);
  assert.equal(PL.ringSelfIntersects(bow), true);
  assert.throws(() => PL.checkRing(bow), /пересекают/);
  const sq = PL.closeRing([[79.2, 43.0], [79.21, 43.0], [79.21, 43.008], [79.2, 43.008]]);
  assert.equal(PL.ringSelfIntersects(sq), false);
  assert.throws(() => PL.checkRing(PL.closeRing([[79.2, 43.0], [79.2001, 43.0], [79.2001, 43.0001]])), /меньше 1 га/);
  assert.throws(() => PL.checkRing(PL.closeRing([[79, 43], [79.6, 43], [79.6, 43.4]])), /больше 30 км/);
  assert.throws(() => PL.checkRing(PL.closeRing([[79, 43], [190, 43], [79, 44]])), /неверные координаты/);
});

test("единицы площади: квадрат 1 × 1 км = 100 га", () => {
  const lat = 43.05, lon = 79.22, dy = 1 / 110.57, dx = 1 / (111.32 * Math.cos(lat * Math.PI / 180));
  const ha = PL.polygonAreaHa(PL.closeRing([[lon, lat], [lon + dx, lat], [lon + dx, lat + dy], [lon, lat + dy]]));
  assert.ok(Math.abs(ha - 100) < 0.5, ha);
});

test("единый объект метаданных: одинаковые поля для сайта, бота и PDF", () => {
  const meta = PL.metaFor({ year: 2026, dates: ["2026-07-11", "2026-07-01"], valid: 0.87654, warnings: ["x"], status: "measured" });
  assert.deepEqual(Object.keys(M.makeMeta(meta)), M.META_FIELDS);
  assert.deepEqual(meta.scene_dates, ["2026-07-01", "2026-07-11"]);
  assert.equal(meta.valid_pixel_fraction, 0.877);
  assert.equal(meta.landcover_year, 2021);
  const legacy = M.metaOf(require("../data").loadPlots());
  assert.deepEqual(Object.keys(legacy), M.META_FIELDS);
  assert.equal(legacy.imagery_count, 6);
  assert.ok(legacy.warnings.length >= 1, "для старых данных честно сказано, что не записано");
});
