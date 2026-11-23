/*
 * Jaiylym — серверное API для сайта: вход через Telegram, роли, профиль хозяйства,
 * сценарии, история расчётов, раздел координатора (акимата).
 *
 * Вход без паролей:
 *   1. Сайт: POST /auth/start → { nonce, code, link }. Код (4 цифры) показывается на сайте.
 *   2. Человек открывает link (t.me/<бот>?start=login_<nonce>), бот показывает тот же код
 *      и кнопку «Подтвердить вход». Telegram сам удостоверяет, кто нажал (webhook защищён секретом).
 *   3. Сайт опрашивает GET /auth/poll?nonce=… и получает токен сессии (30 дней).
 *      На сервере хранится только хэш токена. Пароли нигде не хранятся.
 *
 * Роли проверяются на сервере при каждом запросе:
 *   farmer      — любой вошедший: свой профиль, свои сценарии и история;
 *   coordinator — Telegram ID указан в переменной окружения COORDINATOR_IDS (через запятую):
 *                 видит хозяйства своих сёл, публикует общий план села.
 */
const crypto = require("crypto");
const PL = require("./web/pipeline.js");
const M = require("./web/model.js");
const G = require("./gemini.js");
const F = require("./ai-facts.js");
const X = require("./ai-context.js");
const AI_CTX_MAX = +process.env.AI_CONTEXT_CHARS || 24000;   // ~7–8 тыс. токенов данных села
// поиск Google: 150 запросов в день ≈ 4 500 в месяц — в пределах бесплатных 5 000 у Gemini 3+
const AI_SEARCH_DAILY = process.env.AI_SEARCH_DAILY != null ? +process.env.AI_SEARCH_DAILY : 150;
const searchDay = { day: "", n: 0 };
const SEARCH_RULE = {
  ru: "Поиск Google: ищи, только если для ответа нужны свежие внешние сведения, которых нет в ДАННЫХ, — погода и прогноз, цены на сено и скот, " +
    "ветеринарные и правовые нормы Казахстана, новости района. Цифры села (участки, поголовье, ёмкость, нагрузка) бери только из ДАННЫХ, не из поиска. " +
    "Для посторонних задач не ищи. Предпочитай официальные и казахстанские источники; найденное в интернете прямо называй найденным в интернете.",
  kk: "Google іздеуі: жауапқа ДЕРЕКТЕРДЕ жоқ жаңа сыртқы мәлімет керек болса ғана ізде — ауа райы мен болжам, шөп пен мал бағасы, " +
    "Қазақстанның ветеринарлық және құқықтық нормалары, аудан жаңалықтары. Ауыл сандарын (учаскелер, мал саны, сыйымдылық, жүктеме) тек ДЕРЕКТЕРДЕН ал. " +
    "Бөгде тапсырмалар үшін іздеме. Ресми және қазақстандық дереккөздерді таңда; интернеттен табылғанды солай ата.",
};

// ---------- ИИ: инструкции модели ----------
const AI_DAILY = +process.env.AI_DAILY_LIMIT || 1500;
const aiDay = { day: "", n: 0 };
const AI_RULES = "Используй только данные из блока ДАННЫЕ и общие знания о выпасе. Различай: спутниковые измерения (NDVI Sentinel-2, площади), " +
  "ввод пользователя (поголовье, водопои) и модельные оценки (ёмкость, нагрузка, тонны сена, стоимость) — оценки называй оценками. " +
  "Не выдумывай чисел, которых нет в данных. Не обещай доходов и экономии. 1 условная голова = 1 корова или лошадь = 5 овец или коз. " +
  "Пиши простым языком для фермера без терминов; если термин нужен — поясни в скобках. Без таблиц, без markdown (без звёздочек и решёток); можно короткие списки через «—». " +
  "Числа пиши только цифрами, точно как в данных (например 15 384), никогда не словами; готовые итоги в поле «итог» уже посчитаны — не пересчитывай их. " +
  "Не путай единицы: поля «…_овец» — это число овец, поля «…усл_голов» — условные головы. Водопой открывает доступ к корму, а не «даёт воду овцам». " +
  "Числа (ёмкость, число овец, дефицит, нагрузка) бери ТОЛЬКО из данных: сам их не считай и не придумывай. Если нужного числа нет — прямо скажи, что его нет в расчёте. " +
  "Чтобы объяснить, откуда число, используй поле «как_рассчитано» (шаги формулы) — перескажи шаги с их числами. " +
  "Право пользования участком в данных — только ввод пользователя, его НЕ проверяли по госреестру; никогда не утверждай, что право подтверждено. " +
  "Вода «по карте WorldCover» — это водоём на снимке, а не проверенный водопой. Ёмкость не подтверждена полевыми измерениями. " +
  "Блок «прошлый_год» — те же участки и то же окно июнь–август прошлого лета; изменения уже посчитаны, бери их оттуда. " +
  "Изменение NDVI меньше порога — «без изменений», а не тренд; NDVI — зелёность травы, а не урожай; один год к другому — не многолетний тренд. " +
  "Если сравнение_надёжно = false — скажи об этом. «Устойчивая вода по снимкам» — вода, видимая большую часть лета, а не проверенный водопой. " +
  "Если в блоке ПРОБЛЕМЫ_ДАННЫХ что-то указано — начни ответ с этого. Ты не агроном и не госорган: твой ответ — пояснение расчёта, а не заключение. " +
  G.SCOPE;
