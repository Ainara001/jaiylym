// Сквозной путь пользователя в настоящем браузере (Playwright, Chromium): ПК и телефон.
// Внешние сервисы (поиск OpenStreetMap, Render, CDN, подложка карты) подменяются — тест не зависит от сети.
// Запуск: npm run test:e2e
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
let pw = null;
try { pw = require("playwright"); } catch (_) {}
// В CI: JAIYLYM_BROWSERS=chromium,webkit (WebKit — движок Safari на iPhone). Локально — Chromium.
const BROWSERS = (process.env.JAIYLYM_BROWSERS || "chromium").split(",").map(s => s.trim()).filter(Boolean);

const WEB = path.join(__dirname, "..", "..", "web");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml" };
let server, base;

test.before(async () => {
  server = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const f = path.join(WEB, u === "/" ? "index.html" : u);
    if (!f.startsWith(WEB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port + "/";
});
test.after(() => server && server.close());

async function stubNetwork(page) {
  await page.route(/nominatim\.openstreetmap\.org\/search/, r => r.fulfill({ contentType: "application/json",
    body: JSON.stringify([{ name: "Кеген", display_name: "Кеген, Райымбекский район, Алматинская область", lat: "43.02", lon: "79.22" }]) }));
  await page.route(/jaiylym-bot\.onrender\.com/, r => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "спит" }) }));
  await page.route(/unpkg\.com|cdnjs\.cloudflare\.com|arcgisonline|open-meteo|fonts\.g/, r => r.abort());
}

