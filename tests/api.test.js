// Проверка входа через Telegram, ролей и разграничения доступа.  Запуск: node --test tests/*.test.js
// Сервер поднимается локально, Telegram имитируется вызовом обработчика бота (как это делает webhook).
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const os = require("os");
const path = require("path");

process.env.BOT_STATE_FILE = path.join(os.tmpdir(), `jaiylym-test-${process.pid}.json`);
process.env.COORDINATOR_IDS = "333";
delete process.env.REDIS_URL;
const bot = require("../bot.js");
const PL = require("../web/pipeline.js");
const G = require("../gemini.js");
bot.setTest();
// Сеть в тестах не используется: снимок для ежедневной проверки подставляем сами (реальный вызов — npm run test:net)
let fakeScene = null;
PL.latestPolygonScene = async () => fakeScene;
PL.latestScene = async () => null;

const SITE = "http://localhost:8765";
let base, server;
const sent = [];
const send = async (chat, text, kb) => { sent.push({ chat: String(chat), text, kb }); };

async function call(method, p, { token, body, origin = SITE, ip } = {}) {
  const headers = { origin };
  if (token) headers.authorization = "Bearer " + token;
  if (body) headers["content-type"] = "application/json";
  if (ip) headers["x-forwarded-for"] = ip;
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch (_) {}
  return { status: r.status, data, headers: r.headers };
}

// полный вход: сайт просит код → человек подтверждает в боте → сайт получает токен
async function login(uid, first_name, { confirm = true } = {}) {
  const st = await call("POST", "/auth/start", { ip: "10.0.0." + uid % 250 });
  assert.equal(st.status, 200);
  const { nonce, code } = st.data;
  await bot.handle({ message: { chat: { id: uid }, from: { id: uid, first_name }, text: "/start login_" + nonce } }, send);
  const msg = sent[sent.length - 1];
  assert.ok(msg.text.includes(code), "бот показывает тот же код, что и сайт");
  const data = msg.kb.inline_keyboard[0][confirm ? 0 : 1].callback_data;
  await bot.handle({ callback_query: { id: "x", data, from: { id: uid, first_name }, message: { chat: { id: uid } } } }, send);
  return { nonce, poll: await call("GET", "/auth/poll?nonce=" + nonce) };
}