const AI_SYSTEM = {
  ru: "Ты — ИИ-помощник сервиса Jaiylym по пастбищам сёл Казахстана. Отвечай по-русски. " + AI_RULES,
  kk: "Сен — Қазақстан ауылдарының жайылымдары бойынша Jaiylym сервисінің ЖИ-көмекшісісің. Жауапты ТЕК қазақ тілінде жаз, орысша сөз араластырма. " +
    "Деректердегі орысша сөздерді аудар: овцы — қой, условная голова — шартты бас, участок — учаске, корм — жем, водопой — суат, сено — шөп, " +
    "стадо — табын, пастбище — жайылым, поголовье — мал саны, ёмкость — сыйымдылық, нагрузка — жүктеме, да/нет — иә/жоқ. Сандарды тек цифрмен жаз (15 384), сөзбен жазба; учаске атауларын (Д-З, Б-С) өзгертпе. " +
    "«…_овец» өрістері — қой саны, «…усл_голов» — шартты бас, оларды шатастырма. " + AI_RULES,
};
const AI_SUMMARY = {
  ru: "Сделай понятную сводку для фермера (до 170 слов): 1) Главное — одной фразой. 2) Что происходит — 2–3 пункта с цифрами из данных. " +
    "3) Что сделать — 3 конкретных шага. 4) Насколько можно доверять — одна фраза. Если какому-то стаду не хватает корма, объясни почему простыми словами.",
  kk: "Фермерге түсінікті қорытынды жаса (130 сөзге дейін): 1) Ең бастысы — бір сөйлеммен. 2) Не болып жатыр — деректердегі сандармен 2–3 тармақ. " +
    "3) Не істеу керек — 3 нақты қадам. 4) Қаншалықты сенуге болады — бір сөйлем. Қай табынға жем жетпесе, себебін қарапайым сөзбен түсіндір.",
};
const AI_CHAT = {
  ru: "Ответь на последний вопрос пользователя коротко и по делу (до 150 слов). Если в данных нет ответа — так и скажи и подскажи, где его взять.",
  kk: "Пайдаланушының соңғы сұрағына қысқа әрі нақты жауап бер (150 сөзге дейін). Деректерде жауап болмаса — соны айт және қайдан табуға болатынын көрсет.",
};

const SESSION_TTL = 30 * 24 * 3600;
const LOGIN_TTL = 600;
const MAX_BODY = 256 * 1024;
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const rnd = n => crypto.randomBytes(n).toString("base64url");

const num = (x, max = 1e6) => { const v = Math.round(+x); return Number.isFinite(v) ? Math.min(Math.max(v, 0), max) : 0; };
const bad = msg => Object.assign(new Error(msg), { code: 400 });
/** Поголовье: пусто → 0; отрицательное, дробное, нечисловое или больше лимита — ошибка 400 (а не тихое обнуление). */
function count(x, name, max = 1e6) {
  if (x == null || x === "") return 0;
  const v = +x;
  if (!Number.isFinite(v)) throw bad(`${name}: не число`);
  if (v < 0) throw bad(`${name}: поголовье не может быть отрицательным`);
  if (Math.round(v) !== v) throw bad(`${name}: нужно целое число`);
  if (v > max) throw bad(`${name}: больше ${max}`);
  return v;
}
const SPECIES_RU = { sheep: "овцы", goats: "козы", cattle: "КРС", horses: "лошади" };
const MAX_HERDS = 60;

/**
 * Проверка данных села, которые сайт передаёт ИИ: чего не хватает и что противоречит друг другу.
 * Возвращает список строк; ИИ обязан сначала сказать о них.
 */
