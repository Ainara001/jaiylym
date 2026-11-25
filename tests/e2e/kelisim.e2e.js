// Келісім в настоящем браузере: организатор (ПК) и три двора (телефоны) от создания до протокола, с настоящим сервером api.js.
// Сайт и API на одном адресе; внешняя сеть отключена. Запуск: npm run test:e2e
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
let pw = null;
try { pw = require("playwright"); } catch (_) {}
const BROWSERS = (process.env.JAIYLYM_BROWSERS || "chromium").split(",").map(s => s.trim()).filter(Boolean);
const { createApi } = require("../../api.js");
const { memoryKv } = require("../../store.js");
const { loadExamples } = require("../../data");

const WEB = path.join(__dirname, "..", "..", "web"), SHOTS = process.env.KEL_SHOTS || "";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2" };
const vkey = (lat, lon) => `${(+lat).toFixed(3)},${(+lon).toFixed(3)}`;
let server, base;

test.before(async () => {
  const villages = Object.fromEntries(loadExamples().map(D => [vkey(D.village.lat, D.village.lon), { data: D }]));
  const api = createApi({ getState: () => ({ users: {}, villages }), save() {}, kv: memoryKv(), vkey, botUsername: "x", onFarmSaved() {}, allowedOrigins: [], kelisimSecret: "s" });
  let ip = 0;
  server = http.createServer(async (req, res) => {
    const u = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (u.startsWith("/api/")) { req.headers["x-forwarded-for"] = "10.2.0." + (ip++ % 250); if (!(await api.handle(req, res))) res.writeHead(404).end(); return; }
    const file = path.join(WEB, u === "/" ? "index.html" : u);
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) { server.closeAllConnections(); server.close(); } });

async function open(b, errors, opts, label) {
  const ctx = await b.newContext(Object.assign({ serviceWorkers: "block", acceptDownloads: true }, opts));
  await ctx.addInitScript(a => { window.JAIYLYM_API_URL = a; }, base);
  const page = await ctx.newPage();
  page.on("pageerror", e => errors.push(label + ": " + e.message));
  await page.route(u => !u.href.startsWith(base), r => r.abort());
  return page;
}
let nShot = 0;
async function check(page, label) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), label + ": без горизонтальной прокрутки");
  const small = await page.evaluate(() => [...document.querySelectorAll("#kelPage .btn, #kelPage .chip, #kelPage summary, dialog[open] .btn, #kelPage input:not([type=checkbox]):not([type=radio]):not([hidden]), #kelPage select")]
    .filter(e => e.offsetParent && innerWidth < 600 && e.getBoundingClientRect().height < 43.5).map(e => e.className + "|" + e.textContent.trim().slice(0, 30)));
  assert.deepEqual(small, [], label + ": цели нажатия от 44 px");
  assert.equal(/kel\.[a-z]|undefined|NaN|\[object/.test(await page.innerText("#kelPage")), false, label + ": все тексты на месте");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${String(++nShot).padStart(2, "0")}-${label.replace(/[^\wа-яё]+/gi, "_")}.png`), fullPage: true });
}

async function flow(b, name) {
  const errors = [], phone = { viewport: { width: 360, height: 740 }, isMobile: name !== "firefox", hasTouch: true, deviceScaleFactor: 2 };
  // 1. организатор: пример → согласование
  const org = await open(b, errors, { viewport: { width: 1280, height: 900 } }, "орг");
  await org.goto(base + "/#/kelisim");
  await org.click("#kelDemo");
  await org.waitForSelector("#kelCreate");
  assert.ok(await org.isVisible("text=Стада из примера условные"));
  assert.match(await org.innerText("#kelPage"), /Где селу можно пасти[\s\S]*825 га/);
  // оставляем три двора: первый без скота — внесёт сам
  while (await org.$$eval("#kelRows .krow", x => x.length) > 3) await org.click("[data-rmrow='0']");
  const names = ["Двор у моста", "Двор Сары-Арка", "Двор у озера"];
  for (let i = 0; i < 3; i++) await org.fill(`#kelRows .krow:nth-child(${i + 1}) [data-f=name]`, names[i]);
  await org.click("#kelRows .krow:nth-child(1) summary");
  for (const s of ["sheep", "goats", "cattle", "horses"]) await org.fill(`#kelRows .krow:nth-child(1) [data-h=${s}]`, "0");
  await org.click("#kelRows .krow:nth-child(3) summary");
  await org.uncheck("#kelRows .krow:nth-child(3) [data-f=daily]");
  await org.fill("#kelRows .krow:nth-child(3) [data-h=sheep]", "9000");          // корма не хватит: возражения заденут соседей
  // участник — хозяйство или общее стадо; сколько хозяев спрашиваем только у общего стада
  const row1 = "#kelRows .krow:nth-child(1) ";
  assert.equal(await org.inputValue(row1 + "[data-f=owners]"), "8");
  await org.click(row1 + ".chip:has([data-k=farm])");
  assert.equal(await org.isVisible(row1 + "[data-f=owners]"), false);
  assert.match(await org.innerText(row1 + "summary"), /Хозяйство\. Скот: внесёт сам/);
  await org.click(row1 + ".chip:has([data-k=common])");
  await org.fill(row1 + "[data-f=owners]", "12");
  assert.equal(await org.$eval("#kelSeason", e => e.options.length), 2);
  await check(org, "орг новое");
  await org.click("#kelCreate");
  await org.waitForSelector("#kStart");
  assert.match(org.url(), /#\/kelisim\?id=[\w-]+&o=[\w-]+$/);
  assert.match(await org.innerText("#kelPage"), /Ещё не внесли скот: Двор у моста/);
  assert.match(await org.innerText("#kelPage"), /Сохраните ссылку организатора/);
  // 2. личные ссылки и QR
  const links = [];
  for (let i = 0; i < 3; i++) {
    await org.click(`.kyard:nth-of-type(${i + 1}) [data-link]`);
    await org.waitForSelector("dialog[open] .kqr svg");
    links.push((await org.innerText("dialog[open] .klink")).trim());
    if (!i) await check(org, "орг ссылка");
    await org.click("dialog[open] .modal-x button");
  }
  assert.equal(new Set(links).size, 3);
  // 3. двор вносит скот
  const d1 = await open(b, errors, phone, "двор1"), d2 = await open(b, errors, phone, "двор2"), d3 = await open(b, errors, phone, "двор3");
  await d1.goto(links[0]);
  await d1.waitForSelector("#kelJoin");
  assert.equal(await d1.isVisible(".bottomnav"), false, "у двора — одна страница без лишних разделов");
  await check(d1, "двор скот");
  await d1.click("#kelJoin button");
  await d1.waitForSelector(".toast.err");
  await d1.fill("#kelJoin [data-h=sheep]", "700");
  await d1.fill("#kelJoin [data-h=cattle]", "40");
  await d1.click("#kelJoin button");
  await d1.waitForSelector(".kdone");
  await org.reload();
  await org.waitForSelector("#kStart");
  assert.match(await org.innerText(".kyard:nth-of-type(1)"), /отвечает пастух[\s\S]*700[\s\S]*внёс участник/);
  await org.click(".kyard:nth-of-type(1) [data-conf]");
  await org.waitForFunction(() => /подтвердил организатор/.test(document.querySelector(".kyard").innerText));
  // 4. план
  await org.click("#kStart");
  await org.waitForSelector("#kClose");
  assert.match(await org.innerText(".kcount"), /Согласны 0 из 3, возражают 0, ждём 3/);
  await check(org, "орг план");
  // 5. двор 1 видит участок, сроки, причину — и соглашается
  await d1.reload();
  await d1.waitForSelector("#kelAgree");
  assert.match(await d1.innerText(".kroute"), /\d\d\.\d\d – \d\d\.\d\d/);
  assert.match(await d1.innerText(".khead"), /сезон 20\d\d \(01\.05–/);
  assert.match(await d1.innerText("#kelPage"), /Общее стадо, хозяев: 12, отвечает пастух[\s\S]*Трава взята по снимкам 2026 года/);
  assert.match(await d1.innerText(".kfeed"), /Не хватает примерно [\d ,]+ т сена/);
  await check(d1, "двор план");
  await d1.click("#kelAgree");
  await d1.waitForSelector("#kelAns .kdone");
  // 6. двор 2 смотрит план по-казахски, возражает; последствия считаются без сети
  await d2.goto(links[1]);
  await d2.waitForSelector("#kelAgree");
  await d2.click('.langsw [data-lang="kk"]');
  await d2.waitForFunction(() => /Келісемін/.test(document.querySelector("#kelAgree").innerText));
  await check(d2, "двор план kk");
  await d2.click('.langsw [data-lang="ru"]');
  await d2.waitForFunction(() => /Согласен/.test(document.querySelector("#kelAgree").innerText));
  await d2.click("#kelObj");
  await d2.check('[name=kMode][value=avoid]', { force: true });
  await d2.waitForSelector("[name=kReason]", { state: "attached" });
  await d2.click("#kPrev");
  await d2.waitForSelector("#kObjErr:not([hidden])");
  if (await d2.$("[name=kPlot]")) { await d2.click(".kobj .chip:has([name=kPlot])"); }
  await d2.click(".kobj .chip:has([value=no_grass])");
  await d2.waitForSelector("[name=kSeen]");
  // наблюдение сверяется со снимком только за то же время
  assert.match(await d2.innerText("#kObsH"), /Дата не указана/);
  const seen = async d => { await d2.fill("[name=kSeen]", d); await d2.locator("[name=kSeen]").blur(); };
  await seen("2026-11-20");
  await d2.waitForFunction(() => /другое время/.test(document.querySelector("#kObsH").innerText));
  await seen("2026-07-20");
  await d2.waitForFunction(() => /Проверить на месте[\s\S]*снимке за 25\.07\.2026[\s\S]*Расчёт от этого не меняется/.test(document.querySelector("#kObsH").innerText));
  await d2.route(/\/api\//, r => r.abort());
  await d2.click("#kPrev");
  await d2.waitForSelector(".kverd");
  await check(d2, "двор последствия");
  // нет связи — возражение не теряется
  await d2.click("#kSend");
  await d2.waitForSelector(".toast.err");
  await d2.waitForSelector("#kSend");
  await d2.unroute(/\/api\//);
  await d2.click("#kSend");
  await d2.waitForSelector(".kwait");
  assert.match(await d2.innerText(".kwait"), /ждёт решения[\s\S]*мало травы/);
  // 7. двор 3 заявляет больше скота: потеряют и соседи
  await d3.goto(links[2]);
  await d3.waitForSelector("#kelObj");
  await d3.click("#kelObj");
  // «другой участок»: считается сразу
  await d3.check('[name=kMode][value=prefer]', { force: true });
  await d3.waitForSelector("[name=kPlot]", { state: "attached" });
  await d3.click(".kobj .chip:has([name=kPlot])");
  await d3.click("#kPrev");
  await d3.waitForSelector(".kverd");
  await check(d3, "двор другой участок");
  await d3.check('[name=kMode][value=herd]', { force: true });
  await d3.waitForSelector("#kHerd");
  await d3.click("#kPrev");
  await d3.waitForSelector("#kObjErr:not([hidden])");
  await d3.fill("#kHerd [data-h=sheep]", "14000");
  await d3.click("#kPrev");
  await d3.waitForSelector(".kv-others");
  assert.match(await d3.innerText("#kEff"), /Потерю делят все[\s\S]*Теряют корм[\s\S]*Соседи не теряют/);
  await check(d3, "двор больше скота");
  await d3.click("#kSend");
  await d3.waitForSelector(".kwait");
  // 8. организатор принимает возражение двора 2, второе отклоняет с пояснением
  await org.reload();
  await org.waitForSelector(".kprop");
  assert.equal(await org.$$eval(".kprop", x => x.length), 2);
  await check(org, "орг возражения");
  await org.click(".kprop:has-text('мало травы') [data-acc]");
  await org.waitForFunction(() => document.querySelectorAll(".kprop").length === 1);
  await check(org, "орг после решения");
  await org.fill(".kprop [data-note]", "Туда гонит другое село");
  await org.click(".kprop [data-dec]");
  await org.click(".kprop [data-dec]");
  await org.waitForFunction(() => !document.querySelector(".kprop"));
  // 9. двор 2: план изменился — подтвердить заново; двор 3 видит отказ; старый ответ на новую версию не проходит молча
  await d2.reload();
  await d2.waitForSelector("#kelAgree");
  assert.match(await d2.innerText("#kelPage"), /План изменился \(версия 2\)\. Подтвердите заново[\s\S]*Ваша просьба принята/);
  await check(d2, "двор план изменился");
  await d2.click("#kelAgree");
  await d2.waitForSelector("#kelAns .kdone");
  await d3.reload();
  await d3.waitForSelector(".kwait");
  assert.match(await d3.innerText(".kwait"), /Отклонено[\s\S]*Туда гонит другое село/);
  await check(d3, "двор отказ");
  await d3.click("#kelAgree");
  await d3.waitForSelector("#kelAns .kdone");
  await d1.reload();
  await d1.waitForSelector("#kelAns");
  if (await d1.$("#kelAgree")) { await d1.click("#kelAgree"); await d1.waitForSelector("#kelAns .kdone"); }
  // 10. потерянная ссылка: новая выпущена, старая не действует
  await org.reload();
  await org.waitForSelector(".kyard");
  await org.click(".kyard:nth-of-type(3) [data-link]");
  await org.click("dialog[open] summary");
  await org.click("#kNewL"); await org.click("#kNewL");
  await org.waitForFunction(u => { const l = document.querySelector("dialog[open] .klink"); return l && l.textContent.trim() !== u; }, links[2]);
  await org.click("dialog[open] .modal-x button");
  await d3.reload();
  await d3.waitForSelector("#kelRe");
  assert.match(await d3.innerText("#kelPage"), /Ссылка больше не действует/);
  // 11. офлайн: двор видит последний план с пометкой
  await d2.route(/\/api\//, r => r.abort());
  await d2.reload();
  await d2.waitForSelector("#kelBar:not([hidden])");
  assert.match(await d2.innerText("#kelBar"), /Нет связи/);
  assert.ok(await d2.isVisible(".kroute"));
  await d2.unroute(/\/api\//);
  const orgUrl = org.url();
  // 12. все согласны → закрыть → протокол PDF
  assert.match(await org.innerText(".kcount"), /Согласны 3 из 3/);
  await org.click("#kClose"); await org.click("#kClose");
  await org.waitForSelector("#kelPdf");
  assert.match(await org.innerText("#kelPage"), /Все участники согласны/);
  const [dl] = await Promise.all([org.waitForEvent("download", { timeout: 60000 }), org.click("#kelPdf")]);
  assert.match(dl.suggestedFilename(), /^jaiylym-kelisim-.+\.pdf$/);
  const file = await dl.path();
  assert.ok(fs.statSync(file).size > 20000, "протокол не пустой");
  if (SHOTS) fs.copyFileSync(file, path.join(SHOTS, "protocol.pdf"));
  await check(org, "орг протокол");
  await d1.reload();
  await d1.waitForSelector("#kelPdf");
  await check(d1, "двор закрыто");
  // наблюдение на карте: три мнения об участке, число не изменилось; ИИ получает его без имён
  const pid = /\(([БД]-[СВЮЗ]+)\)/.exec(await org.textContent("details[data-d=obs] .kvar b"))[1];
  await org.setViewportSize({ width: 360, height: 740 });
  await org.goto(base + "/#/map?lat=54.77515&lon=69.09779&name=Бесколь&demo=1&plot=" + encodeURIComponent(pid));
  await org.waitForSelector("dialog[open] .obs3-check");
  assert.match(await org.innerText(".obs3"), /Три мнения[\s\S]*трава[\s\S]*мало травы[\s\S]*проверьте на месте/);
  const ai = await org.evaluate(() => window.JaiylymApp.aiContext()["наблюдения_людей"]);
  assert.deepEqual([ai.length, ai[0]["участок"], ai[0]["вывод"]], [1, pid, "проверить на месте"]);
  assert.equal(/Сары-Арка/.test(JSON.stringify(ai)), false, "имя двора в ИИ не уходит");
  const caps = await org.evaluate(id => [window.Jaiylym.plotCapacity(window.JaiylymApp.S.plots.find(p => p.id === id), window.JaiylymApp.S.P).au_season, window.JaiylymApp.S.plots.find(p => p.id === id).ndvi], pid);
  assert.equal(caps[1], require("../../data").loadExamples()[0].plots.find(p => p.id === pid).ndvi, "наблюдение не меняет измерение");
  assert.ok(await org.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (SHOTS) await org.screenshot({ path: path.join(SHOTS, "карта-три-мнения.png") });
  // 13. телефон организатора и список; RU/KZ на нём
  const o2 = await open(b, errors, phone, "орг телефон");
  await o2.goto(orgUrl);
  await o2.waitForSelector(".kyard");
  await check(o2, "орг телефон");
  await o2.click('.langsw [data-lang="kk"]');
  await o2.waitForFunction(() => /Қатысушылар/.test(document.querySelector("#kelPage").innerText));
  await check(o2, "орг телефон kk");
  await o2.goto(base + "/#/kelisim");
  await o2.waitForSelector(".ksteps");
  await check(o2, "начало kk");
  assert.deepEqual(errors, [], "ошибки JavaScript");
}

/** Действия организатора на телефоне: правило, правка скота, новый двор после начала, сверка, файл → удаление → восстановление, срок. */
async function organizer(b, name) {
  const errors = [], phone = { viewport: { width: 360, height: 740 }, hasTouch: true, deviceScaleFactor: 2 };
  const org = await open(b, errors, phone, "орг");
  await org.goto(base + "/#/kelisim?new=1");
  await org.waitForSelector("#kelDemo");                                     // село не выбрано — начало, а не ошибка
  await org.click("#kelDemo");
  await org.waitForSelector("#kelCreate");
  await org.fill("#kelRows .krow:nth-child(2) [data-f=name]", await org.inputValue("#kelRows .krow:nth-child(1) [data-f=name]"));
  await org.click("#kelCreate");
  assert.match(await org.innerText("#kelErr"), /уже есть/);
  await org.fill("#kelRows .krow:nth-child(2) [data-f=name]", "8 701 123 45 67");
  await org.click("#kelCreate");
  await org.waitForFunction(() => /телефон/.test(document.querySelector("#kelErr").innerText));
  await org.fill("#kelRows .krow:nth-child(2) [data-f=name]", "Двор <b>у реки</b>");
  await check(org, "орг новое телефон");
  await org.click("#kelCreate");
  await org.waitForSelector("#kStart");
  assert.equal(await org.$$eval(".kyard b b", x => x.length), 0, "разметка из имени не исполняется");
  await org.click("#kStart");
  await org.waitForSelector("#kClose");
  // правило
  await org.click("details[data-d=plan] summary");
  await org.click("details[data-d=plan] .kopt:nth-of-type(2)");
  await org.click("#kRuleGo");
  await org.waitForFunction(() => /версия 2/.test(document.querySelector("details[data-d=plan] summary").innerText));
  await check(org, "орг правило");
  // правка двора и новый двор
  await org.click(".kyard:nth-of-type(1) [data-edit]");
  await org.waitForSelector("#kEd");
  await check(org, "орг правка");
  await org.fill("#kEd [data-h=sheep]", "300");
  await org.click("#kEd button.kbig");
  await org.waitForFunction(() => !document.querySelector("dialog[open]") && /овцы 300/.test(document.querySelector(".kyard").innerText));
  await org.fill("#kAddF input", "Новый двор");
  await org.click("#kAddF button");
  await org.waitForSelector("dialog[open] .kqr svg");
  await org.click("dialog[open] .modal-x button");
  assert.match(await org.innerText(".kyard:last-of-type"), /Новый двор/);
  // сверка с числом акимата и срок
  await org.click("details[data-d=set] summary");
  await org.fill("#kSet [name=of_sheep]", "10");
  await org.fill("#kSet [name=deadline]", "2020-01-01");
  await org.click("#kSet button");
  await org.waitForSelector(".toast.err");
  await org.fill("#kSet [name=deadline]", "2099-06-01");
  await org.click("#kSet button");
  await org.waitForFunction(() => /01\.06\.2099/.test(document.querySelector(".khead").innerText));
  assert.match(await org.innerText("#kelPage"), /Участники внесли больше/);
  // файл → удалить → восстановить
  const url = org.url();
  const [dl] = await Promise.all([org.waitForEvent("download"), org.click("#kExp")]);
  const file = await dl.path();
  await org.click("#kDel"); await org.click("#kDel");
  await org.waitForSelector("#kelDemo");
  await org.goto(url);
  await org.waitForFunction(() => /не найдено/.test(document.querySelector("#kelPage").innerText));
  await check(org, "орг не найдено");
  await org.setInputFiles("#kelFile", file);
  await org.waitForSelector("#kClose");
  assert.match(await org.innerText("#kelPage"), /восстановлено из файла, подпись файла верна/i);
  // ссылок дворов в этом браузере больше нет — предлагаем выпустить новую
  await org.click(".kyard:nth-of-type(1) [data-link]");
  await org.waitForSelector("#kNewL");
  await org.click("#kNewL");
  await org.waitForSelector("dialog[open] .kqr svg");
  assert.deepEqual(errors, [], "ошибки JavaScript");
}

for (const name of BROWSERS) {
  test(`${name}: Келісім — организатор на телефоне`, { skip: !pw && "playwright не установлен", timeout: 120000 }, async () => {
    const b = await pw[name].launch();
    try { await organizer(b, name); } finally { await b.close(); }
  });
  test(`${name}: Келісім — три двора от создания до протокола`, { skip: !pw && "playwright не установлен", timeout: 180000 }, async () => {
    const b = await pw[name].launch();
    try { await flow(b, name); } finally { await b.close(); }
  });
}