async function journey(page, label) {
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await stubNetwork(page);
  // 1. открыть сайт
  await page.goto(base + "#/home");
  await page.waitForSelector("#heroQ");
  assert.match(await page.textContent(".band-need"), /Что приблизительно/, label + ": на главной сказано, что приблизительно");
  // 2. найти село
  await page.fill("#heroQ", "Кеген");
  await page.click("#heroSearch button");
  await page.waitForFunction(() => location.hash.startsWith("#/map") && window.JaiylymApp.S.D);
  // 3. спутниковый результат (пример Кегена — реальные снимки, сохранённые в репозитории)
  const S = () => page.evaluate(() => { const s = window.JaiylymApp.S; return { plots: s.plots.length, herds: s.herds.length, status: s.pl && s.pl.status, demo: s.herds.filter(h => h.demo).length }; });
  let st = await S();
  assert.equal(st.plots, 16);
  assert.equal(st.demo, 5, "демо-стада помечены");
  assert.match(await page.textContent('.pane[data-pane="brief"]'), /условных демо-стад/);
  // убрать демо-стада → добавить своё хозяйство
  await page.click("#demoToggle");
  assert.equal((await S()).herds, 0);
  await page.evaluate(() => window.JaiylymApp.renderPane("herds"));
  await page.click("#addHerd");
  // 4–5. расчёт для своего стада
  await page.fill('.herd [data-k="sheep"]', "40000");
  await page.dispatchEvent('.herd [data-k="sheep"]', "change");
  await page.evaluate(() => window.JaiylymApp.render());
  st = await S();
  assert.equal(st.status, "partially_feasible", "огромное стадо — честный частичный результат");
  await page.evaluate(() => window.JaiylymApp.renderPane("brief"));
  assert.match(await page.textContent(".result"), /полностью распределить стада не удалось/);
  // «Как рассчитано?»
  await page.click('.result [data-how]');
  const how = await page.textContent("dialog[open]");
  assert.match(how, /max\(0, /);
  assert.match(how, /Ограничения результата/);
  await page.keyboard.press("Escape");
  // 6. изменить ограничения: закрыть участок, подтвердить отсутствие воды
  const before = await page.evaluate(() => window.JaiylymApp.S.pl.deficit_kg);
  await page.evaluate(() => { const A = window.JaiylymApp; A.S.forbidden.add("Д-ЮЗ"); A.rebuildPlots(); A.render(); });
  const after = await page.evaluate(() => ({ d: window.JaiylymApp.S.pl.deficit_kg, used: window.JaiylymApp.S.pl.load["Д-ЮЗ"].used }));
  assert.equal(after.used, 0, "закрытый участок не используется");
  assert.ok(after.d >= before);
  // 7. сравнить сценарии
  await page.evaluate(() => window.JaiylymApp.renderPane("whatif"));
  const wi = await page.textContent('.pane[data-pane="whatif"]');
  for (const re of [/Как сейчас/, /Предлагаемый план/, /водопой на/, /Скота на 20 % больше/, /не оптимизатор/, /Точн|точная граница/i]) assert.match(wi, re);
  // неверный параметр не принимается
  await page.evaluate(() => window.JaiylymApp.renderPane("brief"));
  await page.evaluate(() => document.querySelectorAll('.pane[data-pane="brief"] details').forEach(d => { d.open = true; }));
  const util = await page.$('.pane[data-pane="brief"] [data-param="util"]');
  assert.ok(util, "поле параметра есть");
  await util.fill("1.5"); await util.dispatchEvent("change");
  assert.equal(await page.evaluate(() => window.JaiylymApp.S.P.util), 0.5, "util 1,5 отклонён");
  assert.match(await page.textContent('.pane[data-pane="brief"] [data-perr="util"]'), /не принято/);
  // 8. сохранить сценарий (гость — в браузере)
  page.once("dialog", d => d.accept());
  await page.click("#saveScBtn");
  await page.fill("dialog.modal[open] input", "Тест " + label);
  await page.click('dialog.modal[open] button[value="ok"]');
  await page.waitForFunction(() => (JSON.parse(localStorage.getItem("jaiylym:guest:scenarios") || "[]")).length >= 1);
  const sc = await page.evaluate(() => JSON.parse(localStorage.getItem("jaiylym:guest:scenarios"))[0]);
  assert.deepEqual(sc.forbidden, ["Д-ЮЗ"], "ограничения сохраняются в сценарии");
  // 9. PDF: собираем отчёт (сама библиотека html2pdf грузится с CDN и в тесте отключена)
  const rep = await page.evaluate(() => window.Report.build(window.JaiylymApp.reportCtx()));
  for (const k of ["Источники данных и даты снимков", "Хозяйства", "Формулы и коэффициенты", "Ограничения модели", "Расчётная потребность", "Результат распределения",
    "Неудовлетворённая потребность", "Сравнение сценариев", "Источники неопределённости", "Версия модели", "не подтверждает право землепользования", "тенге"]) assert.ok(rep.includes(k), k);
  assert.ok(!rep.includes("₸"), "в PDF тенге словом");
  // настоящий PDF: кнопка → библиотека html2pdf из web/vendor (CDN в тесте закрыт) → скачанный файл
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click("#pdfBtn")]);
  const file = await dl.path();
  const buf = fs.readFileSync(file);
  assert.equal(buf.slice(0, 5).toString(), "%PDF-", label + ": скачан PDF");
  assert.ok(buf.length > 50000, label + ": PDF не пустой (" + buf.length + " байт)");
  assert.match(dl.suggestedFilename(), /^jaiylym-kegen-\d{4}-\d{2}-\d{2}\.pdf$/);
  // 10. открыть данные в Telegram
  const tg = await page.getAttribute("#tgVillage", "href");
  assert.match(tg, /^https:\/\/t\.me\/JAIYLYM_bot\?start=v_43020_79220$/);
  // казахский язык и страница исследования
  await page.click('.langsw [data-lang="kk"]');
  assert.match(await page.textContent(".tabs"), /Егер былай болса/);
  await page.goto(base + "#/research");
  assert.match(await page.textContent("#rsPage"), /Жазылған сұхбаттар: 0/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, label + ": нет горизонтальной прокрутки страницы");
  assert.deepEqual(errors, [], label + ": ошибки JavaScript");
}

for (const name of BROWSERS) {
  const skip = !pw && "playwright не установлен";
  test(`${name}: путь пользователя на компьютере`, { skip, timeout: 180000 }, async () => {
    const b = await pw[name].launch();
    try { const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true }); await journey(await ctx.newPage(), name + " ПК"); }
    finally { await b.close(); }
  });
  test(`${name}: путь пользователя на телефоне (iPhone 13)`, { skip, timeout: 180000 }, async () => {
    const b = await pw[name].launch();
    const dev = Object.assign({}, pw.devices["iPhone 13"]);
    if (name !== "webkit") delete dev.defaultBrowserType;
    try { const ctx = await b.newContext(Object.assign(dev, { acceptDownloads: true })); await journey(await ctx.newPage(), name + " телефон"); }
    finally { await b.close(); }
  });
}
