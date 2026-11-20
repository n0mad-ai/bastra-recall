/**
 * #1674 — the forwarder's wait for a healthy daemon runs on a monotonic
 * clock. On `Date.now()`, a system clock set back during the wait kept it
 * polling for as long as the clock stayed behind its deadline.
 *
 * No wall clock: `performance.now` and `Date.now` are replaced by clocks that
 * move on every read, and the assertion counts health probes. The daemon
 * answers unhealthy until its 20th probe; a wait of 1000 monotonic ms gives
 * up long before that. Before the fix the system clock, moving back a second
 * per read, never reached the deadline, and the 20th probe answered healthy.
 *
 * Runner: npm test (scripts/test-env.mjs isolates HOME and the logs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

test("#1674 forwarder: a system clock set back does not extend the wait for a healthy daemon", async (t) => {
  let probes = 0;
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === "/health") probes++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: probes >= 20 }));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  t.after(() => new Promise<void>((ok) => server.close(() => ok())));
  const prev = process.env.BASTRA_DAEMON_URL;
  process.env.BASTRA_DAEMON_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(() => {
    if (prev === undefined) delete process.env.BASTRA_DAEMON_URL;
    else process.env.BASTRA_DAEMON_URL = prev;
  });
  // The endpoint is resolved at import, so the import follows the env.
  const { waitForHealth } = await import("../src/forwarder-daemon-client.js");

  let monotonic = 0;
  let system = 1_800_000_000_000;
  t.mock.method(performance, "now", () => (monotonic += 100));
  t.mock.method(Date, "now", () => (system -= 1000));
  const healthy = await waitForHealth(1000);
  t.mock.restoreAll();

  assert.equal(healthy, false, `gave up before the daemon turned healthy (${probes} probes)`);
  assert.ok(probes >= 1 && probes < 20, `${probes} probes`);
});
