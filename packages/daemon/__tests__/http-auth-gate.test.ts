/**
 * Tests für die Browser-Bridge-Härtung des HTTP-Servers: Origin-Gate,
 * Token-Pflicht für Browser-Requests und die CORS-Allowlist.
 *
 * Kern-Bedrohungsmodell: Der Browser des Users läuft auf 127.0.0.1 — über die
 * TCP-Quelle nicht von der CLI unterscheidbar. Nur der Origin-Header trennt eine
 * (potenziell fremde) Website von einem lokalen Tool. Darum: Origin gesetzt =
 * Allowlist + Token Pflicht (auch loopback); kein Origin = loopback-skip gilt.
 *
 * Runner: `tsx --test __tests__/http-auth-gate.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corsAllowlistFromEnv, resolveCorsAllowlist, resolveCorsOrigin, gateApiRequest, safeEqual, isLoopbackHost } from "../src/http.js";
import { addCorsOrigin, getCorsOrigins } from "../src/settings.js";

const SITE = "https://bastra.io";
const TOKEN = "secret-token";

// ── resolveCorsOrigin ────────────────────────────────────────────────
test("resolveCorsOrigin: '*' reflects the caller's origin (or '*' when none)", () => {
  assert.equal(resolveCorsOrigin(SITE, ["*"]), SITE);
  assert.equal(resolveCorsOrigin(undefined, ["*"]), "*");
});

test("resolveCorsOrigin: allowlist reflects only listed origins, else null", () => {
  assert.equal(resolveCorsOrigin(SITE, [SITE]), SITE);
  assert.equal(resolveCorsOrigin("https://evil.com", [SITE]), null);
  assert.equal(resolveCorsOrigin(undefined, [SITE]), null); // no origin, not in list
});

// ── gateApiRequest: local tools (no Origin) ──────────────────────────
test("gate: no Origin + loopback-skip → 200 without token (CLI/forwarder path)", () => {
  assert.equal(
    gateApiRequest({
      reqOrigin: undefined,
      allowedOrigin: null,
      isLoopback: true,
      isLoopbackHost: true,
      authHeader: "",
      apiToken: TOKEN,
      loopbackSkip: true,
    }),
    200,
  );
});

test("gate: no Origin, non-loopback, token set → 401 without correct Bearer", () => {
  const base = {
    reqOrigin: undefined,
    allowedOrigin: null,
    isLoopback: false,
    isLoopbackHost: false,
    apiToken: TOKEN,
    loopbackSkip: true,
  };
  assert.equal(gateApiRequest({ ...base, authHeader: "" }), 401);
  assert.equal(gateApiRequest({ ...base, authHeader: `Bearer ${TOKEN}` }), 200);
});

test("gate: no Origin, loopback-skip OFF, token set → token enforced even on loopback", () => {
  const base = {
    reqOrigin: undefined,
    allowedOrigin: null,
    isLoopback: true,
    isLoopbackHost: true,
    apiToken: TOKEN,
    loopbackSkip: false,
  };
  assert.equal(gateApiRequest({ ...base, authHeader: "" }), 401);
  assert.equal(gateApiRequest({ ...base, authHeader: `Bearer ${TOKEN}` }), 200);
});

test("#526 gate: no Origin, loopback peer but FOREIGN Host → token required", () => {
  const base = {
    reqOrigin: undefined,
    allowedOrigin: null,
    isLoopback: true, // DNS-rebound browser / local tunnel: the socket looks local
    isLoopbackHost: false, // … but the Host header does not
    apiToken: TOKEN,
    loopbackSkip: true,
  };
  assert.equal(gateApiRequest({ ...base, authHeader: "" }), 401);
  assert.equal(gateApiRequest({ ...base, authHeader: `Bearer ${TOKEN}` }), 200, "tunnels stay usable with the token");
});

// ── gateApiRequest: browser requests (Origin present) ────────────────
test("gate: browser, allowed origin + correct token → 200 (even over loopback)", () => {
  assert.equal(
    gateApiRequest({
      reqOrigin: SITE,
      allowedOrigin: SITE,
      isLoopback: true,
      isLoopbackHost: true,
      authHeader: `Bearer ${TOKEN}`,
      apiToken: TOKEN,
      loopbackSkip: true, // must NOT exempt a browser request
    }),
    200,
  );
});

test("gate: browser, allowed origin, wrong/missing token → 401", () => {
  const base = {
    reqOrigin: SITE,
    allowedOrigin: SITE,
    isLoopback: true,
    isLoopbackHost: true,
    apiToken: TOKEN,
    loopbackSkip: true,
  };
  assert.equal(gateApiRequest({ ...base, authHeader: "" }), 401);
  assert.equal(gateApiRequest({ ...base, authHeader: "Bearer wrong" }), 401);
});

test("gate: browser, origin NOT on allowlist → 403 regardless of token", () => {
  assert.equal(
    gateApiRequest({
      reqOrigin: "https://evil.com",
      allowedOrigin: null, // resolveCorsOrigin rejected it
      isLoopback: true,
      isLoopbackHost: true,
      authHeader: `Bearer ${TOKEN}`,
      apiToken: TOKEN,
      loopbackSkip: true,
    }),
    403,
  );
});

test("gate: browser, allowed origin but NO token issued → 401 (secure by default)", () => {
  assert.equal(
    gateApiRequest({
      reqOrigin: SITE,
      allowedOrigin: SITE,
      isLoopback: true,
      isLoopbackHost: true,
      authHeader: "",
      apiToken: "", // daemon has no token → browser clients can't get in
      loopbackSkip: true,
    }),
    401,
  );
});

// ── corsAllowlistFromEnv: sicherer Default (#95) ─────────────────────
test("corsAllowlist (#95): unset/empty env → EMPTY allowlist, '*' only as explicit opt-in", () => {
  assert.deepEqual(corsAllowlistFromEnv(undefined), []);
  assert.deepEqual(corsAllowlistFromEnv(""), []);
  assert.deepEqual(corsAllowlistFromEnv("  "), []);
  assert.deepEqual(corsAllowlistFromEnv("*"), ["*"]);
  assert.deepEqual(corsAllowlistFromEnv(`${SITE}, https://x.dev`), [SITE, "https://x.dev"]);
});

test("corsAllowlist (#95): milestone test D — evil.com + valid token → 403 on default allowlist", () => {
  // Default (env unset): no origin is reflected …
  const allowedOrigin = resolveCorsOrigin("https://evil.com", corsAllowlistFromEnv(undefined));
  assert.equal(allowedOrigin, null);
  // … and the gate rejects the browser request even WITH the valid token.
  assert.equal(
    gateApiRequest({
      reqOrigin: "https://evil.com",
      allowedOrigin,
      isLoopback: true,
      isLoopbackHost: true,
      authHeader: `Bearer ${TOKEN}`,
      apiToken: TOKEN,
      loopbackSkip: true,
    }),
    403,
  );
  // Explicit legacy "*" would still let it through (the documented tunnel/dev tradeoff).
  assert.equal(resolveCorsOrigin("https://evil.com", corsAllowlistFromEnv("*")), "https://evil.com");
});

// ── CORS allowlist source: env override vs cli-settings (`bastra token --origin`)
test("resolveCorsAllowlist: env wins when set; cli-settings when env empty", () => {
  const stored = ["https://stored.dev"];
  // env (ops override) present → env wins, cli-settings ignored.
  assert.deepEqual(resolveCorsAllowlist([SITE], stored), [SITE]);
  // env empty → the origins minted by `bastra token --origin` apply.
  assert.deepEqual(resolveCorsAllowlist([], stored), stored);
  // neither → empty allowlist = deny all browser origins (secure by default).
  assert.deepEqual(resolveCorsAllowlist([], []), []);
});

test("addCorsOrigin → getCorsOrigins: normalizes, dedupes, drops invalid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-cors-"));
  const path = join(dir, "cli-settings.json");
  // Silence the intentional "ignoring invalid …" warning so the run stays clean.
  const origErr = process.stderr.write.bind(process.stderr);
  let warned = 0;
  // @ts-expect-error test shim: swallow stderr, count the warnings we expect.
  process.stderr.write = () => { warned++; return true; };
  try {
    await addCorsOrigin(SITE, path);
    await addCorsOrigin(SITE, path); // exact dup → not appended
    await addCorsOrigin("http://localhost:5173/", path); // trailing slash → normalized to bare origin
    await addCorsOrigin("https://bastra.io/app?x=1", path); // has a path → invalid, dropped
    await addCorsOrigin("not-a-url", path); // unparseable → dropped
    assert.deepEqual(await getCorsOrigins(path), [SITE, "http://localhost:5173"]);
    assert.ok(warned >= 2, "both invalid origins should warn");
  } finally {
    process.stderr.write = origErr;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ── safeEqual: timing-safe Token-Vergleich ───────────────────────────
test("safeEqual: equal true; different content or length false", () => {
  assert.equal(safeEqual(`Bearer ${TOKEN}`, `Bearer ${TOKEN}`), true);
  assert.equal(safeEqual("Bearer secret-tokeX", `Bearer ${TOKEN}`), false);
  assert.equal(safeEqual("", `Bearer ${TOKEN}`), false);
});

// ── isLoopbackHost: DNS-Rebinding-Gate für token-lose Endpoints ──────
test("isLoopbackHost: loopback hosts pass, rebound domains do not", () => {
  assert.equal(isLoopbackHost("127.0.0.1:6723", []), true);
  assert.equal(isLoopbackHost("localhost:6723", []), true);
  assert.equal(isLoopbackHost("LOCALHOST", []), true);
  assert.equal(isLoopbackHost("[::1]:6723", []), true);
  // #526: KEIN Host-Header ist kein Loopback-Beweis. Browser-Rebinding trägt
  // zwar immer einen, ein roher Port-Forwarder (socat, `ssh -L`) ergänzt aber
  // keinen — ein Angreifer am Tunnel lässt ihn einfach weg.
  assert.equal(isLoopbackHost(undefined, []), false);
  assert.equal(isLoopbackHost("", []), false);
  assert.equal(isLoopbackHost("attacker.example:6723", []), false);
  assert.equal(isLoopbackHost("attacker.example", []), false);
});

test("isLoopbackHost: BASTRA_ALLOWED_HOSTS entries pass (tunnel escape hatch)", () => {
  assert.equal(isLoopbackHost("tunnel.example.com", ["tunnel.example.com"]), true);
  assert.equal(isLoopbackHost("tunnel.example.com:443", ["tunnel.example.com"]), true);
  assert.equal(isLoopbackHost("other.example.com", ["tunnel.example.com"]), false);
});
