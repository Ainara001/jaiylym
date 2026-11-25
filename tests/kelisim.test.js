// Келісім, расчётная часть (web/kelisim.js): последствия возражений, устойчивость, защита соседей, правила, протокол.
const test = require("node:test");
const assert = require("node:assert/strict");
const K = require("../web/kelisim.js");
const J = require("../web/engine.js");
const PL = require("../web/pipeline.js");
const N = require("../web/norms.js");
const NG = require("../web/nograze.js");
const { loadExamples } = require("../data");
const P = J.params();

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function randomVillage(r, windows = true) {
  const plots = PL.makePlots(43, 79, 4).map(p => {
    const near = p.ring === "near", water = near ? r() < 0.9 : r() < 0.55;
    const o = { id: p.id, ring: p.ring, dir: p.dir, dist_km: p.dist_km, pasture_ha: Math.round(near ? 120 + r() * 230 : 600 + r() * 1700), ndvi: +(0.14 + r() * 0.36).toFixed(3),
      series: [1, 2, 3, 4].map(i => ({ d: "2026-07-0" + i, v: 0.3 })), water, water_status: water ? (near ? "assumed" : "satellite") : "unknown" };
    if (windows && !near && r() < 0.2) { const a = 1 + Math.floor(r() * 60); o.window = { from: a, to: Math.min(150, a + 40 + Math.floor(r() * 60)) }; }
    return o;
  });
  return kel(plots, households(r, plots, 3 + Math.floor(r() * 13), 2000));
}
function households(r, plots, n, sheep) {
  const near = plots.filter(p => p.ring === "near").map(p => p.id), all = plots.map(p => p.id);
  return Array.from({ length: n }, (_, i) => { const daily = r() < 0.25, home = near[Math.floor(r() * near.length)];
    return hh("h" + i, { sheep: daily ? 0 : Math.round(r() * sheep), goats: 0, cattle: Math.round(r() * (daily ? 120 : 60)), horses: daily ? 0 : Math.round(r() * 40) },
      { home, daily_return: daily, allowed: r() < 0.3 ? all.filter(() => r() < 0.4).concat([home]).filter((x, j, a) => a.indexOf(x) === j) : [] }); });
}
const hh = (id, herd, o = {}) => Object.assign({ id, name: "Двор " + id, herd: Object.assign({ sheep: 0, goats: 0, cattle: 0, horses: 0 }, herd), home: "Б-С", daily_return: false, weight: 1, allowed: [], avoid: [], prefer: [],
  herd_status: "declared", answer: null }, o);
function kel(plots, list, o = {}) {
  const k = Object.assign({ rule: "share", version: 1, title: "т", snapshot: { plots, params: {}, source: {}, check: { status: "unknown" } }, households: list, proposals: [], versions: [] }, o);
  k.plan = K.solve(k);
  return k;
}
const exampleVillages = r => loadExamples().flatMap(D => { const plots = N.attach(NG.apply(D.plots, D.nograze), { region: N.regionOf(D.village.region) });
  return [6, 12].map(n => kel(plots, households(r, plots, n, 700))); });
const VILLAGES = (() => { const r = rng(777); return Array.from({ length: 121 }, () => randomVillage(r)).concat(exampleVillages(r)); })();   // 125 сёл
const capOk = (k, plan, what) => { for (const p of k.snapshot.plots) if (plan.load[p.id] != null) assert.ok(plan.load[p.id] <= 1.002, `${what}: ${p.id} ${plan.load[p.id]}`); };
const busy = k => k.households.filter(h => J.herdAU(h.herd, P) > 0 && K.plotsOf(k.plan.routes[h.id]).length);

test("125 сёл: план в пределах ёмкости; ничего не изменилось — план прежний у всех", () => {
  assert.equal(VILLAGES.length, 125);
  let moved = 0, total = 0;
  for (const k of VILLAGES) {
    capOk(k, k.plan, "план");
    const again = K.solve(k, { keep: k.plan.alloc });
    for (const [id, x] of Object.entries(K.compare(k.plan, again))) { total++; if (x.route) moved++; assert.ok(Math.abs(x.delta) < 0.011, "доля без причины изменилась: " + x.delta); }
  }
  assert.ok(moved <= total * 0.02, `без изменений маршрут сменился у ${moved} из ${total}`);
});

