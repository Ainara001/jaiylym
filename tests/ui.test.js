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
    for (const m of read(f).matchAll(/\bt\("([a-zA-Z0-9._]+)"/g)) used.add(m[1]);
  }
  // экраны Келісім: tt("x") → kel.x; ключи по кодам расчёта
  const kel = read("web/js/kelisim-ui.js"), K = require("../web/kelisim.js");
  for (const m of kel.matchAll(/\btt\("([\w.]+[\w])"/g)) used.add("kel." + m[1]);
  for (const m of kel.matchAll(/tt\([^()]*?\? "([\w.]+)" : "([\w.]+)"/g)) { used.add("kel." + m[1]); used.add("kel." + m[2]); }
  for (const m of kel.matchAll(/\bt\("([\w.]+[\w])"/g)) if (!/^herds\.w$/.test(m[1])) used.add(m[1]);
  for (const r of K.REASONS) used.add("kel.rs." + r);
  for (const r of K.RULES) { used.add("kel.rule." + r); used.add("kel.rule." + r + "D"); }
  for (const x of K.TYPES) used.add("kel.pt." + x);
  for (const v of ["free", "own", "others", "impossible", "none", "not_calculated", "error"]) { used.add("kel.vd." + v); used.add("kel.vd." + v + "Org"); }
  for (const x of ["daily", "far", "nearest", "closer_full", "shared", "preferred"]) used.add("kel.why." + x);
  for (const x of ["start", "proposal", "add", "remove", "edit", "rule", "restore"]) used.add("kel.wh." + x);
  for (const x of ["open", "accepted", "declined", "withdrawn"]) used.add("kel.pst." + x);
  for (const x of ["not_a_contract", "no_land_rights", "herds_declared", "model_estimate"]) used.add("kel.lim." + x);
  for (const x of ["none", "entered", "declared", "confirmed"]) used.add("kel.hs." + x);
  for (const m of read("kelisim.js").matchAll(/why: "(\w+)"/g)) used.add("kel.err." + m[1]);
  for (const m of read("web/index.html").matchAll(/data-i18n(?:-ph|-label)?="([a-zA-Z0-9._]+)"/g)) used.add(m[1]);
  // ключи, собираемые из переменной: t("conf." + c) — их полноту проверяет следующий тест
  const dynamic = /^(conf|role|herds|src|hist|ab|map\.mode|fc|how\.step|how\.f|unit|meta|rsn|set\.origin|veg|vt|why|wi\.a|wi\.st|wi\.v|wi\.v\.algo|algo|wr|ws|sg|rs|mt\.v|mt\.r|mt\.s)\.$/;
  const missing = [...used].filter(k => !ru.includes(k) && !dynamic.test(k) && !/^ab\.(f|g\.)$/.test(k));
  assert.deepEqual(missing, []);
});

test("для всех кодов движка и модели есть тексты (статусы, причины, нарушения, водопой)", () => {
  const ru = new Set(Array.from(loadI18n().keys().ru));
  const M = require("../web/model.js");
  const need = [
    ...["high", "medium", "low", "none"].map(x => "conf." + x),
    ...["none", "unconfirmed", "calibrated"].map(x => "fc." + x),
    ...M.WATER_STATUS.map(x => "ws." + x),
    ...M.VEGETATION.map(x => "veg." + x),
    ...["default", "user", "calibrated"].map(x => "set.origin." + x),
    ...["forbidden", "no_data", "low_quality", "no_water", "closed", "not_allowed", "daily_far", "unknown_plot"].map(x => "rsn." + x),
    ...["capacity", "no_allowed_plots", "calendar"].map(x => "why." + x),
    ...["add_water", "check_data", "extend_rights", "split_daily_herd", "reduce_herd", "hay"].map(x => "sg." + x),
    ...["no_data_excluded", "low_quality_used", "water_unconfirmed", "rights_not_specified", "rights_user_entered", "forage_unconfirmed"].map(x => "wr." + x),
    ...["overload", "unknown_capacity", "forbidden_used", "no_water_used", "not_allowed_used", "daily_far", "negative", "conservation", "calendar_gap", "calendar_overlap_or_gap", "window", "calendar_end"].map(x => "vt." + x),
    ...["feasible", "partially_feasible", "infeasible", "no_demand"].map(x => "wi.st." + x),
    ...["current", "plan", "forage", "herds", "season", "cautious", "optimistic"].map(x => "wi.v." + x),
    ...["cautious", "base", "optimistic"].map(x => "wi.a." + x),
    ...["optimized", "greedy"].flatMap(x => ["algo." + x, "wi.v.algo." + x]),
    ...["area", "ndvi", "biomass", "forage", "au_days", "au_season", "sheep", "herd_intake", "days"].flatMap(x => ["how.step." + x, "unit." + x]),
    "how.f.area", "how.f.ndvi", "how.step.norm", "how.step.limit", "unit.norm", "unit.limit", "src.norm", "how.step.nograze", "unit.nograze", "src.osm",
    ...["measured", "no_data"].map(x => "meta." + x),
    ...["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9"].map(x => "rs." + x),
  ];
  assert.deepEqual(need.filter(k => !ru.has(k)), []);
});

test("тексты README и интерфейса о достоверности совпадают с правилом в коде", () => {
  const M = require("../web/model.js");
  const { high, medium } = M.QUALITY_RULES;
  const I = loadI18n();
  const ruConf = read("web/js/i18n.js");
  for (const n of [high.obs, high.samples, Math.round(high.valid * 100), medium.obs, medium.samples, Math.round(medium.valid * 100)])
    assert.ok(ruConf.includes(String(n)), "число " + n + " есть в описании");
  const readme = read("README.md");
  assert.match(readme, /от 4 безоблачных дат, от 300 пастбищных пикселей 10 м и от 70 %/);
  assert.ok(I.t("data.conf.d").includes("300"));
});

test("в интерфейсе и боте нет цветных смайликов", () => {
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
  for (const f of ["web/index.html", "web/js/app.js", "web/js/i18n.js", "web/js/report.js", "web/js/kelisim-ui.js", "web/css/app.css", "web/model.js", "web/engine.js", "api.js"]) {
    const lines = read(f).split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => emoji.test(l));
    assert.deepEqual(lines, [], f);
  }
  const bot = read("bot.js").split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => emoji.test(l) && !/console\.log/.test(l));
  assert.deepEqual(bot, [], "bot.js");
});

test("предупреждения о данных из model.js переведены на казахский (вкладка «Данные»)", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "web", "js", "app.js"), "utf8");
  const M = require("../web/model.js");
  const w = M.metaOf({ source: { year: 2026, dates: ["2026-07-01"] } }).warnings;
  assert.ok(w.length >= 2);
  // каждое предупреждение metaOf попадает под шаблон META_WARN
  const res = [...src.matchAll(/\[\/(\^[^\n]*?)\/, /g)].map(m => new RegExp(m[1]));
  for (const x of w) assert.ok(res.some(re => re.test(x)), "нет перевода для: " + x);
});
