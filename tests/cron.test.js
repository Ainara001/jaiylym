// POST /cron: доступ по OIDC-токену GitHub Actions (без общего пароля) или по CRON_SECRET.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const os = require("os"), path = require("path");
process.env.BOT_STATE_FILE = path.join(os.tmpdir(), `jaiylym-cron-test-${process.pid}.json`);
delete process.env.REDIS_URL;
delete process.env.CRON_SECRET;
const { verifyGithubOidc } = require("../cronauth.js");
const bot = require("../bot.js");
bot.setTest();

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = Object.assign(publicKey.export({ format: "jwk" }), { kid: "k1", alg: "RS256", use: "sig" });
const jwks = async () => [jwk];
const NOW = Date.parse("2026-11-24T04:00:00Z");
const good = {
  iss: "https://token.actions.githubusercontent.com", aud: "jaiylym-cron", repository: "Ainara001/jaiylym", ref: "refs/heads/main",
  workflow_ref: "Ainara001/jaiylym/.github/workflows/daily-check.yml@refs/heads/main", iat: NOW / 1000 - 10, exp: NOW / 1000 + 300,
};
function sign(claims, key = privateKey, head = { alg: "RS256", kid: "k1", typ: "JWT" }) {
  const enc = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = enc(head) + "." + enc(claims);
  return data + "." + crypto.sign("RSA-SHA256", Buffer.from(data), key).toString("base64url");
}
const opt = { jwks, now: NOW };

test("настоящий токен workflow ежедневной проверки из main принимается", async () => {
  const r = await verifyGithubOidc(sign(good), opt);
  assert.equal(r.ok, true, r.reason);
});

test("подделки и чужие токены отклоняются", async () => {
  const cases = {
    signature: sign(good, other.privateKey),
    repository: sign(Object.assign({}, good, { repository: "evil/jaiylym", workflow_ref: "evil/jaiylym/.github/workflows/daily-check.yml@refs/heads/main" })),
    workflow: sign(Object.assign({}, good, { workflow_ref: "Ainara001/jaiylym/.github/workflows/other.yml@refs/heads/main" })),
    ref: sign(Object.assign({}, good, { ref: "refs/heads/feature" })),
    audience: sign(Object.assign({}, good, { aud: "https://github.com/Ainara001" })),
    expired: sign(Object.assign({}, good, { exp: NOW / 1000 - 3600 })),
    issuer: sign(Object.assign({}, good, { iss: "https://evil.example" })),
    alg: sign(good, privateKey, { alg: "HS256", kid: "k1" }),
    unknown_kid: sign(good, privateKey, { alg: "RS256", kid: "zzz" }),
    not_jwt: "abc",
  };
  for (const [reason, tok] of Object.entries(cases)) {
    const r = await verifyGithubOidc(tok, opt);
    assert.equal(r.ok, false, reason);
    assert.equal(r.reason, reason);
  }
});

function fakeRes() {
  const res = { code: 0, body: "", writeHead(c) { this.code = c; return this; }, end(b) { this.body = String(b || ""); return this; } };
  return res;
}
const send = async () => {};

test("POST /cron: без пароля и без токена — 401, с токеном GitHub — проверка выполняется", async () => {
  let res = fakeRes();
  await bot.cronRoute({ headers: {} }, res, send, { oidc: opt, now: new Date(NOW) });
  assert.equal(res.code, 401);
  assert.match(res.body, /no_credentials/);
  res = fakeRes();
  await bot.cronRoute({ headers: { authorization: "Bearer " + sign(good, other.privateKey) } }, res, send, { oidc: opt, now: new Date(NOW) });
  assert.equal(res.code, 401);
  res = fakeRes();
  await bot.cronRoute({ headers: { authorization: "Bearer " + sign(good) } }, res, send, { oidc: opt, now: new Date(NOW) });
  assert.equal(res.code, 200, res.body);
  assert.equal(JSON.parse(res.body).auth, "github-oidc");
});

test("POST /cron: запасной способ — CRON_SECRET", async () => {
  process.env.CRON_SECRET = "s3cret-value-1234567890";
  try {
    let res = fakeRes();
    await bot.cronRoute({ headers: { "x-cron-secret": "wrong" } }, res, send, { oidc: opt, now: new Date(NOW) });
    assert.equal(res.code, 401);
    res = fakeRes();
    await bot.cronRoute({ headers: { "x-cron-secret": "s3cret-value-1234567890" } }, res, send, { oidc: opt, now: new Date(NOW) });
    assert.equal(res.code, 200);
    assert.equal(JSON.parse(res.body).auth, "secret");
  } finally { delete process.env.CRON_SECRET; }
});

test("версия на сервере видна в ответе /health", () => {
  assert.match(bot.buildInfo(), /^Модель 2.3.0, сборка /);
});
