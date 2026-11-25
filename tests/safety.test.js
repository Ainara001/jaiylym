// Надёжность и защита сервера: состояние, Redis, адрес клиента, вход по паролю, бот. Настоящий bot.js с поддельными Redis и Telegram, без сети.
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net"), path = require("path"), os = require("os"), fs = require("fs"), crypto = require("crypto"), { spawn } = require("child_process");
const { redisClient } = require("../store.js");
const { clientIp } = require("../clientip.js");

const ROOT = path.join(__dirname, ".."), sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- поддельный Redis ----------
function fakeRedis() {
  const db = new Map(), st = { failState: 0, hook: null };
  const parse = b => {
    if (b[0] !== 42) return null;
    let nl = b.indexOf("\r\n"); if (nl < 0) return null;
    const n = +b.toString("utf8", 1, nl), out = []; let p = nl + 2;
    for (let i = 0; i < n; i++) { nl = b.indexOf("\r\n", p); if (nl < 0) return null; const len = +b.toString("utf8", p + 1, nl); if (b.length < nl + 4 + len) return null; out.push(b.toString("utf8", nl + 2, nl + 2 + len)); p = nl + 4 + len; }
    return [out, p];
  };
  const run = ([c, k, v], s) => {
    if (c === "SET") { db.set(k, v); return s.write("+OK\r\n"); }
    if (c === "DEL") { db.delete(k); return s.write(":1\r\n"); }
    if (c !== "GET") return s.write("+OK\r\n");
    if (k === "jaiylym:state" && st.failState-- > 0) return s.write("-LOADING Redis is loading the dataset in memory\r\n");
    if (st.hook && st.hook(k, s)) return;
    const x = db.get(k);
    s.write(x == null ? "$-1\r\n" : `$${Buffer.byteLength(x)}\r\n${x}\r\n`);
  };
  const srv = net.createServer(s => {
    let buf = Buffer.alloc(0); s.on("error", () => {});
    s.on("data", d => { buf = Buffer.concat([buf, d]); for (;;) { const r = parse(buf); if (!r) return; buf = buf.subarray(r[1]); run(r[0], s); } });
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r({ db, st, port: srv.address().port, close: () => srv.close() })));
}

// ---------- настоящий сервер бота ----------
const MOCK = path.join(os.tmpdir(), `jaiylym-mock-${process.pid}.js`);
fs.writeFileSync(MOCK, `let ai = 0; globalThis.fetch = async (u, o) => { u = String(u);
  if (u.startsWith("https://api.telegram.org")) return new Response(JSON.stringify({ ok: true, result: { username: "x" } }));
  if (u.startsWith("https://api.deepseek.com")) { console.log("AI-CALL", ++ai); return new Response(JSON.stringify({ choices: [{ message: { content: "Ответ." }, finish_reason: "stop" }], usage: {} })); }
  throw new Error("сеть закрыта"); };`);
test.after(() => { try { fs.unlinkSync(MOCK); } catch (_) {} });
let nextPort = 21000 + process.pid % 4000;
async function startBot(redisPort) {
  const port = nextPort++, B = "http://127.0.0.1:" + port;
  const p = spawn(process.execPath, ["-r", MOCK, path.join(ROOT, "bot.js")], { cwd: ROOT, env: Object.assign({}, process.env, { TELEGRAM_TOKEN: "1:x", RENDER_EXTERNAL_URL: B, PORT: String(port), REDIS_URL: "redis://127.0.0.1:" + redisPort, DEEPSEEK_API_KEY: "k" }) });
  let log = ""; p.stdout.on("data", d => log += d); p.stderr.on("data", d => log += d);
  for (let i = 0; i < 200 && !/Режим: webhook/.test(log); i++) { if (p.exitCode != null) throw new Error("не поднялся: " + log); await sleep(50); }
  const call = async (m, u, b, h = {}) => { const r = await fetch(B + u, { method: m, headers: Object.assign({ "content-type": "application/json" }, h), body: b === undefined ? undefined : JSON.stringify(b) }); return { s: r.status, d: await r.json().catch(() => null) }; };
  const tg = u => fetch(B + "/tg", { method: "POST", headers: { "x-telegram-bot-api-secret-token": crypto.createHash("sha256").update("1:x").digest("hex").slice(0, 32) }, body: JSON.stringify(u) });
  const say = (id, text) => tg({ message: { chat: { id }, from: { id, first_name: "Ш" }, text } });
  return { p, port, call, tg, say, get log() { return log; }, stop: () => new Promise(r => { if (p.exitCode != null) return r(); p.on("exit", r); p.kill(); }) };
}

