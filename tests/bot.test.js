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