function aiContextIssues(ctx) {
  const out = [];
  if (!ctx || typeof ctx !== "object" || !ctx["село"]) { out.push("Село не открыто: данных участков и стад нет."); return out; }
  const plots = Array.isArray(ctx["участки"]) ? ctx["участки"] : [];
  const herds = Array.isArray(ctx["стада"]) ? ctx["стада"] : [];
  if (!plots.length) out.push("Нет данных участков.");
  if (!herds.length) out.push("Стада не введены: план и дефицит не считались.");
  const noNdvi = plots.filter(p => p && (p.ndvi_спутник == null)).map(p => p.id);
  if (noNdvi.length) out.push("Нет NDVI (ёмкость неизвестна) для участков: " + noNdvi.slice(0, 16).join(", ") + ".");
  const it = ctx["итог"] || {};
  const st = ctx["статус_плана"];
  const def = it["дефицит_сена_т_по_плану_оценка"];
  if (st === "feasible" && def > 0) out.push("Противоречие: статус «распределение возможно», но указан дефицит " + def + " т.");
  if ((st === "partially_feasible" || st === "infeasible") && def === 0) out.push("Противоречие: план неполный, но дефицит указан как 0.");
  for (const p of plots) if (p && p.нагрузка_по_плану_проц > 100) { out.push("Противоречие: план превышает 100 % на участке " + p.id + "."); break; }
  for (const h of herds) if (h && [h.овцы, h.козы, h.крс, h.лошади].some(v => v != null && (!Number.isFinite(+v) || +v < 0))) { out.push("Неверное поголовье у стада «" + h.имя + "»."); break; }
  if (ctx["демо_стада"]) out.push("В расчёте есть условные демо-стада — это пример, а не реальные хозяйства.");
  return out;
}
const str = (x, max = 80) => String(x == null ? "" : x).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
const coordOk = (lat, lon) => Number.isFinite(+lat) && Number.isFinite(+lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
const PLOT_RE = /^[БД]-(С|СВ|В|ЮВ|Ю|ЮЗ|З|СЗ)$/;

function createApi({ getState, save, kv, vkey, botUsername, onFarmSaved, allowedOrigins }) {
  // состояние берём при каждом обращении: бот может заменить объект целиком при загрузке
  const st = () => { const s = getState(); s.users = s.users || {}; s.villagePlans = s.villagePlans || {}; return s; };
  const origins = new Set(allowedOrigins || []);
  const hits = new Map();   // простое ограничение частоты запросов по IP

  const coordinatorIds = () => new Set(String(process.env.COORDINATOR_IDS || "").split(",").map(s => s.trim()).filter(Boolean));
  const roleOf = u => (u && coordinatorIds().has(String(u.uid)) ? "coordinator" : "farmer");

  // ---------- HTTP-помощники ----------
  function cors(req, res) {
    const o = req.headers.origin;
    if (o && origins.has(o)) {
      res.setHeader("Access-Control-Allow-Origin", o);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
    }
  }
  function json(res, code, obj) {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(obj));
  }
  function body(req) {
    return new Promise((resolve, reject) => {
      let b = "";
      req.on("data", c => { b += c; if (b.length > MAX_BODY) { reject(Object.assign(new Error("слишком большой запрос"), { code: 413 })); req.destroy(); } });
      req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (_) { reject(Object.assign(new Error("неверный JSON"), { code: 400 })); } });
    });
  }
  function limited(req, key, max, perMs) {
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const k = key + ":" + ip, now = Date.now();
    const arr = (hits.get(k) || []).filter(t => now - t < perMs);
    arr.push(now); hits.set(k, arr);
    if (hits.size > 5000) hits.clear();
    return arr.length > max;
  }
  async function auth(req) {
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(req.headers.authorization || "");
    if (!m) return null;
    const uid = await kv.get("sess:" + sha(m[1]));
    const u = uid != null && st().users[uid];
    return u ? { user: u, tokenHash: sha(m[1]) } : null;
  }

  // ---------- представления данных ----------
  const pubUser = u => ({
    uid: u.uid, name: u.name, username: u.username || null, role: roleOf(u), created: u.created,
    farm: u.farm || null, pastures: u.pastures || [], villages: roleOf(u) === "coordinator" ? (u.villages || []) : [],
  });
  const farmVk = u => (u.farm && u.farm.village ? vkey(u.farm.village.lat, u.farm.village.lon) : null);
  const canSeeVillage = (u, vk) => farmVk(u) === vk || (roleOf(u) === "coordinator" && (u.villages || []).some(v => v.vk === vk));

  function cleanFarm(b) {
    const v = b.village || {};
    if (!coordOk(v.lat, v.lon)) throw bad("укажите село");
    if (b.home != null && b.home !== "" && !(PLOT_RE.test(b.home) && b.home.startsWith("Б"))) throw bad("домашний участок — только ближний (Б-…)");
    if (b.plots != null && !Array.isArray(b.plots)) throw bad("участки: нужен список");
    const plots = b.plots || [];
    const badPlots = plots.filter(p => !PLOT_RE.test(p));
    if (badPlots.length) throw bad("неизвестные участки: " + badPlots.map(x => str(x, 10)).join(", "));
    return {
      name: str(b.name, 60) || "Хозяйство",
      village: { name: str(v.name, 80) || "Село", lat: +(+v.lat).toFixed(5), lon: +(+v.lon).toFixed(5) },
      sheep: count(b.sheep, SPECIES_RU.sheep), goats: count(b.goats, SPECIES_RU.goats), cattle: count(b.cattle, SPECIES_RU.cattle), horses: count(b.horses, SPECIES_RU.horses),
      daily_return: !!b.daily_return,
      home: b.home || "Б-С",
      // участки, которыми хозяйство пользуется по своим словам; это НЕ проверка по госреестру
      plots: [...new Set(plots)].slice(0, 16), rights_source: "user_entered",
      updated: new Date().toISOString(),
    };
  }
  /**
   * Своё пастбище: контур проверяется и площадь пересчитывается на сервере.
   * NDVI и состав покрова посчитаны В БРАУЗЕРЕ: сервер их не проверял, поэтому они хранятся с пометкой
   * provenance = "client_reported", verified = false. Подтверждённые сервером значения появляются только
   * после проверки снимка на сервере (ежедневная проверка, observations с source = "server").
   */
  function cleanPasture(b, existing) {
    const g = b.geometry || {};
    let ring = g.type === "Polygon" && Array.isArray(g.coordinates) ? g.coordinates[0] : null;
    if (!Array.isArray(ring) || ring.length < 3 || ring.length > 201) throw Object.assign(new Error("контур: от 3 до 200 точек"), { code: 400 });
    ring = ring.map(p => [+(+p[0]).toFixed(6), +(+p[1]).toFixed(6)]);
    if (!ring.every(([x, y]) => coordOk(y, x))) throw Object.assign(new Error("неверные координаты"), { code: 400 });
    ring = PL.closeRing(ring);
    if (PL.ringSelfIntersects(ring)) throw bad("границы пересекают сами себя");
    const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
    if (Math.max(...xs) - Math.min(...xs) > 0.45 || Math.max(...ys) - Math.min(...ys) > 0.3) throw Object.assign(new Error("участок больше 30 км"), { code: 400 });
    const area = PL.polygonAreaHa(ring);
    if (area < 1) throw Object.assign(new Error("участок меньше 1 га"), { code: 400 });
    const key = JSON.stringify(ring.slice(0, -1).map(p => p.map(v => +v.toFixed(5))).sort());
    if ((existing || []).some(q => q.ring_key === key)) throw Object.assign(new Error("такое пастбище уже сохранено"), { code: 409 });
    const s = b.stats || {};
    const nd = x => (Number.isFinite(+x) && x !== null && Math.abs(+x) <= 1 ? +(+x).toFixed(3) : null);
    const series = (Array.isArray(s.series) ? s.series : []).slice(0, 12)
      .filter(x => x && /^\d{4}-\d{2}-\d{2}$/.test(x.d) && nd(x.v) != null).map(x => ({ d: x.d, v: nd(x.v) }));
    const ha = x => Math.min(Math.round(area * 10) / 10, Math.max(0, +x || 0));
    const frac = x => (Number.isFinite(+x) && x !== null ? Math.min(1, Math.max(0, +x)) : null);
    return {
      id: rnd(8), name: str(b.name, 60) || "Пастбище",
      geometry: { type: "Polygon", coordinates: [ring] }, ring_key: key,
      area_ha: Math.round(area * 10) / 10,
      water: !!b.water,                                        // ввод фермера: есть ли вода
      water_status: b.water ? "confirmed" : (s.water_on_map ? "satellite" : "unknown"),
      stats: {
        ndvi: nd(s.ndvi), series,
        pasture_ha: ha(s.pasture_ha), excluded_ha: ha(s.excluded_ha), uncertain_ha: ha(s.uncertain_ha),
        wc_pasture_share: Math.min(1, Math.max(0, +s.wc_pasture_share || 0)),
        valid_fraction: frac(s.valid_fraction), obs_count: series.length,
        water_on_map: !!s.water_on_map, year: num(s.year, 3000),
        provenance: "client_reported", verified: false,           // посчитано в браузере, сервер не проверял
      },
      created: new Date().toISOString(),
    };
  }
  function plotList(x, name) {
    if (x == null) return [];
    if (!Array.isArray(x)) throw bad(name + ": нужен список участков");
    const badIds = x.filter(p => !PLOT_RE.test(p));
    if (badIds.length) throw bad(name + ": неизвестные участки " + badIds.map(v => str(v, 10)).join(", "));
    return [...new Set(x)].slice(0, 16);
  }
  function cleanScenario(b, u) {
    const v = b.village || {};
    if (!coordOk(v.lat, v.lon)) throw bad("в сценарии нет села");
    if (b.herds != null && !Array.isArray(b.herds)) throw bad("стада: нужен список");
    if ((b.herds || []).length > MAX_HERDS) throw bad(`слишком большой сценарий: больше ${MAX_HERDS} стад`);
    const ids = new Set();
    const herds = (b.herds || []).map((h, i) => {
      if (!h || typeof h !== "object") throw bad("стадо " + (i + 1) + ": неверные данные");
      const id = str(h.id, 40) || "h" + i;
      if (ids.has(id)) throw bad("стадо повторяется: " + id);
      ids.add(id);
      if (h.home != null && h.home !== "" && !PLOT_RE.test(h.home)) throw bad("стадо " + (i + 1) + ": неизвестный участок " + str(h.home, 10));
      return { id, name: str(h.name, 60) || "Стадо", sheep: count(h.sheep, SPECIES_RU.sheep), goats: count(h.goats, SPECIES_RU.goats),
        cattle: count(h.cattle, SPECIES_RU.cattle), horses: count(h.horses, SPECIES_RU.horses), home: h.home || "Б-С", daily_return: !!h.daily_return,
        allowed_plots: plotList(h.allowed_plots, "разрешённые участки"), demo: !!h.demo };
    });
    let params = {};
    if (b.params != null) {
      const r = M.validate(b.params);
      if (!r.ok) throw bad("параметры модели: " + r.errors.map(e => `${e.key} ${e.reason}`).join("; "));
      params = r.values;
    }
    const ws = b.water_status && typeof b.water_status === "object" ? b.water_status : {};
    const water_status = {};
    for (const [id, st] of Object.entries(ws)) {
      if (!PLOT_RE.test(id) || !["confirmed", "absent", "unknown"].includes(st)) throw bad("статус водопоя: " + str(id, 10) + " = " + str(st, 20));
      water_status[id] = st;
    }
    return {
      id: rnd(9), name: str(b.name, 80) || "Сценарий", owner: u.uid, ownerName: u.name,
      village: { name: str(v.name, 80), lat: +(+v.lat).toFixed(5), lon: +(+v.lon).toFixed(5) },
      herds, water: plotList(b.water, "водопои"), forbidden: plotList(b.forbidden, "закрытые участки"), water_status, params,
      model_version: M.MODEL_VERSION,
      request_id: /^[A-Za-z0-9_-]{8,64}$/.test(b.request_id || "") ? b.request_id : null,
      summary: b.summary && typeof b.summary === "object" ? JSON.parse(JSON.stringify(b.summary).slice(0, 2000)) : null,
      created: new Date().toISOString(),
    };
  }

  // ---------- вход: вызывается ботом, когда человек нажал «Подтвердить вход» ----------
  async function loginInfo(nonce) {
    const rec = /^[A-Za-z0-9_-]{20,64}$/.test(nonce || "") && await kv.get("login:" + sha(nonce));
    return rec && rec.status === "pending" ? rec : null;
  }
  async function confirmLogin(nonce, from, ok) {
    const key = "login:" + sha(nonce);
    const rec = await kv.get(key);
    if (!rec || rec.status !== "pending") return false;
    if (!ok) { await kv.set(key, { status: "denied" }, 120); return true; }
    const uid = String(from.id);
    const name = str([from.first_name, from.last_name].filter(Boolean).join(" "), 80) || "Пользователь";
    const u = st().users[uid] = st().users[uid] || { uid, created: new Date().toISOString(), scenarios: [], history: [] };
    u.name = name; u.username = from.username ? str(from.username, 40) : null; u.lastLogin = new Date().toISOString();
    save();
    await kv.set(key, { status: "ok", uid }, 120);
    return true;
  }

  // ---------- маршруты ----------
  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    if (!p.startsWith("/auth/") && !p.startsWith("/api/me") && !p.startsWith("/api/scenarios") &&
        !p.startsWith("/api/history") && !p.startsWith("/api/coord") && p !== "/api/village" && p !== "/api/ai" && p !== "/api/ai/status") return false;
    cors(req, res);
    if ((p === "/api/village" || p === "/api/ai/status") && !res.getHeader("Access-Control-Allow-Origin")) res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return true; }
    try {
      // --- состояние ИИ: есть ли ключ, какие модели доступны, последние ошибки (без ключа) ---
      if (p === "/api/ai/status" && req.method === "GET") {
        if (limited(req, "aistatus", 6, 60e3)) return json(res, 429, { error: "слишком часто" }), true;
        return json(res, 200, await G.status()), true;
      }
      // --- ИИ-помощник (Gemini): сводка по селу и чат. Доступен и гостю, с ограничением частоты ---
      if (p === "/api/ai" && req.method === "POST") {
        if (limited(req, "ai", 12, 60e3)) return json(res, 429, { error: "слишком много вопросов подряд, подождите минуту" }), true;
        const day = new Date().toISOString().slice(0, 10);
        if (aiDay.day !== day) { aiDay.day = day; aiDay.n = 0; }
        if (++aiDay.n > AI_DAILY) return json(res, 429, { error: "дневной лимит ИИ исчерпан, попробуйте завтра" }), true;
        const b = await body(req);
        const lang = b.lang === "kk" ? "kk" : "ru";
        const issues = aiContextIssues(b.context);
        // сжатие под предел по протоколу ai-context.js (без обрезки строки): последние вопросы задают, какие участки важнее
        const userQ = (Array.isArray(b.messages) ? b.messages : []).slice(-12).filter(m => m && m.role !== "ai").map(m => str(m.text, 1200)).join("\n");
        const packed = X.compactContext(b.context && typeof b.context === "object" ? b.context : {}, { max: AI_CTX_MAX, focusText: userQ });
        const ctx = packed.json;
        const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-12)
          .map(m => `${m.role === "ai" ? "Помощник" : "Пользователь"}: ${str(m.text, 1200)}`).join("\n");
        const userText = userQ;   // числа из вопросов пользователя (не из прошлых ответов ИИ) допустимы в ответе
        const task = b.mode === "summary" ? AI_SUMMARY[lang] : AI_CHAT[lang];
        const input = `ДАННЫЕ (JSON):\n${ctx}\n\nПРОБЛЕМЫ_ДАННЫХ: ${issues.length ? issues.join(" ") : "нет"}\n\n` +
          `${msgs ? "РАЗГОВОР:\n" + msgs + "\n\n" : ""}ЗАДАЧА: ${task}`;
        // Казахский текст занимает больше токенов, чем русский: сводке нужен запас по длине и времени.
        // Сайт ждёт 90 с, поэтому общий бюджет — 60 с, на одну модель — до 30 с.
        const summary = b.mode === "summary";
        const started = Date.now();
        const opts = { system: AI_SYSTEM[lang], maxTokens: summary ? (lang === "kk" ? 900 : 600) : (lang === "kk" ? 900 : 700),
          timeoutMs: summary ? 30000 : 25000 };
        // Поиск Google — только в чате и в пределах дневного лимита (сверх бесплатной квоты Google каждый запрос поиска платный);
        // сводка строится только по данным села. Искать ли — решает модель по правилу SEARCH_RULE.
        if (searchDay.day !== day) { searchDay.day = day; searchDay.n = 0; }
        const search = !summary && searchDay.n < AI_SEARCH_DAILY;
        let r = await G.ask(Object.assign({ input, budgetMs: 60000, search }, opts, search ? { system: opts.system + " " + SEARCH_RULE[lang] } : {}));
        if (r.ok && r.searches) searchDay.n += r.searches;
        if (!r.ok) {
          // Gemini не ответил — шаблон из тех же данных: сайт и демо не зависят от перегрузок Google
          const ERR = { no_key: "ИИ не настроен на сервере", timeout: "ИИ не ответил вовремя, попробуйте ещё раз",
            quota: "у ИИ закончился лимит запросов Google, попробуйте позже", key: "ключ ИИ на сервере не принят Google",
            model_not_found: "модели ИИ из настроек сервера недоступны",
            overloaded: "серверы Google сейчас перегружены, ИИ не ответил — попробуйте через минуту" };
          const SHORT = { ru: { overloaded: "серверы Google перегружены", timeout: "не успел ответить", quota: "закончился лимит Google" },
            kk: { overloaded: "Google серверлері жүктелген", timeout: "уақытында жауап бермеді", quota: "Google лимиті бітті" } };
          return json(res, 200, { text: F.templateAnswer(b.context, lang, issues, SHORT[lang][r.error] || ""), fallback: true, model: null,
            error: ERR[r.error] || "ИИ сейчас перегружен, попробуйте через минуту", reason: r.error, issues }), true;
        }
        // Проверка чисел: всё, чего нет в данных и в вопросах пользователя, — выдумано или посчитано моделью.
        // Один повтор с просьбой убрать такие числа, если хватает времени (сайт ждёт 90 с).
        // числа из фрагментов ответа, подтверждённых источником поиска, тоже допустимы (источник показан под ответом)
        let check = F.verifyNumbers(r.text, packed.obj, userText + "\n" + (r.cited || []).join("\n"));
        const left = 80000 - (Date.now() - started);
        if (!check.ok && left > 15000 && !(r.sources || []).length) {   // ответ с поиском не переписываем без поиска — только помечаем
          const again = await G.ask(Object.assign({}, opts, { budgetMs: Math.min(30000, left), input: input +
            `\n\nПРОВЕРКА: в черновике ответа были числа, которых нет в ДАННЫХ: ${check.unknown.join(", ")}. ` +
            "Напиши ответ заново, используя только числа из ДАННЫХ; если нужного числа нет — скажи, что его нет в расчёте." }));
          if (again.ok) { const c2 = F.verifyNumbers(again.text, packed.obj, userText); if (c2.unknown.length <= check.unknown.length) { r = again; check = c2; } }
        }
        return json(res, 200, { text: r.text, model: r.model, issues, numbers: check,
          sources: r.sources || [], suggestions: (r.sources || []).length ? r.suggestions || "" : "",
          note: "Ответ ИИ — пояснение расчёта, а не заключение агронома или госоргана." }), true;
      }
      // --- вход ---
      if (p === "/auth/start" && req.method === "POST") {
        if (limited(req, "start", 10, 60e3)) return json(res, 429, { error: "слишком часто, подождите минуту" }), true;
        const nonce = rnd(24), code = String(crypto.randomInt(1000, 10000));
        await kv.set("login:" + sha(nonce), { status: "pending", code, created: Date.now() }, LOGIN_TTL);
        return json(res, 200, { nonce, code, link: `https://t.me/${botUsername}?start=login_${nonce}`, expires_in: LOGIN_TTL }), true;
      }
      if (p === "/auth/poll" && req.method === "GET") {
        if (limited(req, "poll", 120, 60e3)) return json(res, 429, { error: "слишком часто" }), true;
        const nonce = url.searchParams.get("nonce") || "";
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(nonce)) return json(res, 400, { error: "неверный код" }), true;
        const key = "login:" + sha(nonce), rec = await kv.get(key);
        if (!rec) return json(res, 200, { status: "expired" }), true;
        if (rec.status === "pending") return json(res, 200, { status: "pending" }), true;
        await kv.del(key);                                  // одноразовый
        if (rec.status !== "ok" || !st().users[rec.uid]) return json(res, 200, { status: "denied" }), true;
        const token = rnd(32);
        await kv.set("sess:" + sha(token), rec.uid, SESSION_TTL);
        return json(res, 200, { status: "ok", token, user: pubUser(st().users[rec.uid]) }), true;
      }

      // --- публично: стада села из Telegram (чужие — без имён) и число подписок на участки ---
      if (p === "/api/village" && req.method === "GET") {
        const me = await auth(req);
        const vk = vkey(url.searchParams.get("lat"), url.searchParams.get("lon"));
        const v = (st().villages || {})[vk];
        const subs = {};
        for (const c of Object.values(st().chats || {})) for (const k of c.subs || []) {
          const [kv, id] = k.split("|"); if (kv === vk) subs[id] = (subs[id] || 0) + 1;
        }
        let n = 0;
        const herds = (v && v.herds || []).map(h => {
          const mine = !!me && h.id === "tg" + me.user.uid;
          return { id: mine ? "mine" : "tg" + (++n), name: mine ? h.name : null, mine, from_bot: true,
            sheep: h.sheep || 0, goats: h.goats || 0, cattle: h.cattle || 0, horses: h.horses || 0, home: h.home, daily_return: !!h.daily_return };
        });
        return json(res, 200, { herds, subs }), true;
      }

      const a = await auth(req);
      if (!a) return json(res, 401, { error: "нужно войти" }), true;
      const u = a.user;

      if (p === "/auth/logout" && req.method === "POST") { await kv.del("sess:" + a.tokenHash); return json(res, 200, { ok: true }), true; }

      // --- профиль ---
      if (p === "/api/me" && req.method === "GET") return json(res, 200, pubUser(u)), true;
      if (p === "/api/me" && req.method === "DELETE") {      // удалить аккаунт и все свои данные
        const vk = farmVk(u);
        delete st().users[u.uid];
        for (const vk2 of Object.keys(st().villagePlans)) st().villagePlans[vk2] = st().villagePlans[vk2].filter(s => s.owner !== u.uid);
        if (onFarmSaved) onFarmSaved(u.uid, null, vk);
        await kv.del("sess:" + a.tokenHash);
        save();
        return json(res, 200, { ok: true }), true;
      }
      if (p === "/api/me/farm" && req.method === "PUT") {
        const oldVk = farmVk(u);
        u.farm = cleanFarm(await body(req));
        save();
        if (onFarmSaved) onFarmSaved(u.uid, u.farm, oldVk);
        return json(res, 200, pubUser(u)), true;
      }

      // --- свои пастбища (контур рисует фермер) ---
      if (p === "/api/me/pastures" && req.method === "POST") {
        if ((u.pastures || []).length >= 10) return json(res, 400, { error: "не больше 10 пастбищ на хозяйство" }), true;
        const past = cleanPasture(await body(req), u.pastures);
        u.pastures = (u.pastures || []).concat([past]);
        save();
        return json(res, 200, pubUser(u)), true;
      }
      const pm = /^\/api\/me\/pastures\/([A-Za-z0-9_-]{6,20})$/.exec(p);
      if (pm && req.method === "DELETE") {
        const before = (u.pastures || []).length;
        u.pastures = (u.pastures || []).filter(x => x.id !== pm[1]);
        if (u.pastures.length === before) return json(res, 404, { error: "пастбище не найдено" }), true;
        save();
        return json(res, 200, pubUser(u)), true;
      }

      // --- сценарии: свои + общие планы сёл, к которым есть доступ ---
      if (p === "/api/scenarios" && req.method === "GET") {
        const shared = [];
        for (const [vk, list] of Object.entries(st().villagePlans)) if (canSeeVillage(u, vk)) shared.push(...list.map(s => Object.assign({ shared: true }, s)));
        return json(res, 200, { own: u.scenarios || [], shared }), true;
      }
      if (p === "/api/scenarios" && req.method === "POST") {
        const b = await body(req);
        const dup = b && b.request_id && (u.scenarios || []).concat(...Object.values(st().villagePlans)).find(x => x.request_id === b.request_id && x.owner === u.uid);
        if (dup) return json(res, 200, Object.assign({ duplicate: true }, dup)), true;    // повторная отправка того же запроса
        const s = cleanScenario(b, u);
        if (b.shared) {
          const vk = vkey(s.village.lat, s.village.lon);
          if (roleOf(u) !== "coordinator" || !(u.villages || []).some(v => v.vk === vk))
            return json(res, 403, { error: "общий план села может публиковать только координатор этого села" }), true;
          s.shared = true;
          st().villagePlans[vk] = [s].concat(st().villagePlans[vk] || []).slice(0, 10);
        } else {
          u.scenarios = [s].concat(u.scenarios || []).slice(0, 30);
        }
        save();
        return json(res, 200, s), true;
      }
      const sm = /^\/api\/scenarios\/([A-Za-z0-9_-]{6,20})$/.exec(p);
      if (sm && req.method === "DELETE") {
        const before = (u.scenarios || []).length;
        u.scenarios = (u.scenarios || []).filter(s => s.id !== sm[1]);
        let found = u.scenarios.length !== before;
        for (const vk of Object.keys(st().villagePlans)) {
          const list = st().villagePlans[vk];
          const mine = list.filter(s => s.id === sm[1] && s.owner === u.uid);
          if (mine.length) { st().villagePlans[vk] = list.filter(s => s.id !== sm[1]); found = true; }
        }
        if (!found) return json(res, 404, { error: "сценарий не найден или принадлежит другому пользователю" }), true;
        save();
        return json(res, 200, { ok: true }), true;
      }

      // --- история расчётов ---
      if (p === "/api/history" && req.method === "GET") return json(res, 200, u.history || []), true;
      if (p === "/api/history" && req.method === "POST") {
        const b = await body(req), v = b.village || {};
        if (!coordOk(v.lat, v.lon)) return json(res, 400, { error: "нет села" }), true;
        const e = { at: new Date().toISOString(), kind: str(b.kind, 20) || "расчёт",
          village: { name: str(v.name, 80), lat: +(+v.lat).toFixed(5), lon: +(+v.lon).toFixed(5) },
          summary: b.summary && typeof b.summary === "object" ? JSON.parse(JSON.stringify(b.summary).slice(0, 1000)) : null };
        u.history = [e].concat(u.history || []).slice(0, 50);
        save();
        return json(res, 200, e), true;
      }

      // --- координатор ---
      if (p.startsWith("/api/coord")) {
        if (roleOf(u) !== "coordinator") return json(res, 403, { error: "раздел доступен только координатору (акимату)" }), true;
        if (p === "/api/coord/villages" && req.method === "POST") {
          const v = (await body(req)).village || {};
          if (!coordOk(v.lat, v.lon)) return json(res, 400, { error: "укажите село" }), true;
          const vk = vkey(v.lat, v.lon);
          u.villages = (u.villages || []).filter(x => x.vk !== vk).concat([{ vk, name: str(v.name, 80), lat: +(+v.lat).toFixed(5), lon: +(+v.lon).toFixed(5) }]).slice(0, 30);
          save();
          return json(res, 200, pubUser(u)), true;
        }
        if (p === "/api/coord/villages" && req.method === "DELETE") {
          const vk = url.searchParams.get("vk");
          u.villages = (u.villages || []).filter(x => x.vk !== vk);
          save();
          return json(res, 200, pubUser(u)), true;
        }
        if (p === "/api/coord/farms" && req.method === "GET") {
          const vk = url.searchParams.get("vk");
          if (!(u.villages || []).some(v => v.vk === vk)) return json(res, 403, { error: "это село не в вашем списке" }), true;
          const farms = Object.values(st().users).filter(x => farmVk(x) === vk).map(x => ({
            uid: x.uid, owner: x.name, name: x.farm.name, sheep: x.farm.sheep, goats: x.farm.goats, cattle: x.farm.cattle,
            horses: x.farm.horses, daily_return: x.farm.daily_return, home: x.farm.home, plots: x.farm.plots, updated: x.farm.updated,
            pastures: (x.pastures || []).map(q => ({ id: q.id, name: q.name, geometry: q.geometry, area_ha: q.area_ha, water: q.water, ndvi: q.stats && q.stats.ndvi,
              ndvi_provenance: (q.stats && q.stats.provenance) || "client_reported" })),
          }));
          return json(res, 200, { vk, farms }), true;
        }
      }
      return json(res, 404, { error: "нет такого адреса" }), true;
    } catch (e) {
      return json(res, e.code || 500, { error: e.code ? e.message : "внутренняя ошибка" }), true;
    }
  }

  return { handle, confirmLogin, loginInfo, roleOf };
}

module.exports = { createApi, aiContextIssues };