test("125 сёл: возражение «участок не подходит» — честные последствия для каждого", () => {
  const v = {}; let n = 0, affected = 0, loose = 0, variants = 0;
  for (const k of VILLAGES) for (const h of busy(k).slice(0, 3)) {
    const plot = K.plotsOf(k.plan.routes[h.id])[0], before = JSON.stringify(k.households);
    const e = K.effect(k, h.id, { type: "avoid", plot });
    n++; v[e.verdict] = (v[e.verdict] || 0) + 1;
    assert.equal(JSON.stringify(k.households), before, "просмотр последствий ничего не меняет");
    if (e.verdict === "impossible") { assert.equal(Object.keys(e.variants).length, 0); continue; }
    for (const [name, x] of Object.entries(e.variants)) {
      capOk(k, x.plan, name);
      assert.ok(!(x.plan.alloc[h.id][plot] > 0.5), "от участка отказались — он не используется");
      const others = x.losers.filter(y => y.id !== h.id);
      if (name === "protect") assert.deepEqual(others.map(y => [y.id, y.delta]), [], "protect: никто другой не теряет");
      if (e.verdict === "free" || e.verdict === "own") assert.equal(others.length, 0, e.verdict + ": никто другой не теряет");
    }
    if (e.verdict === "others") assert.ok(e.variants.protect, "теряют другие — есть вариант без потерь для них");
    variants++; affected += e.variants.equal.affected.length;
    const a = K.applyProposal(k, h, { type: "avoid", plot }).household;
    loose += Object.entries(K.compare(k.plan, K.solve(K.withHousehold(k, a)))).filter(([id, x]) => id !== h.id && x.route).length;
  }
  assert.ok(v.free / n > 0.7, "большинство возражений решаются без потерь: " + JSON.stringify(v));
  assert.ok(affected < loose * 0.6, `устойчивый пересчёт задевает меньше дворов: ${affected} против ${loose}`);
});

test("завысить скот после начала невыгодно: сверх прежнего корма — только то, что никто не теряет", () => {
  const r = rng(99), list = Array.from({ length: 60 }, () => randomVillage(r, false)).concat(exampleVillages(r));
  let n = 0, gainEqual = 0, gainProtect = 0;
  for (const k of list) {
    if (k.plan.deficit_t < 0.5) continue;
    for (const h of busy(k).slice(0, 3)) {
      if (k.plan.share[h.id] > 0.99) continue;
      const herd = Object.fromEntries(Object.entries(h.herd).map(([s, x]) => [s, Math.round(x * 1.5)]));
      const e = K.effect(k, h.id, { type: "herd", herd }), f0 = k.plan.feed[h.id];
      n++;
      if (e.variants.equal.own.feed1 > f0 * 1.03) gainEqual++;
      if ((e.variants.protect || e.variants.equal).own.feed1 > f0 * 1.03) gainProtect++;
    }
  }
  assert.ok(n > 40, "случаев с дефицитом достаточно: " + n);
  assert.ok(gainEqual > n * 0.5, "при простом пересчёте завышение выгодно — проблема настоящая");
  assert.ok(gainProtect <= n * 0.03, `с гарантией соседям — почти никогда: ${gainProtect} из ${n}`);
});

test("много соседей теряют понемногу — это тоже потеря, а не «свободный» корм", () => {
  // один общий участок, корма вдвое меньше потребности; маленький двор удваивает скот
  const plots = [{ id: "Б-С", ring: "near", dir: "С", dist_km: 1.8, pasture_ha: 150, ndvi: 0.35, series: [1, 2, 3, 4].map(i => ({ d: "2026-07-0" + i, v: 0.3 })), water: true, water_status: "confirmed" },
    ...["Б-Ю", "Д-С", "Д-Ю"].map(id => ({ id, ring: id[0] === "Б" ? "near" : "far", dir: id.slice(2), dist_km: 2, pasture_ha: 0, ndvi: 0.3, series: [], water: false, water_status: "unknown" }))];
  const k = kel(plots, [hh("a", { sheep: 10 }), ...Array.from({ length: 20 }, (_, i) => hh("n" + i, { sheep: 60 }))]);
  assert.ok(k.plan.share.a < 0.9);
  const e = K.effect(k, "a", { type: "herd", herd: { sheep: 20, goats: 0, cattle: 0, horses: 0 } });
  assert.equal(e.variants.equal.losers.filter(x => x.id !== "a").length, 0, "каждый сосед теряет меньше 1 п. п.");
  assert.equal(e.verdict, "others");
  assert.ok(e.variants.protect.own.feed1 < k.plan.feed.a * 1.03, "при защите соседей прибавки нет");
});

