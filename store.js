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

function redisClient(url) {
  const u = new URL(url);
  let sock = null, buf = Buffer.alloc(0), queue = [], ready = null;

  function connect() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const opts = { host: u.hostname, port: +u.port || 6379 };
      sock = u.protocol === "rediss:" ? tls.connect(opts, resolve) : net.connect(opts, resolve);
      sock.on("data", d => { buf = Buffer.concat([buf, d]); drain(); });
      const fail = e => { ready = null; sock = null; queue.splice(0).forEach(q => q.reject(e || new Error("Redis закрыл соединение"))); reject(e); };
      sock.on("error", fail);
      sock.on("close", () => fail());
    }).then(async () => {
      if (u.password) await send(u.username ? ["AUTH", decodeURIComponent(u.username), decodeURIComponent(u.password)] : ["AUTH", decodeURIComponent(u.password)], true);
    });
    ready.catch(() => {});
    return ready;
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

  function drain() {
    for (;;) {
      if (!queue.length) return;
      const r = parse(buf);
      if (!r) return;
      buf = buf.subarray(r[1]);
      const q = queue.shift();
      r[0] instanceof Error ? q.reject(r[0]) : q.resolve(r[0]);
    }
  }

  function send(args, raw) {
    const go = () => new Promise((resolve, reject) => {
      const parts = args.map(a => Buffer.from(String(a), "utf8"));
      const head = `*${parts.length}\r\n`;
      const body = parts.map(p => Buffer.concat([Buffer.from(`$${p.length}\r\n`), p, Buffer.from("\r\n")]));
      queue.push({ resolve, reject });
      sock.write(Buffer.concat([Buffer.from(head), ...body]));
    });
    return raw ? go() : connect().then(go);
  }

  return {
    get: k => send(["GET", k]),
    set: (k, v, ttlSec) => send(ttlSec ? ["SET", k, v, "EX", Math.ceil(ttlSec)] : ["SET", k, v]),
    del: k => send(["DEL", k]),
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
    load: async () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; } },
    save: async obj => { fs.writeFileSync(file, JSON.stringify(obj)); },
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
