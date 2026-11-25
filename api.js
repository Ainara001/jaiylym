/*
 * Jaiylym — серверное API для сайта: вход через Telegram, роли, профиль хозяйства,
 * сценарии, история расчётов, раздел координатора (акимата).
 *
 * Вход без паролей:
 *   1. Сайт: POST /auth/start → { nonce, code, link }. Код (4 цифры) показывается на сайте.
 *   2. Человек открывает link (t.me/<бот>?start=login_<nonce>), бот показывает тот же код
 *      и кнопку «Подтвердить вход». Telegram сам удостоверяет, кто нажал (webhook защищён секретом).
 *   3. Сайт опрашивает GET /auth/poll?nonce=… и получает токен сессии (30 дней).
 *      На сервере хранится только хэш токена. Пароли нигде не хранятся.
 *
 * Роли проверяются на сервере при каждом запросе:
 *   farmer      — любой вошедший: свой профиль, свои сценарии и история;
 *   coordinator — Telegram ID указан в переменной окружения COORDINATOR_IDS (через запятую):
 *                 видит хозяйства своих сёл, публикует общий план села.
 */
const crypto = require("crypto");
const PL = require("./web/pipeline.js");
const M = require("./web/model.js");
const NM = require("./web/norms.js");
const Z = require("./web/zone.js");
const { createKelisim, createRoutes } = require("./kelisim.js");
const { clientIp } = require("./clientip.js");
const G = require("./ai.js");   // DeepSeek (DEEPSEEK_API_KEY) или Gemini (GEMINI_API_KEY) — см. ai.js
const F = require("./ai-facts.js");
const X = require("./ai-context.js");
const AI_CTX_MAX = +process.env.AI_CONTEXT_CHARS || 24000;   // ~7–8 тыс. токенов данных села
// поиск в интернете (DeepSeek web search или Google у Gemini): не больше AI_SEARCH_DAILY поисков в день — найденные страницы оплачиваются как входные токены
const AI_SEARCH_DAILY = process.env.AI_SEARCH_DAILY != null ? +process.env.AI_SEARCH_DAILY : 150;
const searchDay = { day: "", n: 0 };
/** Можно ли сегодня искать в интернете (лимит общий для сайта и бота — один процесс). */
function searchAllowed() {
  const day = new Date().toISOString().slice(0, 10);
  if (searchDay.day !== day) { searchDay.day = day; searchDay.n = 0; }
  return searchDay.n < AI_SEARCH_DAILY;
}
const searchUsed = n => { searchDay.n += n || 0; };
let lastAnswer = null;
/** Сегодняшняя дата по Алматы (UTC+5) словами: «24 ноября 2026, вторник». Снимки и расчёт — за лето, вопросы — о сегодняшнем дне. */
function todayText(lang, now = new Date()) {
  const d = new Date(now.getTime() + 5 * 3600e3);
  const M = { ru: ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"],
    kk: ["қаңтар", "ақпан", "наурыз", "сәуір", "мамыр", "маусым", "шілде", "тамыз", "қыркүйек", "қазан", "қараша", "желтоқсан"] };
  const W = { ru: ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"],
    kk: ["жексенбі", "дүйсенбі", "сейсенбі", "сәрсенбі", "бейсенбі", "жұма", "сенбі"] };
  const L = lang === "kk" ? "kk" : "ru";
  return L === "kk" ? `${d.getUTCFullYear()} жылғы ${d.getUTCDate()} ${M.kk[d.getUTCMonth()]}, ${W.kk[d.getUTCDay()]}`
    : `${d.getUTCDate()} ${M.ru[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${W.ru[d.getUTCDay()]}`;
}   // для /api/ai/status: искал ли ИИ в последнем ответе, были ли источники, прошла ли проверка чисел
const SEARCH_RULE = {
  ru: "Поиск в интернете: ищи, только если для ответа нужны свежие внешние сведения, которых нет в ДАННЫХ, — погода и прогноз, цены на сено и скот, " +
    "ветеринарные и правовые нормы Казахстана, новости района. Цифры села (участки, поголовье, ёмкость, нагрузка) бери только из ДАННЫХ, не из поиска. " +
    "Для посторонних задач не ищи. Предпочитай официальные и казахстанские источники; найденное в интернете прямо называй найденным в интернете. " +
    "Для таких вопросов это правило важнее правила «только ДАННЫЕ»: не отвечай «этого нет в данных» — сначала поищи.",
  kk: "Интернеттен іздеу: жауапқа ДЕРЕКТЕРДЕ жоқ жаңа сыртқы мәлімет керек болса ғана ізде — ауа райы мен болжам, шөп пен мал бағасы, " +
    "Қазақстанның ветеринарлық және құқықтық нормалары, аудан жаңалықтары. Ауыл сандарын (учаскелер, мал саны, сыйымдылық, жүктеме) тек ДЕРЕКТЕРДЕН ал. " +
    "Бөгде тапсырмалар үшін іздеме. Ресми және қазақстандық дереккөздерді таңда; интернеттен табылғанды солай ата. " +
    "Мұндай сұрақтарда бұл ереже «тек ДЕРЕКТЕР» ережесінен маңыздырақ: «деректерде жоқ» деп жауап берме — алдымен ізде.",
};
// Вопрос о свежих внешних сведениях (погода, цены, нормы, новости): модель сама часто не ищет, если в данных этого нет, —
// для таких вопросов в задачу добавляется прямое указание искать (только когда поиск разрешён).
const WEB_Q = /погод|прогноз|дожд|снег|мороз|заморозк|град|ветер|температур|(?<![а-яё])цен[аыуе]|стоимост|почём|почем(?![а-яё])|сколько стоит|закупочн|субсиди|закон|правил[аио] выпас|ветеринар|вакцин|карантин|эпизоот|новост|ауа ?райы|болжам|жаңбыр|аяз|баға|құн[ыі]|заң|ереже|жаңалық/i;
const needsWeb = text => WEB_Q.test(String(text || ""));
const WEB_RETRY = {
  ru: "ВНИМАНИЕ: в прошлой попытке ты не выполнил поиск. Сейчас обязательно вызови поиск в интернете и ответь по найденному.",
  kk: "НАЗАР АУДАР: алдыңғы әрекетте іздеу жасалмады. Қазір міндетті түрде интернеттен ізде де, табылғанмен жауап бер.",
};
const WEB_TASK = {
  ru: " ПОИСК: вопрос о свежих внешних сведениях — сначала выполни поиск в интернете и ответь по найденному (найденное помечай [интернет]); цифры села — только из ДАННЫХ.",
  kk: " ІЗДЕУ: сұрақ жаңа сыртқы мәлімет туралы — алдымен интернеттен ізде де, табылғанмен жауап бер (табылғанды [интернет] деп белгіле); ауыл сандары — тек ДЕРЕКТЕРДЕН.",
};

