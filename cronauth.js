/*
 * Проверка вызова POST /cron без общего пароля: GitHub Actions предъявляет OIDC-токен
 * (JWT, подписан GitHub, RS256). Сервер проверяет подпись по открытым ключам GitHub и что токен выдан
 * именно workflow ежедневной проверки этого репозитория из ветки main, для нашей аудитории и ещё не истёк.
 * Подделать такой токен без доступа к main этого репозитория нельзя. CRON_SECRET остаётся как запасной способ.
 */
const crypto = require("crypto");

const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = ISSUER + "/.well-known/jwks";
const AUDIENCE = "jaiylym-cron";

let cache = { at: 0, keys: null };
async function defaultJwks() {
  if (cache.keys && Date.now() - cache.at < 3600e3) return cache.keys;
  const r = await fetch(JWKS_URL, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error("JWKS " + r.status);
  cache = { at: Date.now(), keys: (await r.json()).keys || [] };
  return cache.keys;
}

const b64json = s => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

/**
 * @returns {Promise<{ok: true, claims} | {ok: false, reason: string}>}
 */
async function verifyGithubOidc(token, {
  repository = process.env.CRON_REPOSITORY || "Ainara001/jaiylym",
  workflow = ".github/workflows/daily-check.yml",
  ref = "refs/heads/main",
  audience = AUDIENCE, jwks = defaultJwks, now = Date.now(),
} = {}) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return { ok: false, reason: "not_jwt" };
    const head = b64json(parts[0]), claims = b64json(parts[1]);
    if (head.alg !== "RS256") return { ok: false, reason: "alg" };
    const key = (await jwks()).find(k => k.kid === head.kid);
    if (!key) return { ok: false, reason: "unknown_kid" };
    const pub = crypto.createPublicKey({ key, format: "jwk" });
    const good = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), pub, Buffer.from(parts[2], "base64url"));
    if (!good) return { ok: false, reason: "signature" };
    const t = Math.floor(now / 1000);
    if (claims.iss !== ISSUER) return { ok: false, reason: "issuer" };
    if ((Array.isArray(claims.aud) ? claims.aud : [claims.aud]).indexOf(audience) < 0) return { ok: false, reason: "audience" };
    if (!(claims.exp > t - 60) || (claims.nbf && claims.nbf > t + 60)) return { ok: false, reason: "expired" };
    if (String(claims.repository || "").toLowerCase() !== repository.toLowerCase()) return { ok: false, reason: "repository" };
    const wf = String(claims.workflow_ref || "").toLowerCase();
    if (!wf.startsWith((repository + "/" + workflow + "@").toLowerCase())) return { ok: false, reason: "workflow" };
    if (claims.ref !== ref) return { ok: false, reason: "ref" };
    return { ok: true, claims };
  } catch (e) { return { ok: false, reason: "error: " + e.message }; }
}

module.exports = { verifyGithubOidc, AUDIENCE, ISSUER };
