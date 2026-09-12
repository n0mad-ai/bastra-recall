/**
 * Tests for src/update-check.ts (#39).
 *
 * Uses node:test runner via tsx — no extra deps. Network calls are stubbed
 * via the injectable `fetchLatest` option, so this passes offline.
 *
 * Run: npx tsx --test packages/daemon/scripts/update-check.test.ts
 *      (or: npm run test:update --workspace=@bastra-recall/daemon)
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  compareVersions,
  checkForUpdate,
  isOptedOut,
} from "../src/update-check.js";
import { detectInstallMode, resolveInstalledRuntime } from "../src/cli/update.js";
import { autostartEnv, refreshManagedAutostart, renderPlist } from "../src/cli/autostart.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-update-check-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("compareVersions: numeric ordering", () => {
  assert.equal(compareVersions("0.5.2", "0.6.0"), -1);
  assert.equal(compareVersions("0.6.0", "1.0.0"), -1);
  assert.equal(compareVersions("0.6.0", "0.6.0"), 0);
  assert.equal(compareVersions("1.2.3", "1.2.4"), -1);
  assert.equal(compareVersions("1.2.10", "1.2.2"), 1); // numeric, not lexical
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
});

test("compareVersions: tolerates 'v' prefix and pre-release", () => {
  assert.equal(compareVersions("v0.6.0", "0.6.0"), 0);
  assert.equal(compareVersions("0.6.0-rc.1", "0.6.0"), 0);
  assert.equal(compareVersions("v0.5.0", "v0.6.0"), -1);
});

test("checkForUpdate: cache hit within TTL skips fetch", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "cache.json");
    const now = Date.now();
    await writeFile(cachePath, JSON.stringify({
      last_checked_at: new Date(now - 60_000).toISOString(),
      current: "0.5.2",
      latest: "0.6.0",
      html_url: "https://example.com/v0.6.0",
      published_at: "2026-05-20T00:00:00Z",
      hasUpdate: true,
    }), "utf8");

    let fetchCalls = 0;
    const state = await checkForUpdate({
      currentVersion: "0.5.2",
      cachePath,
      ttlMs: 24 * 60 * 60 * 1000,
      now,
      fetchLatest: async () => {
        fetchCalls++;
        return null;
      },
    });
    assert.equal(fetchCalls, 0, "fetch must not be called when cache is fresh");
    assert.ok(state);
    assert.equal(state.latest, "0.6.0");
    assert.equal(state.hasUpdate, true);
  });
});

test("checkForUpdate: cache miss triggers fetch + writes cache", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "cache.json");
    const now = Date.now();
    let fetchCalls = 0;
    const state = await checkForUpdate({
      currentVersion: "0.5.2",
      cachePath,
      ttlMs: 24 * 60 * 60 * 1000,
      now,
      fetchLatest: async () => {
        fetchCalls++;
        return {
          tag: "v0.6.0",
          html_url: "https://example.com/v0.6.0",
          published_at: "2026-05-20T00:00:00Z",
          body: "release notes",
        };
      },
    });
    assert.equal(fetchCalls, 1);
    assert.ok(state);
    assert.equal(state.current, "0.5.2");
    assert.equal(state.latest, "0.6.0");
    assert.equal(state.hasUpdate, true);

    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    assert.equal(cached.latest, "0.6.0");
    assert.equal(cached.hasUpdate, true);
  });
});

test("checkForUpdate: when local is current, hasUpdate=false", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "cache.json");
    const state = await checkForUpdate({
      currentVersion: "0.6.0",
      cachePath,
      ttlMs: 24 * 60 * 60 * 1000,
      now: Date.now(),
      fetchLatest: async () => ({
        tag: "0.6.0",
        html_url: "",
        published_at: "",
        body: "",
      }),
    });
    assert.ok(state);
    assert.equal(state.hasUpdate, false);
  });
});

test("checkForUpdate: opt-out via env returns null without fetching", async () => {
  await withTempDir(async (dir) => {
    const prev = process.env.BASTRA_UPDATE_CHECK;
    process.env.BASTRA_UPDATE_CHECK = "off";
    try {
      assert.equal(isOptedOut(), true);
      let fetchCalls = 0;
      const state = await checkForUpdate({
        currentVersion: "0.5.2",
        cachePath: join(dir, "cache.json"),
        ttlMs: 24 * 60 * 60 * 1000,
        now: Date.now(),
        fetchLatest: async () => {
          fetchCalls++;
          return null;
        },
      });
      assert.equal(state, null);
      assert.equal(fetchCalls, 0);
    } finally {
      if (prev === undefined) delete process.env.BASTRA_UPDATE_CHECK;
      else process.env.BASTRA_UPDATE_CHECK = prev;
    }
  });
});

test("checkForUpdate: stale-cache fallback when fetch returns null", async () => {
  await withTempDir(async (dir) => {
    const cachePath = join(dir, "cache.json");
    const now = Date.now();
    // Cache older than TTL
    await writeFile(cachePath, JSON.stringify({
      last_checked_at: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
      current: "0.5.2",
      latest: "0.6.0",
      html_url: "https://example.com",
      published_at: "2026-05-01T00:00:00Z",
      hasUpdate: true,
    }), "utf8");

    const state = await checkForUpdate({
      currentVersion: "0.5.2",
      cachePath,
      ttlMs: 24 * 60 * 60 * 1000,
      now,
      fetchLatest: async () => null, // simulate offline
    });
    assert.ok(state, "should fall back to stale cache when fetch fails");
    assert.equal(state.latest, "0.6.0");
  });
});

test("detectInstallMode: brew path", () => {
  const m = detectInstallMode("/opt/homebrew/Cellar/bastra-recall/0.5.2/libexec/dist/cli.js");
  assert.equal(m.mode, "brew");
  assert.match(m.updateCommand, /brew upgrade/);
});

test("detectInstallMode: npm-global path", () => {
  const m = detectInstallMode("/Users/x/.nvm/versions/node/v20.0.0/lib/node_modules/@bastra-recall/daemon/dist/cli.js");
  assert.equal(m.mode, "npm-global");
  assert.match(m.updateCommand, /npm install -g/);
});

test("detectInstallMode: source checkout with .git ancestor", async () => {
  await withTempDir(async (dir) => {
    // Build a fake source tree: dir/.git + dir/packages/daemon/dist/cli.js
    await mkdir(join(dir, ".git"), { recursive: true });
    await mkdir(join(dir, "packages", "daemon", "dist"), { recursive: true });
    const fakeCli = join(dir, "packages", "daemon", "dist", "cli.js");
    await writeFile(fakeCli, "// fake", "utf8");
    const m = detectInstallMode(fakeCli);
    assert.equal(m.mode, "source");
    assert.match(m.updateCommand, /git pull/);
  });
});

test("detectInstallMode: unknown path", () => {
  const m = detectInstallMode("/tmp/some/random/place/cli.js");
  // /tmp has no .git ancestor → unknown
  assert.equal(m.mode, "unknown");
  assert.match(m.updateCommand, /github\.com/);
});

// ─── #435 / #441: der verwaltete LaunchAgent nach einem Update ───────────────
//
// Beide Fälle drehen sich um denselben absoluten Pfad im plist. Getestet wird
// gegen ECHTE Keg-Verzeichnisse in einem Temp-Baum plus einen brew-Stub auf
// PATH; launchd wird nie angefasst — `launchctl` ist ebenfalls ein Stub, und
// der plist liegt im Temp-Verzeichnis, nie unter ~/Library.

const onMac = process.platform === "darwin";

interface Keg {
  root: string;
  script: string;
  version: string;
}

/** Ein Homebrew-Keg wie die Formel es baut: <keg>/libexec/packages/daemon/. */
async function makeKeg(cellar: string, version: string): Promise<Keg> {
  const root = join(cellar, version);
  const pkgRoot = join(root, "libexec", "packages", "daemon");
  await mkdir(join(pkgRoot, "dist"), { recursive: true });
  await writeFile(join(pkgRoot, "package.json"), JSON.stringify({ name: "@bastra-recall/daemon", version }), "utf8");
  const script = join(pkgRoot, "dist", "index.js");
  await writeFile(script, "// daemon entry point\n", "utf8");
  return { root, script, version };
}

