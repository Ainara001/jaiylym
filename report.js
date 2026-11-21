// Текстовый отчёт по селу: node report.js
const { Jaiylym: J, loadPlots, loadHerds } = require("./data");
const D = loadPlots(), H = loadHerds();
const cur = J.current(D.plots, H), pl = J.plan(D.plots, H);
const pct = x => (isFinite(x) ? Math.round(x * 100) + "%" : "∞");

console.log(`Село: ${D.village.name}. Снимки ${D.source.year}: ${D.source.dates.join(", ")}\n`);
console.log("Стада (УГ):", H.map(h => `${h.name} ${J.herdAU(h)}`).join(", "));
console.log("\nУчасток  вода  пастбище,га  NDVI   ёмкость,УГ/сезон  сейчас  план");
for (const p of D.plots) {
  const c = J.plotCapacity(p);
  console.log(`${p.id.padEnd(7)} ${p.water ? " да " : " нет"}  ${String(p.pasture_ha).padStart(8)}   ${String(p.ndvi).padEnd(5)}  ${String(Math.round(c.au_season)).padStart(10)}       ${pct(cur.load[p.id].load).padStart(5)}  ${pct(pl.load[p.id].load).padStart(5)}`);
}
console.log(`\nСейчас: перегружено участков ${cur.overloaded}, корма сверх нормы ≈ ${J.hayTonnes(cur.deficit_kg).toFixed(0)} т сена`);
console.log(`План:   перегружено участков ${pl.overloaded}, дефицит ≈ ${J.hayTonnes(pl.deficit_kg).toFixed(0)} т сена`);
for (const h of H) console.log(" ", h.name, pl.herdPlans[h.id].map(s => `${s.plot || "нет корма"} д.${s.from}–${s.to}`).join(" → "));
console.log("\nВодопой откроет корм (на сезон):", J.wells(D.plots).map(w => `${w.plot} ≈ ${Math.round(w.sheep)} овец`).join(", "));
