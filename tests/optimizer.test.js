// Оптимизатор распределения (fair-optimal-v1): корректность, оптимальность по заявленным критериям, сравнение с жадным.
const test = require("node:test");
const assert = require("node:assert/strict");
const J = require("../web/engine.js");
const { loadPlots, loadHerds } = require("../data");
const B = require("../scripts/benchmark-optimizer.js");

const P = J.params();
const D = loadPlots(), H = loadHerds();
const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
const scale = k => H.map(h => Object.assign({}, h, { sheep: (h.sheep || 0) * k, cattle: (h.cattle || 0) * k }));

function invariants(res, plots, herds, opts = {}) {
  const byId = Object.fromEntries(plots.map(p => [p.id, p]));
  const forb = new Set(opts.forbidden || []);
  assert.deepEqual(res.violations, [], JSON.stringify(res.violations));
  const demand = herds.reduce((a, h) => a + J.herdAU(h, P) * P.season_days, 0);
  const used = Object.values(res.load).reduce((a, l) => a + l.used, 0);
  assert.ok(Math.abs(used + sum(res.unmet) - demand) < 1, "распределено + дефицит = спрос");
  for (const [id, l] of Object.entries(res.load)) {
    if (l.known) assert.ok(l.used <= l.cap * (byId[id].max_load ?? 1) + 1e-6, id + " перегружен");
    if (l.used > 1e-6) { assert.ok(!forb.has(id) && !byId[id].forbidden); assert.ok(byId[id].ndvi != null); }
    assert.ok(Math.abs(l.herds.reduce((a, z) => a + z.au_days, 0) - l.used) < 1e-6);
  }
  for (const h of herds) {
    const segs = res.herdPlans[h.id];
    if (J.herdAU(h, P) === 0) continue;
    assert.equal(segs[0].from, 1); assert.equal(segs[segs.length - 1].to, P.season_days);
    for (let i = 1; i < segs.length; i++) assert.equal(segs[i].from, segs[i - 1].to + 1);
    if (h.allowed_plots && h.allowed_plots.length) for (const s of segs) if (s.plot) assert.ok(h.allowed_plots.includes(s.plot), "право: " + h.id + " " + s.plot);
    if (h.daily_return) for (const s of segs) if (s.plot) assert.equal(byId[s.plot].ring, "near");
  }
  if (sum(res.unmet) > 1) assert.notEqual(res.status, "feasible");
  assert.ok(sum(res.unmet) >= res.bound.min_deficit_au_days - 1e-3, "не лучше точной границы — иначе ошибка в границе");
}

test("инварианты: Кеген ×1…×12 и 80 случайных сёл (права, дойные, окна, участки без NDVI)", () => {
  for (const k of [1, 2, 4, 6, 8, 12]) { const hs = scale(k); invariants(J.optimize(D.plots, hs), D.plots, hs); }
  const r = B.rng(7);
  for (let i = 0; i < 80; i++) { const c = B.randomVillage(r); invariants(J.optimize(c.plots, c.herds, P, c.opts), c.plots, c.herds, c.opts); }
});

test("без сезонных окон общий объём корма равен точной границе (max-flow)", () => {
  for (const k of [1, 4, 8, 12]) { const o = J.optimize(D.plots, scale(k)); assert.ok(o.gap_au_days < 1, "Кеген ×" + k + ": " + o.gap_au_days); }
  const r = B.rng(11);
  for (let i = 0; i < 60; i++) {
    const c = B.randomVillage(r);
    const o = J.optimize(c.plots, c.herds, P, {});
    assert.ok(o.gap_au_days < 1e-6 * o.demand_au_days + 1, `задача ${i}: разрыв ${o.gap_au_days}`);
  }
});

test("справедливость max-min: долю худшего хозяйства нельзя поднять, не нарушив ограничений", () => {
  const r = B.rng(13);
  const { flowModel, feasibleFlow, fairShares } = J._internal;
  for (let i = 0; i < 40; i++) {
    const c = B.randomVillage(r);
    const m = flowModel(c.plots, c.herds, P, {});
    if (!m.H.length) continue;
    const s = fairShares(m), lo = Math.min(...s);
    if (lo >= 1 - 1e-9) continue;
    // поднять всех хотя бы до lo + 1 % невозможно
    const L = m.H.map((x, k) => Math.max(s[k], Math.min(1, lo + 0.01)) * x.d);
    assert.ok(feasibleFlow(m, L).flow < L.reduce((a, b) => a + b, 0) - 1e-6, `задача ${i}: минимум ${lo} можно поднять`);
    // и сами доли достижимы
    const L0 = m.H.map((x, k) => s[k] * x.d);
    assert.ok(feasibleFlow(m, L0).flow >= L0.reduce((a, b) => a + b, 0) - 1e-3);
  }
});

