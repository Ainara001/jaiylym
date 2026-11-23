/*
 * Jaiylym — движок расчёта нагрузки и распределения пастбищ.
 * Один файл для веб-карты (браузер) и Telegram-бота (Node).
 * Без нейросетей: прозрачные формулы, которые можно проверить руками (см. explainCapacity и docs/METHODOLOGY.md).
 *
 * 1) Корм на участке (кг сухого вещества) — ОЦЕНКА МОДЕЛИ, а не измерение:
 *      биомасса_кг_га = max(0, NDVI − ndvi0) × k_ndvi        ← k_ndvi не откалиброван, нужен укос 1 м²
 *      доступный_корм = пастбище_га × биомасса × util × forage_factor
 * 2) Ёмкость участка в «голово-днях» условных голов (УГ):
 *      ёмкость = доступный_корм / intake                         ← 1 УГ ≈ 11 кг сухого корма в сутки
 * 3) Стадо в УГ: КРС 1, лошадь 1, овца/коза 0.2 (коэффициенты настраиваются).
 *
 * Нет NDVI → ёмкость НЕИЗВЕСТНА (status "no_data"), а не «корма нет». Такой участок не попадает в план.
 *
 * План — жадная эвристика (не оптимизатор). Для проверки качества считается точная нижняя граница
 * дефицита задачи без календарных деталей (максимальный поток, см. exactBound). Критерий: минимум
 * неудовлетворённой потребности в голово-днях при соблюдении всех ограничений.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./model.js"));
  else root.Jaiylym = factory(root.JaiylymModel);
})(typeof self !== "undefined" ? self : this, function (M) {
  "use strict";
  if (!M) throw new Error("Сначала подключите web/model.js");

  const DIRS = ["С", "СВ", "В", "ЮВ", "Ю", "ЮЗ", "З", "СЗ"];
  const DEFAULTS = M.defaults();
  const ALGORITHM = "greedy-heuristic-v2";
  const EPS = 0.5;                       // голово-дней: меньше — считаем нулём (округление)

  /** Параметры модели: стандартные + переданные. Неверные значения — ParamError, а не тихая подмена. */
  function params(p) {
    if (p && p._origin) return p;          // уже собраны и проверены
    return M.resolve({ user: p || null });
  }

  const SPECIES = ["sheep", "goats", "cattle", "horses"];
  function herdAU(h, p) {
    p = params(p);
    let s = 0;
    for (const k of SPECIES) {
      const v = h[k];
      if (v == null || v === "") continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
        throw Object.assign(new Error(`поголовье «${k}» должно быть неотрицательным числом (получено ${v})`), { code: 400 });
      s += v * p.au[k];
    }
    return s;
  }

  /**
   * Кормовая ёмкость участка. Возвращает и числа, и происхождение:
   *   status: no_data | insufficient_quality | estimated | calibrated
   *   quality: качество спутникового измерения (high|medium|low|none)
   *   forage_confidence: достоверность перевода NDVI в корм (none|unconfirmed|calibrated)
   * При no_data числа = null: ёмкость неизвестна.
   */
  function plotCapacity(plot, p) {
    p = params(p);
    const pasture = +plot.pasture_ha;
    if (!Number.isFinite(pasture) || pasture < 0) throw Object.assign(new Error(`площадь пастбища участка ${plot.id || ""} неверна: ${plot.pasture_ha}`), { code: 400 });
    let ndvi = plot.ndvi;
    const badNdvi = ndvi != null && (!Number.isFinite(+ndvi) || +ndvi < -1 || +ndvi > 1);
    if (badNdvi) ndvi = null;
    const view = badNdvi ? Object.assign({}, plot, { ndvi: null }) : plot;
    const status = M.dataStatus(view, p);
    const quality = M.satelliteQuality(view);
    const fc = M.forageConfidence(view, p);
    if (status === "no_data")
      return { status, quality, forage_confidence: fc, known: false, biomass: null, forage: null, au_days: null, au_season: null,
        warning: badNdvi ? "invalid_ndvi" : "no_ndvi" };
    const biomass = Math.max(0, +ndvi - p.ndvi0) * p.k_ndvi;            // кг/га — расчёт по формуле
    const forage = pasture * biomass * p.util * p.forage_factor;        // кг — оценка модели
    return { status, quality, forage_confidence: fc, known: true, biomass, forage, au_days: forage / p.intake, au_season: forage / p.intake / p.season_days };
  }

  /** Пошаговый расчёт для кнопки «Как рассчитано?» — его можно повторить на калькуляторе. */
  function explainCapacity(plot, p, herd) {
    p = params(p);
    const c = plotCapacity(plot, p);
    const steps = [];
    const r = (x, d = 0) => (x == null ? null : +(+x).toFixed(d));
    steps.push({ key: "area", value: r(plot.pasture_ha, 1), unit: "га", kind: "sat", formula: "пастбищный покров ESA WorldCover внутри участка" });
    steps.push({ key: "ndvi", value: plot.ndvi == null ? null : r(plot.ndvi, 3), unit: "NDVI", kind: "sat", formula: "медиана безоблачных снимков Sentinel-2" });
    if (c.known) {
      steps.push({ key: "biomass", value: r(c.biomass), unit: "кг СВ/га", kind: "model",
        formula: `max(0, ${r(plot.ndvi, 3)} − ${p.ndvi0}) × ${p.k_ndvi} = ${r(c.biomass)}` });
      steps.push({ key: "forage", value: r(c.forage), unit: "кг СВ", kind: "model",
        formula: `${r(plot.pasture_ha, 1)} × ${r(c.biomass)} × ${p.util}${p.forage_factor !== 1 ? " × " + p.forage_factor : ""} = ${r(c.forage)}` });
      steps.push({ key: "au_days", value: r(c.au_days), unit: "усл. гол.·сут", kind: "model", formula: `${r(c.forage)} / ${p.intake} = ${r(c.au_days)}` });
      steps.push({ key: "au_season", value: r(c.au_season, 1), unit: "усл. гол. на сезон", kind: "model", formula: `${r(c.au_days)} / ${p.season_days} = ${r(c.au_season, 1)}` });
      steps.push({ key: "sheep", value: r(c.au_season / p.au.sheep), unit: "овец на сезон", kind: "model", formula: `${r(c.au_season, 1)} / ${p.au.sheep} = ${r(c.au_season / p.au.sheep)}` });
      if (herd) {
        const au = herdAU(herd, p), need = au * p.intake;
        steps.push({ key: "herd_intake", value: r(need), unit: "кг СВ/сут", kind: "model", formula: `${r(au, 1)} усл. гол. × ${p.intake} = ${r(need)}` });
        steps.push({ key: "days", value: au > 0 ? r(c.forage / need) : null, unit: "сут", kind: "model", formula: au > 0 ? `${r(c.forage)} / ${r(need)} = ${r(c.forage / need)}` : "стадо пустое" });
      }
    }
    const limits = [
      "NDVI — измерение спутника; биомасса, корм и число голов — оценки модели.",
      "Коэффициент k_ndvi не откалиброван полевым укосом: реальная ёмкость может отличаться в разы.",
      "Модель не учитывает поедаемость видов трав, отрастание за сезон, засуху и вытаптывание.",
      "Наличие травы не означает права выпаса и доступа к воде.",
    ];
    if (!c.known) limits.unshift("NDVI для участка нет — ёмкость неизвестна, участок не используется в плане.");
    if (c.status === "insufficient_quality") limits.unshift("Мало безоблачных снимков или пикселей — NDVI ненадёжен.");
    return { capacity: c, steps, params: { ndvi0: p.ndvi0, k_ndvi: p.k_ndvi, util: p.util, intake: p.intake, season_days: p.season_days, au_sheep: p.au.sheep, forage_factor: p.forage_factor },
      model_version: M.MODEL_VERSION, field_validated: M.fieldValidated(p), formula: M.FORMULA, limits };
  }

  function xy(plot) {
    const a = DIRS.indexOf(plot.dir) * Math.PI / 4;
    return [(plot.dist_km || 0) * Math.sin(a), (plot.dist_km || 0) * Math.cos(a)];
  }
  function dist(a, b) {
    const [x1, y1] = xy(a), [x2, y2] = xy(b);
    return Math.hypot(x1 - x2, y1 - y2);
  }

  // ---------- подготовка участков: все ограничения в одном месте ----------
  function forbiddenSet(opts) { return new Set((opts && opts.forbidden) || []); }
  function windowOf(pl, opts, season) {
    const w = (opts && opts.windows && opts.windows[pl.id]) || pl.window;
    if (!w) return [1, season];
    const a = Math.max(1, Math.round(+w.from || 1)), b = Math.min(season, Math.round(+w.to || season));
    return b >= a ? [a, b] : null;                     // null — участок закрыт на весь период расчёта
  }
  function prepare(plots, p, opts) {
    opts = opts || {};
    const forb = forbiddenSet(opts);
    const ids = new Set();
    return plots.map(pl => {
      if (ids.has(pl.id)) throw Object.assign(new Error("участок повторяется: " + pl.id), { code: 400 });
      ids.add(pl.id);
      const c = plotCapacity(pl, p);
      const maxLoad = pl.max_load != null ? Math.min(1, Math.max(0, +pl.max_load)) : p.max_load;
      const win = windowOf(pl, opts, p.season_days);
      const reasons = [];
      if (pl.forbidden || forb.has(pl.id)) reasons.push("forbidden");
      if (!c.known) reasons.push("no_data");
      else if (c.status === "insufficient_quality" && opts.exclude_low_quality) reasons.push("low_quality");
      if (!M.waterUsable(pl, opts.water_policy)) reasons.push("no_water");
      if (!win) reasons.push("closed");
      return { pl, id: pl.id, ring: pl.ring, c, cap: c.known ? c.au_days * maxLoad : 0, trueCap: c.known ? c.au_days : null,
        maxLoad, win, reasons, water: M.waterStatus(pl) };
    });
  }
  function herdReasons(h, q) {
    const r = q.reasons.slice();
    const allowed = Array.isArray(h.allowed_plots) && h.allowed_plots.length ? h.allowed_plots : null;
    if (allowed && !allowed.includes(q.id)) r.push("not_allowed");
    if (h.daily_return && q.ring !== "near") r.push("daily_far");
    return r;
  }
  const rightsOf = h => (Array.isArray(h.allowed_plots) && h.allowed_plots.length ? "entered" : "not_specified");

  function emptyLoad(prep) {
    const load = {};
    for (const q of prep) load[q.id] = { cap: q.known === false ? 0 : (q.trueCap == null ? 0 : q.trueCap), known: q.trueCap != null,
      limit: q.cap, used: 0, load: 0, herds: [], status: q.c.status, quality: q.c.quality };
    return load;
  }
  function finishLoad(load, p) {
    let overKg = 0, over = 0, unknownUsed = 0;
    for (const id in load) {
      const l = load[id];
      if (!l.known) {                                   // ёмкость неизвестна: не «перегруз», а «нет данных»
        l.load = l.used > 0 ? null : 0;
        if (l.used > 0) unknownUsed++;
        continue;
      }
      l.load = l.cap > 0 ? l.used / l.cap : (l.used > 0 ? Infinity : 0);
      const excess = Math.max(0, l.used - l.cap) * p.intake;
      if (excess > 0.5) over++;
      overKg += excess;
    }
    return { overloaded: over, excess_kg: overKg, unknown_used: unknownUsed };
  }

  /** «Как сейчас»: каждое стадо весь сезон пасётся на своём ближнем участке у села (описание, не план). */
  function current(plots, herds, p, opts) {
    p = params(p);
    const prep = prepare(plots, p, opts);
    const load = emptyLoad(prep);
    for (const h of herds) {
      const need = herdAU(h, p) * p.season_days;
      const l = load[h.home];
      if (!l) continue;
      l.used += need;
      l.herds.push({ herd: h.id, au_days: need });
    }
    const s = finishLoad(load, p);
    const res = Object.assign({ load, deficit_kg: s.excess_kg, kind: "current" }, s);
    res.violations = checkLoad(prep, herds, load, p, { describeOnly: true });
    return res;
  }

  /**
   * План Jaiylym. Жадное распределение «голово-дней» (эвристика, не гарантирует оптимум):
   *  - дойные стада (возвращаются в село каждый вечер) — только ближние участки, распределяются первыми;
   *  - остальные — от малых к большим, сначала на дальние участки с водой (ближайшие к дому),
   *    ближние — только если дальних не хватило;
   *  - участок используется, только если: есть NDVI, есть пригодный по введённым данным водопой, он не
   *    запрещён, открыт в период расчёта и разрешён этому хозяйству (если хозяйство указало свои участки);
   *  - ни один участок не загружается больше max_load (по умолчанию 100 %) ёмкости;
   *  - что не поместилось — дефицит с объяснением причин.
   * opts: { forbidden:[id], windows:{id:{from,to}}, water_policy:"any_indicated"|"confirmed_only", exclude_low_quality:bool }
   */
  function plan(plots, herds, p, opts) {
    p = params(p);
    opts = opts || {};
    const prep = prepare(plots, p, opts);
    const byId = Object.fromEntries(prep.map(q => [q.id, q]));
    const load = emptyLoad(prep);
    const ids = new Set();
    for (const h of herds) { if (ids.has(h.id)) throw Object.assign(new Error("стадо повторяется: " + h.id), { code: 400 }); ids.add(h.id); }
    const order = herds.slice().sort((a, b) =>
      (b.daily_return ? 1 : 0) - (a.daily_return ? 1 : 0) || herdAU(a, p) - herdAU(b, p));
    const herdPlans = {}, unmet = {}, coverage = {}, diagnostics = {};
    const alloc = {};                       // alloc[herd][plot] = голово-дни
    const remaining = q => Math.max(0, q.cap - load[q.id].used);

    for (const h of order) {
      const au = herdAU(h, p);
      alloc[h.id] = {};
      const excluded = {};
      for (const q of prep) for (const r of herdReasons(h, q)) (excluded[r] = excluded[r] || []).push(q.id);
      if (au <= 0) { herdPlans[h.id] = []; coverage[h.id] = p.season_days; diagnostics[h.id] = { rights: rightsOf(h), excluded, candidates: [] }; continue; }
      let need = au * p.season_days;
      const homeQ = byId[h.home] || prep[0];
      const home = homeQ ? homeQ.pl : { dir: "С", dist_km: 0 };
      const farFirst = q => (h.daily_return || q.ring === "far" ? 0 : 1);
      const allowed = prep.filter(q => herdReasons(h, q).length === 0)
        .sort((a, b) => farFirst(a) - farFirst(b) || dist(home, a.pl) - dist(home, b.pl));
      const maxFor = q => { const w = q.win; return au * (w[1] - w[0] + 1) - (alloc[h.id][q.id] || 0); };
      const take = (q, x) => {
        const l = load[q.id];
        l.used += x;
        const hh = l.herds.find(z => z.herd === h.id); if (hh) hh.au_days += x; else l.herds.push({ herd: h.id, au_days: x });
        alloc[h.id][q.id] = (alloc[h.id][q.id] || 0) + x;
        need -= x;
      };
      // 1) крупные куски: стадо целиком хотя бы на 2 недели (меньше — не гоняем)
      for (const q of allowed) {
        if (need <= EPS) break;
        const x = Math.min(need, remaining(q), Math.max(0, maxFor(q)));
        if (x < au && x < need) continue;
        if (x < need && x < au * 14) continue;
        take(q, x);
      }
      // 2) если корма не хватило — добираем остатки со всех разрешённых участков
      //    (большое стадо в жизни делят на отары; без этого шага план мог оказаться хуже «как сейчас»)
      for (const q of allowed) {
        if (need <= EPS) break;
        const x = Math.min(need, remaining(q), Math.max(0, maxFor(q)));
        if (x > EPS) take(q, x);
      }
      // 3) календарь; дни, которые не удалось поставить в окна участков, возвращаются в дефицит
      const segs = Object.entries(alloc[h.id]).map(([id, x]) => ({ plot: id, ring: byId[id].ring, days: x / au, au_days: x, window: byId[id].win }));
      const sch = schedule(segs, p.season_days);
      for (const u of sch.unplaced) {
        const x = u.days * au;
        load[u.plot].used -= x;
        const hh = load[u.plot].herds.find(z => z.herd === h.id); hh.au_days -= x;
        alloc[h.id][u.plot] -= x;
        need += x;
      }
      for (const id in load) load[id].herds = load[id].herds.filter(z => z.au_days > 1e-6);
      herdPlans[h.id] = sch.segments.map(s => (s.plot === null && need > EPS ? Object.assign(s, { reason: "no_feed" }) : s));
      const full = allowed.filter(q => remaining(q) <= EPS).map(q => q.id);
      diagnostics[h.id] = { rights: rightsOf(h), candidates: allowed.map(q => q.id), full, excluded, calendar_conflict: sch.unplaced.length > 0 };
      if (need > EPS) {
        unmet[h.id] = need;
        diagnostics[h.id].reason = !allowed.length ? "no_allowed_plots" : sch.unplaced.length ? "calendar" : "capacity";
      }
      coverage[h.id] = Math.max(0, p.season_days - Math.max(0, need) / au);   // на сколько дней сезона хватает корма
    }
    const s = finishLoad(load, p);
    const deficitAUd = Object.values(unmet).reduce((a, x) => a + x, 0);
    const demand = herds.reduce((a, h) => a + herdAU(h, p) * p.season_days, 0);
    const allocated = Object.values(load).reduce((a, l) => a + l.used, 0);
    const status = demand <= EPS ? "no_demand" : deficitAUd <= EPS ? "feasible" : allocated <= EPS ? "infeasible" : "partially_feasible";
    const herdsFull = herds.filter(h => !unmet[h.id]).map(h => h.id), herdsShort = herds.filter(h => unmet[h.id]).map(h => h.id);
    const res = Object.assign({ load, herdPlans, unmet, coverage, deficit_kg: deficitAUd * p.intake, deficit_au_days: deficitAUd,
      demand_au_days: demand, allocated_au_days: allocated, status, herds_full: herdsFull, herds_short: herdsShort,
      diagnostics, algorithm: ALGORITHM, optimal: false, kind: "plan" }, s);
    res.warnings = planWarnings(prep, res, herds);
    res.suggestions = suggestions(plots, herds, p, opts, prep, res);
    res.violations = checkLoad(prep, herds, load, p, { plan: res });
    res.bound = exactBound(plots, herds, p, opts);
    res.gap_au_days = Math.max(0, deficitAUd - res.bound.min_deficit_au_days);
    return res;
  }

  /**
   * Раскладка по календарю: весна — ближние, лето — дальние (жайлау), осень — снова ближние.
   * Сегменты с окнами (участок открыт только с дня a по день b) ставятся только в своё окно.
   * Возвращает непрерывный календарь 1..season без наложений (дни без корма — plot: null) и то, что не поместилось.
   */
  function schedule(segs, season) {
    const near = segs.filter(s => s.ring === "near"), far = segs.filter(s => s.ring !== "near");
    const w = s => s.window || [1, season];
    let parts;
    if (near.length && far.length) {
      parts = [
        ...near.map(s => ({ plot: s.plot, days: s.days / 2, window: w(s) })),
        ...far.map(s => ({ plot: s.plot, days: s.days, window: w(s) })),
        ...near.slice().reverse().map(s => ({ plot: s.plot, days: s.days / 2, window: w(s) })),
      ];
    } else parts = segs.map(s => ({ plot: s.plot, days: s.days, window: w(s) }));
    let free = [[0, season]];
    const pieces = [], unplaced = {};
    for (const part of parts) {
      let rest = part.days;
      const a = part.window[0] - 1, b = part.window[1];
      const next = [];
      for (const [f0, f1] of free) {
        const s0 = Math.max(f0, a), s1 = Math.min(f1, b);
        if (rest > 1e-9 && s1 - s0 > 1e-9) {
          const take = Math.min(rest, s1 - s0);
          pieces.push({ plot: part.plot, s: s0, e: s0 + take });
          rest -= take;
          if (s0 > f0) next.push([f0, s0]);
          if (s0 + take < f1) next.push([s0 + take, f1]);
        } else next.push([f0, f1]);
      }
      free = next.sort((x, y) => x[0] - y[0]);
      if (rest > 1e-6) unplaced[part.plot] = (unplaced[part.plot] || 0) + rest;
    }
    pieces.sort((x, y) => x.s - y.s);
    const out = [];
    for (const pc of pieces) {
      const from = Math.round(pc.s) + 1, to = Math.round(pc.e);
      if (to < from) continue;
      const last = out[out.length - 1];
      if (last && last.plot === pc.plot && last.to + 1 >= from) { last.to = Math.max(last.to, to); continue; }
      out.push({ plot: pc.plot, from, to });
    }
    // дыры (корма нет или участки закрыты) — явные сегменты без участка
    const full = [];
    let day = 1;
    for (const s of out) {
      const from = Math.max(s.from, day);
      if (from > day) full.push({ plot: null, from: day, to: from - 1 });
      if (s.to >= from) full.push({ plot: s.plot, from, to: s.to });
      day = Math.max(day, s.to + 1);
    }
    if (day <= season) full.push({ plot: null, from: day, to: season });
    if (!full.length) full.push({ plot: null, from: 1, to: season });
    return { segments: full, unplaced: Object.entries(unplaced).map(([plot, days]) => ({ plot, days })) };
  }

  // ---------- проверка ограничений (инварианты плана) ----------
  function checkLoad(prep, herds, load, p, { plan: res, describeOnly } = {}) {
    const v = [];
    const byId = Object.fromEntries(prep.map(q => [q.id, q]));
    for (const q of prep) {
      const l = load[q.id];
      if (l.used <= 1e-6) continue;
      if (l.known && l.used > (describeOnly ? l.cap : q.cap) + 1e-6) v.push({ type: "overload", plot: q.id, load: l.load });
      if (!l.known) v.push({ type: "unknown_capacity", plot: q.id });
      if (q.reasons.includes("forbidden")) v.push({ type: "forbidden_used", plot: q.id });
      if (!describeOnly && q.reasons.includes("no_water")) v.push({ type: "no_water_used", plot: q.id });
      for (const z of l.herds) {
        const h = herds.find(x => x.id === z.herd); if (!h) continue;
        const r = herdReasons(h, q);
        if (r.includes("not_allowed")) v.push({ type: "not_allowed_used", plot: q.id, herd: h.id });
        if (r.includes("daily_far")) v.push({ type: "daily_far", plot: q.id, herd: h.id });
      }
      if (l.used < -1e-6) v.push({ type: "negative", plot: q.id });
    }
    if (res) {
      const unmetSum = Object.values(res.unmet).reduce((a, x) => a + x, 0);
      if (Math.abs(res.allocated_au_days + unmetSum - res.demand_au_days) > 1) v.push({ type: "conservation", diff: res.allocated_au_days + unmetSum - res.demand_au_days });
      for (const h of herds) {
        const segs = res.herdPlans[h.id] || [];
        for (let i = 0; i < segs.length; i++) {
          if (i === 0 && segs[0].from !== 1) v.push({ type: "calendar_gap", herd: h.id });
          if (i > 0 && segs[i].from !== segs[i - 1].to + 1) v.push({ type: "calendar_overlap_or_gap", herd: h.id });
          const s = segs[i];
          if (s.plot && byId[s.plot] && byId[s.plot].win && (s.from < byId[s.plot].win[0] || s.to > byId[s.plot].win[1])) v.push({ type: "window", herd: h.id, plot: s.plot });
        }
        if (segs.length && segs[segs.length - 1].to !== p.season_days) v.push({ type: "calendar_end", herd: h.id });
      }
    }
    return v;
  }

  function planWarnings(prep, res, herds) {
    const w = [];
    const used = id => res.load[id].used > EPS;
    const noData = prep.filter(q => q.reasons.includes("no_data")).map(q => q.id);
    if (noData.length) w.push({ type: "no_data_excluded", plots: noData });
    const low = prep.filter(q => q.c.status === "insufficient_quality" && used(q.id)).map(q => q.id);
    if (low.length) w.push({ type: "low_quality_used", plots: low });
    const water = prep.filter(q => used(q.id) && q.water !== "confirmed").map(q => ({ plot: q.id, status: q.water }));
    if (water.length) w.push({ type: "water_unconfirmed", plots: water });
    const rights = herds.filter(h => rightsOf(h) === "not_specified").map(h => h.id);
    if (rights.length) w.push({ type: "rights_not_specified", herds: rights });
    if (herds.some(h => rightsOf(h) === "entered")) w.push({ type: "rights_user_entered" });
    w.push({ type: "forage_unconfirmed" });
    return w;
  }

  function suggestions(plots, herds, p, opts, prep, res) {
    if (res.status === "feasible" || res.status === "no_demand") return [];
    const out = [];
    const short = herds.filter(h => res.unmet[h.id]);
    const deficit = res.deficit_au_days;
    // водопой: участки, которые мешает использовать только отсутствие подтверждённой воды
    const wellCand = prep.filter(q => q.reasons.length === 1 && q.reasons[0] === "no_water" && short.some(h => !herdReasons(h, q).some(r => r !== "no_water")));
    for (const q of wellCand.sort((a, b) => b.cap - a.cap).slice(0, 2))
      out.push({ type: "add_water", plot: q.id, au_days: Math.min(q.cap, deficit) });
    const noData = prep.filter(q => q.reasons.includes("no_data") && !q.reasons.includes("forbidden"));
    if (noData.length) out.push({ type: "check_data", plots: noData.map(q => q.id) });
    const rightsBlocked = prep.filter(q => q.cap > EPS && q.reasons.length === 0 && res.load[q.id].used < q.cap - EPS &&
      short.some(h => herdReasons(h, q).includes("not_allowed")));
    if (rightsBlocked.length) out.push({ type: "extend_rights", plots: rightsBlocked.map(q => q.id) });
    if (short.some(h => h.daily_return)) out.push({ type: "split_daily_herd" });
    out.push({ type: "reduce_herd", au: deficit / p.season_days, sheep: deficit / p.season_days / p.au.sheep });
    out.push({ type: "hay", tonnes: hayTonnes(deficit * p.intake, p) });
    return out;
  }

  /**
   * Точная нижняя граница дефицита (максимальный поток «стада → участки»).
   * Ограничения те же: права, запреты, вода, данные, ёмкость × max_load, длина окна участка, дойные у села.
   * Не учитывает правило «не меньше 2 недель на участке» и порядок по календарю — поэтому это граница,
   * которую жадный план может не достигать. Разница (gap) показывает цену эвристики.
   */
  function exactBound(plots, herds, p, opts) {
    p = params(p);
    const prep = prepare(plots, p, opts);
    const H = herds.map(h => ({ h, au: herdAU(h, p) })).filter(x => x.au > 0);
    const nH = H.length, nP = prep.length, S = 0, T = nH + nP + 1, N = T + 1;
    const g = Array.from({ length: N }, () => []);
    const add = (u, v, c) => { g[u].push({ v, c, r: g[v].length }); g[v].push({ v: u, c: 0, r: g[u].length - 1 }); };
    let demand = 0;
    H.forEach((x, i) => {
      const d = x.au * p.season_days; demand += d;
      add(S, 1 + i, d);
      prep.forEach((q, j) => { if (herdReasons(x.h, q).length === 0 && q.cap > 0) add(1 + i, 1 + nH + j, x.au * (q.win[1] - q.win[0] + 1)); });
    });
    prep.forEach((q, j) => { if (q.cap > 0) add(1 + nH + j, T, q.cap); });
    // Dinic
    let flow = 0;
    const level = new Array(N), it = new Array(N);
    const bfs = () => {
      level.fill(-1); level[S] = 0; const qu = [S];
      while (qu.length) { const u = qu.shift(); for (const e of g[u]) if (e.c > 1e-9 && level[e.v] < 0) { level[e.v] = level[u] + 1; qu.push(e.v); } }
      return level[T] >= 0;
    };
    const dfs = (u, f) => {
      if (u === T) return f;
      for (; it[u] < g[u].length; it[u]++) {
        const e = g[u][it[u]];
        if (e.c > 1e-9 && level[e.v] === level[u] + 1) {
          const d = dfs(e.v, Math.min(f, e.c));
          if (d > 1e-9) { e.c -= d; g[e.v][e.r].c += d; return d; }
        }
      }
      return 0;
    };
    while (bfs()) { it.fill(0); let f; while ((f = dfs(S, Infinity)) > 1e-9) flow += f; }
    return { method: "max-flow (Dinic), без календарных правил", demand_au_days: demand, max_allocated_au_days: flow, min_deficit_au_days: Math.max(0, demand - flow) };
  }

  /** Где новый водопой откроет больше всего корма (только участки с известной ёмкостью и без запрета). */
  function wells(plots, p, opts) {
    p = params(p);
    const prep = prepare(plots, p, opts);
    return prep
      .filter(q => q.reasons.includes("no_water") && q.c.known && !q.reasons.includes("forbidden"))
      .map(q => ({ plot: q.id, au: q.c.au_season, sheep: q.c.au_season / p.au.sheep, forage_t: q.c.forage / 1000, water_status: q.water, other_limits: q.reasons.filter(r => r !== "no_water") }))
      .sort((a, b) => b.au - a.au);
  }

  /** Моделирование водопоя на участке: что изменится в плане. Не рекомендация строить скважину. */
  function wellEffect(plots, herds, p, plotId, opts) {
    p = params(p);
    const before = plan(plots, herds, p, opts);
    const withWell = plots.map(pl => (pl.id === plotId ? Object.assign({}, pl, { water: true, water_status: "modeled", water_source: "смоделированный водопой" }) : pl));
    const after = plan(withWell, herds, p, opts);
    const prepA = prepare(withWell, p, opts);
    const q = prepA.find(x => x.id === plotId);
    return {
      plot: plotId, before, after,
      newly_accessible: q && q.reasons.length === 0 ? [plotId] : [],
      remaining_limits: q ? q.reasons : ["unknown_plot"],
      deficit_kg_before: before.deficit_kg, deficit_kg_after: after.deficit_kg,
      overloaded_before: before.overloaded, overloaded_after: after.overloaded,
      field_checks: ["hydrology", "water_quality", "land_rights", "access_road", "cost"],
    };
  }

  // ---------- «Что если?»: сравнение сценариев на одном экране ----------
  function metrics(res, herds) {
    return {
      status: res.status || (res.overloaded ? "overloaded" : "ok"),
      deficit_kg: res.deficit_kg, overloaded: res.overloaded,
      herds_full: res.herds_full ? res.herds_full.length : herds.filter(h => !(res.violations || []).some(v => v.herd === h.id)).length,
      herds_short: res.herds_short ? res.herds_short.length : null,
      violations: res.violations || [], unknown_used: res.unknown_used || 0,
    };
  }
  /**
   * variants: [{ id, type, plot?, factor?, days?, name? }], type ∈
   *   current | plan | add_water | exclude_plot | forage | herds | season | params
   */
  function compareScenarios(plots, herds, p, variants, opts) {
    p = params(p);
    return variants.map(v => {
      let ps = plots, hs = herds, pp = p, o = opts, r, note = "";
      try {
        if (v.type === "add_water") ps = plots.map(pl => (pl.id === v.plot ? Object.assign({}, pl, { water: true, water_status: "modeled" }) : pl));
        if (v.type === "exclude_plot") o = Object.assign({}, opts, { forbidden: ((opts && opts.forbidden) || []).concat([v.plot]) });
        if (v.type === "forage") pp = M.resolve({ user: Object.assign(stripParams(p), { forage_factor: +(p.forage_factor * v.factor).toFixed(4) }) });
        if (v.type === "herds") hs = herds.map(h => { const x = Object.assign({}, h); for (const k of SPECIES) if (x[k]) x[k] = Math.round(x[k] * v.factor); return x; });
        if (v.type === "season") pp = M.resolve({ user: Object.assign(stripParams(p), { season_days: Math.max(1, Math.min(365, p.season_days + v.days)) }) });
        if (v.type === "params") pp = M.scenarioParams(p, v.name);
        r = v.type === "current" ? current(ps, hs, pp, o) : plan(ps, hs, pp, o);
      } catch (e) { return { id: v.id, type: v.type, error: e.message }; }
      return Object.assign({ id: v.id, type: v.type, plot: v.plot, factor: v.factor, days: v.days, name: v.name, note, result: r }, metrics(r, hs));
    });
  }
  function stripParams(p) {
    const o = {};
    for (const k in M.SPEC) o[k] = p[k];
    o.au = Object.assign({}, p.au); o.season_start = p.season_start; o.vegetation_type = p.vegetation_type;
    return o;
  }
  /** Стандартный набор сценариев «Что если?» для экрана сравнения. */
  function defaultVariants(plots, herds, p, opts) {
    p = params(p);
    const v = [{ id: "current", type: "current" }, { id: "plan", type: "plan" }];
    const w = wells(plots, p, opts)[0];
    if (w) v.push({ id: "well", type: "add_water", plot: w.plot });
    const pl = plan(plots, herds, p, opts);
    const busiest = Object.entries(pl.load).filter(([, l]) => l.used > EPS).sort((a, b) => b[1].used - a[1].used)[0];
    if (busiest) v.push({ id: "exclude", type: "exclude_plot", plot: busiest[0] });
    v.push({ id: "forage", type: "forage", factor: 0.8 }, { id: "herds", type: "herds", factor: 1.2 },
      { id: "season", type: "season", days: 30 }, { id: "cautious", type: "params", name: "cautious" }, { id: "optimistic", type: "params", name: "optimistic" });
    return v;
  }

  /** Анализ чувствительности: как меняется ёмкость участков с водой и дефицит при изменении одного параметра. */
  function sensitivity(plots, herds, p, key, values, opts) {
    p = params(p);
    return values.map(val => {
      const user = stripParams(p);
      if (key.startsWith("au.")) user.au[key.slice(3)] = val; else user[key] = val;
      let pp;
      try { pp = M.resolve({ user }); } catch (e) { return { value: val, error: e.message }; }
      const cap = totalCapacity(plots, pp, opts);
      const r = herds.length ? plan(plots, herds, pp, opts) : null;
      return { value: val, capacity_au_season: cap.au_season, capacity_sheep: cap.au_season / pp.au.sheep, deficit_kg: r ? r.deficit_kg : 0, status: r ? r.status : "no_demand" };
    });
  }
  /** Ёмкость всех участков, пригодных для плана (по умолчанию — с водой и данными, без запретов). */
  function totalCapacity(plots, p, opts) {
    p = params(p);
    const prep = prepare(plots, p, opts);
    const ok = prep.filter(q => q.reasons.length === 0);
    const au_days = ok.reduce((a, q) => a + q.cap, 0);
    return { au_days, au_season: au_days / p.season_days, plots: ok.map(q => q.id), unknown: prep.filter(q => !q.c.known).map(q => q.id) };
  }

  function hayTonnes(kgDM, p) { p = params(p); return kgDM / p.hay_dm / 1000; }

  /** Какой участок у стада в день сезона N (1..season_days). */
  function plotOnDay(herdPlan, day) {
    return (herdPlan || []).find(s => day >= s.from && day <= s.to) || null;
  }

  function seasonDay(date, p) {
    p = params(p);
    const [mm, dd] = p.season_start.split("-").map(Number);
    const start = new Date(date.getFullYear(), mm - 1, dd);
    return Math.floor((date - start) / 86400000) + 1;
  }

  return { DIRS, DEFAULTS, ALGORITHM, MODEL: M, params, herdAU, plotCapacity, explainCapacity, current, plan, schedule, exactBound, wells, wellEffect,
    compareScenarios, defaultVariants, sensitivity, totalCapacity, hayTonnes, plotOnDay, seasonDay, dist };
});
