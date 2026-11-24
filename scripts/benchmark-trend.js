// Ложные тревоги и обнаружение: правило «разница первого и последнего года» против тренда с поправкой на осадки (web/trend.js).
// Синтетика: 8 лет, межгодовой шум NDVI σ = 0.02, осадки апреля–августа ≈ 380 ± 50 мм. Запуск: node scripts/benchmark-trend.js
const T = require("../web/trend.js");

function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const R = rng(20261124);
const gauss = () => Math.sqrt(-2 * Math.log(R() || 1e-12)) * Math.cos(2 * Math.PI * R());
const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const N = 1000;

const scenarios = {
  "шум без тренда (нормальные осадки)": () => {
    const rain = YEARS.map(() => 380 + 50 * gauss());
    return { rain, ndvi: rain.map(r => 0.30 + (r - 380) * 0.0004 + 0.02 * gauss()), truth: false };
  },
  "засуха без ухудшения (осадки падают, трава следует за ними)": () => {
    const rain = YEARS.map((y, i) => 420 - 18 * i + 35 * gauss());
    return { rain, ndvi: rain.map(r => 0.30 + (r - 380) * 0.0006 + 0.015 * gauss()), truth: false };
  },
  "ухудшение при обычных осадках (−0.008 NDVI в год)": () => {
    const rain = YEARS.map(() => 380 + 50 * gauss());
    return { rain, ndvi: rain.map((r, i) => 0.33 - 0.008 * i + (r - 380) * 0.0004 + 0.015 * gauss()), truth: true };
  },
};

console.log(`Синтетика: ${N} рядов по ${YEARS.length} лет на сценарий.\n`);
for (const [name, gen] of Object.entries(scenarios)) {
  let two = 0, trend = 0;
  for (let k = 0; k < N; k++) {
    const { rain, ndvi } = gen();
    if (T.twoYearAlarm(ndvi)) two++;
    if (T.seriesTrend(YEARS, ndvi, rain).verdict === "decline_unexplained") trend++;
  }
  const truth = gen().truth;
  const what = truth ? "обнаружено" : "ложных тревог";
  console.log(`${name}\n  ${what}: «разница двух лет» ${(two / N * 100).toFixed(1)} %, тренд с поправкой на осадки ${(trend / N * 100).toFixed(1)} %\n`);
}
