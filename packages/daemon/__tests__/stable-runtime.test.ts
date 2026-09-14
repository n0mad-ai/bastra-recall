/**
 * Tests for the stable runtime of npx-based installs (#180): the pure
 * ephemeral-path decision, the node_modules-root resolution, the
 * copy-into-~/.bastra/runtime round-trip (fixture dirs, no real npm), and
 * doctor's forwarder-path check formatting.
 *
 * ensureStableForwarder is exercised with injected forwarderPath/version/home
 * so no test touches the real HOME or a real npx cache.
 *
 * Run: npx tsx --test packages/daemon/__tests__/stable-runtime.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkForwarderRegistration,
  ensureStableForwarder,
  isEphemeralInstallPath,
  mapBinToStableRuntime,
  pinnedRuntimeVersion,
  removeRuntimeBase,
  resolveNodeModulesRoot,
  stableRuntimeTarget,
  homebrewKeg,
  homebrewStablePath,
} from "../src/cli/stable-runtime.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-stable-runtime-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Builds a fake npx cache: a flat node_modules with the daemon package and
 * two "production deps" — the shape `npx @bastra-recall/daemon` materializes.
 * Returns the node_modules root and the forwarder path inside it.
 */
async function makeFakeNpxCache(dir: string): Promise<{ nmRoot: string; forwarderPath: string }> {
  const nmRoot = join(dir, ".npm", "_npx", "0123abcd4567ef89", "node_modules");
  const daemonPkg = join(nmRoot, "@bastra-recall", "daemon");
  await mkdir(join(daemonPkg, "dist"), { recursive: true });
  await writeFile(join(daemonPkg, "package.json"), '{"name":"@bastra-recall/daemon","type":"module"}\n', "utf8");
  await writeFile(join(daemonPkg, "dist", "mcp-forwarder.js"), "// fake forwarder\n", "utf8");
  await writeFile(join(daemonPkg, "dist", "index.js"), "// fake daemon\n", "utf8");
  const corePkg = join(nmRoot, "@bastra-recall", "core");
  await mkdir(join(corePkg, "dist"), { recursive: true });
  await writeFile(join(corePkg, "package.json"), '{"name":"@bastra-recall/core","type":"module"}\n', "utf8");
  await writeFile(join(corePkg, "dist", "index.js"), "// fake core\n", "utf8");
  await mkdir(join(nmRoot, "zod"), { recursive: true });
  await writeFile(join(nmRoot, "zod", "package.json"), '{"name":"zod"}\n', "utf8");
  return { nmRoot, forwarderPath: join(daemonPkg, "dist", "mcp-forwarder.js") };
}

// ─── isEphemeralInstallPath (pure matrix) ────────────────────────────────────

test("isEphemeralInstallPath: npx cache paths are ephemeral", () => {
  assert.equal(isEphemeralInstallPath("/Users/x/.npm/_npx/0123abcd/node_modules/@bastra-recall/daemon/dist/mcp-forwarder.js"), true);
  assert.equal(isEphemeralInstallPath("/home/x/.npm/_npx/ff00/node_modules/@bastra-recall/daemon/dist/mcp-forwarder.js"), true);
  // Windows separators — npx caches exist there too.
  assert.equal(isEphemeralInstallPath("C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\ab12\\node_modules\\@bastra-recall\\daemon\\dist\\mcp-forwarder.js"), true);
  // segment at the very start
  assert.equal(isEphemeralInstallPath("_npx/abc/dist/mcp-forwarder.js"), true);
});

test("isEphemeralInstallPath: permanent installs are not", () => {
  // global npm
  assert.equal(isEphemeralInstallPath("/usr/local/lib/node_modules/@bastra-recall/daemon/dist/mcp-forwarder.js"), false);
  // Homebrew
  assert.equal(isEphemeralInstallPath("/opt/homebrew/lib/node_modules/@bastra-recall/daemon/dist/mcp-forwarder.js"), false);
  // source checkout
  assert.equal(isEphemeralInstallPath("/Users/x/Projekte/bastra-recall/packages/daemon/dist/mcp-forwarder.js"), false);
  assert.equal(isEphemeralInstallPath(""), false);
});

test("isEphemeralInstallPath: '_npx' must be a path segment, never a substring", () => {
  assert.equal(isEphemeralInstallPath("/home/x/my_npx_tools/daemon/dist/mcp-forwarder.js"), false);
  assert.equal(isEphemeralInstallPath("/home/x/_npx_backup/dist/mcp-forwarder.js"), false);
});

