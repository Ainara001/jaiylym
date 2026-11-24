// Дописывает в web/data/plots.js(.json) зоны, где нельзя пасти (nograze): жильё, населённые пункты, фермы, промзоны
// из OpenStreetMap на сетке ESA WorldCover — тем же pipeline.js и nograze.js, что сайт и бот. Запуск: node scripts/add_nograze.js
// Исходная кормовая площадь участков не меняется: вычитание делается при расчёте (сайт, бот), буфер выбирается.
const fs = require("fs");
const path = require("path");
const PL = require("../web/pipeline.js");
const NG = require("../web/nograze.js");
const { loadPlots } = require("../data");

const UA = "Jaiylym-hackathon/1.0 (+https://github.com/Ainara001/jaiylym)";
PL.setUserAgent(UA); NG.setUserAgent(UA);
const DATA = path.join(__dirname, "..", "web", "data");

(async () => {
  const D = loadPlots();
  const ng = await PL.buildNoGraze({ lat: D.village.lat, lon: D.village.lon, onProgress: m => console.log(m) });
  if (ng.status === "error") throw new Error(ng.error);
  D.nograze = ng;
  console.log("зон:", JSON.stringify(ng.counts), "контуров для карты:", ng.zones.length);
  for (const b of ng.buffers) {
    const t = Object.values(ng.by_buffer[b]).reduce((s, x) => s + x.pasture_ha, 0);
    console.log(`буфер ${b} м: из пастбищ вычитается ${t.toFixed(1)} га`);
  }
  for (const p of NG.apply(D.plots, ng)) if (p.nograze_ha) console.log(p.id, p.pasture_ha_gross, "−", p.nograze_ha, "=", p.pasture_ha);
  fs.writeFileSync(path.join(DATA, "plots.json"), JSON.stringify(D, null, 1));
  fs.writeFileSync(path.join(DATA, "plots.js"), "window.JAIYLYM_DATA = " + JSON.stringify(D) + ";\n");
})().catch(e => { console.error(e); process.exit(1); });
