/* Jaiylym — интерфейс приложения.
 * Расчёты — web/engine.js (без изменений), спутник — web/pipeline.js, сервер — js/client.js. */
(function () {
  "use strict";
  const J = window.Jaiylym, PL = window.JaiylymPipeline, C = window.Client, I = window.I18N, t = I.t;
  const DEFAULT = window.JAIYLYM_DATA, DEMO_HERDS = window.JAIYLYM_HERDS;
  const BOT = "JAIYLYM_bot";
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  // числа и даты в казахстанском формате для обоих языков: 1 234,5 и 21.11.2026 14:05
  const fmt = n => Math.round(n).toLocaleString("ru-RU");
  const fmt1 = n => (+n).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  const two = n => String(n).padStart(2, "0");
  const dateStr = (s, time = true) => { const d = new Date(s); if (isNaN(d)) return ""; return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()}` + (time ? ` ${two(d.getHours())}:${two(d.getMinutes())}` : ""); };
  const pct = x => (isFinite(x) ? Math.round(x * 100).toLocaleString("ru-RU") + " %" : "∞");
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ic = id => `<svg class="ic"><use href="#i-${id}"/></svg>`;
  const src = k => `<span class="src src-${k}">${t("src." + k)}</span>`;
  const coord = x => (x < 0 ? "m" : "") + Math.round(Math.abs(x) * 1000);
  const isKegen = (lat, lon) => Math.abs(lat - DEFAULT.village.lat) < 0.01 && Math.abs(lon - DEFAULT.village.lon) < 0.01;

  // ---------- состояние ----------
  const S = {
    D: null, plots: [], baseWater: {}, added: new Set(), herds: [], P: J.params(C.ls.get("jaiylym:params", null) || {}),
    mode: C.ls.get("jaiylym:mode", "plan"), tab: "brief", cur: null, pl: null, botSubs: {}, picking: false, wx: null, aiBrief: null,
    map: null, layers: {}, group: null, ndviLayer: null, png: null, route: "home", loadingKey: null, histKey: null,
  };

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
  const loadColor = x => (!x ? "#9aa29a" : x <= 0.7 ? "#3e8e5a" : x <= 1 ? "#c9970f" : "#bf4a2a");
  const ndviColor = v => (v == null ? "#9aa29a" : v < 0.18 ? "#8c510a" : v < 0.25 ? "#d8b56a" : v < 0.32 ? "#9fd068" : "#2f9a4b");
  // Достоверность спутникового показателя участка: число безоблачных снимков (series) и площадь пастбища
  function confidence(p) {
    if (p.ndvi == null || p.pasture_ha < 20) return "low";
    const n = (p.series || []).length;
    if (n >= 4 && p.pasture_ha >= 100) return "high";
    if (n >= 2) return "medium";
    return "low";
  }
  const confTag = p => { const c = confidence(p); return `<span class="conf conf-${c}">${t("conf." + c)}</span>`; };
  const botLink = plotId => `https://t.me/${BOT}?start=` + (S.D ? (plotId
    ? `p_${coord(S.D.village.lat)}_${coord(S.D.village.lon)}_${PL.plotCode(plotId)}`
    : `v_${coord(S.D.village.lat)}_${coord(S.D.village.lon)}`) : "");

  async function askText(title, value) {
    return new Promise(resolve => {
      const d = document.createElement("dialog");
      d.className = "modal";
      d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><label class="field"><input name="v" maxlength="80" value="${esc(value)}" required></label>
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
    return { route: ["home", "map", "scenarios", "profile", "coord", "about", "ai", "settings"].includes(r) ? r : "home", q: new URLSearchParams(m[2] || "") };
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
        const extra = { plot: q.get("plot"), pasture: q.get("pasture"), draw: q.get("draw") === "1" };
        if (!same || pend) openVillage(q.get("name") || "Село", lat, lon, Object.assign(extra, pend || {}));
        else {
          if (extra.plot) focusPlot(extra.plot);
          if (extra.pasture) focusPasture(extra.pasture);
          if (extra.draw) startDraw();
        }
      } else if (!S.D) {
        const last = C.ls.get("jaiylym:last", null), extra = { draw: q.get("draw") === "1" };
        if (last) openVillage(last.name, last.lat, last.lon, extra); else openVillage(DEFAULT.village.name, DEFAULT.village.lat, DEFAULT.village.lon, extra);
      } else if (q.get("draw") === "1") setTimeout(startDraw, 100);
      setTimeout(() => S.map && S.map.invalidateSize(), 50);
    }
    if (route === "home") renderHome();
    if (route === "scenarios") renderScenarios();
    if (route === "profile") renderProfile();
    if (route === "coord") renderCoord();
    if (route === "about") { renderAbout(); renderDataPage(); }
    if (route === "ai") renderAI();
    if (route === "settings") renderSettings();
    const more = $("#moreDlg"); if (more && more.open) more.close();
    window.scrollTo(0, 0);
  }

  // ---------- карта ----------
  function ensureMap() {
    if (S.map || S.noLeaflet) return;
    if (!window.L) { S.noLeaflet = true; $("#map").hidden = true; $("#schemeMap").hidden = false; return; }
    S.map = L.map("map", { zoomControl: true, attributionControl: true, maxZoom: 19 }).setView([DEFAULT.village.lat, DEFAULT.village.lon], 12);
    // снимки Esri есть до 17 уровня; дальше карта увеличивает их, чтобы можно было точнее ставить точки
    const tiles = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxNativeZoom: 17, maxZoom: 19, attribution: "Esri World Imagery · Sentinel-2 ESA Copernicus · © OpenStreetMap",
    }).addTo(S.map);
    let tileErrors = 0;
    tiles.on("tileerror", () => { if (++tileErrors === 6 && !navigator.onLine) toast(t("map.fallback"), true); });
    S.group = L.layerGroup().addTo(S.map);
    S.pastGroup = L.layerGroup().addTo(S.map);
    new ResizeObserver(() => S.map.invalidateSize()).observe($("#map"));
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

  function drawVillage() {
    S.layers = {};
    if (S.noLeaflet) return;            // запасная схема рисуется в paintMap(), когда нагрузка уже посчитана
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
      poly.bindTooltip("", { permanent: true, direction: "center", className: "plabel" });
      poly.on("click", () => { if (!S.picking && !S.draw) openPlot(p.id); });
      S.layers[p.id] = poly;
    }
    const b = L.latLngBounds(S.plots.flatMap(p => p.geometry.coordinates[0].map(([x, y]) => [y, x])));
    S.map.invalidateSize(); S.map.fitBounds(b, { padding: [12, 12] });
    drawPastures();
  }

  // ---------- свои пастбища: фермер рисует контур, NDVI считается по снимкам внутри него ----------
  const farmAU = () => (C.user && C.user.farm ? J.herdAU(C.user.farm, S.P) : 0);
  function pastConf(st, area) {
    const n = (st.series || []).length;
    if (st.ndvi == null || area < 1) return "low";
    if (n >= 4 && area >= 5) return "high";
    return n >= 2 ? "medium" : "low";
  }
  function pastureRows(st, area, water) {
    const cap = J.plotCapacity({ ndvi: st.ndvi, pasture_ha: st.pasture_ha }, S.P);
    const au = farmAU(), load = au && cap.au_days > 0 ? au * S.P.season_days / cap.au_days : null;
    const c = pastConf(st, area);
    return `<table><tbody>
      <tr><td>${t("past.area")}</td><td>${fmt1(area)} ${t("common.ha")} ${src("input")}</td></tr>
      <tr><td>${t("past.usable")}</td><td>${fmt1(st.pasture_ha)} ${t("common.ha")} ${src("sat")}</td></tr>
      <tr><td>NDVI ${st.year || ""}</td><td>${st.ndvi ?? "—"} ${src("sat")} <span class="conf conf-${c}">${t("conf." + c)}</span></td></tr>
      <tr><td>${t("past.cap")}</td><td>≈ ${fmt(cap.au_season / S.P.au.sheep)} ${t("pop.sheep")} ${src("model")}</td></tr>
      <tr><td>${t("past.myLoad")}</td><td>${load == null ? `<small>${t("past.noFarm")}</small>` : `<b style="color:${loadColor(load)}">${pct(load)}</b> ${src("model")}`}</td></tr>
      <tr><td>${t("pop.water")}</td><td>${water ? t("pop.hasWater").replace(/ \(.*\)/, "") : "—"}${st.water_on_map ? ` (${t("past.waterMap")})` : ""}</td></tr>
      </tbody></table>${spark(st.series)}
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
    L.popup({ maxWidth: 300, maxHeight: Math.max(220, $("#map").clientHeight - 120), autoPanPaddingTopLeft: [16, 70] })
      .setLatLng(lay.getBounds().getCenter()).setContent(pastureHtml(q)).openOn(S.map);
  }
  function focusPasture(id) {
    const lay = S.pastLayers && S.pastLayers[id];
    if (!lay) return;
    S.map.fitBounds(lay.getBounds(), { padding: [50, 50], maxZoom: 15, animate: false });
    openPasture(id);
  }

  function startDraw() {
    if (S.noLeaflet || !S.map) { toast(t("past.noMap"), true); return; }
    if (S.draw) return;
    setPicking(false);
    S.map.closePopup();
    S.draw = { pts: [], line: L.polyline([], { color: "#e3b25c", weight: 3, dashArray: "6 5" }).addTo(S.map), marks: L.layerGroup().addTo(S.map) };
    $("#map").classList.add("drawing");
    $("#drawbar").hidden = false;
    updateDrawHint();
  }
  function updateDrawHint() {
    $("#drawHint").textContent = t("past.drawHint", { n: S.draw ? S.draw.pts.length : 0 });
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
          : `<button class="btn btn-tg" id="pSave">${ic("send")} ${t("past.loginSave")}</button>`}</p>`;
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
        stats: { ndvi: st.ndvi, series: st.series, pasture_ha: st.pasture_ha, wc_pasture_share: st.wc_pasture_share, water_on_map: st.water_on_map, year: st.year } });
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
    if (isKegen(lat, lon)) { data = JSON.parse(JSON.stringify(DEFAULT)); png = "data/ndvi.png"; }
    else {
      const hit = C.ls.get(key, null);
      if (hit && hit.plots) { data = hit; png = hit.png; delete data.png; data.village.name = name || data.village.name; }
    }
    if (!data) {
      if (!navigator.onLine) { status(t("err.offline"), { err: true }); return; }
      try {
        const res = await PL.buildVillage({ name, lat, lon, onProgress: m => {
          const k = /снимк.*Sentinel/.test(m) ? "st.scenes" : /Загружаю/.test(m) ? "st.loading" : "st.computing";
          status(t(k), { busy: true });
        } });
        if (S.loadingKey !== key) return;                      // пока считали, выбрали другое место
        png = ndviPng(res.grid); delete res.grid;
        data = res;
        C.ls.set(key, Object.assign({}, res, { png }));
      } catch (e) {
        if (S.loadingKey === key) status(t("err.build") + ": " + e.message, { err: true });
        return;
      }
    }
    status("");
    S.D = data; S.png = png;
    S.baseWater = Object.fromEntries(data.plots.map(p => [p.id, p.water]));
    S.added = new Set((opts.water || []).filter(id => S.baseWater[id] === false));
    if (opts.params) Object.assign(S.P, opts.params);
    rebuildPlots();
    S.herds = opts.herds ? opts.herds.map(h => Object.assign({}, h)) : (isKegen(lat, lon) && C.ls.get("jaiylym:demo", true) ? DEMO_HERDS.map(h => Object.assign({ demo: true }, h)) : []);
    addOwnFarm();
    S.botSubs = {};
    C.ls.set("jaiylym:last", { name: data.village.name, lat: data.village.lat, lon: data.village.lon });
    history.replaceState(null, "", `#/map?lat=${data.village.lat}&lon=${data.village.lon}&name=${encodeURIComponent(data.village.name)}`);
    $("#mapQ").value = data.village.name;
    $("#tgVillage").href = botLink();
    drawVillage();
    render();
    if (!opts.herds) loadBotData();
    if (S.histKey !== key) { S.histKey = key; C.addHistory({ kind: "open", village: data.village, summary: summary() }); }
    const want = opts.plot;
    if (want) setTimeout(() => focusPlot(want), 350);
    if (opts.pasture) setTimeout(() => focusPasture(opts.pasture), 400);
    if (opts.draw) setTimeout(startDraw, 450);
  }

  function rebuildPlots() {
    S.plots = S.D.plots.map(p => Object.assign({}, p, {
      water: S.baseWater[p.id] || S.added.has(p.id),
      water_source: S.added.has(p.id) ? t("pop.hasWater") : p.water_source,
    }));
  }
  function addOwnFarm() {
    const u = C.user;
    S.herds = S.herds.filter(h => !h.mine);
    if (!u || !u.farm || !S.D) return;
    const f = u.farm;
    if (Math.abs(f.village.lat - S.D.village.lat) > 0.0015 || Math.abs(f.village.lon - S.D.village.lon) > 0.0015) return;
    S.herds.unshift({ id: "mine", mine: true, name: f.name, sheep: f.sheep, goats: f.goats, cattle: f.cattle, horses: f.horses, home: f.home, daily_return: f.daily_return });
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
    const cur = J.current(S.plots, S.herds, S.P), pl = J.plan(S.plots, S.herds, S.P);
    return { overloaded_before: cur.overloaded, overloaded_after: pl.overloaded,
      excess_t: +J.hayTonnes(cur.deficit_kg, S.P).toFixed(1), deficit_t: +J.hayTonnes(pl.deficit_kg, S.P).toFixed(1),
      herds: S.herds.length, au: Math.round(S.herds.reduce((s, h) => s + J.herdAU(h, S.P), 0)), water_added: [...S.added] };
  }

  function render() {
    if (!S.D) return;
    S.cur = J.current(S.plots, S.herds, S.P);
    S.pl = J.plan(S.plots, S.herds, S.P);
    const past = S.plots.reduce((s, p) => s + p.pasture_ha, 0);
    $("#vtitle").innerHTML = `<b>${esc(S.D.village.name)}</b> · Sentinel-2, ${S.D.source.year} · ${fmt(past)} ${t("common.ha")} ${src("sat")}`;
    paintMap();
    renderPane(S.tab);
  }

  function plotLabel(p) {
    const r = S.mode === "current" ? S.cur : S.pl, l = r.load[p.id];
    const small = window.matchMedia("(max-width: 860px)").matches;
    if (S.mode === "ndvi") return `${p.id}<br>${p.ndvi ?? "—"}`;
    return l.used ? `${p.id}<br>${pct(l.load)}` : (small ? p.id : `${p.id}<br>${t("map.free")}`);
  }
  function plotFill(p) {
    const r = S.mode === "current" ? S.cur : S.pl;
    return S.mode === "ndvi" ? ndviColor(p.ndvi) : loadColor(r.load[p.id].load);
  }
  function paintMap() {
    if (S.noLeaflet) { renderSchemeMap(); }
    else {
      for (const p of S.plots) {
        const lay = S.layers[p.id]; if (!lay) continue;
        lay.setStyle({ fillColor: plotFill(p), fillOpacity: S.mode === "ndvi" ? 0.06 : 0.5, color: p.water ? "#8fd3ff" : "#ffffff",
          weight: p.water && p.ring === "far" ? 2.6 : 1.2, dashArray: p.water ? null : "4 4" });
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
    lg.innerHTML = S.mode === "ndvi"
      ? `<b>${t("map.legend.ndvi")} ${S.D.source.year}</b><i style="background:#2f9a4b"></i>${t("map.legend.dense")}<br><i style="background:#9fd068"></i>${t("map.legend.mid")}<br><i style="background:#d8b56a"></i>${t("map.legend.sparse")}<br><i style="background:#8c510a"></i>${t("map.legend.none")}<br><small>${t("map.legend.nonpasture")}</small>`
      : `<b>${t("map.legend.load")}</b><i style="background:#3e8e5a"></i>${t("map.legend.ok")}<br><i style="background:#c9970f"></i>${t("map.legend.warn")}<br><i style="background:#bf4a2a"></i>${t("map.legend.bad")}<br><i style="background:#9aa29a"></i>${t("map.legend.idle")}<br><i style="border:2px solid #2f7aa6"></i>${t("map.legend.water")}<br><i style="border:1.5px dashed #555"></i>${t("map.legend.nowater")}`;
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
      const stroke = p.water && p.ring === "far" ? "#8fd3ff" : (dark ? "#1b3f30" : "#ffffff");
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
      scheme(S.plots, plotFill, p => { const l = (S.mode === "current" ? S.cur : S.pl).load[p.id]; return S.mode === "ndvi" ? String(p.ndvi ?? "—") : (l.used ? pct(l.load) : ""); }, { size: 520, interactive: true });
    el.querySelectorAll("[data-plot]").forEach(g => {
      g.onclick = () => openPlot(g.dataset.plot);
      g.onkeydown = e => { if (e.key === "Enter") openPlot(g.dataset.plot); };
    });
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
    const c = J.plotCapacity(p, S.P), l = (S.mode === "current" ? S.cur : S.pl).load[p.id];
    const names = l.herds.map(x => (S.herds.find(h => h.id === x.herd) || {}).name).filter(Boolean);
    const ndviRow = p.ndvi_base != null ? `${p.ndvi_base} → ${p.ndvi}` : (p.ndvi ?? "—");
    return `<div class="pop"><h3 style="margin:0 0 6px">${esc(p.id)} <small style="font-weight:500;color:#627064">${p.ring === "near" ? t("pop.near") : t("pop.far")}, ~${p.dist_km} ${t("common.km")}, ${p.dir}</small></h3>
      <table><tbody>
      <tr><td>${t("pop.pasture")}</td><td>${fmt(p.pasture_ha)} ${t("common.ha")} ${src("sat")}</td></tr>
      <tr><td>${t("pop.ndvi")}${p.ndvi_base != null ? ` ${S.D.source.base_year} → ${S.D.source.year}` : ""}</td><td>${ndviRow} ${src("sat")}</td></tr>
      <tr><td>${t("pop.conf")}</td><td>${confTag(p)}</td></tr>
      <tr><td>${t("pop.forage")}</td><td>${fmt(c.forage / 1000)} ${t("pop.t")} ${src("model")}</td></tr>
      <tr><td>${t("pop.cap")}</td><td>≈ ${fmt(c.au_season / S.P.au.sheep)} ${t("pop.sheep")} ${src("model")}</td></tr>
      <tr><td>${t("pop.load")}</td><td><b>${pct(l.load)}</b> (${S.mode === "current" ? t("kpi.before") : t("kpi.after")})</td></tr>
      <tr><td>${t("pop.herds")}</td><td style="white-space:normal">${esc(names.join(", ")) || "—"}</td></tr>
      <tr><td>${t("pop.water")}</td><td style="white-space:normal">${esc(p.water_source)}</td></tr>
      </tbody></table>
      ${spark(p.series)}
      ${p.ring === "far" && S.baseWater[p.id] === false ? `<label class="check" style="margin-top:8px"><input type="checkbox" data-water="${p.id}" ${S.added.has(p.id) ? "checked" : ""}> ${t("pop.hasWater")} ${src("input")}</label>` : ""}
      <a class="btn btn-tg btn-sm" style="width:100%;margin-top:10px;color:#fff" href="${botLink(p.id)}" target="_blank" rel="noopener">${ic("send")} ${t("pop.subscribe")}</a>
      ${S.botSubs[p.id] ? `<p class="fine" style="margin:6px 0 0">${t("pop.subsCount", { n: S.botSubs[p.id] })}</p>` : ""}</div>`;
  }
  function bindPlotHtml(root) {
    root.querySelectorAll("[data-water]").forEach(chk => chk.onchange = () => { toggleWater(chk.dataset.water, chk.checked); });
  }
  let plotDlg;
  function openPlot(id) {
    const p = S.plots.find(x => x.id === id); if (!p) return;
    if (!S.noLeaflet && S.layers[id]) {
      const h = $("#map").clientHeight;
      const pop = L.popup({ maxWidth: 300, maxHeight: Math.max(220, h - 120), autoPanPaddingTopLeft: [16, 70], autoPanPaddingBottomRight: [16, 16] })
        .setLatLng(S.layers[id].getBounds().getCenter()).setContent(plotHtml(p)).openOn(S.map);
      bindPlotHtml(pop.getElement());
      return;
    }
    plotDlg = plotDlg || Object.assign(document.createElement("dialog"), { className: "modal" });
    if (!plotDlg.isConnected) document.body.appendChild(plotDlg);
    plotDlg.innerHTML = `<form method="dialog" class="modal-x"><button aria-label="${t("common.close")}">${ic("x")}</button></form>` + plotHtml(p);
    bindPlotHtml(plotDlg);
    plotDlg.showModal();
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
    S.tab = tab;
    $$(".tabs [data-tab]").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === tab));
    $$(".pane").forEach(p => { p.hidden = p.dataset.pane !== tab; });
    const el = $(`.pane[data-pane="${tab}"]`);
    ({ brief: paneBrief, overview: paneBrief, herds: paneHerds, routes: paneRoutes, water: paneWater, plots: panePlots, data: paneData })[tab](el);
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
      $("#addDemo", el).onclick = () => { S.herds = DEMO_HERDS.map(h => Object.assign({ demo: true }, h)); render(); };
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
  function paramsBlock() {
    const f = [["season_days", "params.season"], ["intake", "params.intake"], ["util", "params.util"], ["k_ndvi", "params.k"], ["hay_price", "params.hay"]];
    return `<details class="params"><summary>${t("params.title")} ${src("model")} ${src("input")}</summary>
      ${f.map(([k, l]) => `<label class="field">${t(l)}<input type="number" step="any" min="0" data-param="${k}" value="${S.P[k]}"></label>`).join("")}
      <button class="linkbtn" data-reset>${t("params.reset")}</button></details>`;
  }
  function bindParams(el) {
    el.querySelectorAll("[data-param]").forEach(i => i.onchange = () => {
      const v = +i.value; if (!Number.isFinite(v) || v <= 0) { i.value = S.P[i.dataset.param]; return; }
      S.P[i.dataset.param] = v; saveParams(); render();
    });
    const r = el.querySelector("[data-reset]"); if (r) r.onclick = () => { S.P = J.params(); saveParams(); render(); };
  }

  function addHerd() {
    S.herds.push({ id: "h" + Date.now().toString(36), name: t("herds.farm") + " " + (S.herds.length + 1), sheep: 300, goats: 0, cattle: 0, horses: 0, home: "Б-С", daily_return: false });
    render();
  }
  function paneHerds(el) {
    const near = S.plots.filter(p => p.ring === "near").map(p => p.id);
    const tag = h => h.mine ? `<span class="tag tag-mine">${t("herds.mine")}</span>` : h.from_bot ? `<span class="tag tag-tg">${t("herds.tg")}</span>` : h.demo ? `<span class="tag">${t("herds.demo")}</span>` : "";
    el.innerHTML = S.herds.map((h, i) => `<div class="herd" data-i="${i}">
        <div class="herd-head"><input data-k="name" value="${esc(h.name)}" aria-label="${t("herds.name")}" ${h.mine || h.from_bot ? "readonly" : ""}>${tag(h)}
          ${h.mine || h.from_bot ? "" : `<button class="btn btn-ghost btn-sm" data-del aria-label="${t("herds.remove")}">${ic("trash")}</button>`}</div>
        <div class="herd-grid">
          ${["sheep", "goats", "cattle", "horses"].map(k => `<label class="field">${t("herds." + k)}<input type="number" inputmode="numeric" min="0" step="10" data-k="${k}" value="${h[k] || 0}" ${h.mine || h.from_bot ? "readonly" : ""}></label>`).join("")}
        </div>
        <div class="herd-foot">
          <label class="field" style="flex-direction:row;align-items:center;gap:8px">${t("herds.home")}<select data-k="home" ${h.mine || h.from_bot ? "disabled" : ""}>${near.map(id => `<option ${id === h.home ? "selected" : ""}>${id}</option>`).join("")}</select></label>
          <label class="check"><input type="checkbox" data-k="daily_return" ${h.daily_return ? "checked" : ""} ${h.mine || h.from_bot ? "disabled" : ""}> ${t("herds.daily")}</label>
          <span class="au">${fmt(J.herdAU(h, S.P))} ${t("herds.au")} ${src("input")}</span>
        </div></div>`).join("") +
      `<button class="btn btn-soft" id="addHerd">${ic("plus")} ${t("herds.add")}</button><p class="note">${t("herds.note")}</p>`;
    $$(".herd", el).forEach(card => {
      const h = S.herds[+card.dataset.i];
      card.querySelectorAll("[data-k]").forEach(inp => inp.onchange = () => {
        const k = inp.dataset.k;
        h[k] = inp.type === "checkbox" ? inp.checked : inp.type === "number" ? Math.max(0, Math.round(+inp.value || 0)) : inp.value;
        if (inp.type === "number") inp.value = h[k];
        delete h.demo;
        S.cur = J.current(S.plots, S.herds, S.P); S.pl = J.plan(S.plots, S.herds, S.P); paintMap();
        card.querySelector(".au").innerHTML = `${fmt(J.herdAU(h, S.P))} ${t("herds.au")} ${src("input")}`;
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
      const why = cov < Sd - 0.5 ? `<p class="note warn" style="margin:-6px 0 14px">${t("routes.short", { d: Math.max(1, Math.round(cov)) })}</p>` : "";
      return `<div class="rname"><span>${esc(h.name)}</span><small>${fmt(J.herdAU(h, S.P))} ${t("herds.au")}</small></div><div class="tl" role="img" aria-label="${esc(h.name)}">${bars}</div>${why}`;
    }).join("") + `<p class="note">${t("routes.note", { d: Sd })} ${src("model")}</p>`;
  }

  function paneWater(el) {
    const ws = J.wells(S.plots, S.P);
    const baseOnly = S.D.plots.map(p => Object.assign({}, p, { water: S.baseWater[p.id] }));
    const before = J.plan(baseOnly, S.herds, S.P);
    const added = [...S.added];
    el.innerHTML = `<h3>${ic("drop")} ${t("water.title")} ${src("model")}</h3>
      ${ws.length ? `<ul class="list">${ws.map((w, i) => `<li class="row"><div class="grow"><b>${i + 1}. ${esc(w.plot)}</b><small>${t("water.opens", { n: fmt(w.sheep) })}</small></div>
        <div class="btns"><button class="btn btn-soft btn-sm" data-add="${w.plot}">${ic("plus")} ${t("water.add")}</button></div></li>`).join("")}</ul>` : `<p class="empty">${t("water.none")}</p>`}
      ${added.length ? `<h3>${t("water.added")} ${src("input")}</h3><ul class="list">${added.map(id => `<li class="row"><div class="grow"><b>${esc(id)}</b></div>
        <div class="btns"><button class="btn btn-ghost btn-sm" data-rm="${id}">${ic("x")} ${t("water.remove")}</button></div></li>`).join("")}</ul>
        <p class="note">${t("water.effect", { a: fmt(J.hayTonnes(before.deficit_kg, S.P)), b: fmt(J.hayTonnes(S.pl.deficit_kg, S.P)), c: before.overloaded, d: S.pl.overloaded })}</p>` : ""}
      <p class="note">${t("water.note")}</p>`;
    el.querySelectorAll("[data-add]").forEach(b => b.onclick = () => toggleWater(b.dataset.add, true));
    el.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => toggleWater(b.dataset.rm, false));
  }

  function panePlots(el) {
    el.innerHTML = `<div class="tablewrap"><table><thead><tr><th>${t("plots.id")}</th><th class="num">${t("plots.ha")}</th><th class="num">${t("plots.ndvi")}</th>
      <th class="num">${t("plots.cap")}</th><th class="num">${t("plots.load")}</th><th>${t("plots.conf")}</th></tr></thead><tbody>
      ${S.plots.map(p => { const l = S.pl.load[p.id].load, c = J.plotCapacity(p, S.P);
        return `<tr data-plot="${p.id}" tabindex="0" style="cursor:pointer"><td><b>${esc(p.id)}</b> ${p.water ? ic("drop") : ""}</td><td class="num">${fmt(p.pasture_ha)}</td>
        <td class="num">${p.ndvi ?? "—"}</td><td class="num">${fmt(c.au_season / S.P.au.sheep)}</td>
        <td class="num"><span class="loadpill" style="background:${loadColor(l)}">${S.pl.load[p.id].used ? pct(l) : "—"}</span></td><td>${confTag(p)}</td></tr>`; }).join("")}
      </tbody></table></div><p class="srcrow" style="margin-top:10px">${t("plots.ha")}, NDVI: ${src("sat")} &nbsp; ${t("plots.cap")}, ${t("plots.load")}: ${src("model")}</p>`;
    el.querySelectorAll("tr[data-plot]").forEach(r => {
      const go2 = () => { if (window.matchMedia("(max-width: 860px)").matches) window.scrollTo({ top: 0, behavior: "smooth" }); focusPlot(r.dataset.plot); };
      r.onclick = go2; r.onkeydown = e => { if (e.key === "Enter") go2(); };
    });
  }

  function trendLine() {
    if (!S.D.source.base_year) return "";
    const avg = ring => { const xs = S.D.plots.filter(p => p.ring === ring && p.ndvi != null && p.ndvi_base != null); return xs.reduce((a, p) => a + p.ndvi - p.ndvi_base, 0) / xs.length; };
    const f = x => (x >= 0 ? "+" : "") + x.toFixed(3);
    return t("data.trend", { a: S.D.source.base_year, b: S.D.source.year, n: f(avg("near")), f: f(avg("far")) });
  }
  function paneData(el) {
    const s = S.D.source, counts = { high: 0, medium: 0, low: 0 };
    S.plots.forEach(p => counts[confidence(p)]++);
    el.innerHTML = `<div class="srcblock s-sat"><h3>${src("sat")} ${t("data.sat.t")}</h3>
        <p>${t("data.village")}: <b>${esc(S.D.village.name)}</b> (${S.D.village.lat}, ${S.D.village.lon}). ${t("data.year")}: <b>${s.year}</b>.<br>
        ${t("data.scenes")} (${s.dates.length}): ${s.dates.slice().sort().join(", ")}.</p>
        <p style="margin-top:8px">${t("plots.conf")}: <span class="conf conf-high">${t("conf.high")} ${counts.high}</span> <span class="conf conf-medium">${t("conf.medium")} ${counts.medium}</span> <span class="conf conf-low">${t("conf.low")} ${counts.low}</span></p>
        ${trendLine() ? `<p class="note">${trendLine()}</p>` : ""}</div>
      <div class="srcblock s-input"><h3>${src("input")} ${t("data.input.t")}</h3><p>${t("data.input.d")}</p></div>
      <div class="srcblock s-model"><h3>${src("model")} ${t("data.model.t")}</h3><p>${t("data.model.d")}</p></div>
      <p><a href="#/data">${t("nav.data")}</a></p>`;
  }

  // ---------- сценарии ----------
  function scenarioPayload(name, shared) {
    return { name, shared: !!shared, village: S.D.village,
      herds: S.herds.filter(h => !h.from_bot).map(h => ({ id: h.id, name: h.name, sheep: h.sheep || 0, goats: h.goats || 0, cattle: h.cattle || 0, horses: h.horses || 0, home: h.home, daily_return: !!h.daily_return })),
      water: [...S.added], params: { season_days: S.P.season_days, intake: S.P.intake, util: S.P.util, k_ndvi: S.P.k_ndvi, hay_price: S.P.hay_price },
      summary: summary() };
  }
  async function saveScenario(shared) {
    if (!S.D) return;
    const name = await askText(t("act.namePrompt"), `${S.D.village.name}, ${dateStr(new Date(), false)}`);
    if (!name) return;
    try {
      await C.saveScenario(scenarioPayload(name, shared));
      toast(shared ? t("act.published") : C.loggedIn ? t("act.saved") : t("act.savedLocal"));
      C.addHistory({ kind: shared ? "publish" : "save", village: S.D.village, summary: summary() });
    } catch (e) { toast(errText(e), true); }
  }
  function loadScenario(sc) {
    // сценарий применяется при открытии карты (onRoute) — так не бывает двух параллельных загрузок
    S.pending = { key: cacheKey(sc.village.lat, sc.village.lon), opts: { herds: sc.herds || [], water: sc.water || [], params: sc.params || null } };
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
  let pollTimer = null;
  async function openLogin() {
    const dlg = $("#loginDlg"), body = $("#loginBody");
    clearTimeout(pollTimer);
    body.innerHTML = `<p>${t("pr.login.d")}</p><div class="waiting"><span class="spin" style="width:16px;height:16px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite"></span><span id="lgWait">${t("login.wait")}</span></div>`;
    if (!dlg.open) dlg.showModal();
    const wake = setTimeout(() => { const w = $("#lgWait"); if (w) w.textContent = t("login.wake"); }, 4000);
    let st;
    try { st = await C.startLogin(); }
    catch (e) { clearTimeout(wake); body.innerHTML = `<p class="note warn">${t("login.fail")}</p><button class="btn btn-ghost" id="lgAgain">${t("login.again")}</button>`; $("#lgAgain").onclick = openLogin; return; }
    clearTimeout(wake);
    body.innerHTML = `<ol class="steps-ol"><li>${t("login.step1")}</li><li>${t("login.step2")}</li></ol>
      <div class="code" aria-label="${t("login.code")}">${esc(st.code)}</div>
      <a class="btn btn-tg wide" href="${esc(st.link)}" target="_blank" rel="noopener">${ic("send")} ${t("login.open")}</a>
      <div class="waiting" id="lgState"><span class="spin" style="width:16px;height:16px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite"></span>${t("login.wait")}</div>`;
    const started = Date.now();
    const poll = async () => {
      if (!dlg.open) return;
      try {
        const r = await C.pollLogin(st.nonce);
        if (r.status === "ok") { dlg.close(); toast(t("login.ok")); await afterAuthChange(); return; }
        if (r.status === "denied" || r.status === "expired") {
          $("#lgState").innerHTML = `<span>${t(r.status === "denied" ? "login.denied" : "login.expired")}</span> <button class="btn btn-ghost btn-sm" id="lgAgain">${t("login.again")}</button>`;
          $("#lgAgain").onclick = openLogin; return;
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
        <div class="card"><h2>${ic("send")} ${t("pr.login.t")}</h2><p>${t("pr.login.d")}</p><button class="btn btn-tg" id="prLogin">${ic("send")} ${t("auth.login")}</button></div>`;
      $("#prLogin").onclick = openLogin;
      return;
    }
    const f = u.farm || { name: "", village: null, sheep: 0, goats: 0, cattle: 0, horses: 0, daily_return: false, home: "Б-С", plots: [] };
    const plotIds = J.DIRS.map(d => "Б-" + d).concat(J.DIRS.map(d => "Д-" + d));
    const initials = (u.name || "?").split(/\s+/).map(s => s[0]).join("").slice(0, 2).toUpperCase();
    el.innerHTML = `<div class="card"><div class="who"><div class="avatar">${esc(initials)}</div><div><h2 style="margin:0">${esc(u.name)}</h2>
        <span class="tag ${u.role === "coordinator" ? "tag-mine" : ""}">${t("role." + u.role)}</span></div></div>
        <dl class="kv"><dt>${t("pr.id")}</dt><dd>${esc(u.uid)}${u.username ? " · @" + esc(u.username) : ""}</dd><dt>${t("pr.since")}</dt><dd>${when(u.created)}</dd></dl>
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
  function saveParams() {
    C.ls.set("jaiylym:params", { season_days: S.P.season_days, intake: S.P.intake, util: S.P.util, k_ndvi: S.P.k_ndvi, hay_price: S.P.hay_price });
  }
  const sheepOf = au => au / S.P.au.sheep;
  function briefData() {
    const Sd = S.P.season_days;
    const water = S.plots.filter(p => p.water);
    const capAU = water.reduce((s, p) => s + J.plotCapacity(p, S.P).au_season, 0);
    const au = S.herds.reduce((s, h) => s + J.herdAU(h, S.P), 0);
    const ratio = capAU > 0 ? au / capAU : Infinity;
    const worst = S.plots.filter(p => S.cur.load[p.id].load > 1).sort((a, b) => S.cur.load[b.id].load - S.cur.load[a.id].load)[0];
    const shortHerds = S.herds.filter(h => S.pl.coverage && S.pl.coverage[h.id] < Sd - 0.5);
    const deficitT = J.hayTonnes(S.pl.deficit_kg, S.P);
    const excessAU = Object.values(S.pl.unmet || {}).reduce((s, x) => s + x, 0) / Sd;
    const well = J.wells(S.plots, S.P)[0];
    const near = S.plots.filter(p => p.ring === "near" && (p.series || []).length >= 2);
    const trend = near.length ? near.reduce((s, p) => s + (p.series[p.series.length - 1].v - p.series[0].v) / p.series[0].v, 0) / near.length * 100 : null;
    return { Sd, water, capAU, au, ratio, worst, shortHerds, deficitT, excessAU, well, trend };
  }
  function briefHtml() {
    if (!S.herds.length) return `<div class="brief"><p>${t("brief.noherds")}</p>
      <p style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button class="btn btn-soft btn-sm" id="addDemo">${ic("plus")} ${t("ov.addDemo")}</button>
      <button class="btn btn-ghost btn-sm" id="addHerd0">${ic("plus")} ${t("herds.add")}</button></p></div>`;
    const b = briefData();
    const st = b.ratio <= 0.7 ? ["ok", "brief.ok"] : b.ratio <= 1 && b.deficitT < 1 ? ["tight", "brief.tight"] : ["short", "brief.short"];
    const lines = [];
    lines.push(t("brief.cap", { ha: fmt(b.water.reduce((s, p) => s + p.pasture_ha, 0)), sheep: fmt(sheepOf(b.capAU)), au: fmt(b.capAU), myau: fmt(b.au), mysheep: fmt(sheepOf(b.au)) }));
    lines.push(b.worst ? t("brief.curOver", { n: S.cur.overloaded, id: `<b>${esc(b.worst.id)}</b>`, pct: pct(S.cur.load[b.worst.id].load) }) : t("brief.curOk"));
    if (b.deficitT < 1) lines.push(t("brief.planOk"));
    else {
      lines.push(t("brief.planShort", { t: `<b>${fmt(b.deficitT)}</b>` }));
      for (const h of b.shortHerds.slice(0, 3)) lines.push(t("brief.herdShort", { name: esc(h.name), d: `<b>${Math.round(S.pl.coverage[h.id])}</b>`, season: b.Sd }));
      lines.push(t("brief.needLess", { au: fmt(b.excessAU), sheep: fmt(sheepOf(b.excessAU)), t: fmt(b.deficitT) }));
    }
    if (b.well) lines.push(t("brief.well", { id: `<b>${esc(b.well.plot)}</b>`, n: fmt(b.well.sheep) }));
    if (b.trend != null && Math.abs(b.trend) >= 3) lines.push(t("brief.trend", { year: S.D.source.year, dir: b.trend < 0 ? t("brief.trendDown") : t("brief.trendUp"), p: Math.abs(Math.round(b.trend)) }));
    const todo = [];
    if (S.cur.overloaded > 0) todo.push(t("brief.do.plan"));
    if (b.well && (b.deficitT >= 1 || b.ratio > 0.8)) todo.push(t("brief.do.well", { id: esc(b.well.plot) }));
    if (b.deficitT >= 1) todo.push(t("brief.do.reduce"));
    todo.push(t("brief.do.bot"));
    todo.push(t("brief.do.calib"));
    return `<div class="brief"><span class="brief-status st-${st[0]}">${t(st[1])}</span>
      ${lines.map(x => `<p>${x}</p>`).join("")}
      <h3 style="margin:12px 0 2px;font-size:15px">${t("brief.do")}</h3>
      <ul class="todo">${todo.slice(0, 4).map(x => `<li>${ic("check")}<span>${x}</span></li>`).join("")}</ul>
      <p class="fine" style="margin-top:10px">${t("brief.trust", { k: S.D.source.dates.length, year: S.D.source.year })} ${src("sat")} ${src("model")}</p></div>
      <div class="aibox" id="aiBox"><button class="btn btn-green btn-sm" id="aiBriefBtn">${ic("spark")} ${t("brief.ai")}</button>
        ${S.aiBrief && S.aiBrief.key === briefKey() ? `<p class="aitext">${esc(S.aiBrief.text)}</p><p class="fine">${t("brief.aiNote")}</p>` : ""}</div>`;
  }
  const briefKey = () => S.D ? JSON.stringify([S.D.village.lat, S.D.village.lon, S.herds.map(h => [h.sheep, h.goats, h.cattle, h.horses, h.home, h.daily_return]), [...S.added], S.P.k_ndvi, S.P.season_days, I.lang]) : "";

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
    el.innerHTML = briefHtml() + movesHtml() + wxHtml() +
      (S.herds.length ? `<details class="more"><summary>${ic("chart")} ${t("brief.details")}</summary><div id="briefDetails"></div></details>` : "");
    const det = $("#briefDetails", el);
    if (det) paneOverview(det);
    const add = $("#addDemo", el); if (add) add.onclick = () => { S.herds = DEMO_HERDS.map(h => Object.assign({ demo: true }, h)); render(); };
    const add0 = $("#addHerd0", el); if (add0) add0.onclick = () => { addHerd(); renderPane("herds"); };
    const btn = $("#aiBriefBtn", el);
    if (btn) btn.onclick = async () => {
      btn.disabled = true;
      const box = $("#aiBox", el), k = briefKey();
      box.insertAdjacentHTML("beforeend", `<p class="fine" id="aiWait">${t("brief.aiWait")}</p>`);
      try {
        const r = await C.ai({ mode: "summary", lang: I.lang, context: aiContext() });
        S.aiBrief = { key: k, text: r.text };
        if (S.tab === "brief") renderPane("brief");
      } catch (e) { const w = $("#aiWait", el); if (w) w.textContent = t("brief.aiFail") + ": " + errText(e); btn.disabled = false; }
    };
    loadWeather();
  }

  /** Данные открытого села для ИИ: только то, что видит пользователь, с пометками источника. */
  function aiContext() {
    if (!S.D) return { село: null };
    const b = briefData();
    return {
      село: S.D.village.name, лето_снимков: S.D.source.year, снимков_безоблачных: S.D.source.dates.length,
      пастбища_с_водой_га: Math.round(b.water.reduce((s, p) => s + p.pasture_ha, 0)),
      ёмкость_всех_участков_с_водой_овец_за_сезон_оценка: Math.round(sheepOf(b.capAU)),
      поголовье_усл_голов: Math.round(b.au), сезон_дней: b.Sd,
      участки: S.plots.map(p => ({ id: p.id, кольцо: p.ring === "near" ? "ближний" : "дальний", км_от_села: p.dist_km, направление: p.dir,
        пастбище_га_спутник: p.pasture_ha, ndvi_спутник: p.ndvi, трава_за_лето_проц: (p.series || []).length >= 2 ? Math.round((p.series[p.series.length - 1].v - p.series[0].v) / p.series[0].v * 100) : null,
        достоверность: confidence(p), вода: p.water ? (S.added.has(p.id) ? "смоделированный водопой" : "есть") : "нет",
        ёмкость_овец_оценка: Math.round(sheepOf(J.plotCapacity(p, S.P).au_season)),
        нагрузка_если_все_у_села_проц: Math.round(S.cur.load[p.id].load * 100), нагрузка_по_плану_проц: Math.round(S.pl.load[p.id].load * 100) })),
      стада: S.herds.map(h => ({ имя: h.name, овцы: h.sheep || 0, козы: h.goats || 0, крс: h.cattle || 0, лошади: h.horses || 0, дойное: !!h.daily_return,
        усл_голов: Math.round(J.herdAU(h, S.P)), дней_корма_по_плану: Math.round((S.pl.coverage || {})[h.id] ?? b.Sd),
        маршрут: (S.pl.herdPlans[h.id] || []).map(s => `${s.plot || "нет корма"} д.${s.from}-${s.to}`).join("; ") })),
      итог: { перегружено_если_все_у_села: S.cur.overloaded, перегружено_по_плану: S.pl.overloaded,
        сено_сверх_нормы_т_если_все_у_села_оценка: Math.round(J.hayTonnes(S.cur.deficit_kg, S.P)), дефицит_сена_т_по_плану_оценка: Math.round(b.deficitT) },
      лучшие_места_для_водопоя: J.wells(S.plots, S.P).slice(0, 3).map(w => ({ участок: w.plot, откроет_корм_овец_оценка: Math.round(w.sheep) })),
      погода: S.wx && !S.wx.fail ? { осадки_30_дней_мм: Math.round(S.wx.rain30), прогноз_7_дней: S.wx.next.map(x => `${x.d}: ${Math.round(x.tmin)}..${Math.round(x.tmax)}°C, ${x.p} мм`) } : null,
      параметры_модели: { кг_биомассы_на_ед_ndvi: S.P.k_ndvi, доля_стравливания: S.P.util, кг_корма_на_голову_в_сутки: S.P.intake, цена_сена_тенге_т: S.P.hay_price },
      мои_пастбища: ((C.user && C.user.pastures) || []).map(q => ({ название: q.name, га: q.area_ha, ndvi: q.stats && q.stats.ndvi })),
    };
  }

  // ---------- ИИ-помощник: отдельный чат ----------
  function renderAI() {
    const el = $("#aiPage");
    const hist = (() => { try { return JSON.parse(sessionStorage.getItem("jaiylym:chat") || "[]"); } catch (_) { return []; } })();
    const ctxLine = S.D ? t("ai.ctx", { v: `${esc(S.D.village.name)} · ${S.plots.length} ${t("tab.plots").toLowerCase()} · ${S.herds.length} ${t("sc.herds")}` }) : t("ai.noctx");
    el.innerHTML = `<div class="chat"><div class="chat-head"><h1>${ic("spark")} ${t("ai.title")}</h1><p class="fine" style="margin:0">${t("ai.lead")}</p>
        <span class="chat-ctx">${ic("pin")} ${ctxLine}</span></div>
      <div class="chat-log" id="chatLog" aria-live="polite">${hist.map(m => `<div class="msg ${m.role}">${esc(m.text)}</div>`).join("")}</div>
      <div class="chips-q">${["ai.q1", "ai.q2", "ai.q3", "ai.q4"].map(k => `<button type="button" data-q="${esc(t(k))}">${t(k)}</button>`).join("")}</div>
      <form class="chat-form" id="chatForm"><textarea id="chatIn" rows="1" placeholder="${t("ai.ph")}" aria-label="${t("ai.ph")}"></textarea>
        <button class="btn btn-primary">${ic("send")} <span>${t("ai.send")}</span></button></form></div>
      <p class="fine" style="margin-top:10px">${t("ai.disclaimer")} ${hist.length ? `<button class="linkbtn" id="chatClear">${t("ai.clear")}</button>` : ""}</p>`;
    const log = $("#chatLog"), inp = $("#chatIn");
    log.scrollTop = log.scrollHeight;
    const send = async text => {
      text = text.trim(); if (!text) return;
      hist.push({ role: "user", text });
      log.insertAdjacentHTML("beforeend", `<div class="msg user">${esc(text)}</div><div class="msg ai" id="aiTyping">${t("ai.thinking")}</div>`);
      log.scrollTop = log.scrollHeight; inp.value = "";
      try {
        const r = await C.ai({ mode: "chat", lang: I.lang, context: aiContext(), messages: hist.slice(-10) });
        hist.push({ role: "ai", text: r.text });
        $("#aiTyping").outerHTML = `<div class="msg ai">${esc(r.text)}</div>`;
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
    const f = [["season_days", "params.season"], ["intake", "params.intake"], ["util", "params.util"], ["k_ndvi", "params.k"], ["hay_price", "params.hay"]];
    $("#setPage").innerHTML = `<div class="card">
        <div class="setrow"><span>${t("set.lang")}</span><div class="seg"><button data-l="ru" class="${I.lang === "ru" ? "on" : ""}">Русский</button><button data-l="kk" class="${I.lang === "kk" ? "on" : ""}">Қазақша</button></div></div>
        <div class="setrow"><span>${t("set.mode")}</span><div class="seg">${["current", "plan", "ndvi"].map(m => `<button data-m="${m}" class="${S.mode === m ? "on" : ""}">${t("map.mode." + m)}</button>`).join("")}</div></div>
        <div class="setrow"><span>${t("set.demo")}</span><label class="switch"><input type="checkbox" id="setDemo" ${C.ls.get("jaiylym:demo", true) ? "checked" : ""}><span></span></label></div></div>
      <div class="card"><h2>${ic("chart")} ${t("set.model")} ${src("model")}</h2><p class="fine">${t("set.modelNote")}</p>
        <div class="params">${f.map(([k, l]) => `<label class="field">${t(l)}<input type="number" step="any" min="0" data-param="${k}" value="${S.P[k]}"></label>`).join("")}</div>
        <button class="btn btn-ghost btn-sm" id="setReset">${t("params.reset")}</button></div>
      <div class="card"><h2>${ic("send")} ${t("set.notify")}</h2><p>${t("set.notifyD")}</p><a class="btn btn-tg" href="https://t.me/JAIYLYM_bot" target="_blank" rel="noopener">${ic("send")} @JAIYLYM_bot</a></div>
      <div class="card"><h2>${ic("save")} ${t("set.data")}</h2><p style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-ghost btn-sm" id="setClear">${t("set.clear")}</button>
        <button class="btn btn-ghost btn-sm" id="setGuest">${t("set.clearGuest")}</button></p><p class="fine">${t("set.version")}: 2026.11 · ${esc(navigator.onLine ? "online" : "offline")}</p></div>`;
    $$("#setPage [data-l]").forEach(b => b.onclick = () => setLang(b.dataset.l));
    $$("#setPage [data-m]").forEach(b => b.onclick = () => { S.mode = b.dataset.m; C.ls.set("jaiylym:mode", S.mode); if (S.D) paintMap(); renderSettings(); });
    $("#setDemo").onchange = e => C.ls.set("jaiylym:demo", e.target.checked);
    $$("#setPage [data-param]").forEach(i => i.onchange = () => { const v = +i.value; if (!Number.isFinite(v) || v <= 0) { i.value = S.P[i.dataset.param]; return; } S.P[i.dataset.param] = v; saveParams(); if (S.D) render(); });
    $("#setReset").onclick = () => { S.P = J.params(); saveParams(); if (S.D) render(); renderSettings(); };
    $("#setClear").onclick = () => { try { Object.keys(localStorage).filter(k => k.startsWith("jaiylym:v")).forEach(k => localStorage.removeItem(k)); } catch (_) {} toast(t("set.cleared")); };
    $("#setGuest").onclick = () => { C.ls.del("jaiylym:guest:scenarios"); C.ls.del("jaiylym:guest:history"); toast(t("set.cleared")); };
  }

  // ---------- «Что это»: о продукте, как пользоваться, словарь, вопросы ----------
  function renderAbout() {
    $("#aboutPage").innerHTML = `<div class="about-hero"><h1>${t("ab.title")}</h1><p>${t("ab.lead")}</p>
        <p style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap"><a class="btn btn-primary" href="#/map">${ic("map")} ${t("nav.map")}</a><a class="btn btn-soft" href="#/ai">${ic("spark")} ${t("nav.ai")}</a></p></div>
      <div class="grid2"><div class="card"><h2>${t("ab.how")}</h2><ol class="howto"><li>${t("ab.h1")}</li><li>${t("ab.h2")}</li><li>${t("ab.h3")}</li><li>${t("ab.h4")}</li></ol></div>
        <div class="card"><h2>${t("ab.gloss")}</h2><dl class="gloss">${["ndvi", "au", "cap", "load", "jailau"].map(k => { const [a, ...rest] = t("ab.g." + k).split(" — "); return `<dt>${a}</dt><dd>${rest.join(" — ")}</dd>`; }).join("")}</dl></div></div>
      <div class="card faq"><h2>${t("ab.faq")}</h2>${[1, 2, 3].map(i => `<details><summary>${t("ab.f" + i + "q")}</summary><p>${t("ab.f" + i + "a")}</p></details>`).join("")}</div>
      <h2 style="margin-top:24px">${t("data.title")}</h2>`;
  }

  // ---------- главная ----------
  let heroMap = null;
  function renderHome() {
    const plots = DEFAULT.plots.map(p => Object.assign({}, p));
    const pl = J.plan(plots, DEMO_HERDS);
    if (window.L && !heroMap) {
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
    $("#heroStatNote").textContent = `${t("home.stat.note")} ${DEFAULT.source.year}. ${t("map.mode.plan")}: ${t("herds.demo").toLowerCase()}.`;
    const last = C.ls.get("jaiylym:last", null), cb = $("#continueBtn");
    if (last && !isKegen(last.lat, last.lon)) { cb.hidden = false; cb.textContent = t("home.continue") + last.name; cb.href = `#/map?lat=${last.lat}&lon=${last.lon}&name=${encodeURIComponent(last.name)}`; }
    else cb.hidden = true;
  }

  // ---------- язык, сеть, запуск ----------
  function setLang(l) {
    I.setLang(l);
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
    $("#drawBtn").onclick = () => (S.draw ? endDraw() : startDraw());
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
      try { await window.Report.export(reportCtx()); C.addHistory({ kind: "pdf", village: S.D.village, summary: summary() }); }
      catch (e) { toast(t("rep.printFallback"), true); }
    };
    $("#accountBtn").onclick = () => (C.loggedIn ? go("profile") : openLogin());
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
    if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // данные для PDF-отчёта
  function reportCtx() {
    return { t, fmt, fmt1, pct, esc, src, J, S, scheme, loadColor, confidence, summary: summary(), trend: trendLine(), lang: I.lang };
  }

  window.JaiylymApp = { S, openVillage, render, summary, confidence, scheme, reportCtx, pickVillageOnMap };   // для отладки и тестов
  init();
})();