// ─── resolveNodeModulesRoot ──────────────────────────────────────────────────

test("resolveNodeModulesRoot: scoped package under node_modules → the node_modules dir", () => {
  assert.equal(
    resolveNodeModulesRoot("/x/.npm/_npx/ab/node_modules/@bastra-recall/daemon"),
    "/x/.npm/_npx/ab/node_modules",
  );
});

test("resolveNodeModulesRoot: source checkout is not a node_modules install", () => {
  assert.equal(resolveNodeModulesRoot("/repo/packages/daemon"), null);
});

// ─── stableRuntimeTarget layout ──────────────────────────────────────────────

test("stableRuntimeTarget: versioned dir under <home>/.bastra/runtime", () => {
  const t = stableRuntimeTarget("1.2.3", "/tmp/home-x");
  assert.equal(t.rootDir, join("/tmp/home-x", ".bastra", "runtime", "1.2.3"));
  assert.equal(t.forwarderPath, join(t.rootDir, "node_modules", "@bastra-recall", "daemon", "dist", "mcp-forwarder.js"));
  assert.equal(t.markerPath, join(t.rootDir, "runtime-source.json"));
});

// ─── ensureStableForwarder (fixture dirs, no real npm) ───────────────────────

test("ensureStableForwarder: permanent install passes through untouched", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const fwd = "/opt/homebrew/lib/node_modules/@bastra-recall/daemon/dist/mcp-forwarder.js";
    const r = await ensureStableForwarder({ dryRun: false }, { forwarderPath: fwd, version: "9.9.9", home });
    assert.equal(r.action, "native");
    assert.equal(r.path, fwd);
    assert.equal(r.note, undefined);
    assert.equal(await exists(join(home, ".bastra")), false);
  });
});

test("ensureStableForwarder: npx cache → copies the tree and returns the stable path", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const { nmRoot, forwarderPath } = await makeFakeNpxCache(dir);
    const r = await ensureStableForwarder({ dryRun: false }, { forwarderPath, version: "9.9.9-test", home });

    assert.equal(r.action, "copied");
    const target = stableRuntimeTarget("9.9.9-test", home);
    assert.equal(r.path, target.forwarderPath);
    assert.ok(r.note?.includes(target.rootDir), `note names the runtime dir: ${r.note}`);

    // Full tree survives: forwarder + daemon package.json + production deps.
    assert.equal(await readFile(target.forwarderPath, "utf8"), "// fake forwarder\n");
    assert.ok(await exists(join(target.rootDir, "node_modules", "@bastra-recall", "daemon", "package.json")));
    assert.ok(await exists(join(target.rootDir, "node_modules", "@bastra-recall", "core", "dist", "index.js")));
    assert.ok(await exists(join(target.rootDir, "node_modules", "zod", "package.json")));

    // Marker records the source.
    const marker = JSON.parse(await readFile(target.markerPath, "utf8"));
    assert.equal(marker.version, "9.9.9-test");
    assert.equal(marker.source, nmRoot);
    assert.ok(typeof marker.copied_at === "string" && marker.copied_at.length > 0);
  });
});

test("ensureStableForwarder: same version reuses the copy — survives cache eviction", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const { forwarderPath } = await makeFakeNpxCache(dir);
    const first = await ensureStableForwarder({ dryRun: false }, { forwarderPath, version: "9.9.9-test", home });
    assert.equal(first.action, "copied");

    // A sentinel in the runtime dir proves the second run does not re-copy.
    const target = stableRuntimeTarget("9.9.9-test", home);
    await writeFile(join(target.rootDir, "sentinel.txt"), "untouched\n", "utf8");

    // Evict the npx cache — the whole point of #180.
    await rm(join(dir, ".npm"), { recursive: true, force: true });

    const second = await ensureStableForwarder({ dryRun: false }, { forwarderPath, version: "9.9.9-test", home });
    assert.equal(second.action, "reused");
    assert.equal(second.path, target.forwarderPath);
    assert.equal(await readFile(join(target.rootDir, "sentinel.txt"), "utf8"), "untouched\n");
  });
});