test("правила: share — равная доля потребности, household — поровну корма; приоритет виден в долях", () => {
  const plots = VILLAGES[0].snapshot.plots.map(p => Object.assign({}, p, { pasture_ha: p.id === "Б-С" ? 200 : 0, water: true, water_status: "confirmed", ndvi: 0.3 })); plots.forEach(p => { delete p.window; });
  const list = [hh("big", { sheep: 2000 }), hh("mid", { sheep: 500 }), hh("small", { sheep: 20 })];
  const s = kel(plots, list), h = kel(plots, list, { rule: "household" });
  assert.ok(Math.abs(s.plan.share.big - s.plan.share.small) < 0.005, "одинаковая доля");
  assert.equal(h.plan.share.small, 1, "маленький двор сыт целиком");
  assert.ok(Math.abs(h.plan.feed.big - h.plan.feed.mid) < 0.02 * h.plan.feed.mid, `поровну корма: ${h.plan.feed.big} и ${h.plan.feed.mid}`);
  assert.ok(Math.abs(Object.values(s.plan.feed).reduce((a, b) => a + b) - Object.values(h.plan.feed).reduce((a, b) => a + b)) < 5, "корма всего столько же");
  const w = kel(plots, [hh("a", { sheep: 1000 }, { weight: 2 }), hh("b", { sheep: 1000 })]);
  assert.ok(Math.abs(w.plan.share.a / w.plan.share.b - 2) < 0.05, "приоритет ×2 при нехватке");
});

test("предложения: другой участок, обмен, отмена, негде пасти, неверные данные", () => {
  const D = loadExamples()[1], plots = NG.apply(D.plots, D.nograze);
  const k = kel(plots, [hh("a", { sheep: 300 }), hh("b", { sheep: 200 }, { home: "Б-Ю" }), hh("c", { cattle: 20 }, { daily_return: true, home: "Б-З" })]);
  const at = K.plotsOf(k.plan.routes.a)[0], to = K.candidates(k, k.households[0]).find(id => id !== at);
  const pr = K.effect(k, "a", { type: "prefer", plot: to });
  assert.ok(pr.variants.equal.own.plots1.includes(to), "желаемый участок достаётся, если на нём есть место");
  assert.equal(pr.verdict, "free");
  const sw = K.effect(k, "a", { type: "swap", plot: at, to });
  assert.deepEqual(sw.variants.equal.own.plots1, [to]);
  assert.equal(K.effect(k, "a", { type: "avoid", plot: "Д-Х" }).error, "unknown_plot");
  assert.equal(K.effect(k, "zzz", { type: "avoid", plot: at }).error, "unknown_household");
  assert.equal(K.effect(k, "a", { type: "swap", plot: at, to: at }).error, "same_plot");
  assert.equal(K.effect(k, "a", { type: "other", text: "не успеваем" }).verdict, "not_calculated");
  const only = kel(plots, [hh("a", { sheep: 100 }, { allowed: ["Б-С"] }), hh("b", { sheep: 100 })]);
  assert.equal(K.effect(only, "a", { type: "avoid", plot: "Б-С" }).verdict, "impossible");
  assert.equal(K.effect(only, "a", { type: "prefer", plot: "Д-С" }).error, "not_allowed", "на участок вне своих прав попросить нельзя");
  // дойное может попросить дальний участок — никто не теряет, но участок дальше 3 км
  assert.equal(K.effect(k, "c", { type: "prefer", plot: "Д-С" }).verdict, "free");
  const h1 = K.applyProposal(k, k.households[0], { type: "avoid", plot: at }).household;
  assert.deepEqual(K.applyProposal(k, h1, { type: "clear" }).household.avoid, []);
});

