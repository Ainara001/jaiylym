// Где селу можно пасти: контур, гектары, чужие участки; площадь не растёт, измерения не меняются.
const test = require("node:test");
const assert = require("node:assert/strict");
const Z = require("../web/zone.js");
const J = require("../web/engine.js");
const NG = require("../web/nograze.js");
const N = require("../web/norms.js");
const PL = require("../web/pipeline.js");
const { loadExamples } = require("../data");
const [BES, KEG] = loadExamples();
const ps = NG.apply(BES.plots, BES.nograze), near = x => Math.abs(x) < 1;

test("гектары по документам: сумма ровно столько, чужие участки в неё не входят", () => {
  const z = Z.defaultFor(BES.village);
  assert.deepEqual(z, { mode: "ha", ha: 825, official: true });
  const a = Z.apply(ps, z);
  assert.ok(near(Z.total(a) - 825), Z.total(a));
  const b = Z.apply(ps, z, null, ["Д-С", "Д-СЗ"]);
  assert.ok(near(Z.total(b, ["Д-С", "Д-СЗ"]) - 825));
  assert.ok(b.every((p, i) => p.ndvi === ps[i].ndvi && p.pasture_ha <= ps[i].pasture_ha && p.pasture_ha_gross >= p.pasture_ha));
  assert.ok(near(Z.total(Z.apply(ps, { mode: "ha", ha: 50000 })) - Z.total(ps)), "больше, чем видно травы, не бывает");
  assert.deepEqual(Z.defaultFor(KEG.village), { mode: "all" });
  assert.equal(Z.apply(ps, { mode: "all" }), ps);
});
test("контур: доля участка внутри; весь круг — всё, пустое место — ноль", () => {
  const v = BES.village, [w, s, e, n] = BES.bbox, mask = { size: 200, bbox: BES.bbox };
  const full = Z.shares(v, [[[w, s], [e, s], [e, n], [w, n]]], mask);
  assert.equal(Object.keys(full).length, 16);
  assert.ok(Object.values(full).every(x => x === 1));
  const north = Z.shares(v, [[[w, v.lat], [e, v.lat], [e, n], [w, n]]], mask);
  assert.ok(north["Д-С"] === 1 && north["Д-Ю"] === 0 && Math.abs(north["Д-В"] - 0.5) < 0.05);
  const a = Z.apply(ps, { mode: "contour", rings: [] }, north);
  assert.equal(a.find(p => p.id === "Д-Ю").pasture_ha, 0);
  assert.ok(a.every((p, i) => p.pasture_ha <= ps[i].pasture_ha));
  assert.equal(Z.apply(ps, { mode: "contour", rings: [] }, null), ps, "доли ещё не посчитаны — площадь прежняя");
  // только северная половина пастбища — пиксели: юг участка не учитывается
  const half = Z.shares(v, [[[w, v.lat], [e, v.lat], [e, n], [w, n]]], Object.assign({ has: i => Math.floor(i / 200) < 100 }, mask));
  assert.equal(half["Д-С"], 1); assert.ok(half["Д-Ю"] == null);
});
test("участок пикселя — тот же, что в спутниковой обработке", () => {
  const { idx } = PL.plotIndex ? PL.plotIndex(BES.village.lat, BES.village.lon, BES.bbox) : { idx: null };
  if (!idx) return;
  const size = Math.sqrt(idx.length), ids = PL.makePlots(BES.village.lat, BES.village.lon).map(p => p.id), [w, s, e, n] = BES.bbox;
  let diff = 0, all = 0;
  for (let i = 0; i < idx.length; i += 37) { const r = Math.floor(i / size), c = i % size, id = Z.plotAt(BES.village, w + (c + .5) * (e - w) / size, n - (r + .5) * (n - s) / size); all++; if ((idx[i] < 0 ? null : ids[idx[i]]) !== id) diff++; }
  assert.ok(diff / all < 0.002, diff + " из " + all);
});
test("неверный выбор не принимается", () => {
  for (const z of [null, 1, {}, { mode: "ha", ha: -5 }, { mode: "ha", ha: "x" }, { mode: "contour", rings: [[[1, 2], [3, 4]]] }, { mode: "contour", rings: [[["a", 1], [2, 2], [3, 3]]] }, { mode: "zzz" }]) assert.equal(Z.clean(z), null, JSON.stringify(z));
  assert.equal(Z.clean({ mode: "contour", rings: Array(9).fill([[1, 1], [2, 2], [3, 1]]) }).rings.length, 5);
});
test("Бесколь: 825 га держат меньше примера — дефицит настоящий, а не из-за запрета дойным; цепочка расчёта сходится", () => {
  const P = J.params(), plots = N.attach(Z.apply(ps, Z.defaultFor(BES.village)), { region: "SKO" }), r = J.optimize(plots, BES.herds, P);
  const cap = plots.reduce((s, p) => s + J.plotCapacity(p, P).au_season, 0), au = BES.herds.reduce((s, h) => s + J.herdAU(h, P), 0);
  assert.ok(cap > 120 && cap < 185, "ёмкость " + cap);
  assert.ok(au > cap && au < cap * 1.6, `стада ${au} против ${cap}`);
  const sh = Object.values(r.shares || {});
  assert.ok(Math.max(...sh) - Math.min(...sh) < 0.05, "нехватку делят поровну: " + sh.map(x => x.toFixed(2)));
  const e = J.explainCapacity(plots.find(p => p.id === "Д-Ю"), P), st = Object.fromEntries(e.steps.map(s => [s.key, s]));
  assert.match(st.zone.formula, /×/);
  assert.equal(st.area.value, +plots.find(p => p.id === "Д-Ю").pasture_ha.toFixed(1));
});
