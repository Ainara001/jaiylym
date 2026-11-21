/*
 * Jaiylym — Telegram-бот для пастуха (@JAIYLYM_bot).
 *
 * 1. Пастух выбирает СВОЁ село или город: пишет название или отправляет геолокацию.
 *    Бот сам считает пастбища по спутнику Sentinel-2 (≈10 секунд, без ключей).
 * 2. Пишет, сколько у него скота: «500 овец 30 коров 10 лошадей».
 * 3. Получает: «Сегодня» — где пасти, «План» — маршрут на сезон, «Карта села»,
 *    «Водопой» — куда акимату ставить воду, «📍 Где я?» — на каком он участке.
 * 4. Любой другой вопрос — отвечает Gemini по данным его села (если задан GEMINI_API_KEY).
 *
 * Запуск: заполнить .env (TELEGRAM_TOKEN=..., GEMINI_API_KEY=...) и  node bot.js
 * Проверка без Telegram:  node bot.js --test
 */
const fs = require("fs");
const path = require("path");
try { process.loadEnvFile(path.join(__dirname, ".env")); } catch (_) {}

const J = require("./web/engine.js");
const PL = require("./web/pipeline.js");
const { loadPlots, loadHerds } = require("./data");

const SITE = process.env.SITE_URL || "https://ainara001.github.io/jaiylym/";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const UA = "Jaiylym-hackathon-bot/1.0 (+https://github.com/Ainara001/jaiylym)";
PL.setUserAgent(UA);

// ---------- состояние (Render Key Value или файл — см. store.js) ----------
const store = require("./store").createStore();
let TEST = false;
let state = { chats: {}, villages: {} };
let saveTimer = null;
const save = () => {
  if (TEST) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.save(persistable()).catch(e => console.error("Не сохранилось:", e.message)), 300);
};
// Данные и демо-стада Кегена не храним — они всегда берутся из web/data
function persistable() {
  const villages = {};
  for (const [k, v] of Object.entries(state.villages)) villages[k] = v.demo ? { herds: v.herds || [] } : v;
  return { chats: state.chats, villages };
}

const KEGEN = loadPlots();
const vkey = (lat, lon) => `${(+lat).toFixed(3)},${(+lon).toFixed(3)}`;
const KEGEN_KEY = vkey(KEGEN.village.lat, KEGEN.village.lon);
function attachKegen() {
  state.villages[KEGEN_KEY] = Object.assign({ herds: [] }, state.villages[KEGEN_KEY] || {}, { data: KEGEN, demo: loadHerds() });
}
async function loadState() {
  try { const s = await store.load(); if (s) state = Object.assign({ chats: {}, villages: {} }, s); }
  catch (e) { console.error("Хранилище недоступно, работаю без него:", e.message); }
  attachKegen();
}
attachKegen();

const chatOf = id => (state.chats[id] = state.chats[id] || {});
const villageOf = c => c.village && state.villages[c.village];
const herdsOf = v => (v.demo || []).concat(v.herds || []);
const fmt = n => Math.round(n).toLocaleString("ru-RU");
const pct = x => (isFinite(x) ? Math.round(x * 100) + "%" : "∞");
const plural = (n, a, b, c) => n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c;
const where = p => `${p.id} (${p.ring === "near" ? "ближний" : "дальний"}, ~${p.dist_km} км на ${p.dir} от села)`;
const siteLink = v => `${SITE}#lat=${v.data.village.lat}&lon=${v.data.village.lon}&name=${encodeURIComponent(v.data.village.name)}`;

const MENU = {
  keyboard: [[{ text: "Сегодня" }, { text: "План" }], [{ text: "Карта села" }, { text: "Водопой" }],
             [{ text: "📍 Где я?", request_location: true }, { text: "Сменить село" }]],
  resize_keyboard: true,
};
const ASK_VILLAGE = {
  keyboard: [[{ text: "📍 Отправить геолокацию села", request_location: true }]],
  resize_keyboard: true, one_time_keyboard: true,
};

