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

/** ИИ-чат, открытый сразу по ссылке: помощник видит данные села (пример), а не «село не открыто». */
async function chatWithoutMap(page, label) {
  await stubNetwork(page);
  await page.goto(base + "#/ai");
  await page.waitForFunction(() => window.JaiylymApp && window.JaiylymApp.S.D, null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => window.JaiylymApp.aiContext()["село"]), "Бесколь", label + ": контекст чата — пример");
  assert.match(await page.textContent(".chat-ctx"), /Бесколь/);
  assert.match(page.url(), /#\/ai$/, label + ": адрес остался на чате");
  await page.goto(base + "#/map");
  await page.waitForFunction(() => document.querySelectorAll("#schemeMap [data-plot], .leaflet-interactive").length > 0, null, { timeout: 15000 });
}

/** Новичок на чистом браузере: карта без чужого села, примеры по кнопке, новое село считается — старого на экране нет. */
async function newcomer(page, label) {
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await stubNetwork(page);
  await page.route(/planetarycomputer|overpass/, r => new Promise(() => {}));        // снимки «грузятся» — расчёт нового села висит
  const App = f => page.evaluate(f);
  await page.goto(base + "#/map");
  await page.waitForSelector(".start");
  assert.equal(await App(() => !!window.JaiylymApp.S.D), false, label + ": село само не открывается");
  assert.match(await page.textContent(".start"), /Выберите село/);
  assert.equal(await page.isVisible(".tabs"), false, label + ": без села вкладок анализа нет");
  assert.equal(await page.isVisible("#vtitle b"), false);
  // пример — по кнопке, с демо-стадами
  await page.click('.start a[href*="54.77515"]');
  await page.waitForFunction(() => window.JaiylymApp.S.D && window.JaiylymApp.S.pl);
  assert.deepEqual(await App(() => { const s = window.JaiylymApp.S; return [s.D.village.name, s.plots.length, s.herds.filter(h => h.demo).length]; }), ["Бесколь", 16, 5]);
  assert.match(page.url(), /demo=1/, label + ": ссылка на пример сохраняет демо-стада");
  // норма нагрузки: в Бесколе снимок выше нормы СКО; выбор типа и области меняет расчёт и запоминается
  await App(() => window.JaiylymApp.renderPane("data"));
  assert.equal(await page.inputValue("#nmRegion"), "SKO");
  assert.match(await page.textContent("#normBox"), /Норма ограничивает участков: 1[0-9] из 16/);
  const cap = () => App(() => Math.round(window.Jaiylym.totalCapacity(window.JaiylymApp.S.plots, window.JaiylymApp.S.P).au_season));
  const soft = await cap();
  await page.selectOption("#nmRow", "SKO-05");
  const strict = await cap();
  assert.ok(strict < soft, label + ": выбранный тип пастбища ужесточает предел");
  await page.selectOption("#nmRegion", "");
  assert.match(await page.textContent("#normBox"), /Область села не определена/);
  assert.ok(await cap() > soft * 2, label + ": без нормы ёмкость — по снимку");
  await page.selectOption("#nmRegion", "SKO");
  assert.equal(await cap(), soft);
  await App(() => window.JaiylymApp.renderPane("brief"));
  assert.match(await page.textContent('.pane[data-pane="brief"]'), /Норма Минсельхоза ограничивает 1[0-9] из 16/);
  assert.equal(await page.isVisible(".tabs"), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), label + ": без горизонтальной прокрутки");
  // где селу можно пасти: 825 га из плана района → чужие участки → свои гектары → контур → вся трава
  assert.match(await page.textContent("#zoneCard"), /825 га[\s\S]*плану района[\s\S]*Точных границ нет/);
  const ha = () => App(() => Math.round(window.JaiylymApp.S.plots.filter(p => !p.forbidden).reduce((s, p) => s + p.pasture_ha, 0)));
  assert.ok(Math.abs(await ha() - 825) < 2);
  await page.click('[data-zn="closed"]');
  await page.click('dialog[open] [data-plot="Д-С"]');
  await page.waitForSelector('dialog[open] [data-plot="Д-С"][aria-pressed="true"]');
  if (process.env.KEL_SHOTS) await page.screenshot({ path: path.join(process.env.KEL_SHOTS, "zone-closed.png") });
  await page.click("dialog[open] .btn-primary");
  await page.waitForFunction(() => /Исключено чужих участков: 1/.test(document.querySelector("#zoneCard").textContent));
  assert.ok(Math.abs(await ha() - 825) < 2, label + ": гектары по документам — только на своих участках");
  await page.click('[data-zn="ha"]');
  await page.fill("dialog[open] input", "400 га");
  await page.click("dialog[open] .btn-primary");
  await page.waitForFunction(() => /400 га/.test(document.querySelector("#zoneCard").textContent));
  assert.ok(Math.abs(await ha() - 400) < 2);
  if (process.env.KEL_SHOTS) await page.screenshot({ path: path.join(process.env.KEL_SHOTS, "zone-card.png"), fullPage: true });
  await App(() => window.JaiylymApp.setZone({ mode: "contour", rings: [[[69.0, 54.78], [69.2, 54.78], [69.2, 54.85], [69.0, 54.85]]] }));
  await page.waitForFunction(() => /внутри вашей границы/.test(document.querySelector("#zoneCard").textContent));
  assert.equal(await App(() => window.JaiylymApp.S.plots.find(p => p.id === "Д-Ю").pasture_ha), 0, label + ": за границей — ноль");
  assert.ok(await App(() => window.JaiylymApp.S.plots.find(p => p.id === "Д-СВ").pasture_ha) > 50);
  const before = await ha();
  await page.reload();
  await page.waitForFunction(() => window.JaiylymApp.S.D && window.JaiylymApp.S.pl);
  assert.equal(await ha(), before, label + ": граница запомнилась");
  await page.click('[data-zn="all"]');
  await page.waitForFunction(() => /всю траву вокруг/.test(document.querySelector("#zoneCard").textContent));
  // на карте закрашены только пиксели пастбища: жильё и зоны OSM прозрачны
  const painted = () => App(() => new Promise(res => { const s = window.JaiylymApp.S, im = new Image(); im.onload = () => { const c = document.createElement("canvas"); c.width = c.height = im.naturalWidth; const x = c.getContext("2d"); x.drawImage(im, 0, 0); const a = x.getImageData(0, 0, c.width, c.height).data;
    let on = 0, bad = 0; const block = window.JaiylymNoGraze.blockMask(s.D.nograze, s.D.bbox, c.width, s.ngBuf); for (let i = 0; i < c.width * c.width; i++) if (a[i * 4 + 3]) { on++; if (block[i] || !s.mask.px[i]) bad++; } res([on, bad, c.width * c.width]); }; im.src = s.pxLayer._url; }));
  if (await App(() => !!window.JaiylymApp.S.pxLayer)) { const [on, bad, all] = await painted(); assert.ok(on > 100 && on < all * 0.9, label + ": закрашено " + on); assert.equal(bad, 0, label + ": жильё не закрашено"); }
  // города: пастбищ почти нет — сказано прямо
  await App(() => { const s = window.JaiylymApp.S; s.keep = s.D.plots.map(p => p.pasture_ha); s.D.plots.forEach(p => { p.area_ha = p.area_ha || 1000; p.pasture_ha = 1; }); window.JaiylymApp.rebuildPlots(); window.JaiylymApp.render(); window.JaiylymApp.renderPane("brief"); });
  assert.match(await page.textContent("#cityNote"), /почти нет пастбищ/);
  await App(() => { const s = window.JaiylymApp.S; s.D.plots.forEach((p, i) => { p.pasture_ha = s.keep[i]; }); window.JaiylymApp.rebuildPlots(); window.JaiylymApp.render(); });
  // водопои: рейтинг по дефициту; без дефицита — честно «корма не добавит»
  await App(() => window.JaiylymApp.renderPane("water"));
  const wp = () => page.textContent('.pane[data-pane="water"]');
  assert.match(await wp(), /новый водопой|водопой сейчас|уже с водой/, label + ": водопой — по делу");
  await App(() => { const s = window.JaiylymApp.S; s.D.plots.forEach(p => { if (p.ring === "far") { p.water = false; p.water_status = "unknown"; } }); s.herds = [{ id: "a", name: "Тест", home: "Б-С", sheep: 1 }]; window.JaiylymApp.rebuildPlots(); window.JaiylymApp.render(); window.JaiylymApp.renderPane("water"); });
  assert.match(await page.textContent("#waterVerdict"), /корма не добавит/);
  await App(() => { const s = window.JaiylymApp.S; s.herds = [{ id: "a", name: "Тест", home: "Б-С", sheep: 9000 }]; window.JaiylymApp.render(); window.JaiylymApp.renderPane("water"); });
  const gains = (await page.$$eval(".wcand small:first-of-type", x => x.map(e => +e.textContent.match(/≈ ([\d\s]+) из/)[1].replace(/\s/g, ""))));
  assert.ok(gains.length > 1 && gains.every((g, i) => !i || gains[i - 1] >= g), label + ": по снижению дефицита");
  // лишнее скрыто: анкета водопоя, координатор, исследование, совет про укос, акимат на главной
  assert.equal(await page.$(".wcand details"), null, label + ": анкеты водопоя нет");
  assert.equal(JSON.stringify(await App(() => window.JaiylymApp.aiContext()["где_проверять_воду"])).includes("проверено_людьми"), false);
  assert.equal(await page.$('.mainnav [href="#/research"], #moreDlg [href="#/research"]'), null);
  assert.equal(await page.$$eval(".coord-only", x => x.every(e => e.hidden)), true);
  assert.equal(/укос/.test(await page.evaluate(() => { window.JaiylymApp.renderPane("brief"); return document.querySelector('.pane[data-pane="brief"] .todo').textContent; })), false);
  assert.equal(/акимат/i.test(await page.textContent('[data-view="home"]')), false);
  if (process.env.KEL_SHOTS) await page.screenshot({ path: path.join(process.env.KEL_SHOTS, "water.png"), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), label + ": водопои без прокрутки вбок");
  await App(() => window.JaiylymApp.renderPane("brief"));
  // новое село: сразу его имя и «считаем», прежнего села на карте и в панели нет
  await page.goto(base + "#/map?lat=50.1&lon=70.1&name=Новое");
  await page.waitForFunction(() => /Считаем пастбища: Новое/.test((document.querySelector(".start") || {}).textContent || ""));
  assert.equal(await App(() => !!window.JaiylymApp.S.D), false);
  assert.match(await page.textContent("#vtitle"), /Новое/);
  assert.equal(await page.$$eval("#schemeMap [data-plot]", x => x.length), 0, label + ": прежнего села на схеме нет");
  // ушли в другой раздел и вернулись — расчёт тот же; пример во время расчёта открывается
  await page.evaluate(() => { location.hash = "#/about"; });
  await page.waitForSelector('[data-view="about"]:not([hidden])');
  await page.evaluate(() => { location.hash = "#/map"; });
  await page.waitForFunction(() => /Считаем пастбища: Новое/.test((document.querySelector(".start") || {}).textContent || ""));
  await page.goto(base + "#/map?lat=43.02&lon=79.22&name=Кеген");
  await page.waitForFunction(() => window.JaiylymApp.S.D && window.JaiylymApp.S.D.village.name === "Кеген" && window.JaiylymApp.S.pl);
  assert.equal(await App(() => window.JaiylymApp.S.herds.length), 0);
  // зоны OSM молчат: село открыто сразу, и прямо сказано, что числа пока без вычета
  await App(() => { const D = JSON.parse(JSON.stringify(window.JAIYLYM_DATA)); delete D.nograze; D.village = { name: "Без зон", lat: 51.2, lon: 71.2, region: "Акмолинская область" };
    D.land_rule = window.JaiylymPipeline.LAND_RULE; D.png = "data/ndvi.png"; localStorage.setItem("jaiylym:v3:51.200,71.200", JSON.stringify(D)); });
  await page.goto(base + "#/map?lat=51.2&lon=71.2&name=Без%20зон");
  await page.waitForFunction(() => window.JaiylymApp.S.D && window.JaiylymApp.S.D.village.name === "Без зон" && window.JaiylymApp.S.pl);
  assert.match(await page.textContent("#ngNote"), /ещё загружаются из OpenStreetMap/, label + ": пока зон нет — честная пометка");
  // главная: оба примера, первым — Бесколь
  await page.goto(base + "#/home");
  await page.waitForSelector("#exBtns a");
  assert.match((await page.$$eval("#exBtns a", a => a.map(x => x.textContent))).join("|"), /Бесколь\|.*Кеген/);
  assert.match(await page.textContent("#heroBadge"), /Бесколь/);
  assert.deepEqual(errors, [], label + ": ошибки JavaScript");
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
  assert.equal(st.herds, 0, label + ": село найдено поиском — выдуманных стад нет");
  await page.click("#addDemo");
  st = await S();
  assert.equal(st.demo, 5, "демо-стада — только по кнопке и помечены");
  assert.match(await page.textContent('.pane[data-pane="brief"]'), /условных демо-стад/);
  // цепочка «NDVI → овцы» на виду: Б-С Кегена 0.289 → 313 овец (367 до вычета жилья и ферм OSM: 320 − 47,1 га), без открытия карточки
  const chain = await page.textContent(".chain");
  for (const re of [/0\.289/, /756/, /313/, /320 − 47,1/, /OpenStreetMap/, /корова — 1, лошадь — 1,2, овца — 0,2/, /Предел по норме Минсельхоза/, /0,5 га на овцу/, /150 дней с 1 мая/]) assert.match(chain, re, label + ": цепочка расчёта ёмкости");
  // трава по годам (P3): ряд Кегена посчитан заранее — вывод, график, правило «не деградация»
  await page.evaluate(() => window.JaiylymApp.renderPane("data"));
  const mt = await page.textContent(".mt");
  assert.match(mt, /Трава по годам/);
  assert.match(mt, /8 лет/, label + ": ряд 2019–2026");
  assert.ok(await page.$(".mt svg.mt-chart"), label + ": график по годам");
  assert.doesNotMatch(mt, /(?<!вывод о )деградац/i, label + ": слово «деградация» только в оговорке «не вывод о деградации»");
  await page.evaluate(() => window.JaiylymApp.renderPane("brief"));
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
  const res = await page.textContent(".result");
  assert.match(res, /полностью распределить стада не удалось/);
  assert.match(res, /Узкое место \(доказательство\)/, "показано доказательство узкого места");
  assert.match(res, /Справедливая оптимизация/);
  assert.equal(await page.evaluate(() => window.JaiylymApp.S.pl.algorithm), "fair-optimal-v2");
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
  for (const re of [/Если все стада у села/, /Предлагаемый план/, /Быстрый алгоритм/, /Худшее хозяйство/, /водопой на/, /Скота на 20 % больше/, /доказуемыми/, /Точн|точная граница/i]) assert.match(wi, re);
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
  // переход по хэшу отрисовывается асинхронно — ждём страницу, а не читаем её сразу (иначе гонка, особенно в WebKit)
  await page.waitForFunction(() => /Жазылған сұхбаттар/.test((document.querySelector("#rsPage") || {}).textContent || ""), null, { timeout: 10000 });
  assert.match(await page.textContent("#rsPage"), /Жазылған сұхбаттар: 0/);
  for (const route of ["research", "map?lat=43.02&lon=79.22&name=Кеген", "settings", "about", "home"]) {
    await page.goto(base + "#/" + route);
    await page.waitForTimeout(300);
    const wide = await page.evaluate(() => {
      const W = document.documentElement.clientWidth;
      if (document.documentElement.scrollWidth <= W + 1) return null;
      return [...document.querySelectorAll("body *")].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > W + 1 && getComputedStyle(e).position !== "fixed"; })
        .slice(-6).map(e => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}.${String(e.className).split(" ")[0]} right=${Math.round(e.getBoundingClientRect().right)} «${(e.textContent || "").trim().slice(0, 40)}»`).join("; ") + ` (ширина ${W}, страница ${document.documentElement.scrollWidth})`;
    });
    assert.equal(wide, null, `${label}: #/${route} шире экрана: ${wide}`);
  }
  // телефон: поля не мельче 16px (иначе iPhone увеличивает страницу при вводе), кнопки и поля не меньше 40px по высоте
  if (/телефон/.test(label)) for (const route of ["map?lat=43.02&lon=79.22&name=Кеген", "ai", "settings", "research", "scenarios"]) {
    await page.goto(base + "#/" + route);
    await page.waitForTimeout(300);
    const bad = await page.evaluate(() => {
      const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width && r.height && s.visibility !== "hidden" && s.display !== "none"; };
      const name = e => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""} «${(e.innerText || e.value || "").trim().slice(0, 30)}»`;
      const out = [];
      for (const e of document.querySelectorAll("input, select, textarea")) if (vis(e) && !/checkbox|radio|range|hidden/.test(e.type) && parseFloat(getComputedStyle(e).fontSize) < 16) out.push("шрифт " + name(e));
      for (const e of document.querySelectorAll("main button, main a.btn, main select, main input:not([type=checkbox]):not([type=radio]), .topbar button, .topbar a.btn"))
        if (vis(e) && !e.closest(".leaflet-control-attribution") && e.getBoundingClientRect().height < 40) out.push(`высота ${Math.round(e.getBoundingClientRect().height)} ` + name(e));
      return out.slice(0, 8);
    });
    assert.deepEqual(bad, [], `${label}: #/${route} мелкие поля или кнопки`);
  }
  assert.deepEqual(errors, [], label + ": ошибки JavaScript");
}

