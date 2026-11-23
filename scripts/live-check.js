/*
 * Проверка продакшна JAIYLYM (запускается в GitHub Actions: .github/workflows/live-check.yml).
 * Ничего не меняет: только читает и задаёт ИИ три вопроса (это расходует 3 запроса дневного лимита).
 * Выход с ошибкой — если сайт или сервер не отвечают, или ИИ не ответил.
 */
const { Jaiylym: J, loadPlots, loadHerds } = require("../data");
const M = require("../web/model.js");
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

/** Данные Кегена в том же виде, в каком их передаёт сайт (сокращённо). */
function context() {
  const D = loadPlots(), H = loadHerds().map(h => Object.assign({ demo: true }, h)), P = J.params();
  const pl = J.plan(D.plots, H, P), cur = J.current(D.plots, H, P);
  return {
    село: D.village.name, лето_снимков: D.source.year, статус_плана: pl.status, версия_модели: M.MODEL_VERSION, демо_стада: true,
    модель_проверена_в_поле: false,
    участки: D.plots.map(p => { const c = J.plotCapacity(p, P); return { id: p.id, пастбище_га_спутник: p.pasture_ha, ndvi_спутник: p.ndvi,
      ёмкость_овец_оценка: c.known ? Math.round(c.au_season / P.au.sheep) : null, вода: M.waterStatus(p),
      как_рассчитано: J.explainCapacity(p, P).steps.map(s => `${s.key}: ${s.formula}`).join("; "),
      нагрузка_если_все_у_села_проц: Math.round(cur.load[p.id].load * 100), нагрузка_по_плану_проц: Math.round(pl.load[p.id].load * 100) }; }),
    стада: H.map(h => ({ имя: h.name, демо: true, овцы: h.sheep, крс: h.cattle, лошади: h.horses, усл_голов: J.herdAU(h, P) })),
    итог: { перегружено_если_все_у_села: cur.overloaded, перегружено_по_плану: pl.overloaded, дефицит_сена_т_по_плану_оценка: Math.round(J.hayTonnes(pl.deficit_kg, P)) },
  };
}

async function ask(body, label) {
  try {
    const r = await get(API + "/api/ai", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), timeout: 90000 });
    const d = await r.json().catch(() => ({}));
    console.log(`\n--- ИИ: ${label} (HTTP ${r.status}, модель ${d.model || "—"}) ---\n${d.text || d.error}\n` + (d.issues && d.issues.length ? "проблемы данных: " + d.issues.join(" ") + "\n" : ""));
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
  const ctx = context();
  const a1 = await ask({ mode: "chat", lang: "ru", context: ctx, messages: [{ role: "user", text: "Откуда взялось число 367 овец на участке Б-С?" }] }, "ru, откуда 367 овец");
  ok(a1.status === 200 && !!a1.d.text, "ИИ отвечает по-русски");
  if (a1.d.text && !/367/.test(a1.d.text)) note("ИИ не назвал 367 в объяснении — проверьте ответ выше");
  const a2 = await ask({ mode: "summary", lang: "kk", context: ctx }, "kk, сводка");
  ok(a2.status === 200 && !!a2.d.text, "ИИ отвечает по-казахски");
  if (a2.d.text && /[а-яё]{4,}/i.test(a2.d.text.replace(/[әғқңөұүһі]/gi, "")) && !/[әғқңөұүһі]/i.test(a2.d.text)) note("казахский ответ похож на русский — проверьте");
  const a3 = await ask({ mode: "chat", lang: "ru", context: {}, messages: [{ role: "user", text: "Сколько овец выдержит моё пастбище?" }] }, "ru, без данных села");
  ok(a3.status === 200 && (a3.d.issues || []).length > 0, "без данных ИИ получает предупреждение «Село не открыто»");

  // 4. бот в Telegram
  try {
    const r = await get("https://t.me/JAIYLYM_bot");
    const t = await r.text();
    ok(r.ok && /JAIYLYM_bot/i.test(t), "страница бота в Telegram открывается");
  } catch (e) { ok(false, "t.me: " + e.message); }

  console.log(`\nИтог: ошибок ${fails.length}, замечаний ${notes.length}.`);
  process.exit(fails.length ? 1 : 0);
})();
