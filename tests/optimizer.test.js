// Оптимизатор распределения (fair-optimal-v2): корректность, оптимальность по заявленным критериям, сравнение с жадным.
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
  assert.equal(J.solve(D.plots, H).algorithm, "fair-optimal-v2");
  assert.equal(J.solve(D.plots, H, P, { algorithm: "greedy" }).algorithm, "greedy-heuristic-v2");
  const v = J.defaultVariants(D.plots, scale(6), P);
  assert.ok(v.some(x => x.type === "algorithm" && x.name === "greedy"));
  const r = J.compareScenarios(D.plots, scale(6), P, v);
  const plan = r.find(x => x.id === "plan"), greedy = r.find(x => x.id === "greedy");
  assert.ok(plan.min_share > greedy.min_share + 0.3, `${plan.min_share} vs ${greedy.min_share}`);
});

// ---------- меньше перегонов, отдых участков, веса хозяйств ----------
const mk = (id, ring, dir, ha, extra = {}) => Object.assign({ id, ring, dir, dist_km: ring === "near" ? 1.8 : 5.5, pasture_ha: ha, ndvi: 0.3, water: true,
  water_source: ring === "near" ? "село" : "водоём на карте WorldCover", series: [1, 2, 3, 4].map(i => ({ d: "2026-07-0" + i, v: 0.3 })) }, extra);

test("календарь: ближние участки целыми группами на весну и осень; короткий единственный ближний не режется пополам", () => {
  const segs = [{ plot: "Б-С", ring: "near", days: 30 }, { plot: "Б-В", ring: "near", days: 20 }, { plot: "Д-С", ring: "far", days: 100 }];
  const s = J._internal.schedule(segs, 150).segments.filter(x => x.plot);
  assert.deepEqual(s.map(x => x.plot), ["Б-С", "Д-С", "Б-В"], "каждый участок — одна стоянка");
  const one = J._internal.schedule([{ plot: "Б-С", ring: "near", days: 20 }, { plot: "Д-С", ring: "far", days: 130 }], 150).segments.filter(x => x.plot);
  assert.deepEqual(one.map(x => x.plot), ["Б-С", "Д-С"], "20 дней не делятся на две стоянки по 10");
  const big = J._internal.schedule([{ plot: "Б-С", ring: "near", days: 60 }, { plot: "Д-С", ring: "far", days: 90 }], 150).segments.filter(x => x.plot);
  assert.deepEqual(big.map(x => x.plot), ["Б-С", "Д-С", "Б-С"], "60 дней — весна и осень по 30");
});

test("меньше перегонов при тех же долях: на 60 случайных сёлах доли и дефицит как без склейки, участков не больше", () => {
  const r = B.rng(424242);
  let movesOpt = 0, movesGreedy = 0, shortOpt = 0, shortGreedy = 0;
  for (let k = 0; k < 60; k++) {
    const c = B.randomVillage(r);
    const o = J.optimize(c.plots, c.herds, P, c.opts), raw = J.optimize(c.plots, c.herds, P, Object.assign({ no_consolidate: true }, c.opts)), g = J.plan(c.plots, c.herds, P, c.opts);
    invariants(o, c.plots, c.herds, c.opts);
    for (const h of c.herds) if (o.shares[h.id] != null) assert.ok(Math.abs(o.shares[h.id] - raw.shares[h.id]) < 1e-6, "доля не меняется");
    assert.ok(o.deficit_au_days <= raw.deficit_au_days + 1, `дефицит не хуже: ${o.deficit_au_days} > ${raw.deficit_au_days}`);
    const mo = J.planMetrics(o, c.plots, c.herds, P), mg = J.planMetrics(g, c.plots, c.herds, P), mr = J.planMetrics(raw, c.plots, c.herds, P);
    assert.ok(mo.moves <= mr.moves, `склейка не добавляет перегонов: ${mo.moves} > ${mr.moves}`);
    movesOpt += mo.moves; movesGreedy += mg.moves; shortOpt += mo.short_stays; shortGreedy += mg.short_stays;
  }
  assert.ok(movesOpt <= movesGreedy * 1.1, `перегонов почти как у жадного: ${movesOpt} vs ${movesGreedy}`);
  assert.ok(shortOpt <= shortGreedy, `коротких стоянок не больше, чем у жадного: ${shortOpt} vs ${shortGreedy}`);
});

