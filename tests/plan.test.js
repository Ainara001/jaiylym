// Смысловые проверки плана: ограничения, инварианты, честный статус при невозможности распределения.
// Запуск: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const { Jaiylym: J, loadPlots, loadHerds } = require("../data");

const D = loadPlots();
const plots = D.plots;
const herds = loadHerds();
const P = J.params();
const sum = o => Object.values(o).reduce((s, x) => s + x, 0);

// маленькое «село» для понятных проверок: 1 ближний и 2 дальних участка
function mini(over = {}) {
  const base = [
    { id: "Б-С", ring: "near", dir: "С", dist_km: 1.8, pasture_ha: 300, ndvi: 0.3, water: true, water_source: "село", series: [1, 2, 3, 4].map(i => ({ d: "2026-07-0" + i, v: 0.3 })) },
    { id: "Д-С", ring: "far", dir: "С", dist_km: 5.5, pasture_ha: 1000, ndvi: 0.3, water: true, water_source: "водоём на карте WorldCover", series: [1, 2, 3, 4].map(i => ({ d: "2026-07-0" + i, v: 0.3 })) },
    { id: "Д-Ю", ring: "far", dir: "Ю", dist_km: 5.5, pasture_ha: 1000, ndvi: 0.3, water: false, water_source: "нет", series: [1, 2, 3, 4].map(i => ({ d: "2026-07-0" + i, v: 0.3 })) },
  ];
  return base.map(p => Object.assign({}, p, over[p.id] || {}));
}
// ёмкость 1000 га при NDVI 0.3: 1000 × 800 × 0.5 / 11 = 36 364 голово-дня ≈ 242 усл. гол. на сезон
const capFar = 1000 * 800 * 0.5 / 11;

/** Инварианты, которые должны выполняться для любого плана. */
function invariants(pl, ps, hs, p = P, opts = {}) {
  const byId = Object.fromEntries(ps.map(x => [x.id, x]));
  const forb = new Set(opts.forbidden || []);
  // 1. план не превышает допустимую ёмкость
  for (const id in pl.load) if (pl.load[id].known) assert.ok(pl.load[id].used <= pl.load[id].cap * (byId[id].max_load ?? p.max_load) + 1e-6, `${id} перегружен`);
  // 2. распределено + дефицит = спрос
  const demand = hs.reduce((s, h) => s + J.herdAU(h, p) * p.season_days, 0);
  const used = Object.values(pl.load).reduce((s, l) => s + l.used, 0);
  assert.ok(Math.abs(used + sum(pl.unmet) - demand) < 1, `${used} + ${sum(pl.unmet)} != ${demand}`);
  // 3. запрещённые участки и участки без данных не используются
  for (const id in pl.load) if (pl.load[id].used > 1e-6) {
    assert.ok(!forb.has(id) && !byId[id].forbidden, "использован закрытый участок " + id);
    assert.ok(byId[id].ndvi != null, "использован участок без NDVI " + id);
  }
  // 4. один ресурс не распределяется дважды: сумма по стадам = загрузке участка
  for (const id in pl.load) assert.ok(Math.abs(pl.load[id].herds.reduce((s, z) => s + z.au_days, 0) - pl.load[id].used) < 1e-6);
  // 5. нет отрицательного корма
  for (const id in pl.load) { assert.ok(pl.load[id].used >= -1e-9); assert.ok(pl.load[id].cap >= 0); }
  for (const x of Object.values(pl.unmet)) assert.ok(x > 0);
  // 6. нет ложного успеха
  if (pl.status === "feasible") { assert.equal(sum(pl.unmet), 0); assert.deepEqual(pl.violations, []); }
  if (sum(pl.unmet) > 1) assert.notEqual(pl.status, "feasible");
  assert.deepEqual(pl.violations, [], JSON.stringify(pl.violations));
  // 7. календарь без наложений и необъяснимых пропусков
  for (const h of hs) {
    const segs = pl.herdPlans[h.id];
    if (J.herdAU(h, p) === 0) { assert.deepEqual(segs, []); continue; }
    assert.equal(segs[0].from, 1);
    assert.equal(segs[segs.length - 1].to, p.season_days);
    for (let i = 1; i < segs.length; i++) assert.equal(segs[i].from, segs[i - 1].to + 1, h.id + " календарь");
    for (const s of segs) if (s.plot === null && pl.unmet[h.id]) assert.equal(s.reason, "no_feed");
  }
  // точная граница не хуже эвристики
  assert.ok(pl.bound.min_deficit_au_days <= sum(pl.unmet) + 1e-6);
}

test("инварианты на данных Кегена и на увеличенных стадах", () => {
  for (const k of [1, 2, 4, 8, 16]) {
    const hs = herds.map(h => Object.assign({}, h, { sheep: (h.sheep || 0) * k, cattle: (h.cattle || 0) * k }));
    invariants(J.plan(plots, hs), plots, hs);
  }
});

