// Наблюдения людей: сравниваем только одно и то же время, числа не меняются, никто не назван неправым.
const test = require("node:test");
const assert = require("node:assert/strict");
const K = require("../web/kelisim.js");
const { loadExamples } = require("../data");
const { compactContext } = require("../ai-context.js");
const [BES] = loadExamples();
const src = BES.source, plot = BES.plots.find(p => p.id === "Д-Ю");
const cmp = (reason, on, p = plot) => K.compareObs({ reason, on }, p, src);

test("июльская жалоба даёт «проверить на месте», ноябрьская со снимком лета не спорит", () => {
  assert.deepEqual([cmp("no_grass", "2026-07-20").verdict, cmp("no_grass", "2026-07-20").scene], ["check", "2026-07-25"]);
  assert.equal(cmp("no_grass", "2026-11-20").verdict, "other_time");
  assert.equal(cmp("no_grass", "2025-07-20").verdict, "other_time", "прошлый год — другое время");
  assert.equal(cmp("no_grass", null).verdict, "no_date");
});
test("граница — 15 суток от снимка", () => {
  assert.equal(cmp("no_grass", "2026-06-25").verdict, "check");
  assert.equal(cmp("no_grass", "2026-06-24").verdict, "other_time");
  assert.equal(cmp("no_grass", "2026-08-29").verdict, "check");
  assert.equal(cmp("no_grass", "2026-08-30").verdict, "other_time");
});
test("снимок тоже показывает редкую траву — сходится; сорняки снимок не различает; «далеко» не сверяется", () => {
  const p = Object.assign({}, plot, { series: [{ d: "2026-07-10", v: 0.2 }] });
  assert.equal(cmp("no_grass", "2026-07-12", p).verdict, "match");
  assert.deepEqual([cmp("weeds", "2026-07-20").verdict, cmp("weeds", "2026-07-20").why], ["check", "sat_blind"]);
  assert.equal(cmp("far", "2026-07-20").verdict, "info");
  assert.equal(cmp("no_grass", "2026-07-20", Object.assign({}, plot, { series: [] })).verdict, "other_time");
});
test("вода: сравниваем в сезон выпаса этого года", () => {
  const w = s => Object.assign({}, plot, { water_status: s });
  assert.equal(cmp("no_water", "2026-07-20", w("satellite")).verdict, "check");
  assert.equal(cmp("no_water", "2026-07-20", w("unknown")).verdict, "match");
  assert.equal(cmp("no_water", "2026-11-20", w("satellite")).verdict, "other_time");
  assert.equal(cmp("no_water", "2026-05-01", w("satellite")).verdict, "check");
  assert.equal(cmp("no_water", "2026-04-30", w("satellite")).verdict, "other_time");
});

const kel = ps => ({ households: [{ id: "h1", name: "А" }, { id: "h2", name: "Б" }, { id: "h3", name: "В", removed: true }], snapshot: { plots: BES.plots, source: src, params: {} },
  proposals: ps.map((p, i) => Object.assign({ id: "p" + i, type: "avoid", plot: "Д-Ю", reason: "no_grass", status: "open", observed_on: "2026-07-20" }, p)) });
test("одно наблюдение на двор; отозванное, чужого двора и не про участок — не считаются", () => {
  const k = kel([{ household: "h1" }, { household: "h1", observed_on: "2026-07-22" }, { household: "h2", status: "declined" }, { household: "h3" }, { household: "h2", status: "withdrawn", reason: "weeds" },
    { household: "h2", reason: "no_rights" }, { household: "h2", type: "prefer", reason: "no_grass", plot: "Д-С" }]);
  assert.equal(K.observations(k).length, 2);
  const g = K.obsOf(k)["Д-Ю"];
  assert.deepEqual([g.verdict, g.items.length, g.items[0].households.length, g.items[0].dates], ["check", 1, 2, ["2026-07-20", "2026-07-22"]]);
});
test("разные вердикты не смешиваются, у участка — самый важный", () => {
  const g = K.obsOf(kel([{ household: "h1", observed_on: "2026-11-20" }, { household: "h2" }]))["Д-Ю"];
  assert.deepEqual([g.verdict, g.items.map(i => i.verdict)], ["check", ["check", "other_time"]]);
  assert.equal(K.obsOf(kel([{ household: "h1", observed_on: "2026-11-20" }]))["Д-Ю"].verdict, "other_time");
});
test("наблюдение не меняет участки снимка", () => {
  const k = kel([{ household: "h1" }]), before = JSON.stringify(k.snapshot);
  K.obsOf(k);
  assert.equal(JSON.stringify(k.snapshot), before);
});
test("ИИ: наблюдения остаются в сжатом контексте, при нехватке места — сначала те, что проверить", () => {
  const a = Array.from({ length: 12 }, (_, i) => ({ участок: "Д-С", что: "мало травы", вывод: i % 2 ? "проверить на месте" : "другое время, не сравнивать" }));
  const r = compactContext({ наблюдения_людей: a, прочее: "x".repeat(3000) }, { max: 3600 });
  assert.ok(r.cut.some(x => /наблюдения/.test(x)));
  assert.equal(/другое время/.test(r.json), false);
});
