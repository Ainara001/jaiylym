// Готовое село-пример для web/data: снимки этого лета, прошлое лето, ряд с 2019 года, зоны «нельзя пасти» и картинка NDVI —
// тем же pipeline.js, что сайт считает для любого села. Нужен, чтобы пример открывался сразу и без сети.
// Запуск: node scripts/build_example.js beskol
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const PL = require("../web/pipeline.js");
const NG = require("../web/nograze.js");

const UA = "Jaiylym-hackathon/1.0 (+https://github.com/Ainara001/jaiylym)";
PL.setUserAgent(UA); NG.setUserAgent(UA);
const DATA = path.join(__dirname, "..", "web", "data");
const FIRST = 2019;
// координаты — точка села в OpenStreetMap (та же, что вернёт поиск на сайте)
const VILLAGES = {
  beskol: { name: "Бесколь", region: "Северо-Казахстанская область", lat: 54.77515, lon: 69.09779, global: "JAIYLYM_BESKOL" },
};

// ---------- PNG с палитрой (как ndviPng в app.js, но 8 бит на пиксель) ----------
const STOPS = [[0.05, [140, 81, 10]], [0.2, [216, 181, 106]], [0.35, [159, 208, 104]], [0.55, [47, 154, 75]]];
function ramp(v) {
  if (v <= STOPS[0][0]) return STOPS[0][1];
  for (let k = 1; k < STOPS.length; k++) if (v <= STOPS[k][0]) {
    const [a, ca] = STOPS[k - 1], [b, cb] = STOPS[k], q = (v - a) / (b - a);
    return ca.map((x, j) => Math.round(x + (cb[j] - x) * q));
  }
  return STOPS[STOPS.length - 1][1];
}
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const t = Buffer.concat([Buffer.from(type, "latin1"), data]), o = Buffer.alloc(8 + data.length + 4);
  o.writeUInt32BE(data.length, 0); t.copy(o, 4); o.writeUInt32BE(crc(t), 8 + data.length);
  return o;
}
function ndviPng(grid) {
  const n = grid.size, LV = 101, lo = 0.05, hi = 0.55;                // цвет 0 — прозрачный, дальше 101 ступень NDVI
  const pal = Buffer.alloc((LV + 1) * 3), tr = Buffer.alloc(LV + 1, 190); tr[0] = 0;
  for (let i = 0; i < LV; i++) Buffer.from(ramp(lo + (hi - lo) * i / (LV - 1))).copy(pal, (i + 1) * 3);
  const raw = Buffer.alloc(n * (n + 1));
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = grid.ndvi[y * n + x];
    if (grid.pasture[y * n + x] && !Number.isNaN(v)) raw[y * (n + 1) + 1 + x] = 1 + Math.round(Math.min(1, Math.max(0, (v - lo) / (hi - lo))) * (LV - 1));
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 3;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("PLTE", pal), chunk("tRNS", tr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

(async () => {
  const id = process.argv[2], V = VILLAGES[id];
  if (!V) throw new Error("Село: " + Object.keys(VILLAGES).join(", "));
  const { name, lat, lon } = V, say = m => console.log(m);
  const D = await PL.buildVillage({ name, lat, lon, onProgress: say });
  const png = ndviPng(D.grid); delete D.grid;
  D.village.region = V.region;
  // площадь пастбищ по документам и условные стада примера переносим из прежнего файла, если они там были
  try { const old = require("../data").loadExamples().find(x => x.village.name === V.name); if (old && old.village.official) D.village.official = old.village.official; if (old && old.herds) D.herds = old.herds; } catch (_) {}
  if (!D.nograze || D.nograze.status !== "ok") D.nograze = await PL.buildNoGraze({ lat, lon, onProgress: say });
  if (D.nograze.status !== "ok") throw new Error("зоны OSM не получены (Overpass): " + D.nograze.error);
  const year = D.source.year;
  D.prev_season = await PL.buildSeason({ lat, lon, year: year - 1, onProgress: say });
  const years = Array.from({ length: year - FIRST + 1 }, (_, i) => FIRST + i);
  const seasons = await PL.buildYears({ lat, lon, years, onProgress: ({ year: y }) => say("лето " + y) });
  D.multiyear = { first: FIRST, last: year, calculated_at: new Date().toISOString(), precip: await PL.fetchPrecip({ lat, lon, years }),
    seasons: seasons.map(s => ({ year: s.year, status: s.status, dates: s.dates, window: s.window || null, valid_fraction: s.valid_fraction,
      plots: s.plots.map(p => ({ id: p.id, ndvi: p.ndvi, valid_fraction: p.valid_fraction })) })) };
  fs.writeFileSync(path.join(DATA, id + ".js"), `window.${V.global} = ${JSON.stringify(D)};\n`);
  fs.writeFileSync(path.join(DATA, id + ".png"), png);
  console.log(`${name}: ${D.plots.length} участков, пастбищ ${Math.round(D.plots.reduce((s, p) => s + p.pasture_ha, 0))} га, зоны ${JSON.stringify(D.nograze.counts)}, прошлое лето ${D.prev_season.status}, лет ${seasons.length}; PNG ${Math.round(png.length / 1024)} КБ`);
})().catch(e => { console.error(e); process.exit(1); });
