/*
 * JAIYLYM Келісім — сервер: состояние согласования, личные ссылки, ответы, версии плана, протокол. Расчёт — web/kelisim.js.
 *
 * Ход: collect (дворы вносят скот) → review (план версии N, ответы) → closed (протокол).
 *  - Доступ — секрет в личной ссылке (у организатора свой, у каждого двора свой). Секрет в адресе после # и в заголовке
 *    Authorization: Kelisim <секрет>, на сервере хранится только SHA-256. Потерянную ссылку организатор перевыпускает.
 *  - Аккаунт не нужен. Телефоны, ИИН и ФИО не нужны: похожее на номер не принимается.
 *  - Участки и параметры — снимок расчёта организатора; сервер сверяет его со своими данными, если они есть (snapshot.check).
 *  - План, ответы и последствия считает сервер. Поголовье и решения видны всем участникам и пишутся в журнал.
 *  - Одновременные правки: запись по очереди на одно согласование; ответ двора привязан к версии плана, решение организатора — к rev.
 *  - Хранение: отдельная запись kv kel:<id> на 180 дней. Тариф хранилища без сохранения на диск, поэтому организатор может
 *    выгрузить файл и восстановить согласование (подпись файла проверяется; без неё — пометка в протоколе).
 */
const crypto = require("crypto");
const K = require("./web/kelisim.js");
const M = require("./web/model.js");
const NM = require("./web/norms.js");

const TTL = 180 * 24 * 3600;
const MAX = { households: 60, proposals: 300, log: 600, versions: 40, text: 300, perDay: 200 };
const PLOT_RE = /^[БД]-(С|СВ|В|ЮВ|Ю|ЮЗ|З|СЗ)$/;
const DIST = { near: 1.8, far: 5.5 };
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const rnd = n => crypto.randomBytes(n).toString("base64url");
const err = (code, message, extra) => Object.assign(new Error(message), { code }, extra ? { extra } : {});
const bad = m => err(400, m);
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const str = (x, max) => String(x == null ? "" : x).replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const PHONE = /(?:(?:\+?7|8)[\s(.-]*)?7\d{2}[\s).-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}/, IIN = /\d{6}\s?\d{6}/;
/** Текст от людей: без разметки и без того, что похоже на телефон или ИИН. */
function text(x, max, what) {
  const s = str(x, max);
  if (PHONE.test(s) || IIN.test(s)) throw bad(what + ": не указывайте телефон или ИИН");
  return s;
}
function int(x, max, what) {
  if (x == null || x === "") return 0;
  const n = +x;
  if (!Number.isInteger(n) || n < 0 || n > max) throw bad(`${what}: целое число от 0 до ${max}`);
  return n;
}
const SPECIES_RU = { sheep: "овцы", goats: "козы", cattle: "КРС", horses: "лошади" };
const herd = b => Object.fromEntries(K.SPECIES.map(s => [s, int(b && b[s], 20000, SPECIES_RU[s])]));
const isNear = id => id.startsWith("Б");
function plotList(x, what) {
  if (x == null) return [];
  if (!Array.isArray(x) || x.some(id => !PLOT_RE.test(id))) throw bad(what + ": неизвестный участок");
  return [...new Set(x)];
}