test("NDVI отсутствует: участок не считается «без корма», а исключается из плана с предупреждением", () => {
  const ps = mini({ "Д-С": { ndvi: null, series: [] } });
  const pl = J.plan(ps, [{ id: "a", sheep: 500, home: "Б-С" }]);
  assert.equal(pl.load["Д-С"].used, 0);
  assert.equal(pl.load["Д-С"].known, false);
  assert.ok(pl.warnings.some(w => w.type === "no_data_excluded" && w.plots.includes("Д-С")));
  const cur = J.current(ps, [{ id: "a", sheep: 500, home: "Д-С" }]);
  assert.equal(cur.load["Д-С"].load, null, "нагрузка неизвестна, а не 0 % и не ∞");
  assert.equal(cur.overloaded, 0);
  assert.equal(cur.unknown_used, 1);
});

test("NDVI ниже порога почвы: корм по модели 0, но статус — оценка, а не «нет данных»", () => {
  const c = J.plotCapacity({ ndvi: 0.08, pasture_ha: 500, series: [1, 2, 3, 4].map(i => ({ d: "2026-07-0" + i, v: 0.08 })) });
  assert.equal(c.forage, 0);
  assert.equal(c.status, "estimated");
});

test("площадь 0 и неверные входные значения", () => {
  assert.equal(J.plotCapacity({ ndvi: 0.4, pasture_ha: 0 }).forage, 0);
  assert.throws(() => J.plotCapacity({ ndvi: 0.4, pasture_ha: -1 }), /площадь/);
  assert.equal(J.plotCapacity({ ndvi: 1.7, pasture_ha: 10 }).status, "no_data", "NDVI вне [−1, 1] — не измерение");
  assert.throws(() => J.herdAU({ sheep: -5 }), /неотрицательн/);
  assert.throws(() => J.herdAU({ sheep: NaN }), /неотрицательн/);
  for (const bad of [{ util: 1.2 }, { util: -0.5 }, { season_days: 0 }, { season_days: -1 }, { k_ndvi: -4000 }, { k_ndvi: 1e9 }, { intake: 0 }, { au: { sheep: -1 } }])
    assert.throws(() => J.params(bad), /Неверные параметры/, JSON.stringify(bad));
  assert.throws(() => J.plan(mini(), [{ id: "a", sheep: 1 }, { id: "a", sheep: 2 }]), /повторяется/);
  assert.throws(() => J.plan(mini().concat([mini()[0]]), []), /повторяется/);
});

test("недостаточно корма: честный статус partially_feasible, причины и предложения", () => {
  const hs = [{ id: "big", sheep: 20000, home: "Б-С" }];
  const pl = J.plan(mini(), hs);
  invariants(pl, mini(), hs);
  assert.equal(pl.status, "partially_feasible");
  assert.deepEqual(pl.herds_short, ["big"]);
  assert.equal(pl.diagnostics.big.reason, "capacity");
  assert.ok(pl.suggestions.some(s => s.type === "add_water" && s.plot === "Д-Ю"), "водопой на Д-Ю откроет корм");
  assert.ok(pl.suggestions.some(s => s.type === "reduce_herd" && s.sheep > 0));
});

test("недостаточно водопоев: без воды участок не используется; водопой появляется — дефицит уменьшается", () => {
  const ps = mini({ "Д-С": { water: false, water_source: "нет" } });
  const hs = [{ id: "a", sheep: 3000, home: "Б-С" }];
  const pl = J.plan(ps, hs);
  invariants(pl, ps, hs);
  assert.equal(pl.load["Д-С"].used, 0);
  assert.equal(pl.load["Д-Ю"].used, 0);
  const eff = J.wellEffect(ps, hs, P, "Д-Ю");
  assert.ok(eff.deficit_kg_after < eff.deficit_kg_before);
  assert.deepEqual(eff.newly_accessible, ["Д-Ю"]);
  assert.ok(eff.field_checks.includes("hydrology"), "нужна проверка на местности");
  invariants(eff.after, ps.map(p => p.id === "Д-Ю" ? Object.assign({}, p, { water: true, water_status: "modeled" }) : p), hs);
});

test("водоём на карте ≠ подтверждённый водопой: при политике confirmed_only он не используется", () => {
  const hs = [{ id: "a", sheep: 1000, home: "Б-С" }];
  const any = J.plan(mini(), hs);
  assert.ok(any.load["Д-С"].used > 0);
  assert.ok(any.warnings.some(w => w.type === "water_unconfirmed"));
  const strict = J.plan(mini({ "Б-С": { water_status: "confirmed" } }), hs, P, { water_policy: "confirmed_only" });
  assert.equal(strict.load["Д-С"].used, 0);
  assert.ok(strict.load["Б-С"].used > 0);
});

