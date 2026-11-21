// Дописывает в web/data/plots.js(.json) график NDVI каждого участка за лето (series),
// посчитанный тем же pipeline.js, что и сайт. Запуск после ndvi.py:  node scripts/add_series.js
const fs = require("fs");
const path = require("path");
const PL = require("../web/pipeline.js");
const { loadPlots } = require("../data");

PL.setUserAgent("Jaiylym-hackathon/1.0 (+https://github.com/Ainara001/jaiylym)");
const DATA = path.join(__dirname, "..", "web", "data");

(async () => {
  const D = loadPlots();
  const v = D.village;
  const r = await PL.buildVillage({ name: v.name, lat: v.lat, lon: v.lon, year: D.source.year });
  let diff = 0;
  for (const p of D.plots) {
    const q = r.plots.find(x => x.id === p.id);
    p.series = q.series;
    diff += Math.abs((q.ndvi || 0) - (p.ndvi || 0));
  }
  console.log(`Снимки: ${r.source.dates.join(", ")}; среднее расхождение NDVI с ndvi.py: ${(diff / D.plots.length).toFixed(3)}`);
  fs.writeFileSync(path.join(DATA, "plots.json"), JSON.stringify(D, null, 1));
  fs.writeFileSync(path.join(DATA, "plots.js"), "window.JAIYLYM_DATA = " + JSON.stringify(D) + ";\n");
  for (const p of D.plots.slice(0, 3)) console.log(p.id, p.series.map(s => `${s.d.slice(5)}:${s.v}`).join(" "));
})().catch(e => { console.error(e); process.exit(1); });
