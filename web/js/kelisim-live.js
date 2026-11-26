/* Jaiylym — Келісім: общая карта и чат. Участник ставит кружок «хочу пасти здесь», все видят кружки друг друга (у каждого свой цвет),
 * обсуждают в чате, голосуют «согласен»/«против». Плюсы и минусы места считает сервер по расчёту (kelisim.js → web/kelisim.js pinFacts),
 * ИИ даёт короткую оценку и совет, а перед подтверждением спрашивает «вы уверены?». Кто в сети — по опросу живого слоя.
 * Данные: GET /api/kelisim/<id>/live?since=<номер сообщения>, POST …/pin, …/chat, …/assess, …/summary. */
(function () {
  "use strict";
  window.KelisimLive = function (X) {
    const { t, I, C, $, $$, esc, ic, toast, kErr, getV, getCur, plotFull, reload, poke } = X;
    const tt = (k, v) => t("kel.lv." + k, v);
    const POLL = 4000, ONLINE = "online";
    // разные хорошо различимые цвета (как у игроков в викторине); организатор — зелёный сайта
    const PAL = ["#e5484d", "#0b7fd1", "#2f9e44", "#8e4ec6", "#d6409f", "#0e9f9a", "#1d4ed8", "#be123c", "#15803d", "#7c3aed", "#0369a1", "#a21caf"];
    const colorOf = hid => (hid === "org" ? "#24543f" : PAL[((parseInt(String(hid).slice(1), 10) || 1) - 1) % PAL.length]);
    const initials = s => (String(s || "?").trim().split(/\s+/).map(w => w[0]).join("").slice(0, 2) || "?").toUpperCase();
    let root = null, cid = null, map = null, pinLayer = null, data = null, seq = 0, chat = [], timer = null, placing = false, radius = 500, mineKey = "", sumKey = "", asked = {}, fails = {};

    const V = () => getV();
    const me = () => (V() && V().role !== "org" ? V().me : "org");
    const nameOf = hid => (hid === "org" ? tt("org") : ((V().households.find(h => h.id === hid) || {}).name || tt("gone")));
    const av = (hid, big) => `<span class="kav${big ? " kav-big" : ""}" style="background:${colorOf(hid)}" aria-hidden="true">${esc(initials(hid === "org" ? tt("orgShort") : nameOf(hid)))}</span>`;
    const pinOf = hid => (data && data.pins.find(p => p.hid === hid)) || null;
    const ago = iso => { const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)); return m < 1 ? tt("justNow") : m < 60 ? tt("minAgo", { n: m }) : m < 1440 ? tt("hAgo", { n: Math.round(m / 60) }) : tt("dAgo", { n: Math.round(m / 1440) }); };
    const verdictChip = v => `<span class="kvd kvd-${esc(v)}">${tt("v." + v)}</span>`;
    function factText(x) {
      const p = Object.assign({}, x, { names: (x.names || []).map(esc).join(", ") }, x.d != null ? { d: String(x.d).replace(".", ",") } : {});   // км с запятой, как везде
      return tt("f." + x.k, p);
    }
    const listOf = (arr, cls, sign) => (arr.length ? `<ul class="kpc ${cls}">${arr.map(x => `<li><span aria-hidden="true">${sign}</span> ${factText(x)}</li>`).join("")}</ul>` : "");
    const placeLine = p => (p.facts.plot ? plotFull(p.facts.plot) : tt("place." + p.facts.ring)) + ` · ${tt("km", { d: String(p.facts.dist_km).replace(".", ",") })}`;
    /** Оценка без ИИ (ключа нет, лимит или сбой): вывод расчёта, минусы и совет проверить на месте. */
    function template(p) {
      const cons = p.cons.map(factText);
      return `${tt("tpl.head", { v: tt("v." + p.verdict).toLowerCase() })}\n${cons.length ? cons.map(c => "— " + c.replace(/<[^>]+>/g, "")).join("\n") : "— " + tt("tpl.noCons")}\n${tt("tpl.advice")}`;
    }
    const aiHtml = s => esc(s).split("\n").filter(Boolean).map(l => (/^(Совет|Кеңес):/.test(l) ? `<p class="kai-adv">${l}</p>` : `<p>${l}</p>`)).join("");

    // ---------- монтирование: один корень и одна карта на согласование, страница вокруг перерисовывается ----------
    function mount(slot) {
      const v = V(), c = getCur();
      if (!slot || !v || !c) return;
      if (!root || cid !== c.id) { stop(true); build(); cid = c.id; }
      slot.replaceWith(root);
      renderTools(); renderPeople();
      if (map) setTimeout(() => map.invalidateSize(), 30); else initMap();
      if (!timer) { tick(); timer = setInterval(() => { if (!document.hidden && navigator.onLine) tick(); }, POLL); }
    }
    function stop(full) {
      clearInterval(timer); timer = null;
      if (full) { if (map) { map.remove(); map = null; } pinsKey = ""; popupOpen = false; root = null; data = null; seq = 0; chat = []; placing = false; mineKey = ""; sumKey = ""; asked = {}; fails = {}; }
    }
    function build() {
      root = document.createElement("section");
      root.className = "card klive"; root.id = "klive";
      root.innerHTML = `<div class="klive-h"><h2>${tt("title")}</h2><span class="klive-on" id="lvOn"></span></div>
        <ol class="klsteps"><li><b>${ic("pin")}</b><span>${tt("s1")}</span></li><li><b>${ic("users")}</b><span>${tt("s2")}</span></li><li><b>${ic("check")}</b><span>${tt("s3")}</span></li></ol>
        <div class="kpeople" id="lvPeople" aria-label="${tt("people")}"></div>
        <div class="klive-grid">
          <div class="klive-left"><div class="klive-tools" id="lvTools"></div><div class="klive-map" id="lvMap" role="application" aria-label="${tt("mapLabel")}"></div><div id="lvMine" aria-live="polite"></div></div>
          <aside class="klive-chat" aria-label="${tt("chat")}"><h3>${tt("chat")}</h3><div class="kchat-log" id="lvLog" role="log" aria-live="polite"><p class="fine" id="lvEmpty">${tt("chatEmpty")}</p></div>
            <form class="kchat-f" id="lvForm"><label class="sr-only" for="lvIn">${tt("chatPh")}</label><input id="lvIn" maxlength="300" autocomplete="off" placeholder="${esc(tt("chatPh"))}">
            <button class="btn btn-primary btn-sm" id="lvSend">${tt("send")}</button></form></aside>
        </div>
        <div id="lvSum"></div>`;
      $("#lvForm", root).onsubmit = async e => {
        e.preventDefault();
        const inp = $("#lvIn", root), txt = inp.value.trim(); if (!txt) return;
        const b = $("#lvSend", root); b.disabled = true;
        try { const r = await C.kel("POST", `/${getCur().id}/chat`, getCur().key, { text: txt, about: inp.dataset.about || undefined }); inp.value = ""; delete inp.dataset.about; inp.placeholder = tt("chatPh"); apply(r.live); }
        catch (x) { toast(kErr(x), true); } finally { b.disabled = false; inp.focus(); }
      };
    }
    function initMap() {
      const box = $("#lvMap", root), v = V();
      if (!window.L) { box.innerHTML = `<p class="note">${tt("noMap")}</p>`; return; }
      const { lat, lon } = v.village;
      map = L.map(box, { zoomControl: true, attributionControl: true, maxZoom: 18, scrollWheelZoom: false }).setView([lat, lon], 12);
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxNativeZoom: 17, maxZoom: 18, attribution: "Esri World Imagery" }).addTo(map);
      // участки расчёта: сектора вокруг села, подписи кодов
      const PL = window.JaiylymPipeline, ids = new Set(v.snapshot.plots.filter(p => !p.forbidden).map(p => p.id)), shut = new Set(v.snapshot.plots.filter(p => p.forbidden).map(p => p.id));
      if (PL && PL.makePlots) {
        const g = L.featureGroup().addTo(map);
        for (const p of PL.makePlots(lat, lon, 10)) {
          const ll = p.geometry.coordinates[0].map(([x, y]) => [y, x]), off = shut.has(p.id);
          L.polygon(ll, { color: "#fff", weight: 1, opacity: 0.8, fillColor: off ? "#5b2333" : "#ffffff", fillOpacity: off ? 0.35 : 0.04, interactive: false }).addTo(g);
          if (ids.has(p.id) || off) L.marker(L.polygon(ll).getBounds().getCenter(), { interactive: false, icon: L.divIcon({ className: "kplot-lbl", html: esc(p.id) + (off ? " ✕" : ""), iconSize: null }) }).addTo(g);
        }
        map.fitBounds(g.getBounds(), { padding: [8, 8] });
      }
      L.circleMarker([lat, lon], { radius: 5, color: "#fff", weight: 2, fillColor: "#24543f", fillOpacity: 1, interactive: false }).addTo(map);
      pinLayer = L.layerGroup().addTo(map);
      map.on("click", e => { if (placing) place(e.latlng); });
      map.on("popupopen", e => { popupOpen = true; bindPopup(e.popup.getElement()); });
      map.on("popupclose", () => { popupOpen = false; drawPins(); });
      // карту можно крутить колесом только после нажатия на неё — страница прокручивается как обычно
      map.on("focus click", () => map.scrollWheelZoom.enable());
      map.on("mouseout", () => map.scrollWheelZoom.disable());
      drawPins();
    }

    // ---------- сеть ----------
    async function tick() {
      const c = getCur(); if (!c || !root) return;
      try { const r = await C.kel("GET", `/${c.id}/live?since=${seq}`, c.key); if (getCur() === c) { apply(r); if (V() && r.rev !== V().rev && poke) poke(); } }
      catch (_) { /* сеть пропала — попробуем на следующем такте */ }
    }
    function apply(r) {
      if (!r || !root) return;
      const was = data;
      data = Object.assign({}, r, { chat: undefined });
      for (const p of data.pins) if (fails[p.hid + p.at] && !p.ai) p.ai_fail = true;        // ИИ не ответил по этому месту — шаблон, без вечного ожидания
      if (r.seq < seq) { chat = []; }                                  // сервер начал счёт заново (запись удалили)
      for (const m of r.chat || []) if (!chat.some(x => x.seq === m.seq)) chat.push(m);
      chat.sort((a, b) => a.seq - b.seq); if (chat.length > 300) chat.splice(0, chat.length - 300);
      seq = Math.max(seq, r.seq || 0);
      const had = !!(was && was.pins.some(p => p.hid === me())), has = data.pins.some(p => p.hid === me());
      if (!was || had !== has) renderTools();             // «Отметить» ↔ «Передвинуть место»
      renderPeople(); drawPins(); renderChat(); renderMine(); renderSum();
      // своё новое место: сразу попросить оценку ИИ (один раз на одно и то же место)
      const mp = pinOf(me());
      if (mp && !mp.ai && !mp.ai_stale && !asked[mp.at]) { asked[mp.at] = true; assess(mp, true); }
      if (mp && mp.ai_stale && !asked[mp.at + ":s"]) { asked[mp.at + ":s"] = true; assess(mp, true); }
      return was;
    }
    async function pinAct(body, b) {
      const c = getCur();
      if (b) b.disabled = true;
      try { const r = await C.kel("POST", `/${c.id}/pin`, c.key, body); apply(r.live); return r; }
      catch (x) { toast(kErr(x), true); return null; }
      finally { if (b && b.isConnected) b.disabled = false; }
    }
    async function place(ll) {
      placing = false; renderTools();
      const r = await pinAct({ op: "set", lat: +ll.lat.toFixed(5), lon: +ll.lng.toFixed(5), r: radius });
      if (r) { toast(tt("placed")); const m = $("#lvMine", root); if (m) m.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
    }
    async function assess(p, quiet) {
      const c = getCur(), box = $("#lvAi", root);
      if (box && !quiet) box.innerHTML = `<p class="startload"><span class="spin" aria-hidden="true"></span><span>${tt("aiWait")}</span></p>`;
      try {
        const r = await C.kel("POST", `/${c.id}/assess`, c.key, { target: p.hid, lang: I.lang });
        const pp = pinOf(p.hid); if (pp) { pp.ai = r.ai; pp.ai_stale = false; pp.ai_fail = !r.ai; }
        if (!r.ai) fails[p.hid + p.at] = true;
        mineKey = ""; renderMine(); drawPins();
        return r;
      } catch (x) { if (!quiet) toast(kErr(x), true); fails[p.hid + p.at] = true; const pp = pinOf(p.hid); if (pp) pp.ai_fail = true; mineKey = ""; renderMine(); return null; }
    }

    // ---------- участники: аватары как в викторине, кто в сети и кто ещё не заходил ----------
    function stateOf(hid) {
      const on = data && data.online.includes(hid), seen = data && data.seen[hid];
      const h = V().households.find(x => x.id === hid);
      if (on) return { k: ONLINE, txt: tt("st.on") };
      if (seen) return { k: "seen", txt: tt("st.seen", { t: ago(seen) }) };
      if (h && h.joined) return { k: "seen", txt: tt("st.joined") };
      return { k: "never", txt: tt("st.never") };
    }
    function renderPeople() {
      const box = $("#lvPeople", root); if (!box || !V()) return;
      const ids = ["org"].concat(V().households.map(h => h.id)), n = data ? data.online.length : 0;
      box.innerHTML = ids.map(hid => { const s = stateOf(hid), p = pinOf(hid);
        return `<div class="kperson kp-${s.k}${hid === me() ? " kp-me" : ""}" title="${esc(nameOf(hid))}: ${esc(s.txt)}">${av(hid, true)}<span class="kdot" aria-hidden="true"></span>
          <b>${esc(nameOf(hid))}${hid === me() ? ` <small>(${tt("you")})</small>` : ""}</b><small>${esc(s.txt)}</small>
          ${hid === "org" && !p ? "" : `<small class="kp-pin">${p ? (p.confirmed ? `✓ ${tt("pinOk")}` : tt("pinYes")) : tt("pinNo")}</small>`}</div>`; }).join("");
      const on = $("#lvOn", root); if (on) on.innerHTML = `<span class="kdot kdot-on" aria-hidden="true"></span> ${tt("onlineN", { n })}`;
    }

    // ---------- кружки на карте ----------
    let pinsKey = "", popupOpen = false;
    function drawPins() {
      if (!map || !pinLayer || !data) return;
      // перерисовка только при изменениях; пока открыта карточка места — после её закрытия (иначе она закрывается сама каждые 4 с)
      const key = JSON.stringify([data.pins.map(p => [p.hid, p.lat, p.lon, p.r, p.confirmed, p.verdict, p.votes, p.ai && p.ai.text, p.ai_stale, p.pros, p.cons]), V().households.map(h => h.name)]);
      if (key === pinsKey) return;
      if (popupOpen) { pinsKey = ""; return; }
      pinsKey = key;
      pinLayer.clearLayers();
      for (const p of data.pins) {
        const c = colorOf(p.hid), mine = p.hid === me();
        L.circle([p.lat, p.lon], { radius: p.r, color: c, weight: mine ? 3 : 2, dashArray: p.confirmed ? null : "6 5", fillColor: c, fillOpacity: 0.22 }).addTo(pinLayer)
          .bindPopup(() => popupHtml(p.hid), { maxWidth: 300 });
        L.marker([p.lat, p.lon], { icon: L.divIcon({ className: "kpin", html: `<span style="background:${c}">${esc(initials(nameOf(p.hid)))}</span>${p.confirmed ? "<i>✓</i>" : ""}`, iconSize: [30, 30], iconAnchor: [15, 15] }), title: nameOf(p.hid), keyboard: true })
          .addTo(pinLayer).bindPopup(() => popupHtml(p.hid), { maxWidth: 300 });
      }
    }
    const votes = p => { const v = Object.values(p.votes || {}); return { up: v.filter(x => x > 0).length, down: v.filter(x => x < 0).length, my: (p.votes || {})[me()] || 0 }; };
    function popupHtml(hid) {
      const p = pinOf(hid); if (!p) return "";
      const vt = votes(p), own = hid === me();
      return `<div class="kpop" data-hid="${esc(hid)}"><div class="kpop-h">${av(hid)}<b>${esc(nameOf(hid))}</b>${verdictChip(p.verdict)}</div>
        <p class="fine">${placeLine(p)}${p.confirmed ? ` · ✓ ${tt("pinOk")}` : ""}</p>${listOf(p.pros, "kpc-pro", "＋")}${listOf(p.cons, "kpc-con", "－")}
        ${p.ai && !p.ai_stale ? `<div class="kai kai-sm"><b>${tt("aiT")}</b>${aiHtml(p.ai.text)}</div>` : ""}
        <div class="kvote">${own ? `<span class="fine">${tt("yes")}: ${vt.up} · ${tt("no")}: ${vt.down}</span>` : `<button type="button" class="btn btn-sm ${vt.my > 0 ? "btn-green" : "btn-soft"}" data-v="1" aria-pressed="${vt.my > 0}">${ic("check")} ${tt("yes")} · ${vt.up}</button>
          <button type="button" class="btn btn-sm ${vt.my < 0 ? "btn-danger" : "btn-ghost"}" data-v="-1" aria-pressed="${vt.my < 0}">${ic("x")} ${tt("no")} · ${vt.down}</button>`}
          <button type="button" class="btn btn-sm btn-ghost" data-talk>${tt("discuss")}</button></div></div>`;
    }
    function bindPopup(el) {
      const box = el && el.querySelector(".kpop"); if (!box) return;
      const hid = box.dataset.hid;
      $$("[data-v]", box).forEach(b => b.onclick = async () => { const p = pinOf(hid), cur = votes(p).my, v = +b.dataset.v; await pinAct({ op: "vote", target: hid, v: cur === v ? 0 : v }, b); map.closePopup(); });
      const tk = $("[data-talk]", box); if (tk) tk.onclick = () => { map.closePopup(); const inp = $("#lvIn", root); inp.dataset.about = hid; inp.placeholder = tt("aboutPh", { n: nameOf(hid) }); inp.focus(); };
    }

    // ---------- инструменты и «моё место» ----------
    function renderTools() {
      const box = $("#lvTools", root); if (!box || !V()) return;
      const v = V();
      if (v.status === "closed") { box.innerHTML = `<p class="fine">${tt("closed")}</p>`; return; }
      const has = !!pinOf(me());
      box.innerHTML = placing
        ? `<div class="kplacing" role="status"><b>${tt("tapMap")}</b><button type="button" class="btn btn-sm btn-ghost" id="lvCancel">${tt("cancel")}</button></div>`
        : `<button type="button" class="btn btn-primary" id="lvPlace">${ic("pin")} ${tt(has ? "move" : "place")}</button>
          <label class="klive-r">${tt("radius")} <select id="lvR">${[250, 500, 1000].map(r => `<option value="${r}" ${r === radius ? "selected" : ""}>${tt("r" + r)}</option>`).join("")}</select></label>`;
      const pl = $("#lvPlace", box); if (pl) pl.onclick = () => { placing = true; renderTools(); $("#lvMap", root).scrollIntoView({ behavior: "smooth", block: "center" }); };
      const cn = $("#lvCancel", box); if (cn) cn.onclick = () => { placing = false; renderTools(); };
      const rs = $("#lvR", box); if (rs) rs.onchange = () => { radius = +rs.value; };
      $("#lvMap", root).classList.toggle("placing", placing);
    }
    function renderMine() {
      const box = $("#lvMine", root); if (!box || !V()) return;
      const p = pinOf(me());
      const key = JSON.stringify(p && [p.lat, p.lon, p.r, p.confirmed, p.verdict, p.pros, p.cons, p.ai && p.ai.text, p.ai_stale, p.ai_fail, votes(p)]);
      if (key === mineKey) return; mineKey = key;
      if (!p) { box.innerHTML = V().status === "closed" ? "" : `<p class="note">${tt("noPin")}</p>`; return; }
      const vt = votes(p);
      box.innerHTML = `<div class="kmine" style="border-color:${colorOf(me())}"><div class="kpop-h">${av(me())}<b>${tt("myPlace")}</b>${verdictChip(p.verdict)}</div>
        <p class="fine">${placeLine(p)} · ${tt("yes")}: ${vt.up} · ${tt("no")}: ${vt.down}</p>
        <div class="kpc-2">${listOf(p.pros, "kpc-pro", "＋")}${listOf(p.cons, "kpc-con", "－")}</div>${listOf(p.info, "kpc-info", "•")}
        <div class="kai" id="lvAi"><b>${tt("aiT")}</b>${p.ai && !p.ai_stale ? aiHtml(p.ai.text) : p.ai_fail ? `<p class="fine">${tt("aiNo")}</p>${aiHtml(template(p))}` : `<p class="startload"><span class="spin" aria-hidden="true"></span><span>${tt("aiWait")}</span></p>`}</div>
        <div class="kmine-b">${p.confirmed ? `<span class="kdone">✓ ${tt("pinOk")}</span>` : `<button type="button" class="btn btn-primary" id="lvConf">${tt("confirm")}</button>`}
          <button type="button" class="btn btn-ghost" id="lvMove">${tt("move")}</button><button type="button" class="btn btn-ghost" id="lvDel">${tt("remove")}</button>
          ${p.ai_fail || p.ai_stale ? `<button type="button" class="btn btn-ghost" id="lvAsk">${tt("askAi")}</button>` : ""}</div></div>`;
      const cf = $("#lvConf", box); if (cf) cf.onclick = () => sureDlg(p);
      $("#lvMove", box).onclick = () => { placing = true; renderTools(); $("#lvMap", root).scrollIntoView({ behavior: "smooth", block: "center" }); };
      X.armBtn($("#lvDel", box), tt("sure"), async b => { await pinAct({ op: "remove" }, b); });
      const ak = $("#lvAsk", box); if (ak) ak.onclick = () => assess(p);
    }
    /** «Вы уверены?»: минусы места и совет ИИ перед подтверждением; если план уже есть и место не в нём — пожелание организатору. */
    async function sureDlg(p) {
      const v = V(), plot = p.facts.plot;
      const inPlan = v.plan && v.plan.routes && (v.plan.routes[me()] || []).some(s => s.plot === plot);
      const wish = v.role !== "org" && v.status === "review" && v.plan && plot && !inPlan && !v.expired;
      const d = document.createElement("dialog");
      d.className = "modal kel-dlg"; d.setAttribute("aria-label", tt("sureT"));
      const body = () => `<form method="dialog" class="modal-x"><button aria-label="${t("common.close")}">✕</button></form><h2>${tt("sureT")}</h2>
        <p>${verdictChip(p.verdict)} ${placeLine(p)}</p>${p.cons.length ? `<h3>${tt("consT")}</h3>${listOf(p.cons, "kpc-con", "－")}` : `<p class="kdone">✓ ${tt("tpl.noCons")}</p>`}
        <div class="kai" id="sureAi"><b>${tt("aiT")}</b>${p.ai && !p.ai_stale ? aiHtml(p.ai.text) : p.ai_fail ? aiHtml(template(p)) : `<p class="startload"><span class="spin" aria-hidden="true"></span><span>${tt("aiWait")}</span></p>`}</div>
        ${wish ? `<label class="check"><input type="checkbox" id="sureWish" checked> ${tt("wish", { p: esc(plot) })}</label>` : ""}
        <div class="kmine-b"><button type="button" class="btn btn-primary" id="sureYes">${tt("sureYes")}</button><button type="button" class="btn btn-ghost" id="sureNo">${tt("sureNo")}</button></div>`;
      d.innerHTML = body(); document.body.appendChild(d); d.showModal();
      d.addEventListener("close", () => d.remove());
      if (!(p.ai && !p.ai_stale) && !p.ai_fail) { const r = await assess(p, true); const pp = pinOf(p.hid) || p; if (d.open) $("#sureAi", d).innerHTML = `<b>${tt("aiT")}</b>${r && r.ai ? aiHtml(r.ai.text) : aiHtml(template(pp))}`; }
      $("#sureNo", d).onclick = () => { d.close(); placing = true; renderTools(); $("#lvMap", root).scrollIntoView({ behavior: "smooth", block: "center" }); };
      $("#sureYes", d).onclick = async () => {
        const b = $("#sureYes", d), w = $("#sureWish", d), send = w && w.checked;
        if (!(await pinAct({ op: "confirm" }, b))) return;
        if (send) {
          try { await C.kel("POST", `/${getCur().id}/answer`, getCur().key, { version: V().version, value: "object", proposal: { type: "prefer", plot } }); toast(tt("wishOk")); if (reload) reload(); }
          catch (x) { toast(kErr(x), true); }
        } else toast(tt("confirmed"));
        d.close();
      };
    }

    // ---------- чат ----------
    function renderChat() {
      const log = $("#lvLog", root); if (!log) return;
      const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      log.innerHTML = chat.length ? chat.map(m => {
        if (m.by === "sys") return `<p class="kmsg-sys">${av(m.hid)} ${tt("sys." + m.kind, { n: esc(nameOf(m.hid)), p: m.plot ? esc(m.plot) : "—" })} <time>${ago(m.at)}</time></p>`;
        const mine = m.by === me();
        return `<div class="kmsg${mine ? " kmsg-me" : ""}">${av(m.by)}<div><b style="color:${colorOf(m.by)}">${esc(nameOf(m.by))}</b> <time>${ago(m.at)}</time>
          ${m.about ? `<small class="kmsg-about">${tt("about", { n: esc(nameOf(m.about)) })}</small>` : ""}<p>${esc(m.text)}</p></div></div>`;
      }).join("") : `<p class="fine">${tt("chatEmpty")}</p>`;
      if (atEnd || chat.length && chat[chat.length - 1].by === me()) log.scrollTop = log.scrollHeight;
    }

    // ---------- сводка мест ----------
    function renderSum() {
      const box = $("#lvSum", root); if (!box || !data || !V()) return;
      const key = JSON.stringify([data.pins.map(p => [p.hid, p.verdict, p.confirmed, p.pros.length, p.cons.length, votes(p)]), data.summary && data.summary.at, I.lang]);
      if (key === sumKey) return; sumKey = key;
      const without = V().households.filter(h => !pinOf(h.id));
      const conf = data.pins.filter(p => p.confirmed).length;
      box.innerHTML = `<div class="ksum"><h3>${tt("sumT")} <small class="fine">${tt("sumD", { n: data.pins.length, a: V().households.length, c: conf })}</small></h3>
        ${data.pins.length ? `<div class="ksum-list">${data.pins.map(p => { const vt = votes(p); return `<div class="ksum-row">${av(p.hid)}<div class="ksum-main"><b>${esc(nameOf(p.hid))}</b> ${verdictChip(p.verdict)}${p.confirmed ? ` <span class="kvd kvd-good">✓ ${tt("pinOk")}</span>` : ""}
          <small>${placeLine(p)}</small>
          <div class="kvote">${p.hid === me() ? `<span class="fine">${tt("yes")}: ${vt.up} · ${tt("no")}: ${vt.down}</span>` : `<button type="button" class="btn btn-sm ${vt.my > 0 ? "btn-green" : "btn-soft"}" data-sv="1" data-hid="${esc(p.hid)}" aria-pressed="${vt.my > 0}">${ic("check")} ${tt("yes")} · ${vt.up}</button><button type="button" class="btn btn-sm ${vt.my < 0 ? "btn-danger" : "btn-ghost"}" data-sv="-1" data-hid="${esc(p.hid)}" aria-pressed="${vt.my < 0}">${ic("x")} ${tt("no")} · ${vt.down}</button>`}</div>
          <div class="kpc-2">${listOf(p.pros.slice(0, 2), "kpc-pro", "＋")}${listOf(p.cons.slice(0, 3), "kpc-con", "－")}</div></div></div>`; }).join("")}</div>` : ""}
        ${without.length ? `<p class="fine">${tt("noPinYet", { n: without.map(h => esc(h.name)).join(", ") })}</p>` : ""}
        ${data.pins.length ? `<div class="kai" id="lvSumAi"><b>${tt("sumAiT")}</b>${data.summary ? aiHtml(data.summary.text) + `<p class="fine">${tt("sumAt", { t: ago(data.summary.at), n: data.summary.pins })}</p>` : `<p class="fine">${tt("sumAiD")}</p>`}
          <button type="button" class="btn btn-soft btn-sm" id="lvSumGo">${tt(data.summary ? "sumAgain" : "sumGo")}</button></div>` : ""}</div>`;
      $$("[data-sv]", box).forEach(b => b.onclick = async () => { const p = pinOf(b.dataset.hid), v = +b.dataset.sv; if (!p) return; await pinAct({ op: "vote", target: p.hid, v: votes(p).my === v ? 0 : v }, b); sumKey = ""; renderSum(); });
      const go = $("#lvSumGo", box); if (go) go.onclick = async () => {
        go.disabled = true; go.innerHTML = `<span class="spin" aria-hidden="true"></span> ${tt("aiWait")}`;
        try { const r = await C.kel("POST", `/${getCur().id}/summary`, getCur().key, { lang: I.lang }); if (r.summary) { data.summary = r.summary; sumKey = ""; renderSum(); } else { toast(tt("aiNo"), true); go.disabled = false; go.textContent = tt("sumGo"); } }
        catch (x) { toast(kErr(x), true); go.disabled = false; go.textContent = tt("sumGo"); }
      };
    }

    // уход со страницы — опрос карты и чата больше не нужен (и не оставляет прерванный запрос)
    window.addEventListener("pagehide", () => stop(false));
    return { mount, stop, colorOf, get data() { return data; } };
  };
})();