test.before(async () => {
  server = http.createServer((req, res) => bot.siteApi.handle(req, res).then(done => { if (!done) res.writeHead(404).end(); }));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());

const KEGEN = { name: "Кеген", lat: 43.02, lon: 79.22 };
let farmer, other, coord;

test("вход: код ждёт подтверждения, токен выдаётся один раз", async () => {
  const st = await call("POST", "/auth/start");
  assert.match(st.data.link, /^https:\/\/t\.me\/JAIYLYM_bot\?start=login_[A-Za-z0-9_-]+$/);
  assert.match(st.data.code, /^\d{4}$/);
  assert.equal(st.headers.get("access-control-allow-origin"), SITE);
  assert.equal((await call("GET", "/auth/poll?nonce=" + st.data.nonce)).data.status, "pending");

  const { nonce, poll } = await login(111, "Айгерим");
  assert.equal(poll.data.status, "ok");
  assert.ok(poll.data.token.length >= 40);
  assert.equal(poll.data.user.role, "farmer");
  assert.equal((await call("GET", "/auth/poll?nonce=" + nonce)).data.status, "expired", "повторно токен не выдаётся");
  farmer = poll.data.token;
});

test("вход: чужой сайт не получает CORS-доступ, отказ в боте не даёт токен", async () => {
  const evil = await call("POST", "/auth/start", { origin: "https://evil.example", ip: "10.9.9.9" });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  const { poll } = await login(444, "Тест", { confirm: false });
  assert.equal(poll.data.status, "denied");
  assert.equal(poll.data.token, undefined);
});

test("без токена или с поддельным токеном — 401", async () => {
  assert.equal((await call("GET", "/api/me")).status, 401);
  assert.equal((await call("GET", "/api/me", { token: "x".repeat(43) })).status, 401);
  assert.equal((await call("GET", "/api/me", { token: farmer })).data.name, "Айгерим");
});

test("профиль хозяйства: неверные данные отклоняются с понятной ошибкой, а не обнуляются", async () => {
  assert.equal((await call("PUT", "/api/me/farm", { token: farmer, body: { name: "Нет села" } })).status, 400);
  const neg = await call("PUT", "/api/me/farm", { token: farmer, body: { name: "КХ", village: KEGEN, sheep: 450, horses: -5 } });
  assert.equal(neg.status, 400);
  assert.match(neg.data.error, /отрицательн/);
  assert.equal((await call("PUT", "/api/me/farm", { token: farmer, body: { village: KEGEN, sheep: 1.5 } })).status, 400, "дробное поголовье");
  assert.equal((await call("PUT", "/api/me/farm", { token: farmer, body: { village: KEGEN, sheep: "много" } })).status, 400, "не число");
  assert.equal((await call("PUT", "/api/me/farm", { token: farmer, body: { village: KEGEN, home: "Д-С" } })).status, 400, "домашний — только ближний");
  assert.equal((await call("PUT", "/api/me/farm", { token: farmer, body: { village: KEGEN, plots: ["Б-С", "плохое"] } })).status, 400, "неизвестный участок");
  assert.equal((await call("PUT", "/api/me/farm", { token: farmer, body: { village: { lat: 95, lon: 79 } } })).status, 400, "неверные координаты");
  const r = await call("PUT", "/api/me/farm", { token: farmer, body: {
    name: "КХ <b>Ак</b>", village: KEGEN, sheep: 450, cattle: 12, home: "Б-С", plots: ["Б-С", "Д-С", "Д-С"] } });
  assert.equal(r.status, 200);
  assert.equal(r.data.farm.name, "КХ bАк/b", "теги вырезаются");
  assert.equal(r.data.farm.horses, 0, "не указано — 0");
  assert.deepEqual(r.data.farm.plots, ["Б-С", "Д-С"], "повторы убраны");
  assert.equal(r.data.farm.rights_source, "user_entered", "право пользования — ввод пользователя, не реестр");
  const v = bot.getState().villages["43.020,79.220"];
  assert.ok(v.herds.some(h => h.id === "tg111" && h.sheep === 450), "стадо появилось в боте");
});

test("сценарии: свои видны только владельцу, чужие нельзя удалить", async () => {
  other = (await login(222, "Ерлан")).poll.data.token;
  assert.equal((await call("POST", "/api/scenarios", { token: farmer, body: { name: "x", village: KEGEN, water: ["Д-З", "x"] } })).status, 400, "неизвестный участок");
  const s = await call("POST", "/api/scenarios", { token: farmer, body: { name: "Мой план", village: KEGEN, herds: [{ name: "A", sheep: 100, weight: 2 }], water: ["Д-З"],
    rest: { "Б-С": { spring: 30, autumn: 0 }, "Д-С": { spring: 0, autumn: 0 } } } });
  assert.equal(s.status, 200);
  assert.deepEqual(s.data.water, ["Д-З"]);
  assert.deepEqual(s.data.rest, { "Б-С": { spring: 30, autumn: 0 } }, "отдых участка сохраняется, пустой — отбрасывается");
  assert.equal(s.data.herds[0].weight, 2, "приоритет хозяйства сохраняется");
  for (const bad of [{ rest: { "X-Y": { spring: 1 } } }, { rest: { "Б-С": { spring: -5 } } }, { rest: { "Б-С": { spring: 1.5 } } }, { herds: [{ name: "A", sheep: 1, weight: 5 }] }])
    assert.equal((await call("POST", "/api/scenarios", { token: farmer, body: Object.assign({ name: "x", village: KEGEN }, bad) })).status, 400, JSON.stringify(bad));
  assert.equal(s.data.model_version, "2.0.0");
  assert.equal((await call("GET", "/api/scenarios", { token: farmer })).data.own.length, 1);
  assert.equal((await call("GET", "/api/scenarios", { token: other })).data.own.length, 0);
  assert.equal((await call("DELETE", "/api/scenarios/" + s.data.id, { token: other })).status, 404);
  assert.equal((await call("DELETE", "/api/scenarios/" + s.data.id, { token: farmer })).status, 200);
});

test("координатор: доступ только к своим сёлам; фермеру раздел закрыт", async () => {
  coord = (await login(333, "Акимат")).poll.data.token;
  assert.equal((await call("GET", "/api/me", { token: coord })).data.role, "coordinator");
  assert.equal((await call("GET", "/api/coord/farms?vk=43.020,79.220", { token: farmer })).status, 403);
  assert.equal((await call("GET", "/api/coord/farms?vk=43.020,79.220", { token: coord })).status, 403, "село ещё не в списке");
  await call("POST", "/api/coord/villages", { token: coord, body: { village: KEGEN } });
  const f = await call("GET", "/api/coord/farms?vk=43.020,79.220", { token: coord });
  assert.equal(f.status, 200);
  assert.deepEqual(f.data.farms.map(x => x.uid), ["111"]);
});

test("общий план села: публикует только координатор, видят хозяйства этого села", async () => {
  const body = { name: "План акимата", village: KEGEN, herds: [], shared: true };
  assert.equal((await call("POST", "/api/scenarios", { token: farmer, body })).status, 403);
  assert.equal((await call("POST", "/api/scenarios", { token: coord, body })).status, 200);
  assert.equal((await call("GET", "/api/scenarios", { token: farmer })).data.shared.length, 1, "фермер Кегена видит план");
  assert.equal((await call("GET", "/api/scenarios", { token: other })).data.shared.length, 0, "без хозяйства в селе — не видит");
});

test("история расчётов — только своя", async () => {
  await call("POST", "/api/history", { token: farmer, body: { village: KEGEN, summary: { overloaded_before: 4, overloaded_after: 0 } } });
  assert.equal((await call("GET", "/api/history", { token: farmer })).data.length, 1);
  assert.equal((await call("GET", "/api/history", { token: other })).data.length, 0);
});

test("свои пастбища: проверка контура, площадь считает сервер, чужое удалить нельзя, координатор видит", async () => {
  const lat = 43.05, lon = 79.22, dy = 1 / 110.57, dx = 1 / (111.32 * Math.cos(lat * Math.PI / 180));
  const ring = [[lon, lat], [lon + dx, lat], [lon + dx, lat + dy], [lon, lat + dy]];           // 1×1 км, контур не замкнут
  const body = { name: "Летнее", geometry: { type: "Polygon", coordinates: [ring] }, area_ha: 99999, water: true,
    stats: { ndvi: 0.207, pasture_ha: 99.3, wc_pasture_share: 0.99, series: [{ d: "2026-06-27", v: 0.214 }, { d: "плохо", v: 1 }], year: 2026 } };
  const r = await call("POST", "/api/me/pastures", { token: farmer, body });
  assert.equal(r.status, 200);
  const past = r.data.pastures[0];
  assert.ok(Math.abs(past.area_ha - 100) < 0.5, "площадь пересчитана сервером, а не взята у клиента: " + past.area_ha);
  assert.equal(past.geometry.coordinates[0].length, 5, "контур замкнут");
  assert.deepEqual(past.stats.series, [{ d: "2026-06-27", v: 0.214 }], "плохие точки графика отброшены");

  assert.equal((await call("POST", "/api/me/pastures", { token: farmer, body: { geometry: { type: "Polygon", coordinates: [ring.slice(0, 2)] } } })).status, 400);
  const huge = [[79, 43], [79.6, 43], [79.6, 43.4], [79, 43.4]];
  assert.equal((await call("POST", "/api/me/pastures", { token: farmer, body: { geometry: { type: "Polygon", coordinates: [huge] } } })).status, 400);
  assert.equal((await call("POST", "/api/me/pastures", { token: farmer, body: { geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 200], [1, 1]]] } } })).status, 400);

  assert.equal((await call("DELETE", "/api/me/pastures/" + past.id, { token: other })).status, 404, "чужое пастбище не удаляется");
  const f = await call("GET", "/api/coord/farms?vk=43.020,79.220", { token: coord });
  assert.equal(f.data.farms[0].pastures[0].name, "Летнее");

  assert.equal(past.stats.provenance, "client_reported", "NDVI с сайта помечен как непроверенный");
  assert.equal(past.stats.verified, false);
  assert.equal((await call("POST", "/api/me/pastures", { token: farmer, body })).status, 409, "то же пастбище второй раз не сохраняется");
  const bow = [[lon, lat], [lon + dx, lat + dy], [lon + dx, lat], [lon, lat + dy]];        // «бантик»: рёбра пересекаются
  assert.equal((await call("POST", "/api/me/pastures", { token: farmer, body: { geometry: { type: "Polygon", coordinates: [bow] } } })).status, 400, "самопересечение");
  for (let i = 1; i < 10; i++) {
    const r2 = ring.map(([x, y]) => [x + i * 0.02, y]);
    assert.equal((await call("POST", "/api/me/pastures", { token: farmer, body: Object.assign({}, body, { geometry: { type: "Polygon", coordinates: [r2] } }) })).status, 200);
  }
  const r11 = ring.map(([x, y]) => [x + 0.5, y]);
  assert.equal((await call("POST", "/api/me/pastures", { token: farmer, body: { geometry: { type: "Polygon", coordinates: [r11] } } })).status, 400, "не больше 10");
  assert.equal((await call("DELETE", "/api/me/pastures/" + past.id, { token: farmer })).status, 200);
});

