/*
 * Jaiylym — где нельзя пасти: города, сёла, фермы, промзоны (OpenStreetMap) с буфером вокруг.
 * Работает в браузере и в Node (бот, скрипты, тесты), без ключей.
 *
 *  1. Запрос к Overpass API по рамке села: жилые кварталы и населённые пункты (landuse=residential, place=*),
 *     фермы и скотные дворы (landuse=farmyard, building=farm|barn|cowshed|stable|sty|farm_auxiliary),
 *     промзоны и стройки, кладбища, военные объекты.
 *  2. Многоугольники → сетка пастбищ (та же, что у ESA WorldCover в pipeline.js, ~50 м): пиксель в зоне, если его центр
 *     внутри многоугольника или в нём лежит вершина (так не теряются мелкие фермы). Населённый пункт, у которого в OSM
 *     есть только точка, — круг с радиусом по типу места (оценка, помечается).
 *  3. Буфер вокруг зон (0, 100, 250, 500 м) — расстояние на сетке. Буфер — допущение (санитарный разрыв), уточняется
 *     по правилам содержания животных акимата.
 *  4. По каждому участку: площадь зон всего и на пастбищном покрове WorldCover — её вычитают из кормовой площади.
 *
 * Данные OSM — то, что нанесли картографы: где карта неполная, зон будет меньше реальных. Это не кадастр и не решение акимата.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JaiylymNoGraze = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // публичные серверы Overpass; при тайм-ауте или 429/5xx — следующий
  const MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];
  const BUFFERS = [0, 100, 250, 500];
  const DEFAULT_BUFFER = 100;
  // флаги видов зон в маске
  const KIND = { settlement: 1, farm: 2, industrial: 4, other: 8 };
  const KIND_NAMES = Object.keys(KIND);
  const LANDUSE_KIND = { residential: "settlement", commercial: "settlement", retail: "settlement", garages: "settlement",
    farmyard: "farm", industrial: "industrial", construction: "industrial", railway: "industrial", quarry: "industrial", landfill: "industrial",
    cemetery: "other", military: "other" };
  const FARM_BUILDINGS = ["farm", "barn", "cowshed", "stable", "sty", "farm_auxiliary"];
  // радиус круга, если населённый пункт в OSM есть только точкой (м) — грубая оценка по типу места
  const PLACE_RADIUS_M = { city: 2500, town: 1200, village: 500, suburb: 600, hamlet: 200, neighbourhood: 250, isolated_dwelling: 60, farm: 80 };

  let USER_AGENT = null;
  function setUserAgent(ua) { USER_AGENT = ua; }

  function overpassQuery(bbox) {
    const [w, s, e, n] = bbox, b = `(${s},${w},${n},${e})`;
    const lu = Object.keys(LANDUSE_KIND).join("|"), pl = Object.keys(PLACE_RADIUS_M).join("|"), fb = FARM_BUILDINGS.join("|");
    return `[out:json][timeout:90];(` +
      `way["landuse"~"^(${lu})$"]${b};relation["landuse"~"^(${lu})$"]${b};` +
      `way["place"~"^(${pl})$"]${b};relation["place"~"^(${pl})$"]${b};node["place"~"^(${pl})$"]${b};` +
      `way["building"~"^(${fb})$"]${b};` +
      `);out geom;`;
  }

  /** Запрос к Overpass с запасным зеркалом и повтором при 429/5xx. */
  async function fetchOSM(bbox, { fetchImpl = (typeof fetch !== "undefined" ? fetch : null), timeoutMs = 100000, retryMs = 1500, mirrors = MIRRORS } = {}) {
    const body = "data=" + encodeURIComponent(overpassQuery(bbox));
    const tried = [];
    for (let i = 0; i < mirrors.length + 1; i++) {
      const url = mirrors[i % mirrors.length], host = url.split("/")[2];
      try {
        const r = await fetchImpl(url, { method: "POST", body, signal: AbortSignal.timeout(timeoutMs),
          headers: Object.assign({ "content-type": "application/x-www-form-urlencoded" }, USER_AGENT ? { "User-Agent": USER_AGENT } : {}) });
        if (r.ok) {
          const j = await r.json();
          // Overpass при нехватке времени отдаёт 200 с пометкой remark и пустым или неполным списком
          if (j && j.remark && /timed out|runtime error|out of memory/i.test(j.remark)) { tried.push(host + ": " + j.remark.slice(0, 60)); continue; }
          return j;
        }
        tried.push(host + ": HTTP " + r.status);
      } catch (e) { tried.push(host + ": " + (e && e.name === "TimeoutError" ? "тайм-аут" : String(e && e.message || e).slice(0, 60))); }
      if (retryMs) await new Promise(res => setTimeout(res, retryMs));
    }
    throw new Error("OpenStreetMap (Overpass) не ответил — " + tried.join("; "));
  }

  // ---------- геометрия ----------
  const kmPerDeg = lat => [111.32 * Math.cos(lat * Math.PI / 180), 110.57];
  function circle(lon, lat, radiusM, steps = 24) {
    const [kx, ky] = kmPerDeg(lat), r = radiusM / 1000, out = [];
    for (let i = 0; i <= steps; i++) { const a = 2 * Math.PI * i / steps; out.push([lon + r * Math.sin(a) / kx, lat + r * Math.cos(a) / ky]); }
    return out;
  }
  const geomRing = g => (g || []).filter(p => p && Number.isFinite(p.lon) && Number.isFinite(p.lat)).map(p => [p.lon, p.lat]);

  /** Ответ Overpass → зоны [{ kind, tag, name, ring: [[lon,lat],…], point }]. Внутренние кольца не вычитаются (осторожная оценка). */
  function parseZones(osm) {
    const zones = [];
    const kindOf = tags => {
      if (!tags) return null;
      if (tags.landuse && LANDUSE_KIND[tags.landuse]) return { kind: LANDUSE_KIND[tags.landuse], tag: "landuse=" + tags.landuse };
      if (tags.building && FARM_BUILDINGS.includes(tags.building)) return { kind: "farm", tag: "building=" + tags.building };
      if (tags.place && PLACE_RADIUS_M[tags.place] != null) return { kind: tags.place === "farm" ? "farm" : "settlement", tag: "place=" + tags.place };
      return null;
    };
    for (const el of (osm && osm.elements) || []) {
      const k = kindOf(el.tags); if (!k) continue;
      const name = (el.tags && (el.tags["name:ru"] || el.tags.name)) || "";
      if (el.type === "node") {
        if (!Number.isFinite(el.lon) || !Number.isFinite(el.lat)) continue;
        zones.push(Object.assign({}, k, { name, ring: circle(el.lon, el.lat, PLACE_RADIUS_M[el.tags.place]), point: true }));
      } else if (el.type === "way") {
        const ring = geomRing(el.geometry);
        if (ring.length >= 3) zones.push(Object.assign({}, k, { name, ring, point: false }));
        else if (ring.length) zones.push(Object.assign({}, k, { name, ring, point: false }));   // линия или точка — отметим вершины
      } else if (el.type === "relation") {
        for (const m of el.members || []) if (m.role !== "inner") { const ring = geomRing(m.geometry); if (ring.length) zones.push(Object.assign({}, k, { name, ring, point: false })); }
      }
    }
    return zones;
  }

  /**
   * Зоны → маска на сетке size×size рамки bbox [w,s,e,n]: флаги видов (KIND). Пиксель отмечен, если центр внутри многоугольника
   * или в пикселе лежит вершина контура.
   */
  function rasterize(zones, bbox, size) {
    const [w, s, e, n] = bbox, mask = new Uint8Array(size * size);
    const col = x => Math.floor((x - w) / (e - w) * size), row = y => Math.floor((n - y) / (n - s) * size);
    for (const z of zones) {
      const f = KIND[z.kind] || KIND.other, ring = z.ring;
      for (const [x, y] of ring) { const c = col(x), r = row(y); if (c >= 0 && c < size && r >= 0 && r < size) mask[r * size + c] |= f; }
      if (ring.length < 3) continue;
      let r0 = size, r1 = -1, c0 = size, c1 = -1;
      for (const [x, y] of ring) { r0 = Math.min(r0, row(y)); r1 = Math.max(r1, row(y)); c0 = Math.min(c0, col(x)); c1 = Math.max(c1, col(x)); }
      r0 = Math.max(0, r0); c0 = Math.max(0, c0); r1 = Math.min(size - 1, r1); c1 = Math.min(size - 1, c1);
      for (let r = r0; r <= r1; r++) {
        const y = n - (r + 0.5) * (n - s) / size;
        // пересечения строки с рёбрами — заливка между парами
        const xs = [];
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i], [xj, yj] = ring[j];
          if ((yi > y) !== (yj > y)) xs.push(xi + (y - yi) * (xj - xi) / (yj - yi));
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const ca = Math.max(c0, Math.ceil((xs[k] - w) / (e - w) * size - 0.5)), cb = Math.min(c1, Math.floor((xs[k + 1] - w) / (e - w) * size - 0.5));
          for (let c = ca; c <= cb; c++) mask[r * size + c] |= f;
        }
      }
    }
    return mask;
  }

  /** Расстояние (в пикселях) от каждого пикселя до ближайшей зоны: двухпроходная фаска (1 и √2). */
  function distance(mask, size) {
    const INF = 1e9, d = new Float32Array(size * size), D2 = Math.SQRT2;
    for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      const i = r * size + c; let v = d[i];
      if (c > 0) v = Math.min(v, d[i - 1] + 1);
      if (r > 0) { v = Math.min(v, d[i - size] + 1); if (c > 0) v = Math.min(v, d[i - size - 1] + D2); if (c < size - 1) v = Math.min(v, d[i - size + 1] + D2); }
      d[i] = v;
    }
    for (let r = size - 1; r >= 0; r--) for (let c = size - 1; c >= 0; c--) {
      const i = r * size + c; let v = d[i];
      if (c < size - 1) v = Math.min(v, d[i + 1] + 1);
      if (r < size - 1) { v = Math.min(v, d[i + size] + 1); if (c < size - 1) v = Math.min(v, d[i + size + 1] + D2); if (c > 0) v = Math.min(v, d[i + size - 1] + D2); }
      d[i] = v;
    }
    return d;
  }

  /**
   * Площади по участкам для каждого буфера. idx — номер участка пикселя (−1 вне участков), isPasture(i) — пастбищный покров,
   * pxHa — площадь пикселя (га), pxM — сторона пикселя (м).
   * → { [buffer]: [{ total_ha, pasture_ha, by_kind: { settlement, farm, industrial, other, buffer } }] по участкам }
   */
  function perPlot({ mask, dist, idx, isPasture, pxHa, pxM, nPlots, buffers = BUFFERS }) {
    const out = {};
    for (const b of buffers) {
      const rPx = b / pxM;
      const acc = Array.from({ length: nPlots }, () => ({ total: 0, pasture: 0, k: { settlement: 0, farm: 0, industrial: 0, other: 0, buffer: 0 } }));
      for (let i = 0; i < idx.length; i++) {
        const p = idx[i]; if (p < 0) continue;
        if (!(mask[i] || dist[i] <= rPx + 1e-9)) continue;
        const a = acc[p]; a.total++;
        if (!isPasture(i)) continue;
        a.pasture++;
        const m = mask[i];
        if (!m) a.k.buffer++;
        else { const name = KIND_NAMES.find(nm => m & KIND[nm]); a.k[name]++; }   // пиксель с несколькими видами — по первому
      }
      out[b] = acc.map(a => ({ total_ha: +(a.total * pxHa).toFixed(1), pasture_ha: +(a.pasture * pxHa).toFixed(1),
        by_kind: Object.fromEntries(Object.entries(a.k).map(([k, v]) => [k, +(v * pxHa).toFixed(1)])) }));
    }
    return out;
  }

  /** Контуры зон для карты: координаты с точностью ~1 м, не больше maxZones (самые крупные). */
  function simplifyForMap(zones, maxZones = 400) {
    const area = r => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(a / 2); };
    return zones.filter(z => z.ring.length >= 3).map(z => ({ z, a: area(z.ring) })).sort((x, y) => y.a - x.a).slice(0, maxZones)
      .map(({ z }) => ({ kind: z.kind, name: z.name || undefined, point: z.point || undefined, ring: z.ring.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]) }));
  }

  /**
   * Полный расчёт для села по уже загруженной сетке. plotIds — id участков по номерам idx.
   * osm — ответ Overpass (или fetch внутри, если не передан).
   */
  async function compute({ bbox, size, idx, pxHa, isPasture, plotIds, osm, fetchImpl, buffers = BUFFERS, lat }) {
    const data = osm || await fetchOSM(bbox, { fetchImpl });
    const zones = parseZones(data);
    const mask = rasterize(zones, bbox, size);
    const dist = distance(mask, size);
    const [kx] = kmPerDeg(lat != null ? lat : (bbox[1] + bbox[3]) / 2);
    const pxM = (bbox[2] - bbox[0]) * kx * 1000 / size;
    const res = perPlot({ mask, dist, idx, isPasture, pxHa, pxM, nPlots: plotIds.length, buffers });
    const count = k => zones.filter(z => z.kind === k).length;
    return {
      source: "OpenStreetMap (Overpass API), © участники OpenStreetMap, ODbL", fetched_at: new Date().toISOString(),
      osm_timestamp: (data && data.osm3s && data.osm3s.timestamp_osm_base) || null,
      buffers, default_buffer: DEFAULT_BUFFER, px_m: +pxM.toFixed(1),
      counts: { settlement: count("settlement"), farm: count("farm"), industrial: count("industrial"), other: count("other"),
        points: zones.filter(z => z.point).length },
      by_buffer: Object.fromEntries(Object.entries(res).map(([b, arr]) => [b, Object.fromEntries(arr.map((v, k) => [plotIds[k], v]))])),
      zones: simplifyForMap(zones),
      status: zones.length ? "ok" : "empty",
    };
  }

  /**
   * Применить к участкам: кормовая площадь = пастбищный покров − пастбищный покров в зонах (с буфером).
   * Возвращает новые объекты; исходный pasture_ha сохраняется в pasture_ha_gross.
   */
  function apply(plots, ng, buffer = DEFAULT_BUFFER) {
    if (!ng || ng.status === "error" || !ng.by_buffer) return plots;
    const b = ng.by_buffer[String(buffer)] ? String(buffer) : String(ng.default_buffer != null ? ng.default_buffer : DEFAULT_BUFFER);
    const t = ng.by_buffer[b]; if (!t) return plots;
    return plots.map(p => {
      const z = t[p.id]; if (!z) return p;
      const gross = p.pasture_ha_gross != null ? p.pasture_ha_gross : p.pasture_ha;
      const cut = Math.min(gross, z.pasture_ha);
      return Object.assign({}, p, { pasture_ha_gross: gross, pasture_ha: Math.max(0, +(gross - cut).toFixed(1)), nograze_ha: cut,
        nograze_total_ha: z.total_ha, nograze_by_kind: z.by_kind, nograze_buffer_m: +b });
    });
  }

  return { BUFFERS, DEFAULT_BUFFER, KIND, PLACE_RADIUS_M, FARM_BUILDINGS, LANDUSE_KIND, setUserAgent, overpassQuery, fetchOSM,
    parseZones, rasterize, distance, perPlot, simplifyForMap, compute, apply, circle };
});
