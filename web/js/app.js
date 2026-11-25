/* Jaiylym — интерфейс приложения.
 * Параметры модели — web/model.js, расчёты — web/engine.js, спутник — web/pipeline.js, сервер — js/client.js. */
(function () {
  "use strict";
  const J = window.Jaiylym, M = window.JaiylymModel, PL = window.JaiylymPipeline, C = window.Client, I = window.I18N, t = I.t;
  // готовые примеры (посчитаны заранее, открываются без сети); первый — село, с которого началась проблема проекта
  const EXAMPLES = [{ id: "beskol", data: window.JAIYLYM_BESKOL, png: "data/beskol.png" }, { id: "kegen", data: window.JAIYLYM_DATA, png: "data/ndvi.png" }]
    .filter(e => e.data && e.data.village);
  const DEFAULT = EXAMPLES[0].data, DEMO_HERDS = window.JAIYLYM_HERDS;
  const NM = window.JaiylymNorms;            // предельно допустимая норма нагрузки (приказ МСХ № 3-3/332)
  const NG = window.JaiylymNoGraze;          // где нельзя пасти: жильё, фермы, промзоны (OpenStreetMap)
  const Z = window.JaiylymZone;              // где селу можно пасти: контур, гектары по документам или вся трава вокруг
  const BOT = "JAIYLYM_bot";
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  // числа и даты в казахстанском формате для обоих языков: 1 234,5 и 21.11.2026 14:05
  const fmt = n => Math.round(n).toLocaleString("ru-RU");
  const fmt1 = n => (+n).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  const two = n => String(n).padStart(2, "0");
  const dateStr = (s, time = true) => { const d = new Date(s); if (isNaN(d)) return ""; return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()}` + (time ? ` ${two(d.getHours())}:${two(d.getMinutes())}` : ""); };
  const pct = x => (x == null ? "—" : x > 10 ? "> 1 000 %" : Math.round(x * 100).toLocaleString("ru-RU") + " %");   // больше десяти норм — точное число ничего не говорит
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ic = id => `<svg class="ic"><use href="#i-${id}"/></svg>`;
  const src = k => `<span class="src src-${k}">${t("src." + k)}</span>`;
  const coord = x => (x < 0 ? "m" : "") + Math.round(Math.abs(x) * 1000);
  const exampleAt = (lat, lon) => EXAMPLES.find(e => Math.abs(lat - e.data.village.lat) < 0.01 && Math.abs(lon - e.data.village.lon) < 0.01) || null;
  const exName = e => t(e.id === "kegen" ? "ex.kegen" : "ex.beskol");
  // демо-стада — только когда человек сам открыл пример (кнопкой или ссылкой с demo=1), а не когда нашёл это село поиском
  const villageHash = (v, demo) => `#/map?lat=${v.lat}&lon=${v.lon}&name=${encodeURIComponent(v.name)}${demo ? "&demo=1" : ""}`;

  // ---------- параметры модели: стандартные → калибровка (если есть) → свои (настройки) ----------
  let paramErr = null;
  function resolveParams(user, cal) {
    try { return M.resolve({ user, calibrated: cal }); }
    catch (e) { paramErr = e.message; try { return M.resolve({ calibrated: cal }); } catch (_) { return M.resolve(); } }
  }

  // ---------- состояние ----------
  const S = {
    D: null, plots: [], baseWater: {}, added: new Set(), forbidden: new Set(), waterSet: {}, herds: [],
    userP: C.ls.get("jaiylym:params", null) || {}, calib: C.ls.get("jaiylym:calibration", null), P: null, t0: 0,
    algo: C.ls.get("jaiylym:algo", "optimized") === "greedy" ? "greedy" : "optimized",
    ngBuf: [0, 100, 250, 500].includes(+C.ls.get("jaiylym:ngbuf", 100)) ? +C.ls.get("jaiylym:ngbuf", 100) : 100,
    mode: C.ls.get("jaiylym:mode", "plan"), tab: "brief", cur: null, pl: null, botSubs: {}, picking: false, wx: null, aiBrief: null,
    map: null, layers: {}, group: null, ndviLayer: null, png: null, route: "home", loadingKey: null, histKey: null,
  };
  S.P = resolveParams(S.userP, S.calib);
  if (paramErr) { S.userP = {}; C.ls.del("jaiylym:params"); }

  // ---------- мелкие помощники ----------
  let toastTimer;
  function toast(msg, err) {
    const el = $("#toast"); el.textContent = msg; el.classList.toggle("err", !!err); el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, err ? 6000 : 3500);
  }
  function status(msg, { err = false, busy = false } = {}) {
    const el = $("#status");
    el.hidden = !msg;
    el.classList.toggle("err", err);
    el.innerHTML = msg ? (busy ? '<span class="spin" aria-hidden="true"></span>' : "") + `<span>${esc(msg)}</span>` : "";
  }
  // плашка: белый или тёмный текст — что контрастнее; если ни то, ни другое не даёт 4,5:1 — фон темнее на 15 %
  const lumOf = hex => { const v = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  function pillStyle(bg) {
    const L = lumOf(bg), wh = ratio(L, 1), dk = ratio(L, lumOf("#1b2a21"));
    if (wh >= 4.5) return `background:${bg};color:#fff`;
    if (dk >= 4.5) return `background:${bg};color:#1b2a21`;
    const d = "#" + [1, 3, 5].map(i => Math.round(parseInt(bg.slice(i, i + 2), 16) * 0.85).toString(16).padStart(2, "0")).join("");
    return `background:${d};color:#fff`;
  }
  const loadColor = x => (x == null ? "#d9d2bf" : !x ? "#9aa29a" : x <= 0.7 ? "#3e8e5a" : x <= 1 ? "#c9970f" : "#bf4a2a");
  const ndviColor = v => (v == null ? "#9aa29a" : v < 0.18 ? "#8c510a" : v < 0.25 ? "#d8b56a" : v < 0.32 ? "#9fd068" : "#2f9a4b");
  // Качество спутникового измерения (единое правило web/model.js) — НЕ достоверность числа овец
  const confidence = p => M.satelliteQuality(p);
  const confTag = p => { const c = confidence(p); return `<span class="conf conf-${c}">${t("conf." + c)}</span>`; };
  const fcTag = p => { const f = M.forageConfidence(p, S.P); return `<span class="conf conf-fc-${f}">${t("fc." + f)}</span>`; };
  const capOf = p => J.plotCapacity(p, S.P);
  const sheepCap = c => (c.known ? fmt(c.au_season / S.P.au.sheep) : "—");
  const fmt2 = n => (+n).toLocaleString("ru-RU", { maximumFractionDigits: 2 });
  /** Сравнение оценки по снимку с нормой: over — снимок обещает больше нормы, under — травы меньше, чем допускает норма, match — в пределах 15 %. */
  function normVerdict(c) {
    if (!c.known || !c.norm || !c.norm.au_season) return null;
    const q = c.sat.au_season / c.norm.au_season;
    return q > 1.15 ? { k: "over", x: q } : q < 0.85 ? { k: "under", x: q } : { k: "match", x: q };
  }
  const normVerdictText = v => (v.k === "over" ? t("nm.over", { x: fmt1(v.x) }) : v.k === "under" ? t("nm.under") : t("nm.match"));
  const wsLabel = p => t("ws." + M.waterStatus(p));
  const loadOf = (r, id) => r.load[id];
  // алгоритм плана: «optimized» — справедливое распределение + минимум перегона (по умолчанию), «greedy» — прежний быстрый
  const solve = (plots, herds, P) => J.solve(plots, herds, P || S.P, { algorithm: S.algo });
  const botLink = plotId => `https://t.me/${BOT}?start=` + (S.D ? (plotId
    ? `p_${coord(S.D.village.lat)}_${coord(S.D.village.lon)}_${PL.plotCode(plotId)}`
    : `v_${coord(S.D.village.lat)}_${coord(S.D.village.lon)}`) : "");

  async function askText(title, value, num) {
    return new Promise(resolve => {
      const d = document.createElement("dialog");
      d.className = "modal";
      d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><label class="field"><input name="v" maxlength="80" value="${esc(value)}" ${num ? 'inputmode="numeric"' : ""} required></label>
        <p style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px"><button class="btn btn-ghost" value="cancel" formnovalidate>${t("common.cancel")}</button>
        <button class="btn btn-primary" value="ok">${t("common.save")}</button></p></form>`;
      document.body.appendChild(d);
      d.addEventListener("close", () => { const v = d.returnValue === "ok" ? d.querySelector("input").value.trim() : null; d.remove(); resolve(v || null); });
      d.showModal(); d.querySelector("input").select();
    });
  }

  // ---------- маршрутизация: #/home, #/map?lat=..&lon=..&name=..&plot=.., #/scenarios, #/profile, #/coord, #/data ----------
  function parseHash() {
    const h = location.hash.replace(/^#/, "");
    if (/^lat=/.test(h)) return { route: "map", q: new URLSearchParams(h) };          // старые ссылки из бота
    const m = /^\/?([a-z]*)\??(.*)$/.exec(h) || [];
    const r = m[1] === "data" ? "about" : m[1];      // старая ссылка «О данных» ведёт в «Что это»
    return { route: ["home", "map", "scenarios", "profile", "coord", "about", "ai", "settings", "research", "kelisim"].includes(r) ? r : "home", q: new URLSearchParams(m[2] || "") };
  }
  function go(route, q) { location.hash = "#/" + route + (q ? "?" + q : ""); }
  function onRoute() {
    const { route, q } = parseHash();
    S.route = route;
    $$("[data-view]").forEach(v => { v.hidden = v.dataset.view !== route; });
    $$("[data-route]").forEach(a => { if (a.dataset.route === route) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    if (route === "map") {
      ensureMap();
      const lat = +q.get("lat"), lon = +q.get("lon");
      if (q.get("lat") && q.get("lon") && Number.isFinite(lat) && Number.isFinite(lon)) {
        const same = S.D && Math.abs(S.D.village.lat - lat) < 1e-4 && Math.abs(S.D.village.lon - lon) < 1e-4;
        const pend = S.pending && S.pending.key === cacheKey(lat, lon) ? S.pending.opts : null;
        S.pending = null;
        const extra = { plot: q.get("plot"), pasture: q.get("pasture"), draw: q.get("draw") === "1", demo: q.get("demo") === "1" };
        // это село уже считается (вернулись на карту, сменили язык) — не начинаем заново
        if (S.building === cacheKey(lat, lon)) { if (extra.draw) S.drawNext = true; renderStart(); }
        else if (!same || pend) openVillage(q.get("name") || "Село", lat, lon, Object.assign(extra, pend || {}));
        else {
          if (extra.demo && exampleAt(lat, lon) && !S.herds.some(h => h.demo)) { S.herds = S.herds.concat(demoHerds()); render(); }
          if (extra.plot) focusPlot(extra.plot);
          if (extra.pasture) focusPasture(extra.pasture);
          if (extra.draw) startDraw();
        }
      } else if (!S.D) {
        const last = C.ls.get("jaiylym:last", null), extra = { draw: q.get("draw") === "1" };
        if (S.building) { if (extra.draw) S.drawNext = true; renderStart(); }
        else if (last) openVillage(last.name, last.lat, last.lon, extra);
        else { if (extra.draw) S.drawNext = true; showStart(); }              // село не выбрано — выбор, а не чужой пример
      } else if (q.get("draw") === "1") setTimeout(startDraw, 100);
      // село уже загружено без карты (например, для ИИ-чата) — дорисовать участки
      if (S.D && (S.noLeaflet ? !$("#schemeMap").children.length : S.map && !Object.keys(S.layers).length)) { drawVillage(); render(); }
      setTimeout(() => S.map && S.map.invalidateSize(), 50);
    }
    if (route === "home") renderHome();
    if (route === "scenarios") renderScenarios();
    if (route === "profile") renderProfile();
    if (route === "coord") renderCoord();
    if (route === "about") { renderAbout(); renderDataPage(); }
    if (route === "ai") renderAI();
    if (route === "settings") renderSettings();
    if (route === "research") renderResearch();
    Kel.route(route === "kelisim", q);
    const more = $("#moreDlg"); if (more && more.open) more.close();
    window.scrollTo(0, 0);
  }

  // ---------- карта ----------
  function ensureMap() {
    if (S.map || S.noLeaflet) return;
    if (!window.L) { S.noLeaflet = true; $("#map").hidden = true; $("#schemeMap").hidden = false; return; }
    S.map = L.map("map", { zoomControl: true, attributionControl: true, maxZoom: 19, zoomSnap: 0.25 }).setView(KZ, phone() ? 4 : 5);   // пока село не выбрано — вся страна
    // снимки Esri есть до 17 уровня; дальше карта увеличивает их, чтобы можно было точнее ставить точки
    const tiles = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxNativeZoom: 17, maxZoom: 19, attribution: "Esri World Imagery · Sentinel-2 ESA Copernicus · © OpenStreetMap",
    }).addTo(S.map);
    let tileErrors = 0;
    tiles.on("tileerror", () => { if (++tileErrors === 6 && !navigator.onLine) toast(t("map.fallback"), true); });
    S.group = L.layerGroup().addTo(S.map);
    S.pastGroup = L.layerGroup().addTo(S.map);
    // поворот телефона или заметная смена формы окна: размер пересчитать и, если человек не двигал карту, снова навести на село
    let lastBox = null;
    new ResizeObserver(([e]) => {
      S.map.invalidateSize();
      const { width: w, height: h } = e.contentRect, prev = lastBox;
      lastBox = { w, h };
      if (prev && S.vBounds && !S.mapMoved && w && h && (Math.abs(w / h - prev.w / prev.h) > 0.25 || Math.abs(w - prev.w) > 80))
        { S.fitting = true; S.map.fitBounds(S.vBounds, { padding: [12, 12], animate: false }); S.fitting = false; }
    }).observe($("#map"));
    S.map.on("dragstart zoomstart", e => { if (!S.fitting) S.mapMoved = true; });
    S.map.on("click", e => {
      if (S.draw) { addDrawPoint(e.latlng); return; }
      if (!S.picking) return;
      setPicking(false);
      const lat = +e.latlng.lat.toFixed(5), lon = +e.latlng.lng.toFixed(5);
      openVillage(`${lat.toFixed(3)}, ${lon.toFixed(3)}`, lat, lon);
    });
  }
  function setPicking(on) {
    S.picking = on;
    $("#map").classList.toggle("picking", on);
    status(on ? t("map.picking") : "");
  }

  // ---------- село не выбрано или ещё считается ----------
  const KZ = [48.0, 67.5];
  const viewMap = () => $(".view-map");
  /** Убрать с экрана прежнее село, чтобы пока считается новое, на карте и в панели не было чужих данных. */
  function clearVillage() {
    S.D = null; S.png = null; S.plots = []; S.herds = []; S.layers = {}; S.vBounds = null; S.cur = null; S.pl = null; S.aiBrief = null; S.chatAuto = null;
    if (S.map) {
      endDraw(); S.map.closePopup(); S.group.clearLayers(); S.pastGroup.clearLayers();
      if (S.ngLayer) { S.ngLayer.remove(); S.ngLayer = null; }
      if (S.zoneLayer) { S.zoneLayer.remove(); S.zoneLayer = null; }
      if (S.ndviLayer) { S.ndviLayer.remove(); S.ndviLayer = null; }
    }
    const sch = $("#schemeMap"); if (sch) sch.innerHTML = "";
    $("#vtitle").innerHTML = ""; $("#toResult").hidden = true;
  }
  function placeLabels(on) {
    if (!S.map) return;
    if (on && !S.labels) S.labels = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxNativeZoom: 17, maxZoom: 19, opacity: 0.9 });
    if (on) S.labels.addTo(S.map); else if (S.labels) S.labels.remove();
  }
  /** Карта без села: вся страна, в панели — как выбрать. */
  function showStart(err, retry) {
    clearVillage();
    S.start = { err: err || "", retry: retry || null };
    placeLabels(true);
    if (S.map && !retry) { S.fitting = true; S.map.setView(KZ, phone() ? 4 : 5, { animate: false }); S.fitting = false; }
    renderStart();
  }
  /** Новое село считается: карта сразу едет к нему. */
  function showBuilding(name, lat, lon) {
    clearVillage();
    S.start = { name };
    placeLabels(true);
    $("#vtitle").innerHTML = `<b>${esc(name)}</b>`; $("#mapQ").value = name;
    if (S.map) {
      S.fitting = true; S.map.invalidateSize(); S.map.setView([lat, lon], 12, { animate: false }); S.fitting = false;
      L.circleMarker([lat, lon], { radius: 7, color: "#fff", weight: 2, fillColor: "#1b2a21", fillOpacity: 1 }).bindTooltip(esc(name), { permanent: true, direction: "top" }).addTo(S.group);
    }
    renderStart();
  }
  function renderStart() {
    const st = S.start || {}, el = $('.pane[data-pane="brief"]');
    viewMap().classList.add("no-village");
    $$(".pane").forEach(p => { p.hidden = p !== el; });
    if (S.building) {
      el.innerHTML = `<div class="start"><h2>${t("start.building", { v: esc(st.name || "") })}</h2><p>${t("start.buildingD")}</p>
        <p class="startload"><span class="spin" aria-hidden="true"></span><span>${t("start.wait")}</span></p></div>`;
      return;
    }
    el.innerHTML = `<div class="start"><h2>${t(st.err ? "start.errT" : "start.title")}</h2>
      ${st.err ? `<p class="note warn">${esc(st.err)}</p>` : `<p>${t("start.lead")}</p>`}
      <div class="startbtns">
        ${st.retry ? `<button type="button" class="btn btn-primary" id="stRetry">${t("start.retry", { v: esc(st.retry.name) })}</button>` : ""}
        <button type="button" class="btn ${st.retry ? "btn-soft" : "btn-primary"}" id="stHere">${ic("pin")} ${t("start.here")}</button>
        ${S.noLeaflet ? "" : `<button type="button" class="btn btn-soft" id="stPick">${ic("map")} ${t("start.pick")}</button>`}</div>
      <h3>${t("start.examples")}</h3><p class="fine">${t("start.examplesD")}</p>
      <div class="startbtns">${EXAMPLES.map(e => `<a class="btn btn-ghost" href="${villageHash(e.data.village, true)}">${esc(exName(e))}</a>`).join("")}</div></div>`;
    const here = $("#stHere", el), pick = $("#stPick", el), re = $("#stRetry", el);
    if (re) re.onclick = () => openVillage(st.retry.name, st.retry.lat, st.retry.lon, st.retry.opts);
    if (pick) pick.onclick = () => { setPicking(true); toast(t("map.picking")); if (phone()) $("#map").scrollIntoView({ block: "center" }); };
    here.onclick = () => {
      if (!navigator.geolocation) { toast(t("pick.geoFail"), true); return; }
      here.disabled = true;
      navigator.geolocation.getCurrentPosition(async p => {
        const lat = +p.coords.latitude.toFixed(5), lon = +p.coords.longitude.toFixed(5);
        let name = ""; try { name = (await PL.reverseGeocode(lat, lon, I.lang === "kk" ? "kk" : "ru")).name; } catch (_) {}
        openVillage(name || `${lat.toFixed(3)}, ${lon.toFixed(3)}`, lat, lon);
      }, () => { here.disabled = false; toast(t("pick.geoFail"), true); }, { enableHighAccuracy: true, timeout: 15000 });
    };
  }

  function drawVillage() {
    { const tr = $("#toResult"); if (tr) tr.hidden = !S.D; }
    placeLabels(false);
    S.layers = {};
    if (S.noLeaflet || !S.map) return;   // нет карты: запасная схема рисуется в paintMap(); село для ИИ-чата — дорисуем при переходе
    S.group.clearLayers();
    const [w, s, e, n] = S.D.bbox;
    S.ndviLayer = L.imageOverlay(S.png, [[s, w], [n, e]], { opacity: 0.85 });
    L.circleMarker([S.D.village.lat, S.D.village.lon], { radius: 6, color: "#fff", weight: 2, fillColor: "#1b2a21", fillOpacity: 1 })
      .bindTooltip(esc(S.D.village.name)).addTo(S.group);
    // для отображения — плавные дуги (48 точек); расчёт по-прежнему идёт по пикселям, а не по контуру
    const smooth = Object.fromEntries(PL.makePlots(S.D.village.lat, S.D.village.lon, 48).map(q => [q.id, q.geometry]));
    for (const p of S.plots) {
      const geom = smooth[p.id] || p.geometry;
      const poly = L.polygon(geom.coordinates[0].map(([x, y]) => [y, x]), { weight: 1.5, color: "#fff", fillOpacity: 0.45, smoothFactor: 0.5 }).addTo(S.group);
      poly.bindTooltip("", { permanent: true, direction: "center", className: p.ring === "near" ? "plabel plabel-near" : "plabel" });
      poly.on("click", () => { if (!S.picking && !S.draw) openPlot(p.id); });
      S.layers[p.id] = poly;
    }
    const b = L.latLngBounds(S.plots.flatMap(p => p.geometry.coordinates[0].map(([x, y]) => [y, x])));
    S.vBounds = b; S.mapMoved = false;
    S.fitting = true; S.map.invalidateSize(); S.map.fitBounds(b, { padding: [12, 12], animate: false }); S.fitting = false;
    drawPastures();
    drawNoGraze();
    drawZone();
  }
  /** Зоны «нельзя пасти» на карте: контуры жилья, ферм и промзон из OSM (не перехватывают нажатия на участки). */
  function drawNoGraze() {
    if (!S.map || !S.D) return;
    if (S.ngLayer) S.ngLayer.remove();
    const ng = S.D.nograze;
    if (!ng || ng.status !== "ok" || !(ng.zones || []).length) return;
    S.ngLayer = L.layerGroup().addTo(S.map);
    for (const z of ng.zones)
      L.polygon(z.ring.map(([x, y]) => [y, x]), { color: "#7a1f0f", weight: 1, fillColor: "#bf4a2a", fillOpacity: 0.35, interactive: false, dashArray: z.point ? "3 3" : null })
        .addTo(S.ngLayer);
  }
  /** Ранее открытые сёла без расчёта зон — досчитать (WorldCover + OSM), результат в кэш браузера. */
  function loadNoGraze(key, data, force) {
    if (!NG || typeof PL.buildNoGraze !== "function") return;
    if (!force && data.nograze && data.nograze.status === "ok") return;
    const hit = !force && C.ls.get(key + ":ng", null);
    if (hit && hit.status === "ok") { data.nograze = hit; return; }
    if (!navigator.onLine) { S.ngState = "offline"; return; }
    S.ngState = "loading";
    const later = !force && S.ngLater; S.ngLater = null;
    (later || PL.buildNoGraze({ lat: data.village.lat, lon: data.village.lon })).then(ng => {
      data.nograze = ng;
      if (ng.status === "ok") C.ls.set(key + ":ng", ng);
      if (S.D !== data) return;                             // пока грузилось, открыли другое село
      S.ngState = ng.status;
      rebuildPlots(); render(); drawNoGraze();
      // серверы OSM часто перегружены ненадолго — один тихий повтор, пока открыто это же село
      if (ng.status === "error" && !S.ngRetried) { S.ngRetried = true; setTimeout(() => { if (S.D === data && S.ngState === "error") { loadNoGraze(key, data, true); renderPane(S.tab); } }, 45000); }
    }).catch(e => { data.nograze = { status: "error", error: String(e.message || e) }; if (S.D !== data) return; S.ngState = "error"; renderPane(S.tab); });
  }

  // ---------- свои пастбища: фермер рисует контур, NDVI считается по снимкам внутри него ----------
  const farmAU = () => (C.user && C.user.farm ? J.herdAU(C.user.farm, S.P) : 0);
  // единое правило качества для своего пастбища и участков села (web/model.js)
  const pastPlot = st => ({ ndvi: st.ndvi, pasture_ha: st.pasture_ha || 0, series: st.series, samples: st.samples, valid_fraction: st.valid_fraction, obs_count: st.obs_count });
  const pastConf = st => M.satelliteQuality(pastPlot(st));
  function pastureRows(st, area, water) {
    const cap = J.plotCapacity(NM ? NM.attach([pastPlot(st)], S.normSel)[0] : pastPlot(st), S.P);
    const toNorm = farmAU() && cap.norm && cap.norm.au_season > 0 ? farmAU() / cap.norm.au_season : null;
    const au = farmAU(), load = au && cap.known && cap.au_days > 0 ? au * S.P.season_days / cap.au_days : null;
    const c = pastConf(st);
    const comp = st.excluded_ha != null ? `<tr><td>${t("past.comp")}</td><td style="white-space:normal">${fmt1(st.pasture_ha)} / ${fmt1(st.excluded_ha)} / ${fmt1(st.uncertain_ha || 0)} ${t("common.ha")} ${src("sat")}</td></tr>` : "";
    const prov = st.provenance === "client_reported" ? `<p class="fine" style="margin:6px 0 0">${t("past.unverified")}</p>` : "";
    return `<table><tbody>
      <tr><td>${t("past.area")}</td><td>${fmt1(area)} ${t("common.ha")} ${src("input")}</td></tr>
      <tr><td>${t("past.usable")}</td><td>${fmt1(st.pasture_ha)} ${t("common.ha")} ${src("sat")}</td></tr>${comp}
      <tr><td>NDVI ${st.year || ""}</td><td>${st.ndvi ?? t("st.no_data")} ${src("sat")} <span class="conf conf-${c}">${t("conf." + c)}</span></td></tr>
      <tr><td>${t("past.cap")}</td><td>${cap.known ? "≈ " + sheepCap(cap) + " " + t("pop.sheep") : t("st.no_data")} ${src("model")} ${fcTag(pastPlot(st))}</td></tr>
      <tr><td>${t("past.myLoad")}</td><td>${load == null ? `<small>${cap.known ? t("past.noFarm") : t("st.no_data")}</small>` : `<b style="color:${loadColor(load)}">${pct(load)}</b> ${src("model")}`}</td></tr>
      ${cap.norm ? `<tr><td>${t("nm.past")}</td><td style="white-space:normal">≈ ${fmt(cap.norm.au_season / S.P.au.sheep)} ${t("pop.sheep")} ${src("norm")}${toNorm == null ? "" : `<br><b>${t("nm.pastLoad", { p: pct(toNorm) })}</b>`}</td></tr>` : ""}
      <tr><td>${t("pop.water")}</td><td>${water ? t("ws.confirmed") : "—"}${st.water_on_map ? ` (${t("past.waterMap")})` : ""}</td></tr>
      </tbody></table>${toNorm != null && toNorm > 1 ? `<p class="note warn">${t("nm.pastOver")}</p>` : toNorm != null && toNorm < NM.LAW.underuse ? `<p class="note warn">${t("nm.pastUnder", { p: pct(toNorm) })}</p>` : ""}${spark(st.series)}${prov}
      ${st.wc_pasture_share != null ? `<p class="fine" style="margin:6px 0 0">${t("past.wc", { p: Math.round(st.wc_pasture_share * 100) })}</p>` : ""}`;
  }
  const pastLink = id => `https://t.me/${BOT}?start=m_${id}`;
  function pastureHtml(q) {
    return `<div class="pop"><h3 style="margin:0 0 6px">${esc(q.name)} <small style="font-weight:500;color:#627064">${t("past.mine")}</small></h3>
      ${pastureRows(q.stats || {}, q.area_ha, q.water)}
      <a class="btn btn-tg btn-sm" style="width:100%;margin-top:10px;color:#fff" href="${pastLink(q.id)}" target="_blank" rel="noopener">${ic("send")} ${t("past.notify")}</a>
      <p class="fine" style="margin:6px 0 0">${t("past.boundaryNote")}</p></div>`;
  }
  function drawPastures() {
    if (!S.pastGroup) return;
    S.pastGroup.clearLayers();
    S.pastLayers = {};
    for (const q of (C.user && C.user.pastures) || []) {
      const ll = q.geometry.coordinates[0].map(([x, y]) => [y, x]);
      const poly = L.polygon(ll, { color: "#e3b25c", weight: 3, fillColor: "#e3b25c", fillOpacity: 0.18 }).addTo(S.pastGroup);
      poly.bindTooltip(esc(q.name), { permanent: true, direction: "center", className: "plabel past" });
      poly.on("click", () => { if (!S.draw && !S.picking) openPasture(q.id); });
      S.pastLayers[q.id] = poly;
    }
  }
  function openPasture(id) {
    const q = ((C.user && C.user.pastures) || []).find(x => x.id === id), lay = S.pastLayers && S.pastLayers[id];
    if (!q || !lay) return;
    if (phone()) { cardDialog(pastureHtml(q)); return; }
    L.popup({ maxWidth: 300, maxHeight: Math.max(220, $("#map").clientHeight - 120), autoPanPaddingTopLeft: [16, 70] })
      .setLatLng(lay.getBounds().getCenter()).setContent(pastureHtml(q)).openOn(S.map);
  }
  function focusPasture(id) {
    const lay = S.pastLayers && S.pastLayers[id];
    if (!lay) return;
    S.map.fitBounds(lay.getBounds(), { padding: [50, 50], maxZoom: 15, animate: false });
    openPasture(id);
  }

  function startDraw(what) {
    if (S.noLeaflet || !S.map) { toast(t("past.noMap"), true); return; }
    if (S.draw) return;
    if (!S.D) { S.drawNext = true; toast(t("start.drawFirst"), true); return; }    // контур считается в привязке к селу
    setPicking(false);
    S.map.closePopup();
    S.draw = { zone: what === "zone", pts: [], line: L.polyline([], { color: "#e3b25c", weight: 3, dashArray: "6 5" }).addTo(S.map), marks: L.layerGroup().addTo(S.map) };
    $("#map").classList.add("drawing");
    $("#drawbar").hidden = false;
    updateDrawHint();
  }
  function updateDrawHint() {
    $("#drawHint").textContent = t(S.draw && S.draw.zone ? "zn.drawHint" : "past.drawHint", { n: S.draw ? S.draw.pts.length : 0 });
    $("#drawDone").disabled = !S.draw || S.draw.pts.length < 3;
    $("#drawUndo").disabled = !S.draw || !S.draw.pts.length;
  }
  function redrawLine() {
    const pts = S.draw.pts;
    S.draw.line.setLatLngs(pts.length >= 3 ? pts.concat([pts[0]]) : pts);
    S.draw.marks.clearLayers();
    pts.forEach((p, i) => L.circleMarker(p, { radius: i ? 5 : 7, color: "#fff", weight: 2, fillColor: "#e3b25c", fillOpacity: 1 }).addTo(S.draw.marks));
    updateDrawHint();
  }
  function addDrawPoint(ll) { if (S.draw.pts.length >= 200) return; S.draw.pts.push(ll); redrawLine(); }
  function undoDraw() { if (S.draw && S.draw.pts.length) { S.draw.pts.pop(); redrawLine(); } }
  function endDraw() {
    if (!S.draw) return;
    S.draw.line.remove(); S.draw.marks.remove();
    S.draw = null;
    $("#map").classList.remove("drawing");
    $("#drawbar").hidden = true;
  }
  async function finishDraw() {
    if (!S.draw || S.draw.pts.length < 3) { toast(t("past.need3"), true); return; }
    const ring = S.draw.pts.map(p => [+p.lng.toFixed(6), +p.lat.toFixed(6)]);
    if (S.draw.zone) {                         // граница пастбища села: снимки заново не нужны, доли считаются по карте травы
      endDraw();
      const old = S.zone && S.zone.mode === "contour" ? S.zone.rings : [];
      if (old.length >= Z.MAX_RINGS) { toast(t("zn.many"), true); return; }
      await setZone(Z.clean({ mode: "contour", rings: old.concat([ring]) }));
      toast(zoneText());
      const zc = $("#zoneCard"); if (zc && phone()) zc.scrollIntoView({ block: "center" });
      return;
    }
    const preview = L.polygon(S.draw.pts, { color: "#e3b25c", weight: 3, fillOpacity: 0.12 }).addTo(S.map);
    endDraw();
    if (!navigator.onLine) { preview.remove(); toast(t("err.offline"), true); return; }
    status(t("past.computing"), { busy: true });
    let st;
    try { st = await PL.polygonStats({ ring, onProgress: () => status(t("past.computing"), { busy: true }) }); }
    catch (e) { preview.remove(); status(t("err.build") + ": " + e.message, { err: true }); return; }
    status("");
    showPastureResult(ring, st, preview);
  }
  function showPastureResult(ring, st, preview) {
    const d = document.createElement("dialog");
    d.className = "modal";
    const n = ((C.user && C.user.pastures) || []).length + 1;
    d.innerHTML = `<form method="dialog" class="modal-x"><button aria-label="${t("common.close")}">${ic("x")}</button></form>
      <h2>${t("past.result")}</h2>
      <label class="field">${t("past.name")}<input id="pName" maxlength="60" value="${esc(t("past.mine") + " " + n)}"></label>
      <div id="pRows" style="margin-top:10px">${pastureRows(st, st.area_ha, st.water_on_map)}</div>
      <label class="check" style="margin-top:10px"><input type="checkbox" id="pWater" ${st.water_on_map ? "checked" : ""}> ${t("past.water")} ${src("input")}</label>
      <p class="fine" style="margin-top:8px">${t("past.boundaryNote")}</p>
      ${C.loggedIn ? "" : `<p class="note warn">${t("past.guestNote")}</p>`}
      <p style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:14px">
        <button class="btn btn-ghost" id="pCancel">${t("common.cancel")}</button>
        ${C.loggedIn ? `<button class="btn btn-primary" id="pSave">${ic("save")} ${t("past.save")}</button>`
          : `<button class="btn btn-primary" id="pSave">${ic("user")} ${t("past.loginSave")}</button>`}</p>`;
    document.body.appendChild(d);
    const close = () => { d.close(); };
    d.addEventListener("close", () => { preview.remove(); d.remove(); });
    $("#pWater", d).onchange = e => { $("#pRows", d).innerHTML = pastureRows(st, st.area_ha, e.target.checked); };
    $("#pCancel", d).onclick = close;
    $("#pSave", d).onclick = async () => {
      if (!C.loggedIn) {         // гость: одна кнопка — вход через Telegram, после входа пастбище сохранится само
        S.pendingPasture = { ring, st, name: $("#pName", d).value, water: $("#pWater", d).checked };
        close(); openLogin();
        return;
      }
      await savePasture({ ring, st, name: $("#pName", d).value, water: $("#pWater", d).checked });
      close();
    };
    d.showModal();
  }
  async function savePasture({ ring, st, name, water }) {
    try {
      await C.addPasture({ name, water, geometry: { type: "Polygon", coordinates: [ring.concat([ring[0]])] },
        stats: { ndvi: st.ndvi, series: st.series, pasture_ha: st.pasture_ha, excluded_ha: st.excluded_ha, uncertain_ha: st.uncertain_ha,
          wc_pasture_share: st.wc_pasture_share, valid_fraction: st.valid_fraction, water_on_map: st.water_on_map, year: st.year } });
      toast(t("past.saved"));
      drawPastures();
    } catch (e) { toast(errText(e), true); }
  }

  // ---------- выбор села ----------
  const cacheKey = (lat, lon) => `jaiylym:v3:${(+lat).toFixed(3)},${(+lon).toFixed(3)}`;
  function ndviPng(grid) {
    const n = grid.size, c = document.createElement("canvas");
    c.width = c.height = n;
    const ctx = c.getContext("2d"), img = ctx.createImageData(n, n);
    const stops = [[0.05, [140, 81, 10]], [0.2, [216, 181, 106]], [0.35, [159, 208, 104]], [0.55, [47, 154, 75]]];
    const ramp = v => {
      if (v <= stops[0][0]) return stops[0][1];
      for (let k = 1; k < stops.length; k++) if (v <= stops[k][0]) {
        const [a, ca] = stops[k - 1], [b, cb] = stops[k], q = (v - a) / (b - a);
        return ca.map((x, j) => x + (cb[j] - x) * q);
      }
      return stops[stops.length - 1][1];
    };
    for (let i = 0; i < n * n; i++) {
      const v = grid.ndvi[i];
      if (!grid.pasture[i] || Number.isNaN(v)) continue;
      const [r, g, b] = ramp(v);
      img.data.set([r, g, b, 190], i * 4);
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL("image/png");
  }

  async function openVillage(name, lat, lon, opts = {}) {
    const key = cacheKey(lat, lon);
    S.loadingKey = key;
    $$(".results").forEach(u => { u.hidden = true; });
    let data = null, png = null;
    const ex = exampleAt(lat, lon);
    S.building = null;
    if (ex) { data = JSON.parse(JSON.stringify(ex.data)); png = ex.png; }
    else {
      const hit = C.ls.get(key, null);
      if (hit && hit.plots) { data = hit; png = hit.png; delete data.png; data.village.name = name || data.village.name; }
    }
    if (!data) {
      if (!navigator.onLine) { status(t("err.offline"), { err: true }); if (!S.D) showStart(t("err.offline")); return; }
      try {
        S.building = key;
        showBuilding(name, lat, lon);
        if (!opts.keepRoute) history.replaceState(null, "", villageHash({ name, lat, lon }));
        const [res, region] = await Promise.all([PL.buildVillage({ name, lat, lon, ngWaitMs: 4000, onProgress: m => {
          const k = /снимк.*Sentinel/.test(m) ? "st.scenes" : /Загружаю/.test(m) ? "st.loading" : "st.computing";
          status(t(k), { busy: true });
        } }), PL.regionAt ? PL.regionAt(lat, lon).catch(() => "") : ""]);
        res.village.region = region;                           // область — для нормы нагрузки
        if (S.loadingKey !== key) return;                      // пока считали, выбрали другое место
        png = ndviPng(res.grid); delete res.grid;
        S.ngLater = res.nograzeLater; delete res.nograzeLater;   // зоны OSM ещё идут — вычтем, когда придут
        data = res; S.justBuilt = true;
        C.ls.set(key, Object.assign({}, res, { png }));
      } catch (e) {
        if (S.loadingKey === key) {
          S.building = null;
          const msg = t("err.build") + ": " + (/fetch|network|load failed|timeout|timed out/i.test(e.message) ? t("err.imagery") : e.message);
          status("");
          showStart(msg, { name, lat, lon, opts });
        }
        return;
      }
    }
    // граница пастбища — до показа села: иначе на миг показали бы чужую землю
    const zs = C.ls.get(key + ":zone", null), zone = Z ? Z.clean(opts.zone) || Z.clean(zs && zs.zone) || Z.defaultFor(data.village) : null;
    const zshare = zone && zone.mode === "contour" ? await zoneShares(data, png, zone.rings) : null;
    if (S.loadingKey !== key) return;
    status("");
    S.building = null; S.start = null;
    viewMap().classList.remove("no-village");
    S.D = data; S.png = png; S.fromCache = !ex && !!C.ls.get(key, null) && !S.justBuilt; S.justBuilt = false;
    S.t0 = Date.now();
    S.baseWater = Object.fromEntries(data.plots.map(p => [p.id, M.waterUsable(p)]));
    S.added = new Set((opts.water || []).filter(id => S.baseWater[id] === false));
    S.forbidden = new Set(opts.forbidden || (zs && zs.closed) || []);
    S.zone = zone; S.zoneShare = zshare;
    S.rest = Object.assign({}, opts.rest || {});
    S.waterSet = Object.assign({}, opts.water_status || {});
    if (opts.params) { S.userP = Object.assign({}, S.userP, opts.params); paramErr = null; S.P = resolveParams(S.userP, S.calib); if (paramErr) toast(paramErr, true); }
    S.normSel = NM ? NM.clean(opts.norm) || NM.clean(C.ls.get(normKey(key), null)) || NM.clean({ region: NM.regionOf(data.village.region) }) : null;
    S.normState = S.normSel ? "ok" : "none";
    S.ngState = data.nograze ? data.nograze.status : null; S.ngRetried = false;
    loadNoGraze(key, data);                                   // из кэша — сразу; из OSM — в фоне, до прихода числа без вычета и с пометкой
    rebuildPlots();
    S.herds = opts.herds ? opts.herds.map(h => Object.assign({}, h)) : (ex && opts.demo ? demoHerds() : []);
    addOwnFarm();
    S.botSubs = {};
    C.ls.set("jaiylym:last", { name: data.village.name, lat: data.village.lat, lon: data.village.lon });
    if (!opts.keepRoute) syncHash();
    $("#mapQ").value = data.village.name;
    $("#tgVillage").href = botLink();
    drawVillage();
    render();
    if (!opts.herds) loadBotData();
    loadRegion(key, data);
    loadPrev(key, data);
    loadMulti(key, data);
    if (S.histKey !== key) { S.histKey = key; C.addHistory({ kind: "open", village: data.village, summary: summary() }); }
    const want = opts.plot;
    if (want) setTimeout(() => focusPlot(want), 350);
    if (opts.pasture) setTimeout(() => focusPasture(opts.pasture), 400);
    if (opts.draw || S.drawNext) { S.drawNext = false; setTimeout(startDraw, 450); }
  }

  // ---------- где селу можно пасти ----------
  const zoneKey = () => cacheKey(S.D.village.lat, S.D.village.lon) + ":zone";
  const saveZone = () => C.ls.set(zoneKey(), { zone: S.zone && !S.zone.official ? S.zone : null, closed: [...S.forbidden] });
  /** Доли участков внутри контура — по пикселям пастбища с карты травы (S.png); картинка не читается — по площади участка. */
  async function zoneShares(D, png, rings) {
    let mask = { size: 256, bbox: D.bbox };
    try {
      const im = new Image(); im.src = png; await im.decode();
      const c = document.createElement("canvas"), n = im.naturalWidth; c.width = c.height = n;
      const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(im, 0, 0);
      const a = x.getImageData(0, 0, n, n).data;
      mask = { size: n, bbox: D.bbox, has: i => a[i * 4 + 3] > 0 };
    } catch (_) {}
    return Z.shares(D.village, rings, mask);
  }
  async function setZone(z) {
    const key = S.loadingKey, sh = z.mode === "contour" ? await zoneShares(S.D, S.png, z.rings) : null;
    if (S.loadingKey !== key) return;
    S.zone = z; S.zoneShare = sh;
    saveZone(); rebuildPlots(); drawZone(); render();
  }
  function drawZone() {
    if (!S.map || !S.group) return;
    if (S.zoneLayer) { S.zoneLayer.remove(); S.zoneLayer = null; }
    if (!S.D || !S.zone || S.zone.mode !== "contour") return;
    S.zoneLayer = L.layerGroup().addTo(S.map);
    for (const r of S.zone.rings) L.polygon(r.map(([x, y]) => [y, x]), { color: "#ffffff", weight: 4, fill: false, interactive: false }).addTo(S.zoneLayer), L.polygon(r.map(([x, y]) => [y, x]), { color: "#1e4634", weight: 2.5, fill: false, interactive: false }).addTo(S.zoneLayer);
  }
  const zoneHa = () => S.plots.filter(p => !p.forbidden).reduce((s, p) => s + p.pasture_ha, 0);
  /** Какую землю учитывает расчёт — одной фразой. */
  function zoneText() {
    const ha = fmt(zoneHa()), n = S.forbidden.size ? " " + t("zn.closed", { n: S.forbidden.size }) : "";
    if (!S.zone || S.zone.mode === "all") return t("zn.all", { ha }) + n;
    if (S.zone.mode === "contour") return t("zn.contour", { ha }) + n;
    return t(S.zone.official ? "zn.official" : "zn.ha", { ha: fmt(S.zone.ha) }) + n;
  }
  function zoneCard() {
    if (!Z || !S.D) return "";
    const m = S.zone ? S.zone.mode : "all", of = S.D.village.official;
    return `<section class="zone zone-${m}" id="zoneCard"><h3>${ic("pin")} ${t("zn.title")}</h3><p>${zoneText()} ${src(m === "all" ? "sat" : "input")}</p>
      ${S.zone && S.zone.official && of ? `<p class="fine">${t("zn.src")}: <a href="${esc(of.url)}" target="_blank" rel="noopener">${esc(of.title)}</a>. ${t("zn.noBorders")}</p>` : m === "ha" ? `<p class="fine">${t("zn.noBorders")}</p>` : m === "all" ? `<p class="fine">${t("zn.allD")}</p>` : ""}
      <div class="zbtns"><button type="button" class="btn btn-sm ${m === "all" ? "btn-primary" : "btn-soft"}" data-zn="draw">${ic("pen")} ${t(m === "contour" ? "zn.more" : "zn.draw")}</button>
      <button type="button" class="btn btn-sm btn-soft" data-zn="closed">${ic("x")} ${t("zn.mark")}</button>
      <button type="button" class="btn btn-sm btn-ghost" data-zn="ha">${t("zn.setHa")}</button>
      ${m !== "all" ? `<button type="button" class="btn btn-sm btn-ghost" data-zn="all">${t("zn.reset")}</button>` : ""}</div></section>`;
  }
  function bindZone(el) {
    $$("[data-zn]", el).forEach(b => b.onclick = () => ({ draw: startZone, closed: closedDlg, ha: haDlg, all: () => { S.forbidden = new Set(); setZone({ mode: "all" }); } })[b.dataset.zn]());
  }
  function startZone() {
    if (S.route !== "map") { go("map", villageHash(S.D.village, S.herds.some(h => h.demo)).split("?")[1]); setTimeout(startZone, 400); return; }
    startDraw("zone");
    if (S.draw && phone()) $("#map").scrollIntoView({ block: "center" });
  }
  async function haDlg() {
    const v = await askText(t("zn.haQ"), S.zone && S.zone.mode === "ha" ? String(S.zone.ha) : "", true);
    if (v == null) return;
    const z = Z.clean({ mode: "ha", ha: +String(v).replace(/[^0-9.]/g, "") });
    if (z) setZone(z); else toast(t("zn.haBad"), true);
  }
  /** Отметить участки, где селу пасти нельзя: нажать на схему или на код. */
  function closedDlg() {
    const d = document.createElement("dialog");
    d.className = "modal plot-sheet"; d.setAttribute("aria-label", t("zn.mark"));
    const draw = () => {
      d.innerHTML = `<form method="dialog" class="modal-x"><button aria-label="${t("common.close")}">${ic("x")}</button></form><h2>${t("zn.mark")}</h2><p>${t("zn.markD")}</p>
        <div class="kmap">${scheme(S.plots, p => (S.forbidden.has(p.id) ? "#7a6a60" : "#4f8a6b"), p => (S.forbidden.has(p.id) ? "×" : ""), { size: 320, interactive: true })}</div>
        <p class="fine">${S.forbidden.size ? t("zn.closed", { n: S.forbidden.size }) : t("zn.closed0")}</p><form method="dialog"><button class="btn btn-primary" style="width:100%;min-height:48px">${t("past.done")}</button></form>`;
      d.querySelectorAll("[data-plot]").forEach(g => { const f = () => { const id = g.dataset.plot; S.forbidden.has(id) ? S.forbidden.delete(id) : S.forbidden.add(id); draw(); const n = d.querySelector(`[data-plot="${id}"]`); if (n) n.focus(); };
        g.setAttribute("aria-pressed", S.forbidden.has(g.dataset.plot)); g.onclick = f; g.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); f(); } }; });
    };
    document.body.appendChild(d);
    d.addEventListener("close", () => { d.remove(); saveZone(); rebuildPlots(); render(); if (S.route === "kelisim") Kel.refresh(); });
    draw(); d.showModal();
  }

  // ---------- норма нагрузки: область села → самая мягкая норма, пока человек не выбрал тип пастбища ----------
  const normKey = key => key + ":norm";
  function loadRegion(key, data) {
    if (!NM || S.normSel || !navigator.onLine || typeof PL.regionAt !== "function") return;
    S.normState = "loading";
    PL.regionAt(data.village.lat, data.village.lon).then(txt => {
      if (S.loadingKey !== key || S.normSel) return;
      const sel = NM.clean({ region: NM.regionOf(txt) });
      S.normState = sel ? "ok" : "none";
      if (sel) {
        data.village.region = txt; S.normSel = sel;
        const hit = C.ls.get(key, null); if (hit && hit.village) { hit.village.region = txt; C.ls.set(key, hit); }
        rebuildPlots();
      }
      render();
    }).catch(() => { if (S.loadingKey === key) { S.normState = "error"; if (S.tab === "data") renderPane("data"); } });
  }
  function setNorm(sel) {
    S.normSel = NM.clean(sel); S.normState = S.normSel ? "ok" : "none";
    if (S.normSel) C.ls.set(normKey(S.loadingKey), S.normSel); else C.ls.del(normKey(S.loadingKey));
    rebuildPlots(); render();
  }
  const regName = id => { const r = NM && NM.region(id); return r ? (I.lang === "kk" ? r.kk : r.ru) : "—"; };
  /** Итог по нормам для участков: сколько ограничено нормой, сколько вышло бы по снимкам и сколько можно. */
  function normTotals(plots) {
    const o = { n: 0, limited: 0, sat: 0, norm: 0, cap: 0 };
    for (const p of plots) {
      const c = capOf(p); if (!c.known || !c.norm) continue;
      o.n++; if (c.limited_by === "norm") o.limited++;
      o.sat += c.sat.au_season / S.P.au.sheep; o.norm += c.norm.full_au_season / S.P.au.sheep; o.cap += c.au_season / S.P.au.sheep;
    }
    return o;
  }
  const syncHash = () => { if (S.D) history.replaceState(null, "", villageHash(S.D.village, S.herds.some(h => h.demo) && !!exampleAt(S.D.village.lat, S.D.village.lon))); };
  // ввод пользователя поверх спутниковых данных: смоделированный водопой, подтверждение/отсутствие воды, закрытый участок
  function rebuildPlots() {
    // кормовая площадь без жилья, ферм и промзон (OSM) с выбранным буфером; исходная — в pasture_ha_gross
    const base = NG && S.D.nograze && S.D.nograze.status === "ok" ? NG.apply(S.D.plots, S.D.nograze, S.ngBuf) : S.D.plots;
    const zoned = Z ? Z.apply(base, S.zone, S.zoneShare, [...S.forbidden]) : base;
    S.plots = (NM ? NM.attach(zoned, S.normSel) : zoned).map(p => {
      const o = Object.assign({}, p);
      if (S.added.has(p.id)) { o.water_status = "modeled"; o.water = true; o.water_source = t("ws.modeled"); }
      else if (S.waterSet[p.id]) { o.water_status = S.waterSet[p.id]; o.water = M.waterUsable(o); }
      else { o.water_status = M.waterStatus(p); o.water = M.waterUsable(o); }
      o.forbidden = S.forbidden.has(p.id);
      // отдых участка: не пасти первые/последние дни сезона — окно выпаса, которое учитывают план и календарь
      const r = (S.rest || {})[p.id];
      if (r && (r.spring > 0 || r.autumn > 0)) o.window = { from: (r.spring || 0) + 1, to: S.P.season_days - (r.autumn || 0) };
      else delete o.window;
      return o;
    });
  }
  // имена демо-стад на языке интерфейса (данные примера по-русски); имя, изменённое пользователем, не трогаем
  const DEMO_KK = { gulnar: "Гүлнар (сауын)", village: "Ауылдың сиыр табыны", baur: "Бауыржан", asan: "Асан", erlan: "Ерлан", common: "Ортақ сиыр табыны", milk: "Сүт шаруашылығы", horses: "Жылқы үйірі", flock: "Ортақ отар", farm: "Шаруа қожалығы" };
  const demoName = h => (I.lang === "kk" && DEMO_KK[h.id]) || h.name;
  const exHerds = () => { const e = S.D && exampleAt(S.D.village.lat, S.D.village.lon); return (e && e.data.herds) || DEMO_HERDS; };
  const demoHerds = () => exHerds().map(h => Object.assign({}, h, { demo: true, name: demoName(h) }));
  function renameDemo() {
    for (const h of S.herds || []) {
      const base = h.demo && exHerds().find(d => d.id === h.id);
      if (base && (h.name === base.name || h.name === DEMO_KK[h.id])) h.name = demoName(base);
    }
  }
  function addOwnFarm() {
    const u = C.user;
    S.herds = S.herds.filter(h => !h.mine);
    if (!u || !u.farm || !S.D) return;
    const f = u.farm;
    if (Math.abs(f.village.lat - S.D.village.lat) > 0.0015 || Math.abs(f.village.lon - S.D.village.lon) > 0.0015) return;
    S.herds.unshift({ id: "mine", mine: true, name: f.name, sheep: f.sheep, goats: f.goats, cattle: f.cattle, horses: f.horses, home: f.home, daily_return: f.daily_return,
      allowed_plots: (f.plots || []).length ? f.plots.slice() : undefined });
  }

  async function loadBotData() {
    const key = cacheKey(S.D.village.lat, S.D.village.lon);
    try {
      const d = await C.villageData(S.D.village.lat, S.D.village.lon);
      if (cacheKey(S.D.village.lat, S.D.village.lon) !== key) return;
      S.botSubs = d.subs || {};
      const near = new Set(S.plots.filter(p => p.ring === "near").map(p => p.id));
      let n = 0;
      const fromBot = (d.herds || []).filter(h => !h.mine).map(h => Object.assign({}, h, {
        name: `${t("herds.tg")} ${++n}`, home: near.has(h.home) ? h.home : "Б-С" }));
      S.herds = S.herds.filter(h => !h.from_bot).concat(fromBot);
      render();
    } catch (_) { /* бот спит или нет сети — сайт работает и без него */ }
  }

  // ---------- поиск ----------
  function bindSearch(form, input) {
    const ul = form.querySelector(".results");
    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      if (!navigator.onLine) { toast(t("err.offline"), true); return; }
      const btn = form.querySelector("button"); btn.disabled = true;
      if (S.route === "map") status(t("st.search", { q }), { busy: true });
      try {
        const found = await PL.geocode(q);
        status("");
        if (!found.length) { toast(t("err.notFound"), true); return; }
        const pick = f => { ul.hidden = true; if (S.route !== "map") go("map", `lat=${f.lat}&lon=${f.lon}&name=${encodeURIComponent(f.name)}`); else openVillage(f.name, f.lat, f.lon); };
        if (found.length === 1) return pick(found[0]);
        ul.innerHTML = found.map((f, i) => `<li tabindex="0" data-i="${i}">${esc(f.name)}<small>${esc(f.full)}</small></li>`).join("");
        ul.hidden = false;
        ul.querySelectorAll("li").forEach(li => {
          const choose = () => pick(found[+li.dataset.i]);
          li.onclick = choose;
          li.onkeydown = e => { if (e.key === "Enter") choose(); };
        });
        ul.querySelector("li").focus();
      } catch (e) { status(""); toast(t("err.geocode") + ": " + e.message, true); }
      finally { btn.disabled = false; }
    });
    document.addEventListener("click", e => { if (!form.contains(e.target)) ul.hidden = true; });
    form.addEventListener("keydown", e => { if (e.key === "Escape") ul.hidden = true; });
  }

  // ---------- расчёт и отрисовка ----------
  function summary() {
    const cur = S.cur || J.current(S.plots, S.herds, S.P), pl = S.pl || solve(S.plots, S.herds);
    return { overloaded_before: cur.overloaded, overloaded_after: pl.overloaded, status: pl.status,
      excess_t: +J.hayTonnes(cur.deficit_kg, S.P).toFixed(1), deficit_t: +J.hayTonnes(pl.deficit_kg, S.P).toFixed(1),
      herds: S.herds.length, herds_short: (pl.herds_short || []).length, demo: S.herds.some(h => h.demo),
      au: Math.round(S.herds.reduce((s, h) => s + J.herdAU(h, S.P), 0)), water_added: [...S.added], forbidden: [...S.forbidden],
      missing: S.plots.filter(p => p.ndvi == null).length, model_version: M.MODEL_VERSION };
  }

  function render() {
    if (!S.D) return;
    try {
      S.cur = J.current(S.plots, S.herds, S.P);
      S.pl = solve(S.plots, S.herds);
    } catch (e) { status(t("err.calc") + ": " + e.message, { err: true }); return; }
    const past = zoneHa();
    $("#vtitle").innerHTML = `<b>${esc(S.D.village.name)}</b> · Sentinel-2, ${S.D.source.year} · ${fmt(past)} ${t("common.ha")} ${src("sat")}${freshness()}`;
    metric("plan", { status: S.pl.status, before: J.hayTonnes(S.cur.deficit_kg, S.P), after: J.hayTonnes(S.pl.deficit_kg, S.P),
      over: S.cur.overloaded, missing: S.plots.filter(p => p.ndvi == null).length, herds: S.herds.length });
    paintMap();
    renderPane(S.tab);
  }
  /** Дата расчёта и источник: кэш браузера помечается, старые данные — предупреждение. */
  function freshness() {
    const meta = M.metaOf(S.D);
    const at = meta.calculated_at, days = at ? (Date.now() - Date.parse(at)) / 864e5 : null;
    const when = at ? dateStr(at, false) : t("meta.unknownDate");
    const stale = days != null && days > 30;
    return ` · <span class="fresh${stale || S.fromCache ? " stale" : ""}" title="${esc(t("meta.calc"))}">${t("meta.calcShort", { d: when })}${S.fromCache ? " · " + t("meta.fromCache") : ""}</span>`;
  }

  function plotLabel(p) {
    const r = S.mode === "current" ? S.cur : S.pl, l = r.load[p.id];
    const small = window.matchMedia("(max-width: 860px)").matches;
    // на телефоне внутреннее кольцо узкое: только направление (кольцо и так видно) и процент без пробела — иначе подписи наезжают
    const id = small && p.ring === "near" ? p.dir : p.id;
    const pc = v => (small ? pct(v).replace(/\s/g, "") : pct(v));
    if (S.mode === "ndvi") return `${id}<br>${p.ndvi ?? "?"}`;
    if (!l.known) return `${id}<br>?`;
    if (p.forbidden) return `${id}<br>${t("pop.closedTag")}`;
    return l.used ? `${id}<br>${pc(l.load)}` : (small ? id : `${p.id}<br>${t("map.free")}`);
  }
  function plotFill(p) {
    const r = S.mode === "current" ? S.cur : S.pl;
    if (S.mode === "ndvi") return ndviColor(p.ndvi);
    return r.load[p.id].known ? loadColor(r.load[p.id].load) : loadColor(null);
  }
  // граница участка = вода и правовой статус по введённым данным; заливка = нагрузка (или трава)
  function plotStroke(p) {
    if (p.forbidden) return { color: "#bf4a2a", weight: 3, dashArray: "2 5" };
    const ws = p.water_status || M.waterStatus(p);
    if (ws === "confirmed") return { color: "#1f6fa3", weight: 3.2, dashArray: null };
    if (ws === "satellite" || ws === "modeled") return { color: "#8fd3ff", weight: 2.6, dashArray: ws === "modeled" ? "8 4" : null };
    if (ws === "assumed") return { color: "#ffffff", weight: 1.4, dashArray: null };
    return { color: "#ffffff", weight: 1.2, dashArray: "4 4" };
  }
  const ngLegend = () => (S.D && S.D.nograze && S.D.nograze.status === "ok" && (S.D.nograze.zones || []).length
    ? `<i style="background:#bf4a2a;opacity:.6"></i>${t("map.legend.nograze")}<br>` : "");
  function paintMap() {
    if (!S.D) return;
    if (S.noLeaflet) { renderSchemeMap(); }
    else {
      for (const p of S.plots) {
        const lay = S.layers[p.id]; if (!lay) continue;
        lay.setStyle(Object.assign({ fillColor: plotFill(p), fillOpacity: S.mode === "ndvi" ? 0.06 : 0.5 }, plotStroke(p)));
        lay.setTooltipContent(plotLabel(p));
      }
      if (S.ndviLayer) { if (S.mode === "ndvi") S.ndviLayer.addTo(S.group); else S.ndviLayer.remove(); }
    }
    const lg = $("#legend");
    if (!lg.dataset.bound) {      // на телефоне легенда свёрнута, раскрывается нажатием
      lg.dataset.bound = "1";
      lg.classList.toggle("collapsed", window.matchMedia("(max-width: 860px)").matches);
      lg.addEventListener("click", () => lg.classList.toggle("collapsed"));
      lg.setAttribute("role", "button"); lg.tabIndex = 0;
      lg.addEventListener("keydown", e => { if (e.key === "Enter") lg.classList.toggle("collapsed"); });
    }
    const border = `<b class="lg-h">${t("map.legend.border")}</b><i style="border:3px solid #1f6fa3"></i>${t("map.legend.wconf")}<br><i style="border:2px solid #8fd3ff"></i>${t("map.legend.wsat")}<br>` +
      `<i style="border:1.5px solid #c9c9c9"></i>${t("map.legend.wassumed")}<br><i style="border:1.5px dashed #555"></i>${t("map.legend.wnone")}<br><i style="border:2px dotted #bf4a2a"></i>${t("map.legend.closed")}<br><small>${t("map.legend.rights")}</small>`;
    lg.innerHTML = S.mode === "ndvi"
      ? `<b>${t("map.legend.ndvi")} ${S.D.source.year}</b><i style="background:#2f9a4b"></i>${t("map.legend.dense")}<br><i style="background:#9fd068"></i>${t("map.legend.mid")}<br><i style="background:#d8b56a"></i>${t("map.legend.sparse")}<br><i style="background:#8c510a"></i>${t("map.legend.none")}<br><i style="background:#9aa29a"></i>${t("map.legend.nodata")}<br><small>${t("map.legend.nonpasture")}</small>`
      : `<b>${t("map.legend.load")}</b><i style="background:#3e8e5a"></i>${t("map.legend.ok")}<br><i style="background:#c9970f"></i>${t("map.legend.warn")}<br><i style="background:#bf4a2a"></i>${t("map.legend.bad")}<br><i style="background:#9aa29a"></i>${t("map.legend.idle")}<br><i style="background:#d9d2bf"></i>${t("map.legend.nodata")}<br>${ngLegend()}${border}`;
    $$(".modes button").forEach(b => { const on = b.dataset.mode === S.mode; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
  }

  // ---------- схема участков (SVG): героиня главной, сравнение, PDF и запасная карта без сети ----------
  function scheme(plots, colorOf, labelOf, { size = 300, dark = false, interactive = false } = {}) {
    const c = size / 2, rNear = [size * 0.06, size * 0.27], rFar = [size * 0.27, size * 0.48];
    const pt = (r, a) => [c + r * Math.sin(a), c - r * Math.cos(a)];
    const arc = (r1, r2, a1, a2) => {
      const [x1, y1] = pt(r2, a1), [x2, y2] = pt(r2, a2), [x3, y3] = pt(r1, a2), [x4, y4] = pt(r1, a1);
      return `M${x1.toFixed(1)},${y1.toFixed(1)} A${r2},${r2} 0 0 1 ${x2.toFixed(1)},${y2.toFixed(1)} L${x3.toFixed(1)},${y3.toFixed(1)} A${r1},${r1} 0 0 0 ${x4.toFixed(1)},${y4.toFixed(1)}Z`;
    };
    const dirs = J.DIRS;
    const parts = plots.map(p => {
      const i = dirs.indexOf(p.dir), [r1, r2] = p.ring === "near" ? rNear : rFar;
      const a1 = (i * 45 - 22.5) * Math.PI / 180, a2 = (i * 45 + 22.5) * Math.PI / 180, am = i * 45 * Math.PI / 180;
      const [lx, ly] = pt((r1 + r2) / 2, am);
      const stroke = p.forbidden ? "#bf4a2a" : p.water && p.ring === "far" ? "#8fd3ff" : (dark ? "#1b3f30" : "#ffffff");
      const lab = labelOf(p);
      return `<g${interactive ? ` data-plot="${p.id}" tabindex="0" role="button" aria-label="${esc(p.id)}" style="cursor:pointer"` : ""}>
        <path d="${arc(r1, r2, a1, a2)}" fill="${colorOf(p)}" stroke="${stroke}" stroke-width="${p.water && p.ring === "far" ? 2.5 : 1.5}" ${p.water ? "" : 'stroke-dasharray="3 3"'}/>
        <text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="${p.ring === "near" ? size * 0.03 : size * 0.038}" font-weight="700" fill="#fff" style="paint-order:stroke;stroke:rgba(0,0,0,.55);stroke-width:2px">
          <tspan x="${lx.toFixed(1)}" dy="-0.2em">${esc(p.id)}</tspan>${lab ? `<tspan x="${lx.toFixed(1)}" dy="1.15em" font-weight="600">${esc(lab)}</tspan>` : ""}</text></g>`;
    }).join("");
    return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="${t("ov.schemes")}">${parts}<circle cx="${c}" cy="${c}" r="${size * 0.022}" fill="${dark ? "#e3b25c" : "#1b2a21"}" stroke="#fff" stroke-width="1.5"/></svg>`;
  }
  function renderSchemeMap() {
    const el = $("#schemeMap");
    el.innerHTML = `<p class="fine">${ic("wifioff")} ${t("map.fallback")}</p>` +
      scheme(S.plots, plotFill, p => { const l = (S.mode === "current" ? S.cur : S.pl).load[p.id]; return S.mode === "ndvi" ? String(p.ndvi ?? "?") : !l.known ? "?" : (l.used ? pct(l.load) : ""); }, { size: 520, interactive: true });
    el.querySelectorAll("[data-plot]").forEach(g => {
      g.onclick = () => openPlot(g.dataset.plot);
      g.onkeydown = e => { if (e.key === "Enter") openPlot(g.dataset.plot); };
    });
  }

  // ---------- наблюдения людей (из согласований Келісім на этом устройстве): рядом со снимком и нормой, числа не меняют ----------
  const NO_OBS = {};
  function obsNow() {
    if (!S.D || !Kel.observations) return NO_OBS;
    const list = Kel.observations(S.D.village);
    return list.length ? window.JaiylymKelisim.plotObs(list, S.plots, S.D.source, S.P) : NO_OBS;
  }
  const ndviWord = v => t("map.legend." + (v < 0.18 ? "none" : v < 0.25 ? "sparse" : v < 0.32 ? "mid" : "dense"));
  function obsHtml(p, c) {
    const g = obsNow()[p.id];
    if (!g) return "";
    const v = normVerdict(c);
    return `<div class="obs3 obs3-${g.verdict}"><h4>${t("obs.three")}</h4><dl>
      <dt>${src("sat")}</dt><dd>${p.ndvi == null ? t("st.no_data") : t("obs.sat", { w: ndviWord(p.ndvi), v: String(p.ndvi).replace(".", ","), y: S.D.source.year })}</dd>
      <dt>${src("norm")}</dt><dd>${v ? normVerdictText(v) : t("nm.noRegion")}</dd>
      <dt>${src("people")}</dt><dd>${Kel.obsItems(g)}</dd></dl>
      <p><b>${t("obs.r." + g.verdict)}</b> ${t("obs.noChange")}</p></div>`;
  }

  // ---------- карточка участка ----------
  function spark(series) {
    if (!series || series.length < 2) return "";
    const w = 240, h = 50, vs = series.map(x => x.v), lo = Math.min(...vs) - 0.02, hi = Math.max(...vs) + 0.02;
    const X = i => 4 + i * (w - 8) / (series.length - 1), Y = v => h - 13 - (v - lo) / (hi - lo) * (h - 20);
    const ch = (vs[vs.length - 1] - vs[0]) / vs[0] * 100, col = ch <= -10 ? "#bf4a2a" : ch >= 10 ? "#3e8e5a" : "#627064";
    const d = s => s.slice(8, 10) + "." + s.slice(5, 7);
    return `<p style="margin:10px 0 0;font-size:12.5px">${t("pop.season")}: <b style="color:${col}">${ch >= 0 ? "+" : ""}${ch.toFixed(0)} %</b> ${src("sat")}</p>
      <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block;max-width:100%">
      <polyline points="${series.map((x, i) => `${X(i).toFixed(1)},${Y(x.v).toFixed(1)}`).join(" ")}" fill="none" stroke="${col}" stroke-width="2"/>
      ${series.map((x, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(x.v).toFixed(1)}" r="2.6" fill="${col}"><title>${d(x.d)}: ${x.v}</title></circle>`).join("")}
      <text x="2" y="${h - 1}" font-size="10" fill="#627064">${d(series[0].d)}</text><text x="${w - 2}" y="${h - 1}" font-size="10" fill="#627064" text-anchor="end">${d(series[series.length - 1].d)}</text></svg>`;
  }
  function plotHtml(p) {
    const c = capOf(p), l = (S.mode === "current" ? S.cur : S.pl).load[p.id];
    const names = l.herds.map(x => (S.herds.find(h => h.id === x.herd) || {}).name).filter(Boolean);
    const ndviRow = p.ndvi_base != null ? `${p.ndvi_base} → ${p.ndvi ?? "?"}` : (p.ndvi ?? t("st.no_data"));
    const ws = M.waterStatus(p), userWs = S.waterSet[p.id] || "";
    return `<div class="pop"><h3 style="margin:0 0 6px">${esc(p.id)} <small style="font-weight:500;color:#627064">${p.ring === "near" ? t("pop.near") : t("pop.far")}, ~${p.dist_km} ${t("common.km")}, ${p.dir}</small></h3>
      ${obsHtml(p, c)}
      <table><tbody>
      ${p.nograze_ha > 0 && p.pasture_ha_gross != null
        ? `<tr><td>${t("pop.pastureNet")}</td><td>${fmt(p.zone ? p.zone.before : p.pasture_ha)} ${t("common.ha")} = ${fmt(p.pasture_ha_gross)} ${src("sat")} − ${fmt1(p.nograze_ha)} ${src("osm")}</td></tr>`
        : `<tr><td>${t("pop.pasture")}</td><td>${fmt(p.pasture_ha)} ${t("common.ha")} ${src("sat")}</td></tr>`}
      ${p.zone ? `<tr><td>${t("zn.row")}</td><td>${pct(p.zone.share)} ${t("zn.of", { a: fmt(p.zone.before) })} ${src("input")}</td></tr>` : ""}
      ${p.nograze_ha != null ? `<tr><td>${t("pop.nograze")}</td><td style="white-space:normal">${fmt1(p.nograze_ha)} ${t("common.ha")} ${t("pop.nograzeOf", { g: fmt(p.pasture_ha_gross), b: p.nograze_buffer_m })} ${src("osm")}</td></tr>` : ""}
      <tr><td>${t("pop.ndvi")}${p.ndvi_base != null ? ` ${S.D.source.base_year} → ${S.D.source.year}` : ""}</td><td>${ndviRow} ${src("sat")}</td></tr>
      <tr><td>${t("pop.quality")}</td><td>${confTag(p)}</td></tr>
      <tr><td>${t("pop.forageConf")}</td><td>${fcTag(p)}</td></tr>
      <tr><td>${t("pop.forage")}</td><td>${c.known ? fmt(c.forage / 1000) + " " + t("pop.t") : t("st.no_data")} ${src("model")}</td></tr>
      <tr><td>${t("pop.cap")}</td><td>${c.known ? "≈ " + sheepCap(c) + " " + t("pop.sheep") : t("st.no_data")} ${src(c.limited_by === "norm" ? "norm" : "model")}</td></tr>
      ${c.norm ? `<tr><td>${t("nm.row")}</td><td style="white-space:normal">≈ ${fmt(c.sat.au_season / S.P.au.sheep)} ${src("model")} / ${fmt(c.norm.au_season / S.P.au.sheep)} ${src("norm")}<br>${normVerdictText(normVerdict(c) || { k: "match" })}${c.norm.green < 0.995 ? ` ${t("nm.green", { g: pct(c.norm.green), a: String(p.ndvi).replace(".", ","), b: String(p.ndvi_ref).replace(".", ",") })}` : ""}</td></tr>` : ""}
      <tr><td>${t("pop.load")}</td><td><b>${l.known ? pct(l.load) : t("st.no_data")}</b> (${S.mode === "current" ? t("kpi.before") : t("kpi.after")})</td></tr>
      <tr><td>${t("pop.herds")}</td><td style="white-space:normal">${esc(names.join(", ")) || "—"}</td></tr>
      <tr><td>${t("pop.water")}</td><td style="white-space:normal">${esc(t("ws." + ws))}</td></tr>
      ${prevRow(p)}
      ${multiRow(p)}
      </tbody></table>
      ${c.known ? "" : `<p class="note warn" style="margin:8px 0 0">${t("pop.noData")}</p>`}
      ${spark(p.series)}
      <button type="button" class="btn btn-soft btn-sm" style="width:100%;margin-top:10px" data-how="${esc(p.id)}">${ic("info")} ${t("pop.how")}</button>
      <label class="field" style="margin-top:8px">${t("ws.set")} ${src("input")}<select data-ws="${esc(p.id)}">
        <option value="" ${userWs ? "" : "selected"}>${t("ws.asIs")}: ${esc(t("ws." + M.waterStatus(S.D.plots.find(x => x.id === p.id) || p)))}</option>
        <option value="confirmed" ${userWs === "confirmed" ? "selected" : ""}>${t("ws.confirmed")}</option>
        <option value="absent" ${userWs === "absent" ? "selected" : ""}>${t("ws.absent")}</option></select></label>
      ${S.baseWater[p.id] === false && !userWs ? `<label class="check" style="margin-top:8px"><input type="checkbox" data-water="${p.id}" ${S.added.has(p.id) ? "checked" : ""}> ${t("pop.hasWater")} ${src("input")}</label>` : ""}
      <label class="check" style="margin-top:8px"><input type="checkbox" data-closed="${esc(p.id)}" ${S.forbidden.has(p.id) ? "checked" : ""}> ${t("pop.closed")} ${src("input")}</label>
      <fieldset class="rest"><legend>${t("rest.title")} ${src("input")}</legend>
        <label class="field">${t("rest.spring")}<input type="number" inputmode="numeric" min="0" max="${S.P.season_days}" step="1" data-rest="${esc(p.id)}" data-side="spring" value="${((S.rest || {})[p.id] || {}).spring || 0}"></label>
        <label class="field">${t("rest.autumn")}<input type="number" inputmode="numeric" min="0" max="${S.P.season_days}" step="1" data-rest="${esc(p.id)}" data-side="autumn" value="${((S.rest || {})[p.id] || {}).autumn || 0}"></label>
        <small class="fine">${t("rest.note", { d: S.P.season_days })}</small></fieldset>
      <a class="btn btn-tg btn-sm" style="width:100%;margin-top:10px;color:#fff" href="${botLink(p.id)}" target="_blank" rel="noopener">${ic("send")} ${t("pop.subscribe")}</a>
      ${S.botSubs[p.id] ? `<p class="fine" style="margin:6px 0 0">${t("pop.subsCount", { n: S.botSubs[p.id] })}</p>` : ""}</div>`;
  }
  function bindPlotHtml(root) {
    root.querySelectorAll("[data-water]").forEach(chk => chk.onchange = () => { toggleWater(chk.dataset.water, chk.checked); });
    root.querySelectorAll("[data-how]").forEach(b => b.onclick = () => openHow(b.dataset.how));
    root.querySelectorAll("[data-closed]").forEach(chk => chk.onchange = () => {
      const id = chk.dataset.closed;
      chk.checked ? S.forbidden.add(id) : S.forbidden.delete(id);
      saveZone(); rebuildPlots(); render(); closePlotCard();
      toast((chk.checked ? t("pop.closedOn") : t("pop.closedOff")) + ": " + id);
    });
    root.querySelectorAll("[data-rest]").forEach(inp => inp.onchange = () => {
      const id = inp.dataset.rest, v = Math.max(0, Math.min(S.P.season_days, Math.round(+inp.value || 0)));
      const r = Object.assign({ spring: 0, autumn: 0 }, (S.rest || {})[id], { [inp.dataset.side]: v });
      S.rest = Object.assign({}, S.rest);
      if (r.spring || r.autumn) S.rest[id] = r; else delete S.rest[id];
      rebuildPlots(); render(); closePlotCard();
      toast(r.spring || r.autumn ? t("rest.on", { id, a: r.spring + 1, b: S.P.season_days - r.autumn }) : t("rest.off", { id }));
    });
    root.querySelectorAll("[data-ws]").forEach(sel => sel.onchange = () => {
      const id = sel.dataset.ws;
      if (sel.value) { S.waterSet[id] = sel.value; S.added.delete(id); } else delete S.waterSet[id];
      rebuildPlots(); render(); closePlotCard();
    });
  }

  // ---------- «Как рассчитано?»: пошаговый расчёт, который можно повторить на калькуляторе ----------
  function openHow(id, herdId) {
    const p = S.plots.find(x => x.id === id); if (!p) return;
    const herd = herdId ? S.herds.find(h => h.id === herdId) : null;
    const e = J.explainCapacity(p, S.P, herd);
    const meta = M.metaOf(S.D);
    const val = s => (s.value == null ? (s.key === "ndvi" ? t("st.no_data") : "—") : s.key === "ndvi" ? String(s.value) : fmt1(s.value));
    const unit = s => (s.key === "ndvi" ? "" : esc(t("unit." + s.key)));
    const formula = s => (s.kind === "sat" ? esc(t("how.f." + s.key)) : `<code>${esc(s.formula)}</code>`);
    const rows = e.steps.map(s => `<tr><td>${t("how.step." + s.key)}</td><td style="white-space:normal">${formula(s)}</td>
      <td class="num"><b>${val(s)}</b> ${unit(s)}</td><td>${src(s.kind)}</td></tr>`).join("");
    const limits = [];
    if (!e.capacity.known) limits.push(t("how.lnd"));
    if (e.capacity.status === "insufficient_quality") limits.push(t("how.llq"));
    limits.push(t("how.l1"), t("how.l2"), t("how.l3"), t("how.l4"));
    const d = document.createElement("dialog");
    d.className = "modal modal-wide";
    d.innerHTML = `<form method="dialog" class="modal-x"><button aria-label="${t("common.close")}">${ic("x")}</button></form>
      <h2>${t("how.title", { id: esc(p.id) })}</h2>
      <p class="fine">${t("how.calc")} ${herd ? t("how.herdFor") + " «" + esc(herd.name) + "»." : ""}</p>
      <div class="tablewrap"><table class="how"><tbody>${rows}
        <tr><td>${t("how.step.dates")}</td><td colspan="3" style="white-space:normal">${meta.scene_dates.map(x => dateStr(x, false)).join(", ") || "—"} ${src("sat")}</td></tr>
        <tr><td>${t("how.step.k")}</td><td colspan="3">k_ndvi = ${e.params.k_ndvi} ${t("unit.k")}, ndvi0 = ${e.params.ndvi0}; ${t("how.step.util")}: ${e.params.util}; intake = ${e.params.intake} ${t("unit.intake")} ${src("model")}</td></tr>
      </tbody></table></div>
      <h3>${t("how.limits")}</h3><ul class="todo">${limits.map(x => `<li>${ic("info")}<span>${x}</span></li>`).join("")}</ul>
      <p class="fine">${t("how.version", { v: e.model_version, f: e.field_validated ? t("how.yes") : t("how.no") })}</p>`;
    document.body.appendChild(d);
    d.addEventListener("close", () => d.remove());
    d.showModal();
  }
  // на телефоне карточка участка — нижняя шторка во весь экран: всплывашка Leaflet там обрезается краем карты и перекрывается кнопками
  const phone = () => matchMedia("(max-width: 860px)").matches;
  let plotDlg;
  function closePlotCard() { if (S.map) S.map.closePopup(); if (plotDlg && plotDlg.open) plotDlg.close(); }
  function cardDialog(html) {
    plotDlg = plotDlg || Object.assign(document.createElement("dialog"), { className: "modal plot-sheet" });
    if (!plotDlg.isConnected) {
      document.body.appendChild(plotDlg);
      plotDlg.addEventListener("click", e => { if (e.target === plotDlg) plotDlg.close(); });   // нажатие на затемнение закрывает
    }
    plotDlg.innerHTML = `<form method="dialog" class="modal-x"><button aria-label="${t("common.close")}">${ic("x")}</button></form>` + html;
    if (!plotDlg.open) plotDlg.showModal();
    plotDlg.scrollTop = 0;
    return plotDlg;
  }
  function openPlot(id) {
    const p = S.plots.find(x => x.id === id); if (!p) return;
    if (!S.noLeaflet && S.layers[id] && !phone()) {
      const h = $("#map").clientHeight;
      const pop = L.popup({ maxWidth: 300, maxHeight: Math.max(220, h - 120), autoPanPaddingTopLeft: [16, 70], autoPanPaddingBottomRight: [16, 16] })
        .setLatLng(S.layers[id].getBounds().getCenter()).setContent(plotHtml(p)).openOn(S.map);
      bindPlotHtml(pop.getElement());
      return;
    }
    bindPlotHtml(cardDialog(plotHtml(p)));
  }
  function focusPlot(id) {
    if (!S.plots.some(p => p.id === id)) return;
    if (!S.noLeaflet && S.layers[id]) S.map.fitBounds(S.layers[id].getBounds(), { padding: [40, 40], maxZoom: 13, animate: false });
    openPlot(id);
  }
  function toggleWater(id, on) {
    if (S.baseWater[id] !== false) return;
    on ? S.added.add(id) : S.added.delete(id);
    rebuildPlots();
    render();
    if (S.map) S.map.closePopup();
    toast(on ? `${t("water.added")}: ${id}` : `${t("water.remove")}: ${id}`);
  }

  // ---------- вкладки панели ----------
  function renderPane(tab) {
    if (!S.D) { if (S.route === "map") renderStart(); return; }
    S.tab = tab;
    $$(".tabs [data-tab]").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === tab));
    $$(".pane").forEach(p => { p.hidden = p.dataset.pane !== tab; });
    const el = $(`.pane[data-pane="${tab}"]`);
    ({ brief: paneBrief, overview: paneBrief, herds: paneHerds, routes: paneRoutes, water: paneWater, plots: panePlots, data: paneData, whatif: paneWhatIf })[tab](el);
    tabsEdge(true);
  }
  /** Полоса вкладок на телефоне шире экрана: выбранная вкладка прокручивается в видимую часть, края с затуханием показывают, что есть ещё. */
  function tabsEdge(reveal) {
    const bar = $(".tabs");
    if (!bar) return;
    if (!bar.dataset.edge) { bar.dataset.edge = "1"; bar.addEventListener("scroll", () => tabsEdge(false), { passive: true }); addEventListener("resize", () => tabsEdge(false)); }
    const sel = bar.querySelector('[aria-selected="true"]');
    if (reveal && sel && bar.scrollWidth > bar.clientWidth) {
      const b = bar.getBoundingClientRect(), s = sel.getBoundingClientRect();
      if (s.left < b.left + 24 || s.right > b.right - 24)
        bar.scrollLeft += (s.left - b.left) - (b.width - s.width) / 2;
    }
    bar.classList.toggle("more-left", bar.scrollLeft > 4);
    bar.classList.toggle("more-right", bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 4);
  }

  function kpi(label, a, b, srcs, fmtFn = fmt, lowerIsBetter = true) {
    const good = lowerIsBetter ? b <= a : b >= a;
    return `<div class="kpi"><div class="k">${label}</div>
      <div class="v"><span class="was">${fmtFn(a)}</span><span class="arr">→</span><span class="${good ? "now" : "was"}">${fmtFn(b)}</span></div>
      <div class="lbl"><span>${t("kpi.before")}</span><span>${t("kpi.after")}</span></div>${srcs}</div>`;
  }
  function compareChart() {
    const rows = S.plots.filter(p => S.cur.load[p.id].used > 0 || S.pl.load[p.id].used > 0)
      .sort((a, b) => S.cur.load[b.id].load - S.cur.load[a.id].load);
    if (!rows.length) return "";
    const maxL = Math.min(8, Math.max(1.2, ...rows.map(p => Math.max(S.cur.load[p.id].load, S.pl.load[p.id].load)).filter(isFinite)));
    const W = 400, L0 = 46, R = 50, bh = 9, gap = 6, rh = bh * 2 + gap + 8, H = rows.length * rh + 26;
    const x = v => L0 + Math.min(v, maxL) / maxL * (W - L0 - R);
    const bar = (v, y, col) => `<rect x="${L0}" y="${y}" width="${Math.max(1.5, x(v) - L0).toFixed(1)}" height="${bh}" rx="3" fill="${col}"/>
      <text x="${(x(v) + 4).toFixed(1)}" y="${y + bh - 1}" font-size="10.5" fill="#3b4a40">${pct(v)}${v > maxL ? " ›" : ""}</text>`;
    const body = rows.map((p, i) => {
      const y = 8 + i * rh, lc = S.cur.load[p.id].load, lp = S.pl.load[p.id].load;
      return `<text x="0" y="${y + bh + 4}" font-size="11.5" font-weight="700" fill="#1b2a21">${esc(p.id)}</text>${bar(lc, y, loadColor(lc))}${bar(lp, y + bh + 3, "#2f7aa6")}`;
    }).join("");
    return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${t("ov.compare")}">${body}
      <line x1="${x(1)}" x2="${x(1)}" y1="2" y2="${H - 18}" stroke="#1b2a21" stroke-dasharray="3 3"/>
      <text x="${x(1)}" y="${H - 4}" font-size="10.5" text-anchor="middle" fill="#1b2a21">100 %</text></svg>
      <p class="cap"><i style="display:inline-block;width:10px;height:10px;background:#bf4a2a;border-radius:3px"></i> ${t("kpi.before")} &nbsp;
      <i style="display:inline-block;width:10px;height:10px;background:#2f7aa6;border-radius:3px"></i> ${t("kpi.after")}. ${t("ov.compareNote")}</p></div>`;
  }
  function paneOverview(el) {
    if (!S.herds.length) {
      el.innerHTML = `<p class="empty">${t("ov.noherds")}</p><button class="btn btn-soft" id="addDemo">${ic("plus")} ${t("ov.addDemo")}</button> <button class="btn btn-ghost" id="addHerd0">${ic("plus")} ${t("herds.add")}</button>${paramsBlock()}`;
      $("#addDemo", el).onclick = () => { S.herds = demoHerds(); render(); };
      $("#addHerd0", el).onclick = () => { addHerd(); renderPane("herds"); };
      bindParams(el);
      return;
    }
    const hc = J.hayTonnes(S.cur.deficit_kg, S.P), hp = J.hayTonnes(S.pl.deficit_kg, S.P);
    const mln = x => fmt1(x * S.P.hay_price / 1e6);
    el.innerHTML = `<div class="kpis">
        ${kpi(t("kpi.overloaded"), S.cur.overloaded, S.pl.overloaded, src("model"))}
        ${kpi(t("kpi.excess"), hc, hp, src("model"))}
        ${kpi(t("kpi.cost"), hc, hp, src("model") + " " + src("input"), mln)}
      </div>
      <p class="note warn">${t("kpi.costNote")}</p>
      <p class="note">${t("ov.explain.cur", { t: fmt(hc) })} ${t("ov.explain.plan")}${hp > 0 ? " " + t("ov.explain.deficit", { t: fmt(hp) }) : ""}</p>
      <h3>${ic("chart")} ${t("ov.compare")}</h3>${compareChart()}
      <h3>${ic("grid")} ${t("ov.schemes")}</h3>
      <div class="schemes">
        <figure>${scheme(S.plots, p => loadColor(S.cur.load[p.id].load), p => (S.cur.load[p.id].used ? pct(S.cur.load[p.id].load) : ""))}<figcaption>${t("map.mode.current")}</figcaption></figure>
        <figure>${scheme(S.plots, p => loadColor(S.pl.load[p.id].load), p => (S.pl.load[p.id].used ? pct(S.pl.load[p.id].load) : ""))}<figcaption>${t("map.mode.plan")}</figcaption></figure>
      </div>${paramsBlock()}`;
    bindParams(el);
  }
  // параметры модели: диапазон, единицы и происхождение (стандарт / калибровка / свой) видны у каждого поля
  const PARAM_FIELDS = [["season_days", "params.season"], ["intake", "params.intake"], ["util", "params.util"], ["k_ndvi", "params.k"],
    ["ndvi0", "params.ndvi0"], ["forage_factor", "params.forage"], ["max_load", "params.maxload"], ["hay_price", "params.hay"]];
  function paramInputs() {
    const origin = S.P._origin || {};
    return PARAM_FIELDS.map(([k, l]) => { const sp = M.SPEC[k];
      return `<label class="field">${t(l)} <small class="fine">${t("set.range", { a: sp.min, b: sp.max })} · ${esc(sp.unit)} · <span class="origin o-${origin[k] || "default"}">${t("set.origin." + (origin[k] || "default"))}</span></small>
        <input type="number" step="any" min="${sp.min}" max="${sp.max}" data-param="${k}" value="${S.P[k]}"><small class="perr" data-perr="${k}" hidden></small></label>`; }).join("");
  }
  function paramsBlock() {
    return `<details class="params"><summary>${t("params.title")} ${src("model")} ${src("input")}</summary>
      ${paramInputs()}
      <p class="fine">${t("set.modelVer")}: ${M.MODEL_VERSION} · ${t("set.field")}: ${M.fieldValidated(S.P) ? t("how.yes") : t("how.no")}</p>
      <button class="linkbtn" data-reset>${t("params.reset")}</button></details>`;
  }
  /** Неверное значение не принимается: показываем причину рядом с полем и оставляем прежнее значение. */
  function setParam(k, raw, inp, root) {
    const r = M.validate({ [k]: raw === "" ? NaN : +raw });
    const err = root && root.querySelector(`[data-perr="${k}"]`);
    if (!r.ok) {
      if (err) { err.hidden = false; err.textContent = t("set.bad", { v: raw, r: r.errors[0].reason }); }
      inp.value = S.P[k]; inp.setAttribute("aria-invalid", "true");
      return false;
    }
    if (err) err.hidden = true;
    inp.removeAttribute("aria-invalid");
    S.userP = Object.assign({}, S.userP, r.values);
    S.P = resolveParams(S.userP, S.calib); saveParams();
    return true;
  }
  function bindParams(el) {
    el.querySelectorAll("[data-param]").forEach(i => i.onchange = () => { if (setParam(i.dataset.param, i.value, i, el)) render(); });
    const r = el.querySelector("[data-reset]"); if (r) r.onclick = () => { S.userP = {}; S.P = resolveParams({}, S.calib); saveParams(); render(); };
  }

  function addHerd() {
    S.herds.push({ id: "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: t("herds.farm") + " " + (S.herds.length + 1), sheep: 300, goats: 0, cattle: 0, horses: 0, home: "Б-С", daily_return: false });
    render();
  }
  function paneHerds(el) {
    const near = S.plots.filter(p => p.ring === "near").map(p => p.id);
    const tag = h => h.mine ? `<span class="tag tag-mine">${t("herds.mine")}</span>` : h.from_bot ? `<span class="tag tag-tg">${t("herds.tg")}</span>` : h.demo ? `<span class="tag tag-demo">${t(h.demo_edited ? "demo.edited" : "herds.demo")}</span>` : "";
    const allIds = S.plots.map(p => p.id);
    const rights = h => {
      const ro = h.mine || h.from_bot;
      const list = h.allowed_plots && h.allowed_plots.length ? h.allowed_plots : null;
      return `<details class="rights"><summary>${t("herds.rights")}: <b>${list ? esc(list.join(", ")) : t("herds.rightsAll")}</b> ${src("input")}</summary>
        <div class="chips">${allIds.map(id => `<label class="chip"><input type="checkbox" data-rp="${esc(id)}" ${list && list.includes(id) ? "checked" : ""} ${ro ? "disabled" : ""}>${esc(id)}</label>`).join("")}</div>
        <p class="fine">${t("herds.rightsNote")}</p></details>`;
    };
    el.innerHTML = S.herds.map((h, i) => `<div class="herd" data-i="${i}">
        <div class="herd-head"><input data-k="name" value="${esc(h.name)}" aria-label="${t("herds.name")}" ${h.mine || h.from_bot ? "readonly" : ""}>${tag(h)}
          ${h.mine || h.from_bot ? "" : `<button class="btn btn-ghost btn-sm" data-del aria-label="${t("herds.remove")}">${ic("trash")}</button>`}</div>
        <div class="herd-grid">
          ${["sheep", "goats", "cattle", "horses"].map(k => `<label class="field">${t("herds." + k)}<input type="number" inputmode="numeric" min="0" step="10" data-k="${k}" value="${h[k] || 0}" ${h.mine || h.from_bot ? "readonly" : ""}></label>`).join("")}
        </div>
        <div class="herd-foot">
          <label class="field" style="flex-direction:row;align-items:center;gap:8px">${t("herds.home")}<select data-k="home" ${h.mine || h.from_bot ? "disabled" : ""}>${near.map(id => `<option ${id === h.home ? "selected" : ""}>${id}</option>`).join("")}</select></label>
          <label class="check"><input type="checkbox" data-k="daily_return" ${h.daily_return ? "checked" : ""} ${h.mine || h.from_bot ? "disabled" : ""}> ${t("herds.daily")}</label>
          <label class="field" style="flex-direction:row;align-items:center;gap:8px" title="${esc(t("herds.wNote"))}">${t("herds.weight")}<select data-k="weight" data-num="1">${[[1, t("herds.w1")], [1.5, t("herds.w15")], [2, t("herds.w2")]].map(([w, l]) => `<option value="${w}" ${(+h.weight || 1) === w ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          <span class="au">${fmt(J.herdAU(h, S.P))} ${t("herds.au")} ${src("input")}</span>
        </div>${rights(h)}</div>`).join("") +
      `<button class="btn btn-soft" id="addHerd">${ic("plus")} ${t("herds.add")}</button><p class="note">${t("herds.note")}</p><p class="note">${t("herds.wNote")}</p><p class="note">${t("herds.codes")}</p>`;
    $$(".herd", el).forEach(card => {
      const h = S.herds[+card.dataset.i];
      card.querySelectorAll("[data-k]").forEach(inp => inp.onchange = () => {
        const k = inp.dataset.k;
        h[k] = inp.type === "checkbox" ? inp.checked : inp.type === "number" ? Math.max(0, Math.round(+inp.value || 0)) : inp.dataset.num ? +inp.value : inp.value;
        if (inp.type === "number") inp.value = h[k];
        if (h.demo) h.demo_edited = true;                  // изменённое демо-стадо остаётся демо-стадом
        S.cur = J.current(S.plots, S.herds, S.P); S.pl = solve(S.plots, S.herds); paintMap();
        card.querySelector(".au").innerHTML = `${fmt(J.herdAU(h, S.P))} ${t("herds.au")} ${src("input")}`;
      });
      card.querySelectorAll("[data-rp]").forEach(chk => chk.onchange = () => {
        const set = new Set(h.allowed_plots || []);
        chk.checked ? set.add(chk.dataset.rp) : set.delete(chk.dataset.rp);
        h.allowed_plots = set.size ? allIds.filter(id => set.has(id)) : undefined;
        if (h.demo) h.demo_edited = true;
        render();
      });
      const del = card.querySelector("[data-del]");
      if (del) del.onclick = () => { S.herds.splice(+card.dataset.i, 1); render(); };
    });
    $("#addHerd", el).onclick = addHerd;
  }

  function paneRoutes(el) {
    if (!S.herds.length) { el.innerHTML = `<p class="empty">${t("ov.noherds")}</p>`; return; }
    const Sd = S.P.season_days, byId = Object.fromEntries(S.plots.map(p => [p.id, p]));
    el.innerHTML = S.herds.map(h => {
      const bars = (S.pl.herdPlans[h.id] || []).map(s => {
        const cls = s.plot ? byId[s.plot].ring : "gap";
        const lab = s.plot || t("routes.nofeed");
        return `<span class="${cls}" style="left:${(s.from - 1) / Sd * 100}%;width:${(s.to - s.from + 1) / Sd * 100}%" title="${esc(lab)}: ${t("common.days")} ${s.from}–${s.to}">${esc(lab)}</span>`;
      }).join("");
      const cov = S.pl.coverage ? S.pl.coverage[h.id] : Sd;
      const dg = S.pl.diagnostics && S.pl.diagnostics[h.id];
      const why = cov < Sd - 0.5 ? `<p class="note warn" style="margin:-6px 0 14px">${t("routes.short", { d: Math.max(0, Math.round(cov)) })} ${dg && dg.reason ? whyHerd(h, dg) : ""}</p>` : "";
      return `<div class="rname"><span>${esc(h.name)}</span><small>${fmt(J.herdAU(h, S.P))} ${t("herds.au")}</small></div><div class="tl" role="img" aria-label="${esc(h.name)}">${bars}</div>${why}`;
    }).join("") + `<p class="note">${t("routes.note", { d: Sd })} ${src("model")}</p>`;
  }

  /** Рейтинг «где проверять воду» считается один раз на план. */
  const wrCache = new WeakMap();
  function wellRank() {
    if (!wrCache.has(S.pl)) wrCache.set(S.pl, J.wellRank(S.plots, S.herds, S.P, { algorithm: S.algo }, S.pl));
    return wrCache.get(S.pl);
  }
  /** Предложения плана: водопой — только если он правда уменьшает дефицит, лучший первым. */
  function planSuggestions() {
    const all = S.pl.suggestions || [], w = all.filter(s => s.type === "add_water");
    if (!w.length) return all;
    const gain = Object.fromEntries(wellRank().list.map(x => [x.plot, x.gain_t]));
    return w.filter(s => gain[s.plot]).sort((a, b) => gain[b.plot] - gain[a.plot]).concat(all.filter(s => s.type !== "add_water"));
  }
  // что проверил человек: право, источник воды, цена. Пусто — «не проверено»; на рейтинг не влияет
  const WRIGHT = ["ok", "no"], WSRC = ["well", "borehole", "river", "pipe"];
  const wcKey = () => cacheKey(S.D.village.lat, S.D.village.lon) + ":wcheck";
  const wcheck = id => Object.assign({ right: "", source: "", cost: 0 }, (C.ls.get(wcKey(), {}) || {})[id]);
  const wcText = id => { const c = wcheck(id); return [`${t("wc.right")}: ${t("wc.right." + (c.right || "none"))}`, `${t("wc.source")}: ${t("wc.source." + (c.source || "none"))}`, `${t("wc.cost")}: ${c.cost ? fmt(c.cost) + " " + t("rep.tenge") : t("wc.none")}`].join("; "); };
  const noWaterObs = () => Object.entries(obsNow()).map(([id, g]) => [id, new Set(g.items.filter(i => i.reason === "no_water").flatMap(i => i.households)).size]).filter(x => x[1]);

  function paneWater(el) {
    const wr = wellRank(), ws = wr.list.filter(w => w.gain_t > 0), rest = wr.list.filter(w => !w.gain_t), nm = ids => ids.map(id => esc((S.herds.find(h => h.id === id) || {}).name || id)).join(", ");
    const nobs = noWaterObs(), nob = Object.fromEntries(nobs);
    const addBtn = w => (S.added.has(w.plot) ? "" : `<button class="btn btn-soft btn-sm" data-add="${w.plot}">${ic("plus")} ${t("water.add")}</button>`);
    const wrow = (w, i) => { const c = wcheck(w.plot), done = (c.right ? 1 : 0) + (c.source ? 1 : 0) + (c.cost ? 1 : 0);
      return `<li class="wcand"><div class="row"><div class="grow"><b>${i + 1}. ${esc(w.plot)}</b><small>${t("water.gain", { t: fmt(w.gain_t), d: fmt(wr.deficit_t) })} ${src("model")}</small>
        <small>${t("water.better", { n: w.better.length })}${w.better.length ? ": " + nm(w.better) : ""}${w.worse.length ? ` · ${t("water.worse")}: ${nm(w.worse)}` : ""}</small>
        ${w.other_limits.length ? `<small>${t("water.remain", { r: w.other_limits.map(r => t("rsn." + r)).join(", ") })}</small>` : ""}</div><div class="btns">${addBtn(w)}</div></div>
        <details ${c.right === "no" ? "open" : ""}><summary>${t("wc.title")}: ${done ? t("wc.done", { n: done }) : t("wc.none")} ${src("input")}</summary><div class="wcform">
          <label class="field">${t("wc.right")}<select data-wc="${esc(w.plot)}" data-f="right"><option value="">${t("wc.none")}</option>${WRIGHT.map(x => `<option value="${x}" ${c.right === x ? "selected" : ""}>${t("wc.right." + x)}</option>`).join("")}</select></label>
          <label class="field">${t("wc.source")}<select data-wc="${esc(w.plot)}" data-f="source"><option value="">${t("wc.none")}</option>${WSRC.map(x => `<option value="${x}" ${c.source === x ? "selected" : ""}>${t("wc.source." + x)}</option>`).join("")}</select></label>
          <label class="field">${t("wc.cost")}, ${t("rep.tenge")}<input type="number" inputmode="numeric" min="0" step="10000" data-wc="${esc(w.plot)}" data-f="cost" value="${c.cost || ""}" placeholder="${t("wc.none")}"></label></div>
          ${c.right === "no" ? `<p class="note warn">${t("wc.noRight")}</p>` : ""}</details></li>`; };
    const added = [...S.added];
    const baseOnly = S.plots.map(p => (S.added.has(p.id) ? Object.assign({}, p, { water: false, water_status: "unknown" }) : p));
    const before = solve(baseOnly, S.herds);
    const statusList = `<h3>${ic("drop")} ${t("water.status")}</h3><div class="tablewrap"><table><tbody>${S.plots.map(p => `<tr><td><b>${esc(p.id)}</b></td>
      <td style="white-space:normal">${esc(wsLabel(p))} ${src(["confirmed", "absent"].includes(p.water_status) || S.added.has(p.id) ? "input" : p.water_status === "satellite" ? "sat" : "model")}${nob[p.id] ? ` <span class="tag tag-check">${t("water.saidNo", { n: nob[p.id] })}</span>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
    let sim = "";
    if (added.length) {
      const newly = added.filter(id => (S.pl.load[id] || {}).used > 0.5);
      const prepLimits = added.map(id => { const w = J.wellEffect(baseOnly, S.herds, S.P, id); return w.remaining_limits.length ? `${id}: ${w.remaining_limits.map(r => t("rsn." + r)).join(", ")}` : ""; }).filter(Boolean);
      sim = `<div class="srcblock s-model"><h3>${t("water.sim")} ${src("model")}</h3>
        <p>${t("water.newly", { ids: newly.length ? newly.join(", ") : t("rep.none") })}</p>
        ${prepLimits.length ? `<p>${t("water.remain", { r: esc(prepLimits.join("; ")) })}</p>` : ""}
        <p class="note warn">${t("water.check")}</p></div>`;
    }
    const verdict = !wr.list.length ? t("water.none") + (wr.status === "no_help" ? " " + t("water.st.no_help", { t: fmt(wr.deficit_t) }) : "") : wr.status === "ok" ? "" : t("water.st." + wr.status, { t: fmt(wr.deficit_t) });
    el.innerHTML = `<h3>${ic("drop")} ${t("water.title")}</h3>
      ${verdict ? `<p class="note ${wr.status === "no_help" ? "warn" : ""}" id="waterVerdict">${verdict}</p>` : ""}
      ${ws.length ? `<ul class="list">${ws.map(wrow).join("")}</ul>` : ""}
      ${rest.length ? `<details class="wrest"><summary>${t(wr.status === "ok" ? "water.zero" : "water.dry")}: ${rest.length}</summary><ul class="list">${rest.map(w => `<li class="row"><div class="grow"><b>${esc(w.plot)}</b><small>${t("water.opens", { n: fmt(w.sheep) })} ${src("model")}</small></div><div class="btns">${addBtn(w)}</div></li>`).join("")}</ul></details>` : ""}
      ${nobs.length ? `<p class="note warn">${t("water.people", { l: nobs.map(([id, n]) => `${esc(id)} (${n})`).join(", ") })} ${src("people")}</p>` : ""}
      ${added.length ? `<h3>${t("water.added")} ${src("input")}</h3><ul class="list">${added.map(id => `<li class="row"><div class="grow"><b>${esc(id)}</b></div>
        <div class="btns"><button class="btn btn-ghost btn-sm" data-rm="${id}">${ic("x")} ${t("water.remove")}</button></div></li>`).join("")}</ul>
        <p class="note">${t("water.effect", { a: fmt(J.hayTonnes(before.deficit_kg, S.P)), b: fmt(J.hayTonnes(S.pl.deficit_kg, S.P)), c: before.overloaded, d: S.pl.overloaded })}</p>${sim}` : ""}
      <p class="note">${t("water.note")}</p>${statusList}`;
    el.querySelectorAll("[data-add]").forEach(b => b.onclick = () => toggleWater(b.dataset.add, true));
    el.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => toggleWater(b.dataset.rm, false));
    el.querySelectorAll("[data-wc]").forEach(x => x.onchange = () => {
      const all = C.ls.get(wcKey(), {}) || {}, c = wcheck(x.dataset.wc), fld = x.dataset.f;
      c[fld] = fld === "cost" ? Math.max(0, Math.min(1e10, Math.round(+x.value || 0))) : x.value;
      if (c.right || c.source || c.cost) all[x.dataset.wc] = c; else delete all[x.dataset.wc];
      C.ls.set(wcKey(), all);
      const key = `[data-wc="${x.dataset.wc}"][data-f="${fld}"]`, y = el.scrollTop, y2 = scrollY, pp = el.parentElement.scrollTop;
      paneWater(el);
      const n = $(key, el); if (n) { n.closest("details").open = true; n.focus({ preventScroll: true }); }
      el.scrollTop = y; el.parentElement.scrollTop = pp; scrollTo(0, y2);
    });
  }

  function panePlots(el) {
    const obs = obsNow(), hasComp = S.plots.some(p => p.excluded_ha != null), hasNg = S.plots.some(p => p.nograze_ha != null);
    el.innerHTML = `<div class="tablewrap"><table class="plots-t"><thead><tr><th>${t("plots.id")}</th><th class="num">${t("plots.ha")}</th>${hasNg ? `<th class="num">${t("plots.nograze")}</th>` : ""}${hasComp ? `<th class="num">${t("plots.comp")}</th>` : ""}<th class="num">${t("plots.ndvi")}</th>
      <th class="num">${t("plots.cap")}</th><th class="num">${t("plots.load")}</th><th>${t("plots.quality")}</th><th>${t("plots.forage")}</th><th>${t("plots.water")}</th></tr></thead><tbody>
      ${S.plots.map(p => { const ld = S.pl.load[p.id], c = capOf(p);
        return `<tr data-plot="${p.id}" tabindex="0" style="cursor:pointer"><td class="pt-id"><b>${esc(p.id)}</b> ${p.water ? ic("drop") : ""}${p.forbidden ? ` <span class="tag tag-closed">${t("pop.closedTag")}</span>` : ""}${obs[p.id] && obs[p.id].verdict === "check" ? ` <span class="tag tag-check">${t("obs.check")}</span>` : ""}</td><td class="num" data-l="${esc(t("plots.ha"))}">${fmt(p.pasture_ha)}</td>
        ${hasNg ? `<td class="num" data-l="${esc(t("plots.nograze"))}">${p.nograze_ha != null ? fmt1(p.nograze_ha) : "—"}</td>` : ""}
        ${hasComp ? `<td class="num" data-l="${esc(t("plots.comp"))}">${fmt(p.excluded_ha || 0)} / ${fmt(p.uncertain_ha || 0)}</td>` : ""}
        <td class="num" data-l="${esc(t("plots.ndvi"))}">${p.ndvi ?? "—"}</td><td class="num" data-l="${esc(t("plots.cap"))}">${sheepCap(c)}</td>
        <td class="num pt-load" data-l="${esc(t("plots.load"))}"><span class="loadpill" style="${pillStyle(ld.known ? loadColor(ld.load) : loadColor(null))}">${!ld.known ? "?" : ld.used ? pct(ld.load) : "—"}</span></td><td data-l="${esc(t("plots.quality"))}">${confTag(p)}</td><td data-l="${esc(t("plots.forage"))}">${fcTag(p)}</td>
        <td class="pt-water" data-l="${esc(t("plots.water"))}" style="white-space:normal;min-width:110px"><small>${esc(wsLabel(p))}</small></td></tr>`; }).join("")}
      </tbody></table></div><p class="srcrow" style="margin-top:10px">${t("plots.ha")}, NDVI: ${src("sat")} &nbsp; ${t("plots.cap")}, ${t("plots.load")}: ${src("model")} &nbsp; ${t("plots.water")}: ${src("sat")} ${src("input")} ${src("model")}</p>
      <p class="fine">${t("plots.qualityNote")}</p>${hasNg ? `<p class="fine">${t("plots.nograzeNote", { b: S.ngBuf })} ${src("osm")}</p>` : ""}${hasComp ? `<p class="fine">${t("plots.compNote")}</p>` : ""}`;
    el.querySelectorAll("tr[data-plot]").forEach(r => {
      const go2 = () => { if (window.matchMedia("(max-width: 860px)").matches) window.scrollTo({ top: 0, behavior: "smooth" }); focusPlot(r.dataset.plot); };
      r.onclick = go2; r.onkeydown = e => { if (e.key === "Enter") go2(); };
    });
  }

  // ---------- прошлое лето: те же участки, то же окно июнь–август, считается в фоне для любого села ----------
  function loadPrev(key, data) {
    const year = data.source.year - 1, pk = key + ":prev:" + year;
    const done = season => {
      if (S.loadingKey !== key) return;
      S.prev = { year, state: season.status === "no_data" ? "none" : "ready", season };
      if (S.tab === "data") renderPane("data");
    };
    if (data.prev_season && data.prev_season.year === year) return done(data.prev_season);
    const hit = C.ls.get(pk, null);
    if (hit && hit.plots) return done(hit);
    if (!navigator.onLine || typeof PL.buildSeason !== "function") { S.prev = { year, state: "error" }; return; }   // офлайн или старый pipeline.js из кэша
    S.prev = { year, state: "loading" };
    PL.buildSeason({ lat: data.village.lat, lon: data.village.lon, year })
      .then(s => { C.ls.set(pk, s); done(s); })
      .catch(() => { if (S.loadingKey === key) { S.prev = { year, state: "error" }; if (S.tab === "data") renderPane("data"); } });
  }
  /** Сравнение «прошлое лето → это лето» по участкам (pipeline.compareSeasons), или null, пока прошлое лето не готово. */
  function prevCmp() {
    if (!S.D || !S.prev || S.prev.state !== "ready") return null;
    if (S.prev.cmpFor !== S.D) {
      S.prev.cmp = PL.compareSeasons({ year: S.D.source.year, dates: S.D.source.dates || [],
        plots: S.D.plots.map(p => ({ id: p.id, ndvi: p.ndvi, water_ha: p.water_obs_ha })) }, S.prev.season);
      S.prev.cmpFor = S.D;
    }
    return S.prev.cmp;
  }
  const signed = v => (v > 0 ? "+" : "") + v;
  function prevLine() {
    if (!S.prev) return "";
    const y = S.prev.year, c = prevCmp();
    if (!c) return `<p class="note">${S.prev.state === "loading" ? t("prev.loading", { y }) : S.prev.state === "none" ? t("prev.none", { y }) : t("prev.error", { y })}</p>`;
    const s = c.summary, w = s.water_total_ha;
    return `<p class="note${c.reliable ? "" : " warn"}">${t("prev.sum", { y, y2: S.D.source.year, c: s.ndvi_median_change_pct == null ? "—" : signed(s.ndvi_median_change_pct) + " %",
      g: s.greener, b: s.browner, s: s.same, t: c.threshold_pct })}${w[0] != null && w[1] != null ? " " + t("prev.water", { a: fmt1(w[0]), b: fmt1(w[1]) }) : ""} ${src("sat")}
      ${c.reliable ? "" : "<br>" + t("prev.unreliable")}</p>`;
  }
  function prevRow(p) {
    const c = prevCmp(), x = c && c.plots.find(q => q.id === p.id);
    if (!x || (x.ndvi[0] == null && x.water_ha[0] == null)) return "";
    const nd = x.ndvi[0] != null ? `NDVI ${x.ndvi[0]} → ${x.ndvi[1] ?? "?"}${x.ndvi_change_pct != null ? ` (${signed(x.ndvi_change_pct)} %)` : ""}` : "";
    const wa = x.water_ha[0] != null && x.water_ha[1] != null ? t("prev.waterPlot", { a: fmt1(x.water_ha[0]), b: fmt1(x.water_ha[1]) }) : "";
    return `<tr><td>${t("prev.row", { y: c.years[0] })}</td><td style="white-space:normal">${[nd, wa].filter(Boolean).join("; ")} ${src("sat")}</td></tr>`;
  }

  // ---------- трава по годам (P3): лето каждого года с 2019, осадки ERA5, Тейл — Сен, Манн — Кендалл, RESTREND (web/trend.js) ----------
  // примеры посчитаны заранее (scripts/build_example.js, add_multiyear.js); другое село — по кнопке (около 8 лет снимков, 1–2 минуты), результат в кэше браузера.
  const MULTI_FIRST = 2019;
  const TR = () => self.JaiylymTrend;
  const multiKey = (key, last) => key + ":multi:" + last;
  const multiOk = (m, last) => m && Array.isArray(m.seasons) && m.last === last;
  function loadMulti(key, data) {
    const last = data.source.year;
    if (multiOk(data.multiyear, last)) return setMulti(key, data.multiyear);
    const hit = C.ls.get(multiKey(key, last), null);
    if (multiOk(hit, last)) return setMulti(key, hit);
    S.multi = { state: "idle", last };
  }
  function setMulti(key, m) {
    if (S.loadingKey !== key) return;
    S.multi = { state: "ready", last: m.last, m, a: TR() ? TR().analyze(m.seasons, m.precip) : null };
    if (S.tab === "data") renderPane("data");
    // архив осадков был недоступен при расчёте — тихо пробуем ещё раз (один раз за открытие), иначе поправка на осадки не появится никогда
    if (!m.precip && navigator.onLine && !S.multi.precipTried && typeof PL.fetchPrecip === "function" && S.D) {
      S.multi.precipTried = true;
      const { lat, lon } = S.D.village, years = m.seasons.map(s => s.year);
      PL.fetchPrecip({ lat, lon, years }).then(precip => {
        if (S.loadingKey !== key || !precip) return;
        const m2 = Object.assign({}, m, { precip });
        if (!S.D.multiyear) C.ls.set(multiKey(key, m.last), m2);
        setMulti(key, m2);
      }).catch(() => {});
    }
  }
  async function runMulti() {
    if (!S.D || !TR() || typeof PL.buildYears !== "function" || (S.multi && S.multi.state === "loading")) return;
    if (!navigator.onLine) { toast(t("err.offline"), true); return; }
    const key = S.loadingKey, D = S.D, last = D.source.year, { lat, lon } = D.village;
    const years = Array.from({ length: last - MULTI_FIRST + 1 }, (_, i) => MULTI_FIRST + i);
    // это лето уже посчитано (S.D), прошлое — тоже, если готово: их не качаем заново
    const have = { [last]: { year: last, status: (D.meta && D.meta.data_status) || "measured", dates: D.source.dates || [], window: D.source.window || null,
      plots: D.plots.map(p => ({ id: p.id, ndvi: p.ndvi, valid_fraction: p.valid_fraction ?? 1 })) } };
    if (S.prev && S.prev.state === "ready" && S.prev.season) have[S.prev.year] = S.prev.season;
    S.multi = { state: "loading", last };
    if (S.tab === "data") renderPane("data");
    const prog = i => { const el = $("#multiProg"); if (el && S.loadingKey === key) el.textContent = t("mt.loading", { a: i + 1, n: years.length }); };
    try {
      const [seasons, precip] = await Promise.all([
        PL.buildYears({ lat, lon, years, have, onProgress: ({ i }) => prog(i) }),
        PL.fetchPrecip({ lat, lon, years }).catch(() => null)]);
      const m = { first: MULTI_FIRST, last, calculated_at: new Date().toISOString(), precip,
        seasons: seasons.map(s => ({ year: s.year, status: s.status, dates: s.dates, window: s.window || null, valid_fraction: s.valid_fraction,
          plots: s.plots.map(p => ({ id: p.id, ndvi: p.ndvi, valid_fraction: p.valid_fraction })) })) };
      if (S.loadingKey !== key) return;
      C.ls.set(multiKey(key, last), m);
      setMulti(key, m);
    } catch (e) {
      if (S.loadingKey === key) { S.multi = { state: "error", last, msg: e.message }; if (S.tab === "data") renderPane("data"); }
    }
  }
  const pTxt = p => (p < 0.01 ? "< 0.01" : p.toFixed(2));
  const slopeTxt = s => `${s.slope_per_year >= 0 ? "+" : "−"}${Math.abs(s.slope_per_year).toFixed(4)}`;
  // наклон и p — того ряда, по которому сделан вывод (NDVI или NDVI с учётом осадков); у участков p с поправкой на 16 проверок
  const basisOf = s => (s.basis === "resid" && s.resid ? { sl: s.resid, p: s.resid.p_adj ?? s.resid.p } : { sl: s, p: s.p_adj ?? s.p });
  function verdictText(s) {
    if (!s || s.verdict === "few_years") return t("mt.v.few_years", { n: s ? s.n : 0, min: TR().MIN_YEARS });
    const b = basisOf(s), resid = s.verdict === "decline_unexplained" && s.basis === "resid";
    return t(resid ? "mt.v.decline_resid" : "mt.v." + s.verdict, { n: s.n, s: slopeTxt(b.sl), p: pTxt(b.p) });
  }
  /** График: медиана NDVI участков по годам (годы вне ряда — пустые точки), осадки — столбики, пунктир — тренд Тейла — Сена. */
  function multiChart(a) {
    const ys = a.years, n = ys.length, W = 320, H = 150, L = 34, R = 8, T = 10, B = 24;
    const vals = ys.map(y => y.ndvi_median).filter(v => v != null);
    if (n < 2 || !vals.length) return "";
    const lo = Math.min(...vals) - 0.02, hi = Math.max(...vals) + 0.02, pmax = Math.max(1, ...ys.map(y => y.precip_mm || 0));
    const X = i => L + i * (W - L - R) / (n - 1), Y = v => T + (hi - v) / (hi - lo) * (H - T - B);
    const bars = ys.map((y, i) => y.precip_mm == null ? "" : (h => `<rect x="${(X(i) - 7).toFixed(1)}" y="${(H - B - h).toFixed(1)}" width="14" height="${h.toFixed(1)}" rx="2" fill="var(--water-soft)"><title>${y.year}: ${y.precip_mm} ${t("wx.mm")}</title></rect>`)((y.precip_mm / pmax) * (H - T - B) * 0.6)).join("");
    const ok = ys.map((y, i) => [y, i]).filter(([y]) => y.ok && y.ndvi_median != null);
    const line = ok.length > 1 ? `<polyline points="${ok.map(([y, i]) => `${X(i).toFixed(1)},${Y(y.ndvi_median).toFixed(1)}`).join(" ")}" fill="none" stroke="var(--primary-2)" stroke-width="2"/>` : "";
    const v = a.village, trend = v.verdict !== "few_years" && v.slope_per_year != null
      ? `<line x1="${X(0)}" y1="${Y(v.intercept + v.slope_per_year * ys[0].year).toFixed(1)}" x2="${X(n - 1)}" y2="${Y(v.intercept + v.slope_per_year * ys[n - 1].year).toFixed(1)}" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="5 4"/>` : "";
    const dots = ys.map((y, i) => y.ndvi_median == null ? "" : `<circle cx="${X(i).toFixed(1)}" cy="${Y(y.ndvi_median).toFixed(1)}" r="4" fill="${y.ok ? "var(--primary-2)" : "var(--surface)"}" stroke="var(--primary-2)" stroke-width="1.6"><title>${y.year}: NDVI ${y.ndvi_median}${y.mid_date ? ", " + y.mid_date.split("-").reverse().join(".") : ""}</title></circle>`).join("");
    const xl = ys.map((y, i) => `<text x="${X(i).toFixed(1)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="var(--muted)">'${String(y.year).slice(2)}</text>`).join("");
    const yl = `<text x="${L - 4}" y="${T + 8}" font-size="10" text-anchor="end" fill="var(--muted)">${hi.toFixed(2)}</text><text x="${L - 4}" y="${H - B}" font-size="10" text-anchor="end" fill="var(--muted)">${lo.toFixed(2)}</text>`;
    return `<svg class="mt-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t("mt.title"))}">${bars}${trend}${line}${dots}${xl}${yl}</svg>
      <p class="mt-legend"><span><span class="sw sw-line"></span>${t("mt.ndvi")}</span><span><span class="sw sw-bar"></span>${t("mt.pr")}</span><span><span class="sw sw-dash"></span>${t("mt.trend")}</span></p>`;
  }
  function multiHtml() {
    const M = S.multi;
    if (!M || !S.D) return "";
    const head = `<h3>${ic("chart")} ${t("mt.title")}</h3>`;
    const n = M.last - MULTI_FIRST + 1;
    if (M.state === "idle") return `<div class="mt">${head}<p class="fine">${t("mt.idle", { a: MULTI_FIRST, b: M.last })}</p>
      <button type="button" class="btn btn-soft btn-sm" id="multiRun">${ic("sat")} ${t("mt.run", { n })}</button></div>`;
    if (M.state === "loading") return `<div class="mt">${head}<p class="fine" id="multiProg" role="status">${t("mt.loading", { a: 1, n })}</p></div>`;
    if (M.state === "error") return `<div class="mt">${head}<p class="note warn">${t("mt.error", { m: esc(M.msg || "") })}</p>
      <button type="button" class="btn btn-soft btn-sm" id="multiRun">${t("mt.retry")}</button></div>`;
    const a = M.a;
    if (!a) return "";
    const v = a.village, out = a.years.filter(y => !y.ok);
    const rain = v.rain ? t("mt.rain", { r2: v.rain.r2.toFixed(2), use: v.rain.valid ? t("mt.rainUsed") : t("mt.rainWeak") }) : t("mt.noRain");
    const groups = {};
    for (const [id, s] of Object.entries(a.plots)) (groups[s.verdict] = groups[s.verdict] || []).push(id);
    const order = ["decline_unexplained", "decline_rain", "increase", "no_change", "few_years"];
    const rows = a.years.map(y => `<tr><td>${y.year}</td><td class="num">${y.ndvi_median ?? "—"}</td><td class="num">${y.precip_mm ?? "—"}</td>
      <td>${y.dates}${y.mid_date ? ` · ${y.mid_date.split("-").reverse().join(".")}` : ""}</td><td>${y.ok ? t("how.yes") : t("mt.r." + y.reason)}</td></tr>`).join("");
    return `<div class="mt">${head}
      <p class="mt-verdict ${v.verdict === "decline_unexplained" ? "warn" : ""}">${verdictText(v)} ${src("sat")}</p>
      ${multiChart(a)}
      <p class="fine">${rain}${out.length ? " " + t("mt.excluded", { list: out.map(y => `${y.year} — ${t("mt.r." + y.reason)}`).join(", ") }) : ""}</p>
      <p class="mt-plots">${order.filter(k => groups[k]).map(k => `<span class="mt-g mt-${k}"><b>${t("mt.s." + k)}</b>: ${groups[k].length > 8 ? groups[k].length : plotIds(groups[k])}</span>`).join(" ")}</p>
      <details class="more"><summary>${t("mt.table")}</summary><div class="tablewrap"><table class="mt-t"><thead><tr><th>${t("mt.th.year")}</th><th class="num">NDVI</th><th class="num">${t("mt.th.pr")}</th><th>${t("mt.th.dates")}</th><th>${t("mt.th.used")}</th></tr></thead>
        <tbody>${rows}</tbody></table></div></details>
      <p class="fine">${t("mt.lim")}</p></div>`;
  }
  function multiRow(p) {
    const M = S.multi, s = M && M.state === "ready" && M.a && M.a.plots[p.id];
    if (!s) return "";
    const b = basisOf(s), pp = pTxt(b.p);
    const val = s.verdict === "few_years" ? t("mt.s.few_years") : `${t("mt.s." + s.verdict)} (${slopeTxt(b.sl)} ${t("mt.perYear")}${s.basis === "resid" ? " " + t("mt.withRain") : ""}, p ${pp.startsWith("<") ? pp : "= " + pp})`;
    return `<tr><td>${t("mt.row", { a: MULTI_FIRST, b: M.last })}</td><td style="white-space:normal">${val} ${src("sat")}</td></tr>`;
  }

  function trendLine() {
    if (!S.D.source.base_year) return "";
    const avg = ring => { const xs = S.D.plots.filter(p => p.ring === ring && p.ndvi != null && p.ndvi_base != null); return xs.reduce((a, p) => a + p.ndvi - p.ndvi_base, 0) / xs.length; };
    const f = x => (x >= 0 ? "+" : "") + x.toFixed(3);
    return t("data.trend", { a: S.D.source.base_year, b: S.D.source.year, n: f(avg("near")), f: f(avg("far")) });
  }
  function metaHtml(meta) {
    const row = (k, v) => `<tr><td>${t("meta." + k)}</td><td style="white-space:normal">${v}</td></tr>`;
    return `<div class="tablewrap"><table><tbody>
      ${row("source", esc(meta.source))}${row("dataset", esc(meta.dataset))}${row("year", meta.year ?? "—")}
      ${row("dates", meta.scene_dates.map(d => dateStr(d, false)).join(", ") || "—")}${row("count", meta.imagery_count)}
      ${row("valid", meta.valid_pixel_fraction == null ? t("meta.notRecorded") : pct(meta.valid_pixel_fraction))}
      ${row("lc", esc(meta.landcover_source) + (meta.landcover_year ? ", " + meta.landcover_year : ""))}
      ${row("calc", meta.calculated_at ? dateStr(meta.calculated_at) : t("meta.unknownDate"))}${row("model", esc(meta.model_version))}
      ${row("status", t("meta." + meta.data_status) )}
      ${meta.warnings.length ? row("warn", meta.warnings.map(w => esc(metaWarn(w))).join("<br>")) : ""}</tbody></table></div>`;
  }
  function paneData(el) {
    const s = S.D.source, counts = { high: 0, medium: 0, low: 0, none: 0 };
    S.plots.forEach(p => counts[confidence(p)]++);
    const meta = M.metaOf(S.D);
    const days = meta.calculated_at ? (Date.now() - Date.parse(meta.calculated_at)) / 864e5 : null;
    el.innerHTML = `<div class="srcblock s-sat"><h3>${src("sat")} ${t("data.sat.t")}</h3>
        <p>${t("data.village")}: <b>${esc(S.D.village.name)}</b> (${S.D.village.lat}, ${S.D.village.lon}). ${t("data.year")}: <b>${s.year}</b>.<br>
        ${t("data.scenes")} (${s.dates.length}): ${s.dates.slice().sort().join(", ")}.</p>
        <p style="margin-top:8px">${t("plots.quality")}: <span class="conf conf-high">${t("conf.high")} ${counts.high}</span> <span class="conf conf-medium">${t("conf.medium")} ${counts.medium}</span> <span class="conf conf-low">${t("conf.low")} ${counts.low}</span> <span class="conf conf-none">${t("conf.none")} ${counts.none}</span></p>
        <p class="fine">${t("fc.note")}</p>
        ${trendLine() ? `<p class="note">${trendLine()}</p>` : ""}
        ${prevLine()}
        ${multiHtml()}
        ${S.fromCache ? `<p class="note warn">${t("meta.cached", { d: meta.calculated_at ? dateStr(meta.calculated_at, false) : t("meta.unknownDate") })}</p>` : ""}
        ${days != null && days > 30 ? `<p class="note warn">${t("meta.stale", { n: Math.round(days) })}</p>` : ""}
        <h3>${t("meta.title")}</h3>${metaHtml(meta)}</div>
      ${normHtml()}
      ${noGrazeHtml()}
      <div class="srcblock s-input"><h3>${src("input")} ${t("data.input.t")}</h3><p>${t("data.input.d")}</p></div>
      <div class="srcblock s-model"><h3>${src("model")} ${t("data.model.t")}</h3><p>${t("data.model.d")}</p></div>
      <div class="srcblock"><h3>${ic("wifioff")} ${t("off.title")}</h3><p>${t("off.d")}</p></div>
      <p><a href="#/data">${t("nav.data")}</a></p>`;
    const mr = $("#multiRun", el); if (mr) mr.onclick = runMulti;
    const nmR = $("#nmRegion", el), nmT = $("#nmRow", el), nmS = $("#nmState", el);
    if (nmR) nmR.onchange = () => setNorm({ region: nmR.value, state: (S.normSel || {}).state });
    if (nmT) nmT.onchange = () => setNorm({ region: S.normSel.region, row: nmT.value || undefined, state: S.normSel.state });
    if (nmS) nmS.onchange = () => setNorm({ region: S.normSel.region, row: S.normSel.row, state: nmS.value });
    const nb = $("#ngBuf", el);
    if (nb) nb.onchange = () => { S.ngBuf = +nb.value; C.ls.set("jaiylym:ngbuf", S.ngBuf); rebuildPlots(); render(); };
    const nr = $("#ngRetry", el);
    if (nr) nr.onclick = () => { loadNoGraze(cacheKey(S.D.village.lat, S.D.village.lon), S.D, true); renderPane("data"); };
  }
  /** Вкладка «Данные»: норма нагрузки — область, тип пастбища, состояние, сравнение со снимком. */
  function normHtml() {
    if (!NM) return "";
    const sel = S.normSel, n = NM.pick(sel), head = `<div class="srcblock s-norm" id="normBox"><h3>${src("norm")} ${t("nm.title")}</h3><p>${t("nm.lead")}</p>`;
    const regSel = `<label class="field">${t("nm.region")} ${src("input")}<select id="nmRegion"><option value="">${t("nm.regionNone")}</option>${NM.REGIONS.map(r => `<option value="${r.id}" ${sel && sel.region === r.id ? "selected" : ""}>${esc(regName(r.id))}</option>`).join("")}</select></label>`;
    const foot = `<p class="fine">${t("nm.limits")} <a href="${NM.SOURCE.url}" target="_blank" rel="noopener">${esc(t("nm.source"))}</a></p></div>`;
    if (!n) return head + `<p class="note warn">${t(S.normState === "loading" ? "nm.loading" : "nm.noRegion")}</p>${regSel}` + foot;
    const ha = x => fmt2(x * S.P.au.sheep), days = d => (d ? `, ${d[0]}–${d[1]} ${t("nm.days")}` : "");
    const groups = {};
    for (const r of NM.rows(sel.region)) (groups[[r.zone, r.subzone].filter(Boolean).join(" · ")] = groups[[r.zone, r.subzone].filter(Boolean).join(" · ")] || []).push(r);
    const soft = NM.pick({ region: sel.region, state: n.state }), tot = normTotals(S.plots);
    return head + `<div class="formgrid nmform">${regSel}
      <label class="field">${t("nm.state")} ${src("input")}<select id="nmState">${NM.STATES.map(s => `<option value="${s}" ${n.state === s ? "selected" : ""}>${t(s === "degraded" ? "nm.degraded" : "nm.restored")}</option>`).join("")}</select></label>
      <label class="field span2">${t("nm.type")} ${src("input")}<select id="nmRow"><option value="">${esc(t("nm.soft", { n: ha(soft.au_ha) }))}</option>
        ${Object.entries(groups).map(([g, rs]) => `<optgroup label="${esc(g)}">${rs.map(r => `<option value="${r.key}" ${sel.row === r.key ? "selected" : ""}>${esc(r.type)} — ${ha(r.au_ha[n.state])} ${t("nm.haSheep")}${days(r.days)}</option>`).join("")}</optgroup>`).join("")}</select></label></div>
      <p><b>${t("nm.sum", { sat: fmt(tot.sat), norm: fmt(tot.norm), cap: fmt(tot.cap) })}</b> ${t("nm.sumK", { k: tot.limited, n: tot.n })}</p>
      ${n.days && S.P.season_days > n.days[1] ? `<p class="note">${t("nm.season", { a: n.days[1], b: S.P.season_days })}</p>` : ""}` + foot;
  }
  /** Вкладка «Данные»: где нельзя пасти — источник, сколько зон, площадь по участкам, буфер. */
  function noGrazeHtml() {
    const ng = S.D.nograze, st = ng ? ng.status : S.ngState;
    const head = `<div class="srcblock s-osm"><h3>${src("osm")} ${t("ng.title")}</h3>`;
    if (!ng || st === "loading") return head + `<p>${st === "offline" ? t("ng.offline") : t("ng.loading")}</p></div>`;
    if (st === "error") return head + `<p class="note warn">${t("ng.error")}: ${esc(ng.error || "")}</p><button class="btn btn-ghost btn-sm" id="ngRetry">${t("ng.retry")}</button></div>`;
    const tot = S.plots.reduce((s, p) => s + (p.nograze_ha || 0), 0), gross = S.plots.reduce((s, p) => s + (p.pasture_ha_gross ?? p.pasture_ha), 0);
    const c = ng.counts || {};
    return head + `<p>${st === "empty" ? t("ng.none") : t("ng.sum", { t: fmt1(tot), g: fmt(gross), p: gross ? Math.round(tot / gross * 100) : 0,
        s: c.settlement || 0, f: c.farm || 0, i: c.industrial || 0, o: c.other || 0 })}</p>
      <label class="field" style="max-width:320px">${t("ng.buffer")}<select id="ngBuf">${(ng.buffers || NG.BUFFERS).map(b => `<option value="${b}" ${+S.ngBuf === b ? "selected" : ""}>${b} м</option>`).join("")}</select></label>
      <p class="fine">${t("ng.note")} ${c.points ? t("ng.points", { n: c.points }) : ""} ${ng.osm_timestamp ? t("ng.date", { d: dateStr(ng.osm_timestamp, false) }) : ""}</p></div>`;
  }

  // ---------- «Что если?»: варианты рядом, на одном экране ----------
  function variantName(v) {
    if (v.type === "add_water") return t("wi.v.well", { id: esc(v.plot) });
    if (v.type === "exclude_plot") return t("wi.v.exclude", { id: esc(v.plot) });
    if (v.type === "params") return t("wi.v." + v.name);
    if (v.type === "algorithm") return t("wi.v.algo." + v.name);
    return t("wi.v." + v.id);
  }
  const violText = v => t("vt." + v.type, { id: esc(v.plot || "") });
  function paneWhatIf(el) {
    if (!S.herds.length) { el.innerHTML = `<p class="empty">${t("ov.noherds")}</p>`; return; }
    let rows;
    const wopts = { algorithm: S.algo };
    try { rows = J.compareScenarios(S.plots, S.herds, S.P, J.defaultVariants(S.plots, S.herds, S.P, wopts), wopts); }
    catch (e) { el.innerHTML = `<p class="note warn">${esc(e.message)}</p>`; return; }
    const plan = rows.find(r => r.id === "plan");
    const dT = r => J.hayTonnes(r.deficit_kg, r.result && r.result.kind ? S.P : S.P);
    const tr = rows.map(r => r.error ? `<tr><td>${variantName(r)}</td><td colspan="5">${t("wi.err")}: ${esc(r.error)}</td></tr>` : `<tr class="${r.id === "plan" ? "wi-base" : ""}">
      <td><b>${variantName(r)}</b>${r.status && r.type !== "current" ? `<br><small>${t("wi.st." + r.status)}</small>` : ""}</td>
      <td class="num">${fmt(dT(r))}${r.id !== "plan" && plan ? `<br><small class="${dT(r) > dT(plan) + 0.5 ? "worse" : dT(r) < dT(plan) - 0.5 ? "better" : ""}">${dT(r) - dT(plan) >= 0 ? "+" : ""}${fmt(dT(r) - dT(plan))}</small>` : ""}</td>
      <td class="num">${r.overloaded}</td><td class="num">${r.type === "current" ? "—" : r.herds_full}</td><td class="num">${r.type === "current" ? "—" : r.herds_short}</td>
      <td class="num">${r.min_share == null ? "—" : pct(r.min_share)}</td>
      <td style="white-space:normal;min-width:120px"><small>${r.violations.length ? r.violations.slice(0, 4).map(violText).join(", ") + (r.violations.length > 4 ? " …" : "") : t("wi.violNone")}</small></td></tr>`).join("");
    // чувствительность и сценарии допущений
    const sens = (key, a, b) => {
      const s2 = J.sensitivity(S.plots, S.herds, S.P, key, [a, b], { algorithm: S.algo });
      if (s2.some(x => x.error)) return "";
      const c0 = s2[0].capacity_sheep, c1 = s2[1].capacity_sheep;
      return t(key === "util" ? "wi.sensUtil" : "wi.sensK", { a, b, c: fmt(c0), d: fmt(c1), p: (c0 ? ((c1 / c0 - 1) * 100).toFixed(0) : "0") + " %" });
    };
    const ass = ["cautious", "base", "optimistic"].map(n => {
      const pp = M.scenarioParams(S.P, n);
      const cap = J.totalCapacity(S.plots, pp).au_season / pp.au.sheep;
      const pl2 = solve(S.plots, S.herds, pp);
      return `<tr><td><b>${t("wi.a." + n)}</b><br><small>util ${pp.util}, k_ndvi ${pp.k_ndvi}</small></td><td class="num">${fmt(cap)}</td><td class="num">${fmt(J.hayTonnes(pl2.deficit_kg, pp))}</td></tr>`;
    }).join("");
    const b = S.pl.bound;
    el.innerHTML = `<h3>${ic("layers")} ${t("wi.title")} ${src("model")}</h3>
      <div class="tablewrap"><table class="wi"><thead><tr><th>${t("wi.c.variant")}</th><th class="num">${t("wi.c.deficit")}</th><th class="num">${t("wi.c.over")}</th>
        <th class="num">${t("wi.c.full")}</th><th class="num">${t("wi.c.short")}</th><th class="num">${t("wi.c.minShare")}</th><th>${t("wi.c.viol")}</th></tr></thead><tbody>${tr}</tbody></table></div>
      <p class="note">${t(S.algo === "greedy" ? "wi.noteGreedy" : "wi.noteOpt")}</p>
      ${normTotals(S.plots).limited ? `<p class="note">${t("nm.whatif", { k: normTotals(S.plots).limited })} ${src("norm")}</p>` : ""}
      <p class="fine">${t("wi.bound", { b: fmt(J.hayTonnes(b.min_deficit_au_days * S.P.intake, S.P)), g: fmt(J.hayTonnes(S.pl.deficit_kg, S.P)), d: fmt(J.hayTonnes(S.pl.gap_au_days * S.P.intake, S.P)) })}</p>
      <h3>${ic("chart")} ${t("wi.sens")}</h3><p>${sens("util", 0.5, 0.4)}</p><p>${sens("k_ndvi", S.P.k_ndvi, Math.round(S.P.k_ndvi * 0.75))}</p>
      <h3>${t("wi.assump")}</h3><div class="tablewrap"><table><thead><tr><th></th><th class="num">${t("wi.c.cap")}</th><th class="num">${t("wi.c.deficit")}</th></tr></thead><tbody>${ass}</tbody></table></div>
      <p class="fine">${t("wi.assumpNote")}</p>`;
  }

  // ---------- исследование: шаблон интервью и пилотные показатели (только этот браузер, без вымышленных ответов) ----------
  const RS_KEY = "jaiylym:interviews";
  const RS_Q = ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9"];
  function renderResearch() {
    const list = C.ls.get(RS_KEY, []) || [];
    const m = C.ls.get("jaiylym:metrics", null) || { plans: 0, feasible: 0, saved: 0, pdf: 0, completed: 0, times: [], last: null };
    const med = xs => { if (!xs || !xs.length) return null; const a = xs.slice().sort((x, y) => x - y), k = a.length >> 1; return a.length % 2 ? a[k] : (a[k - 1] + a[k]) / 2; };
    const L = m.last || {};
    $("#rsPage").innerHTML = `<div class="card"><h2>${ic("users")} ${t("rs.title")}</h2><p>${t("rs.lead")}</p>
        <p><b>${t("rs.count", { n: list.length })}</b>${list.length ? "" : " · " + t("rs.none")}</p>
        <p class="note warn">${t("rs.noPersonal")}</p></div>
      <form class="card" id="rsForm"><h2>${t("rs.new")}</h2>
        <div class="formgrid"><label class="field">${t("rs.role")}<select name="role"><option value="farmer">${t("rs.role.farmer")}</option><option value="akimat">${t("rs.role.akimat")}</option><option value="other">${t("rs.role.other")}</option></select></label>
          <label class="field span2">${t("rs.village")}<input name="village" maxlength="60"></label>
          <label class="field">${t("rs.date")}<input name="date" type="date" required></label></div>
        ${RS_Q.map(q => `<label class="field" style="margin-top:8px">${t("rs." + q)}<textarea name="${q}" rows="2" maxlength="1000"></textarea></label>`).join("")}
        <label class="check" style="margin-top:10px"><input type="checkbox" name="consent"> ${t("rs.consent")}</label>
        <p style="margin-top:12px"><button class="btn btn-primary btn-sm">${t("rs.save")}</button></p></form>
      <div class="card"><p style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-soft btn-sm" id="rsJson" ${list.length ? "" : "disabled"}>${t("rs.export")}</button>
        <button class="btn btn-soft btn-sm" id="rsCsv" ${list.length ? "" : "disabled"}>${t("rs.exportCsv")}</button>
        <button class="btn btn-ghost btn-sm" id="rsClear" ${list.length ? "" : "disabled"}>${t("rs.clear")}</button></p></div>
      <div class="card"><h2>${ic("chart")} ${t("rs.metrics")}</h2><p class="fine">${t("rs.metricsNote")}</p>
        <dl class="kv"><dt>${t("m.plans")}</dt><dd>${m.plans}</dd><dt>${t("m.scenarios")}</dt><dd>${m.saved}</dd>
          <dt>${t("m.herdsInPlan")}</dt><dd>${L.herds ?? "—"}</dd><dt>${t("m.feasibleShare")}</dt><dd>${m.plans ? pct(m.feasible / m.plans) : "—"}</dd>
          <dt>${t("m.deficit")}</dt><dd>${L.before_t != null ? fmt1(L.before_t) + " → " + fmt1(L.after_t) : "—"}</dd><dt>${t("m.over")}</dt><dd>${L.overloaded ?? "—"}</dd>
          <dt>${t("m.missing")}</dt><dd>${L.missing ?? "—"}</dd><dt>${t("m.time")}</dt><dd>${med(m.times) ?? "—"}</dd><dt>${t("m.completed")}</dt><dd>${m.completed}</dd></dl>
        <button class="btn btn-soft btn-sm" id="rsMetrics">${t("m.export")}</button></div>`;
    const dl = (name, text, type) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
    // обезличивание: без названия села и даты дня — только роль, месяц, ответы (свободный текст человек заполняет без ФИО)
    const anon = () => (C.ls.get(RS_KEY, []) || []).map((x, i) => Object.assign({ n: i + 1, role: x.role, month: (x.date || "").slice(0, 7) }, Object.fromEntries(RS_Q.map(q => [q, x[q] || ""]))));
    $("#rsForm").onsubmit = ev => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      if (fd.get("consent") !== "on") { toast(t("rs.needConsent"), true); return; }
      const rec = { role: fd.get("role"), village: String(fd.get("village") || "").trim(), date: fd.get("date"), saved: new Date().toISOString() };
      for (const q of RS_Q) rec[q] = String(fd.get(q) || "").trim();
      if (RS_Q.every(q => !rec[q])) { toast(t("rs.empty"), true); return; }
      C.ls.set(RS_KEY, (C.ls.get(RS_KEY, []) || []).concat([rec]));
      toast(t("rs.saved")); renderResearch();
    };
    $("#rsJson").onclick = () => dl("jaiylym-interviews-anon.json", JSON.stringify(anon(), null, 2), "application/json");
    $("#rsCsv").onclick = () => { const rows = anon(); const cols = ["n", "role", "month"].concat(RS_Q);
      dl("jaiylym-interviews-anon.csv", [cols.join(",")].concat(rows.map(r => cols.map(c => '"' + String(r[c]).replace(/"/g, '""') + '"').join(","))).join("\n"), "text/csv"); };
    let armed = false;
    $("#rsClear").onclick = e => { if (!armed) { armed = true; e.currentTarget.textContent = t("past.delConfirm"); return; } C.ls.del(RS_KEY); renderResearch(); };
    $("#rsMetrics").onclick = () => dl("jaiylym-pilot-metrics.json", JSON.stringify(Object.assign({ note: t("rs.metricsNote") }, m, { lastKey: undefined }), null, 2), "application/json");
  }

  // ---------- сценарии ----------
  function scenarioPayload(name, shared) {
    return { name, shared: !!shared, village: S.D.village, request_id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10),
      herds: S.herds.filter(h => !h.from_bot).map(h => ({ id: h.id, name: h.name, sheep: h.sheep || 0, goats: h.goats || 0, cattle: h.cattle || 0, horses: h.horses || 0,
        home: h.home, daily_return: !!h.daily_return, allowed_plots: h.allowed_plots || [], demo: !!h.demo, weight: +h.weight || 1 })),
      water: [...S.added], forbidden: [...S.forbidden], water_status: Object.assign({}, S.waterSet), params: Object.assign({}, S.userP),
      rest: Object.assign({}, S.rest || {}), norm: S.normSel || undefined, zone: S.zone || undefined, summary: summary() };
  }
  async function saveScenario(shared) {
    if (!S.D) return;
    const name = await askText(t("act.namePrompt"), `${S.D.village.name}, ${dateStr(new Date(), false)}`);
    if (!name) return;
    try {
      await C.saveScenario(scenarioPayload(name, shared));
      toast(shared ? t("act.published") : C.loggedIn ? t("act.saved") : t("act.savedLocal"));
      metric("saved");
      C.addHistory({ kind: shared ? "publish" : "save", village: S.D.village, summary: summary() });
    } catch (e) { toast(errText(e), true); }
  }
  function loadScenario(sc) {
    // сценарий применяется при открытии карты (onRoute) — так не бывает двух параллельных загрузок
    S.pending = { key: cacheKey(sc.village.lat, sc.village.lon), opts: { herds: (sc.herds || []).map(h => Object.assign({}, h, { allowed_plots: (h.allowed_plots || []).length ? h.allowed_plots : undefined })),
      water: sc.water || [], forbidden: sc.forbidden || [], water_status: sc.water_status || {}, rest: sc.rest || {}, zone: sc.zone || null, norm: sc.norm || null, params: sc.params || null } };
    const h = `#/map?lat=${sc.village.lat}&lon=${sc.village.lon}&name=${encodeURIComponent(sc.village.name)}`;
    if (location.hash === h) onRoute(); else location.hash = h;
  }
  const errText = e => (e && e.message === "offline" ? t("err.offline") : e && e.message === "network" ? t("err.server") : (e && e.message) || t("err.server"));
  const when = s => dateStr(s);
  const kindLabel = k => t("hist." + k) === "hist." + k ? k : t("hist." + k);
  const sumLine = s => (s ? `${t("kpi.overloaded")}: ${s.overloaded_before} → ${s.overloaded_after}; ${t("kpi.excess")}: ${fmt(s.excess_t || 0)} → ${fmt(s.deficit_t || 0)}` : "");

  async function renderScenarios() {
    const el = $("#scPage");
    el.innerHTML = `<div class="card"><p class="empty">…</p></div>`;
    let sc, hist;
    try { [sc, hist] = await Promise.all([C.listScenarios(), C.listHistory()]); }
    catch (e) { el.innerHTML = `<div class="card"><p class="empty">${esc(errText(e))}</p></div>`; return; }
    const row = (s, canDel) => `<li class="row"><div class="grow"><b>${esc(s.name)}</b><small>${esc(s.village.name)} · ${when(s.created)} · ${(s.herds || []).length} ${t("sc.herds")} · ${(s.water || []).length} ${t("sc.water")}${s.ownerName && s.shared ? " · " + esc(s.ownerName) : ""}</small><small>${sumLine(s.summary)}</small></div>
      <div class="btns"><button class="btn btn-soft btn-sm" data-load="${esc(s.id)}">${t("sc.load")}</button>${canDel ? `<button class="btn btn-ghost btn-sm" data-del="${esc(s.id)}" aria-label="${t("sc.del")}">${ic("trash")}</button>` : ""}</div></li>`;
    const all = (sc.own || []).concat(sc.shared || []);
    el.innerHTML = `${!C.loggedIn ? `<p class="note warn">${t("sc.guestNote")}</p>` : ""}
      <div class="card"><h2>${ic("layers")} ${t("sc.own")}</h2>${(sc.own || []).length ? `<ul class="list">${sc.own.map(s => row(s, true)).join("")}</ul>` : `<p class="empty">${t("sc.empty")}</p>`}</div>
      ${C.loggedIn ? `<div class="card"><h2>${ic("users")} ${t("sc.shared")}</h2>${(sc.shared || []).length ? `<ul class="list">${sc.shared.map(s => row(s, C.user && s.owner === C.user.uid)).join("")}</ul>` : `<p class="empty">${t("sc.sharedEmpty")}</p>`}</div>` : ""}
      <div class="card"><h2>${ic("clock")} ${t("sc.history")}</h2>${(hist || []).length ? `<ul class="list">${hist.slice(0, 30).map((h, i) => `<li class="row"><div class="grow"><b>${esc(h.village.name)}</b><small>${when(h.at)} · ${esc(kindLabel(h.kind))}</small><small>${sumLine(h.summary)}</small></div>
        <div class="btns"><button class="btn btn-ghost btn-sm" data-hist="${i}">${t("sc.load")}</button></div></li>`).join("")}</ul>` : `<p class="empty">${t("sc.histEmpty")}</p>`}</div>`;
    el.querySelectorAll("[data-load]").forEach(b => b.onclick = () => { const s = all.find(x => x.id === b.dataset.load); if (s) loadScenario(s); });
    el.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
      try { await C.deleteScenario(b.dataset.del); renderScenarios(); } catch (e) { toast(errText(e), true); }
    });
    el.querySelectorAll("[data-hist]").forEach(b => b.onclick = () => { const h = hist[+b.dataset.hist]; go("map", `lat=${h.village.lat}&lon=${h.village.lon}&name=${encodeURIComponent(h.village.name)}`); });
  }

  // ---------- вход ----------
  // Два равноправных способа: логин и пароль (регистрация на сайте) или Telegram (без пароля, с уведомлениями в боте).
  let pollTimer = null;
  const spin = `<span class="spin" style="width:16px;height:16px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite"></span>`;
  function acctErr(e) {
    if (e && (e.message === "offline" || e.message === "network")) return e.message === "offline" ? t("err.offline") : t("login.fail");
    if (e && e.status === 409) return t("acct.e.taken");
    if (e && e.status === 401) return t("acct.e.bad");
    if (e && e.status === 429) return t("acct.e.many");
    if (e && e.status === 400) return t({ password: "acct.e.password", name: "acct.e.name" }[e.field] || "acct.e.login");
    return errText(e);
  }
  function openLogin(mode) {
    const dlg = $("#loginDlg"), body = $("#loginBody");
    clearTimeout(pollTimer);
    const reg = mode === "register";
    $("#loginTitle").textContent = t("acct.title");
    body.innerHTML = `<div class="seg acct-tabs" role="tablist" aria-label="${t("acct.title")}">
        <button type="button" role="tab" aria-selected="${!reg}" data-mode="login">${t("acct.tabLogin")}</button>
        <button type="button" role="tab" aria-selected="${reg}" data-mode="register">${t("acct.tabRegister")}</button></div>
      <form id="pwForm" class="pwform" novalidate>
        ${reg ? `<label class="field">${t("acct.name")}<input name="name" autocomplete="name" maxlength="80" required></label>` : ""}
        <label class="field">${t("acct.login")}<input name="login" autocomplete="username" autocapitalize="none" spellcheck="false" required placeholder="${t("acct.loginPh")}"></label>
        <label class="field">${t("acct.password")}<span class="pw-wrap"><input name="password" type="password" autocomplete="${reg ? "new-password" : "current-password"}" required>
          <button type="button" class="btn btn-ghost btn-sm" id="pwShow" aria-pressed="false">${t("acct.show")}</button></span></label>
        ${reg ? `<p class="fine">${t("acct.pwHint")}</p>` : ""}
        <p class="note warn" id="pwErr" role="alert" hidden></p>
        <button class="btn btn-primary wide" id="pwGo">${t(reg ? "acct.doRegister" : "acct.doLogin")}</button>
      </form>
      <div class="or" aria-hidden="true"><span>${t("acct.or")}</span></div>
      <button type="button" class="btn btn-tg wide" id="tgGo">${ic("send")} ${t("acct.viaTg")}</button>
      <p class="fine" style="margin-top:12px">${t("acct.note")}</p>`;
    if (!dlg.open) dlg.showModal();
    $$(".acct-tabs [data-mode]", body).forEach(b => b.onclick = () => openLogin(b.dataset.mode));
    $("#tgGo").onclick = openTelegramLogin;
    const pw = $('#pwForm [name="password"]');
    $("#pwShow").onclick = e => { const on = pw.type === "password"; pw.type = on ? "text" : "password"; e.currentTarget.setAttribute("aria-pressed", on); e.currentTarget.textContent = t(on ? "acct.hide" : "acct.show"); };
    // окно показано — курсор в первое поле, но не отбираем его, если человек уже начал заполнять форму
    const first = $('#pwForm input'); if (first) setTimeout(() => { const a = document.activeElement; if (!(a && a.closest && a.closest("#pwForm"))) first.focus(); }, 30);
    $("#pwForm").onsubmit = async e => {
      e.preventDefault();
      const f = e.target, err = $("#pwErr"), go = $("#pwGo");
      const v = k => (f.elements[k] ? f.elements[k].value.trim() : "");
      const fail = msg => { err.textContent = msg; err.hidden = false; };
      err.hidden = true;
      // проверки до сервера — те же правила, что на сервере
      if (reg && !v("name")) return fail(t("acct.e.name"));
      if (!v("login")) return fail(t("acct.e.login"));
      if (reg && f.elements.password.value.length < 8) return fail(t("acct.e.password"));
      if (!f.elements.password.value) return fail(t("acct.e.bad"));
      go.disabled = true; const label = go.innerHTML; go.innerHTML = `${spin} ${t("login.wait2")}`;
      const wake = setTimeout(() => { go.innerHTML = `${spin} ${t("login.wake")}`; }, 4000);
      try {
        if (reg) await C.register(v("name"), v("login"), f.elements.password.value);
        else await C.loginPw(v("login"), f.elements.password.value);
        clearTimeout(wake); dlg.close(); toast(t(reg ? "acct.welcome" : "login.ok")); await afterAuthChange();
      } catch (ex) { clearTimeout(wake); go.disabled = false; go.innerHTML = label; fail(acctErr(ex)); }
    };
  }
  async function openTelegramLogin() {
    const dlg = $("#loginDlg"), body = $("#loginBody");
    clearTimeout(pollTimer);
    $("#loginTitle").textContent = t("login.title");
    const back = `<button type="button" class="linkbtn" id="lgBack">← ${t("acct.back")}</button>`;
    const bindBack = () => { const b = $("#lgBack"); if (b) b.onclick = () => openLogin(); };
    body.innerHTML = `${back}<p>${t("pr.login.d")}</p><div class="waiting">${spin}<span id="lgWait">${t("login.wait")}</span></div>`;
    bindBack();
    if (!dlg.open) dlg.showModal();
    const wake = setTimeout(() => { const w = $("#lgWait"); if (w) w.textContent = t("login.wake"); }, 4000);
    let st;
    try { st = await C.startLogin(); }
    catch (e) { clearTimeout(wake); body.innerHTML = `${back}<p class="note warn">${t("login.fail")}</p><button class="btn btn-ghost" id="lgAgain">${t("login.again")}</button>`; bindBack(); $("#lgAgain").onclick = openTelegramLogin; return; }
    clearTimeout(wake);
    body.innerHTML = `${back}<ol class="steps-ol"><li>${t("login.step1")}</li><li>${t("login.step2")}</li></ol>
      <div class="code" aria-label="${t("login.code")}">${esc(st.code)}</div>
      <a class="btn btn-tg wide" href="${esc(st.link)}" target="_blank" rel="noopener">${ic("send")} ${t("login.open")}</a>
      <div class="waiting" id="lgState">${spin}${t("login.wait")}</div>`;
    bindBack();
    const started = Date.now();
    const poll = async () => {
      if (!dlg.open) return;
      try {
        const r = await C.pollLogin(st.nonce);
        if (r.status === "ok") { dlg.close(); toast(t("login.ok")); await afterAuthChange(); return; }
        if (r.status === "denied" || r.status === "expired") {
          $("#lgState").innerHTML = `<span>${t(r.status === "denied" ? "login.denied" : "login.expired")}</span> <button class="btn btn-ghost btn-sm" id="lgAgain">${t("login.again")}</button>`;
          $("#lgAgain").onclick = openTelegramLogin; return;
        }
      } catch (_) { /* временная ошибка сети — пробуем дальше */ }
      if (Date.now() - started < 600000) pollTimer = setTimeout(poll, 2500);
    };
    pollTimer = setTimeout(poll, 2500);
  }

  async function afterAuthChange() {
    renderAccount();
    if (S.D) { addOwnFarm(); render(); }
    drawPastures();
    if (C.loggedIn && S.pendingPasture) { const p = S.pendingPasture; S.pendingPasture = null; await savePasture(p); }
    if (S.route !== "map") onRoute();
  }
  function renderAccount() {
    const u = C.user;
    $("#accountLabel").textContent = u ? u.name : t("auth.login");
    $("#accountShort").textContent = u ? u.name : t("auth.loginShort");
    const coord = !!u && u.role === "coordinator";
    $$(".coord-only").forEach(el => { el.hidden = !coord; });
  }

  // ---------- профиль ----------
  async function renderProfile() {
    const el = $("#prPage"), u = C.user;
    if (!u) {
      el.innerHTML = `<div class="card"><h2>${ic("user")} ${t("pr.guest.t")}</h2><p>${t("pr.guest.d")}</p></div>
        <div class="card"><h2>${ic("user")} ${t("acct.title")}</h2><p>${t("acct.guestD")}</p>
          <p style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-primary" id="prReg">${t("acct.tabRegister")}</button>
          <button class="btn btn-ghost" id="prLogin">${t("acct.tabLogin")}</button>
          <button class="btn btn-tg" id="prTg">${ic("send")} ${t("acct.viaTg")}</button></p></div>`;
      $("#prReg").onclick = () => openLogin("register");
      $("#prLogin").onclick = () => openLogin("login");
      $("#prTg").onclick = openTelegramLogin;
      return;
    }
    const f = u.farm || { name: "", village: null, sheep: 0, goats: 0, cattle: 0, horses: 0, daily_return: false, home: "Б-С", plots: [] };
    const plotIds = J.DIRS.map(d => "Б-" + d).concat(J.DIRS.map(d => "Д-" + d));
    const initials = (u.name || "?").split(/\s+/).map(s => s[0]).join("").slice(0, 2).toUpperCase();
    el.innerHTML = `<div class="card"><div class="who"><div class="avatar">${esc(initials)}</div><div><h2 style="margin:0">${esc(u.name)}</h2>
        <span class="tag ${u.role === "coordinator" ? "tag-mine" : ""}">${t("role." + u.role)}</span></div></div>
        <dl class="kv">${u.via === "password" ? `<dt>${t("acct.login")}</dt><dd>${esc(u.login)}</dd>` : `<dt>${t("pr.id")}</dt><dd>${esc(u.uid)}${u.username ? " · @" + esc(u.username) : ""}</dd>`}<dt>${t("pr.since")}</dt><dd>${when(u.created)}</dd></dl>
        ${u.role !== "coordinator" ? `<p class="note">${t("pr.coordHint")}</p>` : ""}
        <p style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px"><button class="btn btn-ghost" id="prLogout">${ic("logout")} ${t("auth.logout")}</button>
        <button class="btn btn-danger" id="prDelete">${ic("trash")} ${t("pr.delete")}</button></p></div>
      <form class="card" id="farmForm"><h2>${ic("leaf")} ${t("pr.farm")} ${src("input")}</h2>
        <div class="formgrid">
          <label class="field span2">${t("pr.farmName")}<input name="name" maxlength="60" value="${esc(f.name)}" required></label>
          <div class="field span2">${t("pr.village")}<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b id="farmVillage" style="font-size:15px;color:var(--ink)">${f.village ? esc(f.village.name) : "—"}</b>
            <button type="button" class="btn btn-soft btn-sm" id="farmPickMap">${ic("map")} ${t("pr.pickMap")}</button></div></div>
          <div class="span4"><div class="search" id="farmSearch" style="max-width:520px"><svg class="ic"><use href="#i-search"/></svg><input id="farmQ" placeholder="${t("home.searchPh")}" aria-label="${t("pr.village")}"><button type="button" class="btn btn-ghost btn-sm" id="farmFind">${t("pr.villagePick")}</button><ul class="results" hidden></ul></div></div>
          ${["sheep", "goats", "cattle", "horses"].map(k => `<label class="field">${t("herds." + k)}<input name="${k}" type="number" inputmode="numeric" min="0" step="10" value="${f[k] || 0}"></label>`).join("")}
          <label class="field span2">${t("pr.home")}<select name="home">${plotIds.slice(0, 8).map(id => `<option ${id === f.home ? "selected" : ""}>${id}</option>`).join("")}</select></label>
          <label class="check span2" style="align-self:end;padding-bottom:8px"><input type="checkbox" name="daily_return" ${f.daily_return ? "checked" : ""}> ${t("herds.daily")}</label>
          <div class="span4 field">${t("pr.plots")}<div class="chips">${plotIds.map(id => `<label class="chip"><input type="checkbox" name="plots" value="${id}" ${(f.plots || []).includes(id) ? "checked" : ""}>${id}</label>`).join("")}</div></div>
        </div>
        <p style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px"><button class="btn btn-primary">${ic("save")} ${t("pr.saveFarm")}</button>
        ${f.village ? `<a class="btn btn-soft" href="#/map?lat=${f.village.lat}&lon=${f.village.lon}&name=${encodeURIComponent(f.village.name)}">${ic("map")} ${t("pr.openMap")}</a>` : ""}</p></form>
      <div class="card" id="pastCard"><h2>${ic("pen")} ${t("past.title")}</h2>
        ${(u.pastures || []).length ? (u.pastures || []).map(q => `<div class="pasture" data-pid="${esc(q.id)}">
            <div class="pasture-head"><b>${esc(q.name)}</b><small style="color:var(--muted)">${dateStr(q.created, false)}</small></div>
            ${pastureRows(q.stats || {}, q.area_ha, q.water)}
            <div class="btns"><button class="btn btn-soft btn-sm" data-pshow>${ic("map")} ${t("past.show")}</button>
              <a class="btn btn-tg btn-sm" href="${pastLink(q.id)}" target="_blank" rel="noopener">${ic("send")} ${t("past.notify")}</a>
              <button class="btn btn-ghost btn-sm" data-pdel>${ic("trash")} ${t("sc.del")}</button></div></div>`).join("")
          : `<p class="empty">${t("past.empty")}</p>`}
        <button class="btn btn-accent" id="pastDraw">${ic("pen")} ${t("past.draw")}</button>
        <p class="fine" style="margin-top:10px">${t("past.boundaryNote")}</p></div>`;
    let village = f.village;
    // карта для пастбища: село хозяйства, иначе открытое село, иначе центр самого пастбища
    const mapQ = (extra, q) => {
      const v = f.village || (S.D && S.D.village) || (q && (() => { const r = q.geometry.coordinates[0]; return { name: q.name, lat: +(r.reduce((s, p) => s + p[1], 0) / r.length).toFixed(5), lon: +(r.reduce((s, p) => s + p[0], 0) / r.length).toFixed(5) }; })()) || DEFAULT.village;
      return `lat=${v.lat}&lon=${v.lon}&name=${encodeURIComponent(v.name)}&${extra}`;
    };
    $("#pastDraw").onclick = () => go("map", mapQ("draw=1"));
    $$("[data-pid]").forEach(box => {
      const q = u.pastures.find(x => x.id === box.dataset.pid);
      box.querySelector("[data-pshow]").onclick = () => go("map", mapQ("pasture=" + q.id, q));
      let armedP = false;
      box.querySelector("[data-pdel]").onclick = async e => {
        if (!armedP) { armedP = true; e.currentTarget.lastChild.textContent = " " + t("past.delConfirm"); return; }
        try { await C.deletePasture(q.id); drawPastures(); renderProfile(); } catch (err) { toast(errText(err), true); }
      };
    });
    $("#prLogout").onclick = async () => { await C.logout(); toast(t("auth.logout")); afterAuthChange(); };
    let armed = false;
    $("#prDelete").onclick = async e => {
      if (!armed) { armed = true; e.currentTarget.textContent = t("pr.deleteConfirm"); return; }
      try { await C.deleteAccount(); toast(t("pr.deleted")); afterAuthChange(); } catch (err) { toast(errText(err), true); }
    };
    $("#farmPickMap").onclick = async () => {
      const v = await pickVillageOnMap(village || (S.D && S.D.village));
      if (v) { village = v; $("#farmVillage").textContent = v.name; }
    };
    const ul = $("#farmSearch .results");
    $("#farmFind").onclick = async () => {
      const q = $("#farmQ").value.trim(); if (!q) return;
      try {
        const found = await PL.geocode(q);
        if (!found.length) { toast(t("err.notFound"), true); return; }
        ul.innerHTML = found.map((x, i) => `<li tabindex="0" data-i="${i}">${esc(x.name)}<small>${esc(x.full)}</small></li>`).join(""); ul.hidden = false;
        ul.querySelectorAll("li").forEach(li => li.onclick = () => { const x = found[+li.dataset.i]; village = { name: x.name, lat: x.lat, lon: x.lon }; $("#farmVillage").textContent = x.name; ul.hidden = true; });
      } catch (e) { toast(t("err.geocode"), true); }
    };
    $("#farmForm").onsubmit = async ev => {
      ev.preventDefault();
      if (!village) { toast(t("pr.noVillage"), true); return; }
      const fd = new FormData(ev.target);
      const farm = { name: fd.get("name"), village, home: fd.get("home"), daily_return: fd.get("daily_return") === "on", plots: fd.getAll("plots") };
      for (const k of ["sheep", "goats", "cattle", "horses"]) farm[k] = Math.max(0, Math.round(+fd.get(k) || 0));
      try { await C.saveFarm(farm); toast(t("pr.farmSaved")); if (S.D) { addOwnFarm(); render(); } renderProfile(); }
      catch (e) { toast(errText(e), true); }
    };
  }

  /** Выбор села нажатием на спутниковую карту (с приближением, поиском и геолокацией телефона). */
  function pickVillageOnMap(start) {
    return new Promise(resolve => {
      if (!window.L) { toast(t("past.noMap"), true); resolve(null); return; }
      const d = document.createElement("dialog");
      d.className = "modal modal-wide";
      d.innerHTML = `<form method="dialog" class="modal-x"><button aria-label="${t("common.close")}">${ic("x")}</button></form>
        <h2>${t("pick.title")}</h2><p class="fine">${t("pick.hint")}</p>
        <form class="search" id="pkSearch" autocomplete="off"><svg class="ic"><use href="#i-search"/></svg><input id="pkQ" placeholder="${t("home.searchPh")}" aria-label="${t("pr.village")}" enterkeyhint="search"><button class="btn btn-ghost btn-sm">${t("home.search")}</button><ul class="results" hidden></ul></form>
        <div class="pickmap" id="pkMap"></div>
        <div class="pickbar"><button type="button" class="btn btn-ghost btn-sm" id="pkHere">${ic("pin")} ${t("pick.here")}</button>
          <span id="pkSel" class="pksel">—</span></div>
        <p style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:12px"><button type="button" class="btn btn-ghost" id="pkCancel">${t("common.cancel")}</button>
          <button type="button" class="btn btn-primary" id="pkOk" disabled>${ic("check")} ${t("pick.choose")}</button></p>`;
      document.body.appendChild(d);
      d.showModal();
      let chosen = null, marker = null, seq = 0;
      const m = L.map($("#pkMap", d), { maxZoom: 19 }).setView(start ? [start.lat, start.lon] : [48.0, 67.5], start ? 12 : 5);
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxNativeZoom: 17, maxZoom: 19, attribution: "Esri · © OpenStreetMap" }).addTo(m);
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxNativeZoom: 17, maxZoom: 19, opacity: 0.9 }).addTo(m);
      setTimeout(() => m.invalidateSize(), 60);
      const choose = async (lat, lon, knownName) => {
        lat = +lat.toFixed(5); lon = +lon.toFixed(5);
        if (marker) marker.setLatLng([lat, lon]); else marker = L.marker([lat, lon]).addTo(m);
        const my = ++seq;
        $("#pkSel", d).textContent = knownName || t("pick.naming");
        let name = knownName;
        if (!name) { try { name = (await PL.reverseGeocode(lat, lon, I.lang === "kk" ? "kk" : "ru")).name; } catch (_) {} }
        if (my !== seq) return;
        chosen = { name: name || `${lat.toFixed(3)}, ${lon.toFixed(3)}`, lat, lon };
        $("#pkSel", d).innerHTML = `${t("pick.selected")}: <b>${esc(chosen.name)}</b> <small>(${lat.toFixed(4)}, ${lon.toFixed(4)})</small>`;
        $("#pkOk", d).disabled = false;
      };
      if (start) choose(start.lat, start.lon, start.name);
      m.on("click", e => choose(e.latlng.lat, e.latlng.lng));
      $("#pkHere", d).onclick = () => {
        if (!navigator.geolocation) { toast(t("pick.geoFail"), true); return; }
        navigator.geolocation.getCurrentPosition(p => { m.setView([p.coords.latitude, p.coords.longitude], 14); choose(p.coords.latitude, p.coords.longitude); },
          () => toast(t("pick.geoFail"), true), { enableHighAccuracy: true, timeout: 15000 });
      };
      const ul = $("#pkSearch .results", d);
      $("#pkSearch", d).onsubmit = async ev => {
        ev.preventDefault();
        const q = $("#pkQ", d).value.trim(); if (!q) return;
        try {
          const found = await PL.geocode(q);
          if (!found.length) { toast(t("err.notFound"), true); return; }
          ul.innerHTML = found.map((x, i) => `<li tabindex="0" data-i="${i}">${esc(x.name)}<small>${esc(x.full)}</small></li>`).join(""); ul.hidden = false;
          ul.querySelectorAll("li").forEach(li => li.onclick = () => { const x = found[+li.dataset.i]; ul.hidden = true; m.setView([x.lat, x.lon], 13); choose(x.lat, x.lon, x.name); });
        } catch (_) { toast(t("err.geocode"), true); }
      };
      let result = null;
      $("#pkCancel", d).onclick = () => d.close();
      $("#pkOk", d).onclick = () => { result = chosen; d.close(); };
      d.addEventListener("close", () => { m.remove(); d.remove(); resolve(result); });
    });
  }

  // ---------- координатор ----------
  async function renderCoord() {
    const el = $("#coPage"), u = C.user;
    if (!u || u.role !== "coordinator") { el.innerHTML = `<div class="card"><p>${t("co.denied")}</p></div>`; return; }
    const vs = u.villages || [];
    el.innerHTML = `<div class="card"><h2>${ic("pin")} ${t("co.villages")}</h2>
      ${vs.length ? `<ul class="list">${vs.map(v => `<li class="row"><div class="grow"><b>${esc(v.name)}</b><small>${v.lat}, ${v.lon}</small></div>
        <div class="btns"><button class="btn btn-soft btn-sm" data-farms="${esc(v.vk)}">${t("co.farms")}</button><button class="btn btn-ghost btn-sm" data-rmv="${esc(v.vk)}" aria-label="${t("co.remove")}">${ic("x")}</button></div></li>`).join("")}</ul>` : `<p class="empty">${t("co.noVillages")}</p>`}
      ${S.D ? `<button class="btn btn-ghost" id="coAdd">${ic("plus")} ${t("co.addCurrent")}: ${esc(S.D.village.name)}</button>` : ""}</div>
      <div class="card" id="coFarms" hidden></div>`;
    const add = $("#coAdd");
    if (add) add.onclick = async () => { try { await C.coordAddVillage(S.D.village); renderCoord(); } catch (e) { toast(errText(e), true); } };
    el.querySelectorAll("[data-rmv]").forEach(b => b.onclick = async () => { try { await C.coordRemoveVillage(b.dataset.rmv); renderCoord(); } catch (e) { toast(errText(e), true); } });
    el.querySelectorAll("[data-farms]").forEach(b => b.onclick = async () => {
      const v = vs.find(x => x.vk === b.dataset.farms), box = $("#coFarms");
      box.hidden = false; box.innerHTML = `<p class="empty">…</p>`;
      try {
        const { farms } = await C.coordFarms(v.vk);
        box.innerHTML = `<h2>${ic("users")} ${t("co.farms")}: ${esc(v.name)}</h2>${farms.length ? `<div class="tablewrap"><table><thead><tr><th>${t("herds.farm")}</th><th>${t("co.owner")}</th>
          <th class="num">${t("herds.sheep")}</th><th class="num">${t("herds.cattle")}</th><th class="num">${t("herds.horses")}</th><th>${t("co.updated")}</th></tr></thead><tbody>
          ${farms.map(f => `<tr><td><b>${esc(f.name)}</b></td><td>${esc(f.owner)}</td><td class="num">${fmt(f.sheep)}</td><td class="num">${fmt(f.cattle)}</td><td class="num">${fmt(f.horses)}</td><td>${when(f.updated)}</td></tr>`).join("")}
          </tbody></table></div><button class="btn btn-primary" id="coJoint" style="margin-top:14px">${ic("map")} ${t("co.joint")}</button>` : `<p class="empty">${t("co.noFarms")}</p>`}`;
        const j = $("#coJoint");
        if (j) j.onclick = () => loadScenario({ village: v, water: [], params: null,
          herds: farms.map(f => ({ id: "f" + f.uid, name: `${f.name} (${f.owner})`, sheep: f.sheep, goats: f.goats, cattle: f.cattle, horses: f.horses, home: f.home, daily_return: f.daily_return })) });
      } catch (e) { box.innerHTML = `<p class="empty">${esc(errText(e))}</p>`; }
    });
  }

  // ---------- страница «О данных» ----------
  function renderDataPage() {
    $("#dataPage").innerHTML = `<div class="card">
      <div class="srcblock s-sat"><h3>${src("sat")} ${t("data.sat.t")}</h3><p>${t("data.sat.d")}</p></div>
      <div class="srcblock s-input"><h3>${src("input")} ${t("data.input.t")}</h3><p>${t("data.input.d")}</p></div>
      <div class="srcblock s-model"><h3>${src("model")} ${t("data.model.t")}</h3><p>${t("data.model.d")}</p></div></div>
      <div class="card"><h2>${ic("shield")} ${t("data.conf.t")}</h2><p>${t("data.conf.d")}</p>
      <p><span class="conf conf-high">${t("conf.high")}</span> <span class="conf conf-medium">${t("conf.medium")}</span> <span class="conf conf-low">${t("conf.low")}</span></p>
      <p class="note warn">${t("kpi.costNote")}</p></div>`;
  }

  // ---------- «Главное»: понятная сводка без терминов ----------
  function saveParams() { C.ls.set("jaiylym:params", S.userP || {}); }

  // ---------- пилотные показатели: только счётчики в этом браузере, никуда не отправляются ----------
  function metric(kind, d) {
    const m = C.ls.get("jaiylym:metrics", null) || { plans: 0, feasible: 0, saved: 0, pdf: 0, completed: 0, times: [], last: null };
    if (kind === "plan") {
      if (!d.herds) return;
      const key = JSON.stringify([S.D && S.D.village.lat, d.status, Math.round(d.after), d.herds]);
      if (m.lastKey === key) return;                      // перерисовка того же расчёта — не новый расчёт
      m.lastKey = key; m.plans++; if (d.status === "feasible") m.feasible++;
      m.last = { status: d.status, before_t: +(+d.before).toFixed(1), after_t: +(+d.after).toFixed(1), overloaded: d.over, missing: d.missing, herds: d.herds };
    }
    if (kind === "saved" || kind === "pdf") {
      m[kind]++; m.completed++;
      if (S.t0) { m.times = (m.times || []).concat([Math.round((Date.now() - S.t0) / 6000) / 10]).slice(-50); S.t0 = Date.now(); }
    }
    C.ls.set("jaiylym:metrics", m);
  }
  const sheepOf = au => au / S.P.au.sheep;
  function briefData() {
    const Sd = S.P.season_days;
    const water = S.plots.filter(p => p.water);
    const capAU = water.reduce((s, p) => s + J.plotCapacity(p, S.P).au_season, 0);
    const au = S.herds.reduce((s, h) => s + J.herdAU(h, S.P), 0);
    const ratio = capAU > 0 ? au / capAU : Infinity;
    const worst = S.plots.filter(p => S.cur.load[p.id].load > 1 && p.pasture_ha >= 5).sort((a, b) => S.cur.load[b.id].load - S.cur.load[a.id].load)[0];
    const shortHerds = S.herds.filter(h => S.pl.coverage && S.pl.coverage[h.id] < Sd - 0.5);
    const deficitT = J.hayTonnes(S.pl.deficit_kg, S.P);
    const excessAU = Object.values(S.pl.unmet || {}).reduce((s, x) => s + x, 0) / Sd;
    const wr = wellRank(), well = wr.status === "ok" ? wr.list[0] : null;
    const near = S.plots.filter(p => p.ring === "near" && (p.series || []).length >= 2);
    const trend = near.length ? near.reduce((s, p) => s + (p.series[p.series.length - 1].v - p.series[0].v) / p.series[0].v, 0) / near.length * 100 : null;
    return { Sd, water, capAU, au, ratio, worst, shortHerds, deficitT, excessAU, well, trend };
  }
  /** Зоны, где нельзя пасти, ещё идут из OSM или не загрузились: площадь и число овец пока без вычета — говорим прямо. */
  const ngNote = () => (S.D.nograze && ["ok", "empty"].includes(S.D.nograze.status) ? "" : S.ngState === "loading" ? `<p class="note" id="ngNote">${t("ng.wait")}</p>`
    : S.ngState === "error" ? `<p class="note warn" id="ngNote">${t("ng.failNote")} <button type="button" class="linkbtn" data-goto="data">${t("ng.toData")}</button></p>` : "");
  function briefHtml() {
    if (!S.herds.length) return `${zoneCard()}${ngNote()}<div class="brief"><p>${t("brief.noherds")}</p>
      <p style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button class="btn btn-soft btn-sm" id="addDemo">${ic("plus")} ${t("ov.addDemo")}</button>
      <button class="btn btn-ghost btn-sm" id="addHerd0">${ic("plus")} ${t("herds.add")}</button></p></div>`;
    const b = briefData();
    const st = b.ratio <= 0.7 ? ["ok", "brief.ok"] : b.ratio <= 1 && b.deficitT < 1 ? ["tight", "brief.tight"] : ["short", "brief.short"];
    const lines = [];
    const res = resultHtml();
    lines.push(t("brief.cap", { ha: fmt(b.water.reduce((s, p) => s + p.pasture_ha, 0)), sheep: fmt(sheepOf(b.capAU)), au: fmt(b.capAU), myau: fmt(b.au), mysheep: fmt(sheepOf(b.au)) }));
    const nt = normTotals(b.water);
    if (nt.limited) lines.push(t("nm.brief", { k: nt.limited, n: nt.n, sat: fmt(nt.sat), cap: fmt(nt.cap) }) + " " + src("norm"));
    lines.push(b.worst ? t("brief.curOver", { n: S.cur.overloaded, id: `<b>${esc(b.worst.id)}</b>`, pct: pct(S.cur.load[b.worst.id].load) }) : t("brief.curOk"));
    if (b.deficitT < 1) lines.push(t("brief.planOk"));
    else {
      lines.push(t("brief.planShort", { t: `<b>${fmt(b.deficitT)}</b>` }));
      for (const h of b.shortHerds.slice(0, 3)) lines.push(t("brief.herdShort", { name: esc(h.name), d: `<b>${Math.round(S.pl.coverage[h.id])}</b>`, season: b.Sd }));
      lines.push(t("brief.needLess", { au: fmt(b.excessAU), sheep: fmt(sheepOf(b.excessAU)), t: fmt(b.deficitT) }));
    }
    if (b.well) lines.push(t("brief.well", { id: `<b>${esc(b.well.plot)}</b>`, t: fmt(b.well.gain_t), n: b.well.better.length }));
    if (b.trend != null && Math.abs(b.trend) >= 3) lines.push(t("brief.trend", { year: S.D.source.year, dir: b.trend < 0 ? t("brief.trendDown") : t("brief.trendUp"), p: Math.abs(Math.round(b.trend)) }));
    const todo = [];
    const chk = Object.entries(obsNow()).filter(([, g]) => g.verdict === "check").map(([id]) => id);
    if (chk.length) todo.push(t("obs.todo", { ids: esc(chk.join(", ")) }));
    if (S.cur.overloaded > 0) todo.push(t("brief.do.plan"));
    if (b.well) todo.push(t("brief.do.well", { id: esc(b.well.plot) }));
    if (b.deficitT >= 1) todo.push(t("brief.do.reduce"));
    todo.push(t("brief.do.bot"));
    todo.push(t("brief.do.calib"));
    return `${demoBanner()}${zoneCard()}${ngNote()}${res}<div class="brief"><span class="brief-status st-${st[0]}">${t(st[1])}</span>
      ${lines.map(x => `<p>${x}</p>`).join("")}
      <h3 style="margin:12px 0 2px;font-size:15px">${t("brief.do")}</h3>
      <ul class="todo">${todo.slice(0, 4).map(x => `<li>${ic("check")}<span>${x}</span></li>`).join("")}</ul>
      <p class="fine" style="margin-top:10px">${t("brief.trust", { k: S.D.source.dates.length, year: S.D.source.year })} ${src("sat")} ${src("model")}</p></div>
      <div class="aibox" id="aiBox"><button class="btn btn-green btn-sm" id="aiBriefBtn">${ic("spark")} ${t("brief.ai")}</button>
        ${S.aiBrief && S.aiBrief.key === briefKey() ? `<div class="aitext">${aiText(S.aiBrief.text)}</div>${S.aiBrief.mark || ""}<p class="fine">${t("brief.aiNote")}</p>` : ""}</div>`;
  }
  /**
   * «Как NDVI превращается в овец»: та же цепочка, что в «Как рассчитано?» (engine.explainCapacity), но на виду —
   * на примере выбранного участка, с пересчётом видов скота и честной оговоркой, что сезон и тип травостоя учтены не полностью.
   */
  function chainHtml() {
    const known = S.plots.filter(p => capOf(p).known);
    if (!known.length) return "";
    const p = known.find(x => x.id === S.chainId) || known[0];
    const e = J.explainCapacity(p, S.P), st = Object.fromEntries(e.steps.map(s => [s.key, s])), P = e.params, au = S.P.au;
    const per = k => fmt1(1 / au[k]);
    const steps = [
      { v: String(st.ndvi.value), u: "NDVI", l: t("cap.s.ndvi"), f: t("cap.f.ndvi", { ha: fmt(st.area.value) }), s: "sat" },
      { v: fmt(st.biomass.value), u: t("cap.u.kgha"), l: t("cap.s.biomass"), f: `(${st.ndvi.value} − ${P.ndvi0}) × ${fmt(P.k_ndvi)}`, s: "model" },
      { v: fmt(st.forage.value / 1000), u: t("pop.t"), l: t("cap.s.forage"), s: "model",
        f: (st.nograze && !p.zone ? `(${fmt(p.pasture_ha_gross)} − ${fmt1(st.nograze.value)}) ${t("common.ha")}` : `${fmt(st.area.value)} ${t("common.ha")}`) + ` × ${fmt(st.biomass.value)} × ${P.util}` },
      { v: fmt1(st.au_season.value), u: t("cap.u.au"), l: t("cap.s.au"), f: t("cap.f.au", { i: P.intake, d: P.season_days }), s: "model" },
      { v: fmt(st.sheep.value), u: t("pop.sheep"), l: t(st.norm ? "cap.s.sheepSat" : "cap.s.sheep"), f: `${fmt1(st.au_season.value)} × ${per("sheep")}`, s: "model" },
    ];
    if (st.norm) steps.push(
      { v: fmt(st.norm.value), u: t("pop.sheep"), l: t("cap.s.norm"), f: t("cap.f.norm", { ha: fmt1(st.area.value), n: fmt2(p.norm.au_ha * au.sheep) }) + (e.capacity.norm.season_factor < 1 ? ` × ${p.norm.days[1]} / ${P.season_days}` : "") + (e.capacity.norm.green < 0.995 ? ` × ${fmt2(e.capacity.norm.green)}` : ""), s: "norm" },
      { v: fmt(st.limit.value), u: t("pop.sheep"), l: t("cap.s.limit"), f: `${t("cap.f.limit", { a: fmt(st.sheep.value), b: fmt(st.norm.value) })} ${normVerdictText(normVerdict(e.capacity) || { k: "match" })}`, s: e.capacity.limited_by === "norm" ? "norm" : "model" });
    return `<section class="chain" aria-labelledby="chainH"><h3 id="chainH">${ic("leaf")} ${t("cap.title")}</h3>
      <label class="field chain-pick">${t("cap.plot")}<select id="chainPlot">${known.map(x => `<option value="${esc(x.id)}" ${x.id === p.id ? "selected" : ""}>${esc(x.id)}</option>`).join("")}</select></label>
      <ol class="chain-steps">${steps.map(x => `<li><div class="cv"><b>${x.v}</b> <span>${esc(x.u)}</span></div>
        <div class="cl">${esc(x.l)} ${src(x.s)}<small>${esc(x.f)}</small></div></li>`).join("")}</ol>
      <ul class="chain-notes">
        <li>${st.norm ? normNote(p.norm) : `${t("nm.noRegion")} <button type="button" class="linkbtn" data-goto="data">${t("nm.choose")}</button>`}</li>
        ${st.norm && e.capacity.norm.green < 0.995 ? `<li>${t("nm.green", { g: pct(e.capacity.norm.green), a: String(p.ndvi).replace(".", ","), b: String(p.ndvi_ref).replace(".", ",") })} ${src("sat")}</li>` : ""}
        <li>${t("cap.n.au", { cattle: fmt2(au.cattle), horses: fmt2(au.horses), sheep: fmt2(au.sheep), goats: fmt2(au.goats) })}</li>
        ${p.zone ? `<li>${t("zn.chain", { a: fmt1(p.zone.before), s: pct(p.zone.share), b: fmt1(st.area.value) })}</li>` : ""}
        ${st.nograze ? `<li>${t("cap.n.ng", { g: fmt(p.pasture_ha_gross), n: fmt1(st.nograze.value), a: fmt1(p.zone ? p.zone.before : st.area.value), b: p.nograze_buffer_m })}</li>` : ""}
        <li>${t("cap.n.season", { d: P.season_days })}</li>
        <li>${t("cap.n.veg", { k: fmt(P.k_ndvi) })}</li>
      </ul>
      <button type="button" class="btn btn-soft btn-sm" data-how="${esc(p.id)}">${ic("info")} ${t("cap.more")}</button></section>`;
  }
  /** Какая норма применена: выбранный тип или самая мягкая по области. */
  const normNote = n => (n.soft ? t("nm.noteSoft", { r: esc(regName(n.region)), n: fmt2(n.au_ha * S.P.au.sheep) })
    : t("nm.noteRow", { ty: esc(n.type), n: fmt2(n.au_ha * S.P.au.sheep), s: t(n.state === "degraded" ? "nm.degraded" : "nm.restored") })) +
    ` <button type="button" class="linkbtn" data-goto="data">${t("nm.choose")}</button>`;
  const briefKey = () => S.D ? JSON.stringify([S.D.village.lat, S.D.village.lon, S.herds.map(h => [h.sheep, h.goats, h.cattle, h.horses, h.home, h.daily_return, h.allowed_plots, h.weight]), [...S.added], [...S.forbidden], S.waterSet, S.rest, S.normSel, S.P.k_ndvi, S.P.util, S.P.season_days, I.lang]) : "";

  // ---------- итог плана простыми словами: возможно ли, почему, что использовано, где дефицит, что изменить, насколько надёжно ----------
  const plotIds = ids => (ids || []).map(esc).join(", ");
  function whyHerd(h, dg) {
    const reasons = Object.entries(dg.excluded || {}).filter(([, ids]) => ids.length).map(([r, ids]) => `${t("rsn." + r)}: ${plotIds(ids)}`).join("; ");
    return t("why." + dg.reason, { name: esc(h.name), d: Math.round(S.P.season_days - (S.pl.coverage[h.id] || 0)), r: reasons || "—" });
  }
  function sgText(s) {
    if (s.type === "add_water") return t("sg.add_water", { id: esc(s.plot), n: fmt(s.au_days / S.P.season_days / S.P.au.sheep) });
    if (s.type === "check_data") return t("sg.check_data", { ids: plotIds(s.plots) });
    if (s.type === "extend_rights") return t("sg.extend_rights", { ids: plotIds(s.plots) });
    if (s.type === "reduce_herd") return t("sg.reduce_herd", { au: fmt(s.au), sheep: fmt(s.sheep) });
    if (s.type === "hay") return t("sg.hay", { t: fmt(s.tonnes) });
    return "";
  }
  /** Предупреждение о данных (строка из model.js / pipeline.js по-русски) → текст на языке интерфейса; неизвестное — как есть. */
  const META_WARN = [
    [/^Число валидных пикселей/, () => t("mw.legacy")],
    [/^Дата расчёта не записана/, () => t("mw.noCalcDate")],
    [/^Безоблачных дат мало: (\d+)/, m => t("mw.fewDates", { n: m[1] })],
    [/^Тайлы одной даты склеены: (\d+) сцен → (\d+)/, m => t("mw.merged", { a: m[1], b: m[2] })],
    [/^Нет NDVI для участков: (.*?)\.?$/, m => t("mw.noNdvi", { ids: m[1] })],
    [/^Зоны, где нельзя пасти \(OpenStreetMap\), не загрузились: (.*)$/, m => t("mw.ngFail", { e: m[1] })],
  ];
  function metaWarn(w) {
    for (const [re, f] of META_WARN) { const m = re.exec(String(w)); if (m) return f(m); }
    return String(w);
  }
  function wrText(w) {
    if (w.type === "no_data_excluded" || w.type === "low_quality_used") return t("wr." + w.type, { ids: plotIds(w.plots) });
    if (w.type === "water_unconfirmed") return t("wr.water_unconfirmed", { n: w.plots.length });
    if (w.type === "rights_not_specified") return t("wr.rights_not_specified", { n: w.herds.length });
    if (w.type === "daily_far_used") return t("wr.daily_far_used", { h: w.herds.map(id => esc((S.herds.find(h => h.id === id) || {}).name || id)).join(", "), ids: plotIds(w.plots) });
    return t("wr." + w.type);
  }
  function resultHtml() {
    const pl = S.pl, meta = M.metaOf(S.D);
    if (!S.herds.length || pl.status === "no_demand") return "";
    const ok = pl.status === "feasible";
    const head = ok ? t("res.feasible") : pl.status === "infeasible" ? t("res.infeasible") : t("res.partial");
    const short = S.herds.filter(h => pl.unmet[h.id]);
    const q = { high: 0, medium: 0, low: 0, none: 0 }; S.plots.forEach(p => q[confidence(p)]++);
    const why = short.map(h => `<li>${whyHerd(h, pl.diagnostics[h.id])}</li>`).join("");
    const sg = planSuggestions().map(sgText).filter(Boolean).map(x => `<li>${x}</li>`).join("");
    const wr = (pl.warnings || []).map(wrText).filter(Boolean).map(x => `<li>${x}</li>`).join("");
    const worst = Object.keys(pl.load).filter(id => pl.load[id].used > 0).sort((a, b) => pl.load[b].used - pl.load[a].used)[0] || S.plots[0].id;
    return `<div class="result ${ok ? "res-ok" : "res-short"}" role="status">
      <p class="res-head">${ic(ok ? "check" : "info")} <b>${head}</b></p>
      ${ok ? "" : `<h4>${t("res.why")}</h4><ul>${why}</ul><h4>${t("res.where")}</h4><p>${t("res.whereLine", { t: fmt(J.hayTonnes(pl.deficit_kg, S.P)), names: short.map(h => esc(h.name)).join(", ") })} ${src("model")}</p>
        <h4>${t("res.change")}</h4><ul>${sg}</ul>`}
      ${!ok && pl.bottleneck && pl.bottleneck.groups.length ? bottleneckHtml(pl.bottleneck.groups[0]) : ""}
      <h4>${t("res.algo")}</h4><p>${algoLine(pl)}</p>
      <h4>${t("res.used")}</h4><p>${t("res.usedLine", { k: meta.imagery_count, year: meta.year ?? "—", lc: meta.landcover_year || "", n: S.herds.length, v: M.MODEL_VERSION })}</p>
      <h4>${t("res.trust")}</h4><p>${t("res.trustLine", { h: q.high, m: q.medium, l: q.low, n: q.none })}</p>
      ${wr ? `<details class="more"><summary>${t("res.warnings")} (${(pl.warnings || []).length})</summary><ul>${wr}</ul></details>` : ""}
      <p style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button type="button" class="btn btn-soft btn-sm" data-how="${esc(worst)}">${ic("info")} ${t("pop.how")} (${esc(worst)})</button>
        <button type="button" class="btn btn-ghost btn-sm" data-goto="whatif">${ic("layers")} ${t("tab.whatif")}</button></p></div>`;
  }
  const herdName = id => { const h = S.herds.find(x => x.id === id); return h ? esc(h.name) : esc(id); };
  /** Доказательство узкого места (минимальный разрез): кому, где и сколько не хватает — можно проверить сложением. */
  function bottleneckHtml(g) {
    // если причина касается не всех стад группы (например, только дойных) — называем, каких именно
    const whoFor = r => { const ids = (g.excluded_for || {})[r] || []; return ids.length && ids.length < g.herds.length ? ` (${t("bn.for")} ${ids.map(herdName).join(", ")})` : ""; };
    const exc = Object.entries(g.excluded || {}).filter(([, ids]) => ids.length).map(([r, ids]) => `${t("rsn." + r)}${whoFor(r)}: ${plotIds(ids)}`).join("; ");
    return `<h4>${t("res.bottleneck")}</h4><p>${t("bn.line", { herds: g.herds.map(herdName).join(", "), plots: plotIds(g.plots) || "—",
      need: fmt(g.demand_au_days), cap: fmt(g.capacity_au_days), short: fmt(g.shortfall_au_days), t: fmt(J.hayTonnes(g.shortfall_au_days * S.P.intake, S.P)) })}
      ${g.window_limited_au_days > 0.5 ? t("bn.window", { w: fmt(g.window_limited_au_days) }) : ""} ${exc ? t("bn.excluded", { r: exc }) : ""} ${src("model")}</p>`;
  }
  function algoLine(pl) {
    if (pl.algorithm !== "fair-optimal-v2") return t("algo.greedyLine");
    const H = S.herds.filter(h => J.herdAU(h, S.P) > 0 && pl.diagnostics[h.id] && pl.diagnostics[h.id].candidates.length);
    const minS = H.length ? Math.min(...H.map(h => 1 - (pl.unmet[h.id] || 0) / (J.herdAU(h, S.P) * S.P.season_days))) : 1;
    return t(pl.status === "feasible" ? "algo.optLineOk" : "algo.optLine", { p: pct(minS) }) + (pl.gap_au_days > 1 ? " " + t("algo.gap", { t: fmt(J.hayTonnes(pl.gap_au_days * S.P.intake, S.P)) }) : "");
  }
  function demoBanner() {
    const n = S.herds.filter(h => h.demo).length;
    if (!n) return "";
    return `<div class="note warn demo-banner">${t("demo.banner", { n })}
      <button type="button" class="btn btn-ghost btn-sm" id="demoToggle">${t("demo.hide")}</button></div>`;
  }

  function movesHtml() {
    if (!S.herds.length) return "";
    const day = J.seasonDay(new Date()), Sd = S.P.season_days, items = [];
    const inSeason = day >= 1 && day <= Sd;
    for (const h of S.herds) {
      const plan = S.pl.herdPlans[h.id] || [];
      if (!inSeason) { const first = plan[0]; if (first && first.plot) items.push({ d: -1, h, s: first }); continue; }
      for (const s of plan) if (s.plot && s.from >= day && s.from <= day + 14) items.push({ d: s.from - day, h, s });
    }
    items.sort((a, b) => a.d - b.d);
    const rows = items.slice(0, 6).map(x => `<li><span><b>${esc(x.h.name)}</b> ${t("moves.to")} ${esc(x.s.plot)}</span><small>${x.d < 0 ? "01.05" : x.d === 0 ? t("moves.today") : t("moves.in", { d: x.d })}</small></li>`).join("");
    return `<div class="mini"><h3>${ic("route")} ${t("moves.title")}</h3>${!inSeason ? `<p class="fine" style="margin:0 0 4px">${t("moves.season")}</p>` : ""}
      ${rows ? `<ul class="list moves">${rows}</ul>` : `<p class="fine" style="margin:0">${t("moves.none")}</p>`}</div>`;
  }

  // ---------- погода (Open-Meteo, без ключа): осадки за 30 дней и прогноз на неделю ----------
  async function loadWeather() {
    if (!S.D || !navigator.onLine) return;
    const key = S.D.village.lat + "," + S.D.village.lon;
    if (S.wx && S.wx.key === key) return;
    try {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${S.D.village.lat}&longitude=${S.D.village.lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&past_days=30&forecast_days=7&timezone=auto`;
      const d = await (await fetch(u, { signal: AbortSignal.timeout(15000) })).json();
      const days = d.daily.time.map((tm, i) => ({ d: tm, tmax: d.daily.temperature_2m_max[i], tmin: d.daily.temperature_2m_min[i], p: d.daily.precipitation_sum[i] || 0 }));
      const today = new Date().toISOString().slice(0, 10);
      const past = days.filter(x => x.d < today), next = days.filter(x => x.d >= today).slice(0, 7);
      S.wx = { key, rain30: past.reduce((s, x) => s + x.p, 0), next, tmean7: next.reduce((s, x) => s + (x.tmax + x.tmin) / 2, 0) / (next.length || 1) };
    } catch (_) { S.wx = { key, fail: true }; }
    if (S.tab === "brief" && S.route === "map") renderPane("brief");
  }
  function wxHtml() {
    if (!S.wx) return `<div class="mini"><h3>${ic("cloud")} ${t("wx.title")}</h3><p class="fine" style="margin:0">…</p></div>`;
    if (S.wx.fail) return `<div class="mini"><h3>${ic("cloud")} ${t("wx.title")}</h3><p class="fine" style="margin:0">${t("wx.fail")}</p></div>`;
    const w = S.wx, tip = w.tmean7 < 5 ? t("wx.cold") : w.rain30 < 10 ? t("wx.dry") : t("wx.good");
    const wd = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"], wk = ["Жс", "Дс", "Сс", "Ср", "Бс", "Жм", "Сн"];
    return `<div class="mini"><h3>${ic("cloud")} ${t("wx.title")} <span class="src src-wx" style="background:#e3eef6;color:#235a7c">${t("src.wx")}</span></h3>
      <div class="wxsum"><span>${t("wx.rain30")}: <b>${fmt1(w.rain30)}</b> ${t("wx.mm")}</span></div>
      <div class="wx" aria-label="${t("wx.next7")}">${w.next.map(x => { const dd = new Date(x.d + "T12:00:00"); return `<div>${(I.lang === "kk" ? wk : wd)[dd.getDay()]}<b>${Math.round(x.tmax)}°</b>${Math.round(x.tmin)}°<br><span class="rain">${x.p >= 0.5 ? fmt1(x.p) : "·"}</span></div>`; }).join("")}</div>
      <p class="fine" style="margin:8px 0 0">${tip} Open-Meteo.</p></div>`;
  }

  function paneBrief(el) {
    el.innerHTML = briefHtml() + chainHtml() + movesHtml() + wxHtml() +
      (S.herds.length ? `<details class="more"><summary>${ic("chart")} ${t("brief.details")}</summary><div id="briefDetails"></div></details>` : "");
    bindZone(el);
    const det = $("#briefDetails", el);
    if (det) paneOverview(det);
    el.querySelectorAll("[data-how]").forEach(b => b.onclick = () => openHow(b.dataset.how));
    el.querySelectorAll("[data-goto]").forEach(b => b.onclick = () => renderPane(b.dataset.goto));
    const cp = $("#chainPlot", el);
    if (cp) cp.onchange = () => { S.chainId = cp.value; const y = scrollY; renderPane("brief"); scrollTo(0, y); const n = $("#chainPlot"); if (n) n.focus(); };
    const dt = $("#demoToggle", el);
    if (dt) dt.onclick = () => {
      S.herds = S.herds.filter(h => !h.demo);
      syncHash();
      render();
    };
    const add = $("#addDemo", el); if (add) add.onclick = () => { S.herds = demoHerds(); render(); };
    const add0 = $("#addHerd0", el); if (add0) add0.onclick = () => { addHerd(); renderPane("herds"); };
    const btn = $("#aiBriefBtn", el);
    if (btn) btn.onclick = async () => {
      btn.disabled = true;
      const box = $("#aiBox", el), k = briefKey();
      box.insertAdjacentHTML("beforeend", `<p class="fine" id="aiWait">${t("brief.aiWait")}</p>`);
      try {
        const r = await C.ai({ mode: "summary", lang: I.lang, context: aiContext() });
        S.aiBrief = { key: k, text: r.text, mark: aiMark(r) };
        if (S.tab === "brief") renderPane("brief");
      } catch (e) { const w = $("#aiWait", el); if (w) w.textContent = t("brief.aiFail") + ": " + errText(e); btn.disabled = false; }
    };
    loadWeather();
  }

  /** Пометка под ответом ИИ: шаблон без ИИ или числа, которых нет в расчёте (проверка на сервере, ai-facts.js). */
  function aiMark(r) {
    if (r.fallback) return `<p class="fine ai-mark">${t("ai.fallback")}</p>`;
    if (r.numbers && !r.numbers.ok) return `<p class="fine ai-mark warn">${t("ai.unverified", { n: esc(r.numbers.unknown.join(", ")) })}</p>`;
    return "";
  }

  /** Ответ ИИ: вывод, заголовки, пункты, выделенные числа и ярлыки источника (js/aitext.js; весь текст экранируется). */
  const aiText = text => (self.JaiylymAIText ? self.JaiylymAIText.toHtml(text, k => t("src." + k)) : `<p>${esc(text)}</p>`);
  /** Источники поиска Google под ответом ИИ (только http/https, открываются в новой вкладке). */
  function aiSources(list) {
    const ok = (list || []).filter(s => s && /^https?:\/\//.test(s.url || ""));
    if (!ok.length) return "";
    const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return u; } };
    return `<div class="ai-src"><p class="fine">${t("ai.sources")}</p><ol>${ok.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(s.title || host(s.url))}</a></li>`).join("")}</ol></div>`;
  }
  /** Подсказки поиска Google (обязательны по условиям Grounding): HTML от Google — в изолированном iframe без скриптов. */
  function aiSuggest(html) {
    if (!html) return "";
    return `<iframe class="ai-sugg" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" title="Google Search" srcdoc="${esc(html)}"></iframe>`;
  }

  /** Данные открытого села для ИИ: только то, что видит пользователь, с пометками источника. */
  function aiContext() {
    if (!S.D) return { село: null };
    const b = briefData();
    return {
      село: S.D.village.name, лето_снимков: S.D.source.year, снимков_безоблачных: S.D.source.dates.length,
      пастбища_с_водой_га: Math.round(b.water.reduce((s, p) => s + p.pasture_ha, 0)),
      ёмкость_всех_участков_с_водой_овец_за_сезон_оценка: Math.round(sheepOf(b.capAU)),
      поголовье_усл_голов: Math.round(b.au), поголовье_в_пересчёте_на_овец: Math.round(sheepOf(b.au)), сезон_дней: b.Sd,
      хватает_ли_корма: b.deficitT < 1 ? (b.ratio <= 0.7 ? "да, с запасом" : "да, впритык") : "нет, не на весь сезон",
      статус_плана: S.pl.status, версия_модели: M.MODEL_VERSION,
      прошлый_год: (c => c ? {
        годы: c.years, безоблачных_дат: c.dates, сравнение_надёжно: c.reliable, порог_изменения_ndvi_проц: c.threshold_pct,
        ndvi_медиана_изменения_проц: c.summary.ndvi_median_change_pct, участков_зеленее: c.summary.greener, участков_суше: c.summary.browner,
        участков_без_изменений: c.summary.same, устойчивая_вода_по_снимкам_га: c.summary.water_total_ha,
        участки: c.plots.map(x => ({ id: x.id, ndvi: x.ndvi, изменение_проц: x.ndvi_change_pct, вода_га: x.water_ha })),
      } : { статус: S.prev ? { loading: "считается", none: "нет безоблачных снимков", error: "не загрузилось" }[S.prev.state] || "нет" : "нет" })(prevCmp()),
      многолетний_ряд: (M => M && M.state === "ready" && M.a ? TR().aiFacts(M.a) : { статус: !M ? "нет" : { idle: "не посчитан (кнопка на вкладке «Данные»)", loading: "считается", error: "не посчитался" }[M.state] || "нет" })(S.multi),
      алгоритм: S.pl.algorithm === "fair-optimal-v2" ? "оптимизация: 1) у всех хозяйств одинаковая доля обеспеченности, насколько позволяют ограничения (max-min); 2) при этом максимум корма; 3) при тех же долях — меньше перегонов и коротких стоянок (< 14 дней), затем меньше км; затем календарь с учётом отдыха участков; приоритет хозяйств (если задан) действует только при нехватке"
        : "жадная эвристика (не оптимизатор)",
      доли_обеспеченности_проц: S.pl.shares ? Object.fromEntries(S.herds.filter(h => S.pl.shares[h.id] != null).map(h => [h.name, Math.round(S.pl.shares[h.id] * 100)])) : null,
      узкое_место: S.pl.bottleneck && S.pl.bottleneck.groups.length ? (g => ({ стада: g.herds.map(id => (S.herds.find(h => h.id === id) || {}).name || id),
        доступные_им_участки: g.plots, потребность_усл_гол_сут: Math.round(g.demand_au_days), ёмкость_этих_участков_усл_гол_сут: Math.round(g.capacity_au_days),
        не_хватает_усл_гол_сут: Math.round(g.shortfall_au_days),
        почему_другие_участки_недоступны: Object.fromEntries(Object.entries(g.excluded || {}).map(([r, ids]) => [r, { участки: ids,
          для_стад: ((g.excluded_for || {})[r] || []).map(id => (S.herds.find(h => h.id === id) || {}).name || id) }])) }))(S.pl.bottleneck.groups[0]) : null,
      модель_проверена_в_поле: M.fieldValidated(S.P), демо_стада: S.herds.some(h => h.demo),
      метаданные: M.metaOf(S.D),
      причины_дефицита: S.herds.filter(h => S.pl.unmet[h.id]).map(h => ({ стадо: h.name, причина: S.pl.diagnostics[h.id].reason,
        исключённые_участки: S.pl.diagnostics[h.id].excluded, не_хватает_дней: Math.round(S.P.season_days - S.pl.coverage[h.id]) })),
      что_можно_изменить: planSuggestions().map(sgText).map(x => x.replace(/<[^>]+>/g, "")),
      предупреждения: (S.pl.warnings || []).map(wrText).map(x => x.replace(/<[^>]+>/g, "")),
      норма_нагрузки_МСХ: (n => (n ? { источник: NM.SOURCE.title, область: regName(n.region), тип_пастбища: n.soft ? "не выбран — взята самая мягкая норма области" : n.type,
        состояние: n.state === "degraded" ? "деградированные" : "восстановленные", норма_га_на_овцу: +(n.au_ha * S.P.au.sheep).toFixed(2),
        участков_ограничено_нормой: normTotals(S.plots).limited, по_снимкам_овец: Math.round(normTotals(S.plots).sat), по_норме_овец: Math.round(normTotals(S.plots).norm), в_расчёте_овец: Math.round(normTotals(S.plots).cap) }
        : "область не определена — предел по норме не применён"))(NM && NM.pick(S.normSel)),
      где_селу_можно_пасти: zoneText().replace(/<[^>]+>/g, ""),
      // сверено с данными за то же время (web/kelisim.js); без имён дворов и без их текста
      наблюдения_людей: Object.entries(obsNow()).flatMap(([id, g]) => g.items.map(i => ({ участок: id, что: { no_grass: "мало травы", weeds: "бурьян, непоедаемая трава", no_water: "нет воды", far: "далеко" }[i.reason],
        когда_видели: i.dates.join(", ") || null, дворов: i.households.length, вывод: { check: "проверить на месте", match: "сходится с данными", other_time: "другое время, не сравнивать", no_date: "без даты, не сравнивать", info: "не сверяется" }[i.verdict],
        снимок_ближайшей_даты: i.scene ? { дата: i.scene, ndvi: i.ndvi } : null }))),
      нельзя_пасти: S.D.nograze && S.D.nograze.status === "ok" ? { источник: "OpenStreetMap: жильё, населённые пункты, фермы, промзоны", буфер_м: S.ngBuf,
        вычтено_из_пастбищ_га: Math.round(S.plots.reduce((s, p) => s + (p.nograze_ha || 0), 0)), зон: S.D.nograze.counts } : "не посчитано",
      участки: S.plots.map(p => ({ id: p.id, кольцо: p.ring === "near" ? "ближний" : "дальний", км_от_села: p.dist_km, направление: p.dir,
        нельзя_пасти_га_osm: p.nograze_ha != null ? p.nograze_ha : undefined,
        пастбищный_покров_га_спутник: p.pasture_ha_gross ?? p.pasture_ha, кормовая_площадь_га: p.pasture_ha, ndvi_спутник: p.ndvi, трава_за_лето_проц: (p.series || []).length >= 2 ? Math.round((p.series[p.series.length - 1].v - p.series[0].v) / p.series[0].v * 100) : null,
        качество_снимка: confidence(p), достоверность_корма: M.forageConfidence(p, S.P), статус_данных: capOf(p).status,
        вода: t("ws." + M.waterStatus(p)), закрыт_по_вводу: !!p.forbidden, отдых_выпас_только_дни: p.window ? `${p.window.from}-${p.window.to}` : undefined,
        ёмкость_овец_оценка: capOf(p).known ? Math.round(sheepOf(capOf(p).au_season)) : null,
        трава_слабее_обычной_норма_уменьшена_до_проц: (n => (n && n.green < 0.995 ? Math.round(n.green * 100) : undefined))(capOf(p).norm),
        что_ограничивает: capOf(p).limited_by ? (capOf(p).limited_by === "norm" ? "норма МСХ" : "трава по снимку") : undefined,
        как_рассчитано: J.explainCapacity(p, S.P).steps.map(s => `${s.key}: ${s.formula}`).join("; "),
        нагрузка_если_все_у_села_проц: S.cur.load[p.id].known ? Math.round(S.cur.load[p.id].load * 100) : null,
        нагрузка_по_плану_проц: S.pl.load[p.id].known ? Math.round(S.pl.load[p.id].load * 100) : null })),
      стада: S.herds.map(h => ({ имя: h.name, демо: !!h.demo, права_на_участки: h.allowed_plots && h.allowed_plots.length ? { участки: h.allowed_plots, источник: "ввод пользователя, не госреестр" } : "не указаны",
        овцы: h.sheep || 0, козы: h.goats || 0, крс: h.cattle || 0, лошади: h.horses || 0, дойное: !!h.daily_return,
        приоритет_при_нехватке: (+h.weight || 1) !== 1 ? +h.weight : undefined,
        усл_голов: Math.round(J.herdAU(h, S.P)), дней_корма_по_плану: Math.round((S.pl.coverage || {})[h.id] ?? b.Sd),
        маршрут: (S.pl.herdPlans[h.id] || []).map(s => `${s.plot || "нет корма"} д.${s.from}-${s.to}`).join("; ") })),
      итог: { перегружено_если_все_у_села: S.cur.overloaded, перегружено_по_плану: S.pl.overloaded,
        сено_сверх_нормы_т_если_все_у_села_оценка: Math.round(J.hayTonnes(S.cur.deficit_kg, S.P)), дефицит_сена_т_по_плану_оценка: Math.round(b.deficitT),
        чтобы_корма_хватило_сократить_на_усл_голов: Math.round(b.excessAU), чтобы_корма_хватило_сократить_на_овец: Math.round(sheepOf(b.excessAU)) },
      где_проверять_воду: (r => ({ вывод: { no_herds: "стада не внесены", no_deficit: "корма хватает: новый водопой сейчас корма не добавит", no_help: "корма не хватает, но ни один новый водопой дефицит не уменьшит", ok: "участки по снижению дефицита" }[r.status],
        участки: r.status !== "ok" ? [] : r.list.filter(w => w.gain_t).slice(0, 3).map(w => ({ участок: w.plot, дефицит_сена_меньше_на_т_оценка: Math.round(w.gain_t), стад_станет_лучше: w.better.length, стад_станет_хуже: w.worse.length || undefined, проверено_людьми: wcText(w.plot) })) }))(wellRank()),
      // почему план такой: проверяемые факты движка по каждому стаду (engine.explainPlan)
      почему_план: Object.values(J.explainPlan(S.plots, S.herds, S.pl, S.P)),
      погода: S.wx && !S.wx.fail ? { осадки_30_дней_мм: Math.round(S.wx.rain30), прогноз_7_дней: S.wx.next.map(x => `${x.d}: ${Math.round(x.tmin)}..${Math.round(x.tmax)}°C, ${x.p} мм`) } : null,
      параметры_модели: { кг_биомассы_на_ед_ndvi: S.P.k_ndvi, доля_стравливания: S.P.util, кг_корма_на_голову_в_сутки: S.P.intake, цена_сена_тенге_т: S.P.hay_price },
      мои_пастбища: ((C.user && C.user.pastures) || []).map(q => ({ название: q.name, га: q.area_ha, ndvi: q.stats && q.stats.ndvi })),
    };
  }

  // ---------- ИИ-помощник: отдельный чат ----------
  /**
   * ИИ-чат открыт без села: подгружаем последнее открытое село, если оно есть в кэше браузера (без сети и без ожидания),
   * иначе пример (первый из списка, с демо-стадами). Пользователь видит, на чьих данных отвечает помощник.
   */
  async function ensureChatVillage() {
    if (S.D || S.chatLoading) return false;
    S.chatLoading = true;
    try {
      const last = C.ls.get("jaiylym:last", null);
      // последнее открытое село пользователя (из кэша или заново по снимкам); не открылось — пример
      const own = last && last.name && (navigator.onLine || C.ls.get(cacheKey(last.lat, last.lon), null));
      if (own) { try { await openVillage(last.name, last.lat, last.lon, { keepRoute: true }); } catch (_) {} }
      const how = S.D ? "last" : "demo";
      if (!S.D) await openVillage(DEFAULT.village.name, DEFAULT.village.lat, DEFAULT.village.lon, { keepRoute: true, demo: true });
      S.chatAuto = how;
      return !!S.D;
    } finally { S.chatLoading = false; }
  }
  function renderAI() {
    if (!S.D) { ensureChatVillage().then(ok => { if (ok && S.route === "ai") renderAI(); }); }
    const el = $("#aiPage");
    const hist = (() => { try { return JSON.parse(sessionStorage.getItem("jaiylym:chat") || "[]"); } catch (_) { return []; } })();
    const ctxLine = S.D ? t("ai.ctx", { v: `${esc(S.D.village.name)} · ${S.plots.length} ${t("ai.plots")} · ${S.herds.length} ${t("sc.herds")}` }) +
      (S.chatAuto ? ` <a href="#/map">${S.chatAuto === "demo" ? t("ai.ctxDemo", { v: esc(S.D.village.name) }) : t("ai.ctxLast")}</a>` : "") : t("ai.loadingCtx");
    el.innerHTML = `<div class="chat"><div class="chat-head"><h1>${ic("spark")} ${t("ai.title")}</h1><p class="fine" style="margin:0">${t("ai.lead")}</p>
        <span class="chat-ctx">${ic("pin")} ${ctxLine}</span></div>
      <div class="chat-log" id="chatLog" aria-live="polite">${hist.map(m => `<div class="msg ${m.role}">${m.role === "ai" ? aiText(m.text) + aiSources(m.sources) : esc(m.text)}</div>`).join("")}</div>
      <div class="chips-q">${["ai.q1", "ai.q5", "ai.q6", "ai.q7", "ai.q8", "ai.q2", "ai.q3", "ai.q4"].map(k => `<button type="button" data-q="${esc(t(k))}">${t(k)}</button>`).join("")}</div>
      <form class="chat-form" id="chatForm"><textarea id="chatIn" rows="1" placeholder="${t("ai.ph")}" aria-label="${t("ai.ph")}"></textarea>
        <button class="btn btn-primary">${ic("send")} <span>${t("ai.send")}</span></button></form></div>
      <p class="fine" style="margin-top:10px">${t("ai.disclaimer")} ${t("ai.note")} ${hist.length ? `<button class="linkbtn" id="chatClear">${t("ai.clear")}</button>` : ""}</p>`;
    const log = $("#chatLog"), inp = $("#chatIn");
    log.scrollTop = log.scrollHeight;
    const send = async text => {
      text = text.trim(); if (!text) return;
      hist.push({ role: "user", text });
      log.insertAdjacentHTML("beforeend", `<div class="msg user">${esc(text)}</div><div class="msg ai" id="aiTyping">${t("ai.thinking")}</div>`);
      log.scrollTop = log.scrollHeight; inp.value = "";
      try {
        // вопрос о том, как менялась трава по годам, а ряд для этого села ещё не посчитан — сначала считаем (1–2 минуты)
        if (S.D && TR() && TR().asksYears(text) && S.multi && S.multi.state === "idle" && navigator.onLine) {
          const ty = $("#aiTyping"); if (ty) ty.textContent = t("ai.multiFirst");
          await runMulti();
          const ty2 = $("#aiTyping"); if (ty2) ty2.textContent = t("ai.thinking");
        }
        const r = await C.ai({ mode: "chat", lang: I.lang, context: aiContext(), messages: hist.slice(-10) });
        hist.push(Object.assign({ role: "ai", text: r.text }, r.sources && r.sources.length ? { sources: r.sources } : {}));
        $("#aiTyping").outerHTML = `<div class="msg ai">${aiText(r.text)}${aiMark(r)}${aiSources(r.sources)}${aiSuggest(r.suggestions)}</div>`;
      } catch (e) {
        hist.pop();
        $("#aiTyping").outerHTML = `<div class="msg ai err">${esc(t("brief.aiFail") + ": " + errText(e))}</div>`;
      }
      try { sessionStorage.setItem("jaiylym:chat", JSON.stringify(hist.slice(-30))); } catch (_) {}
      log.scrollTop = log.scrollHeight;
    };
    $("#chatForm").onsubmit = e => { e.preventDefault(); send(inp.value); };
    inp.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(inp.value); } };
    $$(".chips-q button", el).forEach(b => b.onclick = () => send(b.dataset.q));
    const clr = $("#chatClear"); if (clr) clr.onclick = () => { try { sessionStorage.removeItem("jaiylym:chat"); } catch (_) {} renderAI(); };
  }

  // ---------- настройки ----------
  function renderSettings() {
    const cal = S.calib || {};
    $("#setPage").innerHTML = `<div class="card">
        <div class="setrow"><span>${t("set.lang")}</span><div class="seg"><button data-l="ru" class="${I.lang === "ru" ? "on" : ""}">Русский</button><button data-l="kk" class="${I.lang === "kk" ? "on" : ""}">Қазақша</button></div></div>
        <div class="setrow"><span>${t("set.mode")}</span><div class="seg">${["current", "plan", "ndvi"].map(m => `<button data-m="${m}" class="${S.mode === m ? "on" : ""}">${t("map.mode." + m)}</button>`).join("")}</div></div>
        <div class="setrow"><span>${t("set.algo")}</span><div class="seg">${["optimized", "greedy"].map(a => `<button data-algo="${a}" class="${S.algo === a ? "on" : ""}">${t("algo." + a)}</button>`).join("")}</div></div></div>
      <div class="card"><h2>${ic("chart")} ${t("set.model")} ${src("model")}</h2><p class="fine">${t("set.modelNote")}</p>
        <p>${t("set.modelVer")}: <b>${M.MODEL_VERSION}</b> · ${t("set.field")}: <b>${M.fieldValidated(S.P) ? t("how.yes") : t("how.no")}</b></p>
        <div class="params">${paramInputs()}
          <label class="field">${t("set.veg")}<select id="setVeg">${M.VEGETATION.map(v => `<option value="${v}" ${S.P.vegetation_type === v ? "selected" : ""}>${t("veg." + v)}</option>`).join("")}</select><small class="fine">${t("set.vegNote")}</small></label></div>
        <button class="btn btn-ghost btn-sm" id="setReset">${t("params.reset")}</button></div>
      <form class="card" id="calibForm"><h2>${ic("leaf")} ${t("set.calib")}</h2><p class="fine">${t("set.calibD")}</p>
        <div class="formgrid"><label class="field">${t("set.calibK")}<input name="k" type="number" step="any" min="${M.SPEC.k_ndvi.min}" max="${M.SPEC.k_ndvi.max}" value="${cal.values ? cal.values.k_ndvi : ""}" required></label>
          <label class="field span2">${t("set.calibSrc")}<input name="src" maxlength="120" value="${esc(cal.source || "")}" required></label>
          <label class="field">${t("set.calibDate")}<input name="date" type="date" value="${esc(cal.date || "")}" required></label>
          <label class="check span4"><input type="checkbox" name="field" ${cal.field ? "checked" : ""}> ${t("set.calibField")}</label></div>
        <p class="perr" id="calibErr" hidden></p>
        <p style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-primary btn-sm">${t("set.calibSave")}</button>${S.calib ? `<button type="button" class="btn btn-ghost btn-sm" id="calibClear">${t("set.calibClear")}</button>` : ""}</p></form>
      <div class="card"><h2>${ic("send")} ${t("set.notify")}</h2><p>${t("set.notifyD")}</p><a class="btn btn-tg" href="https://t.me/JAIYLYM_bot" target="_blank" rel="noopener">${ic("send")} @JAIYLYM_bot</a></div>
      <div class="card"><h2>${ic("save")} ${t("set.data")}</h2><p style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-ghost btn-sm" id="setClear">${t("set.clear")}</button>
        <button class="btn btn-ghost btn-sm" id="setGuest">${t("set.clearGuest")}</button></p><p class="fine">${t("set.version")}: 2026.11 · ${esc(navigator.onLine ? "online" : "offline")}</p></div>`;
    $$("#setPage [data-l]").forEach(b => b.onclick = () => setLang(b.dataset.l));
    $$("#setPage [data-m]").forEach(b => b.onclick = () => { S.mode = b.dataset.m; C.ls.set("jaiylym:mode", S.mode); if (S.D) paintMap(); renderSettings(); });
    $$("#setPage [data-algo]").forEach(b => b.onclick = () => { S.algo = b.dataset.algo; C.ls.set("jaiylym:algo", S.algo); if (S.D) render(); renderSettings(); });
    $$("#setPage [data-param]").forEach(i => i.onchange = () => { if (setParam(i.dataset.param, i.value, i, $("#setPage")) && S.D) render(); });
    $("#setVeg").onchange = e => { S.userP = Object.assign({}, S.userP, { vegetation_type: e.target.value }); S.P = resolveParams(S.userP, S.calib); saveParams(); };
    $("#setReset").onclick = () => { S.userP = {}; S.P = resolveParams({}, S.calib); saveParams(); if (S.D) render(); renderSettings(); };
    $("#calibForm").onsubmit = ev => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const cal2 = { values: { k_ndvi: +fd.get("k") }, source: String(fd.get("src")).trim(), date: String(fd.get("date")), field: fd.get("field") === "on" };
      const r = M.validate(cal2.values);
      if (!r.ok) { const e = $("#calibErr"); e.hidden = false; e.textContent = t("set.bad", { v: fd.get("k"), r: r.errors[0].reason }); return; }
      S.calib = cal2; C.ls.set("jaiylym:calibration", cal2); S.P = resolveParams(S.userP, S.calib);
      if (S.D) render(); renderSettings(); toast(t("set.calibSaved"));
    };
    const cc = $("#calibClear"); if (cc) cc.onclick = () => { S.calib = null; C.ls.del("jaiylym:calibration"); S.P = resolveParams(S.userP, null); if (S.D) render(); renderSettings(); };
    $("#setClear").onclick = () => { try { Object.keys(localStorage).filter(k => k.startsWith("jaiylym:v")).forEach(k => localStorage.removeItem(k)); } catch (_) {} toast(t("set.cleared")); };
    $("#setGuest").onclick = () => { C.ls.del("jaiylym:guest:scenarios"); C.ls.del("jaiylym:guest:history"); toast(t("set.cleared")); };
  }

  // ---------- «Что это»: о продукте, как пользоваться, словарь, вопросы ----------
  function renderAbout() {
    $("#aboutPage").innerHTML = `<div class="about-hero"><h1>${t("ab.title")}</h1><p>${t("ab.lead")}</p>
        <p style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap"><a class="btn btn-primary" href="#/map">${ic("map")} ${t("nav.map")}</a><a class="btn btn-soft" href="#/ai">${ic("spark")} ${t("nav.ai")}</a></p></div>
      <div class="grid2"><div class="card"><h2>${t("ab.how")}</h2><ol class="howto"><li>${t("ab.h1")}</li><li>${t("ab.h2")}</li><li>${t("ab.h3")}</li><li>${t("ab.h4")}</li></ol></div>
        <div class="card"><h2>${t("ab.gloss")}</h2><dl class="gloss">${["ndvi", "au", "cap", "load", "jailau", "plots"].map(k => { const [a, ...rest] = t("ab.g." + k).split(" — "); return `<dt>${a}</dt><dd>${rest.join(" — ")}</dd>`; }).join("")}</dl></div></div>
      <div class="card faq"><h2>${t("ab.faq")}</h2>${[1, 2, 3].map(i => `<details><summary>${t("ab.f" + i + "q")}</summary><p>${t("ab.f" + i + "a")}</p></details>`).join("")}</div>
      <h2 style="margin-top:24px">${t("data.title")}</h2>`;
  }

  // ---------- главная ----------
  let heroMap = null, heroWatch = null;
  function heroMapVisible() {
    const el = $("#heroMap"); if (!el || typeof IntersectionObserver === "undefined") return true;
    const r = el.getBoundingClientRect(); return r.top < innerHeight + 200 && r.bottom > -200;
  }
  function lazyHeroMap() {
    if (heroWatch) return;
    heroWatch = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { heroWatch.disconnect(); heroWatch = null; heroForce = true; if (S.route === "home") renderHome(); } }, { rootMargin: "200px" });
    heroWatch.observe($("#heroMap"));
  }
  let heroForce = false;
  function renderHome() {
    // те же данные, что на карте: пастбище без жилья, ферм и промзон (OSM)
    const plots = (NG && DEFAULT.nograze && DEFAULT.nograze.status === "ok" ? NG.apply(DEFAULT.plots, DEFAULT.nograze, S.ngBuf) : DEFAULT.plots).map(p => Object.assign({}, p));
    const pl = J.solve(plots, DEFAULT.herds || DEMO_HERDS);
    // спутниковая карта на главной — только когда видна (на телефоне она ниже первого экрана): тайлы не отнимают канал у страницы
    if (window.L && !heroMap && !heroForce && !heroMapVisible()) { lazyHeroMap(); }
    else if (window.L && !heroMap) {
      heroMap = L.map("heroMap", { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false, tap: false });
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 17 }).addTo(heroMap);
      const smooth = PL.makePlots(DEFAULT.village.lat, DEFAULT.village.lon, 48);
      const g = L.featureGroup().addTo(heroMap);
      smooth.forEach(p => L.polygon(p.geometry.coordinates[0].map(([x, y]) => [y, x]), { color: "#ffffff", weight: 1.2, opacity: .85, fillColor: loadColor(pl.load[p.id].load), fillOpacity: 0.42, interactive: false }).addTo(g));
      setTimeout(() => { heroMap.invalidateSize(); heroMap.fitBounds(g.getBounds(), { padding: [20, 20] }); }, 60);
    } else if (!window.L) {
      $("#heroScheme").hidden = false;
      $("#heroScheme").innerHTML = scheme(plots, p => loadColor(pl.load[p.id].load), p => (pl.load[p.id].used ? pct(pl.load[p.id].load) : ""), { size: 320, dark: true });
    } else setTimeout(() => heroMap.invalidateSize(), 60);
    const ha = plots.reduce((s, p) => s + p.pasture_ha, 0);
    $("#heroStats").innerHTML = `<div><b>${plots.length}</b><span>${t("home.stat.plots")}</span></div><div><b>${DEFAULT.source.dates.length}</b><span>${t("home.stat.scenes")}</span></div><div><b>${fmt(ha)}</b><span>${t("home.stat.ha")}</span></div>`;
    $("#heroStatNote").textContent = `${t("home.stat.note", { v: exName(EXAMPLES[0]) })} ${DEFAULT.source.year}. ${t("map.mode.plan")}: ${t("herds.demo").toLowerCase()}.`;
    $("#heroBadge").textContent = "Sentinel-2 · " + exName(EXAMPLES[0]);
    $("#exBtns").innerHTML = EXAMPLES.map((e, i) => `<a class="btn ${i ? "btn-ghost" : "btn-soft"}" href="${villageHash(e.data.village, true)}">${t("home.demo", { v: esc(exName(e)) })}</a>`).join("");
    const last = C.ls.get("jaiylym:last", null), cb = $("#continueBtn");
    if (last && !exampleAt(last.lat, last.lon)) { cb.hidden = false; cb.textContent = t("home.continue") + last.name; cb.href = `#/map?lat=${last.lat}&lon=${last.lon}&name=${encodeURIComponent(last.name)}`; }
    else cb.hidden = true;
  }

  // ---------- язык, сеть, запуск ----------
  function setLang(l) {
    I.setLang(l);
    renameDemo();
    $$(".langsw button").forEach(b => b.setAttribute("aria-pressed", b.dataset.lang === I.lang));
    renderAccount();
    if (S.D) { rebuildPlots(); render(); }
    onRoute();
  }
  function netState() {
    $("#netbar").hidden = navigator.onLine;
    if (navigator.onLine && netState.was === false) toast(t("err.online"));
    netState.was = navigator.onLine;
  }

  async function init() {
    I.applyStatic();
    $$(".langsw button").forEach(b => { b.setAttribute("aria-pressed", b.dataset.lang === I.lang); b.onclick = () => setLang(b.dataset.lang); });
    document.documentElement.lang = I.lang === "kk" ? "kk" : "ru";
    bindSearch($("#heroSearch"), $("#heroQ"));
    bindSearch($("#mapSearch"), $("#mapQ"));
    $("#pickBtn").onclick = () => { if (S.noLeaflet) { toast(t("map.fallback"), true); return; } endDraw(); setPicking(!S.picking); };
    // числовые поля: при нажатии выделяем значение (чтобы «0» заменялся, а не дописывался), лишние нули убираем
    document.addEventListener("focusin", e => { if (e.target.matches && e.target.matches('input[type="number"]')) setTimeout(() => { try { e.target.select(); } catch (_) {} }, 0); });
    document.addEventListener("input", e => {
      const el = e.target;
      if (el.matches && el.matches('input[type="number"]') && /^0\d/.test(el.value)) el.value = String(Math.round(+el.value));
    });
    $("#drawBtn").onclick = () => (S.draw ? endDraw() : startZone());
    // телефон: итог и план — под картой; кнопка на карте прокручивает к ним
    $("#toResult").onclick = () => { const pnl = $(".panel"); if (pnl) pnl.scrollIntoView({ behavior: "smooth", block: "start" }); };
    $("#drawUndo").onclick = undoDraw;
    $("#drawCancel").onclick = endDraw;
    $("#drawDone").onclick = finishDraw;
    document.addEventListener("keydown", e => { if (S.draw && e.key === "Escape") endDraw(); if (S.draw && e.key === "Enter" && !e.target.closest("input,textarea")) finishDraw(); });
    $$(".modes button").forEach(b => b.onclick = () => { S.mode = b.dataset.mode; paintMap(); if (S.tab === "plots") renderPane("plots"); });
    $$(".tabs [data-tab]").forEach(b => b.onclick = () => renderPane(b.dataset.tab));
    $(".tabs").addEventListener("keydown", e => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const bs = $$(".tabs [data-tab]"), i = bs.findIndex(b => b.getAttribute("aria-selected") === "true");
      const n = bs[(i + (e.key === "ArrowRight" ? 1 : bs.length - 1)) % bs.length]; n.focus(); renderPane(n.dataset.tab);
    });
    $("#saveScBtn").onclick = () => saveScenario(false);
    $("#publishBtn").onclick = () => saveScenario(true);
    $("#pdfBtn").onclick = async () => {
      if (!S.D) return;
      toast(t("rep.making"));
      try { await window.Report.export(reportCtx()); C.addHistory({ kind: "pdf", village: S.D.village, summary: summary() }); metric("pdf"); }
      catch (e) { toast(t("rep.printFallback"), true); }
    };
    $("#accountBtn").onclick = () => (C.loggedIn ? go("profile") : openLogin("login"));
    const more = $("#moreDlg");
    $("#moreBtn").onclick = () => more.showModal();
    more.addEventListener("click", e => { if (e.target === more || e.target.closest("a")) more.close(); });
    $("#loginDlg").addEventListener("close", () => clearTimeout(pollTimer));
    window.addEventListener("hashchange", onRoute);
    window.addEventListener("online", netState); window.addEventListener("offline", netState);
    netState();
    onRoute();
    if (C.loggedIn) { try { await C.me(); } catch (_) {} renderAccount(); if (S.D) { addOwnFarm(); render(); } if (["profile", "coord", "scenarios"].includes(S.route)) onRoute(); }
    else renderAccount();
    // офлайн-кэш: на https и на локальном сервере (безопасный контекст — так офлайн-режим проверяется автотестом)
    if ("serviceWorker" in navigator && (location.protocol === "https:" || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // данные для PDF-отчёта
  function reportCtx() {
    let scen = [];
    try { const o = { algorithm: S.algo }; scen = S.herds.length ? J.compareScenarios(S.plots, S.herds, S.P, J.defaultVariants(S.plots, S.herds, S.P, o), o) : []; } catch (_) {}
    return { t, fmt, fmt1, pct, esc, src, J, M, S, scheme, loadColor, confidence, summary: summary(), trend: trendLine(), lang: I.lang,
      norm: (n => { if (!n) return ""; const tt = normTotals(S.plots), kv = fmt2(n.au_ha * S.P.au.sheep);
        return `${t("nm.source")}. ${n.soft ? t("nm.noteSoft", { r: esc(regName(n.region)), n: kv }) : t("nm.noteRow", { ty: esc(n.type), n: kv, s: t(n.state === "degraded" ? "nm.degraded" : "nm.restored") })} ${t("nm.sum", { sat: fmt(tt.sat), norm: fmt(tt.norm), cap: fmt(tt.cap) })} ${t("nm.sumK", { k: tt.limited, n: tt.n })}`; })(NM && NM.pick(S.normSel)),
      zone: zoneText(), wells: wellRank(), wcText, planSuggestions, meta: M.metaOf(S.D), scenarios: scen, variantName, sgText, wrText, whyHerd, dateStr, algoLine, bottleneckHtml };
  }

  // Келісім — согласование плана между дворами (js/kelisim-ui.js)
  const Kel = !window.KelisimUI ? { route() {} } : window.KelisimUI({ t, I, S, C, J, M, K: window.JaiylymKelisim, NM, $, $$, esc, ic, src, fmt, fmt1, pct, dateStr, pillStyle, loadColor, scheme, toast, go, errText, openVillage, exampleAt, EXAMPLES, exName, regName, phone, zoneText, closedDlg, startZone, zoneHa });
  $("#kelBtn").onclick = () => go("kelisim", "new=1");

  window.JaiylymApp = { S, openVillage, render, summary, confidence, scheme, reportCtx, Kel, pickVillageOnMap, aiContext, briefData, openHow, renderPane, rebuildPlots, setZone };   // для отладки и тестов
  init();
})();