test("бот: подписка на своё пастбище только владельцу, уведомление по снимку без дублей", async () => {
  const q = bot.getState().users["111"].pastures[0];
  sent.length = 0;
  await bot.handle({ message: { chat: { id: 222 }, from: { id: 222 }, text: "/start m_" + q.id } }, send);
  assert.match(sent[0].text, /не найдено в вашем профиле/, "чужое пастбище не подписывается");
  await bot.handle({ message: { chat: { id: 111 }, from: { id: 111 }, text: "/start m_" + q.id } }, send);
  assert.match(sent[1].text, /Вы подписаны на своё пастбище «Летнее»/);
  assert.match(sent[1].text, /pasture=/, "ссылка ведёт на пастбище на сайте");
  sent.length = 0;
  fakeScene = { id: "S2B_TEST_20260829", date: "2026-08-29", cloud: 3, ndvi: 0.205, valid: 0.97 };
  const r = await bot.runCron(send, new Date("2026-08-31T04:00:00Z"));
  const mine = sent.filter(m => m.chat === "111" && /ваше пастбище «Летнее»/.test(m.text));
  assert.equal(mine.length, 1, JSON.stringify(r));
  assert.match(mine[0].text, /Снимок Sentinel-2 от 29\.08: NDVI 0\.\d\d/);
  assert.ok(!/Внимание: трава убывает/.test(mine[0].text), "одно наблюдение — не повод для тревоги");
  const obs = bot.getState().users["111"].pastures[0].observations;
  assert.equal(obs[obs.length - 1].source, "server", "снимок, проверенный сервером, сохранён отдельно");
  // планировщик запустили повторно с тем же снимком — второго сообщения нет
  bot.getState().users["111"].pastures[0].monitor.last = null;
  sent.length = 0;
  const r2 = await bot.runCron(send, new Date("2026-08-31T05:00:00Z"));
  assert.equal(sent.filter(m => m.chat === "111").length, 0, JSON.stringify(r2));
  assert.equal(r2.duplicates, 1);
  fakeScene = null;
});

