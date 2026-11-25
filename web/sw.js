/* Jaiylym — офлайн-кэш интерфейса.
 * Полностью офлайн: оболочка сайта, готовые примеры (Бесколь и Кеген: данные и картинка NDVI), расчётная модель и движок, сценарии гостя.
 * Из сохранённого кэша браузера (localStorage, не этим файлом): ранее открытые сёла — с датой расчёта, помечены «из кэша».
 * Только с сетью: поиск мест, новые снимки Sentinel-2 и WorldCover, сервер (вход, профиль, бот, ИИ), погода, подложка карты.
 * PDF-библиотека и карта Leaflet — свои копии (vendor/), тоже в кэше.
 * Спутниковые запросы здесь НЕ кэшируются, чтобы старые значения не выдавались за свежие. */
const VERSION = "jaiylym-v41";
const SHELL = [
  "./", "index.html", "css/app.css", "model.js", "engine.js", "nograze.js", "norms.js", "zone.js", "pipeline.js", "trend.js", "kelisim.js",
  "js/i18n.js", "js/client.js", "js/report.js", "js/aitext.js", "js/kelisim-ui.js", "vendor/qrcode-1.4.4/qrcode.js", "js/app.js",
  "data/beskol.js", "data/beskol.png", "data/plots.js", "data/herds.js", "data/ndvi.png", "vendor/html2pdf-0.10.1.bundle.min.js",
  "vendor/leaflet-1.9.4/leaflet.js", "vendor/leaflet-1.9.4/leaflet.css", "vendor/leaflet-1.9.4/images/layers.png", "vendor/leaflet-1.9.4/images/marker-icon.png",
  "fonts/inter-latin-wght-normal.woff2", "fonts/inter-latin-ext-wght-normal.woff2", "fonts/inter-cyrillic-wght-normal.woff2", "fonts/inter-cyrillic-ext-wght-normal.woff2",
];
// карта Leaflet — своя копия (vendor/), без внешнего сервера: не задерживает первую отрисовку и работает офлайн
const CDN = [];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(SHELL);
    await Promise.all(CDN.map(u => c.add(new Request(u, { mode: "cors" })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const cdn = CDN.includes(url.href) || url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!sameOrigin && !cdn) return;                    // спутник, поиск, сервер, тайлы — только сеть
  // сначала сеть (чтобы обновления сайта приходили сразу), без сети — кэш
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    try {
      // свои файлы всегда сверяем с сервером (ETag), чтобы обновления сайта приходили сразу
      const r = await fetch(req, sameOrigin ? { cache: "no-cache" } : undefined);
      if (r && (r.ok || r.type === "opaque")) c.put(req, r.clone());
      return r;
    } catch (_) {
      const hit = await c.match(req, { ignoreSearch: sameOrigin });
      if (hit) return hit;
      if (req.mode === "navigate") return (await c.match("index.html")) || Response.error();
      return Response.error();
    }
  })());
});
