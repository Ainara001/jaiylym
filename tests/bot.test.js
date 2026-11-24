// Тексты бота: тревога только при подтверждённом снижении, демо-стада помечены, «нет данных» вместо 0 %.
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os"), path = require("path");
process.env.BOT_STATE_FILE = path.join(os.tmpdir(), `jaiylym-bot-test-${process.pid}.json`);
delete process.env.REDIS_URL;
const bot = require("../bot.js");
bot.setTest();

const sent = [];
const send = async (chat, text, kb) => { sent.push({ chat: String(chat), text, kb }); };
const last = () => sent[sent.length - 1].text;

test("одно снижение NDVI — мягкое сообщение, два подряд — тревога", () => {
  const v = bot.getState().villages["43.020,79.220"];
  const p = v.data.plots[0];
  assert.match(bot.alertText(v, p, 0.22, [0.31, 0.30, 0.31], "2026-08-29"), /^Возможно снижение травы/);
  assert.match(bot.alertText(v, p, 0.21, [0.31, 0.30, 0.31, 0.23], "2026-09-03"), /^Внимание: трава убывает \(видно на двух снимках подряд\)/);
  assert.match(bot.alertText(v, p, 0.30, [], "2026-08-29"), /первое наблюдение/);
});

test("карта села и план: демо-стада помечены, статус плана сказан словами", async () => {
  await bot.handle({ message: { chat: { id: 901 }, from: { id: 901 }, text: "/start" } }, send);
  await bot.handle({ message: { chat: { id: 901 }, from: { id: 901 }, text: "Кеген" } }, send).catch(() => {});
  const c = bot.getState().chats["901"];
  c.village = "43.020,79.220";
  await bot.handle({ message: { chat: { id: 901 }, from: { id: 901 }, text: "Карта села" } }, send);
  assert.match(last(), /Стад в расчёте пока нет/, "демо-стада не входят в расчёт, пока человек сам их не выбрал");
  assert.doesNotMatch(last(), /демо/);
  await bot.handle({ callback_query: { id: "q", data: "herd:asan", message: { chat: { id: 901 } } } }, send);
  await bot.handle({ message: { chat: { id: 901 }, from: { id: 901 }, text: "Карта села" } }, send);
  assert.match(last(), /демо: 5/);
  assert.match(last(), /условных демо-стад/);
  await bot.handle({ message: { chat: { id: 901 }, from: { id: 901, first_name: "Тест" }, text: "500 овец 20 коров" } }, send);
  assert.match(last(), /\nПо введённым условиям возможен вариант распределения/);
  assert.match(last(), /оценка модели/);
  await bot.handle({ message: { chat: { id: 901 }, from: { id: 901 }, text: "Водопой" } }, send);
  assert.match(last(), /не рекомендация строить скважину/);
});

test("неизвестная команда — подсказка, а не молчание", async () => {
  await bot.handle({ message: { chat: { id: 901 }, from: { id: 901 }, text: "/foo" } }, send);
  assert.match(last(), /Не понял/);
});

test("готовые примеры: Бесколь первый, все сёла полные (16 участков, прошлое лето, ряд, зоны)", () => {
  const { loadExamples } = require("../data");
  const ex = loadExamples();
  assert.deepEqual(ex.map(d => d.village.name), ["Бесколь", "Кеген"]);
  for (const d of ex) {
    assert.equal(d.plots.length, 16, d.village.name);
    assert.ok(d.plots.every(p => p.ndvi > -1 && p.ndvi < 1 && p.pasture_ha > 0), d.village.name + ": трава и площадь по каждому участку");
    assert.equal(d.prev_season.year, d.source.year - 1);
    assert.equal(d.multiyear.seasons.length, 8);
    assert.equal(d.nograze.status, "ok");
    const v = bot.getState().villages[`${d.village.lat.toFixed(3)},${d.village.lon.toFixed(3)}`];
    assert.ok(v && v.example, "бот открывает пример без расчёта");
  }
});

