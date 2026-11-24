/*
 * Jaiylym — расчёт пастбищ для ЛЮБОГО села прямо в браузере (и в боте на Node).
 * То же, что ndvi.py, но без сервера:
 *   1. Ищем село/город (OpenStreetMap Nominatim).
 *   2. Ищем безоблачные снимки Sentinel-2 за лето (Microsoft Planetary Computer STAC).
 *   3. Получаем кусок снимка по рамке вокруг села (Planetary Computer Data API, формат .npy).
 *   4. Считаем NDVI (медиана по снимкам) и маску пастбищ по ESA WorldCover.
 *   5. Делим на 16 участков (8 направлений × 2 кольца) и считаем статистику.
 * Ключи не нужны.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JaiylymPipeline = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search";
  const DATA = "https://planetarycomputer.microsoft.com/api/data/v1/item/bbox";
  const NOMINATIM = "https://nominatim.openstreetmap.org/search";
  const DIRS = ["С", "СВ", "В", "ЮВ", "Ю", "ЮЗ", "З", "СЗ"];
  const RINGS = [[0.5, 3.0, "Б", "near"], [3.0, 8.0, "Д", "far"]];
  const R_KM = 8.6;
  const SIZE = 340;                  // пикселей по стороне (~50 м на пиксель)
  // ---------- единые правила классификации ESA WorldCover (для села и для своего пастбища) ----------
  // pasture   — потенциально пригодный пастбищный покров (это НЕ право выпаса);
  // excluded  — не корм: лес, пашня, застройка, снег, вода, мангры;
  // uncertain — неясно без проверки на месте (водно-болотные травы, мхи, нет данных).
  const LANDCOVER = {
    10: { name: "лес", category: "excluded" },
    20: { name: "кустарник", category: "pasture" },
    30: { name: "травяной покров", category: "pasture" },
    40: { name: "пашня", category: "excluded" },
    50: { name: "застройка", category: "excluded" },
    60: { name: "редкая растительность / голая почва", category: "pasture" },
    70: { name: "снег и лёд", category: "excluded" },
    80: { name: "постоянные водоёмы", category: "excluded" },
    90: { name: "травянистые водно-болотные угодья", category: "uncertain" },
    95: { name: "мангры", category: "excluded" },
    100: { name: "мхи и лишайники", category: "uncertain" },
  };
  const LANDCOVER_YEAR = 2021;
  function classifyLandcover(code) {
    const c = LANDCOVER[code];
    return c ? c.category : "uncertain";             // 0 (нет данных) и неизвестные коды — неопределённые
  }
  const WC_PASTURE = Object.keys(LANDCOVER).map(Number).filter(k => LANDCOVER[k].category === "pasture");
  const WC_WATER = 80;
  const SCL_OK = [4, 5];             // растительность, голая почва (без облаков/теней/снега/воды/насыщения)
  const SCL_NAMES = { 0: "нет данных", 1: "насыщение", 2: "тёмные пиксели", 3: "тени облаков", 6: "вода", 7: "не классифицировано", 8: "облака (средняя вероятность)", 9: "облака (высокая вероятность)", 10: "перистые облака", 11: "снег" };

  const MODEL_VERSION = (typeof module === "object" && module.exports ? require("./model.js") : (self.JaiylymModel || {})).MODEL_VERSION || "2.0.0";
  let USER_AGENT = null;             // в Node Nominatim требует User-Agent
  function setUserAgent(ua) { USER_AGENT = ua; }
  const headers = extra => Object.assign(USER_AGENT ? { "User-Agent": USER_AGENT } : {}, extra || {});

  // ---------- поиск места ----------
  async function geocode(query) {
    const tryOnce = async extra => {
      const u = `${NOMINATIM}?format=json&limit=5&accept-language=ru&q=${encodeURIComponent(query)}${extra}`;
      const r = await fetch(u, { headers: headers() });
      if (!r.ok) throw new Error("Поиск места недоступен (" + r.status + ")");
      return r.json();
    };
    let res = await tryOnce("&countrycodes=kz");
    if (!res.length) res = await tryOnce("");
    return res.map(x => ({
      name: (x.name || x.display_name.split(",")[0]).trim(),
      full: x.display_name,
      lat: +(+x.lat).toFixed(5),
      lon: +(+x.lon).toFixed(5),
    }));
  }

  /** Название места по точке (для выбора села нажатием на карту). */
  async function reverseGeocode(lat, lon, lang = "ru") {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=14&accept-language=${lang}&lat=${lat}&lon=${lon}`, { headers: headers() });
    if (!r.ok) throw new Error("Поиск места недоступен (" + r.status + ")");
    const d = await r.json();
    const a = d.address || {};
    const name = a.village || a.town || a.city || a.hamlet || a.suburb || a.municipality || a.county || d.name || "";
    return { name: String(name).trim(), full: d.display_name || "" };
  }

  // ---------- геометрия ----------
  function kmPerDeg(lat) { return [111.32 * Math.cos(lat * Math.PI / 180), 110.57]; }

  function bboxFor(lat, lon) {
    const [kx, ky] = kmPerDeg(lat);
    return [lon - R_KM / kx, lat - R_KM / ky, lon + R_KM / kx, lat + R_KM / ky].map(v => +v.toFixed(5));
  }

  function sector(lat, lon, r1, r2, a1, a2, steps = 12) {
    const [kx, ky] = kmPerDeg(lat);
    const pt = (r, a) => [+(lon + r * Math.sin(a) / kx).toFixed(5), +(lat + r * Math.cos(a) / ky).toFixed(5)];
    const pts = [];
    for (let i = 0; i <= steps; i++) pts.push(pt(r2, (a1 + (a2 - a1) * i / steps) * Math.PI / 180));
    for (let i = steps; i >= 0; i--) pts.push(pt(r1, (a1 + (a2 - a1) * i / steps) * Math.PI / 180));
    pts.push(pts[0]);
    return { type: "Polygon", coordinates: [pts] };
  }

  function makePlots(lat, lon, steps = 12) {      // steps — плавность дуги (только для отображения)
    const out = [];
    for (const [r1, r2, code, ring] of RINGS)
      DIRS.forEach((d, i) => out.push({
        id: `${code}-${d}`, ring, dir: d, dist_km: +((r1 + r2) / 2).toFixed(1),
        geometry: sector(lat, lon, r1, r2, i * 45 - 22.5, i * 45 + 22.5, steps),
      }));
    return out;
  }

  // ---------- сеть: повтор при сбое и не больше 4 одновременных загрузок ----------
  // Planetary Computer иногда обрывает соединение или отвечает 429/5xx, если сразу просить десяток снимков.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let active = 0;
  const queue = [];
  async function slot(fn) {
    if (active >= 4) await new Promise(r => queue.push(r));
    active++;
    try { return await fn(); } finally { active--; const next = queue.shift(); if (next) next(); }
  }
  async function fetchRetry(url, opts, tries = 4) {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await slot(() => fetch(url, opts));
        if (r.status !== 429 && r.status < 500) return r;
        last = new Error("HTTP " + r.status);
        const ra = +r.headers.get("retry-after");
        if (i < tries - 1) await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) * 1000 : 800 * 2 ** i);
        else return r;
      } catch (e) { last = e; if (i < tries - 1) await sleep(800 * 2 ** i); }
    }
    throw last;
  }

  // ---------- данные ----------
  function parseNpy(buf) {
    const u8 = new Uint8Array(buf);
    const major = u8[6];
    const hlen = major === 1 ? u8[8] | (u8[9] << 8) : new DataView(buf).getUint32(8, true);
    const hstart = major === 1 ? 10 : 12;
    const header = new TextDecoder().decode(u8.subarray(hstart, hstart + hlen));
    const descr = header.match(/'descr':\s*'([^']+)'/)[1];
    const shape = header.match(/'shape':\s*\(([^)]*)\)/)[1].split(",").map(s => s.trim()).filter(Boolean).map(Number);
    const body = buf.slice(hstart + hlen);
    const T = { "<u2": Uint16Array, "|u1": Uint8Array, "<i2": Int16Array, "<f4": Float32Array, "<u1": Uint8Array }[descr];
    if (!T) throw new Error("Неизвестный тип данных " + descr);
    return { shape, data: new T(body) };
  }

  async function stac(body) {
    const r = await fetchRetry(STAC, { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify(body) });
    if (!r.ok) throw new Error("Каталог снимков недоступен (" + r.status + ")");
    return (await r.json()).features || [];
  }

  async function raster(bbox, collection, item, assets) {
    const q = `collection=${collection}&item=${encodeURIComponent(item)}&${assets.map(a => "assets=" + a).join("&")}&dst_crs=epsg:4326`;
    const r = await fetchRetry(`${DATA}/${bbox.join(",")}/${SIZE}x${SIZE}.npy?${q}`, { headers: headers() });
    if (!r.ok) throw new Error("Снимок не загрузился (" + r.status + ")");
    return parseNpy(await r.arrayBuffer());
  }

  function summerYear(now = new Date()) {
    return now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;   // с сентября — текущее лето
  }

  /**
   * Проверка списка сцен каталога: дата должна быть правильной, внутри окна поиска и не в будущем;
   * повторы одного id убираются. Возвращает { items, dropped }.
   */
  function sanitizeScenes(items, { from, to, now = new Date() } = {}) {
    const seen = new Set(), out = [], dropped = [];
    for (const it of items || []) {
      const d = it && it.properties && String(it.properties.datetime || "").slice(0, 10);
      const t = Date.parse(d + "T00:00:00Z");
      const bad = !it || !it.id || !/^\d{4}-\d{2}-\d{2}$/.test(d || "") || Number.isNaN(t) || t > +now + 864e5 ||
        (from && d < from) || (to && d > to) || seen.has(it.id);
      if (bad) { dropped.push(it && it.id); continue; }
      seen.add(it.id); out.push(it);
    }
    return { items: out, dropped };
  }
  /** До 6 разных дат с наименьшей облачностью; все тайлы одной даты оставляем вместе (их склеим в одно наблюдение). */
  function pickScenes(items, maxDates = 6, maxItems = 10) {
    const byDate = new Map();
    for (const it of items.slice().sort((a, b) => (a.properties["eo:cloud_cover"] ?? 100) - (b.properties["eo:cloud_cover"] ?? 100))) {
      const d = it.properties.datetime.slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(it);
    }
    const out = [];
    for (const [, list] of [...byDate.entries()].slice(0, maxDates)) for (const it of list) if (out.length < maxItems) out.push(it);
    return out;
  }
  /**
   * Снимки лета: сначала окно июнь–август с облачностью < 20 %, если мало — май–сентябрь < 40 %.
   * У результата свойство window: { from, to, widened } — для многолетнего ряда расширенное окно (другая фенология) помечается.
   */
  async function findScenes(bbox, year, now = new Date()) {
    for (const [cloud, from, to, widened] of [[20, "06-01", "08-31", false], [40, "05-15", "09-15", true]]) {
      const raw = await stac({
        collections: ["sentinel-2-l2a"], bbox, datetime: `${year}-${from}/${year}-${to}`,
        query: { "eo:cloud_cover": { lt: cloud } }, limit: 60,
      });
      const { items } = sanitizeScenes(raw, { from: `${year}-${from}`, to: `${year}-${to}`, now });
      if (new Set(items.map(i => i.properties.datetime.slice(0, 10))).size >= 2) return Object.assign(pickScenes(items), { window: { from, to, widened } });
    }
    return Object.assign([], { window: null });
  }

  // ---------- общие шаги расчёта ----------
  async function loadLand(bbox) {
    const N = SIZE * SIZE;
    const items = (await stac({ collections: ["esa-worldcover"], bbox, limit: 10 }))
      .filter((f, _, all) => f.id.includes("2021") || !all.some(g => g.id.includes("2021")));
    const parts = await Promise.all(items.map(it => raster(bbox, "esa-worldcover", it.id, ["map"])));
    const land = new Uint8Array(N);   // склеиваем тайлы по маске
    for (const { data } of parts) for (let i = 0; i < N; i++) if (!land[i] && data[N + i]) land[i] = data[i];
    return land;
  }

  /**
   * Смещение отражения: с processing baseline 04.00 (сцены с 25.01.2022) ESA добавляет +1000 к DN.
   * Если baseline не указан, решаем по дате съёмки.
   */
  function boaOffset(props) {
    const pb = props && props["s2:processing_baseline"];
    if (pb && /^\d{2}\.\d{2}$/.test(String(pb))) return String(pb) >= "04.00" ? 1000 : 0;
    const d = String((props && props.datetime) || "").slice(0, 10);
    return d >= "2022-01-25" ? 1000 : 0;
  }
  /**
   * NDVI одного снимка из массивов каналов (B04 — красный, B08 — ближний ИК, SCL — классы сцены, mask — no-data).
   * Пиксель отбрасывается: нет данных, облако/тень/снег/вода по SCL, нулевая или насыщенная яркость, NDVI вне [−1, 1].
   */
  function ndviFromBands(d, N, off) {
    const nd = new Float32Array(N).fill(NaN);
    for (let i = 0; i < N; i++) {
      if (!d[3 * N + i] || !SCL_OK.includes(d[2 * N + i])) continue;
      const red = d[i] - off, nir = d[N + i] - off;
      if (red <= 0 || nir <= 0 || red >= 20000 || nir >= 20000) continue;
      const v = (nir - red) / (nir + red);
      if (v >= -1 && v <= 1) nd[i] = v;
    }
    return nd;
  }
  /** Классы SCL по пикселям (0 — нет данных). Тот же запрос, что и для NDVI: вода видна без лишних загрузок. */
  function sclFromBands(d, N) {
    const s = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (d[3 * N + i]) s[i] = d[2 * N + i];
    return s;
  }
  async function sceneData(bbox, it) {
    const N = SIZE * SIZE;
    const { data: d } = await raster(bbox, "sentinel-2-l2a", it.id, ["B04", "B08", "SCL"]);
    return { nd: ndviFromBands(d, N, boaOffset(it.properties)), scl: sclFromBands(d, N) };
  }
  async function sceneNdvi(bbox, it) { return (await sceneData(bbox, it)).nd; }
  /**
   * Тайлы одной даты (один пролёт спутника) — одно наблюдение: склеиваем, а не считаем дважды в медиане.
   * per — массивы по сценам (NDVI: пропуск — NaN; SCL: пропуск — 0), dates — их даты. Возвращает { per, dates } по уникальным датам.
   */
  function mergeSameDate(per, dates, missing = v => Number.isNaN(v)) {
    const order = [], byDate = new Map();
    per.forEach((nd, j) => {
      const d = dates[j];
      if (!byDate.has(d)) { byDate.set(d, nd.slice()); order.push(d); return; }
      const acc = byDate.get(d);
      for (let i = 0; i < acc.length; i++) if (missing(acc[i]) && !missing(nd[i])) acc[i] = nd[i];
    });
    return { per: order.map(d => byDate.get(d)), dates: order };
  }

  // ---------- вода по снимкам (SCL), а не по карте 2021 года ----------
  const SCL_WATER = 6;
  const SCL_SEEN = [2, 4, 5, 6, 7, 11];    // поверхность видна: не облако, не тень облака, не нет данных
  /**
   * Вода на каждом участке за лето по классу SCL «вода». Пиксель — устойчивая вода, если он виден минимум на 2 снимках
   * и был водой хотя бы на половине из них: так отсекаются тени гор, мокрая почва и одиночные лужи, которые SCL путает с водой.
   * water_ha — устойчивая вода, water_max_ha — вода хотя бы на одном снимке. water_obs — сколько снимков видели ≥ 50 % участка.
   * null — участок почти не виден ни на одном снимке.
   */
  function plotWater(scls, idx, pxHa, nPlots = 16) {
    const acc = Array.from({ length: nPlots }, () => ({ all: 0, seen: 0, stable: 0, any: 0 }));
    const n = scls.length ? scls[0].length : 0;
    const dateSeen = Array.from({ length: nPlots }, () => new Array(scls.length).fill(0));
    for (let i = 0; i < n; i++) {
      const k = idx[i];
      if (k < 0) continue;
      let seen = 0, water = 0;
      scls.forEach((scl, j) => { if (SCL_SEEN.includes(scl[i])) { seen++; dateSeen[k][j]++; if (scl[i] === SCL_WATER) water++; } });
      const a = acc[k]; a.all++;
      if (seen) a.seen++;
      if (seen >= 2 && water / seen >= 0.5) a.stable++;
      if (water) a.any++;
    }
    return acc.map((a, k) => {
      const obs = dateSeen[k].filter(s => a.all && s / a.all >= 0.5).length;
      if (!obs) return { water_ha: null, water_max_ha: null, water_obs: 0 };
      return { water_ha: +(a.stable * pxHa).toFixed(1), water_max_ha: +(a.any * pxHa).toFixed(1), water_obs: obs };
    });
  }

  /** Снимки одного лета: NDVI и SCL по уникальным датам. null — безоблачных снимков нет. */
  async function seasonArrays(bbox, year) {
    const scenes = await findScenes(bbox, year);
    if (!scenes.length) return null;
    const raw = await Promise.all(scenes.map(it => sceneData(bbox, it)));
    const d0 = scenes.map(s => s.properties.datetime.slice(0, 10));
    const { per, dates } = mergeSameDate(raw.map(x => x.nd), d0);
    const { per: scls } = mergeSameDate(raw.map(x => x.scl), d0, v => v === 0);
    return { scenes, per, scls, dates, window: scenes.window || null };
  }

  /**
   * Одно лето для участков села (любое село, любой год): NDVI (медиана июнь–август по пастбищному покрову)
   * и вода по снимкам. Тот же расчёт, что у buildVillage, без картинки. Для сравнения с прошлым годом и многолетнего ряда.
   */
  async function buildSeason({ lat, lon, year, onProgress, land }) {
    const say = m => onProgress && onProgress(m);
    const bbox = bboxFor(lat, lon);
    say(`Ищу снимки лета ${year}…`);
    const arr = await seasonArrays(bbox, year);
    const plots = makePlots(lat, lon);
    if (!arr) return { year, dates: [], status: "no_data", valid_fraction: 0, plots: plots.map(p => ({ id: p.id, ndvi: null, valid_fraction: 0, obs_count: 0, water_ha: null, water_max_ha: null, water_obs: 0 })) };
    say(`Считаю лето ${year}…`);
    return Object.assign(seasonFromArrays({ lat, lon, bbox, year, per: arr.per, scls: arr.scls, dates: arr.dates, land: land || await loadLand(bbox) }),
      { window: arr.window });
  }

  /**
   * Многолетний ряд: лето каждого года из years (последовательно — не перегружать Planetary Computer и телефон).
   * have — уже посчитанные сезоны { год: сезон } (например, прошлое лето), их не качаем заново. Карта покрытия одна на все годы.
   */
  async function buildYears({ lat, lon, years, onProgress, have = {} }) {
    const out = [];
    let land = null;
    for (const [i, year] of years.entries()) {
      if (have[year]) { out.push(have[year]); continue; }
      if (!land) land = await loadLand(bboxFor(lat, lon));
      onProgress && onProgress({ year, i, n: years.length });
      out.push(await buildSeason({ lat, lon, year, land }));
    }
    return out;
  }

  /**
   * Осадки апреля–августа каждого года (мм), реанализ ERA5 через архив Open-Meteo (без ключа). Одним запросом на все годы.
   * Трава отвечает на весеннюю и летнюю влагу с запаздыванием, поэтому окно шире окна снимков. Возвращает { год: мм }.
   */
  async function fetchPrecip({ lat, lon, years }) {
    const y0 = Math.min(...years), y1 = Math.max(...years);
    const u = `https://archive-api.open-meteo.com/v1/archive?latitude=${(+lat).toFixed(3)}&longitude=${(+lon).toFixed(3)}` +
      `&start_date=${y0}-04-01&end_date=${y1}-08-31&daily=precipitation_sum&timezone=UTC`;
    const r = await fetchRetry(u, { headers: headers() });
    if (!r.ok) throw new Error("Архив осадков недоступен (" + r.status + ")");
    return precipByYear(await r.json(), years);
  }
  /** Суммы осадков апрель–август по годам из ответа архива; год с пропусками > 5 % дней — null. */
  function precipByYear(d, years) {
    const t = (d.daily && d.daily.time) || [], p = (d.daily && d.daily.precipitation_sum) || [];
    const out = {};
    for (const y of years) {
      let sum = 0, n = 0, miss = 0;
      t.forEach((day, i) => { if (day >= `${y}-04-01` && day <= `${y}-08-31`) { n++; if (p[i] == null) miss++; else sum += p[i]; } });
      out[y] = n >= 150 && miss <= n * 0.05 ? +sum.toFixed(1) : null;
    }
    return out;
  }
  /** Вычислительная часть buildSeason без сети (для тестов). */
  function seasonFromArrays({ lat, lon, bbox, year, per, scls, dates, land }) {
    const N = SIZE * SIZE;
    const { idx, pxHa } = plotIndex(lat, lon, bbox);
    const med = plotMeans(medianComposite(per, N), land, idx);
    const perPlot = per.map(nd => plotMeans(nd, land, idx));
    const water = plotWater(scls, idx, pxHa);
    let vSum = 0, vN = 0;
    const plots = makePlots(lat, lon).map((p, k) => {
      if (med[k].n) { vSum += med[k].valid; vN++; }
      return { id: p.id, ndvi: med[k].ndvi, valid_fraction: +med[k].valid.toFixed(3),
        obs_count: perPlot.filter(m => m[k].valid >= 0.5).length, water_ha: water[k].water_ha, water_max_ha: water[k].water_max_ha, water_obs: water[k].water_obs };
    });
    return { year, dates: dates.slice().sort(), status: plots.every(p => p.ndvi == null) ? "no_data" : "measured",
      valid_fraction: vN ? +(vSum / vN).toFixed(3) : 0, plots };
  }

  /**
   * Сравнение двух лет по участкам. cur и prev — { year, dates, plots: [{ id, ndvi, water_ha }] }.
   * Изменение NDVI меньше NDVI_SAME_PCT % считается «без изменений» (разные даты и облака дают шум такого порядка).
   * Сравнение ненадёжно, если в каком-то году меньше minDates безоблачных дат или общих участков с NDVI меньше половины.
   */
  const NDVI_SAME_PCT = 5;
  function compareSeasons(cur, prev, { minDates = 4 } = {}) {
    const byId = Object.fromEntries((prev.plots || []).map(p => [p.id, p]));
    const plots = (cur.plots || []).map(c => {
      const p = byId[c.id] || {};
      const n0 = p.ndvi ?? null, n1 = c.ndvi ?? null, w0 = p.water_ha ?? null, w1 = c.water_ha ?? null;
      const pct = n0 != null && n1 != null && n0 > 0 ? Math.round((n1 - n0) / n0 * 100) : null;
      return { id: c.id, ndvi: [n0, n1], ndvi_change_pct: pct,
        trend: pct == null ? null : pct >= NDVI_SAME_PCT ? "greener" : pct <= -NDVI_SAME_PCT ? "browner" : "same",
        water_ha: [w0, w1], water_change_ha: w0 != null && w1 != null ? +(w1 - w0).toFixed(1) : null };
    });
    const both = plots.filter(p => p.ndvi_change_pct != null);
    const s = both.map(p => p.ndvi_change_pct).sort((a, b) => a - b), m = s.length >> 1;
    const sumW = i => { const xs = plots.map(p => p.water_ha[i]).filter(v => v != null); return xs.length ? +xs.reduce((a, b) => a + b, 0).toFixed(1) : null; };
    const reasons = [];
    if ((prev.dates || []).length < minDates) reasons.push(`prev_dates:${(prev.dates || []).length}`);
    if ((cur.dates || []).length < minDates) reasons.push(`cur_dates:${(cur.dates || []).length}`);
    if (both.length < plots.length / 2) reasons.push(`plots:${both.length}/${plots.length}`);
    return { years: [prev.year, cur.year], dates: [(prev.dates || []).length, (cur.dates || []).length], reliable: !reasons.length, reasons,
      threshold_pct: NDVI_SAME_PCT, plots,
      summary: { ndvi_median_change_pct: s.length ? (s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)) : null,
        greener: both.filter(p => p.trend === "greener").length, browner: both.filter(p => p.trend === "browner").length,
        same: both.filter(p => p.trend === "same").length, water_total_ha: [sumW(0), sumW(1)] } };
  }
  function medianComposite(per, N) {
    const out = new Float32Array(N).fill(NaN), buf = [];
    for (let i = 0; i < N; i++) {
      buf.length = 0;
      for (const nd of per) if (!Number.isNaN(nd[i])) buf.push(nd[i]);
      if (!buf.length) continue;
      buf.sort((a, b) => a - b);
      const m = buf.length >> 1;
      out[i] = buf.length % 2 ? buf[m] : (buf[m - 1] + buf[m]) / 2;
    }
    return out;
  }

  /** Для каждого пикселя — номер участка (0..15) или −1; площадь пикселя в га. */
  function plotIndex(lat, lon, bbox) {
    const [kx, ky] = kmPerDeg(lat);
    const idx = new Int8Array(SIZE * SIZE).fill(-1);
    for (let row = 0; row < SIZE; row++) {
      const dy = (bbox[3] - (row + 0.5) * (bbox[3] - bbox[1]) / SIZE - lat) * ky;
      for (let col = 0; col < SIZE; col++) {
        const dx = (bbox[0] + (col + 0.5) * (bbox[2] - bbox[0]) / SIZE - lon) * kx;
        const r = Math.hypot(dx, dy);
        const ring = r >= 0.5 && r < 3 ? 0 : r >= 3 && r < 8 ? 1 : -1;
        if (ring < 0) continue;
        let az = Math.atan2(dx, dy) * 180 / Math.PI; if (az < 0) az += 360;
        idx[row * SIZE + col] = ring * 8 + Math.round(az / 45) % 8;
      }
    }
    const pxHa = ((bbox[2] - bbox[0]) * kx / SIZE) * ((bbox[3] - bbox[1]) * ky / SIZE) * 100;
    return { idx, pxHa };
  }

  /** Средний NDVI по пастбищным пикселям каждого участка, число валидных пикселей и их доля. */
  function plotMeans(nd, land, idx) {
    const acc = Array.from({ length: 16 }, () => ({ past: 0, sum: 0, n: 0 }));
    for (let i = 0; i < nd.length; i++) {
      const k = idx[i];
      if (k < 0 || classifyLandcover(land[i]) !== "pasture") continue;
      const a = acc[k]; a.past++;
      if (!Number.isNaN(nd[i])) { a.sum += nd[i]; a.n++; }
    }
    return acc.map(a => ({ ndvi: a.n ? +(a.sum / a.n).toFixed(3) : null, valid: a.past ? a.n / a.past : 0, n: a.n }));
  }
  /**
   * Состав площади по классам WorldCover. inside — маска (1 = внутри), pxHa — площадь пикселя в га.
   * Возвращает площади пригодного, исключённого и неопределённого покрова и разбивку по классам.
   */
  function landcoverComposition(land, inside, pxHa) {
    const counts = {};
    let n = 0;
    for (let i = 0; i < land.length; i++) {
      if (inside && !inside[i]) continue;
      n++; counts[land[i]] = (counts[land[i]] || 0) + 1;
    }
    const by_class = Object.keys(counts).map(Number).sort((a, b) => a - b).map(code => ({
      code, name: (LANDCOVER[code] || { name: code === 0 ? "нет данных" : "неизвестный класс " + code }).name,
      category: classifyLandcover(code), ha: +(counts[code] * pxHa).toFixed(2), share: +(counts[code] / n).toFixed(4) }));
    const sum = cat => +by_class.filter(c => c.category === cat).reduce((s, c) => s + c.ha, 0).toFixed(2);
    return { total_ha: +(n * pxHa).toFixed(2), pasture_ha: sum("pasture"), excluded_ha: sum("excluded"), uncertain_ha: sum("uncertain"),
      water_ha: +((counts[WC_WATER] || 0) * pxHa).toFixed(2), by_class, pixels: n };
  }

  /**
   * Главная функция. Возвращает объект как web/data/plots.js:
   * { village, bbox, source, plots: [{ id, ring, dir, dist_km, geometry, area_ha, pasture_ha, ndvi, series, water, water_source }] }
   * + grid (NDVI и маска пастбищ) для картинки слоя.
   */
  async function buildVillage({ name, lat, lon, year, onProgress }) {
    const say = m => onProgress && onProgress(m);
    year = year || summerYear();
    const bbox = bboxFor(lat, lon);
    const N = SIZE * SIZE;

    say("Ищу безоблачные снимки Sentinel-2…");
    let scenes = await findScenes(bbox, year);
    if (scenes.length < 2) { year -= 1; scenes = await findScenes(bbox, year); }
    if (!scenes.length) throw new Error("Нет безоблачных летних снимков для этого места");

    say(`Загружаю ${scenes.length} снимков и карту покрытия земли…`);
    const [raw, land] = await Promise.all([Promise.all(scenes.map(it => sceneData(bbox, it))), loadLand(bbox)]);
    const d0 = scenes.map(s => s.properties.datetime.slice(0, 10));
    const { per, dates } = mergeSameDate(raw.map(x => x.nd), d0);
    const { per: scls } = mergeSameDate(raw.map(x => x.scl), d0, v => v === 0);

    say("Считаю NDVI и пастбища…");
    const ndvi = medianComposite(per, N);

    const plots = makePlots(lat, lon);
    const { idx, pxHa } = plotIndex(lat, lon, bbox);
    const acc = plots.map(() => ({ all: 0, past: 0, water: 0, excl: 0, unc: 0 }));
    const pasture = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const cat = classifyLandcover(land[i]);
      pasture[i] = cat === "pasture" ? 1 : 0;
      if (idx[i] < 0) continue;
      const a = acc[idx[i]];
      a.all++; if (cat === "pasture") a.past++; else if (cat === "excluded") a.excl++; else a.unc++;
      if (land[i] === WC_WATER) a.water++;
    }
    const med = plotMeans(ndvi, land, idx);
    const perPlot = per.map(nd => plotMeans(nd, land, idx));
    const water = plotWater(scls, idx, pxHa);
    let vSum = 0, vN = 0;
    plots.forEach((p, k) => {
      const a = acc[k];
      p.area_ha = Math.round(a.all * pxHa);
      p.pasture_ha = Math.round(a.past * pxHa);
      p.excluded_ha = Math.round(a.excl * pxHa);
      p.uncertain_ha = Math.round(a.unc * pxHa);
      p.ndvi = med[k].ndvi;
      p.ndvi_base = null;
      p.valid_fraction = +med[k].valid.toFixed(3);
      p.samples = med[k].n;
      p.px_ha = +pxHa.toFixed(4);
      if (a.past) { vSum += med[k].valid * a.past; vN += a.past; }
      // NDVI участка на каждом снимке (если облака закрыли меньше половины пастбища)
      p.series = dates.map((d, j) => ({ d, v: perPlot[j][k].valid >= 0.5 ? perPlot[j][k].ndvi : null }))
        .filter(x => x.v != null).sort((x, y) => x.d < y.d ? -1 : 1);
      p.obs_count = p.series.length;
      p.water_px = a.water;
      // вода, видимая на снимках этого лета (SCL): для сравнения с прошлым годом; статус водопоя ниже не меняется
      p.water_obs_ha = water[k].water_ha; p.water_obs_max_ha = water[k].water_max_ha;
      // вода: у села — допущение модели; дальний участок — водоём на карте (это ещё не пригодный водопой); иначе — нет информации
      p.water_status = p.ring === "near" ? "assumed" : (a.water * pxHa >= 0.5 ? "satellite" : "unknown");
      p.water = p.water_status !== "unknown";
      p.water_source = p.ring === "near" ? "село" : (p.water ? "водоём на карте WorldCover" : "нет");
    });
    const warnings = [];
    if (dates.length < 4) warnings.push(`Безоблачных дат мало: ${dates.length}.`);
    if (scenes.length > dates.length) warnings.push(`Тайлы одной даты склеены: ${scenes.length} сцен → ${dates.length} наблюдений.`);
    const noData = plots.filter(p => p.ndvi == null).map(p => p.id);
    if (noData.length) warnings.push("Нет NDVI для участков: " + noData.join(", ") + ".");
    const valid = vN ? vSum / vN : 0;

    return {
      village: { name, lat, lon },
      bbox,
      source: {
        ndvi: "Sentinel-2 L2A (ESA Copernicus), медиана безоблачных снимков лета",
        landcover: "ESA WorldCover 10 м",
        base_year: null, year, dates, window: scenes.window || null, calculated_at: new Date().toISOString(),
      },
      meta: metaFor({ year, dates, valid, warnings, status: noData.length === plots.length ? "no_data" : "measured" }),
      plots,
      grid: { size: SIZE, ndvi, pasture },
    };
  }

  function metaFor({ year, dates, valid, warnings, status }) {
    return {
      source: "Microsoft Planetary Computer", dataset: "Sentinel-2 L2A", year, scene_dates: dates.slice().sort(),
      imagery_count: dates.length, valid_pixel_fraction: +(+valid || 0).toFixed(3),
      landcover_source: "ESA WorldCover 10 м", landcover_year: LANDCOVER_YEAR,
      calculated_at: new Date().toISOString(), model_version: MODEL_VERSION, data_status: status, warnings,
    };
  }

  /**
   * Мониторинг: самый свежий снимок новее `after` (YYYY-MM-DD) за последние `days` дней.
   * Возвращает { id, date, cloud, plots: { "Д-С": { ndvi, valid } } } или null, если нового снимка нет.
   */
  async function latestScene({ lat, lon, after, now = new Date(), days = 20 }) {
    const bbox = bboxFor(lat, lon);
    const from = new Date(now - days * 864e5).toISOString().slice(0, 10);
    const items = (await stac({
      collections: ["sentinel-2-l2a"], bbox, datetime: `${from}/${now.toISOString().slice(0, 10)}T23:59:59Z`,
      query: { "eo:cloud_cover": { lt: 60 } }, limit: 30,
    })).filter(it => !after || String(it.properties.datetime).slice(0, 10) > after);
    const items2 = sanitizeScenes(items, { now }).items.sort((a, b) => a.properties.datetime < b.properties.datetime ? 1 : -1);
    if (!items2.length) return null;
    const it = items2[0];
    const [nd, land] = await Promise.all([sceneNdvi(bbox, it), loadLand(bbox)]);
    const means = plotMeans(nd, land, plotIndex(lat, lon, bbox).idx);
    const plots = {};
    makePlots(lat, lon).forEach((p, k) => { plots[p.id] = means[k]; });
    return { id: it.id, date: it.properties.datetime.slice(0, 10), cloud: it.properties["eo:cloud_cover"], plots };
  }

  // ---------- своё пастбище: контур, нарисованный фермером ----------
  // Внутри своего контура действуют те же правила классификации, что и для села (classifyLandcover).

  /** Площадь многоугольника [[lon,lat],…] в гектарах (локальная проекция, точность ~0.5 % для участков до 30 км). */
  function polygonAreaHa(ring) {
    const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const [kx, ky] = kmPerDeg(lat0);
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] * kx) * (ring[i][1] * ky) - (ring[i][0] * kx) * (ring[j][1] * ky);
    return Math.abs(a / 2) * 100;
  }
  function closeRing(ring) {
    const r = ring.map(p => [+p[0], +p[1]]);
    const a = r[0], b = r[r.length - 1];
    if (a[0] !== b[0] || a[1] !== b[1]) r.push([a[0], a[1]]);
    return r;
  }
  /** Есть ли у контура самопересечение (несмежные рёбра пересекаются). ring замкнут. */
  function ringSelfIntersects(ring) {
    const n = ring.length - 1;
    const orient = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    const onSeg = (a, b, c) => Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);
    const cross = (p1, p2, p3, p4) => {
      const d1 = orient(p3, p4, p1), d2 = orient(p3, p4, p2), d3 = orient(p1, p2, p3), d4 = orient(p1, p2, p4);
      if (d1 !== d2 && d3 !== d4 && d1 && d2 && d3 && d4) return true;
      return (d1 === 0 && onSeg(p3, p4, p1)) || (d2 === 0 && onSeg(p3, p4, p2)) || (d3 === 0 && onSeg(p1, p2, p3)) || (d4 === 0 && onSeg(p1, p2, p4));
    };
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (j === i || j === i + 1 || (i === 0 && j === n - 1)) continue;   // соседние рёбра делят вершину
      if (cross(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
    }
    return false;
  }
  function checkRing(ring) {
    if (!Array.isArray(ring) || ring.length < 4) throw new Error("нужно минимум 3 точки");
    if (ring.length > 201) throw new Error("слишком много точек (максимум 200)");
    if (!ring.every(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90))
      throw new Error("неверные координаты");
    const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
    const [kx, ky] = kmPerDeg(ys[0]);
    if ((Math.max(...xs) - Math.min(...xs)) * kx > 30 || (Math.max(...ys) - Math.min(...ys)) * ky > 30) throw new Error("участок больше 30 км — разбейте его на части");
    if (ringSelfIntersects(ring)) throw new Error("границы пересекают сами себя — нарисуйте контур без «восьмёрки»");
    const ha = polygonAreaHa(ring);
    if (ha < 1) throw new Error("участок меньше 1 га");
    return ha;
  }
  function ringBbox(ring) {
    const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
    const mx = (Math.max(...xs) - Math.min(...xs)) * 0.04 + 0.0005, my = (Math.max(...ys) - Math.min(...ys)) * 0.04 + 0.0005;
    return [Math.min(...xs) - mx, Math.min(...ys) - my, Math.max(...xs) + mx, Math.max(...ys) + my].map(v => +v.toFixed(6));
  }
  function insideMask(ring, bbox) {
    const m = new Uint8Array(SIZE * SIZE);
    for (let row = 0; row < SIZE; row++) {
      const y = bbox[3] - (row + 0.5) * (bbox[3] - bbox[1]) / SIZE;
      for (let col = 0; col < SIZE; col++) {
        const x = bbox[0] + (col + 0.5) * (bbox[2] - bbox[0]) / SIZE;
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i], [xj, yj] = ring[j];
          if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
        m[row * SIZE + col] = inside ? 1 : 0;
      }
    }
    return m;
  }
  /** Средний NDVI по пастбищным пикселям внутри контура (те же классы, что у села). */
  function maskedMean(nd, inside, land) {
    let sum = 0, n = 0, all = 0;
    for (let i = 0; i < nd.length; i++) {
      if (!inside[i] || classifyLandcover(land[i]) !== "pasture") continue;
      all++;
      if (!Number.isNaN(nd[i])) { sum += nd[i]; n++; }
    }
    return { ndvi: n ? +(sum / n).toFixed(3) : null, valid: all ? n / all : 0, n };
  }

  /**
   * Статистика по контуру, нарисованному фермером: площадь, NDVI (медиана безоблачных летних снимков),
   * NDVI по каждому снимку, доля «пастбища» по ESA WorldCover (для справки), есть ли вода на карте.
   */
  async function polygonStats({ ring, year, onProgress }) {
    const say = m => onProgress && onProgress(m);
    ring = closeRing(ring);
    const area = checkRing(ring);
    const bbox = ringBbox(ring);
    year = year || summerYear();
    say("Ищу безоблачные снимки Sentinel-2…");
    let scenes = await findScenes(bbox, year);
    if (scenes.length < 2) { year -= 1; scenes = await findScenes(bbox, year); }
    say(scenes.length ? `Загружаю ${scenes.length} снимков и карту покрытия земли…` : "Снимков нет, загружаю карту покрытия земли…");
    const [rawPer, land] = await Promise.all([Promise.all(scenes.map(it => sceneNdvi(bbox, it))), loadLand(bbox)]);
    const { per, dates } = mergeSameDate(rawPer, scenes.map(s => s.properties.datetime.slice(0, 10)));
    say("Считаю NDVI внутри участка…");
    return polygonFromArrays({ ring, area, bbox, per, dates, land, year });
  }
  /** Вычислительная часть polygonStats без сети (для проверки и тестов). */
  function polygonFromArrays({ ring, area, bbox, per, dates, land, year }) {
    const inside = insideMask(ring, bbox);
    const N = SIZE * SIZE;
    let inN = 0;
    for (let i = 0; i < N; i++) if (inside[i]) inN++;
    if (inN < 4) throw new Error("участок слишком маленький для снимка 10 м");
    const pxHa = area / inN;
    const comp = landcoverComposition(land, inside, pxHa);
    const med = medianComposite(per, N);
    const series = per.map((nd, j) => { const r = maskedMean(nd, inside, land); return { d: dates[j], v: r.valid >= 0.5 ? r.ndvi : null }; })
      .filter(x => x.v != null).sort((x, y) => x.d < y.d ? -1 : 1);
    const mm = per.length ? maskedMean(med, inside, land) : { ndvi: null, valid: 0, n: 0 };
    const warnings = [];
    if (!per.length) warnings.push("Нет безоблачных летних снимков: NDVI неизвестен.");
    else if (mm.valid < 0.5) warnings.push(`Валидными пикселями покрыто ${Math.round(mm.valid * 100)} % пастбищной площади.`);
    if (comp.pasture_ha <= 0) warnings.push("Внутри контура нет пастбищного покрова по ESA WorldCover.");
    if (comp.uncertain_ha > 0) warnings.push(`Неопределённый покров: ${comp.uncertain_ha} га (нужна проверка на месте).`);
    const status = !per.length || mm.ndvi == null ? "no_data" : "measured";
    return {
      area_ha: Math.round(area * 10) / 10,
      pasture_ha: Math.round(comp.pasture_ha * 10) / 10,   // только пастбищный покров WorldCover (те же классы, что у села)
      excluded_ha: Math.round(comp.excluded_ha * 10) / 10,
      uncertain_ha: Math.round(comp.uncertain_ha * 10) / 10,
      landcover: comp.by_class,
      wc_pasture_share: comp.total_ha ? +(comp.pasture_ha / comp.total_ha).toFixed(2) : 0,
      water_on_map: comp.water_ha >= 0.2,
      ndvi: mm.ndvi, valid_fraction: +mm.valid.toFixed(3), samples: mm.n, obs_count: series.length,
      series, dates, year,
      meta: metaFor({ year, dates, valid: mm.valid, warnings, status }),
    };
  }

  /** Мониторинг своего пастбища: NDVI на самом свежем снимке новее `after`, или null. */
  async function latestPolygonScene({ ring, after, now = new Date(), days = 20 }) {
    ring = closeRing(ring);
    const bbox = ringBbox(ring);
    const from = new Date(now - days * 864e5).toISOString().slice(0, 10);
    const items = (await stac({
      collections: ["sentinel-2-l2a"], bbox, datetime: `${from}/${now.toISOString().slice(0, 10)}T23:59:59Z`,
      query: { "eo:cloud_cover": { lt: 60 } }, limit: 30,
    })).filter(it => !after || String(it.properties.datetime).slice(0, 10) > after);
    const items2 = sanitizeScenes(items, { now }).items.sort((a, b) => a.properties.datetime < b.properties.datetime ? 1 : -1);
    if (!items2.length) return null;
    const it = items2[0];
    const [nd, land] = await Promise.all([sceneNdvi(bbox, it), loadLand(bbox)]);
    const r = maskedMean(nd, insideMask(ring, bbox), land);
    return { id: it.id, date: it.properties.datetime.slice(0, 10), cloud: it.properties["eo:cloud_cover"], ndvi: r.ndvi, valid: r.valid };
  }

  // Код участка для ссылок и кнопок Telegram (только латиница): "Д-С" ↔ "F0"
  function plotCode(id) { const [r, d] = id.split("-"); return (r === "Б" ? "N" : "F") + DIRS.indexOf(d); }
  function plotFromCode(code) {
    const m = /^([NF])([0-7])$/.exec(code || "");
    return m ? (m[1] === "N" ? "Б" : "Д") + "-" + DIRS[+m[2]] : null;
  }

  return { geocode, reverseGeocode, buildVillage, buildSeason, buildYears, fetchPrecip, precipByYear, seasonFromArrays, compareSeasons, plotWater, sclFromBands, NDVI_SAME_PCT, latestScene, polygonStats, latestPolygonScene, polygonAreaHa, closeRing, checkRing, ringSelfIntersects,
    plotCode, plotFromCode, bboxFor, makePlots, setUserAgent, summerYear, SIZE,
    LANDCOVER, LANDCOVER_YEAR, SCL_OK, SCL_NAMES, classifyLandcover, landcoverComposition, sanitizeScenes, pickScenes, boaOffset, ndviFromBands,
    mergeSameDate, medianComposite, fetchRetry, plotMeans, maskedMean, insideMask, ringBbox, polygonFromArrays, plotIndex, metaFor };
});
