/*
 * Проверка продакшна JAIYLYM (запускается в GitHub Actions: .github/workflows/live-check.yml).
 * Ничего не меняет: только читает и задаёт ИИ шесть вопросов (это расходует 6 запросов дневного лимита).
 * Выход с ошибкой — если сайт или сервер не отвечают, или ИИ не ответил.
 */
const { Jaiylym: J, loadPlots, loadHerds } = require("../data");
const M = require("../web/model.js");
const NG = require("../web/nograze.js");
const PL = require("../web/pipeline.js");
PL.setUserAgent("Jaiylym-live-check/1.0 (+https://github.com/Ainara001/jaiylym)");
const SITE = process.env.SITE_URL || "https://ainara001.github.io/jaiylym/";
const API = process.env.API_URL || "https://jaiylym-bot.onrender.com";
const fails = [], notes = [];
const ok = (cond, msg) => { console.log((cond ? "OK   " : "FAIL ") + msg); if (!cond) fails.push(msg); };
const note = msg => { console.log("NOTE " + msg); notes.push(msg); };
const get = (url, opt = {}) => fetch(url, Object.assign({ signal: AbortSignal.timeout(opt.timeout || 60000) }, opt));

async function wake() {
  for (let i = 0; i < 10; i++) {
    try { const r = await get(API + "/health"); if (r.ok) return r.text(); } catch (_) {}
    await new Promise(r => setTimeout(r, 20000));
  }
  return null;
}

/** Данные села в том же виде, в каком их передаёт сайт (сокращённо). По умолчанию — Кеген с демо-стадами. */
function context(D0 = loadPlots(), H = loadHerds().map(h => Object.assign({ demo: true }, h))) {
  const D = Object.assign({}, D0, { plots: NG.apply(D0.plots, D0.nograze) }), P = J.params();
  const pl = J.solve(D.plots, H, P), cur = J.current(D.plots, H, P);
  return {
    село: D.village.name, лето_снимков: D.source.year, статус_плана: pl.status, версия_модели: M.MODEL_VERSION, демо_стада: H.some(h => h.demo),
    модель_проверена_в_поле: false,
    участки: D.plots.map(p => { const c = J.plotCapacity(p, P); return { id: p.id, пастбищный_покров_га_спутник: p.pasture_ha_gross ?? p.pasture_ha,
      нельзя_пасти_га_osm: p.nograze_ha ?? undefined, кормовая_площадь_га: p.pasture_ha, ndvi_спутник: p.ndvi,
      ёмкость_овец_оценка: c.known ? Math.round(c.au_season / P.au.sheep) : null, вода: M.waterStatus(p),
      как_рассчитано: J.explainCapacity(p, P).steps.map(s => `${s.key}: ${s.formula}`).join("; "),
      нагрузка_если_все_у_села_проц: Math.round(cur.load[p.id].load * 100), нагрузка_по_плану_проц: Math.round(pl.load[p.id].load * 100) }; }),
    стада: H.map(h => ({ имя: h.name, демо: !!h.demo, овцы: h.sheep, крс: h.cattle, лошади: h.horses, усл_голов: J.herdAU(h, P) })),
    итог: { перегружено_если_все_у_села: cur.overloaded, перегружено_по_плану: pl.overloaded, дефицит_сена_т_по_плану_оценка: Math.round(J.hayTonnes(pl.deficit_kg, P)) },
    почему_план: Object.values(J.explainPlan(D.plots, H, pl, P)),
  };
}

async function ask(body, label) {
  try {
    const r = await get(API + "/api/ai", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), timeout: 90000 });
    const d = await r.json().catch(() => ({}));
    console.log(`\n--- ИИ: ${label} (HTTP ${r.status}, модель ${d.model || "—"}${d.reason ? ", причина " + d.reason : ""}) ---\n${d.text || d.error}\n` + (d.issues && d.issues.length ? "проблемы данных: " + d.issues.join(" ") + "\n" : ""));
    return { status: r.status, d };
  } catch (e) { console.log(`--- ИИ: ${label}: ${e.message}`); return { status: 0, d: {} }; }
}

