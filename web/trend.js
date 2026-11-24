/*
 * Многолетний анализ травы (P3) без нейросетей: тренд Тейла — Сена, тест Манна — Кендалла, RESTREND по осадкам.
 * Вход — летние сезоны pipeline.buildSeason (одно окно июнь–август каждый год) и осадки апреля–августа (ERA5).
 * Вывод никогда не называется «деградацией»: без полевых наблюдений это только повод проверить участок на месте.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JaiylymTrend = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ALPHA = 0.05;           // уровень значимости
  const MIN_YEARS = 5;          // меньше качественных лет — вывода нет
  const MIN_CHANGE = 0.02;      // изменение NDVI за весь период меньше этого — шум разных дат и облаков, а не тренд
  const RAIN_R2 = 0.3;          // RESTREND применяется, только если трава заметно зависит от осадков
  const MIN_DATES = 3;          // безоблачных дат в году, чтобы год участвовал
  const MIN_VALID = 0.5;        // доля чистых пастбищных пикселей участка

  const median = xs => { const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };

  /** Наклон Тейла — Сена: медиана наклонов по всем парам точек (устойчив к выбросам). */
  function theilSen(x, y) {
    const sl = [];
    for (let i = 0; i < x.length; i++) for (let j = i + 1; j < x.length; j++) if (x[j] !== x[i]) sl.push((y[j] - y[i]) / (x[j] - x[i]));
    const slope = median(sl);
    if (slope == null) return { slope: null, intercept: null };
    return { slope, intercept: median(x.map((xi, i) => y[i] - slope * xi)) };
  }

  /** Число перестановок из n элементов с k инверсиями (числа Махони), k = 0..n(n−1)/2. */
  function mahonian(n) {
    let row = [1];
    for (let m = 2; m <= n; m++) {
      const next = new Array(row.length + m - 1).fill(0);
      for (let k = 0; k < next.length; k++) for (let j = 0; j < m; j++) if (k - j >= 0 && k - j < row.length) next[k] += row[k - j];
      row = next;
    }
    return row;
  }
  const erf = x => {   // Абрамовиц — Стиган 7.1.26, точность 1.5e−7
    const s = Math.sign(x); x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
  };
  const normCdf = z => 0.5 * (1 + erf(z / Math.SQRT2));

  /**
   * Тест Манна — Кендалла на монотонный тренд (ряд упорядочен по времени). Двусторонний p:
   * без совпадений и n ≤ 12 — точный (распределение S через инверсии), иначе нормальное приближение с поправкой на совпадения.
   */
  function mannKendall(y) {
    const n = y.length;
    if (n < 3) return { n, s: 0, p: 1, exact: false };
    let s = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) s += Math.sign(y[j] - y[i]);
    const ties = {};
    for (const v of y) ties[v] = (ties[v] || 0) + 1;
    const tied = Object.values(ties).some(c => c > 1);
    if (!tied && n <= 12) {
      const dist = mahonian(n), total = dist.reduce((a, b) => a + b, 0), pairs = n * (n - 1) / 2;
      // S = пары − 2·инверсии; P(|S| ≥ |s|)
      let tail = 0;
      dist.forEach((c, k) => { if (Math.abs(pairs - 2 * k) >= Math.abs(s)) tail += c; });
      return { n, s, p: Math.min(1, tail / total), exact: true };
    }
    let v = n * (n - 1) * (2 * n + 5);
    for (const c of Object.values(ties)) if (c > 1) v -= c * (c - 1) * (2 * c + 5);
    v /= 18;
    const z = s > 0 ? (s - 1) / Math.sqrt(v) : s < 0 ? (s + 1) / Math.sqrt(v) : 0;
    return { n, s, p: Math.min(1, 2 * (1 - normCdf(Math.abs(z)))), exact: false };
  }

  /** Обычная регрессия y = a + b·x и доля объяснённой дисперсии R². */
  function ols(x, y) {
    const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
    if (!sxx) return { a: my, b: 0, r2: 0 };
    const b = sxy / sxx;
    return { a: my - b * mx, b, r2: syy ? (sxy * sxy) / (sxx * syy) : 0 };
  }

  /**
   * Тренд одного ряда: years, ndvi (по годам), precip (мм; null — нет данных). Возвращает наклон, p, RESTREND и вывод:
   *   few_years           — меньше MIN_YEARS качественных лет;
   *   no_change           — значимого изменения нет (или оно меньше MIN_CHANGE за период);
   *   decline_rain        — снижение есть, но его объясняют осадки (остатки RESTREND без тренда);
   *   decline_unexplained — снижение, не объяснённое осадками: повод проверить на месте;
   *   increase            — рост.
   */
  function seriesTrend(years, ndvi, precip) {
    const n = years.length;
    if (n < MIN_YEARS) return { n, verdict: "few_years", basis: null };
    const ts = theilSen(years, ndvi), mk = mannKendall(ndvi);
    const span = years[n - 1] - years[0];
    const out = { n, slope_per_year: ts.slope, intercept: ts.intercept, change_total: ts.slope * span, p: mk.p, exact: mk.exact, rain: null, resid: null };
    const havePrecip = precip && precip.every(v => v != null && isFinite(v));
    if (havePrecip) {
      const r = ols(precip, ndvi);
      const valid = r.b > 0 && r.r2 >= RAIN_R2;
      out.rain = { b: r.b, r2: r.r2, valid };
      if (valid) {
        const res = ndvi.map((v, i) => v - (r.a + r.b * precip[i]));
        const rts = theilSen(years, res), rmk = mannKendall(res);
        out.resid = { slope_per_year: rts.slope, change_total: rts.slope * span, p: rmk.p };
      }
    }
    return classify(out, out.p, out.resid && out.resid.p);
  }
  /**
   * Вывод по статистикам ряда при заданных p (сырых или с поправкой на множественную проверку).
   * Если трава заметно зависит от осадков, снижение решают остатки RESTREND: значимое снижение остатков — «не объяснено осадками»
   * (даже если сырой ряд растёт за счёт влажных лет), снижение сырого ряда без снижения остатков — «объясняют осадки».
   * basis — по какому ряду вывод: raw (NDVI) или resid (NDVI с учётом осадков), чтобы текст показывал нужный наклон.
   */
  function classify(out, pRaw, pRes) {
    const rainValid = !!(out.rain && out.rain.valid && out.resid);
    const sig = pRaw < ALPHA && Math.abs(out.change_total) >= MIN_CHANGE;
    const rsig = rainValid && pRes < ALPHA && Math.abs(out.resid.change_total) >= MIN_CHANGE;
    if (rsig && out.resid.slope_per_year < 0) { out.verdict = "decline_unexplained"; out.basis = "resid"; }
    else if (sig && out.slope_per_year < 0) { out.verdict = rainValid ? "decline_rain" : "decline_unexplained"; out.basis = "raw"; }
    else if (sig && out.slope_per_year > 0) { out.verdict = "increase"; out.basis = "raw"; }
    else { out.verdict = "no_change"; out.basis = "raw"; }
    return out;
  }
  /** Поправка Бенджамини — Хохберга (доля ложных открытий) для p-значений участков одного села. */
  function bhAdjust(ps) {
    const idx = ps.map((p, i) => [p, i]).filter(([p]) => p != null).sort((a, b) => a[0] - b[0]);
    const m = idx.length, out = ps.map(() => null);
    let min = 1;
    for (let k = m - 1; k >= 0; k--) { min = Math.min(min, idx[k][0] * m / (k + 1)); out[idx[k][1]] = Math.min(1, min); }
    return out;
  }

  /** Годится ли год для тренда: снимков хватает, окно стандартное (июнь–август). */
  function yearQuality(season) {
    if (!season || season.status !== "measured") return { ok: false, reason: "no_data" };
    if ((season.dates || []).length < MIN_DATES) return { ok: false, reason: "few_dates" };
    if (season.window && season.window.widened) return { ok: false, reason: "window" };
    return { ok: true, reason: null };
  }

  /**
   * Анализ села: seasons — массив buildSeason по годам, precip — { год: мм апрель–август }.
   * Ряд села — медиана NDVI участков в каждом году; участок в году учитывается, если у него достаточно чистых пикселей.
   */
  function analyze(seasons, precip) {
    const list = (seasons || []).slice().sort((a, b) => a.year - b.year);
    const years = list.map(s => {
      const q = yearQuality(s);
      const vals = (s.plots || []).filter(p => p.ndvi != null && (p.valid_fraction ?? 1) >= MIN_VALID).map(p => p.ndvi);
      const ds = (s.dates || []).slice().sort();
      return { year: s.year, ok: q.ok && vals.length > 0, reason: q.ok && !vals.length ? "no_data" : q.reason, dates: ds.length,
        mid_date: ds.length ? ds[(ds.length - 1) >> 1].slice(5) : null,   // медианная дата снимков: разные годы — разная фенология
        ndvi_median: vals.length ? +median(vals).toFixed(3) : null, precip_mm: precip && precip[s.year] != null ? Math.round(precip[s.year]) : null };
    });
    const good = years.filter(y => y.ok);
    const pr = ys => (ys.every(y => y.precip_mm != null) ? ys.map(y => y.precip_mm) : null);
    const village = seriesTrend(good.map(y => y.year), good.map(y => y.ndvi_median), pr(good));
    const ids = [...new Set(list.flatMap(s => (s.plots || []).map(p => p.id)))];
    const plots = {};
    for (const id of ids) {
      const pts = [];
      for (const s of list) {
        const y = years.find(v => v.year === s.year);
        const p = (s.plots || []).find(q => q.id === id);
        if (y.ok && p && p.ndvi != null && (p.valid_fraction ?? 1) >= MIN_VALID) pts.push({ year: s.year, ndvi: p.ndvi, precip: y.precip_mm });
      }
      plots[id] = seriesTrend(pts.map(q => q.year), pts.map(q => q.ndvi), pts.every(q => q.precip != null) ? pts.map(q => q.precip) : null);
    }
    // 16 участков проверяются одновременно: без поправки ~1 участок на село выглядел бы «значимым» случайно.
    // Выводы участков — по p с поправкой Бенджамини — Хохберга (сырые p сохраняются для прозрачности).
    const tested = ids.filter(id => plots[id].verdict !== "few_years");
    const adjRaw = bhAdjust(tested.map(id => plots[id].p));
    const adjRes = bhAdjust(tested.map(id => (plots[id].resid ? plots[id].resid.p : null)));
    tested.forEach((id, i) => {
      const s = plots[id];
      s.p_adj = adjRaw[i];
      if (s.resid) s.resid.p_adj = adjRes[i];
      classify(s, adjRaw[i], adjRes[i]);
    });
    return { years, village, plots, rules: { alpha: ALPHA, min_years: MIN_YEARS, min_change: MIN_CHANGE, rain_r2: RAIN_R2, min_dates: MIN_DATES, plots_fdr: "Benjamini–Hochberg" } };
  }

  /**
   * Многолетний ряд как факты для ИИ — один формат для сайта и бота: годы, вывод по селу, участки с наклоном и p
   * (у участков p с поправкой Бенджамини — Хохберга; при поправке на осадки — по остаткам).
   */
  function aiFacts(a) {
    const basis = s => (s.basis === "resid" && s.resid ? { sl: s.resid, p: s.resid.p_adj ?? s.resid.p } : { sl: s, p: s.p_adj ?? s.p });
    return {
      годы: a.years.map(y => ({ год: y.year, ndvi_села: y.ndvi_median, осадки_апр_авг_мм: y.precip_mm, в_ряду: y.ok, причина: y.reason || undefined })),
      вывод_по_селу: a.village.verdict, лет_в_ряду: a.village.n,
      наклон_ndvi_в_год: a.village.slope_per_year != null ? +a.village.slope_per_year.toFixed(4) : null, p: a.village.p != null ? +a.village.p.toFixed(3) : null,
      связь_с_осадками_r2: a.village.rain ? +a.village.rain.r2.toFixed(2) : null, поправка_на_осадки: a.village.rain ? a.village.rain.valid : false,
      участки: Object.entries(a.plots).map(([id, s]) => { const b = basis(s); return `${id}: ${s.verdict}${b.sl.slope_per_year != null ? ` ${b.sl.slope_per_year.toFixed(4)}/год${s.basis === "resid" ? " с учётом осадков" : ""} p=${b.p.toFixed(2)}` : ""}`; }),
      p_участков: "с поправкой на множественную проверку (Бенджамини — Хохберг)",
    };
  }

  /** Старое правило для сравнения: разница первого и последнего года больше порога — «тревога». */
  function twoYearAlarm(ndvi, thr = MIN_CHANGE) { return ndvi.length >= 2 && ndvi[0] - ndvi[ndvi.length - 1] >= thr; }

  return { theilSen, mannKendall, mahonian, ols, seriesTrend, classify, bhAdjust, yearQuality, analyze, aiFacts, twoYearAlarm, median, ALPHA, MIN_YEARS, MIN_CHANGE, RAIN_R2 };
});
