/*
 * Ответ ИИ → аккуратный HTML для сайта (и Node для тестов). Модель пишет простой текст (формат задан в api.js):
 * первая строка — вывод; «— пункт»; «Заголовок:»; метки источника [спутник] [ввод] [модель] [норма] [интернет] [общее].
 * Безопасно: весь текст экранируется, разметка ставится только вокруг найденных токенов — HTML из ответа не исполняется.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JaiylymAIText = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TAGS = { "спутник": "sat", "ввод": "input", "енгізу": "input", "модель": "model", "интернет": "web", "общее": "gen", "жалпы": "gen", "норма": "norm" };
  // метка источника | число (знак — только в начале слова: в «д.1-30» дефис — диапазон), разделители тысяч, дробь, %
  // … | код участка (Д-ЮЗ) — не рвётся по дефису на узком экране. В классе разделителей тысяч — пробел, U+00A0 и U+202F.
  const TOKEN = /\[(спутник|ввод|енгізу|модель|интернет|общее|жалпы|норма)\]|((?:(?<=^|\s)[-−+])?(?:\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?))(\s?%)?|([БД]-(?:СВ|СЗ|ЮВ|ЮЗ|С|В|Ю|З))(?![А-Яа-яЁё])/gi;

  /** Строка → HTML: числа выделены, метки источника — цветные ярлыки (label(kind) даёт подпись на языке сайта). */
  function inline(line, label) {
    let out = "", last = 0;
    for (const m of line.matchAll(TOKEN)) {
      out += esc(line.slice(last, m.index));
      if (m[1]) { const k = TAGS[m[1].toLowerCase()]; out += ` <span class="src src-${k}">${esc(label(k))}</span>`; }
      else if (m[4]) out += `<span class="plot-id">${esc(m[4])}</span>`;
      else out += `<b class="num">${esc(m[2] + (m[3] || ""))}</b>`;
      last = m.index + m[0].length;
    }
    return (out + esc(line.slice(last))).replace(/\s+(<span class="src)/g, " $1");
  }

  /** Весь ответ: вывод, заголовки групп, списки. Остатки markdown (** и #) убираются. */
  function toHtml(text, label = k => k) {
    const lines = String(text == null ? "" : text).replace(/\*\*/g, "").split(/\r?\n/).map(s => s.replace(/^#+\s*/, "").trim()).filter(Boolean);
    const html = [];
    let list = null, lead = false;
    const close = () => { if (list) { html.push(`<ul class="ai-list">${list.join("")}</ul>`); list = null; } };
    for (const l of lines) {
      const b = /^(?:[—–•*]|-(?=\s))\s*(.*)$/.exec(l);
      if (b) { (list = list || []).push(`<li>${inline(b[1], label)}</li>`); continue; }
      close();
      if (!lead) { html.push(`<p class="ai-lead">${inline(l, label)}</p>`); lead = true; }
      else if (/:$/.test(l) && l.length <= 60) html.push(`<p class="ai-h">${inline(l, label)}</p>`);
      else html.push(`<p>${inline(l, label)}</p>`);
    }
    close();
    return `<div class="ai-text">${html.join("")}</div>`;
  }
  return { toHtml, inline, TAGS };
});