// ---------- ИИ: инструкции модели ----------
const AI_DAILY = +process.env.AI_DAILY_LIMIT || 1500;
const aiDay = { day: "", n: 0 };
/** Одно обращение к ИИ в счёт дневного лимита (общий для сайта и бота). false — на сегодня всё. */
function aiTake(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  if (aiDay.day !== day) { aiDay.day = day; aiDay.n = 0; }
  if (aiDay.n >= AI_DAILY) return false;
  aiDay.n++;
  return true;
}
const AI_RULES = "Используй только данные из блока ДАННЫЕ и общие знания о выпасе. Различай: спутниковые измерения (NDVI Sentinel-2, площади), " +
  "ввод пользователя (поголовье, водопои) и модельные оценки (ёмкость, нагрузка, тонны сена, стоимость) — оценки называй оценками. " +
  "Не выдумывай чисел, которых нет в данных. Не обещай доходов и экономии. 1 условная голова = 1 корова = 5 овец или коз; лошадь = 1,2 условной головы. " +
  "Пиши простым языком для фермера без терминов; если термин нужен — поясни в скобках. " +
  "ФОРМАТ: первая строка — главный вывод одной фразой. Дальше короткие пункты, каждый с новой строки и с «— » в начале; " +
  "заголовок группы пунктов — отдельная короткая строка с двоеточием в конце. Без таблиц и без markdown (без звёздочек и решёток). " +
  "Пункт с числом заканчивай меткой источника в квадратных скобках: [спутник] — измерено со спутника, [ввод] — ввёл пользователь, " +
  "[модель] — оценка расчёта, [норма] — предельная норма нагрузки Минсельхоза, [интернет] — найдено поиском в этом ответе (только если ты действительно искал и даёшь источник), " +
  "[общее] — общие знания о выпасе, не из данных и не из поиска. Метки всегда эти, на любом языке ответа. " +
  "Числа пиши только цифрами, точно как в данных (например 15 384), никогда не словами; готовые итоги в поле «итог» уже посчитаны — не пересчитывай их. " +
  "Не путай единицы: поля «…_овец» — это число овец, поля «…усл_голов» — условные головы. Водопой открывает доступ к корму, а не «даёт воду овцам». " +
  "Числа (ёмкость, число овец, дефицит, нагрузка) бери ТОЛЬКО из данных: сам их не считай и не придумывай. Если нужного числа нет — прямо скажи, что его нет в расчёте. " +
  "Ёмкость участка — меньшее из двух: оценки по снимку и предельной нормы нагрузки Минсельхоза (блок «норма_нагрузки_МСХ», у участка — «что_ограничивает»). " +
  "Если ограничивает норма — так и скажи: по снимку вышло больше, но по норме столько нельзя; не советуй ставить скота больше нормы. " +
  "Блок «где_селу_можно_пасти» — какую землю учитывает расчёт: контур или гектары ввёл человек, прав на землю это не подтверждает. Если «вся трава вокруг» — скажи, что в расчёт может входить чужая земля. " +
  "Где трава слабее, чем обычно вокруг села (поле «трава_слабее_обычной…»), предел уменьшен во столько же раз — это вклад снимка. " +
  "Если тип пастбища не выбран, норма — самая мягкая по области: скажи, что тип можно выбрать на вкладке «Данные». " +
  "Чтобы объяснить, откуда число, используй поле «как_рассчитано» (шаги формулы) — перескажи шаги с их числами. " +
  "Почему стадо пасётся на этом участке, почему ему не хватило корма и какие участки ему недоступны — бери из поля «почему_план» " +
  "(маршрут[].почему, недоступные_участки, причина_дефицита); своих причин не придумывай. " +
  "Право пользования участком в данных — только ввод пользователя, его НЕ проверяли по госреестру; никогда не утверждай, что право подтверждено. " +
  "О новом водопое говори по блоку «где_проверять_воду»: это места, где стоит проверить возможность, а не совет строить. Если в выводе «водопой не добавит» или «не уменьшит» — так и скажи. " +
  "Право, источник воды и цену проверяют люди: «не проверено» так и называй. " +
  "Вода «по карте WorldCover» — это водоём на снимке, а не проверенный водопой. Ёмкость не подтверждена полевыми измерениями. " +
  "Блок «прошлый_год» — те же участки и то же окно июнь–август прошлого лета; изменения уже посчитаны, бери их оттуда. " +
  "Изменение NDVI меньше порога — «без изменений», а не тренд; NDVI — зелёность травы, а не урожай; один год к другому — не многолетний тренд. " +
  "Если сравнение_надёжно = false — скажи об этом. «Устойчивая вода по снимкам» — вода, видимая большую часть лета, а не проверенный водопой. " +
  "Блок «многолетний_ряд» — лето каждого года с 2019 и осадки; вывод уже посчитан (тренд Тейла — Сена, тест Манна — Кендалла, поправка на осадки RESTREND): " +
  "decline_unexplained — «снижение, не объяснённое осадками, — повод проверить на месте», decline_rain — снижение объясняют осадки, " +
  "no_change — значимого изменения нет, increase — рост, few_years — данных мало. Никогда не называй это деградацией и не делай вывод о тренде по двум годам. " +
  "Блок «наблюдения_людей» — что участники сами видели на участке (из согласования), уже сверенное с данными за то же время. " +
  "«проверить на месте» — люди и снимок говорят разное или снимок этого не видит: скажи оба мнения и предложи проверить, не решай, кто ошибся, и не называй неправым ни фермера, ни спутник. " +
  "«другое время» и «без даты» — не сравнивай со снимком вообще. Наблюдения ёмкость и план не меняют: так и скажи; новых чисел по ним не считай. " +
  "Если в блоке ПРОБЛЕМЫ_ДАННЫХ что-то указано — начни ответ с этого. Ты не агроном и не госорган: твой ответ — пояснение расчёта, а не заключение. " +
  G.SCOPE;
const AI_SYSTEM = {
  ru: "Ты — ИИ-помощник сервиса Jaiylym по пастбищам сёл Казахстана. Отвечай по-русски. " + AI_RULES,
  kk: "Сен — Қазақстан ауылдарының жайылымдары бойынша Jaiylym сервисінің ЖИ-көмекшісісің. Жауапты ТЕК қазақ тілінде жаз, орысша сөз араластырма. " +
    "Деректердегі орысша сөздерді аудар: овцы — қой, условная голова — шартты бас, участок — учаске, корм — жем, водопой — суат, сено — шөп, " +
    "стадо — табын, пастбище — жайылым, поголовье — мал саны, ёмкость — сыйымдылық, нагрузка — жүктеме, да/нет — иә/жоқ. Сандарды тек цифрмен жаз (15 384), сөзбен жазба; учаске атауларын (Д-З, Б-С) өзгертпе. " +
    "«…_овец» өрістері — қой саны, «…усл_голов» — шартты бас, оларды шатастырма. " + AI_RULES,
};
const AI_SUMMARY = {
  ru: "Сделай понятную сводку для фермера (до 170 слов). Первая строка — главное одной фразой. Затем «Что происходит:» и 2–3 пункта с цифрами из данных; " +
    "«Что сделать:» и 3 конкретных шага; «Насколько доверять:» и один пункт. Если какому-то стаду не хватает корма, объясни почему простыми словами.",
  kk: "Фермерге түсінікті қорытынды жаса (130 сөзге дейін). Бірінші жол — ең бастысы бір сөйлеммен. Содан кейін «Не болып жатыр:» және деректердегі сандармен 2–3 тармақ; " +
    "«Не істеу керек:» және 3 нақты қадам; «Қаншалықты сенуге болады:» және бір тармақ. Қай табынға жем жетпесе, себебін қарапайым сөзбен түсіндір.",
};
const AI_CHAT = {
  ru: "Ответь на последний вопрос пользователя коротко и по делу (до 150 слов): вывод первой строкой, затем 2–5 пунктов. Если в данных нет ответа — так и скажи и подскажи, где его взять.",
  kk: "Пайдаланушының соңғы сұрағына қысқа әрі нақты жауап бер (150 сөзге дейін): бірінші жолда қорытынды, содан кейін 2–5 тармақ. Деректерде жауап болмаса — соны айт және қайдан табуға болатынын көрсет.",
};

