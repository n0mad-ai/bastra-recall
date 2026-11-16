/**
 * #1587: when may the strict local lock (tasks, assistant addresses) take over
 * a lease whose recorded pid is alive or whose host name differs?
 *
 * Only when the recorded writer provably cannot be running any more. A live
 * owner — any lease whose pid is alive in this boot and this process table —
 * is never displaced; those cases must still fail after the wait.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/path-lock-strict-reclaim.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { withPathLock, pathLockFilePath, PathLockUnavailableError } from "../src/path-lock.js";

const DEAD_PID = 2147483647;
const OTHER_BOOT = "00000000-0000-4000-8000-000000000000";

/** The boot identity this process writes into its own strict lease, if any. */
async function currentBoot(dir: string): Promise<string | undefined> {
  const state = join(dir, "probe.json");
  let boot: string | undefined;
  await withPathLock(
    state,
    async () => {
      boot = (JSON.parse(await readFile(pathLockFilePath(state), "utf8")) as { boot?: string }).boot;
    },
    { strictLocal: true }
  );
  return boot;
}

/** Writes `body` as a held lease and reports whether a strict writer got in. */
async function attempt(dir: string, name: string, body: Record<string, unknown>) {
  const state = join(dir, `${name}.json`);
  const raw = JSON.stringify({ token: `held-${name}`, ts: Date.now(), ...body });
  await writeFile(pathLockFilePath(state), raw, { mode: 0o600 });
  let ran = false;
  let error: unknown;
  try {
    await withPathLock(
      state,
      async () => {
        ran = true;
      },
      { strictLocal: true }
    );
  } catch (caught) {
    error = caught;
  }
  const after = await readFile(pathLockFilePath(state), "utf8").catch(() => null);
  return { ran, error, untouched: after === raw };
}

function quietStderr(t: { after: (fn: () => void) => void }) {
  const write = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = write;
  });
}

test("#1587: strict leases record this boot's identity where the platform exposes one", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-strict-boot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const boot = await currentBoot(dir);
  if (process.platform === "darwin" || process.platform === "linux") assert.match(String(boot), /^[0-9a-f-]{36}$/);
  else assert.equal(boot, undefined);
});

test("#1587: a lease from an earlier boot of this host is taken over even when its pid is alive again", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-strict-reboot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (process.platform !== "darwin" && process.platform !== "linux") return t.skip("no boot identity here");
  // process.pid stands in for an unrelated process that got the pid after a restart.
  const result = await attempt(dir, "reboot", { pid: process.pid, host: hostname(), boot: OTHER_BOOT });
  assert.equal(result.error, undefined);
  assert.equal(result.ran, true);
});

test("#1587: a renamed host in the same boot is judged by its pid on macOS", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-strict-rename-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (process.platform !== "darwin" && process.platform !== "linux") return t.skip("no boot identity here");
  const boot = (await currentBoot(dir)) ?? "missing";
  quietStderr(t);
  const dead = await attempt(dir, "renamed-dead", { pid: DEAD_PID, host: "old-name.local", boot });
  if (process.platform === "darwin") {
    assert.equal(dead.error, undefined);
    assert.equal(dead.ran, true);
  } else {
    // Linux containers share one boot id across pid namespaces: no proof there.
    assert.ok(dead.error instanceof PathLockUnavailableError);
    assert.equal(dead.untouched, true);
  }
});

test("#1587: a live or unprovable owner is never displaced", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-strict-live-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const boot = (await currentBoot(dir)) ?? "unknown";
  quietStderr(t);
  const host = hostname();
  const cases: [string, Record<string, unknown>][] = [
    // Alive in this boot: the rightful holder.
    ["live-same-boot", { pid: process.pid, host, boot }],
    // Written before boot ids existed: a live pid may be the holder.
    ["live-no-boot", { pid: process.pid, host }],
    // Same boot, other host name, live pid: still the holder.
    ["live-renamed", { pid: process.pid, host: "old-name.local", boot }],
    // Another host from another boot may be another machine sharing the file.
    ["remote-other-boot", { pid: DEAD_PID, host: "other-host", boot: OTHER_BOOT }],
    ["remote-no-boot", { pid: DEAD_PID, host: "other-host" }],
    // A non-string boot proves nothing.
    ["live-odd-boot", { pid: process.pid, host, boot: 42 }],
    // Nor does a damaged one: only the form of a real boot id can prove a reboot.
    ["live-empty-boot", { pid: process.pid, host, boot: "" }],
    ["live-text-boot", { pid: process.pid, host, boot: "not-a-boot-id" }],
    ["live-null-boot", { pid: process.pid, host, boot: null }],
  ];
  const results = await Promise.all(cases.map(([name, body]) => attempt(dir, name, body)));
  results.forEach((result, index) => {
    const name = cases[index][0];
    assert.equal(result.ran, false, `${name}: the callback must not run`);
    assert.ok(result.error instanceof PathLockUnavailableError, `${name}: ${String(result.error)}`);
    assert.equal(result.untouched, true, `${name}: the holder's lease stays as it was`);
    assert.doesNotMatch((result.error as Error).message, /settings file/, `${name}: names the wrong store`);
  });
});
