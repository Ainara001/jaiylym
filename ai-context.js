/*
 * Сжатие контекста села для ИИ под предел символов — вместо обрезки строки (обрезка ломала JSON и молча теряла хвост).
 *
 * Протокол (по шагам, пока не влезет):
 *  1. Без потерь, всегда: убираются пустые поля (null, "", [], {}) и списки из ≥ 3 однотипных объектов
 *     превращаются в таблицы { _колонки, _строки } — ключи не повторяются в каждой строке.
 *  2. С потерями, по порядку от наименее важного: каждый шаг убирает подробности одного вида и записывает,
 *     что убрано, в поле _сокращено. Итоги, статусы и числа, на которые опирается ответ, остаются до конца.
 *  3. Если всё ещё не влезает — целые разделы по списку DROP_ORDER, тоже с записью в _сокращено.
 * Строка никогда не режется посередине: ИИ всегда получает корректный JSON и знает, чего не хватает.
 */

const FORMAT_NOTE = "Таблицы: _колонки — названия полей, _строки — значения по порядку. Поля нет — данных нет. " +
  "_сокращено — что не передано из-за объёма: о таких подробностях скажи, что они есть на сайте.";
const PLOT_ID = /[БД]-(?:СВ|СЗ|ЮВ|ЮЗ|С|В|Ю|З)(?![А-Яа-я])/g;

const clone = x => JSON.parse(JSON.stringify(x == null ? {} : x));
const isObj = x => x && typeof x === "object" && !Array.isArray(x);
const empty = v => v == null || v === "" || (Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).length);

/** Убирает пустые поля объектов (внутри массивов позиции сохраняются: [null, 0.3] — это «нет данных за прошлый год»). */
function dropEmpty(x) {
  if (Array.isArray(x)) return x.map(dropEmpty);
  if (!isObj(x)) return x;
  const out = {};
  for (const [k, v] of Object.entries(x)) { const w = dropEmpty(v); if (!empty(w)) out[k] = w; }
  return out;
}

/** Списки из ≥ 3 объектов → таблица. Без потерь: все ключи всех строк, отсутствующее — null. */
function tabulate(x) {
  if (Array.isArray(x)) {
    const items = x.map(tabulate);
    if (items.length >= 3 && items.every(isObj)) {
      const cols = [...new Set(items.flatMap(o => Object.keys(o)))];
      return { _колонки: cols, _строки: items.map(o => cols.map(c => (c in o ? o[c] : null))) };
    }
    return items;
  }
  if (!isObj(x)) return x;
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, tabulate(v)]));
}

const keep = (arr, n) => (Array.isArray(arr) && arr.length > n ? arr.slice(0, n) : arr);

/**
 * Шаги с потерями: [описание для _сокращено, функция(obj, focus) → true, если что-то изменила].
 * Порядок — от второстепенного к важному.
 */
