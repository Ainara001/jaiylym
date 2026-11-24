// Норма нагрузки (приказ МСХ № 3-3/332): таблица, область села, предел в расчёте ёмкости и плане.
const test = require("node:test");
const assert = require("node:assert/strict");
const N = require("../web/norms.js");
const J = require("../web/engine.js");
const NG = require("../web/nograze.js");
const { loadExamples, loadHerds } = require("../data");
const P = J.params();

test("таблица целиком: 253 строки, 17 областей, деградированные не мягче восстановленных", () => {
  assert.equal(N.REGIONS.length, 17);
  const all = N.REGIONS.flatMap(r => N.rows(r.id));
  assert.equal(all.length, 253);
  assert.equal(new Set(all.map(r => r.key)).size, 253, "ключи строк не повторяются");
  for (const r of all) {
    assert.ok(r.au_ha.restored >= 1.5 && r.au_ha.restored <= 25, r.key);
    assert.ok(r.au_ha.degraded >= r.au_ha.restored, r.key + ": деградированные — не меньше гектаров на голову");
    assert.ok(r.type.length > 5, r.key);
  }
});

test("значения из приказа: СКО, Алматинская; опечатка в одной ячейке не меняет норму", () => {
  assert.deepEqual(N.range("SKO"), [4.5, 7]);
  const s = N.rows("SKO").map(r => r.au_ha.restored / 5);
  assert.equal(Math.min(...s), 0.9); assert.equal(Math.max(...s), 1.4);
  const m = N.rows("ALM").find(r => /^Манжетно/.test(r.type));
  assert.deepEqual([m.au_ha.restored, m.au_ha.degraded, m.days], [4, 6, [140, 160]]);
  // Акмолинская, последняя строка: КРС 4,5 при овце 1,9 и лошади 11,4 — верное значение 9,5
  assert.equal(N.rows("AKM")[10].au_ha.restored, 9.5);
});

test("область по коду ISO и по названиям на двух языках; район или чужая страна — не область", () => {
  for (const [s, id] of [["KZ-59", "SKO"], ["Северо-Казахстанская область", "SKO"], ["Солтүстік Қазақстан облысы", "SKO"], ["Жетысуская область", "ZHE"], ["область Абай", "ABA"],
    ["Абайская область", "ABA"], ["Алматы облысы", "ALM"], ["Қарағанды облысы", "KAR"], ["Улытауская область", "ULY"], ["KZ-71", "AKM"], ["Жамбылская область", "ZHA"]])
    assert.equal(N.regionOf(s), id, s);
  for (const s of ["", null, "Абайский район", "Ошская область", "KZ-99"]) assert.equal(N.regionOf(s), null, String(s));
  for (const r of N.REGIONS) { assert.equal(N.regionOf(r.iso), r.id); assert.equal(N.regionOf(r.ru), r.id, r.ru); assert.equal(N.regionOf(r.kk), r.id, r.kk); }
});

test("тип не выбран — самая мягкая норма области; выбранный тип и состояние — точные; неверный выбор не проходит", () => {
  const soft = N.pick({ region: "SKO" });
  assert.equal(soft.soft, true); assert.equal(soft.au_ha, 4.5);
  for (const r of N.REGIONS) for (const st of N.STATES) assert.equal(N.pick({ region: r.id, state: st }).au_ha, N.range(r.id, st)[0], "мягче нет: " + r.id);
  const row = N.rows("SKO")[4], exact = N.pick({ region: "SKO", row: row.key, state: "degraded" });
  assert.equal(exact.soft, false); assert.equal(exact.au_ha, row.au_ha.degraded);
  assert.equal(N.pick(null), null); assert.equal(N.pick({ region: "XXX" }), null);
  assert.equal(N.clean({ region: "XXX" }), null);
  assert.deepEqual(N.clean({ region: "SKO", row: "ALM-01", state: "?" }), { region: "SKO", state: "restored" });
});

