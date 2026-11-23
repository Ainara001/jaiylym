// РЕАЛЬНЫЕ запросы к Microsoft Planetary Computer и OpenStreetMap. Запуск: npm run test:net (нужен интернет).
// В обычном npm test не участвуют: результат зависит от сети и наличия новых снимков.
const test = require("node:test");
const assert = require("node:assert/strict");
const PL = require("../../web/pipeline.js");
PL.setUserAgent("Jaiylym-tests/1.0");

test("Кеген: расчёт села по реальным снимкам", { timeout: 240000 }, async () => {
  const r = await PL.buildVillage({ name: "Кеген", lat: 43.02, lon: 79.22, year: 2025 });
  assert.equal(r.plots.length, 16);
  assert.ok(r.meta.imagery_count >= 2);
  for (const p of r.plots) assert.ok(p.ndvi == null || (p.ndvi > -1 && p.ndvi < 1));
});

test("своё пастбище: реальный снимок", { timeout: 240000 }, async () => {
  const lat = 43.05, lon = 79.22, dy = 1 / 110.57, dx = 1 / (111.32 * Math.cos(lat * Math.PI / 180));
  const r = await PL.polygonStats({ ring: [[lon, lat], [lon + dx, lat], [lon + dx, lat + dy], [lon, lat + dy]], year: 2025 });
  assert.ok(Math.abs(r.area_ha - 100) < 0.5);
  assert.ok(r.pasture_ha + r.excluded_ha + r.uncertain_ha <= r.area_ha + 0.5);
});