test("отдых участка: окно выпаса соблюдается в календаре всех стад", () => {
  const plots = [mk("Б-С", "near", "С", 300), mk("Д-С", "far", "С", 900, { window: { from: 31, to: 150 } }), mk("Д-Ю", "far", "Ю", 900)];
  const herds = [{ id: "a", sheep: 800, home: "Б-С" }, { id: "b", sheep: 800, home: "Б-С" }];
  const o = J.optimize(plots, herds, P);
  invariants(o, plots, herds);
  for (const h of herds) for (const s of o.herdPlans[h.id]) if (s.plot === "Д-С") assert.ok(s.from >= 31, `${h.id}: Д-С с ${s.from} дня, а отдыхает до 30`);
});

test("веса хозяйств: при нехватке доля с весом 2 растёт вдвое быстрее; вес 1 у всех — как без весов", () => {
  const plots = [mk("Б-С", "near", "С", 200)];
  const base = [{ id: "a", sheep: 1500, home: "Б-С" }, { id: "b", sheep: 1500, home: "Б-С" }];
  const eq = J.optimize(plots, base, P), w1 = J.optimize(plots, base.map(h => Object.assign({ weight: 1 }, h)), P);
  assert.ok(Math.abs(eq.shares.a - eq.shares.b) < 1e-6);
  assert.ok(Math.abs(w1.shares.a - eq.shares.a) < 1e-9);
  const w = J.optimize(plots, [Object.assign({ weight: 2 }, base[0]), base[1]], P);
  assert.ok(w.shares.a < 1, "корма не хватает обоим");
  assert.ok(Math.abs(w.shares.a / w.shares.b - 2) < 0.01, "доли 2 : 1 — " + (w.shares.a / w.shares.b).toFixed(3));
  assert.ok(Math.abs((w.shares.a + w.shares.b) - (eq.shares.a + eq.shares.b)) < 1e-3, "весь корм по-прежнему роздан");
});

test("explainPlan: факты совпадают с планом — маршрут, «заняты до предела», недоступные участки", () => {
  const NG = require("../web/nograze.js");
  const P0 = NG.apply(D.plots, D.nograze);
  const r = B.rng(23);
  const cases = [{ plots: P0, herds: H }, { plots: P0, herds: scale(6) }];
  for (let i = 0; i < 25; i++) cases.push(B.randomVillage(r));
  for (const c of cases) {
    const res = J.solve(c.plots, c.herds, P, c.opts);
    const ex = J.explainPlan(c.plots, c.herds, res, P, c.opts);
    for (const h of c.herds) {
      if (J.herdAU(h, P) <= 0) continue;
      const e = ex[h.id];
      assert.ok(e, h.id);
      assert.deepEqual(e.маршрут.map(s => s.участок), res.herdPlans[h.id].map(s => s.plot), "маршрут как в плане");
      assert.equal(e.не_хватает_усл_гол_сут, Math.round(res.unmet[h.id] || 0));
      for (const s of e.маршрут) {
        if (!s.участок) continue;
        const m = /ближе были (.+?) — заняты другими стадами до предела/.exec(s.почему);
        if (m) for (const id of m[1].split(", ").map(x => x.split(" ")[0])) {
          const l = res.load[id];
          assert.ok(l.used >= l.limit - 0.5 * 1.01, `${id} назван занятым, но свободен: ${l.used} из ${l.limit}`);
        }
      }
      for (const [reason, ids] of Object.entries(e.недоступные_участки || {})) assert.deepEqual(ids, res.diagnostics[h.id].excluded[reason]);
    }
  }
});
