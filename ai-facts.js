/*
 * Объяснимый ИИ (P2), серверная часть. Без нейросетей:
 *  - verifyNumbers: все числа ответа Gemini сверяются с числами данных села (с допуском округления);
 *  - templateAnswer: ответ без Gemini — шаблон из тех же данных, только их числа.
 * Данные — контекст, который сайт передаёт в /api/ai (web/js/app.js → aiContext).
 */

/**
 * Числа из текста: «15 384», «0,289», «40%». Пробелы-разделители тысяч (обычные и неразрывные) склеиваются.
 * Знак не учитывается: в «д.1-30» дефис — диапазон, а не минус.
 */
function numbersIn(text) {
  const out = [];
  const re = /\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g;
  for (const m of String(text == null ? "" : text).matchAll(re)) {
    const raw = m[0].replace(/[   ]/g, "").replace(",", ".");
    const v = parseFloat(raw);
    if (Number.isFinite(v)) out.push({ v, decimals: (raw.split(".")[1] || "").length, raw: m[0] });
  }
  return out;
}

/** Все числа контекста: числовые поля и числа внутри строк (шаги формулы, маршруты, предложения). */
function factNumbers(ctx) {
  const out = [];
  const walk = x => {
    if (typeof x === "number") { if (Number.isFinite(x)) out.push(Math.abs(x)); }
    else if (typeof x === "string") { for (const n of numbersIn(x)) out.push(n.v); }
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") Object.values(x).forEach(walk);
  };
  walk(ctx);
  return out;
}

/**
 * Число ответа считается известным, если оно есть в данных с точностью до округления
 * (округлённое до стольких же знаков, отклонение до 1 %), это небольшое целое (нумерация, «в 2 раза»)
 * или год. Остальные — незнакомые: модель их придумала или посчитала сама.
 */
function known(n, facts) {
  const a = Math.abs(n.v);
  if (n.decimals === 0 && a <= 10) return true;
  if (n.decimals === 0 && a >= 1990 && a <= 2100) return true;
  return facts.some(f => {
    if (Math.abs(f - n.v) < 1e-9) return true;
    const k = Math.pow(10, n.decimals);
    if (Math.round(f * k) / k === n.v) return true;
    return Math.abs(f) >= 100 && Math.abs(f - n.v) <= Math.abs(f) * 0.01;
  });
}

/** Проверка ответа: unknown — числа, которых нет ни в данных, ни в сообщениях пользователя. */
function verifyNumbers(answer, ctx, extraText = "") {
  const facts = factNumbers(ctx).concat(numbersIn(extraText).map(n => n.v));
  const nums = numbersIn(answer);
  const unknown = [...new Set(nums.filter(n => !known(n, facts)).map(n => n.raw.trim()))];
  return { ok: unknown.length === 0, checked: nums.length, unknown };
}