test("ensureStableForwarder: new version copies again and prunes the old dir — runtime never grows unbounded", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const { forwarderPath } = await makeFakeNpxCache(dir);
    await ensureStableForwarder({ dryRun: false }, { forwarderPath, version: "1.0.0", home });
    // Stale staging leftovers (killed install) go too.
    const staleStaging = `${stableRuntimeTarget("1.0.0", home).rootDir}.tmp-99999`;
    await mkdir(staleStaging, { recursive: true });
    const r = await ensureStableForwarder({ dryRun: false }, { forwarderPath, version: "2.0.0", home });
    assert.equal(r.action, "copied");
    assert.equal(await exists(stableRuntimeTarget("1.0.0", home).rootDir), false);
    assert.equal(await exists(staleStaging), false);
    assert.ok(await exists(stableRuntimeTarget("2.0.0", home).forwarderPath));
  });
});

test("ensureStableForwarder: reuse never prunes — a second surface install keeps sibling dirs", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const { forwarderPath } = await makeFakeNpxCache(dir);
    await ensureStableForwarder({ dryRun: false }, { forwarderPath, version: "3.0.0", home });
    // A sibling dir that appears after the copy (e.g. concurrent tooling).
    const sibling = stableRuntimeTarget("other", home).rootDir;
    await mkdir(sibling, { recursive: true });
    const r = await ensureStableForwarder({ dryRun: false }, { forwarderPath, version: "3.0.0", home });
    assert.equal(r.action, "reused");
    assert.ok(await exists(sibling));
  });
});

test("ensureStableForwarder: dry-run reports the target path, writes nothing", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const { forwarderPath } = await makeFakeNpxCache(dir);
    const r = await ensureStableForwarder({ dryRun: true }, { forwarderPath, version: "9.9.9-test", home });
    assert.equal(r.action, "would-copy");
    assert.equal(r.path, stableRuntimeTarget("9.9.9-test", home).forwarderPath);
    assert.match(r.note ?? "", /would copy/);
    assert.equal(await exists(join(home, ".bastra")), false);
  });
});

test("ensureStableForwarder: unexpected layout falls back to the cache path, never throws", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    // _npx in the path but the package does NOT live under node_modules.
    const fwd = join(dir, "_npx", "weird", "daemon", "dist", "mcp-forwarder.js");
    const r = await ensureStableForwarder({ dryRun: false }, { forwarderPath: fwd, version: "9.9.9", home });
    assert.equal(r.action, "fallback");
    assert.equal(r.path, fwd);
    assert.match(r.note ?? "", /layout unexpected/);
  });
});

test("ensureStableForwarder: failed copy falls back to the cache path, never throws", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    // Plausible npx layout as a string, but nothing exists on disk → cp fails.
    const fwd = join(dir, "_npx", "ab", "node_modules", "@bastra-recall", "daemon", "dist", "mcp-forwarder.js");
    const r = await ensureStableForwarder({ dryRun: false }, { forwarderPath: fwd, version: "9.9.9", home });
    assert.equal(r.action, "fallback");
    assert.equal(r.path, fwd);
    assert.match(r.note ?? "", /copy failed/);
  });
});

// ─── mapBinToStableRuntime (#180: hooks + statusline follow the forwarder) ───

test("mapBinToStableRuntime: bin under the source node_modules maps into the copy", () => {
  const res = {
    rootDir: "/home/x/.bastra/runtime/1.0.0",
    sourceNodeModules: "/home/x/.npm/_npx/ab/node_modules",
  };
  assert.equal(
    mapBinToStableRuntime("/home/x/.npm/_npx/ab/node_modules/@bastra-recall/daemon/dist/hook.js", res),
    join("/home/x/.bastra/runtime/1.0.0", "node_modules", "@bastra-recall", "daemon", "dist", "hook.js"),
  );
  // Statusline resolves within the copied node_modules too.
  assert.equal(
    mapBinToStableRuntime("/home/x/.npm/_npx/ab/node_modules/@bastra-recall/statusline/dist/index.mjs", res),
    join("/home/x/.bastra/runtime/1.0.0", "node_modules", "@bastra-recall", "statusline", "dist", "index.mjs"),
  );
});