(async () => {
  // 1. сайт
  try {
    const r = await get(SITE);
    const html = await r.text();
    ok(r.ok, `сайт открывается (${r.status})`);
    ok(/model\.js\?v=\d+/.test(html), "на сайте новая версия (подключён model.js)");
    const mj = await (await get(SITE + "model.js")).text();
    ok(mj.includes(`MODEL_VERSION = "${M.MODEL_VERSION}"`), `модель на сайте ${M.MODEL_VERSION}`);
    const v = await get(SITE + "vendor/html2pdf-0.10.1.bundle.min.js");
    ok(v.ok, "библиотека PDF лежит на сайте");
    const lf = await get(SITE + "vendor/leaflet-1.9.4/leaflet.js");
    ok(lf.ok, "карта Leaflet лежит на сайте (без unpkg.com)");
  } catch (e) { ok(false, "сайт: " + e.message); }

  // 2. сервер
  const health = await wake();
  ok(!!health, "сервер на Render отвечает: " + (health || "нет ответа"));
  if (health && !health.includes(M.MODEL_VERSION)) note("сервер ещё на старой версии (нет «Модель " + M.MODEL_VERSION + "» в /health) — Render мог не пересобраться");
  try {
    const r = await get(API + "/api/village?lat=43.02&lon=79.22");
    const d = await r.json();
    ok(r.ok && Array.isArray(d.herds), `данные села из бота (${r.status}, стад из Telegram: ${(d.herds || []).length})`);
  } catch (e) { ok(false, "api/village: " + e.message); }
  try {
    const r = await get(API + "/cron", { method: "POST" });
    ok(r.status === 401, `/cron без доступа закрыт (${r.status})`);
  } catch (e) { ok(false, "/cron: " + e.message); }

  // 3. ИИ с настоящим ключом
  try {
    const st = await (await get(API + "/api/ai/status")).json();
    console.log("\n--- состояние ИИ ---\n" + JSON.stringify(st, null, 1));
    ok(st.key_configured === true, `ключ ИИ задан на сервере (${st.provider || "gemini"})`);
    if (st.configured_available && st.configured_available.every(x => !x.available)) note("ни одна модель из GEMINI_MODELS не доступна ключу; запасные: " + (st.fallback_candidates || []).join(", "));
  } catch (e) { note("/api/ai/status недоступен (сервер на старой версии?): " + e.message); }
  const ctx = context();
  const a1 = await ask({ mode: "chat", lang: "ru", context: ctx, messages: [{ role: "user", text: "Откуда взялось число 313 овец на участке Б-С?" }] }, "ru, откуда 313 овец");
  // перегрузка серверов ИИ — внешний сбой: отмечаем, но не считаем ошибкой нашей системы.
  // Шаблонный ответ (fallback) приходит с кодом 200, но это значит, что ИИ НЕ ответил — его нельзя засчитывать как успех.
  const aiOk = (r, msg) => (r.d.fallback && r.d.reason === "overloaded" ? note(msg + ": серверы ИИ перегружены, сервер повторил запрос и показал шаблон — внешний сбой")
    : ok(r.status === 200 && !!r.d.text && !r.d.fallback, msg + (r.d.fallback ? ` — ИИ не ответил (${r.d.reason}), показан шаблон` : "")));
  aiOk(a1, "ИИ отвечает по-русски");
  if (a1.d.text && !/313/.test(a1.d.text)) note("ИИ не назвал 313 в объяснении — проверьте ответ выше");
  if (a1.d.text && !/47[,.]1/.test(a1.d.text)) note("ИИ не упомянул 47,1 га жилья и ферм (OSM) — проверьте ответ выше");
  const a2 = await ask({ mode: "summary", lang: "kk", context: ctx }, "kk, сводка");
  aiOk(a2, "ИИ отвечает по-казахски");
  if (a2.d.text && /[а-яё]{4,}/i.test(a2.d.text.replace(/[әғқңөұүһі]/gi, "")) && !/[әғқңөұүһі]/i.test(a2.d.text)) note("казахский ответ похож на русский — проверьте");
  const a3 = await ask({ mode: "chat", lang: "ru", context: {}, messages: [{ role: "user", text: "Сколько овец выдержит моё пастбище?" }] }, "ru, без данных села");
  ok((a3.d.issues || []).length > 0, "без данных ИИ получает предупреждение «Село не открыто»");
  aiOk(a3, "ИИ отвечает без данных села");
  const a4 = await ask({ mode: "chat", lang: "ru", context: ctx, messages: [{ role: "user", text: "Почему стадо Ерлана пасётся на участке Д-ЮЗ, а не ближе к дому?" }] }, "ru, почему Д-ЮЗ");
  aiOk(a4, "ИИ объясняет выбор участка");
  if (a4.d.text && !/Д-Ю\b|вод/i.test(a4.d.text)) note("ИИ не назвал причину из фактов (Д-Ю без подтверждённой воды) — проверьте ответ выше");
  // поиск в интернете: свежие сведения (погода) — под ответом должны быть источники
  const a5 = await ask({ mode: "chat", lang: "ru", context: ctx, messages: [{ role: "user", text: "Какая погода ожидается в Кегене на этой неделе?" }] }, "ru, поиск: погода");
  aiOk(a5, "ИИ отвечает на вопрос о погоде");
  if (a5.status === 200 && !a5.d.fallback) {
    if ((a5.d.sources || []).length) ok(true, `поиск в интернете работает: ${a5.d.sources.length} источн.: ${a5.d.sources.map(x => x.url).slice(0, 3).join(" ")}`);
    else note("ИИ ответил о погоде без источников — поиск не сработал (проверьте лимит AI_SEARCH_DAILY и поддержку поиска у провайдера)");
    if (/\[интернет\]/.test(a5.d.text) && !(a5.d.sources || []).length) ok(false, "метка [интернет] без источников");
  }
  // что DeepSeek вернул на запрос с поиском (инструмент передан? был ли вызов поиска?) — для разбора, если источников нет
  try { const st = await (await get(API + "/api/ai/status")).json(); console.log("\n--- поиск: последний запрос с инструментом ---\n" + JSON.stringify({ search_available: st.search_available, last_search: st.last_search, last_answer: st.last_answer, uptime_s: st.uptime_s, rss_mb: st.rss_mb, usage: st.usage_since_start }, null, 1)); }
  catch (e) { note("/api/ai/status после вопроса о погоде: " + e.message); }
  // другое село (не демо): ИИ должен помогать по любому селу — Нарынкол считается по снимкам здесь же, как в браузере
  try {
    const N = await PL.buildVillage({ name: "Нарынкол", lat: 42.717, lon: 80.183 });
    const nctx = context(N, [{ id: "h1", name: "Стадо 1", sheep: 400, cattle: 20, horses: 10, home: N.plots[0].id }]);
    const top = nctx.участки.filter(x => x.ёмкость_овец_оценка != null).sort((a, b) => b.ёмкость_овец_оценка - a.ёмкость_овец_оценка)[0];
    const a6 = await ask({ mode: "chat", lang: "ru", context: nctx, messages: [{ role: "user", text: `Сколько овец выдержит участок ${top.id} и откуда это число?` }] }, `ru, другое село: Нарынкол, ${top.id}`);
    aiOk(a6, "ИИ отвечает по другому селу (Нарынкол)");
    if (a6.d.text && !new RegExp(String(top.ёмкость_овец_оценка)).test(a6.d.text.replace(/\s/g, ""))) note(`ИИ не назвал ёмкость ${top.ёмкость_овец_оценка} овец участка ${top.id} Нарынкола — проверьте ответ выше`);
    if ((a6.d.issues || []).some(x => /Село не открыто/.test(x))) ok(false, "данные Нарынкола не дошли до ИИ");
  } catch (e) { note("Нарынкол не посчитался по снимкам (внешний сбой Planetary Computer/OSM?): " + e.message); }



  // 4. бот в Telegram
  try {
    const r = await get("https://t.me/JAIYLYM_bot");
    const t = await r.text();
    ok(r.ok && /JAIYLYM_bot/i.test(t), "страница бота в Telegram открывается");
  } catch (e) { ok(false, "t.me: " + e.message); }

  console.log(`\nИтог: ошибок ${fails.length}, замечаний ${notes.length}.`);
  process.exit(fails.length ? 1 : 0);
})();
