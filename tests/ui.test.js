// Проверка текстов интерфейса: перевод на казахский полный, все ключи существуют, смайликов нет.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(root, f), "utf8");

function loadI18n() {
  const ctx = { window: {}, localStorage: { getItem: () => null, setItem() {} }, document: { documentElement: {}, querySelectorAll: () => [] } };
  vm.runInNewContext(read("web/js/i18n.js"), ctx);
  return ctx.window.I18N;
}

test("у каждого русского текста есть казахский перевод", () => {
  const keys = loadI18n().keys(), ru = Array.from(keys.ru), kk = Array.from(keys.kk);   // массивы из другого контекста vm
  assert.deepEqual(ru.filter(k => !kk.includes(k)), []);
  assert.deepEqual(kk.filter(k => !ru.includes(k)), [], "лишние ключи в казахском");
  assert.ok(ru.length > 150, "словарь не пустой");
});

test("все ключи, которые использует интерфейс, есть в словаре", () => {
  const ru = Array.from(loadI18n().keys().ru);
  const used = new Set();
  for (const f of ["web/js/app.js", "web/js/report.js"]) {
    for (const m of read(f).matchAll(/\bt\("([a-zA-Z.]+)"/g)) used.add(m[1]);
  }
  for (const m of read("web/index.html").matchAll(/data-i18n(?:-ph|-label)?="([a-zA-Z.]+)"/g)) used.add(m[1]);
  const dynamic = /^(conf|role|herds|src|hist)\./;      // ключи, собираемые из переменной: t("conf." + c)
  const missing = [...used].filter(k => !ru.includes(k) && !dynamic.test(k));
  assert.deepEqual(missing, []);
});

test("в интерфейсе и боте нет цветных смайликов", () => {
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
  for (const f of ["web/index.html", "web/js/app.js", "web/js/i18n.js", "web/js/report.js", "web/css/app.css", "api.js"]) {
    const lines = read(f).split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => emoji.test(l));
    assert.deepEqual(lines, [], f);
  }
  const bot = read("bot.js").split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => emoji.test(l) && !/console\.log/.test(l));
  assert.deepEqual(bot, [], "bot.js");
});
