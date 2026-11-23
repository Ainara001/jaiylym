// Таблица «русский ↔ казахский» для проверки носителем языка: node scripts/i18n-review.js > docs/KK_REVIEW.md
const fs = require("fs"), path = require("path"), vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "..", "web", "js", "i18n.js"), "utf8");
const ctx = { window: {}, localStorage: { getItem: () => null, setItem() {} }, document: { documentElement: {}, querySelectorAll: () => [] } };
vm.runInNewContext(src, ctx);
const I = ctx.window.I18N;
const keys = Array.from(I.keys().ru);
const mark = src.indexOf("версия модели 2.0");
const isNew = k => src.indexOf(JSON.stringify(k) + ":", mark) > 0 && src.indexOf(JSON.stringify(k) + ":") > mark;
const cell = s => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const row = k => { I.setLang("ru"); const ru = I.t(k); I.setLang("kk"); const kk = I.t(k); return `| \`${k}\` | ${cell(ru)} | ${cell(kk)} | |`; };
const fresh = keys.filter(isNew), old = keys.filter(k => !isNew(k));
console.log(`# Проверка казахского перевода носителем языка

Перевод сделан без носителя языка. Пожалуйста, впишите исправления в последнюю колонку
(или исправьте прямо в \`web/js/i18n.js\`, раздел \`const KK\`). Фигурные скобки \`{n}\` — подстановки, их не переводить.
Коды участков (Б-С, Д-ЮЗ) не переводятся.

Всего строк: ${keys.length}. Сначала — ${fresh.length} новых строк версии 2.0 (их стоит проверить в первую очередь).

## Новые строки (версия 2.0)

| Ключ | Русский | Қазақша | Исправление |
|---|---|---|---|
${fresh.map(row).join("\n")}

## Остальные строки

| Ключ | Русский | Қазақша | Исправление |
|---|---|---|---|
${old.map(row).join("\n")}`);
