/* Jaiylym — связь сайта с сервером (Render): вход через Telegram, профиль, сценарии, история.
 * В браузере хранится только токен сессии (не пароль: паролей в Jaiylym нет).
 * Гость: сценарии и история хранятся в этом браузере и так и подписаны в интерфейсе. */
(function () {
  "use strict";
  const API = "https://jaiylym-bot.onrender.com";
  const TOKEN_KEY = "jaiylym:session";
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} },
  };
  let token = ls.get(TOKEN_KEY, null);
  let user = null;

  class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

  async function req(method, path, body, { timeout = 70000, auth = true } = {}) {
    const headers = {};
    if (body) headers["content-type"] = "application/json";
    if (auth && token) headers.authorization = "Bearer " + token;
    let r;
    try {
      r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw new ApiError(navigator.onLine === false ? "offline" : "network", 0);
    }
    let data = null;
    try { data = await r.json(); } catch (_) {}
    if (r.status === 401 && auth && token) { setToken(null); user = null; }
    if (!r.ok) throw new ApiError((data && data.error) || ("HTTP " + r.status), r.status);
    return data;
  }
  function setToken(tk) { token = tk; tk ? ls.set(TOKEN_KEY, tk) : ls.del(TOKEN_KEY); }

  // ---------- вход ----------
  async function startLogin() { return req("POST", "/auth/start", null, { auth: false, timeout: 90000 }); }
  async function pollLogin(nonce) {
    const d = await req("GET", "/auth/poll?nonce=" + encodeURIComponent(nonce), null, { auth: false, timeout: 30000 });
    if (d.status === "ok") { setToken(d.token); user = d.user; }
    return d;
  }
  async function logout() {
    try { if (token) await req("POST", "/auth/logout", null, { timeout: 15000 }); } catch (_) {}
    setToken(null); user = null;
  }
  async function me() {
    if (!token) return (user = null);
    try { user = await req("GET", "/api/me"); }
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
  const coordAddVillage = village => req("POST", "/api/coord/villages", { village }).then(u => (user = u));
  const coordRemoveVillage = vk => req("DELETE", "/api/coord/villages?vk=" + encodeURIComponent(vk)).then(u => (user = u));
  const coordFarms = vk => req("GET", "/api/coord/farms?vk=" + encodeURIComponent(vk));

  // ---------- данные бота по селу (публично; свои стада помечены, чужие — без имён) ----------
  const villageData = (lat, lon) => req("GET", `/api/village?lat=${lat}&lon=${lon}`, null, { timeout: 90000 });

  // ---------- ИИ-помощник (Gemini через сервер; ключ хранится только на сервере) ----------
  const ai = body => req("POST", "/api/ai", body, { timeout: 90000 });

  window.Client = {
    API, ApiError, ls,
    get user() { return user; }, get loggedIn() { return !!token; },
    startLogin, pollLogin, logout, me, saveFarm, deleteAccount, addPasture, deletePasture,
    listScenarios, saveScenario, deleteScenario, listHistory, addHistory,
    coordAddVillage, coordRemoveVillage, coordFarms, villageData, ai,
  };
})();
