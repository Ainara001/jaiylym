// Общий кэш посчитанных сёл: первый посетитель села запускает расчёт на сервере, следующие получают готовое сразу.
// Считает только сервер (тем же pipeline.js, что и сайт) — от браузера расчёт не принимается, подделать данные села нельзя.
// Каждое село — отдельная запись хранилища vc:<широта,долгота до 0,001°> со сроком, а не часть общего состояния бота.
const zlib = require("zlib");

const TTL = 10 * 24 * 3600;                         // через 10 дней — заново: летом появляются новые снимки
const KZ = { lat: [40, 56], lon: [46, 88] };        // только Казахстан: точки за его пределами не считаем

// ---------- картинка NDVI: PNG с палитрой (тот же вид, что у примеров сёл) ----------
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
/** Сетка NDVI села → PNG: прозрачно там, где не пастбище; 101 ступень цвета от 0,05 до 0,55. */
function ndviPng(grid) {
  const n = grid.size, LV = 101, lo = 0.05, hi = 0.55;
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

/**
 * @param kv      хранилище { get, set } (Redis или память)
 * @param vkey    (lat, lon) → ключ села
 * @param build   ({ lat, lon }) → { data, png } — расчёт села; по умолчанию pipeline.js
 * @param fresh   data → true, если расчёт годится (то же правило земли и то же лето)
 */
// село с картинкой — 100–170 КБ: храним не больше keep последних сёл, чтобы не переполнить бесплатное хранилище
function createVillageCache({ kv, vkey, build, fresh, perHour = 20, queueMax = 5, keep = 40, now = () => Date.now() }) {
  const queue = [], queued = new Set();
  let busy = false, hour = { t: 0, n: 0 };
  const okPoint = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && lat >= KZ.lat[0] && lat <= KZ.lat[1] && lon >= KZ.lon[0] && lon <= KZ.lon[1];
  async function run() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        try {
          const r = await build(job);
          const ng = r && r.data && r.data.nograze;
          // зоны «нельзя пасти» не загрузились — такой расчёт не сохраняем для всех: в следующий раз посчитаем заново
          if (r && r.data && Array.isArray(r.data.plots) && ng && ["ok", "empty"].includes(ng.status)) {
            await kv.set("vc:" + job.vk, { data: r.data, png: r.png, at: new Date(now()).toISOString() }, TTL);
            const list = ((await kv.get("vc:list")) || []).filter(x => x !== job.vk).concat([job.vk]);
            for (const old of list.splice(0, Math.max(0, list.length - keep))) await kv.del("vc:" + old);
            await kv.set("vc:list", list, TTL);
          }
        } catch (e) { console.error("кэш села:", job.vk, e.message); }
        queued.delete(job.vk);
      }
    } finally { busy = false; }
  }
  return {
    /** Готовое село или { status: "building" | "busy" }: в обоих случаях сайт считает сам, а сервер — для следующих. */
    async get(lat, lon) {
      lat = +lat; lon = +lon;
      if (!okPoint(lat, lon)) return { status: "outside" };
      const vk = vkey(lat, lon), hit = await kv.get("vc:" + vk);
      if (hit && hit.data && fresh(hit.data)) return { status: "ok", data: hit.data, png: hit.png, at: hit.at };
      if (queued.has(vk)) return { status: "building" };
      const t = now();
      if (t - hour.t > 3600e3) hour = { t, n: 0 };
      if (queue.length >= queueMax || hour.n >= perHour) return { status: "busy" };
      hour.n++; queued.add(vk); queue.push({ vk, lat: +lat.toFixed(5), lon: +lon.toFixed(5) });
      run();
      return { status: "building" };
    },
    get pending() { return queue.length + (busy ? 1 : 0); },
  };
}

/** Расчёт села тем же pipeline.js, что и сайт: снимки, зоны OSM (с ожиданием), область для нормы, картинка NDVI. */
function pipelineBuild(PL) {
  return async ({ lat, lon }) => {
    const [res, region] = await Promise.all([PL.buildVillage({ name: "", lat, lon }), PL.regionAt(lat, lon).catch(() => "")]);
    const png = "data:image/png;base64," + ndviPng(res.grid).toString("base64");
    delete res.grid; delete res.nograzeLater;
    res.village.region = region || "";
    return { data: res, png };
  };
}

module.exports = { createVillageCache, pipelineBuild, ndviPng, ramp, KZ, TTL };
