/*
 * JAIYLYM Келісім — согласование пастбищ между дворами: расчётная часть (браузер и Node, без сети).
 *
 * Двор возражает («этот участок не подходит», «хочу другой», «у меня больше скота») — считаем, что будет со всеми остальными:
 *  - equal:   потерю делят все по правилу справедливости (честный пересчёт max-min);
 *  - protect: никто другой не теряет, потерю несёт тот, кто попросил (доли остальных — гарантированный минимум).
 * Пересчёт устойчивый: прежние участки сохраняются, если их не нужно менять, поэтому остальным не приходится соглашаться заново.
 * Доли, участки и сроки — только из engine.js; здесь нет своих оценок. Состояние, ссылки и хранение — на сервере (kelisim.js).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./engine.js"));
  else root.JaiylymKelisim = factory(root.Jaiylym);
})(typeof self !== "undefined" ? self : this, function (J) {
  "use strict";
  if (!J) throw new Error("Сначала подключите web/engine.js");

  const REASONS = ["no_grass", "weeds", "no_water", "far", "no_rights", "crowded", "other"];
  const TYPES = ["avoid", "prefer", "swap", "herd", "clear", "other"];
  const RULES = ["share", "household"];          // share — всем одинаковая доля потребности; household — всем дворам поровну корма
  const WEIGHTS = [1, 1.5, 2];
  const SPECIES = ["sheep", "goats", "cattle", "horses"];
  const TOL = 0.01;                              // 1 п. п. доли: меньше — погрешность календаря, а не потеря
  const REL = 0.05;                              // у кого корма и так мало, для того потеря — уже 5 % его корма
  const SPREAD = 0.02;                           // соседи вместе теряют больше 2 % потребности просящего — это потеря, даже если каждому «по чуть-чуть»
  const TRANSFER = 0.3;                          // прибавка просящего больше чем на 30 % взята у соседей — это не «свободный» корм
  const FAR_KM = 1;                              // средний путь длиннее больше чем на километр — двору станет дальше
  const SHIFT_DAYS = 3;                          // сдвиг сроков, который двору нужно подтвердить заново

  /** Двор потерял корм: больше 1 п. п. доли или больше 5 % того, что у него было. */
  const lost = x => x.delta != null && (x.delta < -TOL || (x.share0 > 0.005 && x.delta < -REL * x.share0 && x.feed0 - x.feed1 > 1));
  const r4 = x => +(+x).toFixed(4), r1 = x => +(+x).toFixed(1);
  const active = k => k.households.filter(h => !h.removed);
  const plotIds = k => k.snapshot.plots.map(p => p.id);

  // ---------- двор → стадо движка ----------
  /** Участки, где двору можно пасти: разрешённые (если заданы) без тех, от которых он отказался. [] — нигде. */
  function allowedOf(k, h) {
    const base = (h.allowed || []).length ? h.allowed : plotIds(k);
    return base.filter(id => !(h.avoid || []).includes(id));
  }
  function herdOf(k, h) {
    const restricted = (h.allowed || []).length || (h.avoid || []).length, allowed = allowedOf(k, h);
    return Object.assign({ id: h.id, name: h.name, home: h.home, daily_return: !!h.daily_return, weight: h.weight || 1 }, h.herd,
      restricted ? { allowed_plots: allowed.length ? allowed : ["—"] } : {});       // «—» — нигде: пустой список движок понял бы как «везде»
  }
  const params = k => J.params(k.snapshot.params || null);
  function options(k, list, extra) {
    const P = params(k), opts = Object.assign({ algorithm: "optimized" }, extra);
    if (k.rule === "household") {
      // всем дворам поровну корма: доля растёт обратно потребности, пока двор не насытится
      const d = list.map(h => J.herdAU(herdOf(k, h), P)), lo = Math.min(...d.filter(x => x > 0), Infinity);
      opts.weights = Object.fromEntries(list.map((h, i) => [h.id, d[i] > 0 ? lo / d[i] : 1]));
    }
    for (const key of ["prefer", "prefer_soft"]) {
      const m = Object.fromEntries(list.filter(h => (h[key] || []).length).map(h => [h.id, h[key]]));
      if (Object.keys(m).length) opts[key] = m;
    }
    return opts;
  }

  // ---------- план ----------
  /** План для дворов k.households. extra: { keep, free, floors } — см. engine.flowModel. Возвращает компактный вид для хранения. */
  function solve(k, extra) {
    const P = params(k), list = active(k), herds = list.map(h => herdOf(k, h));
    const res = J.optimize(k.snapshot.plots, herds, P, options(k, list, extra));
    return compact(res, herds, P, k.snapshot.plots);
  }
  function compact(res, herds, P, plots) {
    const byId = Object.fromEntries(plots.map(p => [p.id, p]));
    const out = { status: res.status, deficit_t: r1(J.hayTonnes(res.deficit_kg, P)), season_days: P.season_days, share: {}, days: {}, feed: {}, need: {}, routes: {}, alloc: {}, km: {}, load: {}, bottleneck: null };
    for (const h of herds) {
      const need = J.herdAU(h, P) * P.season_days, got = need - (res.unmet[h.id] || 0);
      out.need[h.id] = r1(need); out.feed[h.id] = r1(got);
      out.share[h.id] = need > 0 ? r4(Math.max(0, got / need)) : 1;
      out.days[h.id] = Math.round(need > 0 ? res.coverage[h.id] : P.season_days);
      out.routes[h.id] = (res.herdPlans[h.id] || []).map(s => ({ plot: s.plot || null, from: s.from, to: s.to }));
      out.alloc[h.id] = {};
      // средний путь от домашнего участка, взвешенный по дням
      const segs = out.routes[h.id].filter(s => s.plot), days = segs.reduce((s, x) => s + x.to - x.from + 1, 0), home = byId[h.home] || plots[0];
      out.km[h.id] = days ? r1(segs.reduce((s, x) => s + J._internal.dist(home, byId[x.plot]) * (x.to - x.from + 1), 0) / days) : null;
    }
    for (const [id, l] of Object.entries(res.load)) {
      out.load[id] = l.known ? r4(l.load) : null;
      for (const x of l.herds) if (out.alloc[x.herd]) out.alloc[x.herd][id] = r1((out.alloc[x.herd][id] || 0) + x.au_days);
    }
    const g = res.bottleneck && res.bottleneck.groups && res.bottleneck.groups[0];
    if (g) out.bottleneck = { households: g.herds, plots: g.plots, shortfall_t: r1(J.hayTonnes(g.shortfall_au_days * P.intake, P)) };
    return out;
  }
  const plotsOf = route => [...new Set((route || []).filter(s => s.plot).map(s => s.plot))];
  /** Маршрут изменился настолько, что двору надо подтвердить заново: другие участки или сдвиг сроков больше SHIFT_DAYS. */
  function routeChanged(a, b) {
    const A = plotsOf(a), B = plotsOf(b);
    if (A.length !== B.length || A.some(id => !B.includes(id))) return true;
    const span = r => Object.fromEntries(plotsOf(r).map(id => { const s = r.filter(x => x.plot === id); return [id, [Math.min(...s.map(x => x.from)), Math.max(...s.map(x => x.to))]]; }));
    const x = span(a), y = span(b);
    return A.some(id => Math.abs(x[id][0] - y[id][0]) > SHIFT_DAYS || Math.abs(x[id][1] - y[id][1]) > SHIFT_DAYS);
  }
  /** Что изменилось для каждого двора между двумя планами. */
  function compare(before, after) {
    const out = {};
    for (const id of Object.keys(after.share)) {
      const s0 = before && before.share[id] != null ? before.share[id] : null, s1 = after.share[id];
      out[id] = { share0: s0, share1: s1, delta: s0 == null ? null : r4(s1 - s0), days0: before && before.days[id], days1: after.days[id],
        feed0: before && before.feed[id], feed1: after.feed[id], km0: before ? before.km[id] : null, km1: after.km[id], plots0: before ? plotsOf(before.routes[id]) : [], plots1: plotsOf(after.routes[id]),
        route: !before || routeChanged(before.routes[id], after.routes[id]) };
    }
    return out;
  }

  // ---------- предложения двора ----------
  /** Двор с учётом предложения (soft — желаемый участок только на свободное место). Возвращает { household } или { error }. Исходный объект не меняется. */
  function applyProposal(k, h, pr, soft) {
    const n = Object.assign({}, h, { avoid: (h.avoid || []).slice(), prefer: (h.prefer || []).slice(), prefer_soft: (h.prefer_soft || []).slice() });
    const ids = plotIds(k);
    if (pr.type === "avoid" || pr.type === "swap") {
      if (!ids.includes(pr.plot)) return { error: "unknown_plot" };
      if (!n.avoid.includes(pr.plot)) n.avoid.push(pr.plot);
      n.prefer = n.prefer.filter(x => x !== pr.plot); n.prefer_soft = n.prefer_soft.filter(x => x !== pr.plot);
    }
    if (pr.type === "prefer" || pr.type === "swap") {
      const to = pr.type === "swap" ? pr.to : pr.plot;
      if (!ids.includes(to)) return { error: "unknown_plot" };
      if (to === pr.plot && pr.type === "swap") return { error: "same_plot" };
      n.avoid = n.avoid.filter(x => x !== to);
      n.prefer = n.prefer.filter(x => x !== to); n.prefer_soft = n.prefer_soft.filter(x => x !== to);
      n[soft ? "prefer_soft" : "prefer"].push(to);
      if ((h.allowed || []).length && !h.allowed.includes(to)) return { error: "not_allowed" };
    }
    if (pr.type === "herd") {
      n.herd = Object.assign({}, pr.herd); n.herd_status = "declared";
      if (pr.home) n.home = pr.home;
      if (pr.daily_return != null) n.daily_return = !!pr.daily_return;
    }
    if (pr.type === "clear") { n.avoid = []; n.prefer = []; n.prefer_soft = []; }
    return { household: n };
  }
  const withHousehold = (k, h) => Object.assign({}, k, { households: k.households.map(x => (x.id === h.id ? h : x)) });
  /** Может ли двор вообще где-то пасти: участки, которые движок для него допускает. */
  function candidates(k, h) {
    const P = params(k), herd = herdOf(k, h);
    if (J.herdAU(herd, P) <= 0) return [];
    return J._internal.prepare(k.snapshot.plots, P, {}).filter(q => q.cap > 0 && !J._internal.herdReasons(herd, q).length).map(q => q.id);
  }

  /**
   * Последствия предложения двора для всех (k.plan — текущая версия).
   * verdict: free — никто не теряет; own — теряет только сам двор; others — при честном пересчёте теряют и другие (и когда понемногу, но многие);
   *          impossible — двору негде пасти; none — предложение не меняет план; not_calculated — словесное возражение.
   * Варианты: equal — потерю делят все; protect — никто другой не теряет корм; room — желаемый участок только на свободное место,
   * никого не сдвигая (есть, если equal меняет чужие участки). farther у варианта — кому станет дальше, хотя корма столько же.
   */
  function effect(k, hid, pr) {
    const h = k.households.find(x => x.id === hid && !x.removed);
    if (!h) return { verdict: "error", error: "unknown_household" };
    if (pr.type === "other") return { verdict: "not_calculated", variants: {} };
    const a = applyProposal(k, h, pr);
    if (a.error) return { verdict: "error", error: a.error };
    const k1 = withHousehold(k, a.household), P = params(k);
    if (J.herdAU(herdOf(k1, a.household), P) > 0 && !candidates(k1, a.household).length) return { verdict: "impossible", variants: {} };
    const keep = k.plan.alloc, free = [hid], equal = pack(k, hid, solve(k1, { keep, free })), more = {};
    if (["prefer", "swap"].includes(pr.type) && equal.affected.length)
      more.room = pack(k, hid, solve(withHousehold(k, applyProposal(k, h, pr, true).household), { keep, free }));
    const gain = equal.own.feed1 - (equal.own.feed0 || 0);
    const taken = equal.others_loss > SPREAD * Math.max(equal.plan.need[hid], k.plan.need[hid] || 0) + 1 || (gain > 1 && equal.others_loss > TRANSFER * gain + 1);
    if (!equal.losers.some(x => x.id !== hid) && !taken) {
      const same = !equal.own.route && Math.abs(equal.own.delta || 0) <= TOL && !equal.affected.length && pr.type !== "herd";
      return { verdict: same ? "none" : (equal.own.delta || 0) < -TOL ? "own" : "free", variants: Object.assign({ equal }, more) };
    }
    const floors = Object.fromEntries(active(k).filter(x => x.id !== hid).map(x => [x.id, k.plan.share[x.id]]));
    return { verdict: "others", variants: Object.assign({ equal, protect: pack(k, hid, solve(k1, { keep, free, floors })) }, more) };
  }
  function pack(k, hid, plan) {
    const c = compare(k.plan, plan), name = id => (k.households.find(x => x.id === id) || {}).name;
    const list = Object.entries(c).map(([id, x]) => Object.assign({ id, name: name(id) }, x));
    const others_loss = Object.entries(c).filter(([id, x]) => id !== hid && x.feed0 != null).reduce((s, [, x]) => s + Math.max(0, x.feed0 - x.feed1), 0);
    return {
      others_loss: r1(others_loss), others_loss_t: r1(J.hayTonnes(others_loss * params(k).intake, params(k))),
      plan, own: c[hid], deficit0_t: k.plan.deficit_t, deficit1_t: plan.deficit_t,
      losers: list.filter(lost).sort((x, y) => x.delta - y.delta),
      gainers: list.filter(x => x.delta != null && x.delta > TOL && x.id !== hid).sort((x, y) => y.delta - x.delta),
      affected: list.filter(x => x.id !== hid && x.route).map(x => x.id),          // у кого изменились участки или сроки
      farther: list.filter(x => x.id !== hid && x.km0 != null && x.km1 != null && x.km1 - x.km0 > FAR_KM),
    };
  }
  /** Принятие требует явного выбора варианта: кто-то другой теряет корм или ему станет дальше. */
  const needsChoice = e => e.verdict === "others" || !!(e.variants.equal && e.variants.equal.farther.length);
  /** Дворы, которым надо ответить заново: изменился маршрут или доля стала меньше. */
  const mustReconfirm = (before, after) => Object.entries(compare(before, after)).filter(([, x]) => x.route || lost(x)).map(([id]) => id);

  // ---------- объяснение ----------
  /**
   * Почему у двора такой участок — кодами, чтобы показать на любом языке:
   * daily (дойное — у села), far (дальний — ближние берегут), nearest (ближе свободного нет), closer_full (ближние заняты до предела), kept (прежний участок сохранён).
   */
  function why(k, hid) {
    const P = params(k), list = active(k), h = list.find(x => x.id === hid);
    if (!h) return [];
    const byId = Object.fromEntries(k.snapshot.plots.map(p => [p.id, p]));
    const prep = J._internal.prepare(k.snapshot.plots, P, {}), cap = Object.fromEntries(prep.map(q => [q.id, q.cap]));
    const used = {};
    for (const a of Object.values(k.plan.alloc)) for (const [id, v] of Object.entries(a)) used[id] = (used[id] || 0) + v;
    const home = byId[h.home] || k.snapshot.plots[0], can = candidates(k, h);
    const km = id => r1(J._internal.dist(home, byId[id]));
    return plotsOf(k.plan.routes[hid]).map(id => {
      const p = byId[id], closer = can.filter(x => x !== id && byId[x].ring === p.ring && km(x) < km(id) - 0.05);
      const full = closer.filter(x => (used[x] || 0) >= cap[x] - 1);
      const codes = [];
      if (h.daily_return) codes.push("daily"); else if (p.ring === "far") codes.push("far");
      if (!closer.length) codes.push("nearest"); else if (full.length === closer.length) codes.push("closer_full"); else codes.push("shared");
      if ((h.prefer || []).includes(id) || (h.prefer_soft || []).includes(id)) codes.push("preferred");
      return { plot: id, km: km(id), codes, closer_full: full, water: p.water_status || null, load: k.plan.load[id] };
    });
  }

  // ---------- поголовье: проверка против сведений акимата ----------
  function herdTotals(k) {
    const t = { sheep: 0, goats: 0, cattle: 0, horses: 0 };
    for (const h of active(k)) for (const s of SPECIES) t[s] += (h.herd && h.herd[s]) || 0;
    return t;
  }
  /** Заявлено дворами против числа, которое внёс организатор (например, из базы идентификации). Не обвинение: повод уточнить. */
  function herdCheck(k) {
    const t = herdTotals(k), o = k.official;
    if (!o) return { declared: t, official: null, over: [] };
    return { declared: t, official: o, over: SPECIES.filter(s => o[s] != null && t[s] > o[s] * 1.05 + 1).map(s => ({ species: s, declared: t[s], official: o[s] })) };
  }

  // ---------- наблюдения людей ----------
  // Причины возражений, которые говорят о самом участке. Наблюдение числа не меняет: только «проверить на месте».
  const OBS = ["no_grass", "weeds", "no_water", "far"];
  const OBS_DAYS = 15;                           // снимок и наблюдение — об одном времени, если между ними не больше 15 суток
  const OBS_SPARSE = 0.25;                       // ниже — по снимку трава редкая (та же граница, что в легенде карты)
  const dayNo = s => Math.round(Date.parse(s + "T00:00:00Z") / 864e5);
  /** Наблюдения из возражений: одно на двор, участок и причину (последнее). Отозванные самим двором не считаются. */
  function observations(k) {
    const out = {}, alive = new Set(active(k).map(h => h.id));
    for (const p of k.proposals || [])
      if (["avoid", "swap"].includes(p.type) && OBS.includes(p.reason) && p.status !== "withdrawn" && alive.has(p.household))
        out[p.household + p.plot + p.reason] = { household: p.household, plot: p.plot, reason: p.reason, on: p.observed_on || null, at: p.at || null };
    return Object.values(out);
  }
  /**
   * Наблюдение против данных, только за одно и то же время.
   * verdict: check — расходится или снимок этого не видит (проверить на месте); match — сходится; other_time — данные за другое время, не сравниваем;
   *          no_date — не сказано, когда видели; info — сравнивать не с чем (далеко).
   */
  function compareObs(o, plot, source, P0) {
    if (o.reason === "far" || !plot) return { verdict: "info" };
    if (!o.on) return { verdict: "no_date" };
    const d = dayNo(o.on);
    if (o.reason === "no_water") {
      const P = J.params(P0 || null), from = dayNo(`${source.year}-${P.season_start || "05-01"}`);
      if (d < from || d >= from + P.season_days) return { verdict: "other_time" };
      return ["unknown", "absent"].includes(plot.water_status) || (!plot.water_status && !plot.water) ? { verdict: "match", why: "water_unknown" } : { verdict: "check", why: "water_listed" };
    }
    const near = (plot.series || []).map(s => ({ d: s.d, v: s.v, gap: Math.abs(dayNo(s.d) - d) })).filter(s => s.gap <= OBS_DAYS).sort((a, b) => a.gap - b.gap)[0];
    if (!near) return { verdict: "other_time" };
    const scene = { scene: near.d, ndvi: near.v };
    if (o.reason === "weeds") return Object.assign({ verdict: "check", why: "sat_blind" }, scene);
    return Object.assign(near.v < OBS_SPARSE ? { verdict: "match", why: "sat_sparse" } : { verdict: "check", why: "sat_green" }, scene);
  }
  /** Сводка по участкам: { участок: { verdict, items: [{ reason, households, dates, verdict, why, scene, ndvi }] } }. */
  function plotObs(list, plots, source, P) {
    const rank = ["check", "match", "other_time", "no_date", "info"], out = {};
    for (const o of list) {
      const c = compareObs(o, plots.find(p => p.id === o.plot), source, P), g = (out[o.plot] = out[o.plot] || { verdict: "info", items: [] });
      let i = g.items.find(x => x.reason === o.reason && x.verdict === c.verdict && x.why === c.why);
      if (!i) g.items.push(i = Object.assign({ reason: o.reason, households: [], dates: [] }, c));
      if (!i.households.includes(o.household)) i.households.push(o.household);
      if (o.on && !i.dates.includes(o.on)) i.dates.push(o.on);
      if (rank.indexOf(c.verdict) < rank.indexOf(g.verdict)) g.verdict = c.verdict;
    }
    for (const g of Object.values(out)) { g.items.sort((a, b) => rank.indexOf(a.verdict) - rank.indexOf(b.verdict)); g.items.forEach(i => i.dates.sort()); }
    return out;
  }
  const obsOf = k => plotObs(observations(k), k.snapshot.plots, k.snapshot.source, k.snapshot.params);

  // ---------- протокол ----------
  /** agree — согласен с текущей версией; object — возражает; pending — не ответил на текущую версию. */
  function answerState(k, h) {
    const a = h.answer;
    if (!k.version || !a || a.version !== k.version) return "pending";
    return a.value;
  }
  function protocol(k) {
    const list = active(k), st = { agree: [], object: [], pending: [] };
    for (const h of list) st[answerState(k, h)].push(h.id);
    const now = k.plan;
    return {
      title: k.title, village: k.village, created: k.created, closed: k.closed || null, version: k.version, versions: (k.versions || []).length,
      rule: k.rule, outcome: !k.version ? "not_started" : st.agree.length === list.length ? "agreed" : st.object.length ? "disagreed" : "unanswered",
      counts: { total: list.length, agree: st.agree.length, object: st.object.length, pending: st.pending.length },
      households: list.map(h => ({ id: h.id, name: h.name, herd: h.herd, herd_status: h.herd_status, weight: h.weight || 1, daily_return: !!h.daily_return,
        share: now ? now.share[h.id] : null, days: now ? now.days[h.id] : null, route: now ? now.routes[h.id] : [], answer: answerState(k, h),
        answered_at: h.answer && h.answer.version === k.version ? h.answer.at : null, carried: !!(h.answer && h.answer.version === k.version && h.answer.carried) })),
      decisions: (k.proposals || []).map(p => ({ id: p.id, household: p.household, type: p.type, plot: p.plot || null, to: p.to || null, herd: p.herd || null, reason: p.reason || null, observed_on: p.observed_on || null,
        status: p.status, variant: p.variant || null, version: p.version, decided_at: p.decided_at || null,
        losers: p.effect && p.effect.variants && p.variant && p.effect.variants[p.variant] ? p.effect.variants[p.variant].losers.map(x => ({ id: x.id, delta: x.delta })) : [] })),
      snapshot: { source: k.snapshot.source, check: k.snapshot.check, norm: k.snapshot.norm || null, model_version: k.snapshot.model_version, deficit_t: now ? now.deficit_t : null, status: now ? now.status : null },
      observations: obsOf(k), herds: herdCheck(k), restored: k.restored || null,
      // что этот документ не делает — показывать всегда
      limits: ["not_a_contract", "no_land_rights", "herds_declared", "model_estimate"],
    };
  }

  return { REASONS, TYPES, RULES, WEIGHTS, SPECIES, TOL, SHIFT_DAYS, active, herdOf, allowedOf, solve, compare, routeChanged, plotsOf, applyProposal, candidates, effect, needsChoice, mustReconfirm,
    why, herdTotals, herdCheck, answerState, protocol, withHousehold, OBS, observations, compareObs, plotObs, obsOf };
});
