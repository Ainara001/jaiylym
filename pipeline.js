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

  /**
   * Главная функция. Возвращает объект как web/data/plots.js:
   * { village, bbox, source, plots: [{ id, ring, dir, dist_km, geometry, area_ha, pasture_ha, ndvi, water, water_source }] }
   * + ndviGrid (Float32Array SIZE×SIZE) и pastureGrid для картинки слоя.
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
    const wcItems = (await stac({ collections: ["esa-worldcover"], bbox, limit: 10 }))
      .filter((f, _, all) => f.id.includes("2021") || !all.some(g => g.id.includes("2021")));

    const [s2, wc] = await Promise.all([
      Promise.all(scenes.map(it => raster(bbox, "sentinel-2-l2a", it.id, ["B04", "B08", "SCL"]).then(r => ({ r, it })))),
      Promise.all(wcItems.map(it => raster(bbox, "esa-worldcover", it.id, ["map"]))),
    ]);

    say("Считаю NDVI и пастбища…");
    // покрытие земли: склеиваем тайлы по маске
    const land = new Uint8Array(N);
    for (const { data } of wc) for (let i = 0; i < N; i++) if (!land[i] && data[N + i]) land[i] = data[i];

    // NDVI по каждому снимку
    const per = s2.map(({ r, it }) => {
      const d = r.data, off = (it.properties["s2:processing_baseline"] || "00.00") >= "04.00" ? 1000 : 0;
      const nd = new Float32Array(N).fill(NaN);
      for (let i = 0; i < N; i++) {
        if (!d[3 * N + i] || !SCL_OK.includes(d[2 * N + i])) continue;
        const red = d[i] - off, nir = d[N + i] - off;
        if (red <= 0 || nir <= 0) continue;
        nd[i] = (nir - red) / (nir + red);
      }
      return nd;
    });
    // медиана
    const ndvi = new Float32Array(N).fill(NaN), buf = [];
    for (let i = 0; i < N; i++) {
      buf.length = 0;
      for (const nd of per) if (!Number.isNaN(nd[i])) buf.push(nd[i]);
      if (!buf.length) continue;
      buf.sort((a, b) => a - b);
      const m = buf.length >> 1;
      ndvi[i] = buf.length % 2 ? buf[m] : (buf[m - 1] + buf[m]) / 2;
    }

    // участки: для каждого пикселя — кольцо и направление
    const plots = makePlots(lat, lon);
    const [kx, ky] = kmPerDeg(lat);
    const pxKmX = (bbox[2] - bbox[0]) * kx / SIZE, pxKmY = (bbox[3] - bbox[1]) * ky / SIZE;
    const pxHa = pxKmX * pxKmY * 100;
    const acc = plots.map(() => ({ all: 0, past: 0, sum: 0, n: 0, water: 0 }));
    const pasture = new Uint8Array(N);
    for (let row = 0; row < SIZE; row++) {
      const dy = (bbox[3] - (row + 0.5) * (bbox[3] - bbox[1]) / SIZE - lat) * ky;
      for (let col = 0; col < SIZE; col++) {
        const i = row * SIZE + col;
        const isPast = WC_PASTURE.includes(land[i]);
        pasture[i] = isPast ? 1 : 0;
        const dx = (bbox[0] + (col + 0.5) * (bbox[2] - bbox[0]) / SIZE - lon) * kx;
        const r = Math.hypot(dx, dy);
        const ringIdx = r >= 0.5 && r < 3 ? 0 : r >= 3 && r < 8 ? 1 : -1;
        if (ringIdx < 0) continue;
        let az = Math.atan2(dx, dy) * 180 / Math.PI; if (az < 0) az += 360;
        const k = ringIdx * 8 + Math.round(az / 45) % 8;
        const a = acc[k];
        a.all++;
        if (land[i] === WC_WATER) a.water++;
        if (isPast) { a.past++; if (!Number.isNaN(ndvi[i])) { a.sum += ndvi[i]; a.n++; } }
      }
    }
    plots.forEach((p, k) => {
      const a = acc[k];
      p.area_ha = Math.round(a.all * pxHa);
      p.pasture_ha = Math.round(a.past * pxHa);
      p.ndvi = a.n ? +(a.sum / a.n).toFixed(3) : null;
      p.ndvi_base = null;
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
        base_year: null, year,
        dates: scenes.map(s => s.properties.datetime.slice(0, 10)),
      },
      plots,
      grid: { size: SIZE, ndvi, pasture },
    };
  }

  return { geocode, buildVillage, bboxFor, makePlots, setUserAgent, summerYear, SIZE };
});
