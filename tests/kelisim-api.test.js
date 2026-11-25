// Келісім, сервер (kelisim.js + api.js): личные ссылки, ответы, версии, решения, гонки, перезапуск, выгрузка, приватность.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { createApi } = require("../api.js");
const { createKelisim, MAX } = require("../kelisim.js");
const { memoryKv } = require("../store.js");
const N = require("../web/norms.js");
const NG = require("../web/nograze.js");
const { loadExamples } = require("../data");

const [BES, KEG] = loadExamples();
const vkey = (lat, lon) => `${(+lat).toFixed(3)},${(+lon).toFixed(3)}`;
const snap = (D = KEG, norm = true) => ({ village: D.village, plots: NG.apply(D.plots, D.nograze), params: {}, norm: norm ? { region: N.regionOf(D.village.region) } : undefined,
  source: { year: D.source.year, dates: D.source.dates, nograze: "ok" } });

let base, server;
const kv = memoryKv();
const villages = { [vkey(KEG.village.lat, KEG.village.lon)]: { data: KEG } };
test.before(async () => {
  const api = createApi({ getState: () => ({ users: {}, villages }), save() {}, kv, vkey, botUsername: "x", onFarmSaved() {}, allowedOrigins: ["http://site"], kelisimSecret: "s" });
  server = http.createServer((q, r) => api.handle(q, r).then(d => { if (!d) r.writeHead(404).end(); }));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port + "/api/kelisim";
});
test.after(() => server.close());
let ipn = 0;
async function call(method, p, key, body, ip = "10.1." + (ipn++ >> 8) + "." + (ipn & 255)) {
  const r = await fetch(base + p, { method, headers: Object.assign({ origin: "http://site", "x-forwarded-for": ip }, key ? { authorization: "Kelisim " + key } : {}, body ? { "content-type": "application/json" } : {}), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, d: await r.json().catch(() => null) };
}
const three = [{ name: "Двор Ақ", herd: { sheep: 600, cattle: 40 }, home: "Б-С" }, { name: "Двор Көк", herd: { sheep: 400, horses: 20 }, home: "Б-Ю" }, { name: "Двор Сары", herd: { cattle: 25 }, home: "Б-З", daily_return: true }];
/** Новое согласование: { id, org, keys: { h1, … }, st() } */
async function make(o = {}) {
  const r = await call("POST", "", null, Object.assign({ title: "Кеген 2027", snapshot: snap(), households: three }, o));
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const keys = Object.fromEntries(r.d.links.map(l => [l.id, l.key]));
  return { id: r.d.id, org: r.d.organizer_key, keys, first: r.d, st: async (k = r.d.organizer_key) => (await call("GET", "/" + r.d.id, k)).d };
}
async function started(o) { const k = await make(o); const s = await k.st(); const r = await call("POST", `/${k.id}/start`, k.org, { rev: s.rev }); assert.equal(r.status, 200, JSON.stringify(r.d)); return k; }
const agree = (k, h, version = 1) => call("POST", `/${k.id}/answer`, k.keys[h], { value: "agree", version });
const object = (k, h, proposal, version = 1) => call("POST", `/${k.id}/answer`, k.keys[h], { value: "object", version, proposal });

test("весь путь: создать → дворы внесли скот → план → возражение → решение → согласие → протокол", async () => {
  const k = await make();
  assert.equal((await k.st()).status, "collect");
  // двор сам вносит скот по своей ссылке; организатор подтверждает
  let r = await call("POST", `/${k.id}/me`, k.keys.h1, { name: "Двор Ақ-Жол", herd: { sheep: 700, cattle: 30 }, home: "Б-С" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const me = r.d.state.households.find(h => h.id === "h1");
  assert.deepEqual([me.name, me.herd.sheep, me.herd_status, me.joined], ["Двор Ақ-Жол", 700, "declared", true]);
  assert.equal(me.herd_log.length, 1, "изменение скота записано и видно всем");
  let s = await k.st();
  r = await call("POST", `/${k.id}/households/h1`, k.org, { rev: s.rev, confirm: true });
  assert.equal(r.d.state.households[0].herd_status, "confirmed");
  // начать
  r = await call("POST", `/${k.id}/start`, k.org, { rev: r.d.state.rev });
  assert.equal(r.d.state.version, 1); assert.equal(r.d.state.status, "review");
  assert.ok(Object.values(r.d.state.plan.load).every(x => x == null || x <= 1.002));
  assert.equal((await call("POST", `/${k.id}/me`, k.keys.h1, { herd: { sheep: 9999 } })).status, 409, "после начала скот меняется только предложением");
  // ответы
  assert.equal((await agree(k, "h2")).d.state.households.find(h => h.id === "h2").answer, "agree");
  assert.equal((await agree(k, "h3")).status, 200);
  const v = await k.st(k.keys.h1);
  assert.equal(v.me, "h1"); assert.ok(v.why.length, "двор видит, почему ему такой участок");
  const plot = v.plan.routes.h1.find(x => x.plot).plot;
  const proposal = { type: "avoid", plot, reason: "no_grass", observed_on: "2026-07-20", text: "вытоптано" };
  const pre = await call("POST", `/${k.id}/preview`, k.keys.h1, { proposal });
  assert.equal(pre.status, 200); assert.equal((await k.st()).version, 1, "просмотр последствий ничего не меняет");
  r = await object(k, "h1", proposal);
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.deepEqual(r.d.proposal.effect, pre.d.effect, "ответ системы тот же, что при просмотре");
  assert.equal(r.d.state.households[0].answer, "object");
  // решение: принять — новая версия, незадетые согласия переносятся, просивший отвечает заново
  s = await k.st();
  r = await call("POST", `/${k.id}/decide`, k.org, { rev: s.rev, proposal: "p1", action: "accept", variant: "equal" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  s = r.d.state;
  assert.equal(s.version, 2);
  assert.ok(!(s.plan.alloc.h1[plot] > 0.5), "участок больше не назначен");
  assert.equal(s.households[0].answer, "pending");
  for (const h of s.households.slice(1)) assert.equal(h.answer, s.versions[1].changed.includes(h.id) ? "pending" : "agree", h.id);
  assert.ok(s.households.slice(1).some(h => h.carried), "хотя бы один незадетый двор не отвечает заново");
  assert.equal((await agree(k, "h1", 1)).status, 409, "ответ на старую версию не принимается");
  for (const h of s.households.filter(x => x.answer === "pending")) assert.equal((await agree(k, h.id, 2)).status, 200);
  s = await k.st();
  r = await call("POST", `/${k.id}/close`, k.org, { rev: s.rev });
  assert.equal(r.d.protocol.outcome, "agreed"); assert.deepEqual(r.d.protocol.counts, { total: 3, agree: 3, object: 0, pending: 0 });
  assert.equal(r.d.protocol.decisions[0].status, "accepted");
  assert.equal((await agree(k, "h1", 2)).status, 409, "закрыто");
  assert.equal((await call("GET", `/${k.id}/protocol`, k.keys.h2)).d.outcome, "agreed", "протокол видит и двор");
});

test("доступ: чужая ссылка, чужие действия, перевыпуск, свободный текст возражений", async () => {
  const k = await started();
  for (const key of [null, "x".repeat(24), k.org + "a"]) assert.equal((await call("GET", "/" + k.id, key)).status, 403);
  assert.equal((await call("GET", "/AAAAAAAAAAAAAAAA", k.org)).status, 404);
  const other = await started();
  assert.equal((await call("GET", "/" + k.id, other.org)).status, 403, "ссылка другого согласования");
  assert.equal((await call("GET", "/" + k.id, other.keys.h1)).status, 403);
  const rev = (await k.st()).rev;
  for (const [p, b] of [["start", { rev }], ["decide", { rev, proposal: "p1", action: "decline" }], ["rule", { rev, rule: "household" }], ["settings", { rev, deadline: "2027-01-01" }], ["close", { rev }], ["households", { name: "Х" }], ["households/h2", { rev, herd: { sheep: 1 } }], ["households/h2/link", {}]])
    assert.equal((await call("POST", `/${k.id}/${p}`, k.keys.h1, b)).status, 403, p);
  assert.equal((await call("GET", `/${k.id}/export`, k.keys.h1)).status, 403);
  assert.equal((await call("DELETE", "/" + k.id, k.keys.h1)).status, 403);
  assert.equal((await call("POST", `/${k.id}/answer`, k.org, { value: "agree", version: 1 })).status, 403, "организатор не отвечает за двор");
  // текст возражения — автору и организатору; причина и участок — всем
  await object(k, "h1", { type: "other", text: "личное пояснение" });
  const p = async key => (await k.st(key)).proposals[0];
  assert.equal((await p(k.org)).text, "личное пояснение"); assert.equal((await p(k.keys.h1)).text, "личное пояснение"); assert.equal((await p(k.keys.h2)).text, undefined);
  assert.equal((await k.st(k.keys.h2)).log, undefined, "журнал — только организатору");
  // потерянная ссылка: новая работает, старая нет
  const r = await call("POST", `/${k.id}/households/h2/link`, k.org, {});
  assert.equal((await call("GET", "/" + k.id, k.keys.h2)).status, 403);
  assert.equal((await call("GET", "/" + k.id, r.d.link.key)).d.me, "h2");
  // секретов на сервере нет
  const raw = JSON.stringify(await kv.get("kel:" + k.id));
  for (const key of [k.org, ...Object.values(k.keys), r.d.link.key]) assert.ok(!raw.includes(key), "секрет ссылки не хранится");
  assert.ok(!JSON.stringify(await k.st()).includes("_hash"), "хеши наружу не отдаются");
});

test("гонки: два ответа сразу сохраняются оба; два решения по одной версии — проходит одно", async () => {
  const k = await started();
  const [a, b, c] = await Promise.all([agree(k, "h1"), agree(k, "h2"), agree(k, "h3")]);
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
  let s = await k.st();
  assert.deepEqual(s.households.map(h => h.answer), ["agree", "agree", "agree"]);
  const rev = s.rev;
  const [x, y] = await Promise.all([call("POST", `/${k.id}/rule`, k.org, { rev, rule: "household" }), call("POST", `/${k.id}/households/h1`, k.org, { rev, weight: 2 })]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409], "второе решение не затирает первое");
  s = await k.st();
  assert.equal(s.version, 2); assert.equal(s.rev, rev + 1);
});

test("перезапуск сервера: состояние на месте, ссылки работают; ключ хранения — с сроком", async () => {
  const k = await started();
  await agree(k, "h1");
  const again = createKelisim({ kv, secret: "s" });
  const v = await again.get(k.id, k.keys.h1);
  assert.equal(v.households[0].answer, "agree"); assert.equal(v.version, 1);
  let ttl = null;
  const spy = createKelisim({ kv: { get: kv.get, del: kv.del, set: (key, val, t) => { if (key.startsWith("kel:")) ttl = t; return kv.set(key, val, t); } }, secret: "s" });
  await spy.answer(k.id, k.keys.h2, { value: "agree", version: 1 });
  assert.equal(ttl, 180 * 24 * 3600);
});

test("решение, при котором теряют другие, — только явным выбором варианта; protect бережёт соседей", async () => {
  // дефицит: много скота в Бесколе; один двор просит учесть втрое больше
  const list = Array.from({ length: 6 }, (_, i) => ({ name: "Д" + i, herd: { sheep: 1500, cattle: 60 }, home: "Б-З" }));
  const k = await started({ snapshot: snap(BES), households: list });
  let s = await k.st();
  assert.ok(s.plan.deficit_t > 1, "корма не хватает");
  assert.equal(s.snapshot.check.status, "unknown", "Бесколя на этом сервере нет — снимок не проверен, и это видно");
  const r = await object(k, "h1", { type: "herd", herd: { sheep: 4500, cattle: 180 } });
  assert.equal(r.d.proposal.effect.verdict, "others");
  assert.ok(r.d.proposal.effect.variants.equal.losers.some(x => x.id !== "h1"), "видно, кто и сколько теряет");
  const feed0 = s.plan.feed, share0 = s.plan.share;
  s = await k.st();
  let d = await call("POST", `/${k.id}/decide`, k.org, { rev: s.rev, proposal: "p1", action: "accept" });
  assert.equal(d.status, 409); assert.equal(d.d.effect.verdict, "others");
  d = await call("POST", `/${k.id}/decide`, k.org, { rev: s.rev, proposal: "p1", action: "accept", variant: "protect" });
  assert.equal(d.status, 200, JSON.stringify(d.d));
  const pl = d.d.state.plan;
  for (const id of ["h2", "h3", "h4", "h5", "h6"]) assert.ok(pl.share[id] >= share0[id] - 0.01, id + " не потерял");
  assert.ok(pl.feed.h1 <= feed0.h1 * 1.05, "завышение не дало корма");
  assert.equal(d.d.state.households[0].herd_status, "declared");
  assert.equal(d.d.state.households[0].herd_log[0].by, "h1", "кто изменил скот — видно");
});

test("отказ, замена возражения, отзыв согласием, словесное возражение", async () => {
  const k = await started();
  const v = await k.st(k.keys.h1), plot = v.plan.routes.h1.find(x => x.plot).plot;
  await object(k, "h1", { type: "avoid", plot, reason: "far" });
  await object(k, "h1", { type: "avoid", plot, reason: "weeds" });
  let s = await k.st();
  assert.deepEqual(s.proposals.map(p => p.status), ["withdrawn", "open"], "новое возражение заменяет прежнее");
  let r = await call("POST", `/${k.id}/decide`, k.org, { rev: s.rev, proposal: "p2", action: "decline", note: "решили на сходе" });
  assert.equal(r.d.state.proposals[1].status, "declined");
  assert.equal(r.d.state.households[0].answer, "object", "отказ не делает двор согласным");
  assert.equal((await call("POST", `/${k.id}/decide`, k.org, { rev: r.d.state.rev, proposal: "p2", action: "accept" })).status, 409, "уже рассмотрено");
  assert.equal((await k.st(k.keys.h1)).proposals[1].note, "решили на сходе", "пояснение отказа видно автору");
  await object(k, "h2", { type: "other", text: "не успеваем к 1 мая" });
  s = await k.st();
  assert.equal((await call("POST", `/${k.id}/decide`, k.org, { rev: s.rev, proposal: "p3", action: "accept" })).status, 409, "слова расчётом не принять");
  await agree(k, "h2");
  assert.equal((await k.st()).proposals[2].status, "withdrawn", "согласие снимает своё возражение");
  s = await k.st();
  r = await call("POST", `/${k.id}/close`, k.org, { rev: s.rev });
  assert.equal(r.d.protocol.outcome, "disagreed", "протокол с разногласием закрывается — решает сход");
});

test("план изменился после возражения — сначала свежие последствия, решение только по ним", async () => {
  const k = await started(), plot = (await k.st(k.keys.h1)).plan.routes.h1.find(x => x.plot).plot;
  await object(k, "h1", { type: "avoid", plot, reason: "crowded" });
  let s = await k.st();
  s = (await call("POST", `/${k.id}/households/h2`, k.org, { rev: s.rev, herd: { sheep: 2500, horses: 60 } })).d.state;
  assert.equal(s.version, 2);
  assert.equal(s.households[0].answer, "object", "нерассмотренное возражение остаётся в силе и в новой версии");
  let r = await call("POST", `/${k.id}/decide`, k.org, { rev: s.rev, proposal: "p1", action: "accept", variant: "equal" });
  assert.equal(r.status, 200); assert.equal(r.d.stale, true);
  assert.equal(r.d.state.version, 2, "по старым числам ничего не принято"); assert.equal(r.d.state.proposals[0].status, "open");
  r = await call("POST", `/${k.id}/decide`, k.org, { rev: r.d.state.rev, proposal: "p1", action: "accept", variant: "equal" });
  assert.equal(r.status, 200, JSON.stringify(r.d)); assert.equal(r.d.stale, undefined); assert.equal(r.d.state.version, 3);
});

test("пожелание участка соседа: без явного выбора не принимается; вариант room занимает только свободное место", async () => {
  const s0 = snap(), plots = s0.plots.map(p => Object.assign({}, p, { water_status: "confirmed", pasture_ha: { "Б-С": 130, "Б-Ю": 600 }[p.id] || 0, pasture_ha_gross: undefined, ndvi: 0.35 }));
  const k = await started({ snapshot: Object.assign(s0, { plots, norm: undefined }), households: [{ name: "А", herd: { sheep: 190 }, home: "Б-Ю" }, { name: "Б", herd: { sheep: 190 }, home: "Б-С" }] });
  const r = await object(k, "h1", { type: "prefer", plot: "Б-С", reason: "far" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.deepEqual(r.d.proposal.effect.variants.equal.farther.map(x => x.id), ["h2"]);
  const rev = (await k.st()).rev;
  assert.equal((await call("POST", `/${k.id}/decide`, k.org, { rev, proposal: "p1", action: "accept" })).status, 409);
  const d = await call("POST", `/${k.id}/decide`, k.org, { rev, proposal: "p1", action: "accept", variant: "room" });
  assert.equal(d.status, 200, JSON.stringify(d.d));
  assert.deepEqual(d.d.state.households[0].prefer_soft, ["Б-С"]); assert.deepEqual(d.d.state.households[0].prefer, []);
  assert.deepEqual(d.d.state.plan.routes.h2.filter(x => x.plot).map(x => x.plot), ["Б-С"], "сосед на своём месте");
});

test("выгрузка и восстановление: только организатор; изменённый файл не приносит чужих согласий", async () => {
  const k = await started();
  for (const h of ["h1", "h2"]) await agree(k, h);
  const file = (await call("GET", `/${k.id}/export`, k.org)).d;
  assert.equal((await call("POST", "/restore", k.org, file)).status, 409, "на сервере есть — не затирает");
  assert.equal((await call("DELETE", "/" + k.id, k.org)).status, 200);
  assert.equal((await call("GET", "/" + k.id, k.org)).status, 404);
  assert.equal((await call("POST", "/restore", k.keys.h1, file)).status, 403);
  let r = await call("POST", "/restore", k.org, file);
  assert.equal(r.status, 200, JSON.stringify(r.d)); assert.equal(r.d.verified, true);
  assert.deepEqual((await k.st(k.keys.h2)).households.map(h => h.answer), ["agree", "agree", "pending"], "ответы и ссылки дворов на месте");
  // подделка: «все согласны»
  await call("DELETE", "/" + k.id, k.org);
  const data = JSON.parse(file.data); data.households.forEach(h => { h.answer = { value: "agree", version: 1, at: "2026-11-25T00:00:00Z" }; }); data.households[0].name = "<b>Двор</b>";
  r = await call("POST", "/restore", k.org, Object.assign({}, file, { data: JSON.stringify(data) }));
  assert.equal(r.status, 200, JSON.stringify(r.d)); assert.equal(r.d.verified, false);
  assert.deepEqual(r.d.state.households.map(h => h.answer), ["pending", "pending", "pending"]);
  assert.ok(!/[<>]/.test(r.d.state.households[0].name));
  assert.equal((await call("GET", `/${k.id}/protocol`, k.org)).d.restored.verified, false, "в протоколе видно, что файл не подтверждён");
  assert.equal((await call("GET", "/" + k.id, k.keys.h3)).d.me, "h3");
  for (const bad of [{}, { format: "jaiylym-kelisim", data: "{" }, { format: "jaiylym-kelisim", data: "{}" }]) assert.equal((await call("POST", "/restore", k.org, bad)).status, 400);
});

test("снимок: сверка с сервером, норма нагрузки, неверные данные не принимаются", async () => {
  const k = await make();
  let s = await k.st();
  assert.deepEqual(s.snapshot.check, { status: "matched", plots: [] }, "Кеген посчитан на сервере — снимок сверен");
  assert.equal(s.snapshot.plots[0].norm.region, "ALM");
  const fake = snap(); fake.plots = fake.plots.map((p, i) => (i === 3 ? Object.assign({}, p, { pasture_ha: p.pasture_ha * 3, pasture_ha_gross: p.pasture_ha_gross * 3 }) : p));
  s = await (await make({ snapshot: fake })).st();
  assert.equal(s.snapshot.check.status, "differs"); assert.deepEqual(s.snapshot.check.plots, [fake.plots[3].id]);
  const bad = async (o, re) => { const r = await call("POST", "", null, Object.assign({ snapshot: snap(), households: three }, o)); assert.equal(r.status, 400, JSON.stringify(r.d).slice(0, 200)); if (re) assert.match(r.d.error, re); };
  await bad({ snapshot: null }, /снимка/);
  await bad({ snapshot: Object.assign(snap(), { plots: [] }) }, /участки/);
  await bad({ snapshot: Object.assign(snap(), { plots: snap().plots.map(p => Object.assign({}, p, { id: "Б-С" })) }) }, /повторяется/);
  await bad({ snapshot: Object.assign(snap(), { plots: snap().plots.map(p => Object.assign({}, p, { ndvi: 5 })) }) }, /NDVI/);
  await bad({ snapshot: Object.assign(snap(), { norm: { region: "XXX" } }) }, /норма/);
  await bad({ snapshot: Object.assign(snap(), { params: { util: 5 } }) }, /параметры/);
  await bad({ rule: "random" }, /правило/);
  await bad({ households: [{ name: "А", herd: { sheep: -1 } }] }, /овцы/);
  await bad({ households: [{ name: "А", weight: 9 }] }, /приоритет/);
  await bad({ households: [{ name: "" }] }, /имя/);
  await bad({ deadline: "2020-01-01" }, /прошёл/);
  assert.equal((await call("POST", "", null, { snapshot: snap(), households: [{ name: "А" }, { name: "а" }] })).status, 409, "одинаковые имена");
  assert.equal((await call("POST", "", null, { snapshot: snap(), households: Array.from({ length: MAX.households + 1 }, (_, i) => ({ name: "Д" + i })) })).status, 400);
});

test("приватность: телефон и ИИН не принимаются, разметка убирается, обычные даты и числа проходят", async () => {
  const k = await started();
  for (const t of ["звоните 8 701 123 45 67", "+77011234567", "ИИН 990101300123", "8(747)123-45-67"]) {
    const r = await object(k, "h1", { type: "other", text: t });
    assert.equal(r.status, 400, t); assert.match(r.d.error, /телефон или ИИН/);
  }
  const r = await object(k, "h1", { type: "other", text: "с 15.07.2026 по 20.08.2026 травы нет, было 350 овец <script>" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.ok(!/[<>]/.test(r.d.proposal.text));
  assert.equal((await call("POST", `/${k.id}/households`, k.org, { name: "Асан 87011234567" })).status, 400);
});

test("возражение: причина обязательна, дата и участок проверяются; нельзя начать дважды и без скота", async () => {
  const k = await started(), plot = (await k.st(k.keys.h1)).plan.routes.h1.find(x => x.plot).plot;
  for (const p of [{ type: "avoid", plot, reason: "weeds", observed_on: "2999-01-01" }, { type: "avoid", plot }, { type: "avoid", plot: "Д-Х", reason: "far" }, { type: "avoid", plot, reason: "zzz" }, { type: "avoid", plot, reason: "far", observed_on: "вчера" }, { type: "other" }, { type: "hack" }, { type: "herd", herd: { sheep: 1.5 } }, { type: "herd", herd: { sheep: 5 }, home: "Д-С" }])
    assert.equal((await object(k, "h1", p)).status, 400, JSON.stringify(p));
  assert.equal((await call("POST", `/${k.id}/answer`, k.keys.h1, { value: "maybe", version: 1 })).status, 400);
  assert.equal((await call("POST", `/${k.id}/start`, k.org, { rev: (await k.st()).rev })).status, 409);
  const e = await make({ households: [{ name: "А" }, { name: "Б" }] });
  assert.equal((await call("POST", `/${e.id}/start`, e.org, { rev: 1 })).status, 400, "ни один двор не внёс поголовье");
  assert.equal((await agree(e, "h1")).status, 409, "плана ещё нет");
  assert.equal((await call("POST", `/${e.id}/preview`, e.keys.h1, { proposal: { type: "avoid", plot, reason: "far" } })).status, 409);
});

test("участник: хозяйство или общее стадо, кто отвечает; сезон; сколько сена не хватает", async () => {
  const s0 = snap(BES);
  let r = await call("POST", "", null, { snapshot: s0, season: 1999, households: three });
  assert.equal(r.status, 400); assert.equal(r.d.why, "season");
  r = await call("POST", "", null, { snapshot: s0, households: [{ name: "Стадо", kind: "herd", herd: { cattle: 5 } }] });
  assert.equal(r.status, 400, "неизвестный вид участника");
  r = await call("POST", "", null, { snapshot: s0, rule: "household", households: [{ name: "Общее стадо", kind: "common", owners: 20, herd: { cattle: 900 }, home: "Б-С" }, { name: "Хозяйство", owners: 7, herd: { cattle: 900 }, home: "Б-Ю" }] });
  assert.equal(r.status, 200);
  const org = r.d.organizer_key, id = r.d.id, [a, b] = r.d.state.households, key = r.d.links[0].key;
  assert.deepEqual([a.kind, a.owners, a.resp, b.kind, b.owners, b.resp], ["common", 20, "herder", "farm", null, "owner"], "у хозяйства один хозяин; за общее стадо по умолчанию отвечает пастух");
  assert.ok([0, 1].includes(r.d.state.season - new Date().getUTCFullYear()));
  r = await call("POST", `/${id}/me`, key, { name: "Общее стадо", kind: "common", owners: 30, resp: "owner", herd: { cattle: 900 }, home: "Б-С" });
  assert.deepEqual([r.d.state.households[0].owners, r.d.state.households[0].resp], [30, "owner"]);
  r = await call("POST", `/${id}/start`, org, { rev: r.d.state.rev });
  const P1 = r.d.state.plan;
  assert.ok(P1.share[a.id] >= P1.share[b.id], "общее стадо получает за всех хозяев");
  // меньше хозяев — меньше корма при правиле «поровну»
  r = await call("POST", `/${id}/households/${a.id}`, org, { rev: r.d.state.rev, kind: "common", owners: 2 });
  assert.equal(r.d.state.version, 2); assert.ok(r.d.state.plan.share[a.id] <= P1.share[a.id]);
  const p = (await call("GET", `/${id}/protocol`, org)).d, h = p.households[0], P2 = r.d.state.plan;
  assert.equal(p.season, r.d.state.season);
  assert.ok(Math.abs(p.households.reduce((s, x) => s + x.hay_t, 0) - P2.deficit_t) < 0.3, "тонны участников сходятся с общей нехваткой");
  assert.equal(h.owners, 2);
});

test("срок ответа: после него двор ответить не может, организатор может продлить", async () => {
  const t = Date.parse("2026-11-25T06:00:00Z"); let now = t;
  const kel = createKelisim({ kv: memoryKv(), secret: "s", now: () => now });
  const c = await kel.create({ snapshot: snap(), households: three, deadline: "2026-11-28" });
  let s = (await kel.start(c.id, c.organizer_key, { rev: 1 })).state;
  now = Date.parse("2026-11-28T18:00:00Z");                        // 23:00 по Казахстану — ещё можно
  assert.equal((await kel.answer(c.id, c.links[0].key, { value: "agree", version: 1 })).state.households[0].answer, "agree");
  now = Date.parse("2026-11-29T06:00:00Z");
  await assert.rejects(kel.answer(c.id, c.links[1].key, { value: "agree", version: 1 }), /срок ответа прошёл/);
  s = await kel.get(c.id, c.organizer_key);
  assert.equal(s.expired, true);
  await kel.setSettings(c.id, c.organizer_key, { rev: s.rev, deadline: "2026-12-05" });
  assert.equal((await kel.answer(c.id, c.links[1].key, { value: "agree", version: 1 })).state.households[1].answer, "agree");
});

test("новый двор и удаление двора после начала — новая версия; незадетые не отвечают заново", async () => {
  const k = await started();
  for (const h of ["h1", "h2", "h3"]) await agree(k, h);
  let r = await call("POST", `/${k.id}/households`, k.org, { name: "Двор новый", herd: { sheep: 50 }, home: "Б-В" });
  assert.equal(r.status, 200, JSON.stringify(r.d)); assert.equal(r.d.state.version, 2);
  assert.ok(r.d.link.key); assert.equal(r.d.state.households[3].answer, "pending");
  assert.ok(r.d.state.households.slice(0, 3).filter(h => h.answer === "agree").length >= 2, "маленькое новое стадо почти никого не двигает");
  r = await call("POST", `/${k.id}/households/h4`, k.org, { rev: r.d.state.rev, remove: true });
  assert.equal(r.d.state.households.length, 3); assert.equal(r.d.state.version, 3);
  const raw = await kv.get("kel:" + k.id);
  assert.equal(raw.households.find(h => h.id === "h4").key_hash, null, "ссылка удалённого двора отозвана");
});

test("один участник не отнимает возможность возразить у остальных", async () => {
  const k = await started();
  let last;
  for (let i = 0; i < 21; i++) last = await object(k, "h1", { type: "other", text: "спам " + i });
  assert.equal(last.status, 429); assert.equal(last.d.why, "objections");
  assert.equal((await object(k, "h2", { type: "other", text: "моё возражение" })).status, 200);
  assert.equal((await agree(k, "h1")).status, 200, "согласиться он по-прежнему может");
});

test("тяжёлые расчёты идут по одному: сервер тем временем отвечает остальным", async () => {
  const big = Array.from({ length: 40 }, (_, i) => ({ name: "Участник " + i, herd: { sheep: 300 + i * 10, cattle: 20 }, home: "Б-С" }));
  const k = await started({ snapshot: snap(BES), households: big });
  const one = async () => { const t = Date.now(); const r = await call("POST", `/${k.id}/preview`, k.keys.h1, { proposal: { type: "herd", herd: { sheep: 20000 } } }); assert.equal(r.status, 200); return Date.now() - t; };
  const alone = await one(), many = Array.from({ length: 6 }, one);
  await new Promise(r => setTimeout(r, 30));
  const t = Date.now(); assert.equal((await call("GET", "/" + k.id, k.org)).status, 200);
  const light = Date.now() - t; await Promise.all(many);
  assert.ok(light < alone * 3 + 300, `обычный запрос ждал ${light} мс при одном расчёте ${alone} мс`);
});

test("предел частоты: поток новых согласований и запросов с одного адреса", async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await call("POST", "", null, { snapshot: snap(), households: three }, "10.9.9.9");
  assert.equal(last.status, 429);
  const k = await make(); let code = 0;
  for (let i = 0; i < 130 && code !== 429; i++) code = (await call("GET", "/" + k.id, k.org, undefined, "10.9.9.8")).status;
  assert.equal(code, 429);
});
