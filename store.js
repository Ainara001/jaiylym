/*
 * Хранилище состояния бота: выбранные сёла, стада, посчитанные участки.
 *  - REDIS_URL задан (Render Key Value) → храним там: переживает засыпание и перезапуск сервера.
 *  - иначе → файл bot_state.json рядом с ботом (для запуска на своём компьютере).
 * Мини-клиент Redis (протокол RESP) без внешних библиотек: нужны только GET и SET.
 */
const fs = require("fs");
const net = require("net");
const tls = require("tls");

const KEY = "jaiylym:state";

function redisClient(url, { timeoutMs = 10000 } = {}) {
  const u = new URL(url);
  let cur = null;                                  // текущее соединение: { sock, buf, queue, ready }

  // Всё состояние — внутри соединения: после обрыва недочитанный ответ и события старого сокета не попадают в новое,
  // иначе ответы сдвинулись бы на чужие запросы.
  function connect() {
    if (cur) return cur;
    const c = { buf: Buffer.alloc(0), queue: [], dead: false };
    cur = c;
    const opts = { host: u.hostname, port: +u.port || 6379 };
    const open = new Promise((resolve, reject) => {
      c.fail = e => {
        if (c.dead) return;
        c.dead = true;
        if (cur === c) cur = null;
        const err = e || new Error("Redis закрыл соединение");
        c.queue.splice(0).forEach(q => { clearTimeout(q.timer); q.reject(err); });
        reject(err);
        c.sock.destroy();
      };
      c.sock = u.protocol === "rediss:" ? tls.connect(opts, resolve) : net.connect(opts, resolve);
      c.sock.setKeepAlive(true, 30000);
      c.sock.on("data", d => { if (c.dead) return; c.buf = Buffer.concat([c.buf, d]); try { drain(c); } catch (e) { c.fail(e); } });
      c.sock.on("error", c.fail);
      c.sock.on("close", () => c.fail());
      const t = setTimeout(() => c.fail(new Error("Redis не ответил при подключении")), timeoutMs);
      const off = () => clearTimeout(t);
      c.sock.once("connect", off); c.sock.once("close", off);
    });
    c.ready = open.then(async () => {
      if (u.password) await command(c, u.username ? ["AUTH", decodeURIComponent(u.username), decodeURIComponent(u.password)] : ["AUTH", decodeURIComponent(u.password)]);
    });
    c.ready.catch(e => c.fail(e));                 // не прошла авторизация — следующий запрос подключится заново
    return c;
  }

  // разбор одного ответа RESP; возвращает [значение, длина] или null, если данных пока мало
  function parse(b) {
    const nl = b.indexOf("\r\n");
    if (nl < 0) return null;
    const type = String.fromCharCode(b[0]), line = b.toString("utf8", 1, nl);
    if (type === "+") return [line, nl + 2];
    if (type === "-") return [new Error(line), nl + 2];
    if (type === ":") return [+line, nl + 2];
    if (type === "$") {
      const len = +line;
      if (len < 0) return [null, nl + 2];
      if (b.length < nl + 2 + len + 2) return null;
      return [b.toString("utf8", nl + 2, nl + 2 + len), nl + 2 + len + 2];
    }
    throw new Error("Неожиданный ответ Redis: " + type);
  }

  function drain(c) {
    for (;;) {
      if (!c.queue.length) return;
      const r = parse(c.buf);
      if (!r) return;
      c.buf = c.buf.subarray(r[1]);
      const q = c.queue.shift();
      clearTimeout(q.timer);
      r[0] instanceof Error ? q.reject(r[0]) : q.resolve(r[0]);
    }
  }

  function command(c, args) {
    return new Promise((resolve, reject) => {
      if (c.dead) return reject(new Error("Redis закрыл соединение"));
      const parts = args.map(a => Buffer.from(String(a), "utf8"));
      const body = parts.map(p => Buffer.concat([Buffer.from(`$${p.length}\r\n`), p, Buffer.from("\r\n")]));
      // молчащее соединение (ответа нет) — закрываем: очередь ответов больше не сопоставить с запросами
      const timer = setTimeout(() => c.fail(new Error("Redis не ответил вовремя")), timeoutMs);
      c.queue.push({ resolve, reject, timer });
      c.sock.write(Buffer.concat([Buffer.from(`*${parts.length}\r\n`), ...body]));
    });
  }
  const send = args => { const c = connect(); return c.ready.then(() => command(c, args)); };

  return {
    get: k => send(["GET", k]),
    set: (k, v, ttlSec) => send(ttlSec ? ["SET", k, v, "EX", Math.ceil(ttlSec)] : ["SET", k, v]),
    del: k => send(["DEL", k]),
    close: () => { if (cur) cur.sock.destroy(); },
  };
}

function createStore() {
  const url = process.env.REDIS_URL;
  if (url) {
    const r = redisClient(url);
    return {
      kind: "Key Value (Redis)",
      load: async () => { const s = await r.get(KEY); return s ? JSON.parse(s) : null; },
      save: async obj => { await r.set(KEY, JSON.stringify(obj)); },
      // короткоживущие записи (коды входа, сессии): значение JSON, срок жизни в секундах
      kv: {
        get: async k => { const s = await r.get("jaiylym:" + k); return s == null ? null : JSON.parse(s); },
        set: (k, v, ttlSec) => r.set("jaiylym:" + k, JSON.stringify(v), ttlSec),
        del: k => r.del("jaiylym:" + k),
      },
    };
  }
  const file = process.env.BOT_STATE_FILE || require("path").join(__dirname, "bot_state.json");
  return {
    kind: "файл bot_state.json",
    // файла нет — начинаем с нуля; файл есть, но не читается — ошибка, иначе первая запись стёрла бы данные
    load: async () => { let x; try { x = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } return JSON.parse(x); },
    save: async obj => { fs.writeFileSync(file + ".tmp", JSON.stringify(obj)); fs.renameSync(file + ".tmp", file); },
    kv: memoryKv(),   // на своём компьютере сессии живут до перезапуска
  };
}

function memoryKv() {
  const m = new Map();
  return {
    get: async k => { const e = m.get(k); if (!e) return null; if (e.exp && e.exp < Date.now()) { m.delete(k); return null; } return JSON.parse(e.v); },
    set: async (k, v, ttlSec) => { m.set(k, { v: JSON.stringify(v), exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 }); },
    del: async k => { m.delete(k); },
  };
}

module.exports = { createStore, redisClient, memoryKv };