test("адрес клиента: подделка слева не помогает, прокси Render и Cloudflare пропускаются", () => {
  const ip = (xff, peer = "10.0.0.7") => clientIp({ headers: xff ? { "x-forwarded-for": xff } : {}, socket: { remoteAddress: peer } });
  assert.equal(ip("91.185.1.2, 172.70.1.1, 10.217.2.3"), "91.185.1.2", "обычный человек за Cloudflare");
  assert.equal(ip("8.8.8.8, 91.185.1.2, 172.70.1.1, 10.217.2.3"), "91.185.1.2", "подделанный левый адрес не считается");
  assert.equal(ip("8.8.8.8, 91.185.1.2"), "91.185.1.2");
  assert.equal(ip("8.8.8.8", "91.185.1.2"), "91.185.1.2", "прямое подключение — заголовку не верим");
  assert.equal(ip("мусор, 91.185.1.2, 10.0.0.1"), "91.185.1.2");
  assert.equal(ip(null, "::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(ip("2a02:6b8:1:2:aaaa::1, 2606:4700::1"), ip("2a02:6b8:1:2:bbbb::9, 2606:4700::1"), "IPv6: одна сеть /64 — один человек");
});

test("Redis: обрыв посреди ответа не сдвигает ответы и не роняет процесс; молчащее соединение закрывается", async () => {
  const R = await fakeRedis(), r = redisClient("redis://127.0.0.1:" + R.port, { timeoutMs: 300 });
  await r.set("a", "АА"); await r.set("b", "ББ");
  let once = true;
  R.st.hook = (k, s) => { if (!once) return false; once = false; s.write("$20\r\n\"обр"); setTimeout(() => s.destroy(), 20); return true; };
  await assert.rejects(r.get("a"));
  assert.deepEqual(await Promise.all([r.get("a"), r.get("b"), r.get("нет")]), ["АА", "ББ", null]);
  R.st.hook = () => true;                                  // сервер молчит
  await assert.rejects(r.get("a"), /вовремя/);
  R.st.hook = null;
  assert.equal(await r.get("b"), "ББ");
  once = true;
  R.st.hook = (k, s) => { if (!once) return false; once = false; s.write("XYZ\r\n"); return true; };
  await assert.rejects(r.get("a"), /Неожиданный/);
  R.st.hook = null;
  assert.equal(await r.get("a"), "АА");
  r.close(); R.close();
});

test("вход по паролю переживает перезапуск; логин не занять; сбой чтения состояния ничего не стирает", { timeout: 60000 }, async () => {
  const R = await fakeRedis(); let bot = await startBot(R.port);
  const reg = await bot.call("POST", "/auth/register", { name: "Айгуль", login: "aigul", password: "correct-horse" });
  assert.equal(reg.s, 200);
  await sleep(500); await bot.stop();
  // прежнее состояние — без списка логинов, как было на сервере
  R.st.failState = 1;                                      // первое чтение при старте не удалось
  bot = await startBot(R.port);
  assert.match(bot.log, /Хранилище недоступно \(попытка 1/);
  const inn = await bot.call("POST", "/auth/login", { login: "Aigul", password: "correct-horse" });
  assert.equal(inn.s, 200); assert.equal(inn.d.user.uid, reg.d.user.uid);
  assert.equal((await bot.call("POST", "/auth/register", { name: "Чужой", login: "aigul", password: "attacker-pass" })).s, 409);
  assert.equal((await bot.call("POST", "/auth/register", { name: "К", login: "constructor", password: "long-password-1" })).s, 200);
  await sleep(500);
  assert.equal(Object.keys(JSON.parse(R.db.get("jaiylym:state")).users).length, 2, "пользователи на месте");
  await bot.stop(); R.close();
});

test("состояние не прочитано — сервер останавливается, а не работает с пустым", { timeout: 20000 }, async () => {
  const srv = net.createServer(s => { s.on("error", () => {}); s.on("data", () => s.write("-LOADING\r\n")); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const code = `require(${JSON.stringify(MOCK)}); process.env.REDIS_URL="redis://127.0.0.1:${srv.address().port}";
    const bot = require(${JSON.stringify(path.join(ROOT, "bot.js"))});
    bot._loadState({ tries: 2, waitMs: 5 }).then(() => console.log("ПРОЧИТАНО"), e => { bot._save(); setTimeout(() => { console.log("ОШИБКА " + e.message); process.exit(0); }, 800); });`;
  const p = spawn(process.execPath, ["-e", code], { cwd: ROOT }); let out = "";
  p.stdout.on("data", d => out += d); p.stderr.on("data", d => out += d);
  await new Promise(r => p.on("exit", r)); srv.close();
  assert.match(out, /ОШИБКА LOADING/); assert.doesNotMatch(out, /Не сохранилось|ПРОЧИТАНО/);
});

test("подбор пароля параллельно: не больше 10 попыток с адреса; хозяин с другого адреса входит", { timeout: 60000 }, async () => {
  const R = await fakeRedis(), bot = await startBot(R.port);
  await bot.call("POST", "/auth/register", { name: "Е", login: "erlan", password: "jailau-parol-7" });
  const c = {}, from = ip => ({ "x-forwarded-for": ip });
  await Promise.all(Array.from({ length: 25 }, (_, i) => bot.call("POST", "/auth/login", { login: "erlan", password: "bad" + i }, from("91.1.1.1")).then(x => { c[x.s] = (c[x.s] || 0) + 1; })));
  assert.deepEqual(c, { 401: 10, 429: 15 });
  assert.equal((await bot.call("POST", "/auth/login", { login: "erlan", password: "jailau-parol-7" }, from("91.2.2.2"))).s, 200, "чужие попытки не запирают хозяина");
  await bot.stop(); R.close();
});

test("тело запроса: буква на границе пакетов, пустое, не объект, слишком большое", { timeout: 30000 }, async () => {
  const R = await fakeRedis(), bot = await startBot(R.port);
  const body = Buffer.from(JSON.stringify({ name: "Айгуль", login: "aigul2", password: "long-password-1" })), cut = body.indexOf(Buffer.from("Айгуль")) + 3;
  const out = await new Promise(res => { const s = net.connect(bot.port, "127.0.0.1"); let o = ""; s.on("data", d => o += d); s.on("end", () => res(o));
    s.write(`POST /auth/register HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n`); s.write(body.subarray(0, cut)); setTimeout(() => s.write(body.subarray(cut)), 60); });
  assert.match(out, /"name":"Айгуль"/);
  for (const u of ["/auth/login", "/api/ai", "/api/kelisim"]) assert.equal((await bot.call("POST", u, null)).s, 400, u);
  assert.equal((await bot.call("POST", "/auth/login", { a: "x".repeat(300 * 1024) })).s, 413);
  assert.equal((await bot.call("GET", "//")).s, 500, "кривой адрес не роняет сервер");
  assert.equal((await bot.call("POST", "/auth/login", { login: "a", password: "b" })).s, 401);
  await bot.stop(); R.close();
});

test("бот: невозможное поголовье, одно стадо на человека, лимит ИИ, удаление аккаунта со всеми следами", { timeout: 60000 }, async () => {
  const R = await fakeRedis(), bot = await startBot(R.port), herds = async (la, lo) => (await bot.call("GET", `/api/village?lat=${la}&lon=${lo}`)).d.herds;
  await bot.say(777, "/start v_54775_69098"); await sleep(400);
  await bot.say(777, "99999999 овец"); await sleep(400);
  assert.deepEqual(await herds(54.775, 69.098), [], "невозможное число не записано");
  await bot.say(777, "100 овец"); await sleep(400);
  assert.equal((await herds(54.775, 69.098))[0].sheep, 100);
  await bot.say(777, "/start v_43020_79220"); await sleep(400);
  assert.equal((await herds(54.775, 69.098)).length, 1, "посмотреть другое село — не переезд");
  await bot.say(777, "50 овец"); await sleep(400);
  assert.deepEqual([(await herds(54.775, 69.098)).length, (await herds(43.02, 79.22)).length], [0, 1], "стадо переехало, а не размножилось");
  for (let i = 0; i < 15; i++) bot.say(777, "какая трава у села, как думаешь " + i);
  await sleep(2500);
  assert.equal((bot.log.match(/AI-CALL/g) || []).length, 6, "не больше 6 вопросов в минуту из одного чата");
  const { nonce } = (await bot.call("POST", "/auth/start", {})).d;
  await bot.tg({ callback_query: { id: "1", from: { id: 777, first_name: "Ш" }, data: "lg:" + nonce, message: { chat: { id: 777 } } } }); await sleep(400);
  const token = (await bot.call("GET", "/auth/poll?nonce=" + nonce)).d.token, h = { authorization: "Bearer " + token };
  assert.equal((await bot.call("POST", "/api/history", { village: { lat: 50, lon: 70, name: "x" }, summary: { overloaded_before: "<img src=x>", overloaded_after: 2, junk: "я".repeat(3000), status: "feasible" } }, h)).s, 200, "длинная сводка — не ошибка");
  const hist = (await bot.call("GET", "/api/history", undefined, h)).d[0].summary;
  assert.deepEqual([hist.overloaded_before, hist.overloaded_after, hist.junk, hist.status], [undefined, 2, undefined, "feasible"], "в сводке только известные поля");
  assert.equal((await bot.call("DELETE", "/api/me", undefined, h)).s, 200);
  await sleep(600);
  const s = JSON.parse(R.db.get("jaiylym:state"));
  assert.equal(s.chats["777"], undefined); assert.equal(s.users["777"], undefined);
  assert.deepEqual(await herds(43.02, 79.22), []);
  await bot.stop(); R.close();
});
