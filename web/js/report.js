/* Jaiylym — PDF-отчёт по селу.
 * Собирается в браузере библиотекой html2pdf.js (загружается только по нажатию кнопки).
 * Если библиотека не загрузилась (нет сети), открывается печать: «Сохранить как PDF». */
(function () {
  "use strict";
  const LIB = "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js";

  function loadLib() {
    if (window.html2pdf) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = LIB; s.async = true;
      const to = setTimeout(() => reject(new Error("timeout")), 20000);
      s.onload = () => { clearTimeout(to); window.html2pdf ? resolve() : reject(new Error("no lib")); };
      s.onerror = () => { clearTimeout(to); reject(new Error("load")); };
      document.head.appendChild(s);
    });
  }

  function build(c) {
    const { t, fmt, fmt1, pct, esc, J, S, scheme, loadColor, confidence, summary } = c;
    const tag = k => `<span style="font-size:9.5px;font-weight:700;padding:1px 6px;border-radius:9px;background:${{ sat: "#dcebf4", input: "#f3e6cf", model: "#e7e2f2" }[k]};color:${{ sat: "#1f5f86", input: "#7a5413", model: "#54407f" }[k]}">${t("src." + k)}</span>`;
    const v = S.D.village, src0 = S.D.source;
    const hc = J.hayTonnes(S.cur.deficit_kg, S.P), hp = J.hayTonnes(S.pl.deficit_kg, S.P);
    const byId = Object.fromEntries(S.plots.map(p => [p.id, p]));
    const th = `style="text-align:left;border-bottom:1px solid #bbb;padding:4px 5px;font-size:10px;text-transform:uppercase;color:#555"`;
    const td = `style="border-bottom:1px solid #e3e3e3;padding:4px 5px"`;
    const tdn = `style="border-bottom:1px solid #e3e3e3;padding:4px 5px;text-align:right"`;
    const h2 = s => `<h2 style="font-size:14px;margin:16px 0 6px;page-break-after:avoid">${s}</h2>`;
    const d = new Date(), two = n => String(n).padStart(2, "0");
    const now = `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;

    const wells = J.wells(S.plots, S.P);
    return `<div style="font:12px/1.45 Inter,Arial,sans-serif;color:#111;width:720px">
      <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #24543f;padding-bottom:8px">
        <div><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#24543f;font-weight:800">Jaiylym</div>
        <h1 style="font-size:21px;margin:2px 0 0">${t("rep.title")}: ${esc(v.name)}</h1></div>
        <div style="text-align:right;color:#555;font-size:11px">${t("rep.generated")}: ${now}<br>${v.lat}, ${v.lon}</div></div>
      <p style="background:#f6ead2;border-radius:6px;padding:7px 9px;margin:10px 0;font-size:11px">${t("rep.disclaimer")}</p>

      ${h2(t("tab.overview"))}
      <table style="width:100%;border-collapse:collapse"><thead><tr><th ${th}></th><th ${th}>${t("kpi.before")}</th><th ${th}>${t("kpi.after")}</th><th ${th}></th></tr></thead><tbody>
        <tr><td ${td}>${t("kpi.overloaded")}</td><td ${tdn}>${S.cur.overloaded}</td><td ${tdn}>${S.pl.overloaded}</td><td ${td}>${tag("model")}</td></tr>
        <tr><td ${td}>${t("kpi.excess")}</td><td ${tdn}>${fmt(hc)}</td><td ${tdn}>${fmt(hp)}</td><td ${td}>${tag("model")}</td></tr>
        <tr><td ${td}>${t("kpi.cost")}</td><td ${tdn}>${fmt1(hc * S.P.hay_price / 1e6)}</td><td ${tdn}>${fmt1(hp * S.P.hay_price / 1e6)}</td><td ${td}>${tag("model")} ${tag("input")}</td></tr>
      </tbody></table>
      <p style="font-size:10.5px;color:#555;margin:4px 0 0">${t("kpi.costNote")}</p>

      ${h2(t("ov.schemes"))}
      <div style="display:flex;gap:12px;page-break-inside:avoid">
        <div style="flex:1;text-align:center;background:#f3f4ee;border-radius:8px;padding:6px">${scheme(S.plots, p => loadColor(S.cur.load[p.id].load), p => (S.cur.load[p.id].used ? pct(S.cur.load[p.id].load) : ""), { size: 300 })}<b>${t("map.mode.current")}</b></div>
        <div style="flex:1;text-align:center;background:#f3f4ee;border-radius:8px;padding:6px">${scheme(S.plots, p => loadColor(S.pl.load[p.id].load), p => (S.pl.load[p.id].used ? pct(S.pl.load[p.id].load) : ""), { size: 300 })}<b>${t("map.mode.plan")}</b></div>
      </div>

      ${h2(t("tab.plots"))}
      <table style="width:100%;border-collapse:collapse;page-break-inside:auto"><thead><tr><th ${th}>${t("plots.id")}</th><th ${th}>${t("plots.ha")} ${tag("sat")}</th><th ${th}>NDVI ${tag("sat")}</th>
        <th ${th}>${t("plots.conf")}</th><th ${th}>${t("plots.cap")} ${tag("model")}</th><th ${th}>${t("kpi.before")}</th><th ${th}>${t("kpi.after")}</th><th ${th}>${t("pop.water")}</th></tr></thead><tbody>
        ${S.plots.map(p => `<tr style="page-break-inside:avoid"><td ${td}><b>${esc(p.id)}</b></td><td ${tdn}>${fmt(p.pasture_ha)}</td><td ${tdn}>${p.ndvi ?? "—"}</td>
          <td ${td}>${t("conf." + confidence(p))}</td><td ${tdn}>${fmt(J.plotCapacity(p, S.P).au_season / S.P.au.sheep)}</td>
          <td ${tdn}>${S.cur.load[p.id].used ? pct(S.cur.load[p.id].load) : "—"}</td><td ${tdn}>${S.pl.load[p.id].used ? pct(S.pl.load[p.id].load) : "—"}</td>
          <td ${td}>${esc(p.water_source)}</td></tr>`).join("")}
      </tbody></table>

      ${h2(t("tab.routes"))}
      <table style="width:100%;border-collapse:collapse"><thead><tr><th ${th}>${t("herds.name")}</th><th ${th}>${t("herds.au")} ${tag("input")}</th><th ${th}>${t("tab.routes")} ${tag("model")}</th></tr></thead><tbody>
        ${S.herds.map(h => `<tr style="page-break-inside:avoid"><td ${td}>${esc(h.name)}</td><td ${tdn}>${fmt(J.herdAU(h, S.P))}</td>
          <td ${td}>${(S.pl.herdPlans[h.id] || []).map(s => `${s.plot ? esc(s.plot) + (byId[s.plot] ? "" : "") : t("routes.nofeed")} (${s.from}–${s.to})`).join(" → ")}</td></tr>`).join("") || `<tr><td ${td} colspan="3">${t("ov.noherds")}</td></tr>`}
      </tbody></table>

      ${h2(t("water.title"))}
      <p>${wells.length ? wells.map(w => `${esc(w.plot)}: ${t("water.opens", { n: fmt(w.sheep) })}`).join("; ") : t("water.none")} ${tag("model")}</p>
      ${S.added.size ? `<p><b>${t("water.added")}:</b> ${[...S.added].map(esc).join(", ")} ${tag("input")}</p>` : ""}

      ${h2(t("data.title"))}
      <p>${tag("sat")} ${t("data.scenes")} Sentinel-2 (${src0.dates.length}): ${src0.dates.slice().sort().join(", ")}. ESA WorldCover 10 м.</p>
      ${c.trend ? `<p>${esc(c.trend)}</p>` : ""}
      <p>${tag("model")} ${t("data.model.d")}</p>
      <p>${tag("input")} ${t("data.input.d")}</p>
      <p style="color:#555;font-size:10.5px;margin-top:14px">ainara001.github.io/jaiylym · Telegram @JAIYLYM_bot · ${summary.herds} ${t("sc.herds")}, ${fmt(summary.au)} ${t("herds.au")}</p>
    </div>`;
  }

  async function exportPdf(c) {
    const html = build(c);
    const name = `jaiylym-${(c.S.D.village.name || "village").replace(/[^\p{L}\p{N}]+/gu, "-")}-${new Date().toISOString().slice(0, 10)}.pdf`;
    try {
      await loadLib();
      const el = document.createElement("div");
      el.innerHTML = html;
      await window.html2pdf().set({
        margin: [10, 10, 12, 10], filename: name, image: { type: "jpeg", quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }, pagebreak: { mode: ["css", "legacy"] },
      }).from(el.firstElementChild).save();
    } catch (e) {
      // запасной путь: печать страницы только с отчётом
      const box = document.getElementById("report");
      box.innerHTML = html;
      document.body.classList.add("printing");
      const done = () => { document.body.classList.remove("printing"); box.innerHTML = ""; window.removeEventListener("afterprint", done); };
      window.addEventListener("afterprint", done);
      setTimeout(() => window.print(), 50);
      throw e;
    }
  }

  window.Report = { build, export: exportPdf };
})();