test("mapBinToStableRuntime: non-stable resolution or bin outside the tree passes through", () => {
  // Native install: no stable runtime → identity, byte-identical no-op.
  assert.equal(
    mapBinToStableRuntime("/repo/packages/daemon/dist/hook.js", {}),
    "/repo/packages/daemon/dist/hook.js",
  );
  // Stable runtime active, but the bin lives outside the copied tree
  // (source-checkout sibling) → identity.
  const res = { rootDir: "/h/.bastra/runtime/1.0.0", sourceNodeModules: "/h/.npm/_npx/ab/node_modules" };
  assert.equal(
    mapBinToStableRuntime("/repo/packages/statusline/dist/index.mjs", res),
    "/repo/packages/statusline/dist/index.mjs",
  );
});

test("ensureStableForwarder: stable resolutions carry rootDir + sourceNodeModules; native/fallback don't", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const { nmRoot, forwarderPath } = await makeFakeNpxCache(dir);
    const target = stableRuntimeTarget("9.9.9-test", home);

    const dry = await ensureStableForwarder({ dryRun: true }, { forwarderPath, version: "9.9.9-test", home });
    assert.equal(dry.rootDir, target.rootDir);
    assert.equal(dry.sourceNodeModules, nmRoot);

    const copied = await ensureStableForwarder({ dryRun: false }, { forwarderPath, version: "9.9.9-test", home });
    assert.equal(copied.action, "copied");
    assert.equal(copied.rootDir, target.rootDir);
    assert.equal(copied.sourceNodeModules, nmRoot);

    const reused = await ensureStableForwarder({ dryRun: false }, { forwarderPath, version: "9.9.9-test", home });
    assert.equal(reused.action, "reused");
    assert.equal(reused.rootDir, target.rootDir);
    assert.equal(reused.sourceNodeModules, nmRoot);

    const native = await ensureStableForwarder(
      { dryRun: false },
      { forwarderPath: "/opt/homebrew/lib/node_modules/@bastra-recall/daemon/dist/mcp-forwarder.js", version: "9.9.9-test", home },
    );
    assert.equal(native.rootDir, undefined);
    assert.equal(native.sourceNodeModules, undefined);

    const fallback = await ensureStableForwarder(
      { dryRun: false },
      { forwarderPath: join(dir, "_npx", "weird", "daemon", "dist", "mcp-forwarder.js"), version: "0.0.1", home },
    );
    assert.equal(fallback.action, "fallback");
    assert.equal(fallback.rootDir, undefined);
  });
});

// ─── removeRuntimeBase (uninstall all, #180) ─────────────────────────────────

test("removeRuntimeBase: removes ~/.bastra/runtime entirely and reports it", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const { forwarderPath } = await makeFakeNpxCache(dir);
    await ensureStableForwarder({ dryRun: false }, { forwarderPath, version: "1.0.0", home });
    assert.equal(await removeRuntimeBase(home), true);
    assert.equal(await exists(join(home, ".bastra", "runtime")), false);
    // Sibling ~/.bastra content survives.
    assert.ok(await exists(join(home, ".bastra")));
  });
});

test("removeRuntimeBase: absent dir → false, never throws", async () => {
  await withTempDir(async (dir) => {
    assert.equal(await removeRuntimeBase(join(dir, "no-such-home")), false);
  });
});

// ─── doctor forwarder-path check (pure formatting) ───────────────────────────

test("checkForwarderRegistration: healthy permanent path", () => {
  const c = checkForwarderRegistration("/opt/homebrew/lib/node_modules/@bastra-recall/daemon/dist/mcp-forwarder.js", true, "claude-code");
  assert.equal(c.broken, false);
  assert.match(c.detail, /\(exists\)$/);
});

test("checkForwarderRegistration: missing path → broken with re-install hint", () => {
  const c = checkForwarderRegistration("/gone/dist/mcp-forwarder.js", false, "cursor");
  assert.equal(c.broken, true);
  assert.match(c.detail, /MISSING/);
  assert.match(c.detail, /re-run 'bastra install cursor'/);
});

// ─── stale runtime pin ───────────────────────────────────────────────────────
// The 0.7.9 → 0.8.8 finding: everything reports success while the surfaces keep
// executing the replaced version. Nothing is missing and nothing is ephemeral,
// so both existing checks pass — the pinned path is the only place the truth is
// still written down.

test("pinnedRuntimeVersion reads the version out of a runtime path", () => {
  const home = "/Users/x";
  const fwd = join(home, ".bastra", "runtime", "0.7.9", "node_modules", "@bastra-recall", "daemon", "dist", "mcp-forwarder.js");
  assert.equal(pinnedRuntimeVersion(fwd, home), "0.7.9");
});