test("запрещённый участок не попадает в план, даже если на нём много корма", () => {
  const hs = [{ id: "a", sheep: 1000, home: "Б-С" }];
  const opts = { forbidden: ["Д-С"] };
  const pl = J.plan(mini({ "Д-С": { pasture_ha: 50000 } }), hs, P, opts);
  invariants(pl, mini(), hs, P, opts);
  assert.equal(pl.load["Д-С"].used, 0);
  const pl2 = J.plan(mini({ "Д-С": { forbidden: true, pasture_ha: 50000 } }), hs);
  assert.equal(pl2.load["Д-С"].used, 0);
  assert.ok(!J.wells(mini({ "Д-Ю": { forbidden: true } })).some(w => w.plot === "Д-Ю"), "водопой на закрытом участке не предлагается");
});

test("дойное стадо не уходит на дальний участок, даже если там свободно", () => {
  const ps = mini({ "Б-С": { pasture_ha: 10 } });
  const hs = [{ id: "milk", cattle: 60, home: "Б-С", daily_return: true }];
  const pl = J.plan(ps, hs);
  invariants(pl, ps, hs);
  assert.equal(pl.load["Д-С"].used, 0);
  assert.ok(pl.unmet.milk > 0);
  assert.ok(pl.suggestions.some(s => s.type === "split_daily_herd"));
});

test("права пользования: хозяйство с указанными участками пасётся только на них", () => {
  const hs = [{ id: "a", sheep: 2000, home: "Б-С", allowed_plots: ["Б-С"] }, { id: "b", sheep: 300, home: "Б-С" }];
  const pl = J.plan(mini(), hs);
  invariants(pl, mini(), hs);
  for (const id of ["Д-С", "Д-Ю"]) assert.ok(!pl.load[id].herds.some(z => z.herd === "a"), "a не пасётся на " + id);
  assert.equal(pl.diagnostics.a.rights, "entered");
  assert.equal(pl.diagnostics.b.rights, "not_specified");
  assert.ok(pl.warnings.some(w => w.type === "rights_not_specified" && w.herds.includes("b")));
  assert.ok(pl.suggestions.some(s => s.type === "extend_rights"));
});

test("совместная нагрузка нескольких хозяйств на одном участке не превышает ёмкость", () => {
  const ps = mini({ "Д-Ю": { water: false } });
  const hs = Array.from({ length: 8 }, (_, i) => ({ id: "h" + i, sheep: 400, home: "Б-С" }));
  const pl = J.plan(ps, hs);
  invariants(pl, ps, hs);
  assert.ok(pl.load["Д-С"].herds.length >= 2);
  assert.ok(pl.load["Д-С"].used <= pl.load["Д-С"].cap + 1e-6);
});

test("невозможность распределения: нет ни одного допустимого участка → infeasible и объяснение", () => {
  const ps = mini({ "Б-С": { water: false, water_source: "нет" }, "Д-С": { water: false, water_source: "нет" } });
  const hs = [{ id: "a", sheep: 100, home: "Б-С" }];
  const pl = J.plan(ps, hs);
  invariants(pl, ps, hs);
  assert.equal(pl.status, "infeasible");
  assert.equal(pl.diagnostics.a.reason, "no_allowed_plots");
  assert.deepEqual(pl.diagnostics.a.excluded.no_water.sort(), ["Б-С", "Д-С", "Д-Ю"]);
  assert.deepEqual(pl.herdPlans.a, [{ plot: null, from: 1, to: P.season_days, reason: "no_feed" }]);
});

test("появление нового допустимого участка уменьшает дефицит", () => {
  const hs = [{ id: "a", sheep: 5000, home: "Б-С" }];
  const before = J.plan(mini(), hs);
  const after = J.plan(mini({ "Д-Ю": { water: true, water_status: "confirmed" } }), hs);
  assert.ok(after.deficit_kg < before.deficit_kg - 1);
});

test("сезонное ограничение: участок открыт только в окне — стадо там только в эти дни", () => {
  const hs = [{ id: "a", sheep: 1000, home: "Б-С" }];
  const opts = { windows: { "Д-С": { from: 31, to: 120 } } };
  const pl = J.plan(mini({ "Д-Ю": { water: false } }), hs, P, opts);
  invariants(pl, mini(), hs, P, opts);
  for (const s of pl.herdPlans.a) if (s.plot === "Д-С") { assert.ok(s.from >= 31 && s.to <= 120, JSON.stringify(s)); }
  const closed = J.plan(mini(), hs, P, { windows: { "Д-С": { from: 200, to: 300 }, "Д-Ю": { from: 200, to: 300 } } });
  assert.equal(closed.load["Д-С"].used, 0, "закрыт на весь сезон");
});