// ---------- разбор текста ----------
function parseHerd(text) {
  const t = text.toLowerCase().replace(/ё/g, "е");
  const grab = re => { const m = t.match(re); return m ? +m[1] : 0; };
  const h = {
    sheep: grab(/(\d+)\s*(овц|овец|овеч|баран|кой|қой)/),
    goats: grab(/(\d+)\s*(коз|ешкі|ешки)/),
    cattle: grab(/(\d+)\s*(коров|крс|бык|телят|сиыр)/),
    horses: grab(/(\d+)\s*(лошад|кон[ье]й|конь|жылқы|жылкы)/),
  };
  if (h.sheep + h.goats + h.cattle + h.horses === 0) return null;
  h.daily_return = /дойн|сауын/.test(t);
  return h;
}

function pointInPoly([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------- расчёты ----------
function compute(v) {
  const herds = herdsOf(v), plots = v.data.plots;
  return { herds, plots, byId: Object.fromEntries(plots.map(p => [p.id, p])), cur: J.current(plots, herds), pl: J.plan(plots, herds) };
}

async function ensureVillage(name, lat, lon, say) {
  const key = vkey(lat, lon);
  if (state.villages[key]) return key;
  await say(`Считаю пастбища «${name}» по снимкам Sentinel-2… это ~10–20 секунд.`);
  const res = await PL.buildVillage({ name, lat, lon });
  delete res.grid;
  state.villages[key] = { data: res, herds: [] };
  save();
  return key;
}

async function reverseName(lat, lon) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=14&accept-language=ru&lat=${lat}&lon=${lon}`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
    const d = await r.json();
    const a = d.address || {};
    return a.village || a.town || a.city || a.hamlet || a.municipality || d.name || `Точка ${(+lat).toFixed(3)}, ${(+lon).toFixed(3)}`;
  } catch (_) { return `Точка ${(+lat).toFixed(3)}, ${(+lon).toFixed(3)}`; }
}

// ---------- тексты ----------
function villageSummary(v) {
  const d = v.data, past = d.plots.reduce((s, p) => s + p.pasture_ha, 0);
  const best = d.plots.filter(p => p.ndvi != null).sort((a, b) => b.ndvi - a.ndvi)[0];
  return `📡 ${d.village.name}: ${fmt(past)} га пастбищ в радиусе 8 км (снимки лета ${d.source.year}, ${d.source.dates.length} безоблачных дней).\n` +
    (best ? `Лучшая трава — участок ${where(best)}, NDVI ${best.ndvi}.` : "");
}

function textToday(v, herd, day) {
  const { pl, byId } = compute(v);
  const P = J.params();
  let note = "";
  if (day < 1 || day > P.season_days) {
    note = `Сейчас не пастбищный сезон (с 1 мая, ${P.season_days} дней). Показываю день 60 как пример. Напишите «день 90», чтобы посмотреть другой.\n\n`;
    day = 60;
  }
  const plan = pl.herdPlans[herd.id];
  const seg = J.plotOnDay(plan, day);
  if (!seg || !seg.plot) return note + `День ${day}: корма для стада по плану не хватает. Нужен водопой на дальнем участке или сено — нажмите «Водопой».`;
  const p = byId[seg.plot], c = J.plotCapacity(p), next = plan[plan.indexOf(seg) + 1];
  return note + `🐑 ${herd.name}, день сезона ${day}\n\n` +
    `Пасти на участке ${where(p)}.\n` +
    `Трава (NDVI): ${p.ndvi ?? "нет данных"} · участок выдержит ≈ ${fmt(c.au_season / 0.2)} овец за сезон.\n` +
    `Нагрузка по плану: ${pct(pl.load[p.id].load)}. Вода: ${p.water_source}.\n\n` +
    (next ? `Через ${seg.to - day + 1} дн. — перегон на ${next.plot ? where(byId[next.plot]) : "— (корма не хватает)"}.` : "До конца сезона здесь.");
}

function textPlan(v, herd) {
  const { pl, byId } = compute(v);
  const lines = pl.herdPlans[herd.id].map(s => `• дни ${s.from}–${s.to}: ${s.plot ? where(byId[s.plot]) : "корма не хватает ⚠️"}`);
  return `Маршрут на сезон — ${herd.name} (${fmt(J.herdAU(herd))} усл. голов):\n\n${lines.join("\n")}\n\n` +
    `Правило: ни один участок не загружен больше 100%. Ближние участки — дойному скоту и на отдых.`;
}

function textMap(v) {
  const { cur, pl, plots, herds } = compute(v);
  const worst = plots.filter(p => cur.load[p.id].load > 1).sort((a, b) => cur.load[b.id].load - cur.load[a.id].load);
  const n = cur.overloaded;
  return villageSummary(v) + `\n\nСтад в расчёте: ${herds.length}${v.demo ? " (вместе с демо-стадами)" : ""}.\n` +
    `Если все пасут у села: перегружено ${n} ${plural(n, "участок", "участка", "участков")}` +
    (worst.length ? ` — ${worst.slice(0, 4).map(p => `${p.id} ${pct(cur.load[p.id].load)}`).join(", ")}` : "") +
    `, сверх нормы ≈ ${fmt(J.hayTonnes(cur.deficit_kg))} т сена.\n` +
    `По плану Jaiylym: перегружено ${pl.overloaded}, не хватает ${fmt(J.hayTonnes(pl.deficit_kg))} т.\n\nКарта: ${siteLink(v)}`;
}

function textWells(v) {
  const { byId, plots } = compute(v);
  const ws = J.wells(plots).slice(0, 4);
  if (!ws.length) return "Все дальние участки уже с водой.";
  return `Где новый водопой откроет больше всего корма:\n\n` +
    ws.map((w, i) => `${i + 1}. ${where(byId[w.plot])} — ≈ ${fmt(w.sheep)} овец на сезон`).join("\n") +
    `\n\nМы не строим водопои. Мы показываем акимату, куда вложить деньги, чтобы открыть дальние пастбища.`;
}

// ---------- Gemini: свободные вопросы ----------
async function askGemini(question, v, herd) {
  if (!GEMINI_KEY) return null;
  const ctx = { село: v.data.village.name, лето: v.data.source.year };
  try {
    const { pl, cur } = compute(v);
    ctx.участки = v.data.plots.map(p => ({ id: p.id, кольцо: p.ring === "near" ? "ближний" : "дальний", км: p.dist_km, направление: p.dir,
      пастбище_га: p.pasture_ha, ndvi: p.ndvi, вода: p.water_source, нагрузка_сейчас: pct(cur.load[p.id].load), нагрузка_план: pct(pl.load[p.id].load) }));
    if (herd) ctx.стадо = { имя: herd.name, овцы: herd.sheep, козы: herd.goats, крс: herd.cattle, лошади: herd.horses, маршрут: pl.herdPlans[herd.id] };
  } catch (_) {}
  const prompt = `Ты — помощник пастуха в приложении Jaiylym (Казахстан). Отвечай коротко (до 6 предложений), просто, ` +
    `на языке вопроса (русский или казахский). Опирайся только на данные ниже и общие знания о выпасе. ` +
    `Не выдумывай цифры. Если вопрос не про пастбища и скот — вежливо скажи, что помогаешь только с пастбищами.\n\n` +
    `Данные села (JSON): ${JSON.stringify(ctx)}\n\nВопрос пастуха: ${question}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
      });
      const d = await r.json();
      const text = d?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
      if (text) return text;
      if (r.status !== 503 && r.status !== 429) { console.error("Gemini:", r.status, d?.error?.message); return null; }
    } catch (e) { console.error("Gemini:", e.message); return null; }   // тайм-аут — не повторяем
    await new Promise(res => setTimeout(res, 2000));
  }
  return null;
}

