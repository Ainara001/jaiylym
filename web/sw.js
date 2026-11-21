/* Jaiylym — офлайн-кэш интерфейса.
 * Кэшируется только оболочка сайта, данные примера (Кеген) и библиотеки.
 * Спутниковые данные, поиск мест, сервер и подложка карты всегда берутся из сети. */
const VERSION = "jaiylym-v2";
const SHELL = [
  "./", "index.html", "css/app.css", "engine.js", "pipeline.js",
  "js/i18n.js", "js/client.js", "js/report.js", "js/app.js",
  "data/plots.js", "data/herds.js", "data/ndvi.png",
];
const CDN = ["https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"];

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
      const r = await fetch(req);
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
