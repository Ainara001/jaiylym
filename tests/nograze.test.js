// Где нельзя пасти (web/nograze.js): OSM → зоны → сетка пастбищ → площади по участкам → кормовая площадь. Без сети.
const test = require("node:test");
const assert = require("node:assert/strict");
const NG = require("../web/nograze.js");
const PL = require("../web/pipeline.js");
const J = require("../web/engine.js");
const { loadPlots } = require("../data");

const LAT = 43.02, LON = 79.22;
const kx = 111.32 * Math.cos(LAT * Math.PI / 180), ky = 110.57;
const at = (dxKm, dyKm) => ({ lon: LON + dxKm / kx, lat: LAT + dyKm / ky });
const square = (cx, cy, w, h) => [at(cx - w / 2, cy - h / 2), at(cx + w / 2, cy - h / 2), at(cx + w / 2, cy + h / 2), at(cx - w / 2, cy + h / 2), at(cx - w / 2, cy - h / 2)];
// село 2 × 2 км в центре (участки начинаются с 0,5 км), ферма 30 × 60 м в 5,5 км к северу, хутор точкой на востоке,
// промзона отношением на юге, внутреннее кольцо отношения не вычитается
const OSM = { osm3s: { timestamp_osm_base: "2026-11-20T00:00:00Z" }, elements: [
  { type: "way", id: 1, tags: { landuse: "residential", name: "Кеген" }, geometry: square(0, 0, 2, 2) },
  { type: "way", id: 2, tags: { building: "cowshed" }, geometry: square(0, 5.5, 0.03, 0.06) },
  { type: "node", id: 3, tags: { place: "hamlet", name: "Хутор" }, ...at(5.5, 0) },
  { type: "relation", id: 4, tags: { landuse: "industrial" }, members: [
    { role: "outer", geometry: square(0, -5.5, 0.6, 0.6) }, { role: "inner", geometry: square(0, -5.5, 0.2, 0.2) }] },
  { type: "way", id: 5, tags: { landuse: "meadow" }, geometry: square(3, 3, 1, 1) },     // луг — не зона
] };

const bbox = PL.bboxFor(LAT, LON), N = PL.SIZE * PL.SIZE;
const land = code => new Uint8Array(N).fill(code);

test("запрос Overpass: жильё, населённые пункты, фермы, промзоны", () => {
  const q = NG.overpassQuery(bbox);
  for (const s of ["landuse", "residential", "farmyard", "place", "hamlet", "cowshed", "industrial", "cemetery", "out geom"]) assert.ok(q.includes(s), s);
});

test("разбор OSM: виды зон, точка места → круг (оценка), луг не зона", () => {
  const z = NG.parseZones(OSM);
  assert.deepEqual(z.map(x => x.kind).sort(), ["farm", "industrial", "settlement", "settlement"]);
  const pt = z.find(x => x.point);
  assert.equal(pt.name, "Хутор");
  assert.ok(pt.ring.length > 20);
  assert.equal(z.filter(x => x.kind === "industrial").length, 1, "внутреннее кольцо отношения не стало отдельной зоной");
});

test("площади по участкам: единицы, буфер растёт, мелкая ферма не теряется", async () => {
  const ng = await PL.noGrazeFor({ lat: LAT, lon: LON, bbox, land: land(30), osm: OSM });
  assert.equal(ng.status, "ok");
  assert.deepEqual(ng.buffers, [0, 100, 250, 500]);
  const sum = (b, f) => Object.values(ng.by_buffer[b]).reduce((s, x) => s + f(x), 0);
  // село 2×2 км = 400 га, из них на участках (r ≥ 0,5 км) ≈ 400 − π·0,5² км² = 400 − 78,5 = 321,5 га (сетка ~50 м)
  const near = sum(0, x => x.total_ha);
  assert.ok(near > 300 && near < 400, "площадь зон на участках " + near);
  assert.ok(ng.by_buffer[0]["Д-С"].by_kind.farm > 0, "ферма 30×60 м попала на сетку 50 м");
  assert.ok(ng.by_buffer[0]["Д-В"].by_kind.settlement > 0, "хутор точкой — круг");
  assert.ok(ng.by_buffer[0]["Д-Ю"].by_kind.industrial > 0);
  for (const [a, b] of [[0, 100], [100, 250], [250, 500]]) assert.ok(sum(b, x => x.total_ha) > sum(a, x => x.total_ha), `буфер ${a} → ${b}`);
  assert.ok(ng.by_buffer[100]["Д-С"].by_kind.buffer > 0, "буфер вокруг фермы считается отдельно");
  assert.equal(ng.counts.points, 1);
  assert.ok(ng.zones.length >= 4 && ng.zones.every(z => z.ring.length >= 3));
});

test("вычитается только пастбищный покров: на лесу зона есть, корм не меняется", async () => {
  const ng = await PL.noGrazeFor({ lat: LAT, lon: LON, bbox, land: land(10), osm: OSM });
  const z = ng.by_buffer[100]["Б-С"];
  assert.ok(z.total_ha > 0);
  assert.equal(z.pasture_ha, 0);
});

test("применение к участкам: кормовая площадь и ёмкость уменьшаются, исходная сохраняется", async () => {
  const ng = await PL.noGrazeFor({ lat: LAT, lon: LON, bbox, land: land(30), osm: OSM });
  const D = loadPlots();
  const before = D.plots.find(p => p.id === "Б-С");
  const after = NG.apply(D.plots, ng, 100).find(p => p.id === "Б-С");
  assert.equal(after.pasture_ha_gross, before.pasture_ha);
  assert.ok(after.nograze_ha > 0);
  assert.ok(Math.abs(after.pasture_ha - (before.pasture_ha - after.nograze_ha)) < 0.11);
  assert.ok(J.plotCapacity(after).au_days < J.plotCapacity(before).au_days);
  const twice = NG.apply(NG.apply(D.plots, ng, 100), ng, 500).find(p => p.id === "Б-С");
  assert.equal(twice.pasture_ha_gross, before.pasture_ha, "повторное применение считает от исходной площади");
  assert.equal(NG.apply(D.plots, { status: "error" }), D.plots, "ошибка OSM — участки без изменений");
});

test("сеть: 429, затем ответ — повтор; сбой OSM не ломает расчёт села", async () => {
  let n = 0;
  const fake = async () => { n++; return n === 1 ? { ok: false, status: 429 } : { ok: true, status: 200, json: async () => OSM }; };
  const r = await NG.fetchOSM(bbox, { fetchImpl: fake, retryMs: 1 });
  assert.equal(r.elements.length, 5); assert.equal(n, 2);
  const bad = await PL.noGrazeFor({ lat: LAT, lon: LON, bbox, land: land(30), fetchImpl: async () => { throw new Error("нет сети"); } });
  assert.equal(bad.status, "error");
  assert.match(bad.error, /нет сети/);
  // ответ 200 с пометкой «timed out» — не данные, а сбой: идём к следующему зеркалу
  let k = 0;
  const slow = async () => { k++; return k === 1 ? { ok: true, status: 200, json: async () => ({ remark: "runtime error: Query timed out", elements: [] }) } : { ok: true, status: 200, json: async () => OSM }; };
  assert.equal((await NG.fetchOSM(bbox, { fetchImpl: slow, retryMs: 1 })).elements.length, 5);
});
