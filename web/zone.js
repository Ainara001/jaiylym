/*
 * Jaiylym — где селу можно пасти (браузер и Node, без сети).
 *
 * Спутник видит всю траву вокруг, но не знает, чья она. Поэтому площадь участков ограничивает человек:
 *  - contour: один или несколько контуров на карте; доля участка внутри считается по пикселям пастбища;
 *  - ha:      известна только площадь по документам (например, 825 га): все участки уменьшаются одинаково, точных границ нет;
 *  - all:     вся трава вокруг — как видит спутник.
 * Прав на землю это не подтверждает. Исходная площадь остаётся в pasture_ha_gross и zone.before.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JaiylymZone = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const DIRS = ["С", "СВ", "В", "ЮВ", "Ю", "ЮЗ", "З", "СЗ"], MAX_RINGS = 5, MAX_PTS = 200;

  /** Проверка сохранённого выбора: { mode, rings | ha } или null. */
  function clean(z) {
    if (!z || typeof z !== "object") return null;
    if (z.mode === "all") return { mode: "all" };
    if (z.mode === "ha") { const ha = Math.round(+z.ha); return ha > 0 && ha <= 50000 ? { mode: "ha", ha } : null; }
    if (z.mode !== "contour" || !Array.isArray(z.rings)) return null;
    const rings = z.rings.slice(0, MAX_RINGS).map(r => (Array.isArray(r) ? r.slice(0, MAX_PTS) : []).filter(p => Array.isArray(p) && Math.abs(+p[0]) <= 180 && Math.abs(+p[1]) <= 90).map(p => [+(+p[0]).toFixed(6), +(+p[1]).toFixed(6)])).filter(r => r.length >= 3);
    return rings.length ? { mode: "contour", rings } : null;
  }
  /** Выбор по умолчанию: у примера известна площадь из плана района, у остальных сёл — вся трава вокруг. */
  const defaultFor = v => (v && v.official && v.official.ha > 0 ? { mode: "ha", ha: v.official.ha, official: true } : { mode: "all" });

  const inRing = (x, y, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > y) !== (r[j][1] > y) && x < (r[j][0] - r[i][0]) * (y - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) c = !c; return c; };
  /** Участок пикселя (как в pipeline.plotIndex) или null. */
  function plotAt(v, lon, lat) {
    const dx = (lon - v.lon) * 111.32 * Math.cos(v.lat * Math.PI / 180), dy = (lat - v.lat) * 110.57, r = Math.hypot(dx, dy);
    if (!(r >= 0.5 && r < 8)) return null;
    let az = Math.atan2(dx, dy) * 180 / Math.PI; if (az < 0) az += 360;
    return (r < 3 ? "Б-" : "Д-") + DIRS[Math.round(az / 45) % 8];
  }
  /**
   * Доля пастбища каждого участка внутри контуров. mask: { size, bbox: [w,s,e,n], has(i) → пиксель — пастбище }.
   * Маски нет (картинка не загрузилась) — по площади участка: has не передан.
   */
  function shares(v, rings, mask) {
    const [w, s, e, n] = mask.bbox, N = mask.size, all = {}, inn = {};
    const box = rings.map(r => [Math.min(...r.map(p => p[0])), Math.min(...r.map(p => p[1])), Math.max(...r.map(p => p[0])), Math.max(...r.map(p => p[1]))]);
    for (let row = 0; row < N; row++) {
      const lat = n - (row + 0.5) * (n - s) / N;
      for (let col = 0; col < N; col++) {
        if (mask.has && !mask.has(row * N + col)) continue;
        const lon = w + (col + 0.5) * (e - w) / N, id = plotAt(v, lon, lat);
        if (!id) continue;
        all[id] = (all[id] || 0) + 1;
        if (rings.some((r, k) => lon >= box[k][0] && lon <= box[k][2] && lat >= box[k][1] && lat <= box[k][3] && inRing(lon, lat, r))) inn[id] = (inn[id] || 0) + 1;
      }
    }
    return Object.fromEntries(Object.keys(all).map(id => [id, +((inn[id] || 0) / all[id]).toFixed(4)]));
  }
  /** Участки с площадью только внутри разрешённого. closed — отмеченные чужими: на них гектары из документов не делим. */
  function apply(plots, zone, sh, closed) {
    if (!zone || zone.mode === "all" || (zone.mode === "contour" && !sh)) return plots;
    const off = new Set(closed || []), total = plots.filter(p => !off.has(p.id)).reduce((s, p) => s + (+p.pasture_ha || 0), 0);
    const k = p => (zone.mode === "contour" ? sh[p.id] || 0 : off.has(p.id) ? 1 : total > 0 ? Math.min(1, zone.ha / total) : 1);
    return plots.map(p => Object.assign({}, p, { pasture_ha: +(p.pasture_ha * k(p)).toFixed(1), pasture_ha_gross: p.pasture_ha_gross != null ? p.pasture_ha_gross : p.pasture_ha, zone: { mode: zone.mode, share: +k(p).toFixed(4), before: p.pasture_ha } }));
  }
  const total = (plots, closed) => plots.filter(p => !(closed || []).includes(p.id)).reduce((s, p) => s + (+p.pasture_ha || 0), 0);

  return { clean, defaultFor, shares, apply, total, plotAt, MAX_RINGS };
});
