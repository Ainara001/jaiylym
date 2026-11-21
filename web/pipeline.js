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
  const WC_PASTURE = [20, 30, 60];   // кустарник, трава, редкая растительность
  const WC_WATER = 80;
  const SCL_OK = [4, 5];             // растительность, голая почва (без облаков/теней/снега)

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

  function makePlots(lat, lon) {
    const out = [];
    for (const [r1, r2, code, ring] of RINGS)
      DIRS.forEach((d, i) => out.push({
        id: `${code}-${d}`, ring, dir: d, dist_km: +((r1 + r2) / 2).toFixed(1),
        geometry: sector(lat, lon, r1, r2, i * 45 - 22.5, i * 45 + 22.5),
      }));
    return out;
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
    const r = await fetch(STAC, { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify(body) });
    if (!r.ok) throw new Error("Каталог снимков недоступен (" + r.status + ")");
    return (await r.json()).features || [];
  }

  async function raster(bbox, collection, item, assets) {
    const q = `collection=${collection}&item=${encodeURIComponent(item)}&${assets.map(a => "assets=" + a).join("&")}&dst_crs=epsg:4326`;
    const r = await fetch(`${DATA}/${bbox.join(",")}/${SIZE}x${SIZE}.npy?${q}`, { headers: headers() });
    if (!r.ok) throw new Error("Снимок не загрузился (" + r.status + ")");
    return parseNpy(await r.arrayBuffer());
  }

  function summerYear(now = new Date()) {
    return now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;   // с сентября — текущее лето
  }

  async function findScenes(bbox, year) {
    for (const [cloud, from, to] of [[20, "06-01", "08-31"], [40, "05-15", "09-15"]]) {
      const items = await stac({
        collections: ["sentinel-2-l2a"], bbox, datetime: `${year}-${from}/${year}-${to}`,
        query: { "eo:cloud_cover": { lt: cloud } }, limit: 60,
      });
      if (items.length >= 2) return items.sort((a, b) => a.properties["eo:cloud_cover"] - b.properties["eo:cloud_cover"]).slice(0, 6);
    }
    return [];
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

  async function sceneNdvi(bbox, it) {
    const N = SIZE * SIZE;
    const { data: d } = await raster(bbox, "sentinel-2-l2a", it.id, ["B04", "B08", "SCL"]);
    // с processing baseline 04.00 (2022+) ESA добавляет к отражению +1000
    const off = (it.properties["s2:processing_baseline"] || "00.00") >= "04.00" ? 1000 : 0;
    const nd = new Float32Array(N).fill(NaN);
    for (let i = 0; i < N; i++) {
      if (!d[3 * N + i] || !SCL_OK.includes(d[2 * N + i])) continue;
      const red = d[i] - off, nir = d[N + i] - off;
      if (red <= 0 || nir <= 0) continue;
      nd[i] = (nir - red) / (nir + red);
    }
    return nd;
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

  /** Средний NDVI по пастбищным пикселям каждого участка и доля пикселей без облаков. */
  function plotMeans(nd, land, idx) {
    const acc = Array.from({ length: 16 }, () => ({ past: 0, sum: 0, n: 0 }));
    for (let i = 0; i < nd.length; i++) {
      const k = idx[i];
      if (k < 0 || !WC_PASTURE.includes(land[i])) continue;
      const a = acc[k]; a.past++;
      if (!Number.isNaN(nd[i])) { a.sum += nd[i]; a.n++; }
    }
    return acc.map(a => ({ ndvi: a.n ? +(a.sum / a.n).toFixed(3) : null, valid: a.past ? a.n / a.past : 0 }));
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
    const [per, land] = await Promise.all([Promise.all(scenes.map(it => sceneNdvi(bbox, it))), loadLand(bbox)]);

    say("Считаю NDVI и пастбища…");
    const ndvi = new Float32Array(N).fill(NaN), buf = [];   // медиана по снимкам
    for (let i = 0; i < N; i++) {
      buf.length = 0;
      for (const nd of per) if (!Number.isNaN(nd[i])) buf.push(nd[i]);
      if (!buf.length) continue;
      buf.sort((a, b) => a - b);
      const m = buf.length >> 1;
      ndvi[i] = buf.length % 2 ? buf[m] : (buf[m - 1] + buf[m]) / 2;
    }

    const plots = makePlots(lat, lon);
    const { idx, pxHa } = plotIndex(lat, lon, bbox);
    const acc = plots.map(() => ({ all: 0, past: 0, water: 0 }));
    const pasture = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const isPast = WC_PASTURE.includes(land[i]);
      pasture[i] = isPast ? 1 : 0;
      if (idx[i] < 0) continue;
      const a = acc[idx[i]];
      a.all++; if (isPast) a.past++; if (land[i] === WC_WATER) a.water++;
    }
    const med = plotMeans(ndvi, land, idx);
    const perPlot = per.map(nd => plotMeans(nd, land, idx));
    const dates = scenes.map(s => s.properties.datetime.slice(0, 10));
    plots.forEach((p, k) => {
      const a = acc[k];
      p.area_ha = Math.round(a.all * pxHa);
      p.pasture_ha = Math.round(a.past * pxHa);
      p.ndvi = med[k].ndvi;
      p.ndvi_base = null;
      // NDVI участка на каждом снимке (если облака закрыли меньше половины пастбища)
      p.series = dates.map((d, j) => ({ d, v: perPlot[j][k].valid >= 0.5 ? perPlot[j][k].ndvi : null }))
        .filter(x => x.v != null).sort((x, y) => x.d < y.d ? -1 : 1);
      p.water_px = a.water;
      p.water = p.ring === "near" || a.water * pxHa >= 0.5;
      p.water_source = p.ring === "near" ? "село" : (p.water ? "водоём на карте WorldCover" : "нет");
    });

    return {
      village: { name, lat, lon },
      bbox,
      source: {
        ndvi: "Sentinel-2 L2A (ESA Copernicus), медиана безоблачных снимков лета",
        landcover: "ESA WorldCover 10 м",
        base_year: null, year, dates,
      },
      plots,
      grid: { size: SIZE, ndvi, pasture },
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
    })).filter(it => !after || it.properties.datetime.slice(0, 10) > after)
      .sort((a, b) => a.properties.datetime < b.properties.datetime ? 1 : -1);
    if (!items.length) return null;
    const it = items[0];
    const [nd, land] = await Promise.all([sceneNdvi(bbox, it), loadLand(bbox)]);
    const means = plotMeans(nd, land, plotIndex(lat, lon, bbox).idx);
    const plots = {};
    makePlots(lat, lon).forEach((p, k) => { plots[p.id] = means[k]; });
    return { id: it.id, date: it.properties.datetime.slice(0, 10), cloud: it.properties["eo:cloud_cover"], plots };
  }

  // ---------- своё пастбище: контур, нарисованный фермером ----------
  const WC_EXCLUDE = [50, 80];        // застройка и вода — не корм; остальное внутри контура фермер считает пастбищем

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
  function checkRing(ring) {
    if (!Array.isArray(ring) || ring.length < 4) throw new Error("нужно минимум 3 точки");
    if (ring.length > 201) throw new Error("слишком много точек (максимум 200)");
    if (!ring.every(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90))
      throw new Error("неверные координаты");
    const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
    const [kx, ky] = kmPerDeg(ys[0]);
    if ((Math.max(...xs) - Math.min(...xs)) * kx > 30 || (Math.max(...ys) - Math.min(...ys)) * ky > 30) throw new Error("участок больше 30 км — разбейте его на части");
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
  function maskedMean(nd, inside, land) {
    let sum = 0, n = 0, all = 0;
    for (let i = 0; i < nd.length; i++) {
      if (!inside[i] || WC_EXCLUDE.includes(land[i])) continue;
      all++;
      if (!Number.isNaN(nd[i])) { sum += nd[i]; n++; }
    }
    return { ndvi: n ? +(sum / n).toFixed(3) : null, valid: all ? n / all : 0 };
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
    if (!scenes.length) throw new Error("Нет безоблачных летних снимков для этого места");
    say(`Загружаю ${scenes.length} снимков и карту покрытия земли…`);
    const [per, land] = await Promise.all([Promise.all(scenes.map(it => sceneNdvi(bbox, it))), loadLand(bbox)]);
    say("Считаю NDVI внутри участка…");
    const inside = insideMask(ring, bbox);
    const N = SIZE * SIZE, buf = [];
    const med = new Float32Array(N).fill(NaN);
    let inN = 0, usable = 0, pasture = 0, water = 0;
    for (let i = 0; i < N; i++) {
      if (!inside[i]) continue;
      inN++;
      if (!WC_EXCLUDE.includes(land[i])) usable++;
      if (WC_PASTURE.includes(land[i])) pasture++;
      if (land[i] === WC_WATER) water++;
      buf.length = 0;
      for (const nd of per) if (!Number.isNaN(nd[i])) buf.push(nd[i]);
      if (!buf.length) continue;
      buf.sort((a, b) => a - b);
      const m = buf.length >> 1;
      med[i] = buf.length % 2 ? buf[m] : (buf[m - 1] + buf[m]) / 2;
    }
    if (inN < 4) throw new Error("участок слишком маленький для снимка 10 м");
    const dates = scenes.map(s => s.properties.datetime.slice(0, 10));
    const series = per.map((nd, j) => { const r = maskedMean(nd, inside, land); return { d: dates[j], v: r.valid >= 0.5 ? r.ndvi : null }; })
      .filter(x => x.v != null).sort((x, y) => x.d < y.d ? -1 : 1);
    const pxHa = area / inN;
    return {
      area_ha: Math.round(area * 10) / 10,
      pasture_ha: Math.round(usable * pxHa * 10) / 10,       // площадь без застройки и воды
      wc_pasture_share: +(pasture / inN).toFixed(2),          // доля, которую WorldCover считает травой/кустарником
      water_on_map: water * pxHa >= 0.2,
      ndvi: maskedMean(med, inside, land).ndvi,
      series, dates, year,
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
    })).filter(it => !after || it.properties.datetime.slice(0, 10) > after)
      .sort((a, b) => a.properties.datetime < b.properties.datetime ? 1 : -1);
    if (!items.length) return null;
    const it = items[0];
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

  return { geocode, buildVillage, latestScene, polygonStats, latestPolygonScene, polygonAreaHa, closeRing, plotCode, plotFromCode, bboxFor, makePlots, setUserAgent, summerYear, SIZE };
});