test("ёмкость — меньшее из оценки по снимку и нормы; без нормы расчёт прежний", () => {
  const plot = { id: "Б-С", pasture_ha: 100, ndvi: 0.65 };
  const free = J.plotCapacity(plot, P), lim = J.plotCapacity(N.attach([plot], { region: "SKO" })[0], P);
  assert.equal(free.norm, undefined); assert.equal(free.limited_by, undefined);
  assert.equal(lim.limited_by, "norm");
  assert.ok(Math.abs(lim.au_season - 100 / 4.5) < 1e-9);
  assert.ok(Math.abs(lim.sat.au_season - free.au_season) < 1e-9, "оценка по снимку сохраняется отдельно");
  assert.ok(Math.abs(lim.forage - lim.au_days * P.intake) < 1e-6);
  const dry = J.plotCapacity(N.attach([Object.assign({}, plot, { ndvi: 0.15 })], { region: "SKO" })[0], P);
  assert.equal(dry.limited_by, "satellite");
  assert.equal(dry.au_season, J.plotCapacity(Object.assign({}, plot, { ndvi: 0.15 }), P).au_season);
});

test("сезон длиннее нормативного периода ужесточает норму, короче — не смягчает", () => {
  const plot = N.attach([{ id: "Б-С", pasture_ha: 100, ndvi: 0.65 }], { region: "SKO" })[0];      // период 160–180 дней
  const at = d => J.plotCapacity(plot, J.params({ season_days: d })).norm;
  assert.equal(at(180).season_factor, 1); assert.equal(at(90).season_factor, 1);
  assert.ok(Math.abs(at(360).au_season - at(180).au_season / 2) < 1e-9);
  assert.ok(Math.abs(at(90).au_season - at(180).au_season) < 1e-9);
});

test("«Как рассчитано?»: шаги формулы — по снимку, затем норма и меньшее из двух", () => {
  const e = J.explainCapacity(N.attach([{ id: "Б-С", pasture_ha: 100, ndvi: 0.65 }], { region: "SKO" })[0], P);
  const st = Object.fromEntries(e.steps.map(s => [s.key, s]));
  assert.equal(st.norm.value, 111); assert.match(st.norm.formula, /100 \/ 0\.9 = 111/); assert.equal(st.norm.kind, "norm");
  assert.equal(st.limit.value, 111); assert.equal(st.limit.formula, `min(${st.sheep.value}, 111) = 111`);
  assert.ok(st.sheep.value > 300, "оценка по снимку показана целиком");
  assert.ok(!J.explainCapacity({ id: "Б-С", pasture_ha: 100, ndvi: 0.65 }, P).steps.some(s => s.key === "norm" || s.key === "limit"));
});

test("готовые примеры: Кеген Б-С по-прежнему 313, в Бесколе норма ограничивает все участки", () => {
  const [B, K] = loadExamples().map(D => N.attach(NG.apply(D.plots, D.nograze), { region: N.regionOf(D.village.region) }));
  const c = J.plotCapacity(K.find(p => p.id === "Б-С"), P);
  assert.equal(Math.round(c.au_season / P.au.sheep), 313); assert.equal(c.limited_by, "satellite");
  const bc = B.map(p => J.plotCapacity(p, P));
  assert.ok(bc.every(x => x.limited_by === "norm"), "в Бесколе оценка по снимку выше нормы СКО на каждом участке");
  const sum = f => bc.reduce((s, x) => s + f(x), 0);
  assert.ok(sum(x => x.sat.au_season) / sum(x => x.au_season) > 2.5, "снимок завышал больше чем в 2,5 раза");
});

test("план с нормой: ни один участок не выше предела, дефицит не меньше, чем без нормы (все области)", () => {
  const D = loadExamples()[1], H = loadHerds(), base = NG.apply(D.plots, D.nograze);
  for (const r of N.REGIONS) for (const state of N.STATES) for (const k of [1, 4]) {
    const herds = H.map(h => Object.assign({}, h, { sheep: (h.sheep || 0) * k, cattle: (h.cattle || 0) * k, horses: (h.horses || 0) * k }));
    const plots = N.attach(base, { region: r.id, state }), pl = J.solve(plots, herds, P), free = J.solve(base, herds, P);
    for (const p of plots) {
      const lim = p.pasture_ha / p.norm.au_ha * Math.min(1, p.norm.days ? p.norm.days[1] / P.season_days : 1) * P.season_days;
      assert.ok(pl.load[p.id].used <= lim + 1, `${r.id} ${state} ×${k} ${p.id}: ${pl.load[p.id].used} > ${lim}`);
    }
    assert.ok(pl.deficit_kg >= free.deficit_kg - 1, r.id);
    assert.equal(pl.violations.filter(v => v.type === "overload").length, 0);
  }
});
