// Загрузка данных web/data/*.js в Node (для бота и проверок).
const fs = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "web", "data");

function loadAssign(file) {
  const text = fs.readFileSync(path.join(DATA, file), "utf8");
  const m = text.match(/window\.\w+\s*=\s*([\s\S]*?);?\s*$/);
  return JSON.parse(m[1]);
}

module.exports = {
  Jaiylym: require("./web/engine.js"),
  loadPlots: () => loadAssign("plots.js"),
  loadHerds: () => loadAssign("herds.js"),
};