test("выход и удаление аккаунта", async () => {
  assert.equal((await call("POST", "/auth/logout", { token: other })).status, 200);
  assert.equal((await call("GET", "/api/me", { token: other })).status, 401, "после выхода токен не работает");
  assert.equal((await call("DELETE", "/api/me", { token: farmer })).status, 200);
  assert.equal(bot.getState().users["111"], undefined);
  assert.ok(!bot.getState().villages["43.020,79.220"].herds.some(h => h.id === "tg111"), "стадо удалено и из бота");
});

test("сценарии: неверные параметры, слишком большой сценарий, повторная отправка", async () => {
  const tok = (await login(555, "Бота")).poll.data.token;
  const base = { name: "П", village: KEGEN, herds: [{ id: "a", sheep: 10 }] };
  for (const params of [{ util: 1.5 }, { util: -0.1 }, { season_days: 0 }, { season_days: -10 }, { k_ndvi: 1e9 }, { intake: "abc" }, { bogus: 1 }]) {
    const r = await call("POST", "/api/scenarios", { token: tok, body: Object.assign({}, base, { params }) });
    assert.equal(r.status, 400, JSON.stringify(params));
    assert.match(r.data.error, /параметры модели/);
  }
  assert.equal((await call("POST", "/api/scenarios", { token: tok, body: Object.assign({}, base, { params: { util: 0.4, season_days: 120 } }) })).status, 200);
  const many = Array.from({ length: 61 }, (_, i) => ({ id: "h" + i, sheep: 1 }));
  assert.equal((await call("POST", "/api/scenarios", { token: tok, body: Object.assign({}, base, { herds: many }) })).status, 400, "больше 60 стад");
  assert.equal((await call("POST", "/api/scenarios", { token: tok, body: Object.assign({}, base, { herds: [{ id: "a", sheep: 1 }, { id: "a", sheep: 2 }] }) })).status, 400, "повтор стада");
  assert.equal((await call("POST", "/api/scenarios", { token: tok, body: Object.assign({}, base, { herds: [{ id: "a", sheep: -1 }] }) })).status, 400, "отрицательное поголовье");
  assert.equal((await call("POST", "/api/scenarios", { token: tok, body: Object.assign({}, base, { water_status: { "Д-З": "есть" } }) })).status, 400, "неизвестный статус водопоя");
  const once = Object.assign({}, base, { request_id: "req-0123456789" });
  const a = await call("POST", "/api/scenarios", { token: tok, body: once });
  const b = await call("POST", "/api/scenarios", { token: tok, body: once });
  assert.equal(b.status, 200);
  assert.equal(b.data.duplicate, true);
  assert.equal(b.data.id, a.data.id, "повторный запрос не создаёт второй сценарий");
  assert.equal((await call("GET", "/api/scenarios", { token: tok })).data.own.filter(x => x.request_id === "req-0123456789").length, 1);
});