test("максимальная нагрузка ниже 100 % соблюдается", () => {
  const ps = mini({ "Д-С": { max_load: 0.6 } });
  const hs = [{ id: "a", sheep: 5000, home: "Б-С" }];
  const pl = J.plan(ps, hs);
  invariants(pl, ps, hs);
  assert.ok(pl.load["Д-С"].used <= capFar * 0.6 + 1e-6);
});

test("изменение коэффициента модели меняет ёмкость пропорционально (чувствительность)", () => {
  const s = J.sensitivity(mini(), [], P, "util", [0.5, 0.4]);
  assert.ok(Math.abs(s[1].capacity_au_season / s[0].capacity_au_season - 0.8) < 1e-9, "util 0.5 → 0.4 = −20 % ёмкости");
  const k = J.sensitivity(mini(), [], P, "k_ndvi", [4000, 2000]);
  assert.ok(Math.abs(k[1].capacity_au_season / k[0].capacity_au_season - 0.5) < 1e-9);
  assert.ok(J.sensitivity(mini(), [], P, "util", [1.5])[0].error, "недопустимое значение — ошибка, а не расчёт");
});

test("жадный план против точной границы (max-flow) на малых задачах", () => {
  // на простой задаче эвристика достигает оптимума
  const a = J.plan(mini(), [{ id: "a", sheep: 20000, home: "Б-С" }]);
  assert.ok(a.gap_au_days < 1, "gap " + a.gap_au_days);
  // перебор: два стада и два участка, проверяем границу вручную
  const ps = mini({ "Д-Ю": { water: false } });
  const hs = [{ id: "x", sheep: 1500, home: "Б-С", allowed_plots: ["Д-С"] }, { id: "y", sheep: 1500, home: "Б-С" }];
  const pl = J.plan(ps, hs);
  const capNear = 300 * 800 * 0.5 / 11;
  const demand = 2 * 1500 * 0.2 * 150;
  assert.ok(Math.abs(pl.bound.min_deficit_au_days - Math.max(0, demand - capFar - capNear)) < 1e-3);
  assert.ok(pl.deficit_au_days >= pl.bound.min_deficit_au_days - 1e-6);
  assert.equal(pl.optimal, false, "план не объявляется оптимальным");
  assert.equal(pl.algorithm, "greedy-heuristic-v2");
});

test("сравнение сценариев «Что если?» на одном экране", () => {
  const hs = herds.map(h => Object.assign({}, h, { sheep: (h.sheep || 0) * 6 }));
  const v = J.defaultVariants(plots, hs, P);
  const r = J.compareScenarios(plots, hs, P, v);
  const by = Object.fromEntries(r.map(x => [x.id, x]));
  for (const id of ["current", "plan", "well", "exclude", "forage", "herds", "season", "cautious", "optimistic"]) assert.ok(by[id], id);
  assert.ok(by.current.overloaded > 0 && by.plan.overloaded === 0);
  assert.ok(by.well.deficit_kg <= by.plan.deficit_kg);
  assert.ok(by.forage.deficit_kg >= by.plan.deficit_kg);
  assert.ok(by.herds.deficit_kg >= by.plan.deficit_kg);
  assert.ok(by.cautious.deficit_kg >= by.plan.deficit_kg && by.optimistic.deficit_kg <= by.plan.deficit_kg);
  assert.ok(by.current.violations.some(x => x.type === "overload"), "«как сейчас» показывает нарушенные ограничения");
  for (const x of r) if (x.type !== "current") assert.deepEqual(x.violations, []);
});

test("три сценария допущений явные и упорядоченные", () => {
  const M = J.MODEL;
  const c = M.scenarioParams(P, "cautious"), o = M.scenarioParams(P, "optimistic");
  assert.equal(c.util, 0.4); assert.equal(c.k_ndvi, 3000);
  assert.equal(o.util, 0.6); assert.equal(o.k_ndvi, 5000);
  const cap = p => J.totalCapacity(plots, p).au_season;
  assert.ok(cap(c) < cap(P) && cap(P) < cap(o));
});

test("пошаговое объяснение повторяется на калькуляторе", () => {
  const p = plots.find(x => x.id === "Б-С");
  const e = J.explainCapacity(p, P, { sheep: 600, cattle: 40 });
  const s = Object.fromEntries(e.steps.map(x => [x.key, x.value]));
  assert.equal(s.biomass, Math.round((p.ndvi - 0.1) * 4000));
  assert.equal(s.forage, Math.round(p.pasture_ha * (p.ndvi - 0.1) * 4000 * 0.5));
  assert.equal(s.sheep, 367, "участок Б-С ≈ 367 овец за сезон");
  assert.equal(s.herd_intake, (600 * 0.2 + 40) * 11);
  assert.equal(e.field_validated, false);
  assert.ok(e.limits.length >= 3);
});