/** brew-Stub, der `--prefix bastra-recall` auf das übergebene Keg zeigen lässt,
 *  und ein launchctl-Stub, der nur mitschreibt, was aufgerufen wurde. */
async function makeStubs(dir: string, prefix: string): Promise<{ bin: string; launchctl: string; log: string }> {
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  const log = join(dir, "launchctl.log");
  const brew = join(bin, "brew");
  await writeFile(brew, `#!/bin/sh\n[ "$1" = "--prefix" ] && { echo "${prefix}"; exit 0; }\nexit 1\n`, { encoding: "utf8", mode: 0o755 });
  const launchctl = join(bin, "launchctl");
  await writeFile(launchctl, `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`, { encoding: "utf8", mode: 0o755 });
  return { bin, launchctl, log };
}

function programFromPlist(xml: string): string[] {
  const array = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!array) return [];
  return [...array[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
}

async function withKegFixture<T>(
  fn: (ctx: { dir: string; old: Keg; fresh: Keg; plist: string; launchctl: string; log: string }) => Promise<T>,
): Promise<T> {
  return withTempDir(async (dir) => {
    const cellar = join(dir, "Cellar", "bastra-recall");
    const old = await makeKeg(cellar, "0.9.1");
    const fresh = await makeKeg(cellar, "0.9.2");
    const { bin, log, launchctl } = await makeStubs(dir, fresh.root);
    const plist = join(dir, "LaunchAgents", "ai.n0mad.bastra-recall.plist");
    await mkdir(join(dir, "LaunchAgents"), { recursive: true });
    // Der plist, den `bastra autostart on` vor dem Update geschrieben hat:
    // verwaltet, und auf das inzwischen abgelöste Keg zeigend.
    await writeFile(
      plist,
      renderPlist(autostartEnv(join(dir, "vault"), process.execPath), [process.execPath, old.script]),
      "utf8",
    );
    const prevPath = process.env.PATH;
    const prevVault = process.env.BASTRA_VAULT_PATH;
    process.env.PATH = `${bin}${delimiter}${prevPath ?? ""}`;
    process.env.BASTRA_VAULT_PATH = join(dir, "vault");
    try {
      return await fn({ dir, old, fresh, plist, launchctl, log });
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevVault === undefined) delete process.env.BASTRA_VAULT_PATH;
      else process.env.BASTRA_VAULT_PATH = prevVault;
    }
  });
}