test("чужие данные: чужой сценарий не виден и не удаляется, чужое хозяйство не меняется", async () => {
  const a = (await login(601, "А")).poll.data.token, b = (await login(602, "Б")).poll.data.token;
  const s = await call("POST", "/api/scenarios", { token: a, body: { name: "секрет", village: KEGEN } });
  assert.ok(!(await call("GET", "/api/scenarios", { token: b })).data.own.some(x => x.id === s.data.id));
  assert.equal((await call("DELETE", "/api/scenarios/" + s.data.id, { token: b })).status, 404);
  await call("PUT", "/api/me/farm", { token: a, body: { name: "Ферма А", village: KEGEN, sheep: 10 } });
  await call("PUT", "/api/me/farm", { token: b, body: { name: "Ферма Б", village: KEGEN, sheep: 99, uid: "601" } });
  assert.equal(bot.getState().users["601"].farm.sheep, 10, "поле uid в теле запроса не позволяет писать в чужой профиль");
  assert.equal((await call("POST", "/api/scenarios", { token: b, body: { name: "план", village: KEGEN, shared: true } })).status, 403, "общий план без роли координатора");
});

test("повреждённый JSON и слишком большой запрос", async () => {
  const r = await fetch(base + "/api/scenarios", { method: "POST", headers: { authorization: "Bearer " + coord, "content-type": "application/json", origin: SITE }, body: "{не json" });
  assert.equal(r.status, 400);
  const big = await fetch(base + "/api/scenarios", { method: "POST", headers: { authorization: "Bearer " + coord, "content-type": "application/json", origin: SITE }, body: "{\"x\":\"" + "a".repeat(300 * 1024) + "\"}" }).catch(e => ({ status: "reset" }));
  assert.ok(big.status === 413 || big.status === "reset", "больше 256 КБ отклоняется: " + big.status);
});

