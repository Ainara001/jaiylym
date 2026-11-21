// Проверка расчётов движка на реальных данных Кегена.  Запуск: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const { Jaiylym: J, loadPlots, loadHerds } = require("../data");

const D = loadPlots();
const plots = D.plots;
const herds = loadHerds();
const P = J.params();

test("условные головы: КРС 1, лошадь 1, овца/коза 0.2", () => {
  assert.equal(J.herdAU({ cattle: 10, horses: 5, sheep: 100, goats: 50 }), 10 + 5 + 20 + 10);
  assert.equal(J.herdAU({}), 0);
});

test("ёмкость участка считается по формуле из README", () => {
  const p = { ndvi: 0.3, pasture_ha: 100 };
  const c = J.plotCapacity(p);
  const biomass = (0.3 - P.ndvi0) * P.k_ndvi;                 // 800 кг/га
  assert.ok(Math.abs(c.biomass - biomass) < 1e-9);
  assert.ok(Math.abs(c.forage - 100 * biomass * P.util) < 1e-6);
  assert.ok(Math.abs(c.au_days - c.forage / P.intake) < 1e-6);
  assert.equal(J.plotCapacity({ ndvi: 0.05, pasture_ha: 100 }).forage, 0);   // NDVI ниже почвы — корма нет
  assert.equal(J.plotCapacity({ ndvi: null, pasture_ha: 100 }).forage, 0);
});

test("план не загружает ни один участок больше 100 %", () => {
  const big = herds.map(h => Object.assign({}, h, { sheep: (h.sheep || 0) * 4 }));
  for (const hs of [herds, big]) {
    const pl = J.plan(plots, hs);
    for (const id in pl.load) assert.ok(pl.load[id].used <= pl.load[id].cap + 1e-6, `${id} перегружен`);
    assert.equal(pl.overloaded, 0);
  }
});

test("план сохраняет потребность: распределено + дефицит = спрос", () => {
  const big = herds.map(h => Object.assign({}, h, { sheep: (h.sheep || 0) * 4 }));
  const pl = J.plan(plots, big);
  const demand = big.reduce((s, h) => s + J.herdAU(h) * P.season_days, 0);
  const used = Object.values(pl.load).reduce((s, l) => s + l.used, 0);
  const unmet = Object.values(pl.unmet).reduce((s, x) => s + x, 0);
  assert.ok(Math.abs(used + unmet - demand) < 1, `${used} + ${unmet} != ${demand}`);
  assert.ok(Math.abs(pl.deficit_kg - unmet * P.intake) < 1e-6);
});

test("дойные стада пасутся только на ближних участках, только у воды", () => {
  const pl = J.plan(plots, herds);
  const byId = Object.fromEntries(plots.map(p => [p.id, p]));
  for (const h of herds) for (const s of pl.herdPlans[h.id]) {
    if (!s.plot) continue;
    assert.ok(byId[s.plot].water, `${h.id} на участке без воды ${s.plot}`);
    if (h.daily_return) assert.equal(byId[s.plot].ring, "near");
  }
});

test("маршрут покрывает весь сезон без пропусков и наложений", () => {
  const pl = J.plan(plots, herds);
  for (const h of herds) {
    const segs = pl.herdPlans[h.id];
    assert.equal(segs[0].from, 1);
    assert.equal(segs[segs.length - 1].to, P.season_days);
    for (let i = 1; i < segs.length; i++) assert.equal(segs[i].from, segs[i - 1].to + 1);
  }
});

test("«как сейчас»: всё стадо на домашнем участке, перегруз считается", () => {
  const cur = J.current(plots, herds);
  const asan = herds.find(h => h.id === "asan");
  assert.ok(Math.abs(cur.load[asan.home].used - J.herdAU(asan) * P.season_days -
    herds.filter(h => h.home === asan.home && h.id !== "asan").reduce((s, h) => s + J.herdAU(h) * P.season_days, 0)) < 1e-6);
  assert.ok(cur.overloaded > 0, "на демо-данных у села есть перегруз");
});

test("водопой: в списке только участки без воды, по убыванию ёмкости, и он уменьшает дефицит", () => {
  const ws = J.wells(plots);
  assert.ok(ws.every(w => !plots.find(p => p.id === w.plot).water));
  for (let i = 1; i < ws.length; i++) assert.ok(ws[i - 1].au >= ws[i].au);
  const big = herds.map(h => Object.assign({}, h, { sheep: (h.sheep || 0) * 6 }));
  const before = J.plan(plots, big).deficit_kg;
  const withWell = plots.map(p => p.id === ws[0].plot ? Object.assign({}, p, { water: true }) : p);
  const after = J.plan(withWell, big).deficit_kg;
  assert.ok(before > 0 && after < before, `дефицит ${before} → ${after}`);
});

test("сено: перевод сухого вещества в тонны сена", () => {
  assert.ok(Math.abs(J.hayTonnes(850) - 1) < 1e-9);          // 850 кг сухого = 1 т сена при 85 %
});
