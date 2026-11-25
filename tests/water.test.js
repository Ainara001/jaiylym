// «Где проверять воду»: порядок по снижению дефицита, честное «не поможет», ничего не советует без эффекта.
const test = require("node:test");
const assert = require("node:assert/strict");
const J = require("../web/engine.js");
const PL = require("../web/pipeline.js");
const N = require("../web/norms.js");
const NG = require("../web/nograze.js");
const { loadExamples, loadHerds } = require("../data");
const P = J.params();
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function village(r) {
  const plots = PL.makePlots(43, 79, 4).map(p => { const near = p.ring === "near", water = near ? r() < 0.9 : r() < 0.55;
    return Object.assign(p, { pasture_ha: Math.round(near ? 120 + r() * 230 : 600 + r() * 1700), ndvi: +(0.14 + r() * 0.36).toFixed(3), series: [1, 2, 3, 4].map(i => ({ d: "2026-07-0" + i, v: 0.3 })), water, water_status: water ? (near ? "assumed" : "satellite") : "unknown" }); });
  const near = plots.filter(p => p.ring === "near").map(p => p.id), all = plots.map(p => p.id);
  const herds = Array.from({ length: 3 + Math.floor(r() * 13) }, (_, i) => { const daily = r() < 0.2, h = { id: "h" + i, home: near[Math.floor(r() * 8)], daily_return: daily, sheep: daily ? 0 : Math.round(r() * 2500), cattle: Math.round(r() * (daily ? 200 : 80)), horses: daily ? 0 : Math.round(r() * 60) };
    if (r() < 0.35) h.allowed_plots = all.filter(() => r() < 0.35).concat([h.home]); return h; });
  return { plots, herds };
}
const r = rng(20261125);
const cases = Array.from({ length: 119 }, () => village(r)).concat(loadExamples().flatMap(D => { const plots = N.attach(NG.apply(D.plots, D.nograze), { region: N.regionOf(D.village.region) });
  return [1, 3, 8].map(k => ({ plots, herds: loadHerds().map(h => Object.assign({}, h, { sheep: (h.sheep || 0) * k, cattle: (h.cattle || 0) * k })) })); }));

test("125 сёл: первым не стоит участок без эффекта, если есть лучший; эффект подтверждается отдельным расчётом", () => {
  const n = { ok: 0, no_deficit: 0, no_help: 0 }; let changed = 0;
  for (const c of cases) {
    const w = J.wellRank(c.plots, c.herds, P, {});
    n[w.status]++;
    if (w.status !== "ok") { assert.ok(w.list.every(x => !x.gain_t)); continue; }
    assert.equal(w.list[0].gain_t, Math.max(...w.list.map(x => x.gain_t)));
    assert.ok(w.list[0].gain_t >= 0.5);
    for (let i = 1; i < w.list.length; i++) assert.ok(w.list[i - 1].gain_t >= w.list[i].gain_t);
    const e = J.wellEffect(c.plots, c.herds, P, w.list[0].plot, {}), real = J.hayTonnes(e.deficit_kg_before - e.deficit_kg_after, P);
    assert.ok(Math.abs(real - w.list[0].gain_t) < 1e-6);
    if (J.wells(c.plots, P)[0].plot !== w.list[0].plot) changed++;
  }
  assert.equal(n.ok + n.no_deficit + n.no_help, 125);
  assert.ok(n.ok > 20 && n.no_deficit > 5, JSON.stringify(n));
  console.log("  сёл: " + JSON.stringify(n) + ", первое место сменилось: " + changed);
});
test("без стад, без дефицита и когда причина не в воде — прямо сказано", () => {
  const [BES] = loadExamples();
  assert.equal(J.wellRank(BES.plots, [], P).status, "no_herds");
  assert.equal(J.wellRank(cases[0].plots, [{ id: "a", home: "Б-С", sheep: 1 }], P).status, "no_deficit");
  const daily = [{ id: "a", home: "Б-С", cattle: 5000, allowed_plots: ["Б-С"] }];     // права только на ближний участок: дальний водопой не поможет
  const ps = BES.plots.map(p => Object.assign({}, p, p.ring === "far" ? { water: false, water_status: "unknown" } : {}));
  const w = J.wellRank(ps, daily, P);
  assert.equal(w.status, "no_help");
  assert.ok(w.list.length > 0);
});
test("кому станет лучше: стадо, которому не хватало корма, в списке", () => {
  const c = cases.find(x => J.wellRank(x.plots, x.herds, P, {}).status === "ok"), w = J.wellRank(c.plots, c.herds, P, {}).list[0], e = J.wellEffect(c.plots, c.herds, P, w.plot, {});
  assert.ok(w.better.length >= 1);
  for (const id of w.better) assert.ok((e.after.unmet[id] || 0) < (e.before.unmet[id] || 0));
});
