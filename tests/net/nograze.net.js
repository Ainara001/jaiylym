// РЕАЛЬНЫЙ запрос к OpenStreetMap (Overpass) и WorldCover для Кегена. Запуск: npm run test:net (нужен интернет).
const test = require("node:test");
const assert = require("node:assert/strict");
const PL = require("../../web/pipeline.js");
const NG = require("../../web/nograze.js");
PL.setUserAgent("Jaiylym-tests/1.0"); NG.setUserAgent("Jaiylym-tests/1.0");

test("Кеген: в OSM есть село, зоны вычитаются из пастбищ ближних участков", { timeout: 300000 }, async t => {
  const ng = await PL.buildNoGraze({ lat: 43.02, lon: 79.22 });
  // все публичные серверы Overpass перегружены (5xx/тайм-аут) — это сбой внешнего сервиса, не кода: тест пропускается с причиной
  if (ng.status === "error" && /Overpass\) не ответил/.test(ng.error) && !/HTTP 4\d\d(?!.*HTTP 429)/.test(ng.error.replace(/HTTP 429/g, ""))) { t.skip("OpenStreetMap недоступен: " + ng.error); return; }
  assert.equal(ng.status, "ok", ng.error);
  assert.ok(ng.counts.settlement >= 1, JSON.stringify(ng.counts));
  const near = Object.entries(ng.by_buffer[100]).filter(([id]) => id.startsWith("Б-")).reduce((s, [, v]) => s + v.total_ha, 0);
  assert.ok(near > 0, "у ближних участков есть зоны");
});
