// Протокол сжатия контекста ИИ (ai-context.js): без обрезки строки, сначала без потерь, потери — с записью в _сокращено.
const test = require("node:test");
const assert = require("node:assert/strict");
const X = require("../ai-context.js");
const F = require("../ai-facts.js");

const DIRS = ["С", "СВ", "В", "ЮВ", "Ю", "ЮЗ", "З", "СЗ"];
function bigContext(herds = 40) {
  const plots = ["Б", "Д"].flatMap(r => DIRS.map((d, i) => ({ id: `${r}-${d}`, кольцо: r === "Б" ? "ближний" : "дальний", км_от_села: r === "Б" ? 1.8 : 5.5,
    пастбище_га_спутник: 300 + i * 37, ndvi_спутник: +(0.2 + i * 0.03).toFixed(3), трава_за_лето_проц: -i, качество_снимка: "high",
    ёмкость_овец_оценка: 200 + i * 41, нагрузка_по_плану_проц: 40 + i * 7, нагрузка_если_все_у_села_проц: r === "Б" ? 180 : 0, вода: "допущение модели",
    как_рассчитано: `биомасса: (${(0.2 + i * 0.03).toFixed(3)} − 0.10) × 4000 = ${Math.round((0.1 + i * 0.03) * 4000)} кг/га; корм: × 0.5; на голову: 1.4 кг/сут × 120 дн.; ёмкость: ${200 + i * 41} овец` })));
  return {
    село: "Тест", лето_снимков: 2026, статус_плана: "partially_feasible", хватает_ли_корма: "нет, не на весь сезон",
    итог: { перегружено_если_все_у_села: 8, перегружено_по_плану: 0, дефицит_сена_т_по_плану_оценка: 212, чтобы_корма_хватило_сократить_на_овец: 3344 },
    прошлый_год: { годы: [2025, 2026], сравнение_надёжно: true, ndvi_медиана_изменения_проц: -11,
      участки: plots.map(p => ({ id: p.id, ndvi: [p.ndvi_спутник + 0.02, p.ndvi_спутник], изменение_проц: -7, вода_га: [1.2, null] })) },
    участки: plots,
    стада: Array.from({ length: herds }, (_, i) => ({ имя: `Хозяйство ${i + 1}`, овцы: 100 + i, козы: 10, крс: 5, лошади: 2, усл_голов: 30 + i,
      маршрут: "Б-С д.1-30; Д-С д.31-60; Д-СВ д.61-90; Д-В д.91-120; Б-В д.121-150", дойное: i % 3 === 0 })),
    что_можно_изменить: ["а", "б", "в", "г", "д"], погода: { осадки_30_дней_мм: 12, прогноз_7_дней: Array.from({ length: 7 }, (_, i) => `0${i + 1}.07: 10..25°C, 0 мм`) },
    мои_пастбища: [{ название: "Моё", га: 40, ndvi: 0.31 }], метаданные: { year: 2026, imagery_count: 6, data_status: "measured", source: "MPC", warnings: [] },
  };
}

test("влезает и так — только шаги без потерь: таблицы, пустые поля убраны, ничего не сокращено", () => {
  const ctx = { село: "Тест", пусто: null, итог: { a: 1 }, участки: [{ id: "Б-С", x: 1 }, { id: "Б-В", x: 2 }, { id: "Б-Ю" }] };
  const r = X.compactContext(ctx, { max: 24000 });
  assert.deepEqual(r.cut, []);
  assert.equal(r.obj._сокращено, undefined);
  assert.equal(r.obj.пусто, undefined);
  assert.deepEqual(r.obj.участки, { _колонки: ["id", "x"], _строки: [["Б-С", 1], ["Б-В", 2], ["Б-Ю", null]] });
});

test("таблицы — без потерь: все числа исходного контекста остаются", () => {
  const ctx = bigContext(6);
  const r = X.compactContext(ctx, { max: 1e6 });
  assert.deepEqual(r.cut, []);
  const before = F.factNumbers(ctx).sort((a, b) => a - b), after = F.factNumbers(r.obj).sort((a, b) => a - b);
  assert.deepEqual(after, before);
  assert.ok(r.size < JSON.stringify(ctx).length * 0.85, "таблицы короче повторяющихся ключей");
});

test("большой контекст: влезает в предел, JSON цел, итоги на месте, сокращённое перечислено", () => {
  const ctx = bigContext(60);
  const lossless = X.compactContext(ctx, { max: 1e9 }).size, max = Math.floor(lossless * 0.6);
  const r = X.compactContext(ctx, { max });
  assert.ok(r.size <= max, `размер ${r.size} > ${max} (без потерь ${lossless}, исходно ${JSON.stringify(ctx).length})`);
  assert.deepEqual(JSON.parse(r.json), r.obj);
  assert.deepEqual(r.obj.итог, ctx.итог);
  assert.equal(r.obj.статус_плана, "partially_feasible");
  assert.ok(r.cut.length >= 1);
  assert.deepEqual(r.obj._сокращено, r.cut);
});

test("шаги формулы остаются у участков из вопроса", () => {
  const ctx = bigContext(60);
  const lossless = X.compactContext(ctx, { max: 1e9 }).size;
  const r = X.compactContext(ctx, { max: Math.floor(lossless * 0.75), focusText: "почему на Д-ЮВ мало корма?" });
  assert.ok(r.cut.some(c => c.includes("как_рассчитано")));
  const t = r.obj.участки, col = t._колонки.indexOf("как_рассчитано"), id = t._колонки.indexOf("id");
  const kept = t._строки.filter(row => row[col]).map(row => row[id]);
  assert.deepEqual(kept, ["Д-ЮВ"]);
});

test("мусорный контекст от браузера огромного размера всё равно сжимается до предела", () => {
  const r = X.compactContext({ село: "Тест", итог: { a: 1 }, мусор: "x".repeat(200000) }, { max: 5000 });
  assert.ok(r.size <= 5000);
  assert.equal(r.obj.село, "Тест");
  assert.ok(r.cut.some(c => c.includes("мусор")));
});