const LOSSY = [
  ["прогноз погоды — только 3 дня", o => o["погода"] && Array.isArray(o["погода"]["прогноз_7_дней"]) && o["погода"]["прогноз_7_дней"].length > 3 &&
    (o["погода"]["прогноз_7_дней"] = keep(o["погода"]["прогноз_7_дней"], 3), true)],
  ["свои пастбища пользователя — только число", o => Array.isArray(o["мои_пастбища"]) && o["мои_пастбища"].length &&
    (o["мои_пастбища_число"] = o["мои_пастбища"].length, delete o["мои_пастбища"], true)],
  ["метаданные снимков — только год, число снимков и статус", o => isObj(o["метаданные"]) && Object.keys(o["метаданные"]).length > 3 &&
    (o["метаданные"] = { год: o["метаданные"].year, снимков: o["метаданные"].imagery_count, статус: o["метаданные"].data_status }, true)],
  ["предупреждения и предложения — первые 3", o => {
    let ch = false;
    for (const k of ["что_можно_изменить", "предупреждения"]) if (Array.isArray(o[k]) && o[k].length > 3) { o[k] = keep(o[k], 3); ch = true; }
    return ch;
  }],
  ["маршруты стад — первые 3 отрезка", o => {
    let ch = false;
    for (const h of o["стада"] || []) if (h && typeof h["маршрут"] === "string" && h["маршрут"].split("; ").length > 3) {
      h["маршрут"] = h["маршрут"].split("; ").slice(0, 3).join("; ") + "; …"; ch = true;
    }
    return ch;
  }],
  ["шаги формулы «как_рассчитано» — только у участков из вопроса (или у двух самых нагруженных); у остальных шаги те же, со своими числами", (o, focus) => {
    const plots = o["участки"] || [];
    const withSteps = plots.filter(p => p && p["как_рассчитано"]);
    if (withSteps.length <= 2) return false;
    let ids = focus.filter(id => plots.some(p => p && p.id === id));
    if (!ids.length) ids = plots.slice().sort((a, b) => (b["нагрузка_по_плану_проц"] || 0) - (a["нагрузка_по_плану_проц"] || 0)).slice(0, 2).map(p => p.id);
    for (const p of plots) if (p && !ids.includes(p.id)) delete p["как_рассчитано"];
    return true;
  }],
  ["наблюдения людей — только участки, которые надо проверить на месте", o => {
    const a = o["наблюдения_людей"];
    if (!Array.isArray(a) || a.length <= 10) return false;
    o["наблюдения_людей"] = a.filter(x => x && x["вывод"] === "проверить на месте").slice(0, 20);
    return true;
  }],
  ["прошлый год — только итог по селу, без участков", o => isObj(o["прошлый_год"]) && Array.isArray(o["прошлый_год"]["участки"]) &&
    (delete o["прошлый_год"]["участки"], true)],
  ["стада сверх 25 — сложены в одну строку", o => {
    const hs = o["стада"];
    if (!Array.isArray(hs) || hs.length <= 25) return false;
    const rest = hs.slice(25), sum = k => rest.reduce((s, h) => s + (+(h && h[k]) || 0), 0);
    o["стада"] = hs.slice(0, 25).concat([{ имя: `ещё ${rest.length} стад вместе`, овцы: sum("овцы"), козы: sum("козы"), крс: sum("крс"), лошади: sum("лошади"), усл_голов: sum("усл_голов") }]);
    return true;
  }],
];
/** Если и после шагов не влезает — разделы целиком, от наименее важного. */
const DROP_ORDER = ["погода", "мои_пастбища_число", "метаданные", "лучшие_места_для_водопоя", "параметры_модели", "алгоритм", "предупреждения",
  "что_можно_изменить", "доли_обеспеченности_проц", "прошлый_год", "стада", "причины_дефицита", "узкое_место", "участки"];

/**
 * ctx — объект контекста, max — предел символов JSON, focusText — текст вопросов (из него берутся id участков).
 * Возвращает { json, obj, cut, size }: json — строка для модели, obj — то же как объект (для проверки чисел), cut — что убрано.
 */
function compactContext(ctx, { max = 24000, focusText = "" } = {}) {
  const focus = [...new Set(String(focusText).match(PLOT_ID) || [])];
  const work = clone(ctx);
  const cut = [];
  const pack = () => {
    const body = tabulate(dropEmpty(work));
    const obj = Object.assign({ _формат: FORMAT_NOTE }, cut.length ? { _сокращено: cut.slice() } : {}, body);
    return { obj, json: JSON.stringify(obj) };
  };
  let r = pack();
  for (const [what, fn] of LOSSY) {
    if (r.json.length <= max) break;
    if (fn(work, focus)) { cut.push(what); r = pack(); }
  }
  for (const k of DROP_ORDER) {
    if (r.json.length <= max) break;
    if (k in work) { delete work[k]; cut.push(`раздел «${k}» целиком`); r = pack(); }
  }
  // неизвестные разделы (контекст присылает браузер) — самые большие первыми
  while (r.json.length > max && Object.keys(work).length) {
    const k = Object.keys(work).sort((a, b) => JSON.stringify(work[b]).length - JSON.stringify(work[a]).length)[0];
    delete work[k]; cut.push(`раздел «${String(k).slice(0, 40)}» целиком`); r = pack();
  }
  return { json: r.json, obj: r.obj, cut, size: r.json.length };
}

module.exports = { compactContext, dropEmpty, tabulate, FORMAT_NOTE };