test("pinnedRuntimeVersion returns null outside the runtime dir", () => {
  const home = "/Users/x";
  assert.equal(pinnedRuntimeVersion("/opt/homebrew/lib/node_modules/@bastra-recall/daemon/dist/mcp-forwarder.js", home), null);
  // A path that merely mentions the directory name elsewhere must not match.
  assert.equal(pinnedRuntimeVersion("/tmp/.bastra/runtime/0.7.9/x.js", home), null);
});

test("checkForwarderRegistration: pin older than the running version → broken", () => {
  const home = "/Users/x";
  const fwd = join(home, ".bastra", "runtime", "0.7.9", "node_modules", "@bastra-recall", "daemon", "dist", "mcp-forwarder.js");
  const c = checkForwarderRegistration(fwd, true, "claude-code", "0.8.8", home);
  assert.equal(c.broken, true);
  assert.match(c.detail, /STALE PIN/);
  assert.match(c.detail, /runs 0\.7\.9/);
  assert.match(c.detail, /0\.8\.8 is installed/);
  assert.match(c.detail, /bastra install claude-code/);
});

test("checkForwarderRegistration: pin matching the running version is healthy", () => {
  const home = "/Users/x";
  const fwd = join(home, ".bastra", "runtime", "0.8.8", "node_modules", "@bastra-recall", "daemon", "dist", "mcp-forwarder.js");
  const c = checkForwarderRegistration(fwd, true, "claude-code", "0.8.8", home);
  assert.equal(c.broken, false);
  assert.match(c.detail, /\(exists\)$/);
});

test("checkForwarderRegistration: existing npx-cache path → broken with re-install hint (#180)", () => {
  const c = checkForwarderRegistration("/Users/x/.npm/_npx/ab12/node_modules/@bastra-recall/daemon/dist/mcp-forwarder.js", true, "claude-desktop");
  assert.equal(c.broken, true);
  assert.match(c.detail, /EPHEMERAL npx cache/);
  assert.match(c.detail, /re-run 'bastra install claude-desktop'/);
  assert.match(c.detail, /\.bastra\/runtime/);
});

test("checkForwarderRegistration: missing beats ephemeral in the wording", () => {
  const c = checkForwarderRegistration("/Users/x/.npm/_npx/ab12/node_modules/@bastra-recall/daemon/dist/mcp-forwarder.js", false, "claude-code");
  assert.equal(c.broken, true);
  assert.match(c.detail, /MISSING/);
});

// ─── Homebrew keg pins ───────────────────────────────────────────────────────
// Found on a Mac after `brew upgrade bastra-recall` 0.9.2 → 1.0.0: Claude Code,
// Cursor and Claude Desktop all still ran `/opt/homebrew/Cellar/bastra-recall/
// 0.9.2/…/mcp-forwarder.js`, and doctor printed "✓ ok … (exists)" beside
// "cli and daemon both 1.0.0". `brew cleanup` would have removed the MCP server
// from all three without a word.

/** A fake Homebrew prefix: two kegs and the opt symlink Homebrew re-points. */
async function brewPrefix(dir: string, optTo: string | null): Promise<{ prefix: string; keg: (v: string) => string }> {
  const prefix = join(dir, "homebrew");
  const keg = (v: string) => join(prefix, "Cellar", "bastra-recall", v);
  for (const v of ["0.9.2", "1.0.0"]) {
    const d = join(keg(v), "libexec", "packages", "daemon", "dist");
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "mcp-forwarder.js"), "", "utf8");
  }
  await mkdir(join(prefix, "opt"), { recursive: true });
  if (optTo) await symlink(join("..", "Cellar", "bastra-recall", optTo), join(prefix, "opt", "bastra-recall"));
  return { prefix, keg };
}
const FWD_REST = "libexec/packages/daemon/dist/mcp-forwarder.js";
const onWindows = process.platform === "win32";

test("homebrewKeg splits a keg path on either separator and ignores everything else", () => {
  assert.deepEqual(homebrewKeg("/opt/homebrew/Cellar/bastra-recall/1.0.0/libexec/x.js"), {
    prefix: "/opt/homebrew",
    keg: "1.0.0",
    version: "1.0.0",
    rest: "libexec/x.js",
  });
  assert.equal(homebrewKeg("/opt/homebrew/Cellar/node/26.8.2/bin/node"), null, "another formula's keg is not ours");
  assert.equal(homebrewKeg("C:\\x\\Cellar\\bastra-recall\\1.0.0\\a.js")?.version, "1.0.0");
  assert.equal(homebrewKeg("/opt/homebrew/opt/bastra-recall/libexec/x.js"), null);
  assert.equal(homebrewKeg("/usr/local/lib/node_modules/@bastra-recall/daemon/dist/mcp-forwarder.js"), null);
});