// ---------- обработка сообщений ----------
async function handle(update, send, today = new Date()) {
  if (update.callback_query) {
    const cq = update.callback_query, chatId = cq.message.chat.id, c = chatOf(chatId);
    const [kind, arg] = (cq.data || "").split(":");
    if (kind === "pick" && c.pending && c.pending[+arg]) {
      const f = c.pending[+arg]; c.pending = null;
      return chooseVillage(chatId, f.name, f.lat, f.lon, send);
    }
    if (kind === "herd") {
      const v = villageOf(c), herd = v && herdsOf(v).find(h => h.id === arg);
      if (herd) { c.herd = herd.id; save(); return send(chatId, `Готово: вы пастух стада «${herd.name}». Нажмите «Сегодня».`, MENU); }
    }
    return;
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id, c = chatOf(chatId);
  const text = (msg.text || "").trim(), low = text.toLowerCase();
  const v = villageOf(c);

  if (low.startsWith("/start") || low === "сменить село" || low === "/selo") {
    c.village = null; c.herd = null; save();
    return send(chatId, `Сәлем! Это Jaiylym — помощник по пастбищам.\n\n` +
      `Я смотрю на траву со спутника и подсказываю, где пасти, чтобы не вытоптать пастбища у села.\n\n` +
      `Напишите название вашего села или города (например: Кеген, Шелек, Жанаарка) или отправьте геолокацию.`, ASK_VILLAGE);
  }

  if (msg.location) {
    const { latitude: lat, longitude: lon } = msg.location;
    if (!v) return chooseVillage(chatId, await reverseName(lat, lon), lat, lon, send);
    const p = v.data.plots.find(pp => pointInPoly([lon, lat], pp.geometry.coordinates[0]));
    if (!p) return send(chatId, `Вы вне пастбищ села ${v.data.village.name} (или в самом селе). Если это другое село — нажмите «Сменить село».`, MENU);
    const { pl } = compute(v), herd = herdsOf(v).find(h => h.id === c.herd);
    let s = `Вы на участке ${where(p)}.\nНагрузка по плану: ${pct(pl.load[p.id].load)}. Трава (NDVI): ${p.ndvi ?? "нет данных"}.`;
    if (herd) {
      const seg = J.plotOnDay(pl.herdPlans[herd.id], J.seasonDay(today));
      if (seg && seg.plot && seg.plot !== p.id) s += `\n\n⚠️ По плану стадо «${herd.name}» сегодня должно быть на ${seg.plot}.`;
      else if (seg && seg.plot === p.id) s += `\n\n✅ Вы там, где нужно по плану.`;
    }
    return send(chatId, s, MENU);
  }

  if (!v) {                                         // село ещё не выбрано: текст = название
    if (!text) return;
    let found;
    try { found = await PL.geocode(text); } catch (e) { return send(chatId, "Поиск места сейчас недоступен, попробуйте через минуту или отправьте геолокацию.", ASK_VILLAGE); }
    if (!found.length) return send(chatId, `Не нашёл «${text}». Попробуйте написать по-русски или отправьте геолокацию.`, ASK_VILLAGE);
    if (found.length === 1) return chooseVillage(chatId, found[0].name, found[0].lat, found[0].lon, send);
    c.pending = found.slice(0, 5); save();
    return send(chatId, "Какое из этих мест?", {
      inline_keyboard: c.pending.map((f, i) => [{ text: f.full.slice(0, 60), callback_data: "pick:" + i }]),
    });
  }

  const parsed = parseHerd(text);
  if (parsed && !/^день/.test(low)) {
    const id = "tg" + chatId;
    const name = msg.from && msg.from.first_name ? msg.from.first_name : "Моё стадо";
    v.herds = (v.herds || []).filter(h => h.id !== id);
    const home = v.data.plots.filter(p => p.ring === "near").sort((a, b) => (b.pasture_ha || 0) - (a.pasture_ha || 0))[0].id;
    const herd = Object.assign({ id, name, home }, parsed);
    v.herds.push(herd);
    c.herd = id; save();
    return send(chatId, `Записал: ${parsed.sheep} овец, ${parsed.goats} коз, ${parsed.cattle} КРС, ${parsed.horses} лошадей` +
      `${parsed.daily_return ? " (дойные, каждый вечер в село)" : ""} = ${fmt(J.herdAU(herd))} условных голов.\n\n` + textPlan(v, herd), MENU);
  }

  if (low === "карта села" || low === "/map") return send(chatId, textMap(v), MENU);
  if (low === "водопой" || low === "/water") return send(chatId, textWells(v), MENU);

  const herd = herdsOf(v).find(h => h.id === c.herd);
  const dm = low.match(/^(?:\/today|сегодня|день)\s*(\d+)?$/);
  if ((dm || low === "план" || low === "/plan") && !herd) return askHerd(chatId, v, send);
  if (dm) return send(chatId, textToday(v, herd, dm[1] ? +dm[1] : J.seasonDay(today)), MENU);
  if (low === "план" || low === "/plan") return send(chatId, textPlan(v, herd), MENU);

  // всё остальное — вопрос к Gemini
  const isQuestion = text.includes("?") || text.split(/\s+/).length >= 4;
  if (isQuestion && GEMINI_KEY) await send(chatId, "Думаю над ответом… 🤔");
  const answer = await askGemini(text, v, herd);
  if (answer) return send(chatId, answer, MENU);
  return send(chatId, (isQuestion && GEMINI_KEY ? "ИИ-помощник сейчас перегружен, спросите чуть позже. " : "Не понял. ") +
    "Кнопки внизу: «Сегодня», «План», «Карта села», «Водопой». " +
    "Чтобы записать стадо, напишите, например: «500 овец 30 коров 10 лошадей».", MENU);
}

async function chooseVillage(chatId, name, lat, lon, send) {
  const c = chatOf(chatId);
  try {
    c.village = await ensureVillage(name, lat, lon, t => send(chatId, t));
  } catch (e) {
    return send(chatId, `Не получилось посчитать это место: ${e.message}. Попробуйте ещё раз или другое село.`, ASK_VILLAGE);
  }
  c.herd = null; save();
  const v = villageOf(c);
  await send(chatId, villageSummary(v) + `\n\nКарта: ${siteLink(v)}`, MENU);
  return askHerd(chatId, v, send);
}

function askHerd(chatId, v, send) {
  const demo = v.demo || [];
  return send(chatId, `Сколько у вас скота? Напишите, например: «500 овец 30 коров 10 лошадей» (для дойных коров добавьте слово «дойные»).` +
    (demo.length ? `\nИли выберите демо-стадо:` : ""),
    demo.length ? { inline_keyboard: demo.map(h => [{ text: `${h.name} — ${fmt(J.herdAU(h))} УГ`, callback_data: "herd:" + h.id }]) } : MENU);
}

// ---------- Telegram ----------
// На сервере (Render) — webhook: Telegram сам присылает сообщения и «будит» уснувший сервер.
// На своём компьютере — long polling: бот сам спрашивает Telegram о новых сообщениях.
const PUBLIC_URL = process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || "";

async function run(token) {
  const api = (m, body) => fetch(`https://api.telegram.org/bot${token}/${m}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(m === "getUpdates" ? 40000 : 20000),
  }).then(r => r.json());
  const me = await api("getMe");
  if (!me.ok) { console.error("Токен не подошёл:", me.description); process.exit(1); }
  await loadState();
  await api("setMyCommands", { commands: [
    { command: "start", description: "Выбрать село" }, { command: "today", description: "Где пасти сегодня" },
    { command: "plan", description: "Маршрут на сезон" }, { command: "map", description: "Карта села" },
    { command: "water", description: "Где нужен водопой" },
  ] });
  const send = (chat_id, text, reply_markup) => api("sendMessage", { chat_id, text, reply_markup, disable_web_page_preview: true });
  const onUpdate = u => {
    if (u.callback_query) api("answerCallbackQuery", { callback_query_id: u.callback_query.id }).catch(() => {});
    const chat = u.message?.chat.id ?? u.callback_query?.message.chat.id;
    if (chat == null) return;
    api("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});
    handle(u, send).catch(e => { console.error("Ошибка:", e); send(chat, "Что-то пошло не так, попробуйте ещё раз.").catch(() => {}); });
  };
  const info = `Бот @${me.result.username}. Хранилище: ${store.kind}. Gemini: ${GEMINI_KEY ? GEMINI_MODEL : "выключен"}.`;

  if (PUBLIC_URL) return serve(token, api, onUpdate, info);

  await api("deleteWebhook");   // иначе Telegram не отдаёт сообщения через getUpdates
  console.log(info + " Режим: long polling.");
  let offset = 0;
  for (;;) {
    try {
      const r = await api("getUpdates", { offset, timeout: 30 });
      if (!r.ok) { console.error("getUpdates:", r.description); await new Promise(res => setTimeout(res, 5000)); continue; }
      for (const u of r.result) { offset = u.update_id + 1; onUpdate(u); }
    } catch (e) { console.error("Сеть, повтор через 3 с:", e.message); await new Promise(res => setTimeout(res, 3000)); }
  }
}

function serve(token, api, onUpdate, info) {
  const http = require("http");
  const secret = require("crypto").createHash("sha256").update(token).digest("hex").slice(0, 32);
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/tg") {
      if (req.headers["x-telegram-bot-api-secret-token"] !== secret) { res.writeHead(401).end(); return; }
      let body = "";
      req.on("data", c => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on("end", () => {
        res.writeHead(200).end("ok");               // отвечаем сразу, считаем потом
        try { onUpdate(JSON.parse(body)); } catch (e) { console.error("Плохое обновление:", e.message); }
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Jaiylym bot работает. Telegram: @" + "JAIYLYM_bot");
  });
  const port = +process.env.PORT || 10000;
  server.listen(port, async () => {
    console.log(info + ` Режим: webhook, порт ${port}.`);
    if (process.env.SKIP_SET_WEBHOOK) return;
    const url = PUBLIC_URL.replace(/\/$/, "") + "/tg";
    const r = await api("setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"] });
    console.log("setWebhook", url, r.ok ? "OK" : r.description);
  });
  return server;
}

// ---------- проверка без Telegram ----------
async function test() {
  TEST = true; state.chats = {};
  const send = async (chat, text, kb) => {
    console.log("🤖 " + text + (kb?.inline_keyboard ? "\n   [" + kb.inline_keyboard.map(r => r[0].text).join(" | ") + "]" : ""));
  };
  const say = async (text, extra = {}) => {
    console.log(`\n👤 ${text || JSON.stringify(extra)}`);
    await handle({ message: Object.assign({ chat: { id: 1 }, from: { first_name: "Тест" }, text }, extra) }, send, new Date(2026, 6, 15));
  };
  const tap = async data => { console.log(`\n👤 [кнопка ${data}]`); await handle({ callback_query: { id: "x", data, message: { chat: { id: 1 } } } }, send); };
  await say("/start");
  await say("Шелек");
  if (chatOf(1).pending) await tap("pick:0");
  await say("Сегодня");
  await say("600 овец 20 коров 10 лошадей");
  await say("Сегодня");
  await say("Карта села");
  await say("Водопой");
  await say("Сменить село");
  await say("", { location: { latitude: 43.02, longitude: 79.22 } });
  await tap("herd:asan");
  await say("", { location: { latitude: 43.06, longitude: 79.22 } });
  await say("Почему мне нельзя пасти рядом с селом?");
}

if (require.main === module) {
  if (process.argv.includes("--test")) test().catch(e => { console.error(e); process.exit(1); });
  else if (process.env.TELEGRAM_TOKEN) run(process.env.TELEGRAM_TOKEN);
  else { console.log("Нужен TELEGRAM_TOKEN в .env (или проверка: node bot.js --test)"); process.exit(1); }
}

module.exports = { handle, parseHerd };
