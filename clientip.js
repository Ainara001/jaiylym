/*
 * Адрес клиента за прокси. X-Forwarded-For слева дописывает сам клиент, поэтому левому адресу верить нельзя: лимиты обходились
 * одним заголовком. Идём справа налево и пропускаем свои прокси (частные адреса Render и Cloudflare); первый чужой адрес —
 * тот, кто на самом деле подключился. Прямое подключение (не из частной сети) — заголовок не смотрим вовсе.
 */
const net = require("net");

const trusted = new net.BlockList();
for (const [a, n] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["127.0.0.0", 8], ["100.64.0.0", 10], ["169.254.0.0", 16],
  // Cloudflare — https://www.cloudflare.com/ips-v4
  ["173.245.48.0", 20], ["103.21.244.0", 22], ["103.22.200.0", 22], ["103.31.4.0", 22], ["141.101.64.0", 18], ["108.162.192.0", 18], ["190.93.240.0", 20],
  ["188.114.96.0", 20], ["197.234.240.0", 22], ["198.41.128.0", 17], ["162.158.0.0", 15], ["104.16.0.0", 13], ["104.24.0.0", 14], ["172.64.0.0", 13], ["131.0.72.0", 22]])
  trusted.addSubnet(a, n, "ipv4");
for (const [a, n] of [["::1", 128], ["fc00::", 7], ["fe80::", 10],
  // Cloudflare — https://www.cloudflare.com/ips-v6
  ["2400:cb00::", 32], ["2606:4700::", 32], ["2803:f800::", 32], ["2405:b500::", 32], ["2405:8100::", 32], ["2a06:98c0::", 29], ["2c0f:f248::", 32]])
  trusted.addSubnet(a, n, "ipv6");

const norm = x => String(x || "").trim().replace(/^::ffff:/i, "").replace(/^\[|\]$/g, "");
const isTrusted = ip => { const v = net.isIP(ip); return v > 0 && trusted.check(ip, v === 6 ? "ipv6" : "ipv4"); };

function clientIp(req) {
  const peer = norm(req.socket && req.socket.remoteAddress);
  if (peer && !isTrusted(peer)) return key(peer);
  const chain = String(req.headers["x-forwarded-for"] || "").split(",").map(norm).filter(x => net.isIP(x)).slice(-12);
  for (let i = chain.length - 1; i >= 0; i--) if (!isTrusted(chain[i])) return key(chain[i]);
  return chain[0] || peer || "?";                 // все адреса свои (локальный запуск, тесты)
}
/** IPv6: у одного человека целая подсеть /64 — лимит на неё, а не на каждый адрес. */
function key(ip) {
  if (net.isIP(ip) !== 6) return ip;
  const [h, t = ""] = ip.split("::"), a = h ? h.split(":") : [], b = ip.includes("::") && t ? t.split(":") : [];
  const full = ip.includes("::") ? a.concat(Array(Math.max(0, 8 - a.length - b.length)).fill("0"), b) : a;
  return full.slice(0, 4).map(x => parseInt(x, 16).toString(16)).join(":") + "::/64";
}

module.exports = { clientIp, isTrusted };
