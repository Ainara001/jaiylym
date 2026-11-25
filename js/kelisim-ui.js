/* Jaiylym — экраны Келісім: согласование плана выпаса. Участник (в коде — household, hh, «двор») — хозяйство или общее стадо.
 * Расчёт и последствия — web/kelisim.js (в браузере, без сети), состояние и ответы — сервер (kelisim.js).
 * Адреса: #/kelisim — список и начало; #/kelisim?new=1 — новое; ?id=…&o=… — организатор; ?id=…&d=… — двор по личной ссылке.
 * Ключи ссылок хранятся только в этом браузере; на сервере — их SHA-256. */
(function () {
  "use strict";
  window.KelisimUI = function (X) {
    const { t, I, S, C, J, K, NM, $, $$, esc, ic, src, fmt, fmt1, pct, dateStr, scheme, toast, go, openVillage, EXAMPLES, exName, regName } = X;
    const LIST = "jaiylym:kel", VIEW = "jaiylym:kelv:", POLL = 20000;
    const DIRS = ["С", "СВ", "В", "ЮВ", "Ю", "ЮЗ", "З", "СЗ"];
    const SP = K ? K.SPECIES : ["sheep", "goats", "cattle", "horses"];
    let cur = null, V = null, at = null, offline = false, fail = null, loading = false, busy = false, dirty = false, fresh = false, on = false, timer = null, seq = 0;
    let f = null;                                        // форма ответа двора: { mode, plot, to, reason, text, observed_on, herd, home, daily, effect }
    const OFFICIAL = false;                               // сверка со сведениями акимата: скрыта в МВП, сервер её понимает
    let N = null;                                        // черновик нового согласования

    const el = () => $("#kelPage");
    const tt = (k, v) => t("kel." + k, v);

    // ---------- память браузера: какие согласования открывали здесь и какие личные ссылки выпустили ----------
    const saved = () => C.ls.get(LIST, []).filter(x => x && x.id && x.key);
    const rec = (id, role) => saved().find(x => x.id === id && x.role === role);
    function remember(id, role, key, patch) {
      const old = saved().find(x => x.id === id && x.role === role && x.key === key) || {};
      C.ls.set(LIST, [Object.assign({}, old, { id, role, key, at: new Date().toISOString() }, patch)].concat(saved().filter(x => !(x.id === id && x.role === role && x.key === key))).slice(0, 30));
    }
    function forget(id, role, key) { C.ls.set(LIST, saved().filter(x => !(x.id === id && x.role === role && x.key === key))); C.ls.del(VIEW + id + ":" + role); }
    const site = () => location.href.split("#")[0];
    const linkOf = (id, role, key) => `${site()}#/kelisim?id=${id}&${role === "org" ? "o" : "d"}=${key}`;

    // ---------- слова ----------
    const dirOf = id => id.slice(2);
    const plotName = id => `${tt(id.startsWith("Б") ? "near" : "far")}, ${tt("dir." + DIRS.indexOf(dirOf(id)))}`;
    const nw = id => `<span class="nw">${esc(id)}</span>`;                        // код участка не рвётся по дефису
    const plotFull = id => `${plotName(id)} <span class="nw">(${esc(id)})</span>`;
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
    const low = s => (s === s.toUpperCase() ? s : s.toLowerCase());            // «овцы», но «КРС»
    const herdLine = h => { const s = SP.filter(k => h && h[k]).map(k => `${low(t("herds." + k))} ${fmt(h[k])}`); return s.length ? s.join(", ") : tt("noHerd"); };
    const changes = h => h.herd_log.filter(x => SP.some(s => x.from && x.from[s]));   // первый ввод скота — не изменение
    const many = ids => (ids.length > 2 ? ids.map(nw).join(", ") : ids.map(plotFull).join(", ")) || "—";      // длинный список участков — кодами
    const span = s => (s.from === s.to ? day(s.from) : `${day(s.from)} – ${day(s.to)}`);
    const day = n => {
      const P = J.params(V.snapshot.params || null), [m, d] = String(P.season_start || "05-01").split("-").map(Number), x = new Date(Date.UTC(V.season, m - 1, d + n - 1));
      return `${String(x.getUTCDate()).padStart(2, "0")}.${String(x.getUTCMonth() + 1).padStart(2, "0")}`;
    };
    const tons = x => (x >= 10 ? fmt(x) : fmt1(x));
    const hay = hid => { const x = V.plan ? K.hayOf(V, V.plan, hid) : 0; return x >= 0.1 ? tt("hayShort", { t: tons(x) }) : ""; };
    /** Кто это и кто отвечает: «общее стадо, хозяев 30, отвечает пастух». */
    const whoLine = h => `${tt("kind." + h.kind)}${h.kind === "common" ? `, ${h.owners ? tt("ownersN", { n: h.owners }) : tt("ownersNo")}` : ""}, ${tt("resp." + h.resp)}`;
    const seasonLine = () => tt("season", { y: V.season, a: day(1), b: day(J.params(V.snapshot.params || null).season_days) });
    const dOnly = s => (s ? s.split("-").reverse().join(".") : "");
    const nameOf = id => { const h = V.households.find(x => x.id === id); return h ? h.name : tt("gone"); };
    const me = () => V.households.find(h => h.id === V.me);
    const chip = (k, txt) => `<span class="kst kst-${k}">${esc(txt)}</span>`;
    const ansChip = h => (V.status === "collect" ? (K.SPECIES.some(s => h.herd[s]) ? chip("agree", tt("st.herd")) : chip("pending", tt("st.noherd"))) : chip(h.answer, tt("st." + h.answer) + (h.carried ? " " + tt("st.carried") : "")));
    const kErr = e => {
      const w = e && e.data && e.data.why;
      if (w && t("kel.err." + w) !== "kel.err." + w) return tt("err." + w);
      if (e && e.status === 403) return tt("err.link");
      if (e && e.status === 404) return tt("err.gone");
      if (e && e.status === 429) return tt("err.many");
      if (e && e.status >= 500) return t("err.server");
      return X.errText(e);
    };
    const spin = txt => `<p class="startload"><span class="spin" aria-hidden="true"></span><span>${txt}</span></p>`;
    const opened = () => Object.fromEntries($$("details[data-d]", el()).map(d => [d.dataset.d, d.open]));
    function put(html) {
      const was = opened(), box = el();
      box.innerHTML = html;
      $$("details[data-d]", box).forEach(d => { if (was[d.dataset.d] != null) d.open = was[d.dataset.d]; });
    }
    /** Опасное действие — вторым нажатием. */
    function arm(b, fn) {
      if (!b) return;
      let a = false; const was = b.innerHTML;
      b.onclick = () => { if (a) return fn(b); a = true; b.textContent = tt("sure"); b.classList.add("btn-danger"); setTimeout(() => { if (b.isConnected) { a = false; b.innerHTML = was; b.classList.remove("btn-danger"); } }, 5000); };
    }

    // ---------- сеть ----------
    const viewKey = () => VIEW + cur.id + ":" + cur.role;
    function setView(v) {
      if (V && v.version !== V.version && f) f.effect = null;
      V = v; at = new Date().toISOString(); offline = false; fail = null; fresh = false;
      C.ls.set(viewKey(), { at, key: cur.key, v });
      remember(cur.id, cur.role, cur.key, { title: v.title, village: v.village.name, name: cur.role === "hh" ? (me() || {}).name : undefined });
    }
    async function load(quiet, force) {
      if (!cur || (loading && quiet)) return;
      const n = ++seq; loading = true;
      if (!quiet) draw();
      try {
        const v = await C.kel("GET", "/" + cur.id, cur.key);
        if (n !== seq) return;
        loading = false;
        if (V && V.rev === v.rev && !offline && !fail && V.expired === v.expired) return;
        if (!force && V && (dirty || f || document.querySelector("dialog[open].kel-dlg"))) { fresh = true; freshBar(); return; }
        setView(v); draw();
      } catch (e) {
        if (n !== seq) return;
        loading = false;
        if (e.status === 403 || e.status === 404) { fail = e.status; V = null; C.ls.del(viewKey()); draw(); return; }
        if (quiet) { if (!offline && V) { offline = true; freshBar(); } return; }
        const hit = C.ls.get(viewKey(), null);
        if (hit && hit.key === cur.key && hit.v) { V = hit.v; at = hit.at; offline = true; } else fail = "net";
        draw();
      }
    }
    async function act(b, path, body, okText) {
      if (busy) return null;
      const c = cur;
      busy = true; if (b) { b.disabled = true; b.setAttribute("aria-busy", "true"); }
      try {
        const r = await C.kel("POST", "/" + c.id + path, c.key, body || {});
        busy = false;
        if (cur !== c) return null;                        // человек уже ушёл на другой экран
        seq++; loading = false;
        if (r.link) { const o = rec(cur.id, "org"); remember(cur.id, "org", cur.key, { links: Object.assign({}, o && o.links, { [r.link.id]: r.link.key }) }); }
        if (r.state) setView(r.state);
        if (okText) toast(okText);
        return r;
      } catch (e) {
        busy = false;
        toast(kErr(e), true);
        if (cur !== c) return null;
        if (e.status === 403 || e.status === 404) { fail = e.status; V = null; draw(); }
        else if (e.data && (e.data.why === "rev" || e.data.why === "stale" || e.data.why === "decided" || e.data.why === "closed" || e.data.why === "started")) { if (f) f.effect = null; dirty = false; await load(false, true); }
        return null;
      } finally { if (b && b.isConnected) { b.disabled = false; b.removeAttribute("aria-busy"); } }
    }
    function freshBar() {
      const b = $("#kelBar"); if (!b) return;
      b.hidden = !(fresh || offline);
      b.innerHTML = fresh ? `<span>${tt("fresh")}</span><button type="button" class="btn btn-sm btn-soft" id="kelShow">${tt("show")}</button>`
        : `<span>${ic("wifioff")} ${tt("offline", { d: dateStr(at) })}</span><button type="button" class="btn btn-sm btn-ghost" id="kelShow">${tt("retry")}</button>`;
      const s = $("#kelShow"); if (s) s.onclick = () => { dirty = false; f = null; load(false, true); };
    }

    // ---------- маршрут ----------
    function route(active, q) {
      on = active;
      clearInterval(timer);
      document.body.classList.toggle("kel-guest", !!(active && q.get("id") && q.get("d")));
      if (!active) return;
      if (!K || typeof C.kel !== "function") { el().innerHTML = `<div class="card"><p>${tt("old")}</p></div>`; return; }   // старые файлы из кэша
      const id = q.get("id"), o = q.get("o"), d = q.get("d");
      if (id && (o || d)) {
        const role = o ? "org" : "hh", key = o || d;
        if (!cur || cur.id !== id || cur.key !== key) { seq++; loading = false; cur = { id, role, key }; V = null; f = null; dirty = false; fail = null; offline = false; const hit = C.ls.get(viewKey(), null); if (hit && hit.key === key) { V = hit.v; at = hit.at; } }
        timer = setInterval(() => { if (on && cur && !document.hidden && navigator.onLine && !busy) load(true); }, POLL);
        load(false);
        return;
      }
      seq++; loading = false;                              // ответ прежнего согласования больше не нужен
      cur = null; V = null; f = null; dirty = false; fail = null;
      if (q.get("new")) newPage(); else landing();
    }
    function draw() {
      if (!on || !cur) return;
      if (fail) return failPage();
      if (!V) { put(`<div class="card">${spin(tt("loading"))}</div>`); return; }
      if (cur.role === "org" && V.role !== "org") { fail = 403; return failPage(); }
      (V.role === "org" ? orgPage : hhPage)();
      freshBar();
    }
    function failPage() {
      const org = cur.role === "org";
      put(`<div class="card"><h1>${tt(fail === 403 ? "fail.link" : fail === 404 ? "fail.gone" : "fail.net")}</h1><p>${tt(fail === 403 ? "fail.linkD" : fail === 404 ? "fail.goneD" : "fail.netD")}</p>
        <div class="startbtns"><button type="button" class="btn btn-primary" id="kelRe">${tt("retry")}</button>${org && fail === 404 ? `<label class="btn btn-ghost">${tt("restore")}<input type="file" id="kelFile" accept=".json,application/json" hidden></label>` : ""}<a class="btn btn-ghost" href="#/kelisim">${tt("toList")}</a></div></div>`);
      $("#kelRe").onclick = () => { fail = null; load(false); };
      bindRestore();
    }

    // ---------- начало: что это, мои согласования ----------
    function landing() {
      const list = saved();
      put(`<h1>${tt("title")}</h1><p class="lead">${tt("lead")}</p>
        <div class="card"><ol class="ksteps"><li><b>${tt("s1")}</b><span>${tt("s1d")}</span></li><li><b>${tt("s2")}</b><span>${tt("s2d")}</span></li><li><b>${tt("s3")}</b><span>${tt("s3d")}</span></li></ol>
          <div class="startbtns">${S.D ? `<a class="btn btn-primary" href="#/kelisim?new=1">${tt("startFor", { v: esc(S.D.village.name) })}</a>` : `<a class="btn btn-primary" href="#/map">${tt("pickVillage")}</a>`}
          <button type="button" class="btn btn-ghost" id="kelDemo">${tt("demo", { v: esc(exName(EXAMPLES[0])) })}</button></div>
          <p class="fine">${ic("shield")}<span>${tt("noRights")}</span></p></div>
        ${list.length ? `<div class="card"><h2>${tt("mine")}</h2><ul class="list">${list.map((x, i) => `<li class="row"><div class="grow"><b>${esc(x.title || x.village || x.id)}</b><small>${tt(x.role === "org" ? "asOrg" : "asHh", { n: esc(x.name || "") })} · ${dateStr(x.at)}</small></div>
          <div class="btns"><a class="btn btn-soft btn-sm" href="${esc(linkOf(x.id, x.role, x.key).replace(site(), ""))}">${tt("open")}</a><button type="button" class="btn btn-ghost btn-sm" data-forget="${i}" aria-label="${tt("forget")}">${ic("x")}</button></div></li>`).join("")}</ul>
          <p class="fine">${tt("mineD")}</p></div>` : ""}
        <p><label class="linkbtn">${tt("restore")}<input type="file" id="kelFile" accept=".json,application/json" hidden></label></p>`);
      $("#kelDemo").onclick = async () => { const v = EXAMPLES[0].data.village; N = null; await openVillage(v.name, v.lat, v.lon, { demo: true, keepRoute: true }); if (!on) return; if (/new=1/.test(location.hash)) newPage(); else go("kelisim", "new=1"); };
      $$("[data-forget]").forEach(b => arm(b, () => { const x = list[+b.dataset.forget]; forget(x.id, x.role, x.key); landing(); }));
      bindRestore();
    }
    function bindRestore() {
      const i = $("#kelFile"); if (!i) return;
      i.onchange = async () => {
        try {
          const b = JSON.parse(await i.files[0].text()), id = JSON.parse(b.data).id, r = (cur && cur.role === "org" && cur.id === id) ? cur : rec(id, "org");
          if (!r) { toast(tt("err.restoreKey"), true); return; }
          const x = await C.kel("POST", "/restore", r.key, b);
          toast(tt(x.verified ? "restored" : "restoredUn"));
          cur = null; const h = linkOf(id, "org", r.key).split("#")[1];
          if (location.hash === "#" + h) route(true, new URLSearchParams(h.split("?")[1])); else location.hash = h;
        } catch (e) { toast(e instanceof SyntaxError ? tt("err.file") : kErr(e), true); }
        i.value = "";
      };
    }

    // ---------- новое согласование ----------
    const blank = () => ({ name: "", kind: "farm", owners: null, resp: "owner", herd: { sheep: 0, goats: 0, cattle: 0, horses: 0 }, home: "Б-С", daily_return: false, weight: 1, allowed: [] });
    function draft() {
      const key = S.D.village.lat + "," + S.D.village.lon;
      if (N && N.key === key) return N;
      const rows = S.herds.filter(h => !h.from_bot).map(h => ({ name: h.name, kind: h.kind === "common" ? "common" : "farm", owners: +h.owners || null, resp: h.kind === "common" ? "herder" : "owner", herd: Object.fromEntries(SP.map(s => [s, +h[s] || 0])), home: h.home, daily_return: !!h.daily_return, weight: +h.weight || 1, allowed: h.allowed_plots || [], demo: !!h.demo }));
      while (rows.length < 2) rows.push(blank());
      return (N = { key, title: tt("defTitle", { v: S.D.village.name }), rows, rule: "share", deadline: "", season: K.defaultSeason(Date.now(), S.P) });
    }
    async function newPage() {
      if (!S.D) {
        const last = C.ls.get("jaiylym:last", null);
        if (!last) return landing();
        put(`<div class="card">${spin(tt("loading"))}</div>`);
        await openVillage(last.name, last.lat, last.lon, { keepRoute: true });
        if (!on || cur) return;
        if (!S.D) return landing();
      }
      const n = draft();
      put(`<p><a class="linkbtn" href="#/map">${tt("backMap")}</a></p><h1>${tt("newTitle")}</h1><p class="lead">${tt("newLead", { v: esc(S.D.village.name) })}</p>
        ${n.rows.some(r => r.demo) ? `<p class="note warn">${tt("demoNote")}</p>` : ""}${!S.normSel ? `<p class="note warn">${t("nm.noRegion")}</p>` : ""}
        <div class="card zone-${S.zone ? S.zone.mode : "all"}"><h2>${t("zn.title")}</h2><p>${X.zoneText()}</p>${!S.zone || S.zone.mode === "all" ? `<p class="note warn">${t("zn.kel")}</p>` : ""}
          <div class="startbtns"><button type="button" class="btn btn-soft" id="kelZDraw">${ic("pen")} ${t("zn.draw")}</button><button type="button" class="btn btn-soft" id="kelZOff">${ic("x")} ${t("zn.mark")}</button></div></div>
        <div class="card"><h2>${tt("yards")}</h2><p>${tt("yardsD")}</p><div id="kelRows">${n.rows.map(newRow).join("")}</div>
          <button type="button" class="btn btn-soft" id="kelAdd">${ic("plus")} ${tt("addYard")}</button></div>
        <div class="card"><h2>${tt("rules")}</h2>${ruleHtml(n.rule, "kelRule")}
          <div class="formgrid kform"><label class="field span2">${tt("name")}<input id="kelTitle" maxlength="80" value="${esc(n.title)}"></label><label class="field span2">${tt("seasonQ")}<select id="kelSeason">${[0, 1].map(i => K.defaultSeason(Date.now(), S.P) + i).map(y => `<option value="${y}" ${n.season === y ? "selected" : ""}>${y}</option>`).join("")}</select></label><label class="field span2">${tt("deadline")}<input type="date" id="kelDeadline" value="${esc(n.deadline)}"></label></div>
          <p class="fine">${tt("deadlineD")}</p></div>
        <p class="note">${tt("snapNote", { d: S.D.source.dates ? S.D.source.dates.length : 0, y: S.D.source.year })}</p>
        <p class="kerr" id="kelErr" role="alert" hidden></p>
        <button type="button" class="btn btn-primary kbig" id="kelCreate">${tt("create")}</button><p class="fine">${ic("shield")}<span>${tt("noRights")} ${tt("noPhones")}</span></p>`);
      const grab = () => {
        $$("#kelRows .krow").forEach((r, i) => { const x = n.rows[i]; x.name = $("[data-f=name]", r).value.trim(); readHerd(r, x); readWho(r, x); });
        n.title = $("#kelTitle").value.trim(); n.season = +$("#kelSeason").value; n.deadline = $("#kelDeadline").value; n.rule = ($("[name=kelRule]:checked") || {}).value || "share";
      };
      el().oninput = () => { if (!$("#kelTitle")) return; grab(); $$("#kelRows .krow").forEach((r, i) => { $("summary span", r).innerHTML = rowSum(n.rows[i]); }); };
      $("#kelZDraw").onclick = () => { grab(); X.startZone(); };
      $("#kelZOff").onclick = () => { grab(); X.closedDlg(); };
      $("#kelAdd").onclick = () => { grab(); n.rows.push(blank()); newPage().then(() => { const x = $$("#kelRows [data-f=name]"); x[x.length - 1].focus(); }); };
      $$("[data-rmrow]").forEach(b => b.onclick = () => { grab(); n.rows.splice(+b.dataset.rmrow, 1); newPage(); });
      $("#kelCreate").onclick = async e => {
        grab();
        const rows = n.rows.filter(r => r.name), err = $("#kelErr"), b = e.currentTarget;
        const msg = rows.length < 2 ? tt("err.two") : new Set(rows.map(r => r.name.toLowerCase())).size < rows.length ? tt("err.name_taken") : "";
        err.hidden = !msg; err.textContent = msg;
        if (msg) { err.scrollIntoView({ block: "center" }); return; }
        if (busy) return;
        busy = true; b.disabled = true; b.innerHTML = spin(tt("creating"));
        try {
          const r = await C.kel("POST", "", "", { title: n.title, season: n.season, rule: n.rule, deadline: n.deadline || undefined, snapshot: snapshot(),
            households: rows.map(x => Object.assign({ name: x.name, kind: x.kind, owners: x.owners, resp: x.resp, home: x.home, daily_return: x.daily_return, weight: x.weight, allowed: x.allowed }, SP.some(s => x.herd[s]) ? { herd: x.herd } : {})) });
          remember(r.id, "org", r.organizer_key, { title: r.state.title, village: r.state.village.name, links: Object.fromEntries(r.links.map(l => [l.id, l.key])) });
          N = null;
          location.hash = linkOf(r.id, "org", r.organizer_key).split("#")[1];
        } catch (x) { err.textContent = kErr(x); err.hidden = false; b.disabled = false; b.textContent = tt("create"); }
        busy = false;
      };
    }
    function snapshot() {
      return { village: { name: S.D.village.name, lat: S.D.village.lat, lon: S.D.village.lon }, plots: S.plots.map(({ geometry, ...p }) => p), params: Object.assign({}, S.P), norm: S.normSel || undefined, zone: S.zone || undefined,
        source: { year: S.D.source.year, dates: S.D.source.dates, nograze: (S.D.nograze && S.D.nograze.status) || "none" } };
    }
    const newRow = (r, i) => `<div class="krow"><div class="krow-h"><label class="field"><span>${tt("yardName")} ${i + 1}${r.demo ? ` <span class="tag tag-demo">${t("herds.demo")}</span>` : ""}</span><input data-f="name" maxlength="60" value="${esc(r.name)}" placeholder="${esc(tt("yardPh"))}"></label>
      <button type="button" class="btn btn-ghost btn-icon2" data-rmrow="${i}" aria-label="${tt("rmYard")}">${ic("x")}</button></div>
      <details data-d="r${i}"><summary><span>${rowSum(r)}</span></summary>${whoForm(r, "kw" + i)}${herdForm(r)}</details></div>`;
    const rowSum = r => `${cap(tt("kind." + r.kind))}. ${tt("herd")}: ${SP.some(s => r.herd[s]) ? esc(herdLine(r.herd)) : tt("selfHerd")}`;
    const whoForm = (x, nm) => `<div class="kwho"><div class="kchips" role="radiogroup" aria-label="${tt("whoQ")}">${K.KINDS.map(k => `<label class="chip"><input type="radio" name="${nm}" data-k="${k}" ${x.kind === k ? "checked" : ""}>${cap(tt("kind." + k))}</label>`).join("")}</div>
      <div class="kwho-f"><label class="field kowners">${tt("ownersQ")}<input type="number" inputmode="numeric" min="2" max="500" step="1" data-f="owners" value="${x.owners || ""}"></label><label class="field">${tt("respQ")}<select data-f="resp">${K.RESP.map(r => `<option value="${r}" ${x.resp === r ? "selected" : ""}>${tt("respO." + r)}</option>`).join("")}</select></label></div></div>`;
    function readWho(r, x) {
      const c = $("[data-k]:checked", r); if (!c) return;
      x.kind = c.dataset.k; x.resp = $("[data-f=resp]", r).value;
      const n = Math.round(+$("[data-f=owners]", r).value || 0); x.owners = x.kind === "common" && n > 0 ? Math.min(500, n) : null;
    }
    const herdForm = x => `<div class="herd-grid">${SP.map(s => `<label class="field">${t("herds." + s)}<input type="number" inputmode="numeric" min="0" max="20000" step="1" data-h="${s}" value="${(x.herd && x.herd[s]) || 0}"></label>`).join("")}</div>
      <label class="field kf">${tt("home")}<select data-f="home">${DIRS.map(d => `<option value="Б-${d}" ${x.home === "Б-" + d ? "selected" : ""}>${tt("dir." + DIRS.indexOf(d))}</option>`).join("")}</select></label>
      <label class="check kcheck"><input type="checkbox" data-f="daily" ${x.daily_return ? "checked" : ""}> <span>${tt("daily")}</span></label>`;
    function readHerd(r, x) {
      if (!$("[data-h]", r)) return;
      x.herd = Object.fromEntries(SP.map(s => [s, Math.min(20000, Math.max(0, Math.round(+$(`[data-h="${s}"]`, r).value || 0)))]));
      x.home = $("[data-f=home]", r).value; x.daily_return = $("[data-f=daily]", r).checked;
    }
    const ruleHtml = (v, name, dis) => `<fieldset class="krule"><legend>${tt("ruleQ")}</legend>${K.RULES.map(r => `<label class="kopt"><input type="radio" name="${name}" value="${r}" ${r === v ? "checked" : ""} ${dis ? "disabled" : ""}><span><b>${tt("rule." + r)}</b><small>${tt("rule." + r + "D")}</small></span></label>`).join("")}</fieldset>`;

    // ---------- наблюдения людей ----------
    const OV = { check: "sat_blind", match: "sat_sparse" };
    /** Что говорит сверка: код → фраза. */
    const obsWhy = i => (OV[i.verdict] ? t("obs.w." + (i.why || OV[i.verdict]), { d: dOnly(i.scene), v: i.ndvi == null ? "" : String(i.ndvi).replace(".", ",") }) : t("obs.v." + i.verdict));
    const obsItem = i => `<li><b>${tt("rs." + i.reason)}</b>${i.households.length > 1 ? ` (${t("obs.yards", { n: i.households.length })})` : ""}${i.dates.length ? `, ${i.dates.map(dOnly).join(", ")}` : ""}. <span class="obs-${i.verdict}">${obsWhy(i)}</span></li>`;
    const obsItems = (g, st) => `<ul class="kef"${st ? ` style="${st}"` : ""}>${g.items.map(obsItem).join("")}</ul>`;
    const obsTag = v => (v === "check" ? `<span class="tag tag-check">${t("obs.check")}</span>` : "");
    function obsCard() {
      const e = Object.entries(K.obsOf(V));
      if (!e.length) return "";
      const n = e.filter(([, g]) => g.verdict === "check").length;
      return `<details data-d="obs" class="card kdet"><summary><span>${t("obs.title")}${n ? ` · ${t("obs.check").toLowerCase()}: ${n}` : ""}</span></summary><p class="fine">${t("obs.note")}</p>
        ${e.sort((a, b) => (b[1].verdict === "check") - (a[1].verdict === "check")).map(([id, g]) => `<div class="kvar"><b>${plotFull(id)}</b> ${obsTag(g.verdict)}${obsItems(g)}</div>`).join("")}</details>`;
    }
    /** Наблюдения по селу из согласований, открытых на этом устройстве (имена дворов и пояснения на карту не идут). */
    function observations(v) {
      const seen = new Set(), out = [];
      if (!K || !K.observations) return out;
      for (const x of saved()) {
        if (seen.has(x.id)) continue;
        const c = ["org", "hh"].map(r => C.ls.get(VIEW + x.id + ":" + r, null)).filter(y => y && y.v && y.v.village).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
        if (!c || Math.abs(c.v.village.lat - v.lat) > 0.0015 || Math.abs(c.v.village.lon - v.lon) > 0.0015) continue;
        seen.add(x.id);
        try { for (const o of K.observations(c.v)) out.push(Object.assign({}, o, { household: x.id + ":" + o.household })); } catch (_) {}
      }
      return out;
    }
    const obsHint = () => {
      if (!f || f.mode !== "avoid" || !K.OBS.includes(f.reason) || !f.plot || f.reason === "far") return "";
      const p = V.snapshot.plots.find(x => x.id === f.plot), c = K.compareObs({ reason: f.reason, on: f.observed_on, plot: f.plot }, p, V.snapshot.source, V.snapshot.params);
      return `${c.verdict === "check" ? `<b>${t("obs.check")}.</b> ` : ""}${obsWhy(c)} ${t("obs.noChange")}`;
    };
    const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);

    // ---------- общее для обоих экранов ----------
    const head = extra => `<div class="notebar" id="kelBar" role="status" hidden></div><div class="khead"><h1>${esc(V.title)}</h1><p class="fine">${esc(V.village.name)} · ${seasonLine()}${V.deadline ? ` · ${tt("until", { d: dOnly(V.deadline) })}` : ""}${extra || ""}</p></div>`;
    const limits = () => `<p class="fine klim">${ic("shield")}<span>${tt("noRights")} ${tt("estimate")}</span></p>`;
    const shareBar = s => `<span class="kbar"><i style="width:${Math.round(Math.min(1, s) * 100)}%" class="${s >= 0.995 ? "ok" : s >= 0.8 ? "mid" : "low"}"></i></span>`;
    function everyone() {
      return `<details data-d="all" class="card kdet"><summary><span>${tt("everyone", { n: V.households.length })}</span></summary><p class="fine">${tt("everyoneD")}</p>
        <ul class="list">${V.households.map(h => `<li class="krowp"><div><b>${esc(h.name)}${h.id === V.me ? ` <span class="tag tag-mine">${tt("you")}</span>` : ""}</b>${ansChip(h)}</div>
          <small>${whoLine(h)}</small><small>${esc(herdLine(h.herd))} · ${tt("hs." + h.herd_status)}</small>${changes(h).map(x => `<small class="kwarn">${dateStr(x.at, false)}: ${esc(herdLine(x.from))} → ${esc(herdLine(x.to))}</small>`).join("")}
          ${V.plan ? `<div class="kshare">${shareBar(V.plan.share[h.id])}<small>${tt("feedShort", { p: pct(V.plan.share[h.id]), d: V.plan.days[h.id], s: V.plan.season_days })}${hay(h.id) ? ` · ${hay(h.id)}` : ""}</small></div>` : ""}</li>`).join("")}</ul>
        ${V.herds.over.map(o => `<p class="note warn">${tt("over", { s: low(t("herds." + o.species)), a: fmt(o.declared), b: fmt(o.official) })}</p>`).join("")}</details>`;
    }
    function routeHtml(hid) {
      const segs = (V.plan.routes[hid] || []), D = V.plan.season_days;
      if (!segs.length) return `<p class="note">${tt("noRoute")}</p>`;
      const why = Object.fromEntries((K.why(V, hid) || []).map(w => [w.plot, w]));
      const bars = segs.map(s => `<span class="${s.plot ? (s.plot.startsWith("Б") ? "near" : "far") : "gap"}" style="left:${(s.from - 1) / D * 100}%;width:${(s.to - s.from + 1) / D * 100}%"></span>`).join("");
      let told = "";                                     // одинаковая причина подряд — один раз
      return `<ol class="kroute">${segs.map(s => {
        const w = why[s.plot], txt = w && s.plot ? w.codes.map(c => tt("why." + c)).join(" ") : "", first = txt && txt !== told; if (txt) told = txt;
        return `<li class="${s.plot ? "" : "gap"}"><b>${s.plot ? plotFull(s.plot) : tt("gap")}</b><span>${span(s)} · ${tt("days", { n: s.to - s.from + 1 })}${w && s.plot && w.km >= 0.1 ? ` · ${tt("km", { n: fmt1(w.km) })}` : ""}</span>
          ${first && w ? `<small>${txt}</small>` : !s.plot ? `<small>${tt("gapD")}</small>` : ""}</li>`; }).join("")}</ol>
        <div class="tl" aria-hidden="true">${bars}</div>`;
    }
    const mapOf = (ids, also) => `<div class="kmap">${scheme(V.snapshot.plots, p => (ids.includes(p.id) ? "#b05627" : (also || []).includes(p.id) ? "#2f7aa6" : "#9db3a2"), () => "", { size: 300 })}<small class="fine">${tt("mapNote")}</small></div>`;
    const whyVersion = () => {
      const w = (V.versions[V.versions.length - 1] || {}).why || {};
      return w.type === "proposal" ? tt(w.household === V.me ? "wv.mine" : "wv.proposal", { n: esc(nameOf(w.household)) }) : w.type === "start" ? "" : tt("wv." + w.type, { n: esc(nameOf(w.household)) });
    };

    const zoneLine = z => (z ? t("zn.k." + z.mode + (z.official ? "O" : ""), { ha: fmt(z.ha) }) : "");

    // ---------- последствия ----------
    const names = list => list.map(x => esc(x.name || nameOf(x.id || x))).join(", ");
    const ppt = x => (x > 0 ? "+" : "−") + fmt1(Math.abs(x) * 100);
    /** Вариант последствий. hid — чей это запрос; own — смотрит сам двор. */
    function variantHtml(v, hid, own) {
      const o = v.own, D = V.plan.season_days, rows = [];
      rows.push(`<li>${own ? tt("ef.you") : esc(nameOf(hid)) + ":"} ${tt("ef.days", { a: o.days0, b: o.days1, s: D })}. ${o.route ? `${tt("ef.plots")}: ${many(o.plots0)} → <b>${many(o.plots1)}</b>.` : tt("ef.sameRoute")}</li>`);
      const los = v.losers.filter(x => x.id !== hid);
      if (los.length) rows.push(`<li class="kbad">${tt("ef.lose")}: ${los.map(x => `${esc(x.name)} ${ppt(x.delta)} ${tt("pp")} (${x.days0} → ${x.days1} ${tt("dShort")})`).join("; ")}</li>`);
      else if (v.others_loss_t > 0.5) rows.push(`<li class="kbad">${tt("ef.spread", { t: fmt1(v.others_loss_t) })}</li>`);
      else rows.push(`<li class="kok">${tt("ef.nobody")}</li>`);
      if (v.farther.length) rows.push(`<li class="kbad">${tt("ef.farther")}: ${v.farther.map(x => `${esc(x.name)} ${fmt1(x.km0)} → ${fmt1(x.km1)} ${tt("kmU")}`).join("; ")}</li>`);
      rows.push(`<li>${v.affected.length ? `${tt("ef.affected")}: ${names(v.affected.map(id => ({ id })))}. ${tt("ef.again")}` : tt("ef.noone")}</li>`);
      return `<ul class="kef">${rows.join("")}</ul>`;
    }
    const VORD = ["equal", "protect", "room"];
    function effectHtml(e, hid, own) {
      if (!e) return "";
      const top = `<p class="kverd kv-${e.verdict}">${tt("vd." + e.verdict + (own ? "" : "Org"))}${e.verdict === "error" ? " " + tt("ee." + (e.error === "not_allowed" ? "not_allowed" : "other")) : ""}</p>`;
      const vs = VORD.filter(n => e.variants && e.variants[n]);
      return top + (vs.length > 1 ? vs.map(n => `<div class="kvar"><b>${tt("var." + n)}</b>${variantHtml(e.variants[n], hid, own)}</div>`).join("") : vs.map(n => variantHtml(e.variants[n], hid, own)).join(""));
    }
    const propText = (p, own) => {
      const w = { avoid: () => tt("pt.avoid", { p: plotFull(p.plot) }), prefer: () => tt("pt.prefer", { p: plotFull(p.plot) }), swap: () => tt("pt.swap", { p: plotFull(p.plot), q: plotFull(p.to) }), herd: () => tt("pt.herd", { h: esc(herdLine(p.herd)) }), clear: () => tt("pt.clear"), other: () => tt("pt.other") }[p.type]();
      return `${w}${p.reason ? ` ${tt("reason")}: ${tt("rs." + p.reason)}.` : ""}${p.observed_on ? ` ${tt("seen", { d: dOnly(p.observed_on) })}` : ""}${p.text ? `<q>${esc(p.text)}</q>` : ""}`;
    };

    // ==================== ДВОР ====================
    function hhPage() {
      const h = me(); if (!h) { fail = 403; return failPage(); }
      const body = V.status === "collect" ? hhCollect(h) : hhPlan(h);
      put(head(` · ${esc(h.name)}`) + (V.restored && !V.restored.verified ? `<p class="note warn">${tt("restUn")}</p>` : "") + body + (V.status === "collect" ? "" : obsCard()) + everyone() + limits() + `<p class="fine"><a href="#/about">${tt("about")}</a></p>`);
      V.status === "collect" ? bindCollect(h) : bindPlan(h);
    }
    function hhCollect(h) {
      if (V.expired) return `<div class="card"><p class="note warn">${tt("expired", { d: dOnly(V.deadline) })}</p></div>`;
      return `<div class="card">${h.joined ? `<p class="kdone">${ic("check")} ${tt("joined")}</p>` : `<p>${tt("collect")}</p>`}
        <h2>${tt("yourHerd")}</h2><form id="kelJoin"><label class="field kf">${tt("nameQ")}<input data-f="name" maxlength="60" value="${esc(h.name)}"></label><p class="fine">${tt("noPhones")}</p>${whoForm(h, "kwMe")}${herdForm(h)}
        <button class="btn btn-primary kbig">${tt(h.joined ? "saveAgain" : "sendHerd")}</button></form><p class="fine">${tt("herdOpen")}</p></div>`;
    }
    function bindCollect(h) {
      const form = $("#kelJoin"); if (!form) return;
      form.oninput = () => { dirty = true; };
      form.onsubmit = async e => {
        e.preventDefault();
        const x = {}; readHerd(form, x); readWho(form, x);
        const name = $("[data-f=name]", form).value.trim();
        if (!name) { toast(tt("err.name"), true); return; }
        if (!SP.some(s => x.herd[s])) { toast(tt("err.zero"), true); return; }
        if (await act($("button", form), "/me", { name, kind: x.kind, owners: x.owners, resp: x.resp, herd: x.herd, home: x.home, daily_return: x.daily_return }, tt("savedOk"))) { dirty = false; draw(); scrollTo(0, 0); }
      };
    }
    function hhPlan(h) {
      const D = V.plan.season_days, s = V.plan.share[h.id], closed = V.status === "closed";
      const mine = V.proposals.filter(p => p.household === h.id), last = mine[mine.length - 1], open = mine.find(p => p.status === "open");
      const changed = V.versions.length > 1 && !closed, v0 = V.versions[V.versions.length - 2], d = v0 && v0.share[h.id] != null ? s - v0.share[h.id] : 0;
      const note = changed ? `<p class="note ${h.answer === "pending" ? "warn" : ""}"><b>${h.answer === "pending" ? tt("changed", { n: V.version }) : h.carried ? tt("carried", { n: V.version }) : tt("newVer", { n: V.version })}</b> ${whyVersion()} ${Math.abs(d) >= 0.01 ? tt("shareWas", { a: pct(v0.share[h.id]), b: pct(s) }) : tt("shareSame")}</p>` : "";
      return `${closed ? `<p class="note"><b>${tt("closedT")}</b> ${tt("out." + outcome())}</p>` : ""}${note}
        <div class="card"><p class="kfeed ${s >= 0.995 ? "ok" : s >= 0.8 ? "mid" : "low"}"><b>${s >= 0.995 ? tt("feedAll") : tt("feedPart", { d: V.plan.days[h.id], s: D })}</b>${s >= 0.995 ? "" : `<small>${tt("feedPartD", { p: pct(s), t: tons(K.hayOf(V, V.plan, h.id)) })}</small>`}</p>
          <p class="fine kline">${cap(whoLine(h))}. ${esc(cap(herdLine(h.herd)))}. ${src("model")}</p><p class="fine kline">${tt("yearNote", { y: V.snapshot.source.year, s: V.season })}</p>
          <h2>${tt("where")}</h2>${routeHtml(h.id)}${mapOf(K.plotsOf(V.plan.routes[h.id]))}
          <p class="fine kline">${zoneLine(V.snapshot.zone)}</p><details data-d="fair"><summary><span>${tt("fairQ")}</span></summary><p>${tt("rule." + V.rule + "D")} ${tt("fairD")}</p>${V.plan.bottleneck ? `<p>${tt("bottle", { p: V.plan.bottleneck.plots.map(nw).join(", "), t: fmt(V.plan.bottleneck.shortfall_t) })}</p>` : ""}</details></div>
        ${closed ? `<button type="button" class="btn btn-primary kbig" id="kelPdf">${ic("file")} ${tt("protocol")}</button>` : V.expired ? `<p class="note warn">${tt("expired", { d: dOnly(V.deadline) })}</p>` : answerHtml(h, open, last)}`;
    }
    function answerHtml(h, open, last) {
      const st = h.answer;
      const state = st === "agree" ? `<p class="kdone">${ic("check")} ${tt(h.carried ? "agreedCarried" : "agreed", { n: V.version })}</p>`
        : open ? `<div class="kwait"><b>${tt("sent")}</b><p>${propText(open, true)}</p></div>` : "";
      const was = !open && last && last.status !== "withdrawn" && (st !== "agree") ? `<div class="kwait"><b>${tt("pst." + last.status)}</b><p>${propText(last, true)}</p>${last.note ? `<p>${tt("orgNote")}: ${esc(last.note)}</p>` : ""}</div>` : "";
      const btns = f ? "" : `<div class="kans">${st === "agree" ? "" : `<button type="button" class="btn btn-primary" id="kelAgree">${ic("check")} ${tt(open ? "withdraw" : "agree")}</button>`}<button type="button" class="btn btn-ghost" id="kelObj">${tt(st === "agree" ? "change" : open ? "replace" : "object")}</button></div>`;
      // пока ответа нет, кнопки видны у нижнего края экрана (sticky), дальше встают на своё место
      const wait = !f && st === "pending";
      return (state || was || f || !wait ? `<div class="card" id="kelAns"><h2>${tt("answerQ")}</h2>${state}${was}${f ? objForm(h) : wait ? "" : btns}</div>` : `<div id="kelAns"></div>`) + (wait ? `<div class="kstick">${btns}</div>` : "");
    }
    const MODES = ["avoid", "prefer", "herd", "other"];
    function objForm(h) {
      const mine = K.plotsOf(V.plan.routes[h.id]), hh = V.households.find(x => x.id === h.id);
      const cand = K.candidates(V, Object.assign({}, hh, { avoid: (hh.avoid || []).filter(x => x !== f.plot) })).filter(id => !mine.includes(id));
      const radio = (name, ids, v) => `<div class="kchips">${ids.map(id => `<label class="chip"><input type="radio" name="${name}" value="${esc(id)}" ${v === id ? "checked" : ""}>${plotFull(id)}</label>`).join("")}</div>`;
      const modes = MODES.filter(m => (m !== "avoid" || mine.length) && (m !== "prefer" || cand.length));
      const part = {
        avoid: () => `${mine.length > 1 ? `<h3>${tt("q.which")}</h3>${radio("kPlot", mine, f.plot)}` : ""}<h3>${tt("q.why")}</h3><div class="kchips">${K.REASONS.map(r => `<label class="chip"><input type="radio" name="kReason" value="${r}" ${f.reason === r ? "checked" : ""}>${tt("rs." + r)}</label>`).join("")}</div>
          ${["no_grass", "weeds", "no_water"].includes(f.reason) ? `<label class="field kf">${tt("q.seen")}<input type="date" name="kSeen" max="${today()}" value="${esc(f.observed_on || "")}"></label><p class="note" id="kObsH" aria-live="polite">${obsHint()}</p>` : ""}
          ${cand.length ? `<label class="field kf">${tt("q.to")}<select name="kTo"><option value="">${tt("q.auto")}</option>${cand.map(id => `<option value="${esc(id)}" ${f.to === id ? "selected" : ""}>${plotName(id)} (${esc(id)})</option>`).join("")}</select></label>` : ""}${txt(false)}`,
        prefer: () => `<h3>${tt("q.want")}</h3>${radio("kPlot", cand, f.plot)}${mapOf(mine, f.plot ? [f.plot] : [])}${txt(false)}`,
        herd: () => `<p class="fine">${tt("q.herd")}</p><div id="kHerd">${herdForm({ herd: f.herd || h.herd, home: f.home || h.home, daily_return: f.daily != null ? f.daily : h.daily_return })}</div>${txt(false)}`,
        other: () => txt(true),
      };
      const ready = f.effect, calc = f.mode !== "other";
      return `<form id="kelObjF" class="kobj"><h3 id="kObjT" tabindex="-1">${tt("q.what")}</h3><div class="kchips">${modes.map(m => `<label class="chip"><input type="radio" name="kMode" value="${m}" ${f.mode === m ? "checked" : ""}>${tt("md." + m)}</label>`).join("")}</div>
        ${f.mode ? part[f.mode]() : ""}<p class="kerr" id="kObjErr" role="alert" hidden></p>
        ${f.mode && calc && !ready ? `<button type="button" class="btn btn-green kbig" id="kPrev">${tt("q.preview")}</button>` : ""}
        <div id="kEff" aria-live="polite">${ready ? `<h3>${tt("q.effect")}</h3>${effectHtml(ready, h.id, true)}` : ""}</div>
        ${(ready && ready.verdict !== "error") || f.mode === "other" ? `<button type="button" class="btn btn-primary kbig" id="kSend">${tt("q.send")}</button><p class="fine">${tt("q.sendD")}</p>` : ""}
        <button type="button" class="btn btn-ghost kbig" id="kBack">${tt("q.back")}</button></form>`;
      function txt(req) { return `<label class="field kf">${tt(req ? "q.textReq" : "q.text")}<textarea name="kText" rows="3" maxlength="300">${esc(f.text || "")}</textarea></label>`; }
    }
    const proposal = h => {
      const p = { type: f.mode, text: f.text || undefined };
      if (f.mode === "avoid") { p.plot = f.plot; p.reason = f.reason; if (f.observed_on) p.observed_on = f.observed_on; if (f.to) { p.type = "swap"; p.to = f.to; } }
      if (f.mode === "prefer") p.plot = f.plot;
      if (f.mode === "herd") { p.herd = f.herd; p.home = f.home; p.daily_return = f.daily; }
      return p;
    };
    function objCheck(h) {
      if (f.mode === "avoid" && !f.plot) return tt("e.plot");
      if (f.mode === "avoid" && !f.reason) return tt("e.reason");
      if (f.mode === "avoid" && f.observed_on && f.observed_on > today()) return tt("err.future");
      if (f.mode === "prefer" && !f.plot) return tt("e.plot");
      if (f.mode === "other" && !(f.text || "").trim()) return tt("e.text");
      if (f.mode === "herd" && SP.every(s => f.herd[s] === (h.herd[s] || 0)) && f.home === h.home && f.daily === h.daily_return) return tt("e.same");
      return "";
    }
    function bindPlan(h) {
      const pdf = $("#kelPdf"); if (pdf) pdf.onclick = () => protocolPdf(pdf);
      const ag = $("#kelAgree"); if (ag) ag.onclick = async () => { if (await act(ag, "/answer", { version: V.version, value: "agree" }, tt("agreedOk"))) { f = null; draw(); } };
      const ob = $("#kelObj"); if (ob) ob.onclick = () => { f = { mode: "" }; draw(); $("#kObjT").focus({ preventScroll: true }); $("#kelObjF").scrollIntoView({ behavior: "smooth", block: "start" }); };
      const form = $("#kelObjF"); if (!form) return;
      const read = () => {
        const g = n => { const x = $(`[name="${n}"]:checked`, form); return x ? x.value : ""; }, val = n => { const x = $(`[name="${n}"]`, form); return x ? x.value : ""; };
        const mode = g("kMode"), was = f.mode;
        if (mode !== was) { f = { mode, text: f.text }; const mine = K.plotsOf(V.plan.routes[h.id]); if (mode === "avoid" && mine.length === 1) f.plot = mine[0]; if (mode === "herd") Object.assign(f, { herd: Object.assign({}, h.herd), home: h.home, daily: h.daily_return }); return true; }
        const before = JSON.stringify([f.plot, f.reason, f.to]);
        if ($('[name="kPlot"]', form)) f.plot = g("kPlot");
        if (mode === "avoid") { f.reason = g("kReason"); f.to = val("kTo"); f.observed_on = val("kSeen"); }
        f.text = val("kText");
        const hb = $("#kHerd"); if (hb) { const x = {}; readHerd(hb, x); f.herd = x.herd; f.home = x.home; f.daily = x.daily_return; }
        return before !== JSON.stringify([f.plot, f.reason, f.to]);
      };
      form.onsubmit = e => e.preventDefault();
      form.onchange = e => {
        const re = read(), hadEff = !!f.effect;
        if (e.target.name !== "kText" && e.target.name !== "kSeen") f.effect = null;
        if (e.target.name === "kSeen" && $("#kObsH")) $("#kObsH").innerHTML = obsHint();
        if (re || (hadEff && !f.effect)) { const n = e.target.name, v = e.target.value, y = scrollY; draw(); scrollTo(0, y); const x = $(`#kelObjF [name="${n}"][value="${CSS.escape(v)}"]`) || $(`#kelObjF [name="${n}"]`); if (x) x.focus({ preventScroll: true }); }
      };
      form.addEventListener("input", e => { if (e.target.name === "kText") f.text = e.target.value; });
      const err = m => { const x = $("#kObjErr"); x.hidden = !m; x.textContent = m; if (m) x.scrollIntoView({ block: "center" }); };
      const pv = $("#kPrev"); if (pv) pv.onclick = () => {
        read(); const m = objCheck(h); err(m); if (m) return;
        pv.disabled = true; pv.innerHTML = spin(tt("q.calc"));
        setTimeout(() => { try { f.effect = K.effect(V, h.id, proposal(h)); } catch (x) { toast(t("err.server"), true); } draw(); const b = $("#kEff"); if (b) b.scrollIntoView({ behavior: "smooth", block: "start" }); }, 40);
      };
      const sd = $("#kSend"); if (sd) sd.onclick = async () => {
        read(); const m = objCheck(h); err(m); if (m) return;
        if (await act(sd, "/answer", { version: V.version, value: "object", proposal: proposal(h) }, tt("sentOk"))) { f = null; draw(); $("#kelAns").scrollIntoView({ block: "start" }); }
      };
      $("#kBack").onclick = () => { f = null; draw(); $("#kelAns").scrollIntoView({ block: "center" }); };
    }

    // ==================== ОРГАНИЗАТОР ====================
    const outcome = () => { const c = counts(); return !V.version ? "not_started" : c.agree === V.households.length ? "agreed" : c.object ? "disagreed" : "unanswered"; };
    function counts() { const c = { agree: 0, object: 0, pending: 0 }; for (const h of V.households) c[h.answer]++; return c; }
    function orgPage() {
      const st = V.status, idx = ["collect", "review", "closed"].indexOf(st), c = counts(), n = V.households.length;
      const empty = V.households.filter(h => SP.every(s => !h.herd[s])), open = V.proposals.filter(p => p.status === "open");
      const step = `<ol class="kprog">${["p.collect", "p.review", "p.closed"].map((k, i) => `<li class="${i < idx ? "done" : i === idx ? "now" : ""}" ${i === idx ? 'aria-current="step"' : ""}>${tt(k)}</li>`).join("")}</ol>`;
      const cta = st === "collect" ? `<p>${tt("o.collect")}</p>${empty.length ? `<p class="note warn">${tt("o.noHerd", { n: empty.map(h => esc(h.name)).join(", ") })}</p>` : ""}
          <button type="button" class="btn btn-primary kbig" id="kStart" ${n < 2 || empty.length === n ? "disabled" : ""}>${tt("o.start")}</button>`
        : st === "review" ? `<p class="kcount">${tt("o.counts", { a: c.agree, n, o: c.object, w: c.pending })}</p><span class="kbar"><i style="width:${Math.round(c.agree / n * 100)}%"></i></span>
          <p>${open.length ? tt("o.decide", { n: open.length }) : c.pending ? tt("o.wait") : c.object ? tt("o.disagree") : tt("o.allAgree")}</p>
          <button type="button" class="btn ${c.agree === n ? "btn-primary" : "btn-ghost"} kbig" id="kClose">${tt(c.agree === n ? "o.close" : "o.closeNo")}</button>`
        : `<p><b>${tt("out." + outcome())}</b> ${tt("o.counts", { a: c.agree, n, o: c.object, w: c.pending })}</p><button type="button" class="btn btn-primary kbig" id="kelPdf">${ic("file")} ${tt("protocol")}</button>`;
      const keep = rec(V.id, "org") && !rec(V.id, "org").kept ? `<div class="note warn kkeep"><p><b>${tt("keepT")}</b> ${tt("keepD")}</p><button type="button" class="btn btn-sm btn-soft" id="kKeep">${tt("copyOrg")}</button></div>` : "";
      put(head(` · ${tt("orgTag")}`) + keep + (V.restored ? `<p class="note warn">${tt(V.restored.verified ? "restOk" : "restUn")}</p>` : "") + (V.expired && st !== "closed" ? `<p class="note warn">${tt("o.expired", { d: dOnly(V.deadline) })}</p>` : "")
        + `<div class="card">${step}${cta}</div>` + (open.length ? `<h2>${tt("o.objections")}</h2>` + open.map(propCard).join("") : "")
        + `<div class="card"><h2>${tt("yards")} <span class="tag">${n}</span></h2>${V.households.map(yardRow).join("") || `<p class="empty">${tt("o.noYards")}</p>`}
            ${st === "closed" ? "" : `<form class="kaddf" id="kAddF"><label class="field">${tt("o.newYard")}<input maxlength="60" placeholder="${esc(tt("yardPh"))}"></label><button class="btn btn-soft">${ic("plus")} ${tt("addYard")}</button></form>`}
            ${V.herds.over.map(o => `<p class="note warn">${tt("over", { s: low(t("herds." + o.species)), a: fmt(o.declared), b: fmt(o.official) })}</p>`).join("")}</div>`
        + obsCard() + (V.plan ? planCard() : "") + settingsCard() + historyCard() + limits());
      bindOrg();
    }
    const keyOf = hid => { const o = rec(V.id, "org"); return o && o.links && o.links[hid]; };
    const yardRow = h => `<div class="kyard" data-hid="${esc(h.id)}"><div class="kyard-t"><b>${esc(h.name)}</b>${ansChip(h)}</div>
      <small>${whoLine(h)}</small><small>${esc(herdLine(h.herd))} · ${tt("hs." + h.herd_status)}${V.status === "collect" ? ` · ${tt(h.joined ? "o.came" : "o.notYet")}` : ""}</small>
      ${(c => (c.length ? `<small class="kwarn">${tt("o.herdChanged", { n: c.length })}: ${esc(herdLine(c[c.length - 1].from))} → ${esc(herdLine(c[c.length - 1].to))}</small>` : ""))(changes(h))}
      ${V.plan ? `<div class="kshare">${shareBar(V.plan.share[h.id])}<small>${tt("feedShort", { p: pct(V.plan.share[h.id]), d: V.plan.days[h.id], s: V.plan.season_days })}${hay(h.id) ? ` · ${hay(h.id)}` : ""} · ${K.plotsOf(V.plan.routes[h.id]).map(nw).join(", ") || "—"}</small></div>` : ""}
      <div class="kyard-b"><button type="button" class="btn btn-sm btn-soft" data-link>${ic("send")} ${tt("o.link")}</button>${V.status === "closed" ? "" : `<button type="button" class="btn btn-sm btn-ghost" data-edit>${ic("pen")} ${tt("o.edit")}</button>`}
      ${V.status !== "closed" && h.herd_status === "declared" ? `<button type="button" class="btn btn-sm btn-ghost" data-conf>${ic("check")} ${tt("o.confirm")}</button>` : ""}</div></div>`;
    const propObs = p => {
      const o = ["avoid", "swap"].includes(p.type) && p.reason !== "far" && K.OBS.includes(p.reason) ? K.compareObs({ reason: p.reason, on: p.observed_on }, V.snapshot.plots.find(x => x.id === p.plot), V.snapshot.source, V.snapshot.params) : null;
      return o ? `<p class="note">${obsTag(o.verdict)} ${obsWhy(o)}</p>` : "";
    };
    const effCache = {};
    /** Последствия по текущему плану: у свежего возражения — посчитанные сервером, у старого — считаем заново здесь. */
    function effectNow(p) {
      if (p.version === V.version && p.effect) return p.effect;
      const k = V.id + p.id + ":" + V.version + ":" + V.rev;
      if (!effCache[k]) effCache[k] = K.effect(V, p.household, p);
      return effCache[k];
    }
    function propCard(p) {
      const e = effectNow(p), vs = VORD.filter(n => e.variants && e.variants[n]), can = !["impossible", "error", "not_calculated", "none"].includes(e.verdict);
      return `<div class="card kprop" data-pid="${esc(p.id)}"><h3>${esc(nameOf(p.household))}</h3><p>${propText(p)}</p>${propObs(p)}${p.version !== V.version ? `<p class="note warn">${tt("o.recalc")}</p>` : ""}${effectHtml(e, p.household, false)}
        ${e.verdict === "not_calculated" ? `<p class="note">${tt("o.verbal")}</p>` : ""}
        <div class="kdec">${can ? vs.map((n, i) => `<button type="button" class="btn ${i ? "btn-soft" : "btn-green"}" data-acc="${n}">${vs.length > 1 ? `${tt("o.accept")}: ${tt("var." + n).toLowerCase()}` : tt("o.accept")}</button>`).join("") : ""}</div>
        <label class="field kf">${tt("o.note")}<input data-note maxlength="300"></label><button type="button" class="btn btn-ghost" data-dec>${tt("o.decline")}</button></div>`;
    }
    function planCard() {
      const P = V.plan;
      return `<details data-d="plan" class="card kdet"><summary><span>${tt("o.plan", { n: V.version })}</span></summary>
        <p>${P.deficit_t > 0.5 ? tt("o.deficit", { t: fmt(P.deficit_t) }) : tt("o.enough")} ${src("model")}</p>${P.bottleneck ? `<p>${tt("bottle", { p: P.bottleneck.plots.map(nw).join(", "), t: fmt(P.bottleneck.shortfall_t) })}</p>` : ""}
        <div class="kmap">${scheme(V.snapshot.plots, p => X.loadColor(P.load[p.id]), p => (P.load[p.id] ? pct(P.load[p.id]) : ""), { size: 420 })}</div>
        ${V.status === "closed" ? `<p>${tt("rule." + V.rule)}. ${tt("rule." + V.rule + "D")}</p>` : `${ruleHtml(V.rule, "kRule2")}<button type="button" class="btn btn-soft" id="kRuleGo" disabled>${tt("o.ruleGo")}</button><p class="fine">${tt("o.ruleD")}</p>`}</details>`;
    }
    function settingsCard() {
      const o = V.official || {}, ck = V.snapshot.check || {};
      return `<details data-d="set" class="card kdet"><summary><span>${tt("o.settings")}</span></summary>
        ${V.status === "closed" ? "" : `<form id="kSet"><label class="field kf">${tt("deadline")}<input type="date" name="deadline" value="${esc(V.deadline || "")}"></label>
        ${!OFFICIAL ? "" : `<h3>${tt("o.official")}</h3><p class="fine">${tt("o.officialD")}</p><div class="herd-grid">${SP.map(s => `<label class="field">${t("herds." + s)}<input type="number" inputmode="numeric" min="0" name="of_${s}" value="${o[s] == null ? "" : o[s]}"></label>`).join("")}</div>
        <label class="field kf">${tt("o.source")}<input name="source" maxlength="80" value="${esc(o.source || "")}"></label>`}<button class="btn btn-soft">${t("common.save")}</button></form>`}
        <p class="fine">${zoneLine(V.snapshot.zone)} ${tt("o.check." + (ck.status || "unknown"), { p: (ck.plots || []).map(esc).join(", ") })} ${V.snapshot.norm ? `${t("nm.source")}: ${esc(regName(V.snapshot.norm.region))}.` : t("nm.noRegion")}</p>
        <div class="startbtns"><button type="button" class="btn btn-ghost" id="kExp">${ic("save")} ${tt("o.export")}</button><button type="button" class="btn btn-ghost" id="kCopyOrg">${tt("copyOrg")}</button><button type="button" class="btn btn-ghost" id="kDel">${ic("trash")} ${tt("o.del")}</button></div><p class="fine">${tt("o.exportD")}</p></details>`;
    }
    /** Кто понёс потерю — только если выбор был: без потерь у соседей вариант ничего не значит. */
    const choice = p => (p.status === "accepted" && p.variant && (p.variant !== "equal" || (p.losers || ((p.effect && p.effect.variants && p.effect.variants.equal && p.effect.variants.equal.losers) || [])).some(x => x.id !== p.household)) ? tt("var." + p.variant) + "." : "");
    function historyCard() {
      const done = V.proposals.filter(p => p.status !== "open");
      if (!done.length && V.versions.length < 2) return "";
      return `<details data-d="his" class="card kdet"><summary><span>${tt("o.history")}</span></summary><ul class="list">${V.versions.map(v => `<li class="krowp"><div><b>${tt("o.ver", { n: v.n })}</b><small>${dateStr(v.at)}</small></div><small>${tt("wh." + v.why.type, { n: esc(nameOf(v.why.household)) })}${v.changed.length && v.n > 1 ? ` · ${tt("o.again", { n: v.changed.map(nameOf).map(esc).join(", ") })}` : ""}</small></li>`).join("")}</ul>
        ${done.length ? `<h3>${tt("o.decisions")}</h3><ul class="list">${done.map(p => `<li class="krowp"><div><b>${esc(nameOf(p.household))}</b>${chip(p.status === "accepted" ? "agree" : "pending", tt("pst." + p.status))}</div><small>${propText(p)} ${choice(p)}${p.note ? " " + esc(p.note) : ""}</small></li>`).join("")}</ul>` : ""}</details>`;
    }
    function bindOrg() {
      const kp = $("#kKeep"), copyOrg = async () => { if (await copy(linkOf(V.id, "org", cur.key))) { remember(V.id, "org", cur.key, { kept: true }); draw(); } };
      if (kp) kp.onclick = copyOrg;
      const st = $("#kStart"); if (st) st.onclick = async () => { if (await act(st, "/start", { rev: V.rev }, tt("o.started"))) { draw(); scrollTo(0, 0); } };
      const cl = $("#kClose"); if (cl) arm(cl, async b => { if (await act(b, "/close", { rev: V.rev }, tt("o.closed"))) { draw(); scrollTo(0, 0); } });
      const pdf = $("#kelPdf"); if (pdf) pdf.onclick = () => protocolPdf(pdf);
      $$(".kyard").forEach(y => {
        const h = V.households.find(x => x.id === y.dataset.hid);
        $("[data-link]", y).onclick = () => linkDlg(h);
        const e = $("[data-edit]", y); if (e) e.onclick = () => editDlg(h);
        const c = $("[data-conf]", y); if (c) c.onclick = async () => { if (await act(c, "/households/" + h.id, { rev: V.rev, confirm: true }, tt("o.confirmed"))) draw(); };
      });
      const af = $("#kAddF"); if (af) {
        af.oninput = () => { dirty = !!$("input", af).value; };
        af.onsubmit = async e => { e.preventDefault(); const name = $("input", af).value.trim(); if (!name) return; const r = await act($("button", af), "/households", { name }, tt("o.added")); if (r) { dirty = false; draw(); linkDlg(V.households.find(x => x.id === r.link.id)); } };
      }
      $$(".kprop").forEach(c => {
        const p = V.proposals.find(x => x.id === c.dataset.pid), note = () => $("[data-note]", c).value.trim() || undefined;
        $("[data-note]", c).oninput = e => { dirty = !!e.target.value; };
        const send = (b, body, ok) => act(b, "/decide", Object.assign({ rev: V.rev, proposal: p.id, note: note() }, body), ok);
        $$("[data-acc]", c).forEach(b => b.onclick = async () => {
          const seen = V.version, variant = b.dataset.acc, nt = note();
          let r = await send(b, { action: "accept", variant });
          // возражение подано к прошлой версии: последствия для текущей мы уже показали — подтверждаем тем же нажатием
          if (r && r.stale && V.version === seen && r.effect && r.effect.variants && r.effect.variants[variant]) r = await act(null, "/decide", { rev: V.rev, proposal: p.id, action: "accept", variant, note: nt });
          if (r) { dirty = false; if (!r.stale) toast(tt("o.accepted")); draw(); }
        });
        arm($("[data-dec]", c), async b => { if (await send(b, { action: "decline" }, tt("o.declined"))) { dirty = false; draw(); } });
      });
      const rg = $("#kRuleGo"); if (rg) {
        $$("[name=kRule2]").forEach(r => r.onchange = () => { rg.disabled = ($("[name=kRule2]:checked") || {}).value === V.rule; });
        rg.onclick = async () => { if (await act(rg, "/rule", { rev: V.rev, rule: $("[name=kRule2]:checked").value }, tt("o.ruleOk"))) draw(); };
      }
      const sf = $("#kSet"); if (sf) {
        sf.oninput = () => { dirty = true; };
        sf.onsubmit = async e => {
          e.preventDefault();
          const off = {}; if (OFFICIAL) for (const s of SP) if (sf["of_" + s].value !== "") off[s] = Math.max(0, Math.round(+sf["of_" + s].value));
          if (Object.keys(off).length) off.source = sf.source.value.trim();
          const body = { rev: V.rev };
          if (OFFICIAL) body.official = Object.keys(off).length ? off : null;
          if (sf.deadline.value !== (V.deadline || "")) body.deadline = sf.deadline.value || null;
          if (await act($("button", sf), "/settings", body, tt("savedOk"))) { dirty = false; draw(); }
        };
      }
      $("#kCopyOrg").onclick = copyOrg;
      $("#kExp").onclick = async () => {
        try { const d = await C.kel("GET", "/" + V.id + "/export", cur.key); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(d)], { type: "application/json" })); a.download = `jaiylym-kelisim-${V.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
        catch (e) { toast(kErr(e), true); }
      };
      arm($("#kDel"), async () => { try { await C.kel("DELETE", "/" + V.id, cur.key); forget(V.id, "org", cur.key); go("kelisim"); } catch (e) { toast(kErr(e), true); } });
    }
    async function copy(text) {
      try { await navigator.clipboard.writeText(text); toast(tt("copied")); return true; }
      catch (_) {
        const a = document.createElement("textarea"); a.value = text; a.style.cssText = "position:fixed;opacity:0"; (document.querySelector("dialog[open]") || document.body).appendChild(a); a.select();
        let ok = false; try { ok = document.execCommand("copy"); } catch (e) {} a.remove(); toast(ok ? tt("copied") : tt("copyFail"), !ok); return ok;
      }
    }
    function dlg(title, html) {
      const d = document.createElement("dialog");
      d.className = "modal plot-sheet kel-dlg"; d.setAttribute("aria-label", title);
      d.innerHTML = `<form method="dialog" class="modal-x"><button aria-label="${t("common.close")}">${ic("x")}</button></form><h2>${esc(title)}</h2>${html}`;
      document.body.appendChild(d);
      d.addEventListener("close", () => d.remove());
      d.addEventListener("click", e => { if (e.target === d) d.close(); });
      window.addEventListener("hashchange", () => d.open && d.close(), { once: true });
      d.showModal();
      return d;
    }
    function qr(text) {
      if (typeof window.qrcode !== "function") return "";
      try { const q = window.qrcode(0, "M"); q.addData(text); q.make(); return `<div class="kqr" role="img" aria-label="QR">${q.createSvgTag({ cellSize: 4, margin: 12, scalable: true })}</div>`; } catch (_) { return ""; }
    }
    function linkDlg(h) {
      const key = keyOf(h.id);
      if (!key) {
        const d = dlg(tt("o.linkT", { n: h.name }), `<p>${tt("o.linkLost")}</p><button type="button" class="btn btn-primary kbig" id="kNewL">${tt("o.reissue")}</button>`);
        $("#kNewL", d).onclick = async e => { if (await act(e.currentTarget, "/households/" + h.id + "/link")) { d.close(); draw(); linkDlg(h); } };
        return;
      }
      const url = linkOf(V.id, "hh", key), msg = tt("o.msg", { n: h.name, t: V.title }), enc = encodeURIComponent;
      const d = dlg(tt("o.linkT", { n: h.name }), `<p>${tt("o.linkD")}</p>${qr(url)}<p class="klink">${esc(url)}</p>
        <div class="kdec"><button type="button" class="btn btn-primary" id="kCp">${tt("o.copy")}</button>${navigator.share ? `<button type="button" class="btn btn-soft" id="kSh">${ic("send")} ${tt("o.share")}</button>` : ""}
        <a class="btn btn-soft" target="_blank" rel="noopener" href="https://wa.me/?text=${enc(msg + "\n" + url)}">WhatsApp</a><a class="btn btn-soft" target="_blank" rel="noopener" href="https://t.me/share/url?url=${enc(url)}&text=${enc(msg)}">Telegram</a><a class="btn btn-ghost" target="_blank" rel="noopener" href="${esc(url)}">${tt("o.openHere")}</a></div>
        <details><summary><span>${tt("o.lost")}</span></summary><p class="fine">${tt("o.reissueD")}</p><button type="button" class="btn btn-ghost" id="kNewL">${tt("o.reissue")}</button></details>`);
      $("#kCp", d).onclick = () => copy(url);
      const sh = $("#kSh", d); if (sh) sh.onclick = () => navigator.share({ text: msg, url }).catch(() => {});
      arm($("#kNewL", d), async b => { if (await act(b, "/households/" + h.id + "/link", {}, tt("o.reissued"))) { d.close(); draw(); linkDlg(h); } });
    }
    function editDlg(h) {
      const d = dlg(h.name, `<form id="kEd"><label class="field kf">${tt("nameQ")}<input data-f="name" maxlength="60" value="${esc(h.name)}"></label>${whoForm(h, "kwEd")}${herdForm(h)}
        <label class="field kf">${t("herds.weight")}<select data-f="weight">${K.WEIGHTS.map(w => `<option value="${w}" ${h.weight === w ? "selected" : ""}>${t("herds.w" + String(w).replace(".", ""))}</option>`).join("")}</select></label>
        <details><summary><span>${t("herds.rights")}: ${h.allowed.length ? esc(h.allowed.join(", ")) : t("herds.rightsAll")}</span></summary><div class="chips">${V.snapshot.plots.map(p => `<label class="chip"><input type="checkbox" data-al="${esc(p.id)}" ${h.allowed.includes(p.id) ? "checked" : ""}>${esc(p.id)}</label>`).join("")}</div><p class="fine">${t("herds.rightsNote")}</p></details>
        ${V.version ? `<p class="note warn">${tt("o.editWarn")}</p>` : ""}<button class="btn btn-primary kbig">${t("common.save")}</button></form><button type="button" class="btn btn-ghost kbig" id="kRm">${ic("trash")} ${tt("o.rm")}</button>`);
      const form = $("#kEd", d);
      form.onsubmit = async e => {
        e.preventDefault();
        const x = {}; readHerd(form, x); readWho(form, x);
        const b = { rev: V.rev }, name = $("[data-f=name]", form).value.trim(), w = +$("[data-f=weight]", form).value, al = $$("[data-al]", form).filter(c => c.checked).map(c => c.dataset.al);
        if (name && name !== h.name) b.name = name;
        if (SP.some(s => x.herd[s] !== (h.herd[s] || 0))) b.herd = x.herd;
        if (x.home !== h.home) b.home = x.home;
        if (x.kind !== h.kind || x.owners !== h.owners || x.resp !== h.resp) Object.assign(b, { kind: x.kind, owners: x.owners, resp: x.resp });
        if (x.daily_return !== h.daily_return) b.daily_return = x.daily_return;
        if (w !== h.weight) b.weight = w;
        if (al.join() !== h.allowed.join()) b.allowed = al;
        if (Object.keys(b).length === 1) { d.close(); return; }
        if (await act($("button", form), "/households/" + h.id, b, tt("savedOk"))) { d.close(); draw(); }
      };
      arm($("#kRm", d), async b => { if (await act(b, "/households/" + h.id, { rev: V.rev, remove: true }, tt("o.removed"))) { d.close(); draw(); } });
    }

    // ---------- протокол ----------
    function protocolHtml(p) {
      const th = `style="text-align:left;border-bottom:1px solid #999;padding:5px;font-size:10px;color:#444;vertical-align:bottom;white-space:normal"`, td = `style="border-bottom:1px solid #ddd;padding:6px 5px;vertical-align:top;white-space:normal;overflow-wrap:anywhere"`;
      const tbl = `style="width:100%;border-collapse:collapse;font-size:11px"`, h2 = s => `<h2 style="font-size:14px;margin:16px 0 6px;color:#24543f;page-break-after:avoid">${s}</h2>`;
      const rt = r => (r || []).map(s => `${s.plot ? esc(s.plot) : tt("gap").toLowerCase()} ${s.from === s.to ? day(s.from) : `${day(s.from)}–${day(s.to)}`}`).join("<br>") || "—";
      return `<div style="font:11.5px/1.45 Inter,Arial,sans-serif;color:#111;width:720px">
        <div style="border-bottom:3px solid #24543f;padding-bottom:8px"><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#24543f;font-weight:800">Jaiylym · Келісім</div>
        <h1 style="font-size:20px;margin:2px 0 4px">${tt("pr.title")}: ${esc(p.title)}</h1><div style="color:#444">${esc(p.village.name)} (${p.village.lat}, ${p.village.lon}) · ${tt("pr.created")} ${dateStr(p.created, false)}${p.closed ? ` · ${tt("pr.closed")} ${dateStr(p.closed)}` : ""}</div><div style="color:#24543f;font-weight:700">${cap(seasonLine())}</div></div>
        <p style="background:#f6ead2;border-radius:6px;padding:7px 9px;margin:10px 0"><b>${tt("out." + p.outcome)}</b> ${tt("pr.counts", { n: p.counts.total, a: p.counts.agree, o: p.counts.object, w: p.counts.pending })} ${tt("noRights")}</p>
        <p>${tt("pr.ver", { n: p.version })} ${tt("ruleQ")} <b>${tt("rule." + p.rule)}</b>. ${tt("rule." + p.rule + "D")}</p>
        ${h2(tt("yards"))}<table ${tbl}><thead><tr>${[["yardName", 140], ["herd", 125], ["where", 165], ["pr.feed", 105], ["pr.answer", 95], ["pr.sign", 90]].map(([k, w]) => `<th ${th} width="${w}">${tt(k)}</th>`).join("")}</tr></thead><tbody>
        ${p.households.map(h => `<tr style="page-break-inside:avoid"><td ${td}><b>${esc(h.name)}</b><br><span style="color:#666">${whoLine(h)}</span>${h.weight !== 1 ? `<br>${t("herds.weight")}: ${h.weight}` : ""}</td><td ${td}>${esc(herdLine(h.herd))}<br><span style="color:#666">${tt("hs." + h.herd_status)}</span></td><td ${td}>${rt(h.route)}</td><td ${td}>${pct(h.share)}<br>${tt("days", { n: h.days == null ? "—" : h.days })}${h.hay_t >= 0.1 ? `<br>${tt("hayShort", { t: tons(h.hay_t) })}` : ""}</td>
          <td ${td}>${tt("st." + h.answer)}${h.carried ? " " + tt("st.carried") : ""}${h.answered_at ? `<br><span style="color:#666">${dateStr(h.answered_at)}</span>` : ""}</td><td ${td}>&nbsp;</td></tr>`).join("")}</tbody></table>
        ${p.decisions.length ? h2(tt("o.decisions")) + `<table ${tbl}><tbody>${p.decisions.map(x => `<tr style="page-break-inside:avoid"><td ${td}><b>${esc(nameOf(x.household))}</b></td><td ${td}>${propText(x)}</td><td ${td}>${tt("pst." + x.status)}. ${choice(x)}${x.status === "accepted" && x.losers.length ? `<br>${tt("ef.lose")}: ${x.losers.map(l => `${esc(nameOf(l.id))} ${ppt(l.delta)} ${tt("pp")}`).join("; ")}` : ""}</td></tr>`).join("")}</tbody></table>` : ""}
        ${Object.keys(p.observations || {}).length ? h2(t("obs.title")) + `<p>${t("obs.note")}</p><table ${tbl}><tbody>${Object.entries(p.observations).map(([id, g]) => `<tr style="page-break-inside:avoid"><td ${td} width="190"><b>${plotFull(id)}</b>${g.verdict === "check" ? `<br>${t("obs.check")}` : ""}</td><td ${td}>${obsItems(g, "font-size:11px;margin:0")}</td></tr>`).join("")}</tbody></table>` : ""}
        ${h2(tt("pr.data"))}${p.snapshot.zone ? `<p>${zoneLine(p.snapshot.zone)}</p>` : ""}<p>${tt("pr.src", { y: p.snapshot.source.year, d: p.snapshot.source.dates.map(x => dOnly(x)).join(", ") || "—", m: esc(p.snapshot.model_version) })} ${tt("yearNote", { y: p.snapshot.source.year, s: p.season })} ${p.snapshot.deficit_t > 0.5 ? tt("o.deficit", { t: fmt(p.snapshot.deficit_t) }) : ""} ${tt("o.check." + (p.snapshot.check.status || "unknown"), { p: (p.snapshot.check.plots || []).map(esc).join(", ") })}</p>
        ${p.herds.over.map(o => `<p>${tt("over", { s: low(t("herds." + o.species)), a: fmt(o.declared), b: fmt(o.official) })}</p>`).join("")}${p.restored && !p.restored.verified ? `<p>${tt("restUn")}</p>` : ""}
        ${p.snapshot.norm ? `<p>${t("nm.source")}: ${esc(regName(p.snapshot.norm.region))}.</p>` : ""}${h2(t("rep.limits"))}<ul style="margin:0;padding-left:18px">${p.limits.map(l => `<li>${tt("lim." + l)}</li>`).join("")}</ul>
        <p style="color:#555;font-size:10px;margin-top:14px">ainara001.github.io/jaiylym · ${dateStr(new Date())}</p></div>`;
    }
    async function protocolPdf(b) {
      b.disabled = true; toast(t("rep.making"));
      try {
        const p = await C.kel("GET", "/" + V.id + "/protocol", cur.key);
        await window.Report.pdf(protocolHtml(p), window.Report.fileName(V.village.name, new Date(), "kelisim"));
      } catch (e) { toast(e instanceof C.ApiError ? kErr(e) : t("rep.printFallback"), true); }
      b.disabled = false;
    }

    document.addEventListener("visibilitychange", () => { if (!document.hidden && on && cur && !busy) load(true); });
    window.addEventListener("online", () => { if (on && cur) load(offline && !f && !dirty ? false : true); });
    return { route, refresh: () => { if (on && !cur && $("#kelTitle")) newPage(); }, observations, obsItems, obsWhy, get state() { return { cur, V, f, offline, fail }; }, protocolHtml };
  };
})();