// Офлайн: после первого визита service worker кэширует оболочку и пример Кегена; без сети сайт открывается,
// Кеген считается, а новое село честно говорит «нет сети», а не ломается.
async function offline(browser, label) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await stubNetwork(page);
  await page.goto(base + "#/home");
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 30000 });
  await page.waitForFunction(async () => (await caches.keys()).length > 0 && !!(await caches.match("data/plots.js")) && !!(await caches.match("data/beskol.png")), null, { timeout: 30000 });
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector("#heroQ");
  assert.equal(await page.isVisible("#netbar"), true, label + ": показана полоса «нет сети»");
  await page.goto(base + "#/map?lat=43.02&lon=79.22&name=Кеген");
  await page.waitForFunction(() => window.JaiylymApp && window.JaiylymApp.S.D && window.JaiylymApp.S.pl);
  assert.equal(await page.evaluate(() => window.JaiylymApp.S.plots.length), 16, label + ": Кеген считается без сети");
  await page.goto(base + "#/map?lat=54.77515&lon=69.09779&name=Бесколь&demo=1");
  await page.waitForFunction(() => window.JaiylymApp.S.D && window.JaiylymApp.S.D.village.name === "Бесколь" && window.JaiylymApp.S.pl);
  await page.goto(base + "#/map?lat=50.1&lon=70.1&name=Новое");
  await page.waitForFunction(() => !document.querySelector("#status").hidden, null, { timeout: 10000 });
  assert.match(await page.textContent("#status"), /Нет сети|Желі жоқ/, label + ": новое село без сети — понятное сообщение");
  assert.deepEqual(errors, [], label + ": ошибки JavaScript без сети");
  await ctx.close();
}