/** Der CLI-Pfad, den ein Prozess aus dem ALTEN Keg sieht — die Lage direkt
 *  nach `brew upgrade`. */
function oldKegCliPath(old: Keg): string {
  return join(old.root, "libexec", "packages", "daemon", "dist", "cli", "update.js");
}

test("#435: after a Homebrew update the managed autostart names the NEW keg, not the superseded one", { skip: !onMac }, async () => {
  await withKegFixture(async ({ old, fresh, plist, launchctl }) => {
    const mode = detectInstallMode(oldKegCliPath(old));
    assert.equal(mode.mode, "brew");

    const target = resolveInstalledRuntime(mode);
    assert.ok(target, "the installed runtime must be resolvable through brew --prefix");
    assert.equal(target.script, fresh.script, "resolved against the installed keg, not the running process");
    assert.equal(target.version, "0.9.2");

    let out = "";
    const outcome = await refreshManagedAutostart((s) => { out += s; }, {
      target,
      reload: true,
      plistFile: plist,
      launchctl,
    });
    assert.equal(outcome.ok, true, out);

    const program = programFromPlist(await readFile(plist, "utf8"));
    assert.equal(program[1], fresh.script, "the plist must not point back at the old keg");
    assert.notEqual(program[1], old.script);
    assert.match(out, /0\.9\.2/, "the proof line names the active version");
  });
});

test("#435: an unresolvable install leaves the managed autostart alone instead of reporting success", { skip: !onMac }, async () => {
  await withKegFixture(async ({ old, plist, launchctl }) => {
    let out = "";
    const outcome = await refreshManagedAutostart((s) => { out += s; }, {
      target: null,
      reload: true,
      plistFile: plist,
      launchctl,
    });
    assert.equal(outcome.ok, false, "an update may not report success it cannot prove");
    const program = programFromPlist(await readFile(plist, "utf8"));
    assert.equal(program[1], old.script, "nothing was rewritten");
  });
});

test("#441: a staged update repoints the managed LaunchAgent without restarting it", { skip: !onMac }, async () => {
  await withKegFixture(async ({ old, fresh, plist, launchctl, log }) => {
    const target = resolveInstalledRuntime(detectInstallMode(oldKegCliPath(old)));
    assert.ok(target);

    let out = "";
    // reload: false ist genau das, was `bastra update --staged` setzt.
    const outcome = await refreshManagedAutostart((s) => { out += s; }, {
      target,
      reload: false,
      plistFile: plist,
      launchctl,
    });
    assert.equal(outcome.ok, true, out);

    const program = programFromPlist(await readFile(plist, "utf8"));
    assert.equal(program[1], fresh.script, "staged must still hand the owned plist to the new runtime");

    // Und der laufende Agent bleibt unangetastet: kein bootout, kein bootstrap,
    // kein kickstart — nur das lesende `print` aus readState.
    const calls = existsSync(log) ? await readFile(log, "utf8") : "";
    assert.doesNotMatch(calls, /bootout|bootstrap|kickstart/, `launchctl was used to restart: ${calls}`);
  });
});

test("#441: the staged path is wired to the same refresh as the interactive one", async () => {
  const src = await readFile(new URL("../src/cli/update.ts", import.meta.url), "utf8");
  const refreshAt = src.indexOf("refreshManagedAutostart((s)");
  const stagedReturnAt = src.indexOf("→ staged — daemon left running on old code");
  assert.ok(refreshAt > 0 && stagedReturnAt > 0, "both anchors must exist");
  assert.ok(
    refreshAt < stagedReturnAt,
    "the managed-service refresh must run BEFORE --staged reports success (#441)",
  );
});