test("ИИ не ответил — бот присылает шаблон из расчёта с маршрутом и причиной выбора участка", async () => {
  const AI = require("../ai.js");
  const orig = AI.ask, key = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test";
  AI.ask = async () => ({ ok: false, error: "overloaded" });
  try {
    const c = bot.getState().chats["901"]; c.village = "43.020,79.220";
    await bot.handle({ message: { chat: { id: 901 }, from: { id: 901, first_name: "Тест" }, text: "почему моё стадо пасётся именно там?" } }, send);
    const t = last();
    assert.match(t, /ИИ сейчас недоступен \(серверы ИИ перегружены\)/);
    assert.match(t, /Маршруты по плану:/);
    assert.match(t, /почему: /);
    assert.doesNotMatch(t, /\*\*/);
  } finally { AI.ask = orig; if (key === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = key; }
});

test("ИИ в боте: многолетний ряд в данных, поиск в интернете включён, источники в конце ответа", async () => {
  const AI = require("../ai.js");
  const orig = AI.ask, key = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test";
  let seen = null;
  AI.ask = async o => { seen = o; return { ok: true, text: "**Дождь** ожидается в среду [интернет].", model: "stub", searches: 1,
    sources: [{ url: "https://meteo.example/kegen", title: "Прогноз" }] }; };
  try {
    const c = bot.getState().chats["901"]; c.village = "43.020,79.220";
    await bot.handle({ message: { chat: { id: 901 }, from: { id: 901, first_name: "Тест" }, text: "какая погода будет в Кегене на неделе?" } }, send);
    assert.equal(seen.search, true, "поиск разрешён в пределах дневного лимита");
    assert.match(seen.system, /Поиск в интернете/);
    assert.match(seen.input, /многолетний_ряд/);
    assert.match(seen.input, /вывод_по_селу/);
    assert.match(seen.input, /^Сегодня: \d{1,2} [а-я]+ 20\d\d/);
    // участки — с вычетом жилья и ферм, как в плане: Б-С 320 − 47,1 = 272,9 га (313 овец, а не 367)
    const ctx = JSON.parse(seen.input.match(/Данные села \(JSON\): (\{.*\})\n\nВопрос/s)[1]);
    const bs = ctx.участки.find(p => p.id === "Б-С");
    assert.equal(bs.пастбищный_покров_га_спутник, 320);
    assert.equal(Math.round(bs.кормовая_площадь_га * 10) / 10, 272.9);
    assert.match(bs.как_рассчитано, /320/);
    assert.match(seen.input, /ПОИСК: вопрос о свежих внешних сведениях/, "вопрос о погоде — прямое указание искать");
    const t = last();
    assert.match(t, /Найдено в интернете:\n— Прогноз: https:\/\/meteo\.example\/kegen/);
    assert.doesNotMatch(t, /\*\*/);
    // без источников метка [интернет] — это общие знания модели
    AI.ask = async () => ({ ok: true, text: "Обычно в ноябре холодно [интернет].", model: "stub" });
    await bot.handle({ message: { chat: { id: 901 }, from: { id: 901, first_name: "Тест" }, text: "холодно ли в ноябре в горах обычно?" } }, send);
    assert.doesNotMatch(last(), /\[интернет\]|Найдено в интернете/);
  } finally { AI.ask = orig; if (key === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = key; }
});

test("ИИ в боте для любого села: многолетний ряд села (не Кегена) из фонового расчёта, иначе — статус", () => {
  const D = require("../data").loadPlots();
  const other = { data: Object.assign({}, D, { village: { name: "Нарынкол", lat: 42.72, lon: 80.18 }, multiyear: undefined }), herds: [] };
  assert.match(bot.multiContext(other, "42.720,80.180").статус, /посчитается в фоне/);
  other.multi = D.multiyear;   // результат фонового расчёта хранится с селом
  const f = bot.multiContext(other, "42.720,80.180");
  assert.ok(f.вывод_по_селу && f.годы.length >= 2);
});