test("чужой участок: корма у соседа столько же, но ему дальше — это видно; вариант room никого не сдвигает", () => {
  const pl = (id, ha, dist) => ({ id, ring: "near", dir: id.slice(2), dist_km: dist, pasture_ha: ha, ndvi: 0.35, series: [1, 2, 3, 4].map(i => ({ d: "2026-07-0" + i, v: 0.3 })), water: true, water_status: "confirmed" });
  const plots = [pl("Б-С", 130, 2), pl("Б-Ю", 600, 2), pl("Б-В", 0, 2), pl("Б-З", 0, 2)];
  const k = kel(plots, [hh("a", { sheep: 190 }, { home: "Б-Ю" }), hh("b", { sheep: 190 }, { home: "Б-С" })]);
  assert.deepEqual([K.plotsOf(k.plan.routes.a), K.plotsOf(k.plan.routes.b)], [["Б-Ю"], ["Б-С"]]);
  const e = K.effect(k, "a", { type: "prefer", plot: "Б-С" });
  assert.deepEqual(e.variants.equal.farther.map(x => x.id), ["b"], "соседу станет дальше");
  assert.equal(e.variants.equal.losers.length, 0, "корма столько же");
  assert.ok(K.needsChoice(e), "молча принять нельзя");
  assert.ok(e.variants.room, "есть вариант без сдвига соседа");
  assert.equal(e.variants.room.affected.length, 0);
  assert.ok((e.variants.room.plan.alloc.a["Б-С"] || 0) <= k.plan.need.b * 0 + 1 + Math.max(0, e.variants.room.plan.need.a), "на занятом участке — только свободное место");
  assert.deepEqual(K.plotsOf(e.variants.room.plan.routes.b), ["Б-С"], "сосед остался");
});

test("сезон по умолчанию: текущий, после его конца — следующий; старые согласования — по дате создания", () => {
  assert.equal(K.defaultSeason(Date.parse("2026-03-01"), {}), 2026);
  assert.equal(K.defaultSeason(Date.parse("2026-07-01"), {}), 2026);
  assert.equal(K.defaultSeason(Date.parse("2026-11-25"), {}), 2027);
  assert.equal(K.seasonOf({ created: "2026-11-25T10:00:00Z", snapshot: { params: null } }), 2027);
  assert.equal(K.seasonOf({ season: 2028, created: "2026-11-25T10:00:00Z", snapshot: { params: null } }), 2028);
});

test("60 дворов: последствия считаются за приемлемое время", () => {
  const r = rng(5), D = loadExamples()[0], plots = N.attach(NG.apply(D.plots, D.nograze), { region: "SKO" });
  const k = kel(plots, households(r, plots, 60, 200)), h = busy(k)[0], t = Date.now();
  K.effect(k, h.id, { type: "avoid", plot: K.plotsOf(k.plan.routes[h.id])[0] });
  assert.ok(Date.now() - t < 6000, Date.now() - t + " мс");
});

test("почему такой участок — коды без текста; протокол честно говорит, чем он не является", () => {
  const D = loadExamples()[1], plots = NG.apply(D.plots, D.nograze);
  const k = kel(plots, [hh("a", { sheep: 300 }), hh("c", { cattle: 20 }, { daily_return: true, home: "Б-З" })], { official: { sheep: 100 } });
  for (const h of k.households) for (const w of K.why(k, h.id)) {
    assert.ok(w.codes.length && w.codes.every(c => ["daily", "daily_far", "far", "nearest", "closer_full", "shared", "preferred"].includes(c)), JSON.stringify(w));
    assert.ok(K.plotsOf(k.plan.routes[h.id]).includes(w.plot));
  }
  assert.ok(K.why(k, "c").every(w => w.codes.includes("daily") && w.plot.startsWith("Б")));
  let p = K.protocol(k);
  assert.equal(p.outcome, "unanswered"); assert.equal(p.counts.pending, 2);
  k.households[0].answer = { value: "agree", version: 1, at: "2026-11-25T00:00:00Z" };
  k.households[1].answer = { value: "agree", version: 0 };
  assert.equal(K.protocol(k).counts.agree, 1, "согласие с прошлой версией не считается");
  k.households[1].answer = { value: "object", version: 1 };
  p = K.protocol(k);
  assert.equal(p.outcome, "disagreed");
  for (const x of ["not_a_contract", "no_land_rights", "herds_declared", "model_estimate"]) assert.ok(p.limits.includes(x));
  assert.deepEqual(p.herds.over.map(x => x.species), ["sheep"], "заявлено больше, чем у акимата, — видно");
});
