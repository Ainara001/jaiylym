// Многолетний анализ (web/trend.js): Тейл — Сен, Манн — Кендалл, RESTREND, качество лет, выводы без слова «деградация».
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../web/trend.js");

const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];

test("Тейл — Сен: точный наклон на прямой и устойчивость к выбросу", () => {
  assert.equal(T.theilSen([1, 2, 3, 4], [1, 3, 5, 7]).slope, 2);
  const r = T.theilSen([1, 2, 3, 4, 5], [1, 2, 3, 40, 5]);
  assert.equal(r.slope, 1, "один выброс не меняет медиану наклонов");
});

test("Манн — Кендалл: числа Махони и точный p", () => {
  assert.deepEqual(T.mahonian(3), [1, 2, 2, 1]);
  assert.equal(T.mahonian(8).reduce((a, b) => a + b, 0), 40320);
  const up = T.mannKendall([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(up.s, 28); assert.equal(up.exact, true);
  assert.ok(Math.abs(up.p - 2 / 40320) < 1e-12, "строго монотонный ряд из 8: p = 2/8!");
  const flat = T.mannKendall([3, 1, 4, 2, 5, 3.5, 2.5, 4.5]);
  assert.ok(flat.p > 0.3, "перемешанный ряд — тренда нет, p=" + flat.p);
  const tied = T.mannKendall([1, 1, 2, 2, 3, 3]);
  assert.equal(tied.exact, false, "совпадения — нормальное приближение с поправкой");
  assert.ok(tied.p < 0.05);
});

test("RESTREND: засуха без ухудшения — снижение объясняется осадками", () => {
  const rain = [300, 280, 260, 230, 200, 180, 160, 140];
  const ndvi = rain.map(r => 0.1 + r * 0.0007);                     // трава только следует за осадками
  const t = T.seriesTrend(YEARS, ndvi, rain);
  assert.ok(t.slope_per_year < 0 && t.p < 0.05, "сырой ряд падает");
  assert.equal(t.rain.valid, true);
  assert.equal(t.verdict, "decline_rain");
});

test("RESTREND: падение при обычных осадках — снижение, не объяснённое осадками", () => {
  const rain = [250, 210, 270, 230, 260, 220, 245, 235];
  const ndvi = YEARS.map((y, i) => 0.40 - 0.012 * i + (rain[i] - 240) * 0.0004);
  assert.equal(T.seriesTrend(YEARS, ndvi, rain).verdict, "decline_unexplained");
});

test("шум без тренда и крошечный дрейф — без вывода об изменении", () => {
  const rain = [250, 210, 270, 230, 260, 220, 245, 235];
  assert.equal(T.seriesTrend(YEARS, [0.31, 0.29, 0.32, 0.30, 0.28, 0.31, 0.30, 0.29], rain).verdict, "no_change");
  const drift = YEARS.map((y, i) => 0.30 - 0.001 * i);              // монотонно, но всего −0.007 за период
  assert.equal(T.seriesTrend(YEARS, drift, null).verdict, "no_change");
});

test("рост; меньше 5 лет — вывода нет", () => {
  assert.equal(T.seriesTrend(YEARS, YEARS.map((y, i) => 0.25 + 0.01 * i), null).verdict, "increase");
  assert.equal(T.seriesTrend([2023, 2024, 2025, 2026], [0.3, 0.29, 0.28, 0.27], null).verdict, "few_years");
});

test("влажные годы скрыли снижение: остатки падают — снижение, не объяснённое осадками", () => {
  const rain = [200, 265, 195, 250, 225, 275, 235, 285];
  const ndvi = YEARS.map((y, i) => +(0.30 + (rain[i] - 240) * 0.0009 - 0.010 * i).toFixed(4));
  const t = T.seriesTrend(YEARS, ndvi, rain);
  assert.ok(t.p > 0.05, "в сыром ряду тренда не видно");
  assert.ok(t.resid.p < 0.05 && t.resid.slope_per_year < 0, "после учёта осадков — падение");
  assert.equal(t.verdict, "decline_unexplained");
});

test("ограничение: осадки растут вместе с годами — отделить их нельзя, RESTREND не применяется", () => {
  const rain = [180, 190, 205, 215, 230, 245, 255, 270];
  const ndvi = YEARS.map((y, i) => 0.30 + (rain[i] - 180) * 0.0009 - 0.012 * i);
  const t = T.seriesTrend(YEARS, ndvi, rain);
  assert.equal(t.rain.valid, false);
  assert.equal(t.resid, null);
});

const season = (year, n, ndvi, extra = {}) => Object.assign({ year, status: "measured", dates: Array.from({ length: n }, (_, i) => `${year}-07-0${i + 1}`),
  plots: [{ id: "Б-С", ndvi, valid_fraction: 0.9 }, { id: "Д-С", ndvi: ndvi + 0.05, valid_fraction: 0.9 }] }, extra);

test("качество лет: мало дат и расширенное окно не участвуют; ряд села — медиана участков", () => {
  const seasons = YEARS.map((y, i) => season(y, 5, 0.30 - 0.01 * i));
  seasons[2] = season(2021, 2, 0.9);                                          // 2 даты — выброс не должен попасть
  seasons[4] = season(2023, 6, 0.9, { window: { from: "05-15", to: "09-15", widened: true } });
  const precip = Object.fromEntries(YEARS.map(y => [y, 240]));
  const a = T.analyze(seasons, precip);
  const by = Object.fromEntries(a.years.map(y => [y.year, y]));
  assert.equal(by[2021].ok, false); assert.equal(by[2021].reason, "few_dates");
  assert.equal(by[2023].ok, false); assert.equal(by[2023].reason, "window");
  assert.equal(by[2019].ndvi_median, 0.325, "медиана двух участков");
  assert.equal(a.village.n, 6);
  assert.equal(a.village.verdict, "decline_unexplained", "при ровных осадках падение не объясняется ими");
  assert.equal(a.plots["Б-С"].n, 6);
});

test("старое правило «разница двух лет» ложно тревожит в засуху, RESTREND — нет", () => {
  const rain = [300, 280, 260, 230, 200, 180, 160, 140];
  const ndvi = rain.map(r => 0.1 + r * 0.0007);
  assert.equal(T.twoYearAlarm(ndvi), true);
  assert.notEqual(T.seriesTrend(YEARS, ndvi, rain).verdict, "decline_unexplained");
});