test("ИИ: ключ не нужен браузеру, проблемы данных передаются модели, ошибки обрабатываются", async () => {
  const orig = G.ask;
  let seen = null;
  G.ask = async args => { seen = args; return { ok: true, text: "ответ", model: "test" }; };
  try {
    const r = await call("POST", "/api/ai", { ip: "10.7.7.1", body: { mode: "chat", lang: "ru", context: {}, messages: [{ role: "user", text: "сколько овец?" }] } });
    assert.equal(r.status, 200);
    assert.match(seen.input, /ПРОБЛЕМЫ_ДАННЫХ: Село не открыто/);
    assert.equal(seen.search, true, "в чате поиск разрешён");
    assert.doesNotMatch(seen.input, /ПОИСК:/, "вопрос о данных села — без указания искать");
    await call("POST", "/api/ai", { ip: "10.7.7.3", body: { mode: "chat", lang: "ru", context: {}, messages: [{ role: "user", text: "Какая погода ожидается в Кегене на этой неделе?" }] } });
    assert.match(seen.input, /ПОИСК: вопрос о свежих внешних сведениях/, "вопрос о погоде — прямое указание искать");
    assert.match(seen.system, /важнее правила «только ДАННЫЕ»/);
    assert.ok(r.data.issues.length >= 1);
    assert.match(r.data.note, /не заключение агронома/);
    const ctx = { "село": "Кеген", "статус_плана": "feasible", "итог": { "дефицит_сена_т_по_плану_оценка": 12 },
      "участки": [{ id: "Б-С", ndvi_спутник: null, нагрузка_по_плану_проц: 130 }], "стада": [{ имя: "А", овцы: -5 }], "демо_стада": true };
    const r2 = await call("POST", "/api/ai", { ip: "10.7.7.2", body: { mode: "summary", lang: "kk", context: ctx } });
    assert.equal(r2.status, 200);
    const all = r2.data.issues.join(" ");
    for (const re of [/Нет NDVI/, /Противоречие: статус/, /превышает 100/, /Неверное поголовье/, /демо-стада/]) assert.match(all, re);
    assert.match(seen.system, /ТЕК қазақ/);
    assert.match(seen.system, /не агроном/);
    G.ask = async () => ({ ok: false, error: "timeout" });
    const r3 = await call("POST", "/api/ai", { ip: "10.7.7.3", body: { mode: "chat", context: ctx } });
    assert.equal(r3.status, 200, "Gemini не ответил — шаблонный ответ, а не ошибка");
    assert.equal(r3.data.fallback, true);
    assert.match(r3.data.error, /не ответил вовремя/);
    assert.match(r3.data.text, /ИИ сейчас недоступен/);
    G.ask = async () => ({ ok: false, error: "no_key" });
    const r4 = (await call("POST", "/api/ai", { ip: "10.7.7.4", body: {} })).data;
    assert.match(r4.error, /не настроен/);
    assert.match(r4.text, /Село не открыто/);
  } finally { G.ask = orig; }
});

test("ИИ: метка [интернет] без источников поиска заменяется на [общее], с источниками — остаётся", async () => {
  const api = require("../api.js");
  assert.equal(api.fixWebLabels("— пасти по очереди [интернет]\n— [ Интернет ] ещё"), "— пасти по очереди [общее]\n— [общее] ещё");
  const orig = G.ask;
  try {
    G.ask = async () => ({ ok: true, text: "Вывод.\n— отдых участка 30 дней полезен [интернет]", model: "t" });
    const r = await call("POST", "/api/ai", { ip: "10.7.8.1", body: { mode: "chat", lang: "ru", context: {}, messages: [{ role: "user", text: "как пасти?" }] } });
    assert.match(r.data.text, /\[общее\]/); assert.doesNotMatch(r.data.text, /\[интернет\]/);
    G.ask = async () => ({ ok: true, text: "Сено 45 000 тенге [интернет]", model: "t", searches: 1, sources: [{ url: "https://example.kz", title: "x" }], cited: ["Сено 45 000 тенге"] });
    const r2 = await call("POST", "/api/ai", { ip: "10.7.8.2", body: { mode: "chat", lang: "ru", context: {}, messages: [{ role: "user", text: "цена сена?" }] } });
    assert.match(r2.data.text, /\[интернет\]/);
  } finally { G.ask = orig; }
});

