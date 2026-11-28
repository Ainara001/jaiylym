// Готовое село-пример для web/data: снимки этого лета, прошлое лето, ряд с 2019 года, зоны «нельзя пасти» и картинка NDVI —
// тем же pipeline.js, что сайт считает для любого села. Нужен, чтобы пример открывался сразу и без сети.
// Запуск: node scripts/build_example.js beskol
const fs = require("fs");
const path = require("path");
const PL = require("../web/pipeline.js");
const NG = require("../web/nograze.js");

const UA = "Jaiylym-hackathon/1.0 (+https://github.com/Ainara001/jaiylym)";
PL.setUserAgent(UA); NG.setUserAgent(UA);
const DATA = path.join(__dirname, "..", "web", "data");
const FIRST = 2019;
// координаты — точка села в OpenStreetMap (та же, что вернёт поиск на сайте)
const VILLAGES = {
  beskol: { name: "Бесколь", region: "Северо-Казахстанская область", lat: 54.77515, lon: 69.09779, global: "JAIYLYM_BESKOL" },
};

const { ndviPng: pngBuf } = require("../villagecache.js");
const ndviPng = grid => pngBuf(grid);

(async () => {
  const id = process.argv[2], V = VILLAGES[id];
  if (!V) throw new Error("Село: " + Object.keys(VILLAGES).join(", "));
  const { name, lat, lon } = V, say = m => console.log(m);
  const D = await PL.buildVillage({ name, lat, lon, onProgress: say });
  const png = ndviPng(D.grid); delete D.grid;
  D.village.region = V.region;
  // площадь пастбищ по документам и условные стада примера переносим из прежнего файла, если они там были
  try { const old = require("../data").loadExamples().find(x => x.village.name === V.name); if (old && old.village.official) D.village.official = old.village.official; if (old && old.herds) D.herds = old.herds; } catch (_) {}
  if (!D.nograze || D.nograze.status !== "ok") D.nograze = await PL.buildNoGraze({ lat, lon, onProgress: say });
  if (D.nograze.status !== "ok") throw new Error("зоны OSM не получены (Overpass): " + D.nograze.error);
  const year = D.source.year;
  D.prev_season = await PL.buildSeason({ lat, lon, year: year - 1, onProgress: say });
  const years = Array.from({ length: year - FIRST + 1 }, (_, i) => FIRST + i);
  const seasons = await PL.buildYears({ lat, lon, years, onProgress: ({ year: y }) => say("лето " + y) });
  D.multiyear = { first: FIRST, last: year, calculated_at: new Date().toISOString(), precip: await PL.fetchPrecip({ lat, lon, years }),
    seasons: seasons.map(s => ({ year: s.year, status: s.status, dates: s.dates, window: s.window || null, valid_fraction: s.valid_fraction,
      plots: s.plots.map(p => ({ id: p.id, ndvi: p.ndvi, valid_fraction: p.valid_fraction })) })) };
  fs.writeFileSync(path.join(DATA, id + ".js"), `window.${V.global} = ${JSON.stringify(D)};\n`);
  fs.writeFileSync(path.join(DATA, id + ".png"), png);
  console.log(`${name}: ${D.plots.length} участков, пастбищ ${Math.round(D.plots.reduce((s, p) => s + p.pasture_ha, 0))} га, зоны ${JSON.stringify(D.nograze.counts)}, прошлое лето ${D.prev_season.status}, лет ${seasons.length}; PNG ${Math.round(png.length / 1024)} КБ`);
})().catch(e => { console.error(e); process.exit(1); });
