// Конфигурация модели: диапазоны, слои параметров, версии, качество снимка ≠ достоверность корма, тревоги по NDVI.
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../web/model.js");
const { loadPlots } = require("../data");

test("стандартные параметры совпадают с README и проходят проверку", () => {
  const p = M.defaults();
  assert.deepEqual([p.season_days, p.intake, p.util, p.ndvi0, p.k_ndvi, p.au.sheep], [150, 11, 0.5, 0.1, 4000, 0.2]);
  assert.ok(M.validate(p).ok);
  for (const r of M.describe(M.resolve())) { assert.ok(r.unit, r.key); assert.ok(r.source, r.key); assert.ok(r.min <= r.value && r.value <= r.max, r.key); }
});

test("проверка диапазонов: отрицательные, нулевые, больше 100 %, огромные и нечисловые значения отклоняются", () => {
  const bad = [["util", 1.01], ["util", 0], ["season_days", 0], ["season_days", -3], ["season_days", 1.5], ["intake", -1],
    ["k_ndvi", 1e7], ["ndvi0", 0.9], ["hay_price", -1], ["max_load", 1.5], ["util", "x"], ["util", NaN], ["util", Infinity]];
  for (const [k, v] of bad) { const r = M.validate({ [k]: v }); assert.equal(r.ok, false, `${k}=${v}`); assert.equal(r.errors[0].key, k); }
  assert.equal(M.validate({ au: { sheep: -0.2 } }).ok, false);
  assert.equal(M.validate({ au: { camel: 1 } }).ok, false);
  assert.equal(M.validate({ season_start: "13-01" }).ok, false);
  assert.equal(M.validate({ vegetation_type: "jungle" }).ok, false);
  assert.throws(() => M.resolve({ user: { util: 2 } }), e => e instanceof M.ParamError && e.errors[0].key === "util");
});

test("слои параметров: стандартные → откалиброванные → пользовательские, с отметкой происхождения", () => {
  const p = M.resolve({ calibrated: { values: { k_ndvi: 3100 }, source: "укос, 5 площадок", date: "2027-07-01", field: true }, user: { util: 0.4 } });
  assert.equal(p.k_ndvi, 3100); assert.equal(p.util, 0.4); assert.equal(p.intake, 11);
  assert.equal(p._origin.k_ndvi, "calibrated"); assert.equal(p._origin.util, "user"); assert.equal(p._origin.intake, "default");
  assert.equal(M.fieldValidated(p), true);
  const plot = { ndvi: 0.3, pasture_ha: 500, series: [1, 2, 3, 4].map(i => ({ d: "2026-07-0" + i, v: 0.3 })) };
  assert.equal(M.dataStatus(plot, p), "calibrated");
  const u = M.resolve({ user: { k_ndvi: 3100 } });
  assert.equal(M.fieldValidated(u), false, "пользователь ввёл число — это не полевая калибровка");
  assert.equal(M.dataStatus(plot, u), "estimated");
  assert.equal(M.MODEL_VERSION, "2.0.0");
});

test("качество спутникового измерения и достоверность корма — разные оценки", () => {
  const good = { ndvi: 0.35, pasture_ha: 300, samples: 1200, valid_fraction: 0.95, series: [1, 2, 3, 4, 5].map(i => ({ d: "2026-07-0" + i, v: 0.35 })) };
  assert.equal(M.satelliteQuality(good), "high");
  assert.equal(M.forageConfidence(good, M.resolve()), "unconfirmed", "отличный снимок не делает оценку числа овец подтверждённой");
  assert.equal(M.satelliteQuality(Object.assign({}, good, { valid_fraction: 0.4 })), "low");
  assert.equal(M.satelliteQuality(Object.assign({}, good, { series: good.series.slice(0, 2) })), "medium");
  assert.equal(M.satelliteQuality({ ndvi: null, pasture_ha: 300 }), "none");
  assert.equal(M.forageConfidence({ ndvi: null }), "none");
});

test("правило качества одинаково для участка села и для пастбища фермера", () => {
  // 5 га пастбища на 10-метровых пикселях = 500 независимых пикселей; лишняя детализация сетки не увеличивает выборку
  const farmer = { ndvi: 0.3, pasture_ha: 5, samples: 90000, valid_fraction: 0.9, obs_count: 5 };
  assert.equal(M.satelliteInputs(farmer).samples, 500);
  assert.equal(M.satelliteQuality(farmer), "high");
  const tiny = { ndvi: 0.3, pasture_ha: 0.4, samples: 9000, valid_fraction: 0.9, obs_count: 5 };
  assert.equal(M.satelliteQuality(tiny), "low", "0,4 га = 40 пикселей");
  // участки Кегена (старые данные без числа пикселей): оценка по шагу сетки 50 м
  const D = loadPlots();
  const q = D.plots.map(p => M.satelliteQuality(p));
  assert.ok(q.every(x => x === "high" || x === "medium"), q.join(","));
});

test("водопой: статусы и правило использования", () => {
  assert.equal(M.waterStatus({ water: true, water_source: "село" }), "assumed");
  assert.equal(M.waterStatus({ water: true, water_source: "водоём на карте WorldCover" }), "satellite");
  assert.equal(M.waterStatus({ water: false, water_source: "нет" }), "unknown", "нет класса воды на карте ≠ «воды нет»");
  assert.equal(M.waterStatus({ water_status: "absent" }), "absent");
  assert.equal(M.waterUsable({ water_status: "satellite" }), true);
  assert.equal(M.waterUsable({ water_status: "satellite" }, "confirmed_only"), false);
  assert.equal(M.waterUsable({ water_status: "absent" }), false);
});

test("тревога по NDVI: одно снижение — «возможно», два подряд — подтверждённое", () => {
  assert.equal(M.ndviTrend(0.30, []).kind, "first");
  assert.equal(M.ndviTrend(0.30, [0.31, 0.30, 0.31]).kind, "stable");
  assert.equal(M.ndviTrend(0.22, [0.31, 0.30, 0.31]).kind, "decline_possible");
  assert.equal(M.ndviTrend(0.21, [0.31, 0.30, 0.31, 0.23]).kind, "decline_confirmed");
  assert.equal(M.ndviTrend(0.40, [0.31, 0.30, 0.31]).kind, "rise");
  assert.equal(M.ndviTrend(0.15, []).kind, "low");
  assert.equal(M.ndviTrend(NaN, [0.3]).kind, "no_data");
});
