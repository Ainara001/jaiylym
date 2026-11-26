// Обычный человек на телефоне: аккаунт, выход, двойные нажатия, «Назад», две вкладки, обрывы связи, странный ввод; и внедрения
// разметки через поля, ссылки и ответы чужих серверов. Настоящий api.js, внешняя сеть закрыта. Запуск: npm run test:e2e
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
let pw = null;
try { pw = require("playwright"); } catch (_) {}
const BROWSERS = (process.env.JAIYLYM_BROWSERS || "chromium").split(",").map(s => s.trim()).filter(Boolean);
const { createApi } = require("../../api.js");
const { memoryKv } = require("../../store.js");
const { loadExamples } = require("../../data");
const G = require("../../ai.js");

const WEB = path.join(__dirname, "..", "..", "web");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2" };
const vkey = (lat, lon) => `${(+lat).toFixed(3)},${(+lon).toFixed(3)}`, sleep = ms => new Promise(r => setTimeout(r, ms));
const XSS = `"><img src=x onerror="window.__xss=1"> '><svg onload="window.__xss=2"> </script><script>window.__xss=3</script>`;
const PW = "long-password-1";

/** Свой сервер на каждый тест: состояние, счётчик запросов, задержка и «мусорный» режим. */
async function world(b) {
  const W = { hits: [], delay: 0, junk: "", ai: 0, errors: [], state: { users: {}, villages: Object.fromEntries(loadExamples().map(D => [vkey(D.village.lat, D.village.lon), { data: D, herds: [{ id: "tg5", name: XSS, sheep: 5, home: "Б-С" }] }])) } };
  const api = createApi({ getState: () => W.state, save() {}, kv: memoryKv(), vkey, botUsername: "x", onFarmSaved() {}, onDeleted() {}, allowedOrigins: [], kelisimSecret: "s" });
  let n = 0;
  const srv = http.createServer(async (q, r) => {
    const u = decodeURIComponent(new URL(q.url, "http://x").pathname);
    if (u.startsWith("/api/") || u.startsWith("/auth/")) {
      W.hits.push(q.method + " " + u); q.headers["x-forwarded-for"] = "91.1.1." + (n++ % 250);
      if (W.delay) await sleep(W.delay);
      if (W.junk === "html") { r.writeHead(200, { "content-type": "text/html" }); return r.end("<html>просыпаюсь"); }
      if (!(await api.handle(q, r))) r.writeHead(404).end();
      return;
    }
    const f = path.join(WEB, u === "/" ? "index.html" : u);
    if (!f.startsWith(WEB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.writeHead(404).end();
    r.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(r);
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  W.base = "http://127.0.0.1:" + srv.address().port + "/";
  W.ctx = async (init, opts) => { const c = await b.newContext(Object.assign({ serviceWorkers: "block", viewport: { width: 360, height: 740 }, hasTouch: true }, opts)); await c.addInitScript(a => { window.JAIYLYM_API_URL = a; }, W.base.slice(0, -1)); if (init) await c.addInitScript(init); return c; };
  W.page = async (c, reply) => {
    const p = await c.newPage(); p.on("pageerror", e => { if (!/service ?worker/i.test(e.message)) W.errors.push(e.message); });
    p.on("console", m => { if (/Content.Security.Policy|Refused to/i.test(m.text()) && !/inline event|javascript:|inline script|script-src/i.test(m.text())) W.errors.push(m.text()); });
    await p.route(u => !u.href.startsWith(W.base), r => (reply && reply(r)) || r.abort());
    return p;
  };
  W.close = () => { srv.closeAllConnections(); srv.close(); };
  return W;
}
const HOME = "#/map?lat=54.77515&lon=69.09779&name=" + encodeURIComponent("Бесколь") + "&demo=1";
const ready = p => p.waitForFunction(() => window.JaiylymApp && window.JaiylymApp.S.pl);
const go = (p, h) => p.evaluate(x => { location.hash = x; }, h);
const label = p => p.textContent("#accountShort");
const toast = p => p.evaluate(() => (document.querySelector("#toast").hidden ? "" : document.querySelector("#toast").innerText));

async function account(b) {
  const W = await world(b);
  try { await accountIn(W); } finally { W.close(); }          // сервер закрывается и при падении — иначе процесс тестов висит до тайм-аута CI
}
async function accountIn(W) {
  const c = await W.ctx(), p = await W.page(c), count = (re, from) => W.hits.slice(from).filter(x => re.test(x)).length;
  await p.goto(W.base + HOME); await ready(p);
  // регистрация: двойной тап и Enter — один аккаунт
  W.delay = 300;
  await p.click("#accountBtn"); await p.click('[data-mode="register"]');
  await p.fill("#pwForm [name=name]", "Айгуль"); await p.fill("#pwForm [name=login]", "aigul"); await p.fill("#pwForm [name=password]", "        ");
  await p.click("#pwGo"); await p.waitForSelector("#pwErr:not([hidden])");
  await p.fill("#pwForm [name=password]", PW);
  let from = W.hits.length;
  await p.evaluate(() => { const g = document.querySelector("#pwGo"); g.click(); g.click(); g.closest("form").requestSubmit(); });
  await p.waitForFunction(() => !document.querySelector("#loginDlg").open);
  assert.equal(count(/register/, from), 1); assert.equal(Object.keys(W.state.users).length, 1);
  // хозяйство в расчёте; после выхода его там нет, переписка с ИИ стёрта, двойной тап — один выход
  W.delay = 0;
  await p.evaluate(async () => { await window.Client.saveFarm({ name: "Моё", village: { name: "Бесколь", lat: 54.77515, lon: 69.09779 }, sheep: 50, home: "Б-С", plots: [] }); sessionStorage.setItem("jaiylym:chat", JSON.stringify([{ role: "user", text: "личное" }])); });
  await p.reload(); await ready(p); await p.waitForFunction(() => window.JaiylymApp.S.herds.some(h => h.mine));
  await go(p, "#/profile"); await p.waitForSelector("#prLogout");
  from = W.hits.length;
  await p.evaluate(() => { const x = document.querySelector("#prLogout"); x.click(); x.click(); });
  await p.waitForFunction(() => document.querySelector("#accountShort").textContent === "Войти");
  assert.equal(count(/logout/, from), 1);
  assert.deepEqual(await p.evaluate(() => [window.JaiylymApp.S.herds.some(h => h.mine), localStorage.getItem("jaiylym:session"), sessionStorage.getItem("jaiylym:chat")]), [false, null, null]);
  // Telegram: нажал «назад», пока ждали код, — форма входа не подменяется
  W.delay = 600; await p.click("#accountBtn"); await p.click("#tgGo"); await p.click("#lgBack"); await sleep(1000);
  assert.equal(await p.$("#loginBody .code"), null); await p.waitForSelector("#pwForm");
  // «Назад» в браузере закрывает окно, а не оставляет его поверх другой страницы
  W.delay = 0; await p.goBack(); await sleep(300);
  assert.equal(await p.evaluate(() => !!document.querySelector("dialog[open]")), false);
  // опасные кнопки: двойной тап не удаляет, два раздельных нажатия — удаляют; через 5 с кнопка возвращается
  await p.evaluate(w => window.Client.loginPw("aigul", w), PW); await p.reload(); await p.waitForFunction(() => window.Client.user);
  for (const n of ["A", "B"]) await p.evaluate(x => window.Client.saveScenario({ name: x, village: { name: "x", lat: 50, lon: 70 }, herds: [], water: [] }), n);
  const me = () => Object.values(W.state.users)[0];
  await go(p, "#/scenarios"); await p.waitForSelector("[data-del]");
  await p.evaluate(() => { const x = document.querySelector("[data-del]"); x.click(); x.click(); }); await sleep(400);
  assert.equal(me().scenarios.length, 2, "двойной тап ничего не удалил");
  await sleep(500); await p.click("[data-del].btn-danger-on"); await p.waitForFunction(() => document.querySelectorAll("[data-del]").length === 1);
  assert.equal(me().scenarios.length, 1);
  await go(p, "#/profile"); await p.waitForSelector("#prDelete"); await p.dblclick("#prDelete"); await sleep(400);
  assert.equal(Object.keys(W.state.users).length, 1, "двойной тап не удалил аккаунт");
  await p.waitForFunction(() => !document.querySelector("#prDelete").classList.contains("btn-danger-on"), null, { timeout: 8000 });
  // введённое в профиле не теряется при смене языка
  await p.fill("#farmForm [name=name]", "Не сохранено"); await p.click('.langsw [data-lang="kk"]'); await sleep(200);
  assert.equal(await p.inputValue("#farmForm [name=name]"), "Не сохранено"); await p.click('.langsw [data-lang="ru"]');
  // вторая вкладка: вышли там — здесь это видно; сессия закончилась посреди работы — сказано
  const p2 = await W.page(c); await p2.goto(W.base + "#/profile"); await p2.waitForSelector("#prLogout"); await p2.click("#prLogout");
  await p.waitForFunction(() => document.querySelector("#accountShort").textContent === "Войти");
  await p.evaluate(w => window.Client.loginPw("aigul", w), PW);
  await p.evaluate(() => fetch(window.Client.API + "/auth/logout", { method: "POST", headers: { authorization: "Bearer " + JSON.parse(localStorage.getItem("jaiylym:session")) } }));
  // всплывающее сообщение исчезает через несколько секунд: запоминаем всё, что в нём было (в WebKit проверка иногда опаздывала)
  await p.evaluate(() => { const t = document.querySelector("#toast"); window.__toasts = []; new MutationObserver(() => window.__toasts.push(t.innerText)).observe(t, { childList: true, subtree: true, characterData: true, attributes: true }); });
  await p.evaluate(() => window.Client.listScenarios().catch(() => {}));
  await p.waitForFunction(() => window.__toasts.some(x => /Сессия закончилась/.test(x)));
  assert.equal(await label(p), "Войти");
  // длинное имя не раздвигает страницу
  await p.evaluate(w => window.Client.register("Ж".repeat(200), "longname", w), PW); await p.reload(); await p.waitForFunction(() => window.Client.user); await go(p, "#/profile"); await p.waitForSelector("#farmForm");
  for (const h of ["#/profile", "#/scenarios", "#/settings", "#/ai", "#/kelisim", "#/home", "#/map"]) {
    await go(p, h); await sleep(250);
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "страница раздвинулась: " + h);
  }
  assert.deepEqual(W.errors, []);
}

async function habits(b) {
  const W = await world(b), p = await W.page(await W.ctx()), was = G.ask;
  G.ask = async () => { W.ai++; await sleep(400); return { ok: true, text: "Ответ " + W.ai, model: "m" }; };
  try {
    await p.goto(W.base + HOME); await ready(p);
    // чат: двойной тап и подсказки подряд — один вопрос; уход со страницы не рвёт переписку
    await go(p, "#/ai"); await p.waitForSelector("#chatForm"); await p.fill("#chatIn", "Где трава?");
    await p.evaluate(() => { document.querySelector("#chatForm").requestSubmit(); document.querySelectorAll(".chips-q button")[0].click(); document.querySelectorAll(".chips-q button")[1].click(); });
    await go(p, "#/settings"); await sleep(800); await go(p, "#/ai"); await p.waitForFunction(() => /Где трава\?[\s\S]*Ответ 1/.test(document.querySelector("#chatLog").innerText));
    assert.equal(W.ai, 1); assert.equal(await p.$$eval("#chatLog .msg", x => x.length), 2);
    // сервер просыпается (HTML вместо данных): понятное сообщение, без ошибок
    W.junk = "html"; await p.fill("#chatIn", "вопрос"); await p.evaluate(() => document.querySelector("#chatForm").requestSubmit());
    await p.waitForFunction(() => /Сервер недоступен/.test(document.querySelector("#chatLog").innerText));
    for (const h of ["#/scenarios", "#/profile", "#/kelisim", "#/map"]) { await go(p, h); await sleep(150); }
    await go(p, "#/kelisim"); await p.click("#kelDemo"); await p.waitForSelector("#kelCreate"); await p.click("#kelCreate");
    await p.waitForFunction(() => /Сервер недоступен/.test(document.querySelector("#kelErr").innerText)); W.junk = "";
    // Келісім: двойной тап создаёт одно согласование и не закрывает его
    let from = W.hits.length; W.delay = 200;
    await p.evaluate(() => { const x = document.querySelector("#kelCreate"); x.click(); x.click(); }); await p.waitForSelector("#kStart"); W.delay = 0;
    assert.equal(W.hits.slice(from).filter(x => x === "POST /api/kelisim").length, 1);
    await p.click("#kStart"); await p.waitForSelector("#kClose"); await p.dblclick("#kClose"); await sleep(500);
    assert.equal(await p.$("#kelPdf"), null, "двойной тап не закрыл согласование");
    // странные числа
    await go(p, HOME); await ready(p); await p.evaluate(() => window.JaiylymApp.renderPane("herds"));
    const put = v => p.evaluate(x => { const i = document.querySelector('.herd [data-k="sheep"]'); i.value = x; i.dispatchEvent(new Event("change", { bubbles: true })); return window.JaiylymApp.S.herds[0].sheep; }, v);
    assert.deepEqual([await put("-5"), await put("1e21"), await put("3.7"), await put("")], [0, 100000, 4, 0]);
    // граница «восьмёркой» — рисование продолжается
    await p.evaluate(() => { document.querySelector("#drawBtn").click(); }); await p.waitForFunction(() => window.JaiylymApp.S.draw);
    await p.evaluate(() => { const s = window.JaiylymApp.S, c = s.map.getCenter(); for (const [a, d] of [[0, 0], [0.01, 0.01], [0, 0.01], [0.01, 0]]) s.map.fire("click", { latlng: window.L.latLng(c.lat + a, c.lng + d) }); document.querySelector("#drawDone").click(); });
    assert.match(await toast(p), /пересекаются/); assert.equal(await p.evaluate(() => window.JaiylymApp.S.draw.pts.length), 4);
    await p.evaluate(() => document.querySelector("#drawCancel").click());
    // быстрые нажатия
    await p.evaluate(() => { for (let k = 0; k < 30; k++) { document.querySelectorAll(".tabs [data-tab]")[k % 7].click(); document.querySelectorAll(".modes button")[k % 3].click(); document.querySelectorAll(".langsw button")[k % 2].click(); } });
    assert.equal(await p.evaluate(() => [...document.querySelectorAll(".pane")].filter(x => !x.hidden).length), 1);
    // браузер запрещает хранилище
    const q = await W.page(await W.ctx(() => { for (const k of ["localStorage", "sessionStorage"]) try { Object.defineProperty(window, k, { get() { throw new Error("denied"); } }); } catch (_) {} }));
    await q.goto(W.base + HOME); await ready(q); for (const h of ["#/profile", "#/ai", "#/kelisim", "#/settings"]) { await go(q, h); await sleep(120); }
    assert.deepEqual(W.errors, []);
  } finally { G.ask = was; W.close(); }
}

async function injections(b) {
  const W = await world(b), was = G.ask;
  G.ask = async () => ({ ok: true, text: XSS + "\n— " + XSS + " [интернет]", model: XSS, sources: [{ url: "javascript:window.__xss=4", title: XSS }, { url: `https://x.kz/"><img src=x onerror=window.__xss=5>`, title: XSS }], searches: 1, cited: [XSS], suggestions: `<script>parent.__xss=6</script>${XSS}` });
  const J = (r, o) => { r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(o) }); return true; };
  const reply = r => { const u = r.request().url();
    if (/nominatim.*search/.test(u)) return J(r, [{ name: XSS, display_name: XSS, lat: "54.77515", lon: "69.09779", address: { state: XSS } }, { name: XSS, display_name: XSS, lat: "43.02", lon: "79.22" }]);
    if (/nominatim/.test(u)) return J(r, { name: XSS, display_name: XSS, address: { village: XSS, state: XSS } });
    if (/open-meteo/.test(u)) return J(r, { daily: { time: ["2026-11-25", XSS], precipitation_sum: [XSS, 1], temperature_2m_max: [XSS, 2], temperature_2m_min: [1, XSS] } }); };
  try {
    const p = await W.page(await W.ctx(null, { viewport: { width: 1280, height: 900 }, hasTouch: false }), reply), E = encodeURIComponent;
    const clean = async n => assert.equal(await p.evaluate(() => window.__xss), undefined, "исполнилась разметка: " + n);
    await p.goto(W.base + "#/map?lat=54.77515&lon=69.09779&name=" + E(XSS) + "&demo=1&plot=" + E(XSS)); await ready(p); await sleep(700); await clean("ссылка, погода, стада Telegram");
    await p.evaluate(async x => { const s = window.JaiylymApp.S; s.herds.forEach(h => { h.name = x; h.sheep = 3000; }); s.useBot = true; s.D.village.name = x; s.D.nograze = { status: "error", error: x }; window.JaiylymApp.render(); for (const t of ["herds", "routes", "water", "whatif", "plots", "data", "brief"]) window.JaiylymApp.renderPane(t); }, XSS); await sleep(200); await clean("вкладки");
    await p.click("#aiBriefBtn"); await sleep(400); await clean("сводка ИИ");
    await p.fill("#mapQ", XSS); await p.evaluate(() => document.querySelector("#mapSearch").requestSubmit()); await p.waitForSelector("#mapSearch .results li"); await clean("поиск места");
    await go(p, "#/ai"); await p.waitForSelector("#chatForm"); await p.fill("#chatIn", XSS); await p.evaluate(() => document.querySelector("#chatForm").requestSubmit()); await p.waitForSelector(".ai-src a"); await sleep(200); await clean("чат");
    assert.deepEqual(await p.$$eval(".ai-src a", a => a.map(x => x.protocol)), ["https:"], "ссылка javascript: отброшена");
    await p.evaluate(async ([x, w]) => { const C = window.Client; await C.register(x, "xss_user", w); await C.saveFarm({ name: x, village: { name: x, lat: 54.77515, lon: 69.09779 }, sheep: 5, home: "Б-С", plots: [] }); await C.saveScenario({ name: x, village: { name: x, lat: 50, lon: 70 }, herds: [{ id: x, name: x, sheep: 1 }], water: [], summary: { overloaded_before: x } }); await C.addHistory({ kind: x, village: { name: x, lat: 1, lon: 1 } }); }, [XSS, PW]);
    for (const h of ["#/profile", "#/scenarios", "#/settings", "#/home"]) { await p.goto(W.base + "?r=" + Math.random() + h); await sleep(400); await clean(h); }
    await p.evaluate(x => { const s = (k, v) => localStorage.setItem("jaiylym:" + k, JSON.stringify(v)); s("params", { season_days: x }); s("calibration", { source: x, date: x, values: { k_ndvi: 4000 } }); s("last", { name: x, lat: 1, lon: 1 }); s("mode", x); s("kel", [{ id: x, key: x, role: x, title: x, name: x, at: x }]); }, XSS);
    for (const h of ["#/home", "#/settings", "#/kelisim"]) { await p.goto(W.base + "?r=" + Math.random() + h); await sleep(300); await clean("испорченное хранилище " + h); }
    await p.evaluate(() => localStorage.clear()); await p.goto(W.base + "?k=1#/kelisim"); await p.click("#kelDemo"); await p.waitForSelector("#kelCreate");
    await p.fill("#kelRows .krow:nth-child(1) [data-f=name]", XSS.slice(0, 60)); await p.fill("#kelTitle", XSS.slice(0, 80)); await p.click("#kelCreate"); await p.waitForSelector("#kStart");
    await p.click(".kyard:nth-of-type(1) [data-link]"); await p.waitForSelector("dialog[open] .klink"); const link = (await p.innerText("dialog[open] .klink")).trim(); await p.click("dialog[open] .modal-x button");
    await p.click("#kStart"); await p.waitForSelector("#kClose"); await clean("Келісім");
    const d = await W.page(await W.ctx()); await d.goto(link); await d.waitForSelector("#kelObj"); await d.click("#kelObj"); await d.check("[name=kMode][value=other]", { force: true }); await d.fill("[name=kText]", XSS); await d.click("#kSend"); await d.waitForSelector(".kwait");
    assert.equal(await d.evaluate(() => window.__xss), undefined);
    await p.reload(); await p.waitForSelector(".kprop"); await p.evaluate(async () => { const K = window.JaiylymApp.Kel, e = document.createElement("div"); e.innerHTML = K.protocolHtml(await window.Client.kel("GET", "/" + K.state.V.id + "/protocol", K.state.cur.key)); document.body.appendChild(e); }); await sleep(200); await clean("возражение и протокол");
    // вторая линия защиты: даже вставленная разметка не исполняется
    await p.evaluate(x => { const e = document.createElement("div"); e.innerHTML = x; document.body.appendChild(e); const s = document.createElement("script"); s.textContent = "window.__xss=7"; document.body.appendChild(s); }, XSS); await sleep(300); await clean("CSP");
    assert.deepEqual(W.errors, []);
  } finally { G.ask = was; W.close(); }
}

for (const name of BROWSERS) for (const [title, fn] of [["аккаунт, выход, двойные нажатия, две вкладки", account], ["привычки: чат, сбои сервера, странный ввод, запрет хранилища", habits], ["внедрения: поля, ссылки, ответы чужих серверов", injections]])
  test(`${name}: обычный человек — ${title}`, { skip: !pw && "playwright не установлен", timeout: 150000 }, async () => {
    const b = await pw[name].launch();
    try { await fn(b); } finally { await b.close(); }
  });
