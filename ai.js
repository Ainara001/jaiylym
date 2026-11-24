/*
 * Выбор ИИ-провайдера для сайта и бота: AI_PROVIDER=deepseek|gemini, иначе — DeepSeek, если задан DEEPSEEK_API_KEY, иначе Gemini.
 * Провайдер выбирается при каждом вызове: ключ можно поменять на Render без правки кода, а тесты подменяют ask() у модуля.
 * Рамка ассистента (SCOPE) и все правила — общие, в api.js и gemini.js; провайдеры отличаются только транспортом.
 */
const gemini = require("./gemini.js");
const deepseek = require("./deepseek.js");

function provider() {
  const p = (process.env.AI_PROVIDER || "").toLowerCase();
  if (p === "deepseek") return deepseek;
  if (p === "gemini") return gemini;
  return process.env.DEEPSEEK_API_KEY ? deepseek : gemini;
}
const name = () => (provider() === deepseek ? "deepseek" : "gemini");

module.exports = {
  ask: (...a) => provider().ask(...a),
  status: async () => Object.assign({ provider: name() }, await provider().status()),
  configured: () => !!(process.env.DEEPSEEK_API_KEY || process.env.GEMINI_API_KEY),
  name,
  get MODELS() { return provider().MODELS; },
  SCOPE: gemini.SCOPE,
};
