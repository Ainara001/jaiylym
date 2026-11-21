/*
 * Jaiylym — движок расчёта нагрузки и распределения пастбищ.
 * Один файл для веб-карты (браузер) и Telegram-бота (Node).
 * Без нейросетей: прозрачные формулы, которые можно проверить руками.
 *
 * 1) Корм на участке (кг сухого вещества):
 *      биомасса_кг_га = max(0, NDVI − ndvi0) × k_ndvi        ← калибруется укосом 1 м²
 *      доступный_корм = пастбище_га × биомасса × util          ← «съел половину — оставь половину»
 * 2) Ёмкость участка в «голово-днях» условных голов (УГ):
 *      ёмкость = доступный_корм / intake                         ← 1 УГ ≈ 11 кг сухого корма в сутки
 * 3) Стадо в УГ: КРС 1, лошадь 1, овца/коза 0.2 (коэффициенты настраиваются).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Jaiylym = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DIRS = ["С", "СВ", "В", "ЮВ", "Ю", "ЮЗ", "З", "СЗ"];

  const DEFAULTS = {
    season_days: 150,     // пастбищный сезон, дней (май–сентябрь)
    season_start: "05-01",
    intake: 11,           // кг сухого вещества на 1 УГ в сутки
    util: 0.5,            // доля биомассы, которую можно стравить без деградации
    ndvi0: 0.10,          // NDVI голой почвы
    k_ndvi: 4000,         // кг/га сухой биомассы на единицу NDVI выше ndvi0 (калибровать!)
    hay_dm: 0.85,         // доля сухого вещества в сене
    hay_price: 30000,     // ₸ за тонну сена — ПРИМЕР, заменить на цену своего района
    well_price: 0,        // ₸ за водопой/скважину — заполнить по смете акимата
    au: { sheep: 0.2, goats: 0.2, cattle: 1, horses: 1 },
  };

  function params(p) {
    return Object.assign({}, DEFAULTS, p || {}, { au: Object.assign({}, DEFAULTS.au, (p && p.au) || {}) });
  }

  function herdAU(h, p) {
    p = params(p);
    return (h.sheep || 0) * p.au.sheep + (h.goats || 0) * p.au.goats +
      (h.cattle || 0) * p.au.cattle + (h.horses || 0) * p.au.horses;
  }

  function plotCapacity(plot, p) {
    p = params(p);
    const ndvi = plot.ndvi == null ? 0 : plot.ndvi;
    const biomass = Math.max(0, ndvi - p.ndvi0) * p.k_ndvi;       // кг/га
    const forage = plot.pasture_ha * biomass * p.util;             // кг
    return { biomass, forage, au_days: forage / p.intake, au_season: forage / p.intake / p.season_days };
  }

  function xy(plot) {
    const a = DIRS.indexOf(plot.dir) * Math.PI / 4;
    return [plot.dist_km * Math.sin(a), plot.dist_km * Math.cos(a)];
  }
  function dist(a, b) {
    const [x1, y1] = xy(a), [x2, y2] = xy(b);
    return Math.hypot(x1 - x2, y1 - y2);
  }

  function emptyLoad(plots, p) {
    const load = {};
    for (const pl of plots) {
      const c = plotCapacity(pl, p);
      load[pl.id] = { cap: c.au_days, used: 0, load: 0, herds: [] };
    }
    return load;
  }
  function finishLoad(load, p) {
    let overKg = 0, over = 0;
    for (const id in load) {
      const l = load[id];
      l.load = l.cap > 0 ? l.used / l.cap : (l.used > 0 ? Infinity : 0);
      const excess = Math.max(0, l.used - l.cap) * p.intake;
      if (excess > 0) over++;
      overKg += excess;
    }
    return { overloaded: over, excess_kg: overKg };
  }

  /** «Как сейчас»: каждое стадо весь сезон пасётся на своём ближнем участке у села. */
  function current(plots, herds, p) {
    p = params(p);
    const load = emptyLoad(plots, p);
    for (const h of herds) {
      const need = herdAU(h, p) * p.season_days;
      const l = load[h.home];
      if (!l) continue;
      l.used += need;
      l.herds.push({ herd: h.id, au_days: need });
    }
    const s = finishLoad(load, p);
    return Object.assign({ load, deficit_kg: s.excess_kg }, s);
  }

  /**
   * План Jaiylym. Жадное распределение «голово-дней»:
   *  - дойные стада (возвращаются в село каждый вечер) — только ближние участки, распределяются первыми;
   *  - остальные — от малых к большим, сначала на дальние участки с водой (ближайшие к дому),
   *    ближние — только если дальних не хватило;
   *  - ни один участок не загружается больше 100 % ёмкости;
   *  - что не поместилось — дефицит, его закрывают сеном или новым водопоем.
   */
  function plan(plots, herds, p) {
    p = params(p);
    const byId = Object.fromEntries(plots.map(pl => [pl.id, pl]));
    const load = emptyLoad(plots, p);
    const order = herds.slice().sort((a, b) =>
      (b.daily_return ? 1 : 0) - (a.daily_return ? 1 : 0) || herdAU(a, p) - herdAU(b, p));
    const herdPlans = {}, unmet = {}, coverage = {};
    let deficitAUd = 0;

    for (const h of order) {
      const au = herdAU(h, p);
      if (au <= 0) { herdPlans[h.id] = []; coverage[h.id] = p.season_days; continue; }
      let need = au * p.season_days;
      const home = byId[h.home] || plots[0];
      // отары сначала идут на дальние участки (жайлау), ближние — дойному скоту и на отдых
      const farFirst = pl => (h.daily_return || pl.ring === "far" ? 0 : 1);
      const allowed = plots
        .filter(pl => pl.water && (!h.daily_return || pl.ring === "near"))
        .sort((a, b) => farFirst(a) - farFirst(b) || dist(home, a) - dist(home, b));
      const segs = [];
      const take = (pl, x) => {
        const l = load[pl.id];
        l.used += x;
        const hh = l.herds.find(z => z.herd === h.id); if (hh) hh.au_days += x; else l.herds.push({ herd: h.id, au_days: x });
        const s = segs.find(z => z.plot === pl.id);
        if (s) { s.days += x / au; s.au_days += x; } else segs.push({ plot: pl.id, ring: pl.ring, days: x / au, au_days: x });
        need -= x;
      };
      // 1) крупные куски: стадо целиком хотя бы на 2 недели (меньше — не гоняем)
      for (const pl of allowed) {
        if (need <= 0.5) break;
        const l = load[pl.id], x = Math.min(need, Math.max(0, l.cap - l.used));
        if (x < au && x < need) continue;
        if (x < need && x < au * 14) continue;
        take(pl, x);
      }
      // 2) если корма не хватило — добираем остатки со всех участков с водой
      //    (большое стадо в жизни делят на отары; без этого шага план мог оказаться хуже «как сейчас»)
      for (const pl of allowed) {
        if (need <= 0.5) break;
        const l = load[pl.id], x = Math.min(need, Math.max(0, l.cap - l.used));
        if (x > 0.5) take(pl, x);
      }
      herdPlans[h.id] = schedule(segs, p.season_days);
      if (need > 0.5) { unmet[h.id] = need; deficitAUd += need; }
      coverage[h.id] = Math.max(0, p.season_days - Math.max(0, need) / au);   // на сколько дней сезона хватает корма
    }
    const s = finishLoad(load, p);
    return Object.assign({ load, herdPlans, unmet, coverage, deficit_kg: deficitAUd * p.intake }, s);
  }

  /** Раскладка по календарю: весна — ближние, лето — дальние (жайлау), осень — снова ближние. */
  function schedule(segs, season) {
    const near = segs.filter(s => s.ring === "near"), far = segs.filter(s => s.ring !== "near");
    let parts;
    if (near.length && far.length) {
      parts = [
        ...near.map(s => ({ plot: s.plot, days: s.days / 2 })),
        ...far.map(s => ({ plot: s.plot, days: s.days })),
        ...near.slice().reverse().map(s => ({ plot: s.plot, days: s.days / 2 })),
      ];
    } else parts = segs.map(s => ({ plot: s.plot, days: s.days }));
    let day = 0;
    const out = [];
    for (const s of parts) {
      const from = Math.round(day), to = Math.round(day + s.days);
      if (to > from) out.push({ plot: s.plot, from: from + 1, to });
      day += s.days;
    }
    // хвост сезона без корма
    if (out.length === 0) return [{ plot: null, from: 1, to: season }];
    const last = out[out.length - 1].to;
    if (last < season && Math.round(day) >= season) out[out.length - 1].to = season;   // округление
    else if (last < season) out.push({ plot: null, from: last + 1, to: season });
    return out;
  }

  /** Где новый водопой откроет больше всего корма. */
  function wells(plots, p) {
    p = params(p);
    return plots
      .filter(pl => !pl.water)
      .map(pl => {
        const c = plotCapacity(pl, p);
        return { plot: pl.id, au: c.au_season, sheep: c.au_season / p.au.sheep, forage_t: c.forage / 1000 };
      })
      .sort((a, b) => b.au - a.au);
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

  return { DIRS, DEFAULTS, params, herdAU, plotCapacity, current, plan, wells, hayTonnes, plotOnDay, seasonDay, dist };
});
