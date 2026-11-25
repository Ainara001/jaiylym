// Жильё, огороды, сады и поля — не пастбище: правило по карте покрова (без OSM) и зоны OSM без буфера.
const test = require("node:test");
const assert = require("node:assert/strict");
const PL = require("../web/pipeline.js");
const NG = require("../web/nograze.js");

const LAT = 43.02, LON = 79.22, bbox = PL.bboxFor(LAT, LON), n = PL.SIZE, at = (x, y) => y * n + x;
const grass = () => new Uint8Array(n * n).fill(30);
const isP = c => PL.classifyLandcover(c) === "pasture";

test("посёлок: трава между домами — не пастбище, луг за околицей остаётся", () => {
  const land = grass();
  for (let y = 100; y < 140; y++) for (let x = 100; x < 140; x++) if ((x + y) % 4 === 0) land[at(x, y)] = 50;      // дома через каждые 200 м — четверть площади
  const L = PL.refineLand(land, bbox);
  assert.equal(L[at(121, 120)], 51, "двор среди домов");
  assert.equal(L[at(120, 148)], 30, "луг в 400 м от домов");
  assert.equal(land[at(121, 120)], 30, "исходный массив не изменился");
  assert.equal(L.filter(isP).length > n * n - 60 * 60, true);
});

test("одиночный дом в степи пастбище не отнимает", () => {
  const land = grass(); land[at(170, 170)] = 50;
  const L = PL.refineLand(land, bbox);
  assert.equal(L.filter(c => c === 51).length, 0);
});

test("пятно травы меньше 5 га среди пашни — не пастбище; 10 га и пятно у края рамки — остаются", () => {
  const land = new Uint8Array(n * n).fill(40), box = (x0, y0, w, h) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) land[at(x, y)] = 30; };
  box(50, 50, 3, 3); box(200, 200, 7, 7); box(0, 300, 3, 3);                // ~2,3 га, ~12,5 га, у края
  const L = PL.refineLand(land, bbox);
  assert.equal(L[at(51, 51)], 31); assert.equal(L[at(203, 203)], 30); assert.equal(L[at(1, 301)], 30);
  assert.equal(PL.classifyLandcover(31), "excluded"); assert.equal(PL.classifyLandcover(51), "excluded");
});

const km = [111.32 * Math.cos(LAT * Math.PI / 180), 110.57], pt = (x, y) => ({ lon: LON + x / km[0], lat: LAT + y / km[1] });
const sq = (x, y, a) => [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([i, j]) => pt(x + i * a / 2, y + j * a / 2));
const way = (tags, g) => ({ type: "way", id: 1, tags, geometry: g });

test("сад, дачи, парк и поле из OSM вычитаются без буфера; школа и аэропорт — с буфером", async () => {
  const one = async tags => (await PL.noGrazeFor({ lat: LAT, lon: LON, bbox, land: grass(), osm: { elements: [way(tags, sq(0, 5, 1))] } }));
  for (const tags of [{ landuse: "orchard" }, { landuse: "allotments" }, { leisure: "park" }, { landuse: "farmland" }]) {
    const g = await one(tags), z = b => g.by_buffer[b]["Д-С"];
    assert.equal(g.counts.garden, 1, JSON.stringify(tags));
    assert.ok(z(0).pasture_ha > 90 && z(0).pasture_ha < 115, "около 100 га: " + z(0).pasture_ha);
    assert.equal(z(500).pasture_ha, z(0).pasture_ha, "буфера у сада нет");
    assert.equal(g.version, NG.VERSION);
  }
  for (const tags of [{ amenity: "school" }, { aeroway: "aerodrome" }]) { const g = await one(tags); assert.ok(g.by_buffer[500]["Д-С"].pasture_ha > g.by_buffer[0]["Д-С"].pasture_ha); }
  const q = NG.overpassQuery(bbox);
  for (const s of ["orchard", "allotments", "vineyard", "farmland", "park", "aerodrome"]) assert.ok(q.includes(s), s);
});

test("маска для карты: жильё с буфером, сад без буфера, луг закрашивается", async () => {
  const ng = await PL.noGrazeFor({ lat: LAT, lon: LON, bbox, land: grass(), osm: { elements: [way({ landuse: "residential" }, sq(-4, 0, 1)), way({ landuse: "orchard" }, sq(4, 0, 1))] } });
  const m = NG.blockMask(ng, bbox, n, 250), px = (x, y) => m[at(Math.floor((x / km[0] + LON - bbox[0]) / (bbox[2] - bbox[0]) * n), Math.floor((bbox[3] - LAT - y / km[1]) / (bbox[3] - bbox[1]) * n))];
  assert.deepEqual([px(-4, 0), px(-3.35, 0), px(4, 0), px(3.35, 0), px(0, 4)], [1, 1, 1, 0, 0]);
});