test("a keg path is registered through opt/ when opt/ points at that keg", { skip: onWindows }, async () => {
  await withTempDir(async (dir) => {
    const { prefix, keg } = await brewPrefix(dir, "1.0.0");
    const fwd = join(keg("1.0.0"), FWD_REST);
    assert.equal(homebrewStablePath(fwd), `${prefix}/opt/bastra-recall/${FWD_REST}`);

    const r = await ensureStableForwarder({ dryRun: false }, { forwarderPath: fwd, version: "1.0.0", home: join(dir, "home") });
    assert.equal(r.action, "native");
    assert.equal(r.path, `${prefix}/opt/bastra-recall/${FWD_REST}`, "the MCP registration must survive the next upgrade");

    const hook = join(keg("1.0.0"), "libexec/packages/daemon/dist/stop-hook.js");
    assert.equal(mapBinToStableRuntime(hook, r), `${prefix}/opt/bastra-recall/libexec/packages/daemon/dist/stop-hook.js`, "hooks and statusline too");
  });
});

test("opt/ pointing at another keg, or missing, leaves the path alone", { skip: onWindows }, async () => {
  await withTempDir(async (dir) => {
    const other = await brewPrefix(join(dir, "a"), "0.9.2");
    const fwd = join(other.keg("1.0.0"), FWD_REST);
    assert.equal(homebrewStablePath(fwd), fwd, "never redirect a registration to different code");
    const none = await brewPrefix(join(dir, "b"), null);
    assert.equal(homebrewStablePath(join(none.keg("1.0.0"), FWD_REST)), join(none.keg("1.0.0"), FWD_REST));
  });
});

test("doctor: a registration on the current keg is not 'ok' — it dies at the next brew cleanup", { skip: onWindows }, async () => {
  await withTempDir(async (dir) => {
    const { prefix, keg } = await brewPrefix(dir, "1.0.0");
    const pinned = checkForwarderRegistration(join(keg("1.0.0"), FWD_REST), true, "claude-desktop", "1.0.0");
    assert.equal(pinned.broken, true);
    assert.match(pinned.detail, /VERSION-PINNED Homebrew keg/);
    assert.match(pinned.detail, /re-run 'bastra install claude-desktop'/);

    const stale = checkForwarderRegistration(join(keg("0.9.2"), FWD_REST), true, "cursor", "1.0.0");
    assert.equal(stale.broken, true);
    assert.match(stale.detail, /STALE PIN — this surface runs 0\.9\.2, but 1\.0\.0 is installed/);

    const stable = checkForwarderRegistration(`${prefix}/opt/bastra-recall/${FWD_REST}`, true, "claude-code", "1.0.0");
    assert.deepEqual(stable.broken, false);
  });
});

test("doctor: a formula revision keg (1.0.0_1) of the running version is pinned, not a stale older version", { skip: onWindows }, async () => {
  await withTempDir(async (dir) => {
    const prefix = join(dir, "homebrew");
    const d = join(prefix, "Cellar", "bastra-recall", "1.0.0_1", "libexec", "packages", "daemon", "dist");
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "mcp-forwarder.js"), "", "utf8");
    await mkdir(join(prefix, "opt"), { recursive: true });
    await symlink(join("..", "Cellar", "bastra-recall", "1.0.0_1"), join(prefix, "opt", "bastra-recall"));
    const c = checkForwarderRegistration(join(prefix, "Cellar", "bastra-recall", "1.0.0_1", FWD_REST), true, "cursor", "1.0.0");
    assert.equal(c.broken, true);
    assert.doesNotMatch(c.detail, /STALE PIN/, "1.0.0_1 IS 1.0.0 — 'the update is not in effect' would be false");
    assert.match(c.detail, /VERSION-PINNED/);
    assert.equal(homebrewStablePath(join(prefix, "Cellar", "bastra-recall", "1.0.0_1", FWD_REST)), `${prefix}/opt/bastra-recall/${FWD_REST}`);
  });
});