const SESSION_TTL = 30 * 24 * 3600;
const LOGIN_TTL = 600;
const MAX_BODY = 256 * 1024;
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const rnd = n => crypto.randomBytes(n).toString("base64url");

// ---------- аккаунты с паролем (вход без Telegram — по выбору пользователя) ----------
// Логин — телефон Казахстана (+7XXXXXXXXXX), e-mail или имя латиницей. Пароль хранится только как хэш scrypt с солью.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
/** Строка или число → строка; объект, список — пусто (не ошибка сервера). */
const plain = x => (typeof x === "string" || typeof x === "number" || typeof x === "boolean" ? String(x) : "");
function normLogin(x) {
  const s = plain(x).trim().toLowerCase();
  const digits = s.replace(/[\s()+-]/g, "");
  if (/^[78]\d{10}$/.test(digits)) return "+7" + digits.slice(1);              // 8 701 …, +7 701 …, 7701…
  if (/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-zа-я]{2,}$/i.test(s)) return s;          // e-mail
  if (/^[a-z][a-z0-9_.]{2,31}$/.test(s)) return s;                                  // имя латиницей
  return null;
}
// Асинхронно, в пуле потоков: сервер не замирает, пока считается хэш. Больше 8 в очереди — просим повторить (иначе перегрузка).
let pwBusy = 0;
async function scrypt(pw, salt, len, N) {
  if (pwBusy >= 8) throw Object.assign(new Error("сервер занят, повторите через несколько секунд"), { code: 503 });
  pwBusy++;
  try { return await new Promise((ok, no) => crypto.scrypt(String(pw), salt, len, { N, r: SCRYPT.r, p: SCRYPT.p }, (e, k) => (e ? no(e) : ok(k)))); }
  finally { pwBusy--; }
}
async function hashPassword(pw, salt = crypto.randomBytes(16)) {
  const hash = await scrypt(pw, salt, SCRYPT.keylen, SCRYPT.N);
  return { alg: "scrypt", N: SCRYPT.N, salt: salt.toString("base64"), hash: hash.toString("base64") };
}
async function checkPassword(pw, rec) {
  if (!rec || rec.alg !== "scrypt") return false;
  const want = Buffer.from(rec.hash, "base64");
  const got = await scrypt(pw, Buffer.from(rec.salt, "base64"), want.length, rec.N || SCRYPT.N);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
// хэш-«пустышка»: на неизвестный логин тратим то же время, что на проверку пароля (не выдаём, есть ли такой логин)
const DUMMY_PW = { alg: "scrypt", N: SCRYPT.N, salt: crypto.randomBytes(16).toString("base64"), hash: crypto.randomBytes(SCRYPT.keylen).toString("base64") };

const num = (x, max = 1e6) => { const v = Math.round(+x); return Number.isFinite(v) ? Math.min(Math.max(v, 0), max) : 0; };
const bad = msg => Object.assign(new Error(msg), { code: 400 });
/** Сводка расчёта от сайта: только известные поля и числа (её потом показывают на странице). */
function cleanSummary(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const out = {}, ids = x => (Array.isArray(x) ? x : []).filter(p => PLOT_RE.test(p)).slice(0, 16);
  for (const k of ["overloaded_before", "overloaded_after", "excess_t", "deficit_t", "herds", "herds_short", "au", "missing"]) if (Number.isFinite(+s[k]) && s[k] !== null && s[k] !== "") out[k] = +s[k];
  if (["feasible", "partially_feasible", "infeasible", "no_demand"].includes(s.status)) out.status = s.status;
  if (s.demo != null) out.demo = !!s.demo;
  if (/^\d+\.\d+\.\d+$/.test(s.model_version || "")) out.model_version = s.model_version;
  out.water_added = ids(s.water_added); out.forbidden = ids(s.forbidden);
  return out;
}
/** Поголовье: пусто → 0; отрицательное, дробное, нечисловое или больше лимита — ошибка 400 (а не тихое обнуление). */
function count(x, name, max = 1e6) {
  if (x == null || x === "") return 0;
  const v = +x;
  if (!Number.isFinite(v)) throw bad(`${name}: не число`);
  if (v < 0) throw bad(`${name}: поголовье не может быть отрицательным`);
  if (Math.round(v) !== v) throw bad(`${name}: нужно целое число`);
  if (v > max) throw bad(`${name}: больше ${max}`);
  return v;
}
const SPECIES_RU = { sheep: "овцы", goats: "козы", cattle: "КРС", horses: "лошади" };
const MAX_HERDS = 60;
/** «[интернет]» в ответе без источников поиска → «[общее]» (модель путает интернет с общими знаниями). */
const fixWebLabels = text => String(text || "").replace(/\[\s*(интернет|интернеттен|internet)\s*\]/gi, "[общее]");

/**
 * Проверка данных села, которые сайт передаёт ИИ: чего не хватает и что противоречит друг другу.
 * Возвращает список строк; ИИ обязан сначала сказать о них.
 */
function aiContextIssues(ctx) {
  const out = [];
  if (!ctx || typeof ctx !== "object" || !ctx["село"]) { out.push("Село не открыто: данных участков и стад нет."); return out; }
  const objs = x => (Array.isArray(x) ? x : []).filter(y => y && typeof y === "object");
  const plots = objs(ctx["участки"]), herds = objs(ctx["стада"]);
  if (!plots.length) out.push("Нет данных участков.");
  if (!herds.length) out.push("Стада не введены: план и дефицит не считались.");
  const noNdvi = plots.filter(p => p && (p.ndvi_спутник == null)).map(p => p.id);
  if (noNdvi.length) out.push("Нет NDVI (ёмкость неизвестна) для участков: " + noNdvi.slice(0, 16).join(", ") + ".");
  const it = ctx["итог"] || {};
  const st = ctx["статус_плана"];
  const def = it["дефицит_сена_т_по_плану_оценка"];
  if (st === "feasible" && def > 0) out.push("Противоречие: статус «распределение возможно», но указан дефицит " + def + " т.");
  if ((st === "partially_feasible" || st === "infeasible") && def === 0) out.push("Противоречие: план неполный, но дефицит указан как 0.");
  for (const p of plots) if (p && p.нагрузка_по_плану_проц > 100) { out.push("Противоречие: план превышает 100 % на участке " + p.id + "."); break; }
  for (const h of herds) if (h && [h.овцы, h.козы, h.крс, h.лошади].some(v => v != null && (!Number.isFinite(+v) || +v < 0))) { out.push("Неверное поголовье у стада «" + str(h.имя, 60) + "»."); break; }
  if (ctx["демо_стада"]) out.push("В расчёте есть условные демо-стада — это пример, а не реальные хозяйства.");
  return out;
}
// без разметки, управляющих и невидимых знаков: направление письма и нулевая ширина подделывают чужие имена
const str = (x, max = 80) => plain(x).replace(/[\u0000-\u001f\u007f<>\u200b\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "").trim().slice(0, max);
const coordOk = (lat, lon) => Number.isFinite(+lat) && Number.isFinite(+lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
const PLOT_RE = /^[БД]-(С|СВ|В|ЮВ|Ю|ЮЗ|З|СЗ)$/;

function createApi({ getState, save, kv, vkey, botUsername, onFarmSaved, onDeleted, allowedOrigins, kelisimSecret }) {
  // состояние берём при каждом обращении: бот может заменить объект целиком при загрузке
  const st = () => { const s = getState(); s.users = s.users || {}; s.villagePlans = s.villagePlans || {}; return s; };
  // логин — поле самого пользователя: отдельный список логинов раньше не сохранялся, и после перезапуска войти было нельзя
  const byLogin = login => Object.values(st().users).filter(u => u.login === login).sort((a, b) => (a.created < b.created ? -1 : 1));
  const origins = new Set(allowedOrigins || []);
  const hits = new Map();   // простое ограничение частоты запросов по IP

  const coordinatorIds = () => new Set(String(process.env.COORDINATOR_IDS || "").split(",").map(s => s.trim()).filter(Boolean));
  const roleOf = u => (u && coordinatorIds().has(String(u.uid)) ? "coordinator" : "farmer");

  // ---------- HTTP-помощники ----------
  function cors(req, res) {
    const o = req.headers.origin;
    if (o && origins.has(o)) {
      res.setHeader("Access-Control-Allow-Origin", o);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
    }
  }
  function json(res, code, obj) {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(obj));
  }
  function body(req, max = MAX_BODY) {
    return new Promise((resolve, reject) => {
      // байты склеиваем целиком: буква на границе двух пакетов иначе превращается в «�»
      const parts = []; let n = 0, over = false;
      req.on("data", c => {
        n += c.length;
        if (n > max) { if (!over) { over = true; parts.length = 0; reject(Object.assign(new Error("слишком большой запрос"), { code: 413 })); } if (n > max * 8) req.destroy(); return; }
        parts.push(c);
      });
      req.on("end", () => {
        if (over) return;
        try { const s = Buffer.concat(parts).toString("utf8"), v = s ? JSON.parse(s) : {}; if (!v || typeof v !== "object" || Array.isArray(v)) throw 0; resolve(v); }
        catch (_) { reject(bad("неверный JSON")); }
      });
      req.on("aborted", () => reject(bad("запрос прерван")));
      req.on("error", () => reject(bad("запрос прерван")));
    });
  }
  function limited(req, key, max, perMs) {
    return over(key + ":" + clientIp(req), max, perMs);
  }
  /** Больше max событий за perMs. Отказы не копятся; при переполнении забываются самые старые ключи, а не все сразу. */
  function over(k, max, perMs) {
    const now = Date.now(), arr = (hits.get(k) || []).filter(t => now - t < perMs);
    hits.delete(k); hits.set(k, arr);
    if (hits.size > 20000) for (const old of hits.keys()) { hits.delete(old); if (hits.size <= 15000) break; }
    if (arr.length >= max) return true;
    arr.push(now);
    return false;
  }
  async function auth(req) {
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(req.headers.authorization || "");
    if (!m) return null;
    const s = await kv.get("sess:" + sha(m[1])), uid = s && typeof s === "object" ? s.uid : s;
    const u = uid != null && st().users[uid];
    // аккаунт удалили и создали заново — сессии прежнего не действуют
    if (u && s && s.at && s.at < Date.parse(u.created)) return null;
    return u ? { user: u, tokenHash: sha(m[1]) } : null;
  }

  async function newSession(uid) {
    const token = rnd(32);
    await kv.set("sess:" + sha(token), { uid, at: Date.now() }, SESSION_TTL);
    return token;
  }
  // попытки входа по одному логину — по очереди: иначе параллельные запросы проходят мимо счётчика
  const pwQueue = new Map();
  function inTurn(key, fn) {
    const p = (pwQueue.get(key) || Promise.resolve()).catch(() => {}).then(fn);
    pwQueue.set(key, p);
    p.catch(() => {}).then(() => { if (pwQueue.get(key) === p) pwQueue.delete(key); });
    return p;
  }

  // ---------- представления данных ----------
  const pubUser = u => ({
    uid: u.uid, name: u.name, username: u.username || null, login: u.login || null, via: u.login ? "password" : "telegram", role: roleOf(u), created: u.created,
    farm: u.farm || null, pastures: u.pastures || [], villages: roleOf(u) === "coordinator" ? (u.villages || []) : [],
  });
  const farmVk = u => (u.farm && u.farm.village ? vkey(u.farm.village.lat, u.farm.village.lon) : null);
  const canSeeVillage = (u, vk) => farmVk(u) === vk || (roleOf(u) === "coordinator" && (u.villages || []).some(v => v.vk === vk));

  function cleanFarm(b) {
    const v = b.village || {};
    if (!coordOk(v.lat, v.lon)) throw bad("укажите село");
    if (b.home != null && b.home !== "" && !(PLOT_RE.test(b.home) && b.home.startsWith("Б"))) throw bad("домашний участок — только ближний (Б-…)");
    if (b.plots != null && !Array.isArray(b.plots)) throw bad("участки: нужен список");
    const plots = b.plots || [];
    const badPlots = plots.filter(p => !PLOT_RE.test(p));
    if (badPlots.length) throw bad("неизвестные участки: " + badPlots.map(x => str(x, 10)).join(", "));
    return {
      name: str(b.name, 60) || "Хозяйство",
      village: { name: str(v.name, 80) || "Село", lat: +(+v.lat).toFixed(5), lon: +(+v.lon).toFixed(5) },
      sheep: count(b.sheep, SPECIES_RU.sheep, 20000), goats: count(b.goats, SPECIES_RU.goats, 20000), cattle: count(b.cattle, SPECIES_RU.cattle, 20000), horses: count(b.horses, SPECIES_RU.horses, 20000),
      daily_return: !!b.daily_return,
      home: b.home || "Б-С",
      // участки, которыми хозяйство пользуется по своим словам; это НЕ проверка по госреестру
      plots: [...new Set(plots)].slice(0, 16), rights_source: "user_entered",
      updated: new Date().toISOString(),
    };
  }
  /**
   * Своё пастбище: контур проверяется и площадь пересчитывается на сервере.
   * NDVI и состав покрова посчитаны В БРАУЗЕРЕ: сервер их не проверял, поэтому они хранятся с пометкой
   * provenance = "client_reported", verified = false. Подтверждённые сервером значения появляются только
   * после проверки снимка на сервере (ежедневная проверка, observations с source = "server").
   */
  function cleanPasture(b, existing) {
    const g = b.geometry || {};
    let ring = g.type === "Polygon" && Array.isArray(g.coordinates) ? g.coordinates[0] : null;
    if (!Array.isArray(ring) || ring.length < 3 || ring.length > 201) throw Object.assign(new Error("контур: от 3 до 200 точек"), { code: 400 });
    if (!ring.every(Array.isArray)) throw bad("контур: нужны координаты");
    ring = ring.map(p => [+(+p[0]).toFixed(6), +(+p[1]).toFixed(6)]);
    if (!ring.every(([x, y]) => coordOk(y, x))) throw Object.assign(new Error("неверные координаты"), { code: 400 });
    ring = PL.closeRing(ring);
    if (PL.ringSelfIntersects(ring)) throw bad("границы пересекают сами себя");
    const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
    if (Math.max(...xs) - Math.min(...xs) > 0.45 || Math.max(...ys) - Math.min(...ys) > 0.3) throw Object.assign(new Error("участок больше 30 км"), { code: 400 });
    const area = PL.polygonAreaHa(ring);
    if (area < 1) throw Object.assign(new Error("участок меньше 1 га"), { code: 400 });
    const key = JSON.stringify(ring.slice(0, -1).map(p => p.map(v => +v.toFixed(5))).sort());
    if ((existing || []).some(q => q.ring_key === key)) throw Object.assign(new Error("такое пастбище уже сохранено"), { code: 409 });
    const s = b.stats || {};
    const nd = x => (Number.isFinite(+x) && x !== null && Math.abs(+x) <= 1 ? +(+x).toFixed(3) : null);
    const series = (Array.isArray(s.series) ? s.series : []).slice(0, 12)
      .filter(x => x && /^\d{4}-\d{2}-\d{2}$/.test(x.d) && nd(x.v) != null).map(x => ({ d: x.d, v: nd(x.v) }));
    const ha = x => Math.min(Math.round(area * 10) / 10, Math.max(0, +x || 0));
    const frac = x => (Number.isFinite(+x) && x !== null ? Math.min(1, Math.max(0, +x)) : null);
    return {
      id: rnd(8), name: str(b.name, 60) || "Пастбище",
      geometry: { type: "Polygon", coordinates: [ring] }, ring_key: key,
      area_ha: Math.round(area * 10) / 10,
      water: !!b.water,                                        // ввод фермера: есть ли вода
      water_status: b.water ? "confirmed" : (s.water_on_map ? "satellite" : "unknown"),
      stats: {
        ndvi: nd(s.ndvi), series,
        pasture_ha: ha(s.pasture_ha), excluded_ha: ha(s.excluded_ha), uncertain_ha: ha(s.uncertain_ha),
        wc_pasture_share: Math.min(1, Math.max(0, +s.wc_pasture_share || 0)),
        valid_fraction: frac(s.valid_fraction), obs_count: series.length,
        water_on_map: !!s.water_on_map, year: num(s.year, 3000),
        provenance: "client_reported", verified: false,           // посчитано в браузере, сервер не проверял
      },
      created: new Date().toISOString(),
    };
  }
  function plotList(x, name) {
    if (x == null) return [];
    if (!Array.isArray(x)) throw bad(name + ": нужен список участков");
    const badIds = x.filter(p => !PLOT_RE.test(p));
    if (badIds.length) throw bad(name + ": неизвестные участки " + badIds.map(v => str(v, 10)).join(", "));
    return [...new Set(x)].slice(0, 16);
  }
  function cleanScenario(b, u) {
    const v = b.village || {};
    if (!coordOk(v.lat, v.lon)) throw bad("в сценарии нет села");
    if (b.herds != null && !Array.isArray(b.herds)) throw bad("стада: нужен список");
    if ((b.herds || []).length > MAX_HERDS) throw bad(`слишком большой сценарий: больше ${MAX_HERDS} стад`);
    const ids = new Set();
    const herds = (b.herds || []).map((h, i) => {
      if (!h || typeof h !== "object") throw bad("стадо " + (i + 1) + ": неверные данные");
      const id = str(h.id, 40) || "h" + i;
      if (ids.has(id)) throw bad("стадо повторяется: " + id);
      ids.add(id);
      if (h.home != null && h.home !== "" && !PLOT_RE.test(h.home)) throw bad("стадо " + (i + 1) + ": неизвестный участок " + str(h.home, 10));
      return { id, name: str(h.name, 60) || "Стадо", sheep: count(h.sheep, SPECIES_RU.sheep), goats: count(h.goats, SPECIES_RU.goats),
        cattle: count(h.cattle, SPECIES_RU.cattle), horses: count(h.horses, SPECIES_RU.horses), home: h.home || "Б-С", daily_return: !!h.daily_return,
        allowed_plots: plotList(h.allowed_plots, "разрешённые участки"), demo: !!h.demo,
        weight: (w => { if (w == null || w === "") return 1; const n = +w; if (![1, 1.5, 2].includes(n)) throw bad("стадо " + (i + 1) + ": приоритет 1, 1.5 или 2"); return n; })(h.weight) };
    });
    let params = {};
    if (b.params != null) {
      const r = M.validate(b.params);
      if (!r.ok) throw bad("параметры модели: " + r.errors.map(e => `${e.key} ${e.reason}`).join("; "));
      params = r.values;
    }
    const ws = b.water_status && typeof b.water_status === "object" ? b.water_status : {};
    const water_status = {};
    for (const [id, st] of Object.entries(ws)) {
      if (!PLOT_RE.test(id) || !["confirmed", "absent", "unknown"].includes(st)) throw bad("статус водопоя: " + str(id, 10) + " = " + str(st, 20));
      water_status[id] = st;
    }
    // отдых участков: { участок: { spring: дни, autumn: дни } } — целые 0…365
    const rs = b.rest && typeof b.rest === "object" ? b.rest : {};
    const rest = {};
    for (const [id, r] of Object.entries(rs)) {
      if (!PLOT_RE.test(id) || !r || typeof r !== "object") throw bad("отдых участка: " + str(id, 10));
      const d = x => { const n = x == null || x === "" ? 0 : +x; if (!Number.isInteger(n) || n < 0 || n > 365) throw bad("отдых участка " + id + ": дни 0…365"); return n; };
      const spring = d(r.spring), autumn = d(r.autumn);
      if (spring || autumn) rest[id] = { spring, autumn };
    }
    return {
      id: rnd(9), name: str(b.name, 80) || "Сценарий", owner: u.uid, ownerName: u.name,
      village: { name: str(v.name, 80), lat: +(+v.lat).toFixed(5), lon: +(+v.lon).toFixed(5) },
      herds, water: plotList(b.water, "водопои"), forbidden: plotList(b.forbidden, "закрытые участки"), water_status, rest, params,
      norm: b.norm == null ? undefined : (n => { if (!n) throw bad("норма нагрузки: неизвестная область"); return n; })(NM.clean(b.norm)),
      zone: Z.clean(b.zone) || undefined,
      model_version: M.MODEL_VERSION,
      request_id: /^[A-Za-z0-9_-]{8,64}$/.test(b.request_id || "") ? b.request_id : null,
      summary: cleanSummary(b.summary),
      created: new Date().toISOString(),
    };
  }

  // ---------- вход: вызывается ботом, когда человек нажал «Подтвердить вход» ----------
  async function loginInfo(nonce) {
    const rec = /^[A-Za-z0-9_-]{20,64}$/.test(nonce || "") && await kv.get("login:" + sha(nonce));
    return rec && rec.status === "pending" ? rec : null;
  }
  async function confirmLogin(nonce, from, ok) {
    const key = "login:" + sha(nonce);
    const rec = await kv.get(key);
    if (!rec || rec.status !== "pending") return false;
    if (!ok) { await kv.set(key, { status: "denied" }, 120); return true; }
    const uid = String(from.id);
    const name = str([from.first_name, from.last_name].filter(Boolean).join(" "), 80) || "Пользователь";
    const u = st().users[uid] = st().users[uid] || { uid, created: new Date().toISOString(), scenarios: [], history: [] };
    u.name = name; u.username = from.username ? str(from.username, 40) : null; u.lastLogin = new Date().toISOString();
    save();
    await kv.set(key, { status: "ok", uid }, 120);
    return true;
  }

  // Келісім: согласование по личным ссылкам, без аккаунта (kelisim.js)
  const kelisim = createKelisim({ kv, secret: kelisimSecret, known: (lat, lon) => { const v = (getState().villages || {})[vkey(lat, lon)]; return (v && v.data) || null; } });
  const kelisimRoute = createRoutes(kelisim, { json, body, limited });

  // ---------- маршруты ----------
  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    if (!p.startsWith("/auth/") && !p.startsWith("/api/me") && !p.startsWith("/api/scenarios") &&
        !p.startsWith("/api/history") && !p.startsWith("/api/coord") && !p.startsWith("/api/kelisim") && p !== "/api/village" && p !== "/api/ai" && p !== "/api/ai/status") return false;
    cors(req, res);
    if ((p === "/api/village" || p === "/api/ai/status") && !res.getHeader("Access-Control-Allow-Origin")) res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return true; }
    if (p.startsWith("/api/kelisim")) return kelisimRoute(req, res, p);
    try {
      // --- состояние ИИ: есть ли ключ, какие модели доступны, последние ошибки (без ключа) ---
      if (p === "/api/ai/status" && req.method === "GET") {
        if (limited(req, "aistatus", 6, 60e3)) return json(res, 429, { error: "слишком часто" }), true;
        // время работы и память процесса: видно, перезапускался ли сервер (например, по нехватке памяти на Render)
        return json(res, 200, Object.assign(await G.status(), { last_answer: lastAnswer, uptime_s: Math.round(process.uptime()),
          rss_mb: Math.round(process.memoryUsage().rss / 1048576) })), true;
      }
      // --- ИИ-помощник (DeepSeek или Gemini, ai.js): сводка по селу и чат. Доступен и гостю, с ограничением частоты ---
      if (p === "/api/ai" && req.method === "POST") {
        if (limited(req, "ai", 20, 60e3)) return json(res, 429, { error: "слишком много вопросов подряд, подождите минуту" }), true;
        if (!aiTake()) return json(res, 429, { error: "дневной лимит ИИ исчерпан, попробуйте завтра" }), true;
        const b = await body(req);
        const lang = b.lang === "kk" ? "kk" : "ru";
        if (!b.context || typeof b.context !== "object" || Array.isArray(b.context)) b.context = {};
        b.messages = (Array.isArray(b.messages) ? b.messages : []).filter(m => m && typeof m === "object");
        const issues = aiContextIssues(b.context);
        // сжатие под предел по протоколу ai-context.js (без обрезки строки): последние вопросы задают, какие участки важнее
        const userQ = (Array.isArray(b.messages) ? b.messages : []).slice(-12).filter(m => m && m.role !== "ai").map(m => str(m.text, 1200)).join("\n");
        const packed = X.compactContext(b.context && typeof b.context === "object" ? b.context : {}, { max: AI_CTX_MAX, focusText: userQ });
        const ctx = packed.json;
        const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-12)
          .map(m => `${m.role === "ai" ? "Помощник" : "Пользователь"}: ${str(m.text, 1200)}`).join("\n");
        // сегодняшняя дата: без неё модель берёт «лето снимков» за текущее время и ищет прогноз на июль
        const today = todayText(lang);
        const userText = userQ + "\n" + today;   // числа из вопросов пользователя и сегодняшняя дата допустимы в ответе
        const lastQ = (Array.isArray(b.messages) ? b.messages : []).filter(m => m && m.role !== "ai").slice(-1).map(m => str(m.text, 1200))[0] || "";
        const web = b.mode !== "summary" && searchAllowed() && needsWeb(lastQ);
        const task = (b.mode === "summary" ? AI_SUMMARY[lang] : AI_CHAT[lang]) + (web ? WEB_TASK[lang] : "");
        const input = `СЕГОДНЯ: ${today}\n\nДАННЫЕ (JSON):\n${ctx}\n\nПРОБЛЕМЫ_ДАННЫХ: ${issues.length ? issues.join(" ") : "нет"}\n\n` +
          `${msgs ? "РАЗГОВОР:\n" + msgs + "\n\n" : ""}ЗАДАЧА: ${task}`;
        // Казахский текст занимает больше токенов, чем русский: сводке нужен запас по длине и времени.
        // Сайт ждёт 90 с, поэтому общий бюджет — 60 с, на одну модель — до 30 с.
        const summary = b.mode === "summary";
        const started = Date.now();
        const opts = { system: AI_SYSTEM[lang], maxTokens: summary ? (lang === "kk" ? 900 : 600) : (lang === "kk" ? 900 : 700),
          timeoutMs: summary ? 30000 : 25000 };
        // Поиск в интернете — только в чате и в пределах дневного лимита (найденные страницы оплачиваются как токены);
        // сводка строится только по данным села. Искать ли — решает модель по правилу SEARCH_RULE.
        const search = !summary && searchAllowed();
        let retried = false;
        let r = await G.ask(Object.assign({ input, budgetMs: 60000, search }, opts, search ? { system: opts.system + " " + SEARCH_RULE[lang] } : {}));
        if (r.ok && r.searches) searchUsed(r.searches);
        // модель ищет не каждый раз (на проде тот же вопрос о погоде — то 3 поиска, то 0): вопрос о свежих сведениях без поиска —
        // один повтор с прямым требованием, если хватает времени; лучше ответ с поиском
        if (r.ok && web && !r.searches && searchAllowed() && Date.now() - started < 30000) {
          const again = await G.ask(Object.assign({ budgetMs: 30000, search: true }, opts, { system: opts.system + " " + SEARCH_RULE[lang],
            input: input + "\n\n" + WEB_RETRY[lang] }));
          if (again.ok && again.searches) { searchUsed(again.searches); r = again; }
          retried = true;
        }
        if (!r.ok) {
          // ИИ не ответил — шаблон из тех же данных: сайт и демо не зависят от перегрузок и баланса провайдера
          const ERR = { no_key: "ИИ не настроен на сервере", timeout: "ИИ не ответил вовремя, попробуйте ещё раз",
            quota: "у ИИ закончился лимит запросов, попробуйте позже", key: "ключ ИИ на сервере не принят",
            balance: "у ИИ закончился оплаченный баланс — сообщите администратору сервиса",
            model_not_found: "модели ИИ из настроек сервера недоступны",
            overloaded: "серверы ИИ сейчас перегружены, ИИ не ответил — попробуйте через минуту" };
          const SHORT = { ru: { overloaded: "серверы ИИ перегружены", timeout: "не успел ответить", quota: "закончился лимит запросов", balance: "закончился баланс ИИ" },
            kk: { overloaded: "ЖИ серверлері жүктелген", timeout: "уақытында жауап бермеді", quota: "сұраныс лимиті бітті", balance: "ЖИ балансы бітті" } };
          return json(res, 200, { text: F.templateAnswer(b.context, lang, issues, SHORT[lang][r.error] || ""), fallback: true, model: null,
            error: ERR[r.error] || "ИИ сейчас перегружен, попробуйте через минуту", reason: r.error, issues }), true;
        }
        // Проверка чисел: всё, чего нет в данных и в вопросах пользователя, — выдумано или посчитано моделью.
        // Один повтор с просьбой убрать такие числа, если хватает времени (сайт ждёт 90 с).
        // числа из фрагментов ответа, подтверждённых источником поиска, тоже допустимы (источник показан под ответом)
        let check = F.verifyNumbers(r.text, packed.obj, userText + "\n" + (r.cited || []).join("\n"));
        const left = 80000 - (Date.now() - started);
        // ответ, для которого модель искала в интернете, не переписываем без поиска (иначе теряются найденные сведения) — только помечаем
        if (!check.ok && left > 15000 && !(r.sources || []).length && !r.searches) {
          const again = await G.ask(Object.assign({}, opts, { budgetMs: Math.min(30000, left), input: input +
            `\n\nПРОВЕРКА: в черновике ответа были числа, которых нет в ДАННЫХ: ${check.unknown.join(", ")}. ` +
            "Напиши ответ заново, используя только числа из ДАННЫХ; если нужного числа нет — скажи, что его нет в расчёте." }));
          if (again.ok) { const c2 = F.verifyNumbers(again.text, packed.obj, userText); if (c2.unknown.length <= check.unknown.length) { r = again; check = c2; } }
        }
        lastAnswer = { at: new Date().toISOString(), mode: summary ? "summary" : "chat", search_allowed: search, web_task: web, searches: r.searches || 0,
          sources: (r.sources || []).length, numbers_ok: check.ok, unknown_numbers: check.unknown.length, search_retry: retried };
        // [интернет] без единого источника — это общие знания модели, а не поиск: метка исправляется на [общее]
        if (!(r.sources || []).length) r.text = fixWebLabels(r.text);
        return json(res, 200, { text: r.text, model: r.model, issues, numbers: check,
          sources: r.sources || [], suggestions: (r.sources || []).length ? r.suggestions || "" : "",
          note: "Ответ ИИ — пояснение расчёта, а не заключение агронома или госоргана." }), true;
      }
      // --- вход ---
      if (p === "/auth/start" && req.method === "POST") {
        if (limited(req, "start", 10, 60e3)) return json(res, 429, { error: "слишком часто, подождите минуту" }), true;
        const nonce = rnd(24), code = String(crypto.randomInt(1000, 10000));
        await kv.set("login:" + sha(nonce), { status: "pending", code, created: Date.now() }, LOGIN_TTL);
        return json(res, 200, { nonce, code, link: `https://t.me/${botUsername}?start=login_${nonce}`, expires_in: LOGIN_TTL }), true;
      }
      // регистрация и вход по логину и паролю — по выбору, вход через Telegram остаётся
      if (p === "/auth/register" && req.method === "POST") {
        if (limited(req, "register", 20, 10 * 60e3) || over("register*", 200, 3600e3)) return json(res, 429, { error: "слишком много регистраций, подождите 10 минут" }), true;
        const b = await body(req);
        const login = normLogin(b.login);
        if (!login) return json(res, 400, { error: "логин: телефон +7…, e-mail или имя латиницей (3–32 знака)", field: "login" }), true;
        const pw = plain(b.password);
        if (pw.trim().length < 8 || pw.length > 128) return json(res, 400, { error: "пароль — от 8 до 128 знаков", field: "password" }), true;
        if (pw.toLowerCase() === login || /^(\d)\1+$/.test(pw) || /^(12345678|123456789|1234567890|password|qwerty123|йцукенгш)$/i.test(pw))
          return json(res, 400, { error: "слишком простой пароль", field: "password" }), true;
        const name = str(b.name, 80).trim();
        if (!name) return json(res, 400, { error: "укажите имя", field: "name" }), true;
        const taken = () => byLogin(login).length > 0, busy = () => (json(res, 409, { error: "такой логин уже зарегистрирован — войдите", field: "login" }), true);
        if (taken()) return busy();
        const hash = await hashPassword(pw);
        if (taken()) return busy();                          // пока считали хэш, логин заняли
        const uid = "a" + rnd(9);
        st().users[uid] = { uid, created: new Date().toISOString(), scenarios: [], history: [], name, login, pw: hash, lastLogin: new Date().toISOString() };
        save();
        const token = await newSession(uid);
        return json(res, 200, { status: "ok", token, user: pubUser(st().users[uid]) }), true;
      }
      if (p === "/auth/login" && req.method === "POST") {
        if (limited(req, "pwlogin", 30, 60e3)) return json(res, 429, { error: "слишком много попыток, подождите минуту" }), true;
        const b = await body(req);
        const login = normLogin(b.login), pw = plain(b.password).slice(0, 128);
        // неверные попытки на один логин: 10 за 15 минут с одного адреса и 50 со всех — чужой адрес не запрёт хозяина
        const lh = sha(login || "-"), mineK = "pwfail:" + lh + ":" + sha(clientIp(req)).slice(0, 16), allK = "pwfail:" + lh;
        const r = await inTurn(lh, async () => {
          const mine = (await kv.get(mineK)) || 0, all = (await kv.get(allK)) || 0;
          if (mine >= 10 || all >= 50) return "wait";
          // после старой ошибки у одного логина могло появиться несколько аккаунтов: подходит тот, чей пароль верен
          let u = null;
          for (const x of login ? byLogin(login).slice(0, 3) : []) if (await checkPassword(pw, x.pw)) { u = x; break; }
          if (!u && !(login && byLogin(login).length)) await checkPassword(pw, DUMMY_PW);
          if (u) { await kv.del(mineK); return u; }
          await kv.set(mineK, mine + 1, 15 * 60); await kv.set(allK, all + 1, 15 * 60);
          return null;
        });
        if (r === "wait") return json(res, 429, { error: "слишком много неверных попыток для этого логина, подождите 15 минут" }), true;
        if (!r) return json(res, 401, { error: "неверный логин или пароль" }), true;
        r.lastLogin = new Date().toISOString(); save();
        return json(res, 200, { status: "ok", token: await newSession(r.uid), user: pubUser(r) }), true;
      }
      if (p === "/auth/poll" && req.method === "GET") {
        if (limited(req, "poll", 120, 60e3)) return json(res, 429, { error: "слишком часто" }), true;
        const nonce = url.searchParams.get("nonce") || "";
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(nonce)) return json(res, 400, { error: "неверный код" }), true;
        const key = "login:" + sha(nonce), rec = await kv.get(key);
        if (!rec) return json(res, 200, { status: "expired" }), true;
        if (rec.status === "pending") return json(res, 200, { status: "pending" }), true;
        await kv.del(key);                                  // одноразовый
        if (rec.status !== "ok" || !st().users[rec.uid]) return json(res, 200, { status: "denied" }), true;
        return json(res, 200, { status: "ok", token: await newSession(rec.uid), user: pubUser(st().users[rec.uid]) }), true;
      }

      // --- публично: стада села из Telegram (чужие — без имён) и число подписок на участки ---
      if (p === "/api/village" && req.method === "GET") {
        const me = await auth(req);
        const vk = vkey(url.searchParams.get("lat"), url.searchParams.get("lon"));
        const v = (st().villages || {})[vk];
        const subs = {};
        for (const c of Object.values(st().chats || {})) for (const k of c.subs || []) {
          const [kv, id] = k.split("|"); if (kv === vk) subs[id] = (subs[id] || 0) + 1;
        }
        let n = 0;
        const lim = x => Math.min(20000, Math.max(0, Math.round(+x) || 0));
        const herds = (v && v.herds || []).slice(0, 100).map(h => {
          const mine = !!me && h.id === "tg" + me.user.uid;
          return { id: mine ? "mine" : "tg" + (++n), name: mine ? h.name : null, mine, from_bot: true,
            sheep: lim(h.sheep), goats: lim(h.goats), cattle: lim(h.cattle), horses: lim(h.horses), home: h.home, daily_return: !!h.daily_return };
        });
        return json(res, 200, { herds, subs }), true;
      }

      const a = await auth(req);
      if (!a) return json(res, 401, { error: "нужно войти" }), true;
      const u = a.user;

      if (p === "/auth/logout" && req.method === "POST") { await kv.del("sess:" + a.tokenHash); return json(res, 200, { ok: true }), true; }

      // --- профиль ---
      if (p === "/api/me" && req.method === "GET") return json(res, 200, pubUser(u)), true;
      if (p === "/api/me" && req.method === "DELETE") {      // удалить аккаунт и все свои данные
        const vk = farmVk(u);
        delete st().users[u.uid];
        for (const vk2 of Object.keys(st().villagePlans)) st().villagePlans[vk2] = st().villagePlans[vk2].filter(s => s.owner !== u.uid);
        if (onFarmSaved) onFarmSaved(u.uid, null, vk);
        if (onDeleted) onDeleted(u.uid);
        await kv.del("sess:" + a.tokenHash);
        save();
        return json(res, 200, { ok: true }), true;
      }
      if (p === "/api/me/farm" && req.method === "PUT") {
        const oldVk = farmVk(u);
        u.farm = cleanFarm(await body(req));
        save();
        if (onFarmSaved) onFarmSaved(u.uid, u.farm, oldVk);
        return json(res, 200, pubUser(u)), true;
      }

      // --- свои пастбища (контур рисует фермер) ---
      if (p === "/api/me/pastures" && req.method === "POST") {
        if ((u.pastures || []).length >= 10) return json(res, 400, { error: "не больше 10 пастбищ на хозяйство" }), true;
        const past = cleanPasture(await body(req), u.pastures);
        u.pastures = (u.pastures || []).concat([past]);
        save();
        return json(res, 200, pubUser(u)), true;
      }
      const pm = /^\/api\/me\/pastures\/([A-Za-z0-9_-]{6,20})$/.exec(p);
      if (pm && req.method === "DELETE") {
        const before = (u.pastures || []).length;
        u.pastures = (u.pastures || []).filter(x => x.id !== pm[1]);
        if (u.pastures.length === before) return json(res, 404, { error: "пастбище не найдено" }), true;
        save();
        return json(res, 200, pubUser(u)), true;
      }

      // --- сценарии: свои + общие планы сёл, к которым есть доступ ---
      if (p === "/api/scenarios" && req.method === "GET") {
        const shared = [];
        for (const [vk, list] of Object.entries(st().villagePlans)) if (canSeeVillage(u, vk)) shared.push(...list.map(s => Object.assign({ shared: true }, s)));
        return json(res, 200, { own: u.scenarios || [], shared }), true;
      }
      if (p === "/api/scenarios" && req.method === "POST") {
        const b = await body(req);
        const dup = b && b.request_id && (u.scenarios || []).concat(...Object.values(st().villagePlans)).find(x => x.request_id === b.request_id && x.owner === u.uid);
        if (dup) return json(res, 200, Object.assign({ duplicate: true }, dup)), true;    // повторная отправка того же запроса
        const s = cleanScenario(b, u);
        if (b.shared) {
          const vk = vkey(s.village.lat, s.village.lon);
          if (roleOf(u) !== "coordinator" || !(u.villages || []).some(v => v.vk === vk))
            return json(res, 403, { error: "общий план села может публиковать только координатор этого села" }), true;
          s.shared = true;
          st().villagePlans[vk] = [s].concat(st().villagePlans[vk] || []).slice(0, 10);
        } else {
          u.scenarios = [s].concat(u.scenarios || []).slice(0, 30);
        }
        save();
        return json(res, 200, s), true;
      }
      const sm = /^\/api\/scenarios\/([A-Za-z0-9_-]{6,20})$/.exec(p);
      if (sm && req.method === "DELETE") {
        const before = (u.scenarios || []).length;
        u.scenarios = (u.scenarios || []).filter(s => s.id !== sm[1]);
        let found = u.scenarios.length !== before;
        for (const vk of Object.keys(st().villagePlans)) {
          const list = st().villagePlans[vk];
          const mine = list.filter(s => s.id === sm[1] && s.owner === u.uid);
          if (mine.length) { st().villagePlans[vk] = list.filter(s => s.id !== sm[1]); found = true; }
        }
        if (!found) return json(res, 404, { error: "сценарий не найден или принадлежит другому пользователю" }), true;
        save();
        return json(res, 200, { ok: true }), true;
      }

      // --- история расчётов ---
      if (p === "/api/history" && req.method === "GET") return json(res, 200, u.history || []), true;
      if (p === "/api/history" && req.method === "POST") {
        const b = await body(req), v = b.village || {};
        if (!coordOk(v.lat, v.lon)) return json(res, 400, { error: "нет села" }), true;
        const e = { at: new Date().toISOString(), kind: str(b.kind, 20) || "расчёт",
          village: { name: str(v.name, 80), lat: +(+v.lat).toFixed(5), lon: +(+v.lon).toFixed(5) },
          summary: cleanSummary(b.summary) };
        u.history = [e].concat(u.history || []).slice(0, 50);
        save();
        return json(res, 200, e), true;
      }

      // --- координатор ---
      if (p.startsWith("/api/coord")) {
        if (roleOf(u) !== "coordinator") return json(res, 403, { error: "раздел доступен только координатору (акимату)" }), true;
        if (p === "/api/coord/villages" && req.method === "POST") {
          const v = (await body(req)).village || {};
          if (!coordOk(v.lat, v.lon)) return json(res, 400, { error: "укажите село" }), true;
          const vk = vkey(v.lat, v.lon);
          u.villages = (u.villages || []).filter(x => x.vk !== vk).concat([{ vk, name: str(v.name, 80), lat: +(+v.lat).toFixed(5), lon: +(+v.lon).toFixed(5) }]).slice(0, 30);
          save();
          return json(res, 200, pubUser(u)), true;
        }
        if (p === "/api/coord/villages" && req.method === "DELETE") {
          const vk = url.searchParams.get("vk");
          u.villages = (u.villages || []).filter(x => x.vk !== vk);
          save();
          return json(res, 200, pubUser(u)), true;
        }
        if (p === "/api/coord/farms" && req.method === "GET") {
          const vk = url.searchParams.get("vk");
          if (!(u.villages || []).some(v => v.vk === vk)) return json(res, 403, { error: "это село не в вашем списке" }), true;
          const farms = Object.values(st().users).filter(x => farmVk(x) === vk).map(x => ({
            uid: x.uid, owner: x.name, name: x.farm.name, sheep: x.farm.sheep, goats: x.farm.goats, cattle: x.farm.cattle,
            horses: x.farm.horses, daily_return: x.farm.daily_return, home: x.farm.home, plots: x.farm.plots, updated: x.farm.updated,
            pastures: (x.pastures || []).map(q => ({ id: q.id, name: q.name, geometry: q.geometry, area_ha: q.area_ha, water: q.water, ndvi: q.stats && q.stats.ndvi,
              ndvi_provenance: (q.stats && q.stats.provenance) || "client_reported" })),
          }));
          return json(res, 200, { vk, farms }), true;
        }
      }
      return json(res, 404, { error: "нет такого адреса" }), true;
    } catch (e) {
      const known = Number.isInteger(e.code) && e.code >= 400 && e.code < 600;      // у сбоев сети code — строка, это не ответ человеку
      if (!known) console.error("api", p, e);
      return json(res, known ? e.code : 500, { error: known ? e.message : "внутренняя ошибка" }), true;
    }
  }

  return { handle, confirmLogin, loginInfo, roleOf, kelisim };
}

module.exports = { createApi, aiTake, aiContextIssues, fixWebLabels, searchAllowed, searchUsed, SEARCH_RULE, needsWeb, todayText };
