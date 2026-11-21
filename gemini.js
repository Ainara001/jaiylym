/*
 * Gemini через Interactions API (POST /v1beta/interactions).
 * Старый метод generateContent для новых ключей Google больше не работает (пустой 404) —
 * поэтому бот раньше «не помогал». Ключ хранится только на сервере (переменная GEMINI_API_KEY).
 * Если модель перегружена (503) или долго молчит, пробуем следующую.
 */
const MODELS = (process.env.GEMINI_MODELS || "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash").split(",").map(s => s.trim()).filter(Boolean);
const URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

async function ask({ system, input, maxTokens = 700, temperature = 0.4, timeoutMs = 20000 }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { ok: false, error: "no_key" };
  let last = "unavailable";
  for (const model of MODELS) {
    try {
      const r = await fetch(URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ model, input, system_instruction: system, generation_config: { max_output_tokens: maxTokens, temperature } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        const text = (d.steps || []).filter(s => s.type === "model_output")
          .flatMap(s => s.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
        if (text) return { ok: true, text, model };
        last = "empty";
        continue;
      }
      last = (d.error && (d.error.code || d.error.message)) || "HTTP " + r.status;
      console.error("Gemini", model, r.status, String(last).slice(0, 120));
    } catch (e) { last = e.name === "TimeoutError" ? "timeout" : e.message; console.error("Gemini", model, last); }
  }
  return { ok: false, error: String(last) };
}

module.exports = { ask, MODELS };