test("пример, где жадный алгоритм несправедлив: маленькое стадо занимает единственный участок большого", () => {
  // участки: Д-С (ёмкость ≈ 36 364 гол.·сут) рядом с домом обоих; Д-Ю (столько же) — только для малого стада
  const plots = [
    { id: "Б-С", ring: "near", dir: "С", dist_km: 1.8, pasture_ha: 10, ndvi: 0.3, water: false, water_source: "нет" },
    { id: "Д-С", ring: "far", dir: "С", dist_km: 5.5, pasture_ha: 1000, ndvi: 0.3, water: true, water_source: "водоём на карте WorldCover", series: [1, 2, 3, 4].map(i => ({ d: "2026-07-0" + i, v: 0.3 })) },
    { id: "Д-Ю", ring: "far", dir: "Ю", dist_km: 5.5, pasture_ha: 1000, ndvi: 0.3, water: true, water_source: "водоём на карте WorldCover", series: [1, 2, 3, 4].map(i => ({ d: "2026-07-0" + i, v: 0.3 })) },
  ];
  const herds = [
    { id: "small", sheep: 1000, home: "Б-С" },                              // 200 усл. гол. × 150 = 30 000
    { id: "big", sheep: 2000, home: "Б-С", allowed_plots: ["Д-С"] },        // 400 усл. гол. × 150 = 60 000, только Д-С
  ];
  const g = J.plan(plots, herds), o = J.optimize(plots, herds);
  const share = (res, id) => 1 - (res.unmet[id] || 0) / (J.herdAU(herds.find(h => h.id === id), P) * 150);
  assert.ok(share(g, "big") < 0.25, "жадный: малое стадо заняло Д-С, большому осталось " + share(g, "big").toFixed(2));
  assert.ok(Math.abs(share(o, "big") - 36364 / 60000) < 0.01, "оптимизатор: большому весь Д-С " + share(o, "big").toFixed(3));
  assert.equal(share(o, "small"), 1, "малое стадо целиком на Д-Ю");
  assert.ok(sum(o.unmet) <= sum(g.unmet) + 1);
  assert.equal(o.bottleneck.groups[0].herds.join(), "big");
  assert.equal(o.bottleneck.groups[0].plots.join(), "Д-С");
  assert.ok(o.bottleneck.groups[0].excluded.not_allowed.includes("Д-Ю"), "Д-Ю недоступен большому стаду по введённым правам");
});

test("узкое место: причина «далеко для дойного» относится только к дойным стадам группы", () => {
  const plots = [
    { id: "Б-С", ring: "near", dir: "С", dist_km: 1.8, pasture_ha: 20, ndvi: 0.3, water: true, water_source: "село", series: [1, 2, 3, 4].map(i => ({ d: "2026-07-0" + i, v: 0.3 })) },
    { id: "Д-С", ring: "far", dir: "С", dist_km: 5.5, pasture_ha: 1000, ndvi: 0.3, water: true, water_source: "водоём на карте WorldCover", series: [1, 2, 3, 4].map(i => ({ d: "2026-07-0" + i, v: 0.3 })) },
  ];
  const herds = [
    { id: "milk", sheep: 500, home: "Б-С", daily_return: true },          // дойное: каждый вечер в село — дальний участок недоступен
    { id: "fixed", sheep: 500, home: "Б-С", allowed_plots: ["Б-С"] },     // не дойное, но права только на Б-С
  ];
  const g = J.bottlenecks(plots, herds, P).groups[0];
  assert.deepEqual(g.herds.sort(), ["fixed", "milk"], "оба стада в одном узком месте");
  assert.deepEqual(g.excluded_for.daily_far, ["milk"], "«далеко для дойного» — только для дойного стада");
  assert.deepEqual(g.excluded_for.not_allowed, ["fixed"]);
  assert.deepEqual(g.excluded.daily_far, ["Д-С"]);
});

