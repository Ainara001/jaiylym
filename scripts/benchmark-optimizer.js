/*
 * Сравнение алгоритмов распределения на воспроизводимом наборе задач (seed фиксирован).
 * Запуск: node scripts/benchmark-optimizer.js [число задач]   → таблица в Markdown (docs/BENCHMARK.md).
 * Метрики: дефицит и разрыв с точной границей, доля обеспеченности худшего хозяйства, индекс Джайна,
 * перегоны, короткие стоянки (< 14 сут), голово-км (условная работа перегона), нарушения ограничений, время.
 */
const J = require("../web/engine.js");
const { loadPlots, loadHerds } = require("../data");
const PL = require("../web/pipeline.js");

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function randomVillage(r) {
  const plots = PL.makePlots(43, 79, 4).map(p => {
    const near = p.ring === "near";
    const water = near ? r() < 0.9 : r() < 0.55;
    return Object.assign(p, { pasture_ha: Math.round(near ? 120 + r() * 230 : 600 + r() * 1700), ndvi: +(0.14 + r() * 0.36).toFixed(3),
      series: [1, 2, 3, 4].map(i => ({ d: "2026-07-0" + i, v: 0.3 })), water, water_status: water ? (near ? "assumed" : "satellite") : "unknown" });
  });
  if (r() < 0.15) plots[Math.floor(r() * 16)].ndvi = null;                 // участок без данных
  const near = plots.filter(p => p.ring === "near").map(p => p.id), all = plots.map(p => p.id);
  const n = 3 + Math.floor(r() * 13);
  const herds = Array.from({ length: n }, (_, i) => {
    const daily = r() < 0.2;
    const h = { id: "h" + i, home: near[Math.floor(r() * 8)], daily_return: daily,
      sheep: daily ? 0 : Math.round(r() * 2500), cattle: Math.round(r() * (daily ? 200 : 80)), horses: daily ? 0 : Math.round(r() * 60) };
    if (r() < 0.35) h.allowed_plots = all.filter(() => r() < 0.35).concat([h.home]);   // права: часть участков
    return h;
  });
  const windows = {};
  for (const p of plots) if (p.ring === "far" && r() < 0.2) { const a = 1 + Math.floor(r() * 60); windows[p.id] = { from: a, to: Math.min(150, a + 40 + Math.floor(r() * 60)) }; }
  return { plots, herds, opts: { windows } };
}

function run(N = 300, seed = 20261123) {
  const r = rng(seed), P = J.params();
  const cases = [];
  const D = loadPlots(), H = loadHerds();
  for (const k of [1, 2, 4, 6, 8, 12]) cases.push({ name: "Кеген ×" + k, plots: D.plots, herds: H.map(h => Object.assign({}, h, { sheep: (h.sheep || 0) * k, cattle: (h.cattle || 0) * k })), opts: {} });
  for (let i = 0; i < N; i++) cases.push(Object.assign({ name: "случайное " + (i + 1) }, randomVillage(r)));
  const rows = [];
  for (const c of cases) {
    const t0 = process.hrtime.bigint();
    const g = J.plan(c.plots, c.herds, P, c.opts);
    const t1 = process.hrtime.bigint();
    const o = J.optimize(c.plots, c.herds, P, c.opts);
    const t2 = process.hrtime.bigint();
    const mg = J.planMetrics(g, c.plots, c.herds, P), mo = J.planMetrics(o, c.plots, c.herds, P);
    const demand = g.demand_au_days || 1;
    rows.push({ name: c.name, demand, bound: o.bound.min_deficit_au_days, g: mg, o: mo, tg: Number(t1 - t0) / 1e6, to: Number(t2 - t1) / 1e6 });
  }
  return rows;
}

