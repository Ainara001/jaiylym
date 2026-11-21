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

const SESSION_TTL = 30 * 24 * 3600;
const LOGIN_TTL = 600;
const MAX_BODY = 256 * 1024;
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const rnd = n => crypto.randomBytes(n).toString("base64url");

const num = (x, max = 1e6) => { const v = Math.round(+x); return Number.isFinite(v) ? Math.min(Math.max(v, 0), max) : 0; };
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
    farm: u.farm || null, villages: roleOf(u) === "coordinator" ? (u.villages || []) : [],
  });
  const farmVk = u => (u.farm && u.farm.village ? vkey(u.farm.village.lat, u.farm.village.lon) : null);
  const canSeeVillage = (u, vk) => farmVk(u) === vk || (roleOf(u) === "coordinator" && (u.villages || []).some(v => v.vk === vk));

  function cleanFarm(b) {
    const v = b.village || {};
    if (!coordOk(v.lat, v.lon)) throw Object.assign(new Error("укажите село"), { code: 400 });
    return {
      name: str(b.name, 60) || "Хозяйство",
      village: { name: str(v.name, 80) || "Село", lat: +(+v.lat).toFixed(5), lon: +(+v.lon).toFixed(5) },
      sheep: num(b.sheep), goats: num(b.goats), cattle: num(b.cattle), horses: num(b.horses),
      daily_return: !!b.daily_return,
      home: PLOT_RE.test(b.home) && b.home.startsWith("Б") ? b.home : "Б-С",
      plots: Array.isArray(b.plots) ? [...new Set(b.plots.filter(p => PLOT_RE.test(p)))].slice(0, 16) : [],
      updated: new Date().toISOString(),
    };
  }
  function cleanScenario(b, u) {
    const v = b.village || {};
    if (!coordOk(v.lat, v.lon)) throw Object.assign(new Error("в сценарии нет села"), { code: 400 });
    const herds = (Array.isArray(b.herds) ? b.herds : []).slice(0, 60).map((h, i) => ({
      id: str(h.id, 40) || "h" + i, name: str(h.name, 60) || "Стадо", sheep: num(h.sheep), goats: num(h.goats),
      cattle: num(h.cattle), horses: num(h.horses), home: PLOT_RE.test(h.home) ? h.home : "Б-С", daily_return: !!h.daily_return,
    }));
    const params = {};
    for (const k of ["season_days", "intake", "util", "k_ndvi", "hay_price"]) if (b.params && Number.isFinite(+b.params[k])) params[k] = +b.params[k];
    return {
      id: rnd(9), name: str(b.name, 80) || "Сценарий", owner: u.uid, ownerName: u.name,
      village: { name: str(v.name, 80), lat: +(+v.lat).toFixed(5), lon: +(+v.lon).toFixed(5) },
      herds, water: (Array.isArray(b.water) ? b.water : []).filter(p => PLOT_RE.test(p)).slice(0, 16), params,
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
        !p.startsWith("/api/history") && !p.startsWith("/api/coord") && p !== "/api/village") return false;
    cors(req, res);
    if (p === "/api/village" && !res.getHeader("Access-Control-Allow-Origin")) res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return true; }
    try {
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

      // --- сценарии: свои + общие планы сёл, к которым есть доступ ---
      if (p === "/api/scenarios" && req.method === "GET") {
        const shared = [];
        for (const [vk, list] of Object.entries(st().villagePlans)) if (canSeeVillage(u, vk)) shared.push(...list.map(s => Object.assign({ shared: true }, s)));
        return json(res, 200, { own: u.scenarios || [], shared }), true;
      }
      if (p === "/api/scenarios" && req.method === "POST") {
        const b = await body(req), s = cleanScenario(b, u);
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

module.exports = { createApi };
