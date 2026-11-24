/* Jaiylym — PDF-отчёт по селу.
 * Собирается в браузере библиотекой html2pdf.js (загружается только по нажатию кнопки).
 * Если библиотека не загрузилась (нет сети), открывается печать: «Сохранить как PDF». */
(function () {
  "use strict";
  // своя копия библиотеки (MIT, web/vendor) — PDF не зависит от внешнего CDN и работает из офлайн-кэша; CDN — запасной путь
  const LIBS = ["vendor/html2pdf-0.10.1.bundle.min.js", "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"];

  function loadOne(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.async = true;
      const to = setTimeout(() => reject(new Error("timeout")), 20000);
      s.onload = () => { clearTimeout(to); window.html2pdf ? resolve() : reject(new Error("no lib")); };
      s.onerror = () => { clearTimeout(to); s.remove(); reject(new Error("load")); };
      document.head.appendChild(s);
    });
  }
  async function loadLib() {
    if (window.html2pdf) return;
    let last;
    for (const src of LIBS) { try { await loadOne(src); return; } catch (e) { last = e; } }
    throw last;
  }

  /**
   * Отчёт: село, дата, снимки, источники, хозяйства, участки, формулы и коэффициенты, ограничения,
   * потребность, распределение, неудовлетворённая потребность, сценарии, неопределённость, версия модели.
   * Тенге пишется словом: символ ₸ есть не во всех шрифтах PDF.
   */
  function build(c) {
    const { t, fmt, fmt1, pct, esc, J, M, S, scheme, loadColor, confidence, summary } = c;
    const tag = k => `<span style="font-size:9.5px;font-weight:700;padding:1px 6px;border-radius:9px;background:${{ sat: "#dcebf4", input: "#f3e6cf", model: "#e7e2f2", norm: "#dfeee2" }[k]};color:${{ sat: "#1f5f86", input: "#7a5413", model: "#54407f", norm: "#1f5a34" }[k]}">${t("src." + k)}</span>`;
    const v = S.D.village, meta = c.meta || M.metaOf(S.D), P = S.P;
    const hc = J.hayTonnes(S.cur.deficit_kg, P), hp = J.hayTonnes(S.pl.deficit_kg, P);
    const tenge = t("rep.tenge");
    const th = `style="text-align:left;border-bottom:1px solid #bbb;padding:4px 5px;font-size:9.5px;text-transform:uppercase;color:#555;vertical-align:bottom"`;
    const td = `style="border-bottom:1px solid #e3e3e3;padding:4px 5px;vertical-align:top;overflow-wrap:break-word"`;
    const tdn = `style="border-bottom:1px solid #e3e3e3;padding:4px 5px;text-align:right;vertical-align:top;white-space:nowrap"`;
    const tbl = `style="width:100%;border-collapse:collapse;table-layout:auto;page-break-inside:auto"`;
    const h2 = s => `<h2 style="font-size:13.5px;margin:16px 0 6px;page-break-after:avoid;color:#24543f">${s}</h2>`;
    const d = new Date(), two = n => String(n).padStart(2, "0");
    const now = `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;
    const ds = x => (c.dateStr ? c.dateStr(x, false) : x);
    const cap = p => J.plotCapacity(p, P);
    const sheep = k => (k.known ? fmt(k.au_season / P.au.sheep) : "—");
    const demandAUd = S.herds.reduce((s, h) => s + J.herdAU(h, P) * P.season_days, 0);
    const unmetAUd = Object.values(S.pl.unmet || {}).reduce((s, x) => s + x, 0);
    const statusText = S.pl.status === "feasible" ? t("res.feasible") : S.pl.status === "no_demand" ? t("ov.noherds") : S.pl.status === "infeasible" ? t("res.infeasible") : t("res.partial");
    const wr = c.wells || J.wellRank(S.plots, S.herds, P), wells = wr.list.filter(w => w.gain_t > 0);
    const scen = c.scenarios || [];

    return `<div style="font:11.5px/1.45 Inter,Arial,sans-serif;color:#111;width:720px">
      <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #24543f;padding-bottom:8px">
        <div><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#24543f;font-weight:800">Jaiylym</div>
        <h1 style="font-size:20px;margin:2px 0 0">${t("rep.title")}: ${esc(v.name)}</h1></div>
        <div style="text-align:right;color:#555;font-size:10.5px">${t("rep.generated")}: ${now}<br>${v.lat}, ${v.lon}<br>${t("rep.version")}: ${esc(meta.model_version)}</div></div>
      <p style="background:#f6ead2;border-radius:6px;padding:7px 9px;margin:10px 0;font-size:10.5px"><b>${t("rep.disclaimer2")}</b> ${t("rep.disclaimer")}</p>
      <p style="font-size:12px;margin:6px 0"><b>${statusText}</b> ${tag("model")}</p>

      ${h2(t("rep.meta"))}
      <table ${tbl}><tbody>
        <tr><td ${td}>${t("meta.dataset")}</td><td ${td}>${esc(meta.dataset)} (${esc(meta.source)}) ${tag("sat")}</td></tr>
        <tr><td ${td}>${t("meta.dates")}</td><td ${td}>${meta.scene_dates.map(ds).join(", ") || "—"} (${meta.imagery_count})</td></tr>
        <tr><td ${td}>${t("meta.valid")}</td><td ${td}>${meta.valid_pixel_fraction == null ? t("meta.notRecorded") : pct(meta.valid_pixel_fraction)}</td></tr>
        <tr><td ${td}>${t("meta.lc")}</td><td ${td}>${esc(meta.landcover_source)}${meta.landcover_year ? ", " + meta.landcover_year : ""}</td></tr>
        <tr><td ${td}>${t("meta.calc")}</td><td ${td}>${meta.calculated_at ? ds(meta.calculated_at) : t("meta.unknownDate")}</td></tr>
        <tr><td ${td}>${t("meta.status")}</td><td ${td}>${t("meta." + meta.data_status)}</td></tr>
        ${c.norm ? `<tr><td ${td}>${t("nm.title")}</td><td ${td}>${c.norm} ${tag("norm")}</td></tr>` : ""}
        ${meta.warnings.length ? `<tr><td ${td}>${t("meta.warn")}</td><td ${td}>${meta.warnings.map(esc).join("<br>")}</td></tr>` : ""}
      </tbody></table>

      ${h2(t("rep.farms"))}
      <table ${tbl}><thead><tr><th ${th}>${t("herds.name")}</th><th ${th}>${t("herds.sheep")}</th><th ${th}>${t("herds.goats")}</th><th ${th}>${t("herds.cattle")}</th><th ${th}>${t("herds.horses")}</th>
        <th ${th}>${t("herds.au")}</th><th ${th}>${t("herds.rights")}</th></tr></thead><tbody>
        ${S.herds.map(h => `<tr style="page-break-inside:avoid"><td ${td}>${esc(h.name)}${h.demo ? " (" + t("herds.demo") + ")" : ""}</td><td ${tdn}>${fmt(h.sheep || 0)}</td><td ${tdn}>${fmt(h.goats || 0)}</td>
          <td ${tdn}>${fmt(h.cattle || 0)}</td><td ${tdn}>${fmt(h.horses || 0)}</td><td ${tdn}>${fmt(J.herdAU(h, P))}</td>
          <td ${td}>${h.allowed_plots && h.allowed_plots.length ? esc(h.allowed_plots.join(", ")) : t("herds.rightsAll")}</td></tr>`).join("") || `<tr><td ${td} colspan="7">${t("ov.noherds")}</td></tr>`}
      </tbody></table>
      <p style="font-size:10px;color:#555;margin:4px 0 0">${tag("input")} ${t("herds.rightsNote")}${S.herds.some(h => h.demo) ? " " + t("demo.banner", { n: S.herds.filter(h => h.demo).length }) : ""}</p>

      ${h2(t("tab.plots"))}
      <table ${tbl}><thead><tr><th ${th}>${t("plots.id")}</th><th ${th}>${t("plots.ha")} ${tag("sat")}</th><th ${th}>NDVI ${tag("sat")}</th>
        <th ${th}>${t("plots.quality")}</th><th ${th}>${t("plots.cap")} ${tag("model")}</th><th ${th}>${t("kpi.before")}</th><th ${th}>${t("kpi.after")}</th><th ${th}>${t("plots.water")}</th></tr></thead><tbody>
        ${S.plots.map(p => { const k = cap(p), lc = S.cur.load[p.id], lp = S.pl.load[p.id];
          return `<tr style="page-break-inside:avoid"><td ${td}><b>${esc(p.id)}</b>${p.forbidden ? " (" + t("pop.closedTag") + ")" : ""}</td><td ${tdn}>${fmt(p.pasture_ha)}</td><td ${tdn}>${p.ndvi ?? "—"}</td>
          <td ${td}>${t("conf." + confidence(p))}</td><td ${tdn}>${sheep(k)}${k.limited_by === "norm" ? " " + t("src.norm").toLowerCase() : ""}</td>
          <td ${tdn}>${!lc.known ? "?" : lc.used ? pct(lc.load) : "—"}</td><td ${tdn}>${!lp.known ? "?" : lp.used ? pct(lp.load) : "—"}</td>
          <td ${td}>${esc(t("ws." + M.waterStatus(p)))}</td></tr>`; }).join("")}
      </tbody></table>
      <p style="font-size:10px;color:#555;margin:4px 0 0">${t("plots.qualityNote")}</p>
      ${S.plots.some(p => p.nograze_ha != null) ? `<p style="font-size:10.5px;margin:4px 0 0">${t("ng.title")}: ${fmt1(S.plots.reduce((s, p) => s + (p.nograze_ha || 0), 0))} ${t("common.ha")} — ${t("plots.nograzeNote", { b: S.ngBuf })}</p>` : ""}

      <div style="display:flex;gap:12px;page-break-inside:avoid;margin-top:10px">
        <div style="flex:1;text-align:center;background:#f3f4ee;border-radius:8px;padding:6px">${scheme(S.plots, p => loadColor(S.cur.load[p.id].known ? S.cur.load[p.id].load : null), p => (S.cur.load[p.id].used ? pct(S.cur.load[p.id].load) : ""), { size: 280 })}<b>${t("map.mode.current")}</b></div>
        <div style="flex:1;text-align:center;background:#f3f4ee;border-radius:8px;padding:6px">${scheme(S.plots, p => loadColor(S.pl.load[p.id].known ? S.pl.load[p.id].load : null), p => (S.pl.load[p.id].used ? pct(S.pl.load[p.id].load) : ""), { size: 280 })}<b>${t("map.mode.plan")}</b></div>
      </div>

      ${h2(t("rep.formula"))}
      <table ${tbl}><tbody>
        ${Object.values(M.FORMULA).map(f => `<tr><td ${td} colspan="2"><code style="font-size:10.5px">${esc(f)}</code></td></tr>`).join("")}
        ${M.describe(P).map(r => `<tr style="page-break-inside:avoid"><td ${td}>${esc(r.key)} = <b>${r.value}</b> ${esc(r.unit)}</td><td ${td}>${esc(r.source)} · ${t("set.origin." + r.origin)}</td></tr>`).join("")}
      </tbody></table>

      ${h2(t("rep.limits"))}
      <ul style="margin:0;padding-left:18px">${["how.l1", "how.l2", "how.l3", "how.l4"].map(k => `<li>${t(k)}</li>`).join("")}<li>${t("rep.l5")}</li><li>${t("rep.l6")}</li></ul>

      ${h2(t("rep.demand"))}
      <p>${t("rep.demandLine", { n: S.herds.length, au: fmt(S.herds.reduce((s, h) => s + J.herdAU(h, P), 0)), kg: fmt(demandAUd * P.intake / 1000), d: P.season_days, aud: fmt(demandAUd) })} ${tag("model")}</p>

      ${h2(t("rep.result"))}
      <table ${tbl}><thead><tr><th ${th}></th><th ${th}>${t("kpi.before")}</th><th ${th}>${t("kpi.after")}</th><th ${th}></th></tr></thead><tbody>
        <tr><td ${td}>${t("kpi.overloaded")}</td><td ${tdn}>${S.cur.overloaded}</td><td ${tdn}>${S.pl.overloaded}</td><td ${td}>${tag("model")}</td></tr>
        <tr><td ${td}>${t("kpi.excess")}</td><td ${tdn}>${fmt(hc)}</td><td ${tdn}>${fmt(hp)}</td><td ${td}>${tag("model")}</td></tr>
        <tr><td ${td}>${t("rep.cost")}</td><td ${tdn}>${fmt1(hc * P.hay_price / 1e6)}</td><td ${tdn}>${fmt1(hp * P.hay_price / 1e6)}</td><td ${td}>${tag("model")} ${tag("input")}</td></tr>
      </tbody></table>
      <p style="font-size:10px;color:#555;margin:4px 0 0">${t("kpi.costNote")} ${t("rep.priceLine", { p: fmt(P.hay_price), c: tenge })}</p>
      <p style="margin:4px 0"><b>${t("res.algo")}:</b> ${c.algoLine ? c.algoLine(S.pl) : ""}</p>
      ${S.pl.bottleneck && S.pl.bottleneck.groups.length && c.bottleneckHtml ? c.bottleneckHtml(S.pl.bottleneck.groups[0]) : ""}
      <table ${tbl}><thead><tr><th ${th}>${t("herds.name")}</th><th ${th}>${t("tab.routes")} ${tag("model")}</th></tr></thead><tbody>
        ${S.herds.map(h => `<tr style="page-break-inside:avoid"><td ${td}>${esc(h.name)}</td>
          <td ${td}>${(S.pl.herdPlans[h.id] || []).map(s => `${s.plot ? esc(s.plot) : t("routes.nofeed")} (${s.from}–${s.to})`).join(" → ") || "—"}</td></tr>`).join("") || `<tr><td ${td} colspan="2">${t("ov.noherds")}</td></tr>`}
      </tbody></table>

      ${h2(t("rep.unmet"))}
      ${unmetAUd > 0.5 ? `<p>${t("res.whereLine", { t: fmt(hp), names: S.herds.filter(h => S.pl.unmet[h.id]).map(h => esc(h.name)).join(", ") })}</p>
        <ul style="margin:0;padding-left:18px">${S.herds.filter(h => S.pl.unmet[h.id]).map(h => `<li>${c.whyHerd ? c.whyHerd(h, S.pl.diagnostics[h.id]) : esc(h.name)} — ${fmt(S.pl.unmet[h.id])} ${t("unit.au_days")}</li>`).join("")}</ul>
        <p><b>${t("res.change")}:</b> ${(c.planSuggestions ? c.planSuggestions() : S.pl.suggestions || []).map(s => c.sgText ? c.sgText(s) : s.type).join(" ")}</p>` : `<p>${t("rep.none")}</p>`}

      ${h2(t("water.title"))}
      ${wells.length ? `<ul style="margin:0;padding-left:18px">${wells.map(w => `<li>${esc(w.plot)}: ${t("water.gain", { t: fmt(w.gain_t), d: fmt(wr.deficit_t) })}, ${t("water.better", { n: w.better.length })}. ${c.wcText ? esc(c.wcText(w.plot)) : ""}</li>`).join("")}</ul>` : `<p>${!wr.list.length && wr.status !== "no_help" ? t("water.none") : t("water.st." + wr.status, { t: fmt(wr.deficit_t) })}</p>`}${tag("model")} ${tag("input")}
      ${S.added.size ? `<p><b>${t("water.added")}:</b> ${[...S.added].map(esc).join(", ")} ${tag("input")}</p>` : ""}
      <p style="font-size:10px;color:#555">${t("water.check")}</p>

      ${scen.length ? `${h2(t("rep.scen"))}
      <table ${tbl}><thead><tr><th ${th}>${t("wi.c.variant")}</th><th ${th}>${t("wi.c.deficit")}</th><th ${th}>${t("wi.c.over")}</th><th ${th}>${t("wi.c.full")}</th><th ${th}>${t("wi.c.short")}</th></tr></thead><tbody>
        ${scen.filter(r => !r.error).map(r => `<tr style="page-break-inside:avoid"><td ${td}>${c.variantName ? c.variantName(r) : r.id}</td><td ${tdn}>${fmt(J.hayTonnes(r.deficit_kg, P))}</td><td ${tdn}>${r.overloaded}</td>
          <td ${tdn}>${r.type === "current" ? "—" : r.herds_full}</td><td ${tdn}>${r.type === "current" ? "—" : r.herds_short}</td></tr>`).join("")}
      </tbody></table><p style="font-size:10px;color:#555">${t("wi.note")}</p>` : ""}

      ${h2(t("rep.uncert"))}
      <ul style="margin:0;padding-left:18px">${["rep.u1", "rep.u2", "rep.u3", "rep.u4", "rep.u5"].map(k => `<li>${t(k)}</li>`).join("")}</ul>
      ${c.trend ? `<p>${esc(c.trend)}</p>` : ""}
      <p>${tag("model")} ${t("data.model.d")}</p>
      <p>${tag("input")} ${t("data.input.d")}</p>
      <p style="color:#555;font-size:10px;margin-top:14px">ainara001.github.io/jaiylym · Telegram @JAIYLYM_bot · ${summary.herds} ${t("sc.herds")}, ${fmt(summary.au)} ${t("herds.au")} · ${t("rep.version")} ${esc(meta.model_version)}</p>
    </div>`;
  }

  // имя файла только латиницей: с кириллицей часть браузеров сохраняет файл как «download» без расширения
  const TR = { а: "a", ә: "a", б: "b", в: "v", г: "g", ғ: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", қ: "q", л: "l", м: "m",
    н: "n", ң: "ng", о: "o", ө: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ұ: "u", ү: "u", ф: "f", х: "kh", һ: "h", ц: "ts", ч: "ch", ш: "sh",
    щ: "shch", ъ: "", ы: "y", і: "i", ь: "", э: "e", ю: "yu", я: "ya" };
  function fileName(village, d, prefix) {
    const lat = String(village || "village").toLowerCase().split("").map(ch => (ch in TR ? TR[ch] : ch)).join("")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "village";
    return `jaiylym-${prefix ? prefix + "-" : ""}${lat}-${d.toISOString().slice(0, 10)}.pdf`;
  }

  async function exportPdf(c) {
    return pdf(build(c), fileName(c.S.D.village.name, new Date()));
  }
  /** Готовый html → файл PDF; если библиотека не загрузилась — печать страницы (и ошибка наверх, чтобы сказать об этом). */
  async function pdf(html, name) {
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

  window.Report = { build, export: exportPdf, pdf, fileName };
})();