/** Вход по выбору: логин и пароль (регистрация) или Telegram. Сервер подменён: регистрация, занятый логин, профиль. */
async function accountFlow(page, label) {
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await stubNetwork(page);
  const user = { uid: "aTest", name: "Айгерим", login: "+77011234567", via: "password", role: "farmer", created: "2026-11-24T10:00:00Z", farm: null, pastures: [], villages: [] };
  let regBody = null;
  const reqs = [], logs = [];
  page.on("request", r => { if (/__api|onrender/.test(r.url())) reqs.push(r.method() + " " + r.url().replace(/^https?:\/\/[^/]+/, "")); });
  page.on("console", m => logs.push(m.type() + ": " + m.text().slice(0, 150)));
  // сервер — на том же адресе, что и сайт (/__api): WebKit в Playwright не перехватывает предварительный CORS-запрос к другому домену
  await page.addInitScript(() => { window.JAIYLYM_API_URL = location.origin + "/__api"; });
  const reply = (r, status, data) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
  await page.route(/\/__api\//, r => reply(r, 404, {}));   // остальное — 404 (маршруты ниже приоритетнее: Playwright берёт последний)
  await page.route(/\/__api\/auth\/register/, r => {
    regBody = JSON.parse(r.request().postData());
    return regBody.login === "taken_login" ? reply(r, 409, { error: "занят", field: "login" }) : reply(r, 200, { status: "ok", token: "t".repeat(40), user }); });
  await page.route(/\/__api\/(api\/me|auth\/logout)$/, r => reply(r, 200, r.request().url().endsWith("/api/me") ? user : { ok: true }));
  await page.route(/\/__api\/auth\/start/, r => reply(r, 200, { nonce: "n".repeat(30), code: "4821", link: "https://t.me/JAIYLYM_bot?start=login_x" }));
  await page.goto(base + "#/home");
  await page.waitForSelector("#accountBtn");
  await page.click("#accountBtn");
  await page.waitForSelector("#loginDlg[open] #pwForm");
  assert.match(await page.textContent("#loginDlg"), /Войти через Telegram/, label + ": Telegram — второй способ");
  assert.match(await page.textContent("#loginDlg"), /Telegram не обязателен/);
  // регистрация: проверка до сервера, затем занятый логин, затем успех
  await page.click('.acct-tabs [data-mode="register"]');
  await page.fill('#pwForm [name="name"]', "Айгерим");
  await page.fill('#pwForm [name="login"]', "taken_login");
  await page.fill('#pwForm [name="password"]', "123");
  await page.click("#pwGo");
  assert.match(await page.textContent("#pwErr"), /не короче 8/, label + ": короткий пароль — сразу, без сервера");
  await page.fill('#pwForm [name="password"]', "pastbishe-2026");
  await page.click("#pwGo");
  await page.waitForFunction(() => /уже зарегистрирован/.test(document.querySelector("#pwErr").textContent), null, { timeout: 15000 }).catch(async e => {
    const st = await page.evaluate(() => ({ err: document.querySelector("#pwErr").textContent, hidden: document.querySelector("#pwErr").hidden, go: document.querySelector("#pwGo").textContent, api: window.JAIYLYM_API_URL }));
    throw new Error(label + ": нет ошибки «занят»: " + JSON.stringify(st) + " запросы: " + reqs.join(" ") + " консоль: " + logs.join(" | "));
  });
  await page.click("#pwShow");
  assert.equal(await page.getAttribute('#pwForm [name="password"]', "type"), "text", label + ": «Показать» пароль");
  await page.fill('#pwForm [name="login"]', "8 701 123 45 67");
  await page.click("#pwGo");
  await page.waitForFunction(() => !document.querySelector("#loginDlg").open);
  assert.equal(regBody.name, "Айгерим");
  assert.match(await page.textContent("#accountLabel"), /Айгерим/, label + ": после регистрации — имя в шапке");
  // профиль: логин вместо Telegram ID
  await page.goto(base + "#/profile");
  await page.waitForFunction(() => /\+77011234567/.test(document.querySelector("#prPage").textContent));
  // выход → окно входа → Telegram и назад
  await page.click("#prLogout");
  await page.waitForFunction(() => /Вход|Войти/.test(document.querySelector("#accountLabel").textContent));
  await page.click("#accountBtn");
  await page.waitForSelector("#loginDlg[open] #tgGo");
  await page.click("#tgGo");
  await page.waitForSelector("#lgBack");
  await page.click("#lgBack");
  await page.waitForSelector("#loginDlg[open] #pwForm");
  assert.deepEqual(errors, [], label + ": ошибки JavaScript");
}

for (const name of BROWSERS) {
  const skip = !pw && "playwright не установлен";
  // WebKit в Playwright при эмуляции офлайна не грузит страницу из service worker («internal error» на reload/goto,
  // хотя service worker и кэш установлены) — это ограничение тестового движка, настоящий Safari отдаёт страницу из кэша.
  const offSkip = skip || (name === "webkit" && "Playwright WebKit: эмуляция офлайна не работает с service worker");
  test(`${name}: офлайн — оболочка и Кеген из кэша, новое село — «нет сети»`, { skip: offSkip, timeout: 120000 }, async () => {
    const b = await pw[name].launch();
    try { await offline(b, name + " офлайн"); } finally { await b.close(); }
  });
  test(`${name}: новичок — выбор села, а не чужой пример; новое село не показывает прежнее`, { skip, timeout: 60000 }, async () => {
    const b = await pw[name].launch();
    try { const dev = Object.assign({}, pw.devices["iPhone 13"]); if (name !== "webkit") delete dev.defaultBrowserType;
      const ctx = await b.newContext(Object.assign({}, dev, { serviceWorkers: "block" }));
      await newcomer(await ctx.newPage(), name + " новичок"); } finally { await b.close(); }
  });
  test(`${name}: вход по выбору — логин и пароль или Telegram`, { skip, timeout: 60000 }, async () => {
    const b = await pw[name].launch();
    try { const dev = Object.assign({}, pw.devices["iPhone 13"]); if (name !== "webkit") delete dev.defaultBrowserType;
      // service worker сайта сам делает запросы — их Playwright не перехватывает (в WebKit заглушка сервера не срабатывала)
      await accountFlow(await (await b.newContext(Object.assign(dev, { serviceWorkers: "block" }))).newPage(), name); } finally { await b.close(); }
  });
  test(`${name}: ИИ-чат по прямой ссылке видит село`, { skip, timeout: 60000 }, async () => {
    const b = await pw[name].launch();
    try { await chatWithoutMap(await (await b.newContext()).newPage(), name); } finally { await b.close(); }
  });
  test(`${name}: путь пользователя на компьютере`, { skip, timeout: 180000 }, async () => {
    const b = await pw[name].launch();
    try { const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, serviceWorkers: "block" }); await journey(await ctx.newPage(), name + " ПК"); }
    finally { await b.close(); }
  });
  test(`${name}: путь пользователя на телефоне (iPhone 13)`, { skip, timeout: 180000 }, async () => {
    const b = await pw[name].launch();
    const dev = Object.assign({}, pw.devices["iPhone 13"]);
    if (name !== "webkit") delete dev.defaultBrowserType;
    try { const ctx = await b.newContext(Object.assign(dev, { acceptDownloads: true, serviceWorkers: "block" })); await journey(await ctx.newPage(), name + " телефон"); }
    finally { await b.close(); }
  });
}