test("сертификат узкого места: дефицит группы = потребность − ёмкость её участков − лимиты окон", () => {
  const r = B.rng(17);
  let checked = 0;
  for (let i = 0; i < 60; i++) {
    const c = B.randomVillage(r);
    const b = J.bottlenecks(c.plots, c.herds, P, c.opts);
    const bound = J.exactBound(c.plots, c.herds, P, c.opts);
    if (b.feasible) { assert.ok(bound.min_deficit_au_days <= 1); continue; }
    const g = b.groups[0];
    assert.ok(Math.abs(g.shortfall_au_days - b.deficit_au_days) < 1e-3 * (1 + b.deficit_au_days), `задача ${i}`);
    assert.ok(Math.abs(b.deficit_au_days - bound.min_deficit_au_days) < 1e-3 * (1 + b.deficit_au_days));
    assert.ok(g.demand_au_days > g.capacity_au_days + g.window_limited_au_days);
    checked++;
  }
  assert.ok(checked > 20);
});

test("при равной доле — ближе к дому; ближние участки не дойным стадам — в последнюю очередь", () => {
  const mk = (id, ring, dir, dist) => ({ id, ring, dir, dist_km: dist, pasture_ha: 1000, ndvi: 0.3, water: true, water_source: ring === "near" ? "село" : "водоём на карте WorldCover", series: [1, 2, 3, 4].map(i => ({ d: "2026-07-0" + i, v: 0.3 })) });
  const plots = [mk("Б-С", "near", "С", 1.8), mk("Д-С", "far", "С", 5.5), mk("Д-Ю", "far", "Ю", 5.5)];
  const o = J.optimize(plots, [{ id: "a", sheep: 1000, home: "Б-С" }]);
  assert.deepEqual(o.herdPlans.a.map(s => s.plot), ["Д-С"], "отара на дальнем участке в том же направлении");
  const milk = J.optimize(plots, [{ id: "m", cattle: 100, home: "Б-С", daily_return: true }]);
  assert.deepEqual(milk.herdPlans.m.map(s => s.plot), ["Б-С"]);
});

test("на обычной нагрузке Кегена перегонов не больше, чем у жадного; план сохраняет «ни один участок > 100 %»", () => {
  const o = J.optimize(D.plots, H), g = J.plan(D.plots, H);
  const mo = J.planMetrics(o, D.plots, H), mg = J.planMetrics(g, D.plots, H);
  assert.equal(o.status, "feasible");
  assert.ok(mo.moves <= mg.moves, `${mo.moves} > ${mg.moves}`);
  assert.equal(o.overloaded, 0);
});

test("сводное сравнение на 150 случайных сёлах: справедливее, без потери корма, без нарушений", () => {
  const rows = B.run(150, 99), s = B.summary(rows);
  assert.equal(s.viol_o, 0);
  assert.equal(s.zero_o, 0, "ни одно хозяйство не остаётся совсем без корма, если корм есть в принципе");
  assert.ok(s.min_cov_o >= s.min_cov_g + 0.2, `худшее хозяйство ${s.min_cov_o} против ${s.min_cov_g}`);
  assert.ok(s.jain_o > s.jain_g);
  assert.ok(s.opt_gap_share <= s.greedy_gap_share, "разрыв с точной границей не больше, чем у жадного");
  assert.ok(s.t_o_max < 500, "время на задачу " + s.t_o_max + " мс");
});

test("solve(): по умолчанию оптимизатор, «greedy» — прежний алгоритм; сценарий сравнения алгоритмов есть", () => {
  assert.equal(J.solve(D.plots, H).algorithm, "fair-optimal-v1");
  assert.equal(J.solve(D.plots, H, P, { algorithm: "greedy" }).algorithm, "greedy-heuristic-v2");
  const v = J.defaultVariants(D.plots, scale(6), P);
  assert.ok(v.some(x => x.type === "algorithm" && x.name === "greedy"));
  const r = J.compareScenarios(D.plots, scale(6), P, v);
  const plan = r.find(x => x.id === "plan"), greedy = r.find(x => x.id === "greedy");
  assert.ok(plan.min_share > greedy.min_share + 0.3, `${plan.min_share} vs ${greedy.min_share}`);
});
