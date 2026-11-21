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
bot.setTest();

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

test("профиль хозяйства: проверка данных и связь со стадом в боте", async () => {
  assert.equal((await call("PUT", "/api/me/farm", { token: farmer, body: { name: "Нет села" } })).status, 400);
  const r = await call("PUT", "/api/me/farm", { token: farmer, body: {
    name: "КХ <b>Ак</b>", village: KEGEN, sheep: 450, cattle: 12, horses: -5, home: "Д-С", plots: ["Б-С", "Д-С", "плохое"] } });
  assert.equal(r.status, 200);
  assert.equal(r.data.farm.name, "КХ bАк/b", "теги вырезаются");
  assert.equal(r.data.farm.horses, 0, "отрицательное поголовье обнуляется");
  assert.equal(r.data.farm.home, "Б-С", "домашний участок только ближний");
  assert.deepEqual(r.data.farm.plots, ["Б-С", "Д-С"]);
  const v = bot.getState().villages["43.020,79.220"];
  assert.ok(v.herds.some(h => h.id === "tg111" && h.sheep === 450), "стадо появилось в боте");
});

test("сценарии: свои видны только владельцу, чужие нельзя удалить", async () => {
  other = (await login(222, "Ерлан")).poll.data.token;
  const s = await call("POST", "/api/scenarios", { token: farmer, body: { name: "Мой план", village: KEGEN, herds: [{ name: "A", sheep: 100 }], water: ["Д-З", "x"] } });
  assert.equal(s.status, 200);
  assert.deepEqual(s.data.water, ["Д-З"]);
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

test("выход и удаление аккаунта", async () => {
  assert.equal((await call("POST", "/auth/logout", { token: other })).status, 200);
  assert.equal((await call("GET", "/api/me", { token: other })).status, 401, "после выхода токен не работает");
  assert.equal((await call("DELETE", "/api/me", { token: farmer })).status, 200);
  assert.equal(bot.getState().users["111"], undefined);
  assert.ok(!bot.getState().villages["43.020,79.220"].herds.some(h => h.id === "tg111"), "стадо удалено и из бота");
});

test("ограничение частоты запросов на вход", async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await call("POST", "/auth/start", { ip: "10.1.1.1" });
  assert.equal(last.status, 429);
});
