// Дописывает в web/data/plots.js(.json) прошлое лето (prev_season) и воду по снимкам текущего лета (water_obs_ha)
// для села по умолчанию — тем же pipeline.js, что и сайт для любого села. Запуск: node scripts/add_history.js
const fs = require("fs");
const path = require("path");
const PL = require("../web/pipeline.js");
const { loadPlots } = require("../data");

PL.setUserAgent("Jaiylym-hackathon/1.0 (+https://github.com/Ainara001/jaiylym)");
const DATA = path.join(__dirname, "..", "web", "data");

(async () => {
  const D = loadPlots();
  const { lat, lon } = D.village, year = D.source.year;
  const say = m => console.log(m);
  const cur = await PL.buildSeason({ lat, lon, year, onProgress: say });
  const prev = await PL.buildSeason({ lat, lon, year: year - 1, onProgress: say });
  for (const p of D.plots) {
    const c = cur.plots.find(x => x.id === p.id);
    p.water_obs_ha = c.water_ha; p.water_obs_max_ha = c.water_max_ha;
  }
  D.prev_season = prev;
  const cmp = PL.compareSeasons({ year, dates: D.source.dates, plots: D.plots.map(p => ({ id: p.id, ndvi: p.ndvi, water_ha: p.water_obs_ha })) }, prev);
  console.log(`Лето ${year - 1}: ${prev.dates.length} дат, ${prev.status}; сравнение: ${JSON.stringify(cmp.summary)}, надёжно: ${cmp.reliable} ${cmp.reasons.join(" ")}`);
  fs.writeFileSync(path.join(DATA, "plots.json"), JSON.stringify(D, null, 1));
  fs.writeFileSync(path.join(DATA, "plots.js"), "window.JAIYLYM_DATA = " + JSON.stringify(D) + ";\n");
})().catch(e => { console.error(e); process.exit(1); });
