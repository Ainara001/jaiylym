// Читаемый ответ ИИ (web/js/aitext.js): вывод, заголовки, пункты, числа, ярлыки источника; HTML из ответа не исполняется.
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../web/js/aitext.js");

test("структура: первая строка — вывод, «Заголовок:», пункты «— » и «- »", () => {
  const h = A.toHtml("Корма хватит до августа.\nЧто происходит:\n— первый\n- второй\nОбычная строка.");
  assert.match(h, /<p class="ai-lead">Корма хватит до августа\.<\/p>/);
  assert.match(h, /<p class="ai-h">Что происходит:<\/p>/);
  assert.match(h, /<ul class="ai-list"><li>первый<\/li><li>второй<\/li><\/ul>/);
  assert.match(h, /<p>Обычная строка\.<\/p>/);
});

test("числа выделены целиком: тысячи, дробь, знак, проценты; дефис диапазона — не минус", () => {
  const h = A.inline("ёмкость 12 040 овец, NDVI 0,289, изменение −11 %, дни 1-30", k => k);
  for (const n of ["12 040", "0,289", "−11 %", "1", "30"]) assert.ok(h.includes(`<b class="num">${n}</b>`), n);
  assert.ok(!h.includes(">-30<"));
});

test("метки источника → ярлыки на языке сайта; казахская метка ввода тоже", () => {
  const L = { sat: "Спутник", input: "Ввод", model: "Модель", web: "Интернет" };
  const h = A.inline("NDVI 0,3 [спутник]; стадо 500 [ввод]; 500 қой [енгізу]; ёмкость [модель]; цена [интернет]", k => L[k]);
  for (const [k, v] of Object.entries(L)) assert.ok(h.includes(`<span class="src src-${k}">${v}</span>`), k);
  assert.ok(!h.includes("[спутник]"));
});

test("безопасность: HTML и markdown из ответа не исполняются", () => {
  const h = A.toHtml("**Вывод** <img src=x onerror=alert(1)>\n# Заголовок\n— <script>alert(1)</script>");
  assert.ok(!/<img|<script/i.test(h));
  assert.match(h, /&lt;img src=x onerror=alert\(<b class="num">1<\/b>\)&gt;/);
  assert.ok(!h.includes("**"));
  assert.ok(!h.includes("#"));
});

test("код участка не рвётся по дефису", () => {
  const h = A.inline("Перевести на Д-ЮЗ и Б-С, а не на Д-Сарыбулак", k => k);
  assert.ok(h.includes('<span class="plot-id">Д-ЮЗ</span>') && h.includes('<span class="plot-id">Б-С</span>'));
  assert.ok(!h.includes('<span class="plot-id">Д-С</span>'));
});