// ---------- снимок расчёта ----------
function cleanSnapshot(b, known) {
  if (!b || typeof b !== "object") throw bad("нет снимка расчёта");
  const v = b.village || {};
  if (!Number.isFinite(+v.lat) || !Number.isFinite(+v.lon) || Math.abs(v.lat) > 90 || Math.abs(v.lon) > 180) throw bad("в снимке нет села");
  if (!Array.isArray(b.plots) || b.plots.length < 4 || b.plots.length > 16) throw bad("участки: от 4 до 16");
  const numOr = (x, lo, hi) => (x == null || x === "" || !Number.isFinite(+x) ? null : Math.min(hi, Math.max(lo, +x)));
  const ids = new Set();
  const norm = b.norm == null ? null : NM.pick(NM.clean(b.norm));
  if (b.norm != null && !norm) throw bad("норма нагрузки: неизвестная область");
  const plots = b.plots.map(p => {
    if (!p || !PLOT_RE.test(p.id) || ids.has(p.id)) throw bad("участки: неизвестный или повторяется");
    ids.add(p.id);
    const ha = +p.pasture_ha;
    if (!Number.isFinite(ha) || ha < 0 || ha > 20000) throw bad(`участок ${p.id}: неверная площадь`);
    if (p.ndvi != null && (!Number.isFinite(+p.ndvi) || Math.abs(+p.ndvi) > 1)) throw bad(`участок ${p.id}: неверный NDVI`);
    const ws0 = M.WATER_STATUS.includes(p.water_status) ? p.water_status : M.waterStatus({ ring: isNear(p.id) ? "near" : "far", water: !!p.water, water_source: str(p.water_source, 60) });
    const ws = M.WATER_STATUS.includes(ws0) ? ws0 : "unknown";
    const win = p.window && Number.isInteger(+p.window.from) && Number.isInteger(+p.window.to) ? { from: Math.max(1, +p.window.from), to: Math.min(365, +p.window.to) } : null;
    const ring = isNear(p.id) ? "near" : "far";
    const out = {
      id: p.id, ring, dir: p.id.slice(2), dist_km: numOr(p.dist_km, 0, 30) == null ? DIST[ring] : numOr(p.dist_km, 0, 30),
      pasture_ha: +ha.toFixed(1), pasture_ha_gross: numOr(p.pasture_ha_gross, 0, 20000), nograze_ha: numOr(p.nograze_ha, 0, 20000),
      ndvi: p.ndvi == null ? null : +(+p.ndvi).toFixed(3), valid_fraction: numOr(p.valid_fraction, 0, 1), samples: numOr(p.samples, 0, 1e7), px_ha: numOr(p.px_ha, 0, 100), obs_count: numOr(p.obs_count, 0, 100),
      series: (Array.isArray(p.series) ? p.series : []).slice(0, 12).filter(s => s && /^\d{4}-\d{2}-\d{2}$/.test(s.d) && Number.isFinite(+s.v)).map(s => ({ d: s.d, v: +(+s.v).toFixed(3) })),
      water_status: ws, forbidden: !!p.forbidden,
    };
    for (const key of ["valid_fraction", "samples", "px_ha", "obs_count", "pasture_ha_gross", "nograze_ha"]) if (out[key] == null) delete out[key];
    out.water = M.waterUsable(out);
    if (win && win.to >= win.from) out.window = win;
    if (norm) out.norm = norm;
    return out;
  });
  const params = M.validate(b.params || {});
  if (!params.ok) throw bad("параметры модели: " + params.errors.map(e => `${e.key} ${e.reason}`).join("; "));
  const s = b.source || {};
  return {
    village: { name: text(v.name, 80, "село") || "Село", lat: +(+v.lat).toFixed(5), lon: +(+v.lon).toFixed(5) },
    plots, params: params.values, norm, model_version: M.MODEL_VERSION,
    source: { year: int(s.year, 2100, "год"), dates: (Array.isArray(s.dates) ? s.dates : []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 30), nograze: ["ok", "empty", "error"].includes(s.nograze) ? s.nograze : "none" },
    check: checkSnapshot(plots, known && known(+v.lat, +v.lon)), taken: new Date().toISOString(),
  };
}
/** Сверка снимка с данными сервера (если село там посчитано): matched | differs | unknown. */
function checkSnapshot(plots, data) {
  if (!data || !Array.isArray(data.plots)) return { status: "unknown", plots: [] };
  const differs = plots.filter(p => {
    const q = data.plots.find(x => x.id === p.id);
    if (!q) return true;
    const a = p.pasture_ha_gross == null ? p.pasture_ha : p.pasture_ha_gross;
    return Math.abs(a - q.pasture_ha) > Math.max(2, q.pasture_ha * 0.05) || (p.ndvi == null) !== (q.ndvi == null) || (p.ndvi != null && Math.abs(p.ndvi - q.ndvi) > 0.03);
  }).map(p => p.id);
  return { status: differs.length ? "differs" : "matched", plots: differs };
}

// ---------- дворы ----------
function cleanHousehold(b, k) {
  const name = text(b && b.name, 60, "имя двора");
  if (!name) throw bad("укажите имя двора (например, «Двор у моста»)");
  if (k.households.some(h => !h.removed && h.name.toLowerCase() === name.toLowerCase())) throw err(409, "двор с таким именем уже есть");
  const home = b.home && PLOT_RE.test(b.home) && isNear(b.home) ? b.home : k.snapshot.plots.filter(p => p.ring === "near").map(p => p.id)[0] || k.snapshot.plots[0].id;
  return Object.assign({ name, herd: herd(b.herd), home, daily_return: !!b.daily_return, weight: weight(b.weight), allowed: plotList(b.allowed, "участки двора"), avoid: [], prefer: [], prefer_soft: [],
    herd_status: b.herd ? "entered" : "none", joined: null, answer: null, herd_log: [] });
}
function weight(x) {
  if (x == null || x === "") return 1;
  if (!K.WEIGHTS.includes(+x)) throw bad("приоритет: 1, 1.5 или 2");
  return +x;
}
function cleanOfficial(b) {
  if (b == null) return null;
  const out = {};
  for (const s of K.SPECIES) if (b[s] != null && b[s] !== "") out[s] = int(b[s], 200000, SPECIES_RU[s]);
  if (!Object.keys(out).length) return null;
  out.source = text(b.source, 80, "источник"); out.at = new Date().toISOString();
  return out;
}
function cleanDeadline(x, now) {
  if (x == null || x === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x) || Number.isNaN(Date.parse(x))) throw bad("срок: дата ГГГГ-ММ-ДД");
  if (Date.parse(x + "T23:59:59+05:00") < now) throw bad("срок уже прошёл");
  return x;
}
const expired = (k, now) => !!k.deadline && Date.parse(k.deadline + "T23:59:59+05:00") < now;

