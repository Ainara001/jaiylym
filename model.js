/*
 * Jaiylym — конфигурация расчётной модели (общая для сайта, бота, API и PDF).
 *
 * Здесь собрано всё, что относится к допущениям модели, а не к измерениям:
 *   - параметры с единицами измерения, допустимыми диапазонами и источником;
 *   - три слоя параметров: стандартные (default) → откалиброванные (calibrated) → пользовательские (user);
 *   - версия модели и отметка о полевой проверке;
 *   - единые правила качества спутникового измерения и достоверности кормовой оценки (это РАЗНЫЕ вещи);
 *   - единый объект метаданных расчёта (сайт, бот и PDF показывают одни и те же поля);
 *   - статусы водопоя и правила, какие из них можно использовать в плане;
 *   - сценарии «осторожный / базовый / оптимистичный» на явно указанных допущениях.
 *
 * Модель НЕ подтверждена полевыми измерениями: коэффициент k_ndvi — допущение, пока не сделан укос.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JaiylymModel = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MODEL_VERSION = "2.0.0";
  const FORMULA = {
    biomass: "biomass_kg_ha = max(0, NDVI − ndvi0) × k_ndvi",
    forage: "available_forage_kg = pasture_ha × biomass_kg_ha × util × forage_factor",
    au_days: "capacity_au_days = available_forage_kg / intake",
    au_season: "capacity_au_season = capacity_au_days / season_days",
    sheep: "capacity_sheep_season = capacity_au_season / au_sheep",
  };

  // ---------- параметры ----------
  // source: откуда взято значение по умолчанию. Ни одно значение не измерено в поле в рамках проекта.
  const SPEC = {
    season_days: { def: 150, min: 1, max: 365, unit: "сут", int: true, source: "допущение: сезон май–сентябрь" },
    intake: { def: 11, min: 3, max: 25, unit: "кг СВ / усл. гол. / сут", source: "справочная норма ≈ 2–2,5 % живой массы (~450 кг)" },
    util: { def: 0.5, min: 0.05, max: 0.9, unit: "доля", source: "правило «съел половину — оставь половину»" },
    ndvi0: { def: 0.10, min: 0, max: 0.3, unit: "NDVI", source: "допущение: NDVI голой почвы" },
    k_ndvi: { def: 4000, min: 500, max: 12000, unit: "кг СВ / га на 1,0 NDVI", source: "допущение, НЕ откалибровано (нужен укос 1 м²)" },
    forage_factor: { def: 1, min: 0.1, max: 2, unit: "множитель", source: "поправка доступного корма (сезон, засуха): не задана, данных нет" },
    hay_dm: { def: 0.85, min: 0.5, max: 1, unit: "доля СВ в сене", source: "справочное значение для сена" },
    hay_price: { def: 30000, min: 0, max: 1000000, unit: "тенге / т", source: "пример, заменить ценой района" },
    well_price: { def: 0, min: 0, max: 1e10, unit: "тенге", source: "не задано (смета акимата)" },
    max_load: { def: 1, min: 0.1, max: 1, unit: "доля ёмкости", source: "план не загружает участок больше 100 %" },
  };
  const AU_SPEC = {
    sheep: { def: 0.2, min: 0.05, max: 0.5, unit: "усл. гол.", source: "справочный коэффициент" },
    goats: { def: 0.2, min: 0.05, max: 0.5, unit: "усл. гол.", source: "справочный коэффициент" },
    cattle: { def: 1, min: 0.5, max: 1.5, unit: "усл. гол.", source: "базовая единица" },
    horses: { def: 1, min: 0.5, max: 1.5, unit: "усл. гол.", source: "справочный коэффициент" },
  };
  const VEGETATION = ["unknown", "steppe", "mountain_meadow", "desert_steppe", "shrub"];
  const META_DEFAULTS = { season_start: "05-01", vegetation_type: "unknown", period: "season" };

  function defaults() {
    const p = {};
    for (const k in SPEC) p[k] = SPEC[k].def;
    p.au = {};
    for (const k in AU_SPEC) p.au[k] = AU_SPEC[k].def;
    return Object.assign(p, META_DEFAULTS);
  }

  class ParamError extends Error {
    constructor(errors) {
      super("Неверные параметры модели: " + errors.map(e => `${e.key} = ${e.value} (${e.reason})`).join("; "));
      this.name = "ParamError"; this.errors = errors; this.code = 400;
    }
  }

  /** Проверка одного значения. Возвращает текст ошибки или null. */
  function checkValue(spec, v) {
    if (typeof v === "string" && v.trim() !== "") v = +v;
    if (typeof v !== "number" || !Number.isFinite(v)) return "не число";
    if (v < spec.min) return `меньше ${spec.min}`;
    if (v > spec.max) return `больше ${spec.max}`;
    if (spec.int && Math.round(v) !== v) return "нужно целое число";
    return null;
  }

  /**
   * Проверка набора параметров (частичного). Ничего не обнуляет молча: неверное значение — ошибка.
   * @returns {{ ok: boolean, errors: Array<{key,value,reason}>, values: object }}
   */
  function validate(p) {
    const errors = [], values = {};
    if (p == null) return { ok: true, errors, values };
    if (typeof p !== "object") return { ok: false, errors: [{ key: "params", value: String(p), reason: "не объект" }], values };
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (k === "au") {
        if (v == null) continue;
        if (typeof v !== "object") { errors.push({ key: "au", value: String(v), reason: "не объект" }); continue; }
        values.au = {};
        for (const a of Object.keys(v)) {
          if (!AU_SPEC[a]) { errors.push({ key: "au." + a, value: v[a], reason: "неизвестный вид скота" }); continue; }
          const e = checkValue(AU_SPEC[a], v[a]);
          if (e) errors.push({ key: "au." + a, value: v[a], reason: e }); else values.au[a] = +v[a];
        }
        continue;
      }
      if (k === "season_start") {
        if (!/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(v))) errors.push({ key: k, value: v, reason: "формат ММ-ДД" });
        else values[k] = String(v);
        continue;
      }
      if (k === "vegetation_type") {
        if (!VEGETATION.includes(v)) errors.push({ key: k, value: v, reason: "неизвестный тип растительности" }); else values[k] = v;
        continue;
      }
      if (k === "period") { values[k] = String(v).slice(0, 20); continue; }
      if (k.startsWith("_")) continue;                       // служебные поля (_origin и т.п.)
      if (!SPEC[k]) { errors.push({ key: k, value: v, reason: "неизвестный параметр" }); continue; }
      const e = checkValue(SPEC[k], v);
      if (e) errors.push({ key: k, value: v, reason: e }); else values[k] = +v;
    }
    return { ok: errors.length === 0, errors, values };
  }

  /**
   * Сборка параметров из трёх слоёв. Порядок: стандартные → откалиброванные → пользовательские.
   * Каждый слой проверяется; при ошибке — ParamError (а не тихая подмена).
   * calibrated = { values: {...}, source: "укос 2027, 5 площадок", date: "2027-07-01", field: true }
   */
  function resolve({ user, calibrated } = {}) {
    const p = defaults();
    const origin = {};
    for (const k in SPEC) origin[k] = "default";
    for (const k in AU_SPEC) origin["au." + k] = "default";
    const apply = (layer, tag) => {
      if (!layer) return;
      const r = validate(layer);
      if (!r.ok) throw new ParamError(r.errors);
      for (const k of Object.keys(r.values)) {
        if (k === "au") { for (const a in r.values.au) { p.au[a] = r.values.au[a]; origin["au." + a] = tag; } }
        else { p[k] = r.values[k]; origin[k] = tag; }
      }
    };
    apply(calibrated && calibrated.values, "calibrated");
    apply(user, "user");
    Object.defineProperty(p, "_origin", { value: origin, enumerable: false, writable: true });
    Object.defineProperty(p, "_calibration", { value: calibrated ? {
      source: String(calibrated.source || ""), date: String(calibrated.date || ""), field: !!calibrated.field } : null, enumerable: false, writable: true });
    return p;
  }

  /** Переводимые параметры для интерфейса: значение, единицы, диапазон, источник, слой. */
  function describe(p) {
    const origin = (p && p._origin) || {};
    const rows = Object.keys(SPEC).map(k => Object.assign({ key: k, value: p[k], origin: origin[k] || "default" }, SPEC[k]));
    for (const a in AU_SPEC) rows.push(Object.assign({ key: "au." + a, value: p.au[a], origin: origin["au." + a] || "default" }, AU_SPEC[a]));
    return rows;
  }

  /** Подтверждена ли модель полевыми измерениями: только если k_ndvi взят из полевой калибровки. */
  function fieldValidated(p) {
    return !!(p && p._calibration && p._calibration.field && p._origin && p._origin.k_ndvi === "calibrated");
  }

  // ---------- статусы данных участка ----------
  // no_data — NDVI отсутствует (облака, нет снимков, участок без пастбищного покрова);
  // insufficient_quality — NDVI есть, но измерение ненадёжно (мало снимков/пикселей);
  // estimated — оценка по неоткалиброванной формуле; calibrated — коэффициент из полевой калибровки.
  const DATA_STATUS = ["no_data", "insufficient_quality", "estimated", "calibrated"];

  /**
   * Качество спутникового измерения NDVI (не путать с достоверностью кормовой ёмкости!).
   * Единое правило для участков села и для пастбищ, нарисованных фермером.
   *   samples — число пастбищных пикселей с валидным NDVI, приведённое к 10-метровому разрешению
   *             Sentinel-2 (нельзя «умножить» данные, пересчитав снимок мельче родного пикселя);
   *   obs     — число дат безоблачных наблюдений участка;
   *   valid   — доля пастбищных пикселей участка, закрытых валидным NDVI на медианном снимке.
   *   high:   obs ≥ 4, samples ≥ 300, valid ≥ 0.7
   *   medium: obs ≥ 2, samples ≥ 50,  valid ≥ 0.5
   *   low:    NDVI есть, но условия выше не выполнены
   *   none:   NDVI нет
   */
  const QUALITY_RULES = { high: { obs: 4, samples: 300, valid: 0.7 }, medium: { obs: 2, samples: 50, valid: 0.5 } };
  const NATIVE_PX_HA = 0.01;          // пиксель Sentinel-2 10 × 10 м = 0,01 га

  function satelliteInputs(plot) {
    const obs = plot.obs_count != null ? plot.obs_count : (plot.series || []).length;
    let samples = plot.samples;
    if (samples == null) {
      // для старых данных (Кеген) число пикселей не сохранено: оцениваем по площади и шагу сетки ~50 м (0,25 га)
      const pxHa = plot.px_ha || 0.25;
      samples = Math.round((plot.pasture_ha || 0) / Math.max(pxHa, NATIVE_PX_HA));
    } else {
      samples = Math.min(samples, Math.round((plot.pasture_ha || 0) / NATIVE_PX_HA));
    }
    const valid = plot.valid_fraction != null ? plot.valid_fraction : null;
    return { obs, samples, valid };
  }

  function satelliteQuality(plot) {
    if (!plot || plot.ndvi == null || !Number.isFinite(+plot.ndvi)) return "none";
    const { obs, samples, valid } = satelliteInputs(plot);
    const v = valid == null ? 1 : valid;                     // не записано — не ограничивает, но есть предупреждение в метаданных
    const ok = r => obs >= r.obs && samples >= r.samples && v >= r.valid;
    if (ok(QUALITY_RULES.high)) return "high";
    if (ok(QUALITY_RULES.medium)) return "medium";
    return "low";
  }

  /**
   * Достоверность кормовой ёмкости — насколько обоснован перевод NDVI в сухую биомассу.
   * Хороший снимок НЕ делает оценку числа овец точной: без полевой калибровки — «не подтверждена».
   *   none          — нет NDVI, ёмкость неизвестна;
   *   unconfirmed   — формула не откалибрована (стандартный k_ndvi) — так сейчас для всех участков;
   *   calibrated    — k_ndvi из полевой калибровки, но точность всё равно зависит от качества снимка;
   *   (high не бывает без серии полевых измерений по сезонам).
   */
  function forageConfidence(plot, p) {
    if (!plot || plot.ndvi == null) return "none";
    return fieldValidated(p) ? "calibrated" : "unconfirmed";
  }

  /** Статус данных участка для движка (см. DATA_STATUS). */
  function dataStatus(plot, p) {
    if (!plot || plot.ndvi == null || !Number.isFinite(+plot.ndvi)) return "no_data";
    if (satelliteQuality(plot) === "low") return "insufficient_quality";
    return fieldValidated(p) ? "calibrated" : "estimated";
  }

  // ---------- водопой ----------
  // confirmed — подтверждён пользователем; satellite — на карте WorldCover есть водный объект (не значит «пригоден для скота»);
  // assumed — предполагается моделью (у села); modeled — смоделированный будущий водопой; unknown — информации нет; absent — водопоя нет.
  const WATER_STATUS = ["confirmed", "satellite", "assumed", "modeled", "unknown", "absent"];
  const WATER_USABLE = { confirmed: true, satellite: true, assumed: true, modeled: true, unknown: false, absent: false };

  /** Статус водопоя для участка (совместимость со старыми данными, где были только water и water_source). */
  function waterStatus(plot) {
    if (plot.water_status && WATER_STATUS.includes(plot.water_status)) return plot.water_status;
    const s = String(plot.water_source || "");
    if (/село|village|ауыл/i.test(s)) return "assumed";
    if (/WorldCover|водо[её]м|су айдын/i.test(s)) return "satellite";
    if (plot.water === true) return "assumed";
    return "unknown";
  }
  const waterUsable = (plot, policy) => {
    const st = waterStatus(plot);
    if (policy === "confirmed_only") return st === "confirmed" || st === "modeled";
    return !!WATER_USABLE[st];
  };

  // ---------- сценарии на явных допущениях (не доверительные интервалы!) ----------
  const ASSUMPTION_SCENARIOS = {
    cautious: { util: 0.8, k_ndvi: 0.75, label: "осторожный: использовать 80 % от доли стравливания и 75 % коэффициента биомассы" },
    base: { util: 1, k_ndvi: 1, label: "базовый: параметры как указаны" },
    optimistic: { util: 1.2, k_ndvi: 1.25, label: "оптимистичный: 120 % доли стравливания (не выше 0,9) и 125 % коэффициента биомассы" },
  };
  function scenarioParams(p, name) {
    const s = ASSUMPTION_SCENARIOS[name];
    if (!s) throw new Error("нет сценария " + name);
    const q = Object.assign({}, p, { au: Object.assign({}, p.au) });
    q.util = Math.min(SPEC.util.max, Math.max(SPEC.util.min, +(p.util * s.util).toFixed(4)));
    q.k_ndvi = Math.min(SPEC.k_ndvi.max, Math.max(SPEC.k_ndvi.min, Math.round(p.k_ndvi * s.k_ndvi)));
    for (const k of ["_origin", "_calibration"]) Object.defineProperty(q, k, { value: p[k], enumerable: false, writable: true });
    return q;
  }

  // ---------- тревога по NDVI: одно изменение — не основание для тревоги ----------
  /**
   * cur — новый NDVI, prev — прошлые значения по порядку (старые → новые).
   * «decline_confirmed» — только если снижение видно на ДВУХ подряд снимках относительно медианы
   * более ранних наблюдений (порог −0,05 NDVI или −12 %). Одно снижение — «decline_possible»:
   * сообщение мягкое, с просьбой дождаться следующего снимка.
   */
  function ndviTrend(cur, prev) {
    const med = xs => { const a = xs.slice().sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
    if (!Number.isFinite(cur)) return { kind: "no_data" };
    if (!prev || !prev.length) return { kind: cur < 0.2 ? "low" : "first", base: null, delta: null };
    const drop = (v, b) => b > 0 && (v - b <= -0.05 || (v - b) / b <= -0.12);
    const rise = (v, b) => b > 0 && (v - b >= 0.05 || (v - b) / b >= 0.12);
    const base = med(prev.slice(-3));
    const delta = cur - base;
    if (drop(cur, base)) {
      // подтверждение: предыдущий снимок тоже ниже медианы ещё более ранних
      const last = prev[prev.length - 1], earlier = prev.slice(0, -1);
      const confirmed = earlier.length >= 1 && drop(last, med(earlier.slice(-3))) && drop(cur, med(earlier.slice(-3)));
      return { kind: confirmed ? "decline_confirmed" : "decline_possible", base, delta };
    }
    if (cur < 0.2) return { kind: "low", base, delta };
    if (rise(cur, base)) return { kind: "rise", base, delta };
    return { kind: "stable", base, delta };
  }

  // ---------- метаданные расчёта: единый формат для сайта, бота и PDF ----------
  const META_FIELDS = ["source", "dataset", "year", "scene_dates", "imagery_count", "valid_pixel_fraction", "landcover_source",
    "landcover_year", "calculated_at", "model_version", "data_status", "warnings"];

  function makeMeta(m) {
    const scene_dates = Array.from(new Set((m.scene_dates || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))).sort();
    const out = {
      source: m.source || "Microsoft Planetary Computer",
      dataset: m.dataset || "Sentinel-2 L2A",
      year: m.year != null ? +m.year : null,
      scene_dates,
      imagery_count: m.imagery_count != null ? +m.imagery_count : scene_dates.length,
      valid_pixel_fraction: m.valid_pixel_fraction != null && Number.isFinite(+m.valid_pixel_fraction) ? +(+m.valid_pixel_fraction).toFixed(3) : null,
      landcover_source: m.landcover_source || "ESA WorldCover 10 м",
      landcover_year: m.landcover_year != null ? +m.landcover_year : null,
      calculated_at: m.calculated_at || null,
      model_version: m.model_version || MODEL_VERSION,
      data_status: m.data_status || (scene_dates.length ? "measured" : "no_data"),
      warnings: Array.isArray(m.warnings) ? m.warnings.map(String) : [],
    };
    return out;
  }

  /** Метаданные для старых данных без поля meta (например, сохранённый пример Кегена). */
  function metaOf(D) {
    if (D && D.meta) return makeMeta(D.meta);
    const s = (D && D.source) || {};
    const warnings = ["Число валидных пикселей и доля покрытия не записаны для этого расчёта (данные до версии модели 2.0)."];
    if (!s.calculated_at) warnings.push("Дата расчёта не записана; известны только даты снимков.");
    return makeMeta({ year: s.year, scene_dates: s.dates || [], landcover_year: 2021, calculated_at: s.calculated_at || null,
      model_version: MODEL_VERSION, data_status: (s.dates || []).length ? "measured" : "no_data", warnings });
  }

  return {
    MODEL_VERSION, FORMULA, SPEC, AU_SPEC, VEGETATION, DATA_STATUS, WATER_STATUS, QUALITY_RULES, NATIVE_PX_HA, META_FIELDS,
    ASSUMPTION_SCENARIOS, ParamError, defaults, validate, resolve, describe, fieldValidated,
    satelliteQuality, satelliteInputs, forageConfidence, dataStatus, waterStatus, waterUsable, scenarioParams, ndviTrend, makeMeta, metaOf,
  };
});
