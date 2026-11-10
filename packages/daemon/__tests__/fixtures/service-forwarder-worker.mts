import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { waitForFixtureChild } from "./service-child-lifetime.js";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { primeDaemon, holdForDaemon, ensureDaemonRunning } from "../../dist/forwarder-daemon-client.js";
import { callDaemon } from "../../dist/mcp-forwarder-calls.js";
const platform = process.argv[2] as NodeJS.Platform;
const serviceWaitMs = process.argv[3] ? Number(process.argv[3]) : undefined;
const opts = { platform, serviceWaitMs };
let plistOpens = 0;
const actualOpen = fs.open;
fs.open = (...args: Parameters<typeof fs.open>) => {
  if (String(args[0]) === join(process.env.HOME!, "Library/LaunchAgents/ai.n0mad.bastra-recall.plist")) plistOpens++;
  return actualOpen(...args);
};
// Keep ownership of each real auto-spawned daemon until process close. The
// production detached spawn/options remain intact; only fixture worker lifetime
// is extended, after its measured result has already been produced.
const spawned: childProcess.ChildProcess[] = [];
const actualSpawn = childProcess.spawn;
childProcess.spawn = ((...args: Parameters<typeof actualSpawn>) => {
  const child = actualSpawn(...args);
  spawned.push(child);
  child.unref = () => {}; // retain the close event in this fixture worker
  return child;
}) as typeof actualSpawn;
syncBuiltinESMExports();
const started = performance.now();
if (process.argv[4] === "disabled") {
  console.log(JSON.stringify({ ready: await ensureDaemonRunning(opts), ms: performance.now()-started }));
} else {
  const readiness = primeDaemon(opts);
  // A call made DURING boot is held, not sent to a missing daemon.
  const result = await holdForDaemon(() => callDaemon("recall", { query: "invented copper valve", k: 1 }));
  const health = await (await fetch(process.env.BASTRA_DAEMON_URL + "/health")).json() as { started_by?: string };
  console.log(JSON.stringify({ ready: await readiness, ms: performance.now()-started, starter: health.started_by, toolSucceeded: typeof result === "object", plistOpens }));
}

await Promise.all(spawned.map(waitForFixtureChild));
