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

for (const [name, lat, lon] of [["Кеген", 43.02, 79.22], ["Бесколь (СКО)", 54.79, 69.12]]) {
  test(`${name}: прошлое лето по реальным снимкам и сравнение с годом раньше`, { timeout: 300000 }, async () => {
    const a = await PL.buildSeason({ lat, lon, year: 2025 }), b = await PL.buildSeason({ lat, lon, year: 2024 });
    for (const s of [a, b]) {
      assert.equal(s.plots.length, 16);
      for (const p of s.plots) {
        assert.ok(p.ndvi == null || (p.ndvi > -1 && p.ndvi < 1));
        assert.ok(p.water_ha == null || (p.water_ha >= 0 && p.water_ha <= p.water_max_ha));
      }
    }
    const c = PL.compareSeasons(a, b);
    assert.deepEqual(c.years, [2024, 2025]);
    assert.ok(c.plots.length === 16);
  });
}

test("многолетний ряд: два лета подряд и осадки ERA5 для двух сёл", { timeout: 300000 }, async () => {
  for (const [lat, lon] of [[43.02, 79.22], [54.79, 69.12]]) {
    const s = await PL.buildYears({ lat, lon, years: [2023, 2024] });
    assert.equal(s.length, 2);
    for (const x of s) { assert.equal(x.plots.length, 16); assert.ok(x.window === null || typeof x.window.widened === "boolean"); }
    const pr = await PL.fetchPrecip({ lat, lon, years: [2023, 2024] });
    for (const y of [2023, 2024]) assert.ok(pr[y] == null || (pr[y] >= 0 && pr[y] < 2000), `осадки ${y}: ${pr[y]}`);
  }
});
