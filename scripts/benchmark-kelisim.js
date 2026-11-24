/*
 * Келісім на воспроизводимом наборе сёл (seed фиксирован): чем кончаются возражения, сколько чужих дворов задевает пересчёт
 * и выгодно ли завышать скот после начала. Запуск: node scripts/benchmark-kelisim.js   → таблица в Markdown.
 * Сёла — случайные задачи того же вида, что в benchmark-optimizer.js, и примеры Бесколь и Кеген с нормой нагрузки; дворы условные.
 */
const K = require("../web/kelisim.js");
const J = require("../web/engine.js");
const PL = require("../web/pipeline.js");
const N = require("../web/norms.js");
const NG = require("../web/nograze.js");
const { loadExamples } = require("../data");
const P = J.params();

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function households(r, plots, n, sheep) {
  const near = plots.filter(p => p.ring === "near").map(p => p.id), all = plots.map(p => p.id);
  return Array.from({ length: n }, (_, i) => { const daily = r() < 0.25, home = near[Math.floor(r() * near.length)];
    return { id: "h" + i, name: "h" + i, home, daily_return: daily, weight: 1, avoid: [], prefer: [], prefer_soft: [], allowed: r() < 0.3 ? [...new Set(all.filter(() => r() < 0.4).concat([home]))] : [],
      herd: { sheep: daily ? 0 : Math.round(r() * sheep), goats: 0, cattle: Math.round(r() * (daily ? 120 : 60)), horses: daily ? 0 : Math.round(r() * 40) } }; });
}
function village(r) {
  const plots = PL.makePlots(43, 79, 4).map(p => { const near = p.ring === "near", water = near ? r() < 0.9 : r() < 0.55;
    return { id: p.id, ring: p.ring, dir: p.dir, dist_km: p.dist_km, pasture_ha: Math.round(near ? 120 + r() * 230 : 600 + r() * 1700), ndvi: +(0.14 + r() * 0.36).toFixed(3),
      series: [1, 2, 3, 4].map(i => ({ d: "2026-07-0" + i, v: 0.3 })), water, water_status: water ? (near ? "assumed" : "satellite") : "unknown" }; });
  return make(plots, households(r, plots, 3 + Math.floor(r() * 13), 2000));
}
function make(plots, list) { const k = { rule: "share", version: 1, snapshot: { plots, params: {} }, households: list, proposals: [], versions: [] }; k.plan = K.solve(k); return k; }
const busy = k => k.households.filter(h => J.herdAU(h.herd, P) > 0 && K.plotsOf(k.plan.routes[h.id]).length);
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + " %" : "—");

const r = rng(20261125);
const list = Array.from({ length: 119 }, () => village(r)).concat(loadExamples().flatMap(D => {
  const plots = N.attach(NG.apply(D.plots, D.nograze), { region: N.regionOf(D.village.region) });
  return [6, 12, 20].map(n => make(plots, households(r, plots, n, 700))); }));
const v = {}, t = []; let n = 0, aff = 0, loose = 0, vn = 0, protN = 0, protLoss = 0, ov = 0, ovEq = 0, ovHurt = 0, ovPr = 0;
for (const k of list) {
  for (const h of busy(k).slice(0, 5)) {
    const plot = K.plotsOf(k.plan.routes[h.id])[0], t0 = process.hrtime.bigint(), e = K.effect(k, h.id, { type: "avoid", plot });
    t.push(Number(process.hrtime.bigint() - t0) / 1e6); n++; v[e.verdict] = (v[e.verdict] || 0) + 1;
    if (!e.variants.equal) continue;
    vn++; aff += e.variants.equal.affected.length;
    loose += Object.entries(K.compare(k.plan, K.solve(K.withHousehold(k, K.applyProposal(k, h, { type: "avoid", plot }).household)))).filter(([id, x]) => id !== h.id && x.route).length;
    if (e.variants.protect) { protN++; if (e.variants.protect.losers.some(x => x.id !== h.id)) protLoss++; }
  }
  if (k.plan.deficit_t > 0.5) for (const h of busy(k).slice(0, 4)) {
    if (k.plan.share[h.id] > 0.99) continue;
    const e = K.effect(k, h.id, { type: "herd", herd: Object.fromEntries(Object.entries(h.herd).map(([s, x]) => [s, Math.round(x * 1.5)])) }), f0 = k.plan.feed[h.id];
    ov++; if (e.variants.equal.own.feed1 > f0 * 1.03) ovEq++; if (e.verdict === "others") ovHurt++;
    if ((e.variants.protect || e.variants.equal).own.feed1 > f0 * 1.03) ovPr++;
  }
}
t.sort((a, b) => a - b);
console.log(`| Показатель (${list.length} сёл, ${n} возражений «участок не подходит») | Значение |\n|---|---|
| Никто не теряет корм | ${pct(v.free || 0, n)} |
| Теряет только сам возразивший | ${pct(v.own || 0, n)} |
| При равном пересчёте теряют и соседи | ${pct(v.others || 0, n)} |
| Возразившему негде пасти | ${pct(v.impossible || 0, n)} |
| Вариант «никто другой не теряет»: соседи всё же потеряли | ${protLoss} из ${protN} |
| Чужих дворов со сменой участка или сроков на одно возражение: обычный пересчёт / устойчивый | ${(loose / vn).toFixed(2)} / ${(aff / vn).toFixed(2)} |
| Завысить скот в 1,5 раза при нехватке корма выгодно: равный пересчёт / с гарантией соседям | ${pct(ovEq, ov)} / ${pct(ovPr, ov)} (${ov} случаев) |
| Время ответа, мс: медиана / максимум | ${t[t.length >> 1].toFixed(0)} / ${t[t.length - 1].toFixed(0)} |`);