function cleanProposal(b, k) {
  if (!b || !K.TYPES.includes(b.type)) throw bad("неизвестное предложение");
  const p = { type: b.type };
  const ids = k.snapshot.plots.map(x => x.id);
  const plot = (x, what) => { if (!ids.includes(x)) throw bad(what + ": неизвестный участок"); return x; };
  if (["avoid", "prefer", "swap"].includes(b.type)) p.plot = plot(b.plot, "участок");
  if (b.type === "swap") p.to = plot(b.to, "новый участок");
  if (b.type === "herd") {
    p.herd = herd(b.herd);
    if (b.home != null) { plot(b.home, "домашний участок"); if (!isNear(b.home)) throw bad("домашний участок — только ближний"); p.home = b.home; }
    if (b.daily_return != null) p.daily_return = !!b.daily_return;
  }
  if (b.reason != null && b.reason !== "") { if (!K.REASONS.includes(b.reason)) throw bad("неизвестная причина"); p.reason = b.reason; }
  if (["avoid", "swap"].includes(b.type) && !p.reason) throw bad("укажите причину");
  if (b.observed_on != null && b.observed_on !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.observed_on) || Number.isNaN(Date.parse(b.observed_on))) throw bad("дата наблюдения: ГГГГ-ММ-ДД");
    p.observed_on = b.observed_on;
  }
  const t = text(b.text, MAX.text, "пояснение");
  if (t) p.text = t;
  if (b.type === "other" && !t) throw bad("опишите, что не подходит");
  return p;
}

// ---------- состояние ----------
function log(k, by, act, data, now) {
  k.log.push(Object.assign({ at: new Date(now).toISOString(), by, act }, data ? { data } : {}));
  if (k.log.length > MAX.log) k.log.splice(0, k.log.length - MAX.log);
}
const find = (k, hid) => { const h = k.households.find(x => x.id === hid && !x.removed); if (!h) throw err(404, "двор не найден"); return h; };
const openProposal = (k, hid) => k.proposals.find(p => p.household === hid && p.status === "open");

/** Новая версия плана. why — что её вызвало. Ответы «согласен» у незадетых дворов переносятся. */
function newVersion(k, plan, why, now) {
  const before = k.plan, n = k.version + 1;
  const again = before ? new Set(K.mustReconfirm(before, plan)) : new Set(K.active(k).map(h => h.id));
  for (const h of K.active(k)) {
    if (!h.answer || h.answer.version !== k.version) continue;
    if (h.answer.value === "agree" && !again.has(h.id)) h.answer = Object.assign({}, h.answer, { version: n, carried: true });
    else if (h.answer.value === "object" && openProposal(k, h.id)) h.answer = Object.assign({}, h.answer, { version: n });   // возражение ещё не рассмотрено — остаётся в силе
  }
  k.version = n; k.plan = plan;
  k.versions.push({ n, at: new Date(now).toISOString(), why, share: plan.share, deficit_t: plan.deficit_t, status: plan.status, changed: before ? [...again] : [] });
  if (k.versions.length > MAX.versions) k.versions.splice(0, k.versions.length - MAX.versions);
}
/** Пересчёт после правки организатора: устойчивый, с прежними участками. */
function resolveAgain(k, why, free, now) {
  newVersion(k, K.solve(k, k.plan ? { keep: k.plan.alloc, free: free || [] } : {}), why, now);
}

// ---------- виды ----------
const slimEffect = e => e && { verdict: e.verdict, error: e.error, variants: Object.fromEntries(Object.entries(e.variants || {}).map(([n, v]) => [n, {
  own: v.own, losers: v.losers.map(x => ({ id: x.id, name: x.name, delta: x.delta, share0: x.share0, share1: x.share1, days0: x.days0, days1: x.days1 })),
  gainers: v.gainers.map(x => ({ id: x.id, name: x.name, delta: x.delta })), affected: v.affected, farther: v.farther.map(x => ({ id: x.id, name: x.name, km0: x.km0, km1: x.km1 })), others_loss_t: v.others_loss_t, deficit0_t: v.deficit0_t, deficit1_t: v.deficit1_t }])) };
const pubProposal = (p, full) => Object.assign({ id: p.id, household: p.household, type: p.type, plot: p.plot, to: p.to, herd: p.herd, home: p.home, daily_return: p.daily_return, reason: p.reason, observed_on: p.observed_on,
  status: p.status, variant: p.variant, version: p.version, at: p.at, decided_at: p.decided_at, effect: p.effect }, full ? { text: p.text, note: p.note } : {});