test("ИИ: поиск Google только в чате; источники и подсказки в ответе; числа из цитат допустимы", async () => {
  const orig = G.ask;
  const calls = [];
  G.ask = async args => {
    calls.push(args);
    return args.search
      ? { ok: true, text: "Сено в районе стоит 45 000 тенге за тонну.", model: "t", searches: 1,
          sources: [{ url: "https://example.kz/seno", title: "example.kz" }], cited: ["Сено в районе стоит 45 000 тенге за тонну."], suggestions: "<div>chips</div>" }
      : { ok: true, text: "ответ", model: "t" };
  };
  try {
    const chat = await call("POST", "/api/ai", { ip: "10.7.8.1", body: { mode: "chat", lang: "ru", context: { село: "Кеген" }, messages: [{ role: "user", text: "почём сено?" }] } });
    assert.equal(calls[0].search, true);
    assert.match(calls[0].system, /Поиск в интернете: ищи, только если/);
    assert.deepEqual(chat.data.sources, [{ url: "https://example.kz/seno", title: "example.kz" }]);
    assert.equal(chat.data.suggestions, "<div>chips</div>");
    assert.equal(chat.data.numbers.ok, true, "45 000 — из фрагмента с источником");
    assert.equal(calls.length, 1, "ответ с поиском не переписывается");
    await call("POST", "/api/ai", { ip: "10.7.8.2", body: { mode: "summary", lang: "ru", context: { село: "Кеген" } } });
    assert.equal(calls[1].search, false, "сводка — без поиска");
    assert.doesNotMatch(calls[1].system, /Поиск в интернете/);
  } finally { G.ask = orig; }
});

test("ограничение частоты запросов на вход", async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await call("POST", "/auth/start", { ip: "10.1.1.1" });
  assert.equal(last.status, 429);
});

test("ИИ: какие вопросы требуют поиска в интернете", () => {
  const { needsWeb } = require("../api.js");
  for (const q of ["Какая погода ожидается в Кегене на этой неделе?", "Сколько стоит сено сейчас?", "почём баран?", "Ауа райы қандай болады?", "Шөп бағасы қанша?", "Нужна ли вакцинация овец весной?"])
    assert.equal(needsWeb(q), true, q);
  for (const q of ["Откуда взялось число 313 овец на участке Б-С?", "Почему стадо Ерлана пасётся на Д-ЮЗ?", "ёмкость оценена верно?", "Сколько овец выдержит моё пастбище?"])
    assert.equal(needsWeb(q), false, q);
});

test("ИИ: ответ, для которого модель искала в интернете, не переписывается без поиска (даже если чисел нет в данных)", async () => {
  const orig = G.ask;
  let calls = 0;
  try {
    G.ask = async () => { calls++; return { ok: true, text: "В Кегене в среду до +3 °C, ночью −8 °C [интернет]", model: "t", searches: 3, sources: [], cited: [] }; };
    const r = await call("POST", "/api/ai", { ip: "10.7.8.3", body: { mode: "chat", lang: "ru", context: {}, messages: [{ role: "user", text: "Какая погода в Кегене на неделе?" }] } });
    assert.equal(calls, 1, "без второго запроса без поиска");
    assert.match(r.data.text, /\+3 °C/);
    const st = await call("GET", "/api/ai/status", { ip: "10.7.8.4" });
    assert.equal(st.data.last_answer.searches, 3);
    assert.equal(st.data.last_answer.web_task, true);
  } finally { G.ask = orig; }
});
