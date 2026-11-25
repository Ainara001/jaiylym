/* Jaiylym — связь сайта с сервером (Render): вход через Telegram, профиль, сценарии, история.
 * В браузере хранится только токен сессии (не пароль: паролей в Jaiylym нет).
 * Гость: сценарии и история хранятся в этом браузере и так и подписаны в интерфейсе. */
(function () {
  "use strict";
  // адрес сервера; JAIYLYM_API_URL — только для автотестов (запросы на тот же адрес, без CORS)
  const API = (typeof window !== "undefined" && window.JAIYLYM_API_URL) || "https://jaiylym-bot.onrender.com";
  const TOKEN_KEY = "jaiylym:session";
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) {
      const s = JSON.stringify(v);
      for (let i = 0; i < 40; i++) {
        try { localStorage.setItem(k, s); return true; }
        // хранилище полно — убираем посчитанные сёла (их можно посчитать заново): ключи ссылок, вход и границы важнее
        catch (_) { if (!dropVillage(k)) return false; }
      }
      return false;
    },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} },
  };
  const HEAVY = /^jaiylym:v\d+:-?[\d.]+,-?[\d.]+(:ng|:multi:\d+|:prev:\d+)?$/;
  /** Освободить место: самая большая запись расчёта села, кроме той, что сохраняем. false — убирать нечего. */
  function dropVillage(keep) {
    let big = null, size = 0;
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k !== keep && HEAVY.test(k)) { const n = (localStorage.getItem(k) || "").length; if (n > size) { size = n; big = k; } } } } catch (_) {}
    if (big) ls.del(big);
    return !!big;
  }
  let token = ls.get(TOKEN_KEY, null);
  let user = null;

  class ApiError extends Error { constructor(msg, status, field, data) { super(msg); this.status = status; this.field = field || null; this.data = data || null; } }

  async function req(method, path, body, { timeout = 70000, auth = true, kel = "" } = {}) {
    const headers = {};
    if (body) headers["content-type"] = "application/json";
    if (auth && token) headers.authorization = "Bearer " + token;
    if (kel) headers.authorization = "Kelisim " + kel;       // Келісім: секрет личной ссылки вместо входа
    let r;
    try {
      r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw new ApiError(navigator.onLine === false ? "offline" : "network", 0);
    }
    let data = null;
    try { data = await r.json(); } catch (_) {}
    if (r.status === 401 && auth && token) { setToken(null); user = null; changed("expired"); }
    // сервер просыпается или обновляется: вместо данных — чужая страница или пустота. Это сбой связи, а не ответ
    if (!r.ok) throw new ApiError((data && data.error) || "network", r.status, data && data.field, data);
    if (!data || typeof data !== "object") throw new ApiError("network", 0);
    return data;
  }
  // вход или выход произошёл не по кнопке на этой странице (сессия закончилась, другая вкладка) — страница должна это показать
  let onAuth = null;
  const changed = why => { if (onAuth) onAuth(why); };
  if (typeof window !== "undefined") window.addEventListener("storage", e => {
    if (e.key !== TOKEN_KEY && e.key !== null) return;
    const tk = ls.get(TOKEN_KEY, null);
    if (tk === token) return;
    token = tk; user = null;
    if (tk) me().catch(() => {}).then(() => changed("tab")); else changed("tab");
  });
  function setToken(tk) { token = tk; tk ? ls.set(TOKEN_KEY, tk) : ls.del(TOKEN_KEY); }

  // ---------- вход ----------
  async function startLogin() { return req("POST", "/auth/start", null, { auth: false, timeout: 90000 }); }
  async function pollLogin(nonce) {
    const d = await req("GET", "/auth/poll?nonce=" + encodeURIComponent(nonce), null, { auth: false, timeout: 30000 });
    if (d.status === "ok") { setToken(d.token); user = d.user; }
    return d;
  }
  // вход и регистрация по логину и паролю (по выбору; Telegram — второй способ)
  async function passwordAuth(path, body) {
    const d = await req("POST", path, body, { auth: false, timeout: 90000 });
    if (d && d.status === "ok") { setToken(d.token); user = d.user; }
    return d;
  }
  const register = (name, login, password) => passwordAuth("/auth/register", { name, login, password });
  const loginPw = (login, password) => passwordAuth("/auth/login", { login, password });
  async function logout() {
    try { if (token) await req("POST", "/auth/logout", null, { timeout: 15000 }); } catch (_) {}
    setToken(null); user = null;
  }
  let meSeq = 0;
  async function me() {
    if (!token) return (user = null);
    const my = ++meSeq, tk = token;
    try { const u = await req("GET", "/api/me"); if (my === meSeq && tk === token) user = u; }          // пока ждали, вышли или вошли другим
    catch (e) { if (e.status === 401) user = null; else throw e; }
    return user;
  }

  // ---------- профиль ----------
  const saveFarm = farm => req("PUT", "/api/me/farm", farm).then(u => (user = u));
  const deleteAccount = () => req("DELETE", "/api/me").then(() => { setToken(null); user = null; });
  const addPasture = p => req("POST", "/api/me/pastures", p).then(u => (user = u));
  const deletePasture = id => req("DELETE", "/api/me/pastures/" + encodeURIComponent(id)).then(u => (user = u));

  // ---------- сценарии: сервер для вошедших, браузер для гостя ----------
  const GUEST_SC = "jaiylym:guest:scenarios", GUEST_HIST = "jaiylym:guest:history";
  const rid = () => Math.random().toString(36).slice(2, 11);
  async function listScenarios() {
    if (token) return req("GET", "/api/scenarios");
    return { own: ls.get(GUEST_SC, []), shared: [], local: true };
  }
  async function saveScenario(s) {
    if (token) return req("POST", "/api/scenarios", s);
    const sc = Object.assign({ id: rid(), created: new Date().toISOString(), local: true }, s);
    ls.set(GUEST_SC, [sc].concat(ls.get(GUEST_SC, [])).slice(0, 30));
    return sc;
  }
  async function deleteScenario(id) {
    if (token) return req("DELETE", "/api/scenarios/" + encodeURIComponent(id));
    ls.set(GUEST_SC, ls.get(GUEST_SC, []).filter(s => s.id !== id));
    return { ok: true };
  }
  async function listHistory() { return token ? req("GET", "/api/history") : ls.get(GUEST_HIST, []); }
  async function addHistory(e) {
    if (token) return req("POST", "/api/history", e).catch(() => null);
    ls.set(GUEST_HIST, [Object.assign({ at: new Date().toISOString(), local: true }, e)].concat(ls.get(GUEST_HIST, [])).slice(0, 50));
  }

  // ---------- координатор ----------

  // ---------- данные бота по селу (публично; свои стада помечены, чужие — без имён) ----------
  const villageData = (lat, lon) => req("GET", `/api/village?lat=${lat}&lon=${lon}`, null, { timeout: 90000 });

  // ---------- ИИ-помощник (Gemini через сервер; ключ хранится только на сервере) ----------
  const ai = body => req("POST", "/api/ai", body, { timeout: 90000 });

  // ---------- Келісім: согласование по личным ссылкам, без аккаунта ----------
  const kel = (method, path, key, body) => req(method, "/api/kelisim" + path, body, { auth: false, kel: key, timeout: 90000 });

  window.Client = {
    API, ApiError, ls, set onAuth(f) { onAuth = f; },
    get user() { return user; }, get loggedIn() { return !!token; },
    startLogin, pollLogin, register, loginPw, logout, me, saveFarm, deleteAccount, addPasture, deletePasture,
    listScenarios, saveScenario, deleteScenario, listHistory, addHistory,
    villageData, ai, kel,
  };
})();