function pubHousehold(k, h, org) {
  return Object.assign({ id: h.id, name: h.name, herd: h.herd, herd_status: h.herd_status, home: h.home, daily_return: h.daily_return, weight: h.weight, allowed: h.allowed, avoid: h.avoid, prefer: h.prefer, prefer_soft: h.prefer_soft,
    joined: !!h.joined, answer: K.answerState(k, h), carried: !!(h.answer && h.answer.version === k.version && h.answer.carried), herd_log: h.herd_log }, org ? { link_issued: h.link_issued } : {});
}
/** Что видит двор или организатор. Поголовье, доли и ответы видны всем участникам; свободный текст возражений — автору и организатору. */
function view(k, who, now) {
  const org = who.role === "org", mine = p => org || p.household === who.id;
  return {
    id: k.id, role: who.role, me: org ? null : who.id, title: k.title, village: k.village, status: k.status, rev: k.rev, version: k.version, rule: k.rule, deadline: k.deadline, expired: expired(k, now),
    created: k.created, closed: k.closed || null, restored: k.restored || null,
    households: K.active(k).map(h => pubHousehold(k, h, org)), plan: k.plan, versions: k.versions, proposals: k.proposals.map(p => pubProposal(p, mine(p))),
    snapshot: k.snapshot, official: k.official, herds: K.herdCheck(k), log: org ? k.log.slice(-100) : undefined,
    why: !org && k.plan ? K.why(k, who.id) : undefined,
  };
}

/**
 * @param kv         { get, set(k, v, ttlSec), del } — хранилище записей
 * @param known      (lat, lon) → данные села, посчитанные сервером, или null — для сверки снимка
 * @param secret     строка для подписи выгрузки
 */