// ---------- шаблонный ответ ----------
const fmt = v => String(Math.round(+v)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const ENOUGH_KK = { "да, с запасом": "иә, артығымен", "да, впритык": "иә, әзер жетеді", "нет, не на весь сезон": "жоқ, бүкіл маусымға жетпейді" };
const T = {
  ru: {
    head: r => `ИИ сейчас недоступен${r ? ` (${r})` : ""}. Ниже — главное из расчёта сервиса, без ИИ.`,
    noVillage: "Село не открыто, поэтому расчёта нет. Откройте село на карте — тогда здесь будет сводка.",
    issues: "Сначала о данных:",
    enough: (v, cap, need) => `Хватит ли корма: ${v}. Ёмкость участков с водой — около ${fmt(cap)} овец за сезон (оценка), стада — ${fmt(need)} в пересчёте на овец.`,
    over: (a, b) => `Перегруженных участков: ${a}, если все пасутся у села; ${b} — по плану.`,
    deficit: (t, s) => `По плану корма не хватает примерно на ${fmt(t)} т сена; чтобы хватило, нужно меньше скота примерно на ${fmt(s)} овец (в пересчёте).`,
    noDeficit: "По плану корма хватает на весь сезон.",
    short: (h, d) => `— ${h}: не хватает корма на ${fmt(d)} дн.`,
    bottleneck: (hs, d) => `Узкое место: стадам ${hs} не хватает ${fmt(d)} усл. гол.-сут. на доступных им участках.`,
    todo: "Что можно сделать:",
    trust: "Ёмкость — оценка модели по спутнику; полевыми замерами она не подтверждена.",
    trustOk: "Модель откалибрована полевыми замерами.",
    demo: "В расчёте есть демо-стада — это пример, а не реальные хозяйства.",
  },
  kk: {
    head: r => `ЖИ қазір қолжетімсіз${r ? ` (${r})` : ""}. Төменде — сервис есебінің ең бастысы, ЖИ-сіз.`,
    noVillage: "Ауыл ашылмаған, сондықтан есеп жоқ. Картадан ауылды ашыңыз — сонда осында қорытынды болады.",
    issues: "Алдымен деректер туралы:",
    enough: (v, cap, need) => `Жем жете ме: ${ENOUGH_KK[v] || v}. Суы бар учаскелердің сыйымдылығы — маусымға шамамен ${fmt(cap)} қой (бағалау), табындар — қойға шаққанда ${fmt(need)}.`,
    over: (a, b) => `Шамадан тыс жүктелген учаскелер: бәрі ауыл маңында жайылса — ${a}; жоспар бойынша — ${b}.`,
    deficit: (t, s) => `Жоспар бойынша жем шамамен ${fmt(t)} т шөпке жетпейді; жетуі үшін малды шамамен ${fmt(s)} қойға (шаққанда) азайту керек.`,
    noDeficit: "Жоспар бойынша жем бүкіл маусымға жетеді.",
    short: (h, d) => `— ${h}: ${fmt(d)} күнге жем жетпейді.`,
    bottleneck: (hs, d) => `Тар орын: ${hs} табындарына қолжетімді учаскелерде ${fmt(d)} шартты бас-тәулік жетпейді.`,
    todo: "Не істеуге болады:",
    trust: "Сыйымдылық — спутник бойынша модель бағалауы; далалық өлшемдермен расталмаған.",
    trustOk: "Модель далалық өлшемдермен калибрленген.",
    demo: "Есепте демо-табындар бар — бұл мысал, нақты шаруашылықтар емес.",
  },
};

/** Ответ без Gemini: только числа из контекста. reason — понятная причина недоступности ИИ. */
function templateAnswer(ctx, lang = "ru", issues = [], reason = "") {
  const L = T[lang === "kk" ? "kk" : "ru"];
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const lines = [L.head(reason)];
  if (!c["село"]) { lines.push(L.noVillage); return lines.join("\n"); }
  if (issues.length) lines.push(L.issues + " " + issues.join(" "));
  const it = c["итог"] || {};
  if (c["хватает_ли_корма"] != null && c["ёмкость_всех_участков_с_водой_овец_за_сезон_оценка"] != null)
    lines.push(L.enough(c["хватает_ли_корма"], c["ёмкость_всех_участков_с_водой_овец_за_сезон_оценка"], c["поголовье_в_пересчёте_на_овец"] || 0));
  if (it["перегружено_если_все_у_села"] != null) lines.push(L.over(it["перегружено_если_все_у_села"], it["перегружено_по_плану"] ?? 0));
  if (it["дефицит_сена_т_по_плану_оценка"] > 0) lines.push(L.deficit(it["дефицит_сена_т_по_плану_оценка"], it["чтобы_корма_хватило_сократить_на_овец"] || 0));
  else if (it["дефицит_сена_т_по_плану_оценка"] === 0) lines.push(L.noDeficit);
  for (const d of (c["причины_дефицита"] || []).slice(0, 4)) if (d && d["не_хватает_дней"] > 0) lines.push(L.short(d["стадо"], d["не_хватает_дней"]));
  const b = c["узкое_место"];
  if (b && b["не_хватает_усл_гол_сут"] > 0) lines.push(L.bottleneck((b["стада"] || []).join(", "), b["не_хватает_усл_гол_сут"]));
  const todo = (c["что_можно_изменить"] || []).filter(Boolean).slice(0, 3);
  if (todo.length) lines.push(L.todo + "\n" + todo.map(x => "— " + x).join("\n"));
  lines.push(c["модель_проверена_в_поле"] ? L.trustOk : L.trust);
  if (c["демо_стада"]) lines.push(L.demo);
  return lines.join("\n");
}

module.exports = { numbersIn, factNumbers, verifyNumbers, templateAnswer };
