/*
 * Jaiylym — Telegram-бот для пастуха (@JAIYLYM_bot).
 *
 * 1. Пастух выбирает СВОЁ село или город: пишет название или отправляет геолокацию.
 *    Бот сам считает пастбища по спутнику Sentinel-2 (≈10 секунд, без ключей).
 * 2. Пишет, сколько у него скота: «500 овец 30 коров 10 лошадей».
 * 3. Получает: «Сегодня» — где пасти, «План» — маршрут на сезон, «Карта села»,
 *    «Водопой» — куда акимату ставить воду, «Где я?» — на каком он участке.
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
  return { chats: state.chats, villages, users: state.users || {}, villagePlans: state.villagePlans || {} };
}

const KEGEN = loadPlots();
const vkey = (lat, lon) => `${(+lat).toFixed(3)},${(+lon).toFixed(3)}`;
const KEGEN_KEY = vkey(KEGEN.village.lat, KEGEN.village.lon);
function attachKegen() {
  state.villages[KEGEN_KEY] = Object.assign({ herds: [] }, state.villages[KEGEN_KEY] || {}, { data: KEGEN, demo: loadHerds() });
}
// ---------- API сайта (вход, профили, сценарии) — см. api.js ----------
const BOT_USERNAME = process.env.BOT_USERNAME || "JAIYLYM_bot";
const siteApi = require("./api").createApi({
  getState: () => state, save, kv: store.kv, vkey: (lat, lon) => vkey(lat, lon), botUsername: BOT_USERNAME,
  allowedOrigins: (process.env.SITE_ORIGINS || "https://ainara001.github.io,http://localhost:8765,http://127.0.0.1:8765").split(","),
  onFarmSaved: (uid, farm, oldVk) => syncFarmHerd(uid, farm, oldVk),
});

/** Стадо из профиля хозяйства на сайте = стадо этого же человека в боте (id чата Telegram = id пользователя). */
function syncFarmHerd(uid, farm, oldVk) {
  const id = "tg" + uid;
  if (oldVk && state.villages[oldVk]) state.villages[oldVk].herds = (state.villages[oldVk].herds || []).filter(h => h.id !== id);
  if (!farm) { save(); return; }
  const vk = vkey(farm.village.lat, farm.village.lon);
  const add = () => {
    const v = state.villages[vk]; if (!v) return;
    v.herds = (v.herds || []).filter(h => h.id !== id).concat([{ id, name: farm.name, sheep: farm.sheep, goats: farm.goats,
      cattle: farm.cattle, horses: farm.horses, home: farm.home, daily_return: farm.daily_return }]);
    const c = chatOf(uid); c.village = vk; c.herd = id;
    save();
  };
  if (state.villages[vk]) add();
  else ensureVillage(farm.village.name, farm.village.lat, farm.village.lon, async () => {}).then(add).catch(e => console.error("село для хозяйства:", e.message));
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
const siteLink = (v, plotId) => `${SITE}#lat=${v.data.village.lat}&lon=${v.data.village.lon}&name=${encodeURIComponent(v.data.village.name)}` +
  (plotId ? `&plot=${encodeURIComponent(plotId)}` : "");

const MENU = {
  keyboard: [[{ text: "Сегодня" }, { text: "План" }], [{ text: "Карта села" }, { text: "Водопой" }],
             [{ text: "Участки" }, { text: "Где я?", request_location: true }], [{ text: "Сменить село" }]],
  resize_keyboard: true,
};
const ASK_VILLAGE = {
  keyboard: [[{ text: "Отправить геолокацию села", request_location: true }]],
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
  return `${d.village.name}: ${fmt(past)} га пастбищ в радиусе 8 км (снимки лета ${d.source.year}, ${d.source.dates.length} безоблачных дней).\n` +
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
  return note + `${herd.name}, день сезона ${day}\n\n` +
    `Пасти на участке ${where(p)}.\n` +
    `Трава (NDVI): ${p.ndvi ?? "нет данных"} · участок выдержит ≈ ${fmt(c.au_season / 0.2)} овец за сезон.\n` +
    `Нагрузка по плану: ${pct(pl.load[p.id].load)}. Вода: ${p.water_source}.\n\n` +
    (next ? `Через ${seg.to - day + 1} дн. — перегон на ${next.plot ? where(byId[next.plot]) : "— (корма не хватает)"}.` : "До конца сезона здесь.");
}

function textPlan(v, herd) {
  const { pl, byId } = compute(v);
  const lines = pl.herdPlans[herd.id].map(s => `• дни ${s.from}–${s.to}: ${s.plot ? where(byId[s.plot]) : "корма не хватает (внимание)"}`);
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
  const system = "Ты — помощник пастуха в сервисе Jaiylym (Казахстан). Отвечай коротко (до 6 предложений), просто, на языке вопроса " +
    "(русский или казахский). Опирайся только на данные села и общие знания о выпасе. Не выдумывай цифры; ёмкость и нагрузка — оценки модели. " +
    "Если вопрос не про пастбища и скот — вежливо скажи, что помогаешь только с пастбищами.";
  const r = await require("./gemini").ask({ system, input: `Данные села (JSON): ${JSON.stringify(ctx)}\n\nВопрос пастуха: ${question}`, maxTokens: 500 });
  return r.ok ? r.text : null;
}

// ---------- подписки на участки ----------
// c.subs = ["43.020,79.220|Д-С", ...] — участки, о которых человек получает уведомления
const subKey = (vk, id) => vk + "|" + id;
const fmtDate = d => d.slice(8, 10) + "." + d.slice(5, 7);
const median = xs => { const a = xs.slice().sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const subscribers = (vk, id) => Object.entries(state.chats).filter(([, c]) => (c.subs || []).includes(subKey(vk, id))).map(([chat]) => chat);
const isSubbed = (c, vk, id) => (c.subs || []).includes(subKey(vk, id));
function toggleSub(c, vk, id, on) {
  c.subs = (c.subs || []).filter(k => k !== subKey(vk, id));
  if (on) c.subs.push(subKey(vk, id));
  c.subs = c.subs.slice(-12);
  save();
}
const ndviWord = x => x == null ? "нет данных" : x < 0.2 ? "травы мало" : x < 0.3 ? "средне" : "хорошо";

function plotLoadLine(v, id) {
  const { pl, herds } = compute(v);
  const l = pl.load[id];
  const names = l.herds.map(x => herds.find(h => h.id === x.herd)).filter(Boolean).length;
  return names ? `По плану Jaiylym здесь пасётся ${names} ${plural(names, "стадо", "стада", "стад")}, нагрузка ${pct(l.load)}.` : "По плану Jaiylym участок сейчас свободен.";
}

/** Отчёт по участку: как менялась трава за лето по снимкам. */
function plotReport(v, p) {
  const s = p.series || [];
  let text = `Участок ${where(p)}, ${v.data.village.name}\n\nПастбище ${fmt(p.pasture_ha)} га. Трава за лето ${v.data.source.year} (NDVI по снимкам Sentinel-2):\n`;
  if (s.length) {
    text += s.map(x => `${fmtDate(x.d)}  ${"▇".repeat(Math.max(1, Math.round(x.v * 20)))} ${x.v.toFixed(2)}`).join("\n");
    const ch = (s[s.length - 1].v - s[0].v) / s[0].v * 100;
    text += `\n\nЗа лето: ${ch >= 0 ? "+" : ""}${ch.toFixed(0)}% ${ch <= -10 ? "— трава убывает" : ch >= 10 ? "— растёт" : "≈ стабильно"}.`;
  } else text += `в среднем ${p.ndvi ?? "нет данных"}.`;
  text += `\nСейчас: ${ndviWord(p.ndvi)}. ${plotLoadLine(v, p.id)}\n\nНа карте: ${siteLink(v, p.id)}`;
  return text;
}

/** Текст уведомления о новом снимке. prev — прошлые значения NDVI этого участка. */
function alertText(v, p, cur, prev, date) {
  const base = prev.length ? median(prev.slice(-3)) : null;
  const delta = base == null ? null : cur - base;
  let head, advice;
  const rel = delta == null ? 0 : delta / base;
  if (delta != null && (delta <= -0.05 || rel <= -0.12)) {
    head = "Внимание: трава убывает";
    advice = "Если стадо там или скоро туда идёт — планируйте перегон заранее. Проверьте на месте: иногда снимок портит дымка.";
  } else if (cur < 0.2) { head = "Мало травы"; advice = "Долго пасти здесь не стоит."; }
  else if (delta != null && (delta >= 0.05 || rel >= 0.12)) { head = "Трава растёт"; advice = "Участок восстанавливается."; }
  else { head = "Свежий снимок"; advice = "Заметных изменений нет."; }
  return `${head} — участок ${p.id}, ${v.data.village.name}\n\n` +
    `Снимок Sentinel-2 от ${fmtDate(date)}: NDVI ${cur.toFixed(2)}` +
    (base != null ? ` (было ≈ ${base.toFixed(2)}, ${delta >= 0 ? "+" : ""}${(delta / base * 100).toFixed(0)}%)` : "") +
    `.\n${plotLoadLine(v, p.id)}\n${advice}\n\nКарта участка: ${siteLink(v, p.id)}`;
}

function plotsKeyboard(c, vk, v) {
  const rows = [];
  for (const ring of ["near", "far"]) {
    const ps = v.data.plots.filter(p => p.ring === ring);
    for (let i = 0; i < ps.length; i += 4)
      rows.push(ps.slice(i, i + 4).map(p => ({ text: (isSubbed(c, vk, p.id) ? "✓ " : "") + p.id, callback_data: "s:" + PL.plotCode(p.id) })));
  }
  return { inline_keyboard: rows };
}

function textMySubs(c) {
  const subs = (c.subs || []).filter(k => state.villages[k.split("|")[0]]);
  if (!subs.length) return { text: "Вы ещё не подписаны ни на один участок.", kb: null };
  return {
    text: "Ваши участки — с мая по сентябрь пришлю уведомление, когда спутник сделает новый снимок (≈ раз в 5–10 дней):",
    kb: { inline_keyboard: subs.map(k => {
      const [vk, id] = k.split("|"), code = PL.plotCode(id), name = state.villages[vk].data.village.name;
      return [{ text: `Отчёт ${id} · ${name}`, callback_data: `r:${vk}|${code}` }, { text: "Пример", callback_data: `d:${vk}|${code}` }, { text: "Отписаться", callback_data: `u:${vk}|${code}` }];
    }) },
  };
}

// ---------- свои пастбища: контур нарисован на сайте; владелец — тот же Telegram-аккаунт ----------
const ha1 = x => (+x || 0).toFixed(1).replace(".", ",");
const myPastures = chatId => (((state.users || {})[String(chatId)] || {}).pastures) || [];
function pastureCenter(q) {
  const r = q.geometry.coordinates[0];
  return [r.reduce((s, p) => s + p[1], 0) / r.length, r.reduce((s, p) => s + p[0], 0) / r.length];
}
function pastureLink(chatId, q) {
  const u = (state.users || {})[String(chatId)], v = u && u.farm && u.farm.village;
  const [lat, lon] = v ? [v.lat, v.lon] : pastureCenter(q);
  return `${SITE}#/map?lat=${(+lat).toFixed(5)}&lon=${(+lon).toFixed(5)}&name=${encodeURIComponent(v ? v.name : q.name)}&pasture=${q.id}`;
}
function pastureReport(chatId, q) {
  const s = q.stats || {}, series = s.series || [];
  const cap = J.plotCapacity({ ndvi: s.ndvi, pasture_ha: s.pasture_ha || 0 });
  let text = `Пастбище «${q.name}»: ${ha1(q.area_ha)} га (границы нарисованы вами на сайте).\n` +
    `Трава за лето ${s.year || ""} — NDVI по снимкам Sentinel-2 внутри границ:\n`;
  if (series.length) {
    text += series.map(x => `${fmtDate(x.d)}  ${"▇".repeat(Math.max(1, Math.round(x.v * 20)))} ${x.v.toFixed(2)}`).join("\n");
    const ch = (series[series.length - 1].v - series[0].v) / series[0].v * 100;
    text += `\n\nЗа лето: ${ch >= 0 ? "+" : ""}${ch.toFixed(0)}% ${ch <= -10 ? "— трава убывает" : ch >= 10 ? "— растёт" : "≈ стабильно"}.`;
  } else text += `в среднем ${s.ndvi ?? "нет данных"}.`;
  text += `\nСейчас: ${ndviWord(s.ndvi)}. Выдержит за сезон ≈ ${fmt(cap.au_season / 0.2)} овец (оценка модели). Вода: ${q.water ? "есть" : "не указана"}.`;
  return text + `\n\nНа карте: ${pastureLink(chatId, q)}`;
}
function pastureAlert(chatId, q, cur, prev, date) {
  const base = prev.length ? median(prev.slice(-3)) : null;
  const delta = base == null ? null : cur - base, rel = delta == null ? 0 : delta / base;
  const head = delta != null && (delta <= -0.05 || rel <= -0.12) ? "Внимание: трава убывает" : cur < 0.2 ? "Мало травы"
    : delta != null && (delta >= 0.05 || rel >= 0.12) ? "Трава растёт" : "Свежий снимок";
  const advice = head.startsWith("Внимание") ? "Если стадо там — планируйте перегон заранее. Проверьте на месте: иногда снимок портит дымка."
    : head === "Мало травы" ? "Долго пасти здесь не стоит." : head === "Трава растёт" ? "Участок восстанавливается." : "Заметных изменений нет.";
  return `${head} — ваше пастбище «${q.name}»\n\nСнимок Sentinel-2 от ${fmtDate(date)}: NDVI ${cur.toFixed(2)}` +
    (base != null ? ` (было ≈ ${base.toFixed(2)}, ${delta >= 0 ? "+" : ""}${(delta / base * 100).toFixed(0)}%)` : "") +
    `.\n${advice}\n\nНа карте: ${pastureLink(chatId, q)}`;
}
function pasturesKeyboard(c, chatId) {
  return { inline_keyboard: myPastures(chatId).map(q => [
    { text: `Отчёт: ${q.name}`.slice(0, 40), callback_data: "pr:" + q.id },
    { text: (c.psubs || []).includes(q.id) ? "Отписаться" : "Подписаться", callback_data: "pt:" + q.id }]) };
}

// ---------- ежедневная проверка (её запускает GitHub Actions через POST /cron) ----------
async function runCron(send, now = new Date()) {
  const month = now.getMonth() + 1, inSeason = month >= 5 && month <= 9;
  const report = { date: now.toISOString().slice(0, 10), season: inSeason, villages: 0, scenes: 0, alerts: 0, reminders: 0, errors: 0 };
  if (!inSeason) { report.note = "вне сезона (октябрь–апрель): снег, NDVI не проверяем"; return report; }

  // 1. новые снимки по участкам, на которые кто-то подписан
  const byVillage = {};
  for (const c of Object.values(state.chats)) for (const k of c.subs || []) {
    const [vk, id] = k.split("|"); (byVillage[vk] = byVillage[vk] || new Set()).add(id);
  }
  for (const [vk, ids] of Object.entries(byVillage)) {
    const v = state.villages[vk]; if (!v) continue;
    report.villages++;
    v.monitor = v.monitor || { last: null, hist: {} };
    let scene;
    try { scene = await PL.latestScene({ lat: v.data.village.lat, lon: v.data.village.lon, after: v.monitor.last, now }); }
    catch (e) { console.error("cron", vk, e.message); report.errors++; continue; }
    if (!scene) continue;
    report.scenes++;
    v.monitor.last = scene.date;
    for (const id of ids) {
      const m = scene.plots[id], p = v.data.plots.find(x => x.id === id);
      if (!m || !p || m.valid < 0.6 || m.ndvi == null) continue;          // облака закрыли участок
      // история: свои прошлые проверки, а в начале — снимки этого же лета из расчёта села
      const seed = v.data.source.year === now.getFullYear() ? (p.series || []).filter(x => x.d < scene.date) : [];
      const hist = v.monitor.hist[id] = v.monitor.hist[id] || seed.slice(-5);
      const text = alertText(v, p, m.ndvi, hist.map(h => h.v), scene.date);
      hist.push({ d: scene.date, v: m.ndvi }); v.monitor.hist[id] = hist.slice(-8);
      for (const chat of subscribers(vk, id)) { await send(chat, text, MENU); report.alerts++; }
    }
  }

  // 1б. свои пастбища, на которые подписан владелец
  for (const [chat, c] of Object.entries(state.chats)) {
    for (const id of c.psubs || []) {
      const q = myPastures(chat).find(x => x.id === id); if (!q) continue;
      q.monitor = q.monitor || { last: null, hist: null };
      let scene;
      try { scene = await PL.latestPolygonScene({ ring: q.geometry.coordinates[0], after: q.monitor.last, now }); }
      catch (e) { console.error("cron pasture", id, e.message); report.errors++; continue; }
      if (!scene) continue;
      report.scenes++;
      q.monitor.last = scene.date;
      if (scene.valid < 0.6 || scene.ndvi == null) continue;                 // облака закрыли участок
      const seed = q.stats && q.stats.year === now.getFullYear() ? (q.stats.series || []).filter(x => x.d < scene.date) : [];
      const hist = q.monitor.hist || seed.slice(-5);
      await send(chat, pastureAlert(chat, q, scene.ndvi, hist.map(h => h.v), scene.date), MENU);
      report.alerts++;
      q.monitor.hist = hist.concat([{ d: scene.date, v: scene.ndvi }]).slice(-8);
    }
  }

  // 2. напоминания о перегоне за 3 дня
  const day = J.seasonDay(now);
  for (const [chat, c] of Object.entries(state.chats)) {
    const v = villageOf(c); if (!v || !c.herd) continue;
    const herd = herdsOf(v).find(h => h.id === c.herd); if (!herd) continue;
    const plan = compute(v).pl.herdPlans[herd.id] || [];
    const i = plan.findIndex(s => s.from === day + 3);
    if (i <= 0 || c.reminded === report.date) continue;   // не чаще раза в день
    c.reminded = report.date;
    const to = plan[i], from = plan[i - 1], p = to.plot && v.data.plots.find(x => x.id === to.plot);
    await send(chat, `Через 3 дня по плану перегон стада «${herd.name}»: ${from.plot || "—"} → ` +
      (p ? `${where(p)}.\nТрава там: ${ndviWord(p.ndvi)} (NDVI ${p.ndvi}). ${p.water_source === "нет" ? "Воды нет — возьмите с собой." : "Вода: " + p.water_source + "."}` : "корма по плану не хватает — нужен водопой или сено.") +
      (p ? `\n\nКарта: ${siteLink(v, p.id)}` : ""), MENU);
    report.reminders++;
  }
  save();
  return report;
}

// ---------- обработка сообщений ----------
async function handle(update, send, today = new Date()) {
  if (update.callback_query) {
    const cq = update.callback_query, chatId = cq.message.chat.id, c = chatOf(chatId);
    const data = cq.data || "", kind = data.split(":")[0], arg = data.slice(kind.length + 1);
    if (kind === "lg" || kind === "ln") {
      const from = cq.from || { id: chatId };
      const ok = await siteApi.confirmLogin(arg, from, kind === "lg");
      if (!ok) return send(chatId, "Ссылка для входа устарела. Нажмите «Войти» на сайте ещё раз.", MENU);
      return send(chatId, kind === "lg" ? "Вход подтверждён. Вернитесь на сайт — он откроется сам через несколько секунд." : "Вход отменён.", MENU);
    }
    if (kind === "pick" && c.pending && c.pending[+arg]) {
      const f = c.pending[+arg]; c.pending = null;
      return chooseVillage(chatId, f.name, f.lat, f.lon, send);
    }
    if (kind === "herd") {
      const v = villageOf(c), herd = v && herdsOf(v).find(h => h.id === arg);
      if (herd) { c.herd = herd.id; save(); return send(chatId, `Готово: вы пастух стада «${herd.name}». Нажмите «Сегодня».`, subPlanButton()); }
    }
    if (kind === "s") {                                   // подписка/отписка на участок текущего села
      const v = villageOf(c), id = PL.plotFromCode(arg);
      if (!v || !id) return;
      const on = !isSubbed(c, c.village, id);
      toggleSub(c, c.village, id, on);
      const p = v.data.plots.find(x => x.id === id);
      await send(chatId, on ? `Подписка на ${where(p)} оформлена.

` + plotReport(v, p) : `Вы отписались от участка ${id}.`, MENU);
      return send(chatId, "Ваши участки отмечены знаком ✓:", plotsKeyboard(c, c.village, v));
    }
    if (kind === "sp") {                                  // подписка на все участки маршрута стада
      const v = villageOf(c), herd = v && herdsOf(v).find(h => h.id === c.herd);
      if (!herd) return;
      const ids = [...new Set((compute(v).pl.herdPlans[herd.id] || []).map(s => s.plot).filter(Boolean))];
      ids.forEach(id => toggleSub(c, c.village, id, true));
      return send(chatId, `Подписала вас на участки маршрута: ${ids.join(", ")}. В сезон пришлю уведомление о каждом новом снимке и напомню о перегоне за 3 дня.`, MENU);
    }
    if (kind === "pr" || kind === "pt") {                 // своё пастбище: отчёт / подписка
      const q = myPastures(chatId).find(x => x.id === arg);
      if (!q) return send(chatId, "Пастбище не найдено в вашем профиле.", MENU);
      if (kind === "pr") return send(chatId, pastureReport(chatId, q), MENU);
      const on = !(c.psubs || []).includes(q.id);
      c.psubs = (c.psubs || []).filter(x => x !== q.id).concat(on ? [q.id] : []); save();
      return send(chatId, on ? `Подписка на пастбище «${q.name}» оформлена.` : `Вы отписались от пастбища «${q.name}».`, pasturesKeyboard(c, chatId));
    }
    if (kind === "r" || kind === "d" || kind === "u") {   // отчёт / пример уведомления / отписка
      const [vk, code] = arg.split("|"), v = state.villages[vk], id = PL.plotFromCode(code);
      const p = v && id && v.data.plots.find(x => x.id === id);
      if (!p) return send(chatId, "Этот участок больше не найден.", MENU);
      if (kind === "r") return send(chatId, plotReport(v, p), MENU);
      if (kind === "u") { toggleSub(c, vk, id, false); return send(chatId, `Вы отписались от участка ${id} (${v.data.village.name}).`, MENU); }
      const s = p.series || [];
      if (s.length < 2) return send(chatId, "Для примера нужно хотя бы два летних снимка участка.", MENU);
      const last = s[s.length - 1];
      return send(chatId, "Так будет выглядеть уведомление в сезон (на реальных снимках прошлого лета):\n\n" +
        alertText(v, p, last.v, s.slice(0, -1).map(x => x.v), last.d), MENU);
    }
    return;
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id, c = chatOf(chatId);
  const text = (msg.text || "").trim(), low = text.toLowerCase();
  const v = villageOf(c);

  const lg = /^\/start\s+login_([A-Za-z0-9_-]{20,64})$/.exec(text);
  if (lg) {                                         // вход на сайт: показать код и спросить подтверждение
    const rec = await siteApi.loginInfo(lg[1]);
    if (!rec) return send(chatId, "Ссылка для входа устарела. Нажмите «Войти» на сайте ещё раз.", MENU);
    return send(chatId, `Вход на сайт Jaiylym.\n\nКод на сайте должен быть: ${rec.code}\n\nЕсли код совпадает и вход начали вы, подтвердите. ` +
      `Если вы не входили на сайт, нажмите «Отмена».`,
      { inline_keyboard: [[{ text: "Подтвердить вход", callback_data: "lg:" + lg[1] }, { text: "Отмена", callback_data: "ln:" + lg[1] }]] });
  }

  const mine = /^\/start\s+m_([A-Za-z0-9_-]{6,20})$/.exec(text);
  if (mine) {                                       // с сайта: подписаться на своё пастбище
    const q = myPastures(chatId).find(x => x.id === mine[1]);
    if (!q) return send(chatId, "Это пастбище не найдено в вашем профиле. Войдите на сайт тем же аккаунтом Telegram и сохраните пастбище в профиле.", MENU);
    c.psubs = [...new Set((c.psubs || []).concat([q.id]))].slice(-10); save();
    return send(chatId, `Вы подписаны на своё пастбище «${q.name}». С мая по сентябрь пришлю уведомление о каждом новом снимке.\n\n` + pastureReport(chatId, q), MENU);
  }

  const deep = /^\/start\s+([vp])_(m?\d+)_(m?\d+)(?:_([NF][0-7]))?$/i.exec(text);
  if (deep) {                                       // пришёл с сайта: открыть село / подписаться на участок
    const num = x => (x[0] === "m" ? -1 : 1) * +x.replace("m", "") / 1000;
    const lat = num(deep[2]), lon = num(deep[3]), vk = vkey(lat, lon);
    const name = state.villages[vk] ? state.villages[vk].data.village.name : await reverseName(lat, lon);
    const ok = await chooseVillage(chatId, name, lat, lon, send, { quiet: !!deep[4] });
    const id = deep[4] && PL.plotFromCode(deep[4].toUpperCase());
    if (ok && id) {
      toggleSub(c, vk, id, true);
      const v2 = state.villages[vk], p = v2.data.plots.find(x => x.id === id);
      return send(chatId, `Вы подписаны на участок ${where(p)}.
С мая по сентябрь пришлю уведомление о каждом новом снимке.

` + plotReport(v2, p), MENU);
    }
    return;
  }

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
      if (seg && seg.plot && seg.plot !== p.id) s += `\n\nВнимание: по плану стадо «${herd.name}» сегодня должно быть на ${seg.plot}.`;
      else if (seg && seg.plot === p.id) s += `\n\nВы там, где нужно по плану.`;
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
      `${parsed.daily_return ? " (дойные, каждый вечер в село)" : ""} = ${fmt(J.herdAU(herd))} условных голов.\n\n` + textPlan(v, herd), subPlanButton());
  }

  if (low === "участки" || low === "/plots") {
    if (myPastures(chatId).length) await send(chatId, "Ваши пастбища (нарисованы на сайте):", pasturesKeyboard(c, chatId));
    const my = textMySubs(c);
    if (my.kb) await send(chatId, my.text, my.kb);
    return send(chatId, `${my.kb ? "Добавить участки" : "Подпишитесь на участки"} села ${v.data.village.name} — нажмите на участок (✓ — уже подписаны):`, plotsKeyboard(c, c.village, v));
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
  if (isQuestion && GEMINI_KEY) await send(chatId, "Думаю над ответом…");
  const answer = await askGemini(text, v, herd);
  if (answer) return send(chatId, answer, MENU);
  return send(chatId, (isQuestion && GEMINI_KEY ? "ИИ-помощник сейчас перегружен, спросите чуть позже. " : "Не понял. ") +
    "Кнопки внизу: «Сегодня», «План», «Карта села», «Водопой». " +
    "Чтобы записать стадо, напишите, например: «500 овец 30 коров 10 лошадей».", MENU);
}

async function chooseVillage(chatId, name, lat, lon, send, { quiet = false } = {}) {
  const c = chatOf(chatId);
  const prev = c.village;
  try {
    c.village = await ensureVillage(name, lat, lon, t => send(chatId, t));
  } catch (e) {
    await send(chatId, `Не получилось посчитать это место: ${e.message}. Попробуйте ещё раз или другое село.`, ASK_VILLAGE);
    return false;
  }
  if (prev !== c.village) c.herd = null;
  save();
  const v = villageOf(c);
  if (quiet) return true;
  await send(chatId, villageSummary(v) + `\n\nКарта: ${siteLink(v)}`, MENU);
  await askHerd(chatId, v, send);
  return true;
}

function subPlanButton() {
  return { inline_keyboard: [[{ text: "Подписаться на участки маршрута", callback_data: "sp" }]] };
}

function askHerd(chatId, v, send) {
  const demo = v.demo || [];
  return send(chatId, `Сколько у вас скота? Напишите, например: «500 овец 30 коров 10 лошадей» (для дойных коров добавьте слово «дойные»).` +
    (demo.length ? `\nИли выберите демо-стадо:` : ""),
    demo.length ? { inline_keyboard: demo.map(h => [{ text: `${h.name} — ${fmt(J.herdAU(h))} УГ`, callback_data: "herd:" + h.id }]) } : MENU);
}

/** Для сайта: стада, записанные в боте (без имён), и сколько людей подписано на каждый участок. */
function villageApi(lat, lon) {
  const vk = vkey(lat, lon), v = state.villages[vk];
  if (!v) return { herds: [], subs: {} };
  const subs = {};
  for (const c of Object.values(state.chats)) for (const k of c.subs || []) {
    const [kv, id] = k.split("|"); if (kv === vk) subs[id] = (subs[id] || 0) + 1;
  }
  const herds = (v.herds || []).map((h, i) => ({ id: "tg" + (i + 1), name: `Пастух из Telegram ${i + 1}`, sheep: h.sheep || 0, goats: h.goats || 0,
    cattle: h.cattle || 0, horses: h.horses || 0, home: h.home, daily_return: !!h.daily_return, from_bot: true }));
  return { herds, subs };
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
  const info = `Бот @${me.result.username}. Хранилище: ${store.kind}. Gemini: ${GEMINI_KEY ? require("./gemini").MODELS.join(", ") : "выключен"} (Interactions API).`;

  if (PUBLIC_URL) return serve(token, api, onUpdate, info, send);

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

function serve(token, api, onUpdate, info, send) {
  const http = require("http");
  const secret = require("crypto").createHash("sha256").update(token).digest("hex").slice(0, 32);
  const server = http.createServer((req, res) => {
    siteApi.handle(req, res).then(done => { if (!done) routes(req, res); })
      .catch(e => { console.error("api", e); try { res.writeHead(500).end(); } catch (_) {} });
  });
  function routes(req, res) {
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
    if (req.method === "POST" && req.url.startsWith("/cron")) {
      // Пароль задаётся вручную: CRON_SECRET в Render (Environment) и такой же секрет в GitHub (Settings → Secrets → Actions)
      if (!process.env.CRON_SECRET) { res.writeHead(503).end("CRON_SECRET не задан"); return; }
      if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) { res.writeHead(401).end(); return; }
      runCron(send).then(r => { console.log("cron", JSON.stringify(r)); res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(r)); })
        .catch(e => { console.error("cron", e); res.writeHead(500).end(String(e.message)); });
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Jaiylym bot работает. Telegram: @" + BOT_USERNAME);
  }
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
  const show = (chat, text, kb) => {
    console.log(`🤖[${chat}] ` + text + (kb?.inline_keyboard ? "\n   [" + kb.inline_keyboard.map(r => r.map(b => b.text).join(" | ")).join(" / ") + "]" : ""));
  };
  const send = async (chat, text, kb) => show(chat, text, kb);
  const say = async (text, extra = {}, chat = 1) => {
    console.log(`\n👤[${chat}] ${text || JSON.stringify(extra)}`);
    await handle({ message: Object.assign({ chat: { id: chat }, from: { first_name: "Тест" }, text }, extra) }, send, new Date(2026, 6, 15));
  };
  const tap = async (data, chat = 1) => { console.log(`\n👤[${chat}] [кнопка ${data}]`); await handle({ callback_query: { id: "x", data, message: { chat: { id: chat } } } }, send); };

  // 1) пришёл с сайта по ссылке «Подписаться» на участок Д-С Кегена
  await say("/start p_43020_79220_F0");
  // 2) список подписок, подписка ещё на Б-С, отчёт, пример уведомления
  await say("Участки");
  await tap("s:N0");
  await tap("d:43.020,79.220|F0");
  // 3) второй человек: стадо и подписка на маршрут
  await say("/start v_43020_79220", {}, 2);
  await say("700 овец 30 коров", {}, 2);
  await tap("sp", 2);
  // 4) сайт: что видит акимат
  console.log("\nAPI для сайта:", JSON.stringify(villageApi(43.02, 79.22)));
  // 5) ежедневная проверка: в ноябре и «31 августа»
  console.log("\nCRON 21 ноября:", JSON.stringify(await runCron(send, new Date("2026-11-21T04:00:00Z"))));
  console.log("\nCRON 31 августа:");
  console.log(JSON.stringify(await runCron(send, new Date("2026-08-31T04:00:00Z"))));
  console.log("\nCRON 31 августа, повторно (нового снимка нет):", JSON.stringify(await runCron(send, new Date("2026-08-31T05:00:00Z"))));
  // 6) напоминание о перегоне: найдём день, когда у стада 2 начинается новый отрезок
  await say("/start v_43020_79220", {}, 3);
  await tap("herd:village", 3);
  const v = state.villages["43.020,79.220"], plan = compute(v).pl.herdPlans["village"];
  console.log("\nплан сельского стада:", JSON.stringify(plan));
  const seg = plan.find((s, i) => i > 0);
  if (seg) {
    const d = new Date(2026, 4, 1 + seg.from - 3 - 1, 9);
    console.log(`CRON за 3 дня до перегона (${d.toISOString().slice(0, 10)}):`, JSON.stringify(await runCron(send, d)));
  }
}

if (require.main === module) {
  if (process.argv.includes("--test")) test().catch(e => { console.error(e); process.exit(1); });
  else if (process.env.TELEGRAM_TOKEN) run(process.env.TELEGRAM_TOKEN);
  else { console.log("Нужен TELEGRAM_TOKEN в .env (или проверка: node bot.js --test)"); process.exit(1); }
}

module.exports = { handle, parseHerd, runCron, villageApi, siteApi, getState: () => state, setTest: () => { TEST = true; } };