function createKelisim({ kv, known, secret, now = () => Date.now() }) {
  const locks = new Map();
  /** Записи одного согласования — строго по очереди (сервер один, хранилище без транзакций). */
  function locked(id, fn) {
    const prev = locks.get(id) || Promise.resolve();
    const p = prev.catch(() => {}).then(fn);
    locks.set(id, p);
    p.catch(() => {}).then(() => { if (locks.get(id) === p) locks.delete(id); });
    return p;
  }
  const ID_RE = /^[A-Za-z0-9_-]{12,24}$/;
  async function load(id) {
    if (!ID_RE.test(id)) throw err(404, "согласование не найдено");
    const k = await kv.get("kel:" + id);
    if (!k) throw err(404, "согласование не найдено: срок хранения прошёл или ссылка неверна");
    return k;
  }
  const store = k => kv.set("kel:" + k.id, k, TTL);
  /** Чей секрет: организатор, двор или никто. Отозванная ссылка — 403. */
  function who(k, key) {
    const h = sha(key || "");
    if (key && same(h, k.org_hash)) return { role: "org" };
    const hh = key && k.households.find(x => !x.removed && x.key_hash && same(h, x.key_hash));
    if (hh) return { role: "household", id: hh.id };
    throw err(403, "ссылка недействительна: попросите организатора прислать новую");
  }
  const onlyOrg = w => { if (w.role !== "org") throw err(403, "это может только организатор"); };
  const onlyHh = w => { if (w.role !== "household") throw err(403, "это может только двор по своей ссылке"); };
  const notClosed = k => { if (k.status === "closed") throw err(409, "согласование закрыто"); };
  const checkRev = (k, rev) => { if (rev !== k.rev) throw err(409, "данные изменились, обновите страницу", { rev: k.rev }); };
  /** Изменение: блокировка, права, правка копии, rev + 1, запись. fn возвращает добавку к ответу. */
  function change(id, key, fn) {
    return locked(id, async () => {
      const k = await load(id), w = who(k, key), t = now();
      const extra = await fn(k, w, t);
      k.rev++; k.updated = new Date(t).toISOString();
      await store(k);
      return Object.assign({ state: view(k, w, t) }, extra || {});
    });
  }
  const addKey = h => { const key = rnd(18); h.key_hash = sha(key); h.link_issued = new Date(now()).toISOString(); return key; };
  function addTo(k, b) {
    if (K.active(k).length >= MAX.households) throw bad(`дворов не больше ${MAX.households}`);
    const h = Object.assign({ id: "h" + (k.next++) }, cleanHousehold(b, k));
    k.households.push(h);
    return { h, key: addKey(h) };
  }

  return {
    MAX,
    async create(b) {
      const t = now(), day = new Date(t).toISOString().slice(0, 10), cnt = "kelcount:" + day, n = (await kv.get(cnt)) || 0;
      if (n >= MAX.perDay) throw err(429, "сегодня создано слишком много согласований, попробуйте завтра");
      const snapshot = cleanSnapshot(b.snapshot, known);
      const org = rnd(24);
      const k = { schema: 1, id: rnd(12), title: text(b.title, 80, "название") || `Келісім: ${snapshot.village.name}`, village: snapshot.village, created: new Date(t).toISOString(), updated: new Date(t).toISOString(),
        status: "collect", rev: 1, version: 0, next: 1, org_hash: sha(org), rule: rule(b.rule), deadline: cleanDeadline(b.deadline, t), snapshot, official: cleanOfficial(b.official),
        households: [], proposals: [], versions: [], plan: null, log: [] };
      if (b.households != null && !Array.isArray(b.households)) throw bad("дворы: нужен список");
      const links = (b.households || []).map(x => { const { h, key } = addTo(k, x); return { id: h.id, name: h.name, key }; });
      log(k, "org", "create", { households: links.length }, t);
      await store(k);
      await kv.set(cnt, n + 1, 2 * 24 * 3600);
      return { id: k.id, organizer_key: org, links, state: view(k, { role: "org" }, t) };
    },
    async get(id, key) { const k = await load(id); return view(k, who(k, key), now()); },

    // ---------- организатор ----------
    addHousehold: (id, key, b) => change(id, key, (k, w, t) => {
      onlyOrg(w); notClosed(k);
      const { h, key: hk } = addTo(k, b || {});
      log(k, "org", "add", { household: h.id, name: h.name }, t);
      if (k.version) resolveAgain(k, { type: "add", household: h.id }, [h.id], t);
      return { link: { id: h.id, name: h.name, key: hk } };
    }),
    reissue: (id, key, hid) => change(id, key, (k, w, t) => {
      onlyOrg(w);
      const h = find(k, hid), hk = addKey(h);
      log(k, "org", "reissue", { household: hid }, t);
      return { link: { id: h.id, name: h.name, key: hk } };
    }),
    editHousehold: (id, key, hid, b) => change(id, key, (k, w, t) => {
      onlyOrg(w); notClosed(k); checkRev(k, b.rev);
      const h = find(k, hid); let solve = false;
      if (b.remove) {
        h.removed = true; h.key_hash = null;
        for (const p of k.proposals) if (p.household === hid && p.status === "open") p.status = "withdrawn";
        log(k, "org", "remove", { household: hid, name: h.name }, t); solve = true;
      } else {
        if (b.name != null) { const name = text(b.name, 60, "имя двора"); if (!name) throw bad("имя двора пустое"); if (K.active(k).some(x => x.id !== hid && x.name.toLowerCase() === name.toLowerCase())) throw err(409, "двор с таким именем уже есть"); h.name = name; }
        if (b.herd != null) { const next = herd(b.herd); herdLog(h, next, "org", t); h.herd = next; h.herd_status = b.confirm ? "confirmed" : "entered"; log(k, "org", "herd", { household: hid, to: next }, t); solve = true; }
        else if (b.confirm != null) { if (h.herd_status === "none") throw bad("поголовье ещё не внесено"); h.herd_status = b.confirm ? "confirmed" : "declared"; log(k, "org", b.confirm ? "confirm" : "unconfirm", { household: hid }, t); }
        if (b.weight != null && weight(b.weight) !== h.weight) { log(k, "org", "weight", { household: hid, from: h.weight, to: weight(b.weight) }, t); h.weight = weight(b.weight); solve = true; }
        if (b.daily_return != null && !!b.daily_return !== h.daily_return) { h.daily_return = !!b.daily_return; solve = true; }
        if (b.home != null) { if (!PLOT_RE.test(b.home) || !isNear(b.home)) throw bad("домашний участок — только ближний"); h.home = b.home; solve = true; }
        if (b.allowed != null) { h.allowed = plotList(b.allowed, "участки двора"); log(k, "org", "allowed", { household: hid, to: h.allowed }, t); solve = true; }
      }
      if (solve && k.version) resolveAgain(k, { type: b.remove ? "remove" : "edit", household: hid }, [hid], t);
    }),
    setRule: (id, key, b) => change(id, key, (k, w, t) => {
      onlyOrg(w); notClosed(k); checkRev(k, b.rev);
      const next = rule(b.rule);
      if (next === k.rule) throw bad("это правило уже действует");
      log(k, "org", "rule", { from: k.rule, to: next }, t); k.rule = next;
      if (k.version) resolveAgain(k, { type: "rule", rule: next }, [], t);
    }),
    setSettings: (id, key, b) => change(id, key, (k, w, t) => {
      onlyOrg(w); notClosed(k); checkRev(k, b.rev);
      if (b.deadline !== undefined) { k.deadline = cleanDeadline(b.deadline, t); log(k, "org", "deadline", { to: k.deadline }, t); }
      if (b.official !== undefined) { k.official = cleanOfficial(b.official); log(k, "org", "official", null, t); }
      if (b.title != null) k.title = text(b.title, 80, "название") || k.title;
    }),
    start: (id, key, b) => change(id, key, (k, w, t) => {
      onlyOrg(w); checkRev(k, b.rev);
      if (k.status !== "collect") throw err(409, "согласование уже начато");
      const list = K.active(k), empty = list.filter(h => K.SPECIES.every(s => !h.herd[s]));
      if (list.length < 2) throw bad("нужно хотя бы два двора");
      if (empty.length === list.length) throw bad("ни один двор не внёс поголовье");
      k.status = "review";
      log(k, "org", "start", { without_herd: empty.map(h => h.id) }, t);
      newVersion(k, K.solve(k), { type: "start" }, t);
    }),
    /** Решение по предложению: accept (вариант equal или protect) или decline. Последствия считаются заново по текущему плану. */
    decide: (id, key, b) => change(id, key, (k, w, t) => {
      onlyOrg(w); notClosed(k); checkRev(k, b.rev);
      const p = k.proposals.find(x => x.id === b.proposal);
      if (!p) throw err(404, "предложение не найдено");
      if (p.status !== "open") throw err(409, "предложение уже рассмотрено");
      const h = find(k, p.household);
      p.note = text(b.note, MAX.text, "пояснение") || undefined;
      p.decided_at = new Date(t).toISOString();
      if (b.action === "decline") { p.status = "declined"; log(k, "org", "decline", { proposal: p.id, household: h.id }, t); return; }
      if (b.action !== "accept") throw bad("решение: accept или decline");
      const e = K.effect(k, h.id, p);
      // план с момента возражения изменился — сначала показываем свежие последствия, решать по старым числам нельзя
      if (p.version !== k.version) { p.version = k.version; p.effect = slimEffect(e); p.decided_at = undefined; p.note = undefined; log(k, "org", "refresh", { proposal: p.id }, t); return { stale: true, effect: p.effect }; }
      if (["impossible", "error"].includes(e.verdict)) throw err(409, e.verdict === "impossible" ? "двору не останется участка, где можно пасти" : "предложение больше не применимо", { effect: e.verdict });
      if (e.verdict === "not_calculated") throw err(409, "словесное возражение нельзя принять расчётом: измените план или отклоните с пояснением");
      // другие теряют корм или им станет дальше — организатор выбирает вариант явно, а не по умолчанию
      if (K.needsChoice(e) && !b.variant) throw err(409, "это изменение задевает другие дворы: выберите вариант", { effect: slimEffect(e) });
      const variant = b.variant || "equal";
      if (!e.variants[variant]) throw bad("неизвестный вариант");
      const a = K.applyProposal(k, h, p, variant === "room").household;
      if (p.type === "herd") { herdLog(h, a.herd, h.id, t); }
      Object.assign(h, { avoid: a.avoid, prefer: a.prefer, prefer_soft: a.prefer_soft, herd: a.herd, herd_status: a.herd_status, home: a.home, daily_return: a.daily_return });
      p.status = "accepted"; p.variant = variant; p.effect = slimEffect(e);
      h.answer = null;                                     // план двора изменился по его просьбе — пусть подтвердит
      log(k, "org", "accept", { proposal: p.id, household: h.id, variant, verdict: e.verdict }, t);
      newVersion(k, e.variants[variant].plan, { type: "proposal", household: h.id, proposal: p.id, variant }, t);
    }),
    close: (id, key, b) => change(id, key, (k, w, t) => {
      onlyOrg(w); checkRev(k, b.rev);
      if (k.status !== "review") throw err(409, k.status === "closed" ? "согласование уже закрыто" : "сначала начните согласование");
      k.status = "closed"; k.closed = new Date(t).toISOString();
      log(k, "org", "close", K.protocol(k).counts, t);
      return { protocol: K.protocol(k) };
    }),
    async remove(id, key) { return locked(id, async () => { const k = await load(id); onlyOrg(who(k, key)); await kv.del("kel:" + id); return { ok: true }; }); },

    // ---------- двор ----------
    /** Двор вносит себя: имя, скот, домашний участок. До начала — свободно; после начала скот меняется только предложением. */
    join: (id, key, b) => change(id, key, (k, w, t) => {
      onlyHh(w); notClosed(k);
      if (expired(k, t)) throw err(409, "срок ответа прошёл");
      if (k.status !== "collect") throw err(409, "план уже рассчитан: изменение скота отправьте как предложение");
      const h = find(k, w.id);
      if (b.name != null) { const name = text(b.name, 60, "имя двора"); if (!name) throw bad("имя двора пустое"); if (K.active(k).some(x => x.id !== h.id && x.name.toLowerCase() === name.toLowerCase())) throw err(409, "двор с таким именем уже есть"); h.name = name; }
      if (b.herd != null) { const next = herd(b.herd); herdLog(h, next, h.id, t); h.herd = next; h.herd_status = "declared"; }
      if (b.home != null) { if (!PLOT_RE.test(b.home) || !isNear(b.home)) throw bad("домашний участок — только ближний"); h.home = b.home; }
      if (b.daily_return != null) h.daily_return = !!b.daily_return;
      h.joined = h.joined || new Date(t).toISOString();
      log(k, h.id, "join", { herd: h.herd }, t);
    }),
    /** Последствия предложения без записи — можно спрашивать до отправки. */
    async preview(id, key, b) {
      const k = await load(id), w = who(k, key);
      if (!k.version) throw err(409, "план ещё не рассчитан");
      const hid = w.role === "household" ? w.id : find(k, b.household).id;
      return { version: k.version, effect: slimEffect(K.effect(k, hid, cleanProposal(b.proposal, k))) };
    },
    /** Ответ на план версии N: согласен или возражение с предложением. Новое возражение заменяет прежнее открытое. */
    answer: (id, key, b) => change(id, key, (k, w, t) => {
      onlyHh(w); notClosed(k);
      if (expired(k, t)) throw err(409, "срок ответа прошёл");
      if (!k.version) throw err(409, "план ещё не рассчитан");
      if (b.version !== k.version) throw err(409, "план изменился, посмотрите новый", { version: k.version });
      const h = find(k, w.id), at = new Date(t).toISOString();
      if (b.value !== "agree" && b.value !== "object") throw bad("ответ: agree или object");
      // «согласен» снимает своё нерассмотренное возражение; новое возражение заменяет прежнее
      const prev = openProposal(k, h.id);
      const fresh = b.value === "object" ? cleanProposal(b.proposal, k) : null;
      if (fresh && k.proposals.length >= MAX.proposals) throw err(429, "слишком много возражений в этом согласовании");
      if (prev) prev.status = "withdrawn";
      h.joined = h.joined || at;
      if (!fresh) { h.answer = { value: "agree", version: k.version, at }; log(k, h.id, "agree", { version: k.version }, t); return; }
      const e = slimEffect(K.effect(k, h.id, fresh));
      if (e.verdict === "error") throw bad("предложение неприменимо: " + e.error);
      const p = Object.assign({ id: "p" + (k.proposals.length + 1), household: h.id, status: "open", version: k.version, at, effect: e }, fresh);
      k.proposals.push(p);
      h.answer = { value: "object", version: k.version, at, proposal: p.id };
      log(k, h.id, "object", { version: k.version, proposal: p.id, type: p.type, plot: p.plot, reason: p.reason }, t);
      return { proposal: pubProposal(p, true) };
    }),

    // ---------- протокол, выгрузка ----------
    async protocol(id, key) { const k = await load(id); who(k, key); return K.protocol(k); },
    async export(id, key) {
      const k = await load(id); onlyOrg(who(k, key));
      const data = JSON.stringify(k);
      return { format: "jaiylym-kelisim", data, sign: sign(data) };
    },
    /** Восстановить из файла, если записи на сервере нет. Ключ организатора должен подойти к файлу; чужая подпись — пометка в протоколе. */
    async restore(b, key) {
      if (!b || b.format !== "jaiylym-kelisim" || typeof b.data !== "string" || b.data.length > 1e6) throw bad("это не файл согласования");
      let k; try { k = JSON.parse(b.data); } catch (_) { throw bad("файл повреждён"); }
      if (!k || k.schema !== 1 || !ID_RE.test(k.id) || !Array.isArray(k.households) || !Array.isArray(k.proposals) || !k.snapshot) throw bad("файл повреждён");
      if (!key || !same(sha(key), k.org_hash)) throw err(403, "файл открывает только его организатор");
      return locked(k.id, async () => {
        if (await kv.get("kel:" + k.id)) throw err(409, "это согласование есть на сервере, восстанавливать нечего");
        const ok = typeof b.sign === "string" && same(sign(b.data), b.sign), t = now();
        if (!ok) k = rebuild(k, t);
        k.restored = { at: new Date(t).toISOString(), verified: ok };
        k.rev++; log(k, "org", "restore", { verified: ok }, t);
        await store(k);
        return { id: k.id, verified: ok, state: view(k, { role: "org" }, t) };
      });
    },
    _locked: locked,
  };
  /**
   * Подпись файла не наша (его правили или сервер сменил ключ): берём только проверенные поля, план считаем заново,
   * а ответы и возражения сбрасываем — чужое согласие из файла не принимается. Личные ссылки продолжают работать.
   */
  function rebuild(f, t) {
    const n = f.snapshot.norm, snapshot = cleanSnapshot(Object.assign({}, f.snapshot, { norm: n ? { region: n.region, row: n.soft ? undefined : n.row, state: n.state } : undefined }), known);
    const k = { schema: 1, id: f.id, title: text(f.title, 80, "название") || "Келісім", village: snapshot.village, created: Number.isNaN(Date.parse(f.created)) ? new Date(t).toISOString() : f.created, updated: new Date(t).toISOString(),
      status: "collect", rev: 1, version: 0, next: 1, org_hash: f.org_hash, rule: K.RULES.includes(f.rule) ? f.rule : "share", deadline: null, snapshot, official: null,
      households: [], proposals: [], versions: [], plan: null, log: [] };
    for (const h of f.households.filter(x => x && !x.removed).slice(0, MAX.households)) {
      const c = cleanHousehold(Object.assign({}, h, { allowed: h.allowed || [] }), k);
      k.households.push(Object.assign({ id: "h" + (k.next++) }, c, { avoid: plotList(h.avoid, "участки"), prefer: plotList(h.prefer, "участки"), prefer_soft: plotList(h.prefer_soft, "участки"), herd_status: "declared",
        key_hash: /^[0-9a-f]{64}$/.test(h.key_hash || "") ? h.key_hash : null }));
    }
    if (f.version && K.active(k).length >= 2) { k.status = "review"; newVersion(k, K.solve(k), { type: "restore" }, t); }
    return k;
  }
  function sign(data) { return crypto.createHmac("sha256", String(secret || "local")).update("kelisim:" + data).digest("hex"); }
  function rule(x) { if (x == null || x === "") return "share"; if (!K.RULES.includes(x)) throw bad("правило: share или household"); return x; }
  function herdLog(h, next, by, t) {
    if (K.SPECIES.every(s => (h.herd[s] || 0) === next[s])) return;
    h.herd_log.push({ at: new Date(t).toISOString(), by, from: h.herd, to: next, was: h.herd_status });
    if (h.herd_log.length > 20) h.herd_log.shift();
  }
}