function summary(rows) {
  const pick = (f, sel) => rows.filter(sel || (() => true)).map(f);
  const mean = xs => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const med = xs => { const a = xs.slice().sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0; };
  const deficitCases = rows.filter(x => x.bound > 1);
  return {
    n: rows.length, deficit_cases: deficitCases.length,
    greedy_gap_cases: rows.filter(x => x.g.deficit_au_days - x.bound > 1).length,
    opt_gap_cases: rows.filter(x => x.o.deficit_au_days - x.bound > 1 + 1e-6 * x.demand).length,
    greedy_gap_share: mean(pick(x => (x.g.deficit_au_days - x.bound) / x.demand)),
    opt_gap_share: mean(pick(x => (x.o.deficit_au_days - x.bound) / x.demand)),
    min_cov_g: mean(deficitCases.map(x => x.g.min_coverage_reachable)), min_cov_o: mean(deficitCases.map(x => x.o.min_coverage_reachable)),
    zero_g: rows.filter(x => x.g.starved > 0).length, zero_o: rows.filter(x => x.o.starved > 0).length,
    starved_g: rows.reduce((a, x) => a + x.g.starved, 0), starved_o: rows.reduce((a, x) => a + x.o.starved, 0),
    jain_g: mean(deficitCases.map(x => x.g.jain)), jain_o: mean(deficitCases.map(x => x.o.jain)),
    moves_g: mean(pick(x => x.g.moves)), moves_o: mean(pick(x => x.o.moves)),
    short_g: mean(pick(x => x.g.short_stays)), short_o: mean(pick(x => x.o.short_stays)),
    km_ratio_feasible: mean(rows.filter(x => x.bound <= 1 && x.g.head_km > 0).map(x => x.o.head_km / x.g.head_km)),
    km_ratio_deficit: mean(deficitCases.filter(x => x.g.head_km > 0).map(x => x.o.head_km / x.g.head_km)),
    viol_g: rows.reduce((a, x) => a + x.g.violations, 0), viol_o: rows.reduce((a, x) => a + x.o.violations, 0),
    t_g: med(pick(x => x.tg)), t_o: med(pick(x => x.to)), t_o_max: Math.max(...pick(x => x.to)),
  };
}

if (require.main === module) {
  const N = +process.argv[2] || 300;
  const rows = run(N), s = summary(rows);
  const pc = x => (x * 100).toFixed(1) + " %", f1 = x => x.toFixed(2);
  console.log(`# Сравнение алгоритмов распределения

Набор: 6 вариантов Кегена (стада ×1…×12) и ${N} случайных сёл (seed 20261123, \`node scripts/benchmark-optimizer.js ${N}\`):
16 участков, 3–15 хозяйств, у 35 % хозяйств ограничен список участков, 20 % — дойные, у части дальних участков
сезонные окна, иногда участок без NDVI. Точная граница — максимальный поток без календарных правил.

| Метрика | Жадный (v2) | Оптимизатор (fair-optimal-v2) |
|---|---|---|
| Задач с разрывом до точной границы > 1 гол.·сут | ${s.greedy_gap_cases} из ${s.n} | ${s.opt_gap_cases} из ${s.n} |
| Средний разрыв, % потребности | ${pc(s.greedy_gap_share)} | ${pc(s.opt_gap_share)} |
| Задач с дефицитом | ${s.deficit_cases} | ${s.deficit_cases} |
| Обеспеченность худшего хозяйства (при дефиците), среднее* | ${pc(s.min_cov_g)} | ${pc(s.min_cov_o)} |
| Хозяйства совсем без корма, хотя допустимый участок есть: задач / хозяйств | ${s.zero_g} / ${s.starved_g} | ${s.zero_o} / ${s.starved_o} |
| Индекс справедливости Джайна (1 = поровну) | ${f1(s.jain_g)} | ${f1(s.jain_o)} |
| Перегонов на задачу | ${f1(s.moves_g)} | ${f1(s.moves_o)} |
| Коротких стоянок (< 14 сут) на задачу | ${f1(s.short_g)} | ${f1(s.short_o)} |
| Голово-км, оптимизатор / жадный: без дефицита | 1 | ${f1(s.km_ratio_feasible)} |
| Голово-км, оптимизатор / жадный: при дефиците | 1 | ${f1(s.km_ratio_deficit)} |
| Нарушений ограничений (всего) | ${s.viol_g} | ${s.viol_o} |
| Время, мс (медиана / максимум оптимизатора) | ${f1(s.t_g)} | ${f1(s.t_o)} / ${f1(s.t_o_max)} |

## Кеген

| Стада | Граница дефицита | Жадный: дефицит / худшее хозяйство / перегоны | Оптимизатор: дефицит / худшее хозяйство / перегоны |
|---|---|---|---|
${rows.slice(0, 6).map(x => `| ${x.name} | ${Math.round(x.bound)} | ${Math.round(x.g.deficit_au_days)} / ${pc(x.g.min_coverage)} / ${x.g.moves} | ${Math.round(x.o.deficit_au_days)} / ${pc(x.o.min_coverage)} / ${x.o.moves} |`).join("\n")}

\* Среди хозяйств, у которых по введённым данным есть хотя бы один допустимый участок (у остальных ноль неизбежен при любом алгоритме).
Голово-км — сумма «условных голов × км от домашнего участка» по используемым участкам; это мера работы перегона, а не маршрут по дорогам.
Результат относится к модели (оценке ёмкости), а не к измеренному эффекту на пастбищах.`);
}

module.exports = { run, summary, randomVillage, rng };
