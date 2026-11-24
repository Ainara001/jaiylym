// Дописывает в web/data/plots.js(.json) многолетний ряд (multiyear): NDVI участков каждого лета с 2019 года и осадки
// апреля–августа (ERA5) — тем же pipeline.js, что и сайт для любого села. Запуск: node scripts/add_multiyear.js
const fs = require("fs");
const path = require("path");
const PL = require("../web/pipeline.js");
const T = require("../web/trend.js");
const { loadPlots } = require("../data");

PL.setUserAgent("Jaiylym-hackathon/1.0 (+https://github.com/Ainara001/jaiylym)");
const DATA = path.join(__dirname, "..", "web", "data");
const FIRST = 2019;   // с этого лета Sentinel-2 L2A в Planetary Computer покрывает Казахстан

(async () => {
  const D = loadPlots();
  const { lat, lon } = D.village, last = D.source.year;
  const years = Array.from({ length: last - FIRST + 1 }, (_, i) => FIRST + i);
  const seasons = await PL.buildYears({ lat, lon, years, onProgress: ({ year }) => console.log("лето", year) });
  const precip = await PL.fetchPrecip({ lat, lon, years });
  D.multiyear = { first: FIRST, last, calculated_at: new Date().toISOString(), precip,
    seasons: seasons.map(s => ({ year: s.year, status: s.status, dates: s.dates, window: s.window || null, valid_fraction: s.valid_fraction,
      plots: s.plots.map(p => ({ id: p.id, ndvi: p.ndvi, valid_fraction: p.valid_fraction })) })) };
  const a = T.analyze(D.multiyear.seasons, precip);
  for (const y of a.years) console.log(y.year, y.ok ? "ок" : "не участвует: " + y.reason, "дат", y.dates, "NDVI", y.ndvi_median, "осадки", y.precip_mm);
  console.log("село:", JSON.stringify(a.village));
  const v = {}; for (const r of Object.values(a.plots)) v[r.verdict] = (v[r.verdict] || 0) + 1;
  console.log("участки:", JSON.stringify(v));
  fs.writeFileSync(path.join(DATA, "plots.json"), JSON.stringify(D, null, 1));
  fs.writeFileSync(path.join(DATA, "plots.js"), "window.JAIYLYM_DATA = " + JSON.stringify(D) + ";\n");
})().catch(e => { console.error(e); process.exit(1); });