// ---------- HTTP ----------
/**
 * Маршруты /api/kelisim…  ctx: { json, body, limited } из api.js. Секрет — в заголовке Authorization: Kelisim <секрет>.
 * Возвращает true, если запрос обработан.
 */
function createRoutes(kel, { json, body, limited }) {
  return async function route(req, res, p) {
    const key = (/^Kelisim\s+([A-Za-z0-9_-]{16,64})$/.exec(req.headers.authorization || "") || [])[1] || "";
    const m = /^\/api\/kelisim(?:\/([A-Za-z0-9_-]{6,24}))?(?:\/([a-z]+))?(?:\/([A-Za-z0-9]{1,8}))?(?:\/([a-z]+))?$/.exec(p);
    if (!m) return json(res, 404, { error: "нет такого адреса" }), true;
    const [, id, act, sub, sub2] = m, POST = req.method === "POST";
    try {
      // подбор чужих ссылок и перегрузка расчётом: общий предел и отдельный на тяжёлые действия
      if (limited(req, "kel", 120, 60e3)) throw err(429, "слишком много запросов, подождите минуту");
      const heavy = POST && (["preview", "answer", "decide", "start", "rule"].includes(act) || act === "households");
      if (heavy && limited(req, "kelcalc", 60, 60e3)) throw err(429, "слишком много пересчётов, подождите минуту");
      if (!id && POST) { if (limited(req, "kelnew", 6, 10 * 60e3)) throw err(429, "слишком много новых согласований, подождите 10 минут"); return json(res, 200, await kel.create(await body(req))), true; }
      if (id === "restore" && POST && !act) { if (limited(req, "kelnew", 6, 10 * 60e3)) throw err(429, "подождите 10 минут"); return json(res, 200, await kel.restore(await body(req, 1.5e6), key)), true; }
      if (id && !act && req.method === "GET") return json(res, 200, await kel.get(id, key)), true;
      if (id && !act && req.method === "DELETE") return json(res, 200, await kel.remove(id, key)), true;
      if (id && act === "protocol" && req.method === "GET") return json(res, 200, await kel.protocol(id, key)), true;
      if (id && act === "export" && req.method === "GET") return json(res, 200, await kel.export(id, key)), true;
      if (id && POST) {
        const b = await body(req);
        if (act === "households" && !sub) return json(res, 200, await kel.addHousehold(id, key, b)), true;
        if (act === "households" && sub && sub2 === "link") return json(res, 200, await kel.reissue(id, key, sub)), true;
        if (act === "households" && sub && !sub2) return json(res, 200, await kel.editHousehold(id, key, sub, b)), true;
        const f = { me: kel.join, answer: kel.answer, preview: kel.preview, start: kel.start, decide: kel.decide, rule: kel.setRule, settings: kel.setSettings, close: kel.close }[act];
        if (f && !sub) return json(res, 200, await f(id, key, b)), true;
      }
      return json(res, 404, { error: "нет такого адреса" }), true;
    } catch (e) {
      if (!e.code || typeof e.code !== "number") { console.error("kelisim", e); return json(res, 500, { error: "внутренняя ошибка" }), true; }
      return json(res, e.code, Object.assign({ error: e.message }, e.extra || {})), true;
    }
  };
}

module.exports = { createKelisim, createRoutes, cleanSnapshot, checkSnapshot, text, MAX };
