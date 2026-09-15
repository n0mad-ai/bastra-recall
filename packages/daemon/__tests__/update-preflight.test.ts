/**
 * #268 + #226 — the preflight in front of `bastra update`'s install step.
 *
 * What is pinned here is the promise the feature makes: an update never
 * replaces a locally modified file without (a) copying it aside first and
 * (b) either refusing or being told to proceed. The trigger case was the
 * Cyrillic locale fix living as a local patch on an installed daemon for days
 * (#253) — an update in that window would have reverted it silently.
 *
 * Every test drives the functions with an explicit `home` pointing at a temp
 * dir; nothing in this file may touch the real ~/.bastra. The provenance check
 * is only exercised on the "npm not found" path — a test that really runs
 * `npm audit signatures` would be slow and network-dependent.
 *
 * Run: npx tsx --test packages/daemon/__tests__/update-preflight.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backupRoot,
  buildManifest,
  classifyAuditOutput,
  detectDirty,
  formatPreflight,
  manifestPath,
  preflight,
  readManifest,
  verifyProvenance,
  writeManifest,
} from "../src/cli/update-preflight.js";
import { findExecutable } from "../src/cli/exec.js";
import { detectInstallMode, hasInPlacePreflight, packageRootFromCliPath, patchReapplyRoot, reapplyPatchSeries } from "../src/cli/update.js";
import { parseArgs } from "../src/cli/commands.js";
import {
  blockedUpdatePath,
  clearBlockedUpdate,
  formatBlockedUpdate,
  readBlockedUpdate,
  recordBlockedUpdate,
} from "../src/update-blocked.js";

const VERSION_UNDER_TEST = "9.9.9-test";

interface Sandbox {
  /** Stand-in for HOME — every read/write of the module goes here. */
  home: string;
  /** Stand-in for the installed package root. */
  root: string;
}

async function withSandbox(fn: (s: Sandbox) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-preflight-"));
  const home = join(dir, "home");
  const root = join(dir, "install", "@bastra-recall", "daemon");
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  try {
    await fn({ home, root });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** The shape an installed daemon package has on disk, minus the noise. */
async function fakeInstall(root: string): Promise<void> {
  await mkdir(join(root, "dist", "cli"), { recursive: true });
  await mkdir(join(root, "webui", "js"), { recursive: true });
  await mkdir(join(root, "node_modules", "zod"), { recursive: true });
  await writeFile(join(root, "package.json"), `{"name":"@bastra-recall/daemon","version":"${VERSION_UNDER_TEST}"}\n`, "utf8");
  await writeFile(join(root, "dist", "index.js"), "// daemon\n", "utf8");
  await writeFile(join(root, "dist", "cli", "update.js"), "// cli update\n", "utf8");
  await writeFile(join(root, "webui", "js", "app.js"), "// webui\n", "utf8");
  await writeFile(join(root, "node_modules", "zod", "index.js"), "// dep\n", "utf8");
}

async function baseline(s: Sandbox): Promise<void> {
  await writeManifest(await buildManifest(s.root, VERSION_UNDER_TEST), s.home);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

test("buildManifest snapshots the package tree and leaves node_modules out", async () => {
  await withSandbox(async (s) => {
    await fakeInstall(s.root);
    const m = await buildManifest(s.root, VERSION_UNDER_TEST);
    const paths = m.files.map((f) => f.path);
    assert.ok(paths.includes("dist/cli/update.js"), `expected dist/cli/update.js in ${paths.join(", ")}`);
    assert.ok(paths.includes("webui/js/app.js"));
    assert.equal(paths.some((p) => p.startsWith("node_modules/")), false, "node_modules must never be hashed");
    assert.equal(m.root, s.root);
    assert.equal(m.version, VERSION_UNDER_TEST);
  });
});

test("writeManifest/readManifest round-trip stays inside the injected home", async () => {
  await withSandbox(async (s) => {
    await fakeInstall(s.root);
    await baseline(s);
    assert.ok(manifestPath(s.home).startsWith(s.home), "manifest must not escape the injected home");
    const back = await readManifest(s.home);
    assert.ok(back);
    assert.equal(back.root, s.root);
  });
});

test("a clean tree passes: ok, no dirty files, no notes", async () => {
  await withSandbox(async (s) => {
    await fakeInstall(s.root);
    await baseline(s);
    const r = await preflight({ root: s.root, unattended: false, force: false, checkProvenance: false, home: s.home });
    assert.equal(r.ok, true);
    assert.deepEqual(r.dirty, []);
    assert.equal(r.backupDir, undefined);
    assert.deepEqual(r.notes, []);
    assert.equal(formatPreflight(r), "");
  });
});

test("a modified file is detected AND copied aside before anything replaces it", async () => {
  await withSandbox(async (s) => {
    await fakeInstall(s.root);
    await baseline(s);
    // The #253 case: a local patch on an installed daemon.
    await writeFile(join(s.root, "dist", "index.js"), "// daemon + local locale fix\n", "utf8");

    const r = await preflight({ root: s.root, unattended: false, force: true, checkProvenance: false, home: s.home });
    assert.equal(r.ok, true, "with --force the install proceeds");
    assert.deepEqual(r.dirty, [{ path: "dist/index.js", kind: "modified" }]);

    const expected = join(backupRoot(s.home), VERSION_UNDER_TEST);
    assert.equal(r.backupDir, expected);
    assert.ok(expected.startsWith(s.home), "backups must land under the injected home, never ~/.bastra");
    assert.equal(
      await readFile(join(expected, "dist", "index.js"), "utf8"),
      "// daemon + local locale fix\n",
      "the backup must hold the LOCAL content, not the shipped one",
    );
  });
});

test("unattended (--staged) refuses on dirty files, names the count, and ignores --force", async () => {
  await withSandbox(async (s) => {
    await fakeInstall(s.root);
    await baseline(s);
    await writeFile(join(s.root, "dist", "index.js"), "// patched\n", "utf8");
    await writeFile(join(s.root, "webui", "js", "app.js"), "// patched\n", "utf8");

    const r = await preflight({ root: s.root, unattended: true, force: true, checkProvenance: false, home: s.home });
    assert.equal(r.ok, false);
    assert.equal(r.dirty.length, 2);
    assert.match(r.refusal ?? "", /2 locally modified file\(s\)/);
    assert.match(r.refusal ?? "", /bastra update/, "the refusal must say how to review it by hand");
    // Refusing is not the same as discarding: the backup happens either way.
    assert.equal(r.backupDir, join(backupRoot(s.home), VERSION_UNDER_TEST));
  });
});

test("interactive refuses without --force and proceeds with it — backup in both cases", async () => {
  await withSandbox(async (s) => {
    await fakeInstall(s.root);
    await baseline(s);
    await writeFile(join(s.root, "dist", "cli", "update.js"), "// patched cli\n", "utf8");

    const refused = await preflight({ root: s.root, unattended: false, force: false, checkProvenance: false, home: s.home });
    assert.equal(refused.ok, false);
    assert.match(refused.refusal ?? "", /--force/);
    assert.ok(refused.backupDir, "a refusal must still leave the copy behind");

    const forced = await preflight({ root: s.root, unattended: false, force: true, checkProvenance: false, home: s.home });
    assert.equal(forced.ok, true);
    assert.equal(forced.refusal, undefined);
    assert.ok(await exists(join(backupRoot(s.home), VERSION_UNDER_TEST, "dist", "cli", "update.js")));
  });
});

test("a failed copy is named and blocks --force instead of claiming a backup", async () => {
  await withSandbox(async (s) => {
    await fakeInstall(s.root);
    await baseline(s);
    await writeFile(join(s.root, "dist", "index.js"), "// patched daemon\n", "utf8");
    await writeFile(join(s.root, "webui", "js", "app.js"), "// patched webui\n", "utf8");

    // Stand-in for the unbackupable file (chmod 000 / root-owned in the field):
    // a plain FILE where the backup needs a `dist/` directory, so the copy of
    // dist/index.js cannot land while webui/js/app.js still can.
    const dir = join(backupRoot(s.home), VERSION_UNDER_TEST);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "dist"), "not a directory\n", "utf8");

    const r = await preflight({ root: s.root, unattended: false, force: true, checkProvenance: false, home: s.home });
    assert.equal(r.ok, false, "--force may not wave through a file that has no copy anywhere");
    assert.deepEqual(r.backupFailed, ["dist/index.js"]);
    assert.equal(r.backupDir, dir, "the files that DID make it are still reported");
    assert.ok(await exists(join(dir, "webui", "js", "app.js")), "one failure must not abort the rest");
    assert.match(r.refusal ?? "", /could NOT be backed up \(dist\/index\.js\)/);
    assert.match(r.refusal ?? "", /--force/, "the refusal must say that forcing does not help here");

    const text = formatPreflight(r);
    assert.match(text, /NOT backed up \(1\)/);
    assert.match(text, /failed {3}dist\/index\.js/);
  });
});

test("when NOTHING could be copied, no backup dir is claimed at all", async () => {
  await withSandbox(async (s) => {
    await fakeInstall(s.root);
    await baseline(s);
    await writeFile(join(s.root, "dist", "index.js"), "// patched daemon\n", "utf8");

    const dir = join(backupRoot(s.home), VERSION_UNDER_TEST);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "dist"), "not a directory\n", "utf8");

    const r = await preflight({ root: s.root, unattended: false, force: true, checkProvenance: false, home: s.home });
    assert.equal(r.ok, false);
    assert.equal(r.backupDir, undefined, "an empty directory must never be reported as 'backed up to:'");
    assert.deepEqual(r.backupFailed, ["dist/index.js"]);
    assert.equal(formatPreflight(r).includes("backed up to:"), false);
  });
});

test("a deleted file counts as kind 'missing' and cannot be backed up", async () => {
  await withSandbox(async (s) => {
    await fakeInstall(s.root);
    await baseline(s);
    await rm(join(s.root, "webui", "js", "app.js"));

    const m = await readManifest(s.home);
    assert.ok(m);
    assert.deepEqual(await detectDirty(m), [{ path: "webui/js/app.js", kind: "missing" }]);

    const r = await preflight({ root: s.root, unattended: false, force: false, checkProvenance: false, home: s.home });
    assert.equal(r.ok, false);
    assert.deepEqual(r.dirty, [{ path: "webui/js/app.js", kind: "missing" }]);
    assert.equal(r.backupDir, undefined, "nothing exists to copy — no empty backup dir is claimed");
  });
});

test("no manifest yet: a note, never a refusal", async () => {
  await withSandbox(async (s) => {
    await fakeInstall(s.root);
    const r = await preflight({ root: s.root, unattended: true, force: false, checkProvenance: false, home: s.home });
    assert.equal(r.ok, true, "the first update after this ships must not be blocked by its own missing baseline");
    assert.deepEqual(r.dirty, []);
    assert.equal(r.notes.length, 1);
    assert.match(r.notes[0], /no install manifest yet/);
    assert.match(formatPreflight(r), /note: no install manifest yet/);
  });
});

test("a manifest from a different install root is skipped with a note", async () => {
  await withSandbox(async (s) => {
    await fakeInstall(s.root);
    await writeManifest(await buildManifest(s.root, VERSION_UNDER_TEST), s.home);
    const elsewhere = join(s.root, "..", "other-daemon");
    await mkdir(elsewhere, { recursive: true });

    const r = await preflight({ root: elsewhere, unattended: true, force: false, checkProvenance: false, home: s.home });
    assert.equal(r.ok, true);
    assert.equal(r.notes.length, 1);
    assert.match(r.notes[0], /different install root/);
  });
});

test("formatPreflight renders notes, findings, the backup dir and the refusal", async () => {
  const text = formatPreflight({
    ok: false,
    dirty: [
      { path: "dist/index.js", kind: "modified" },
      { path: "webui/js/app.js", kind: "missing" },
    ],
    backupDir: "/tmp/home/.bastra/update-backups/1.2.3",
    notes: ["npm not found on a trusted PATH"],
    refusal: "2 locally modified file(s) found — re-run with --force to update anyway.",
  });
  assert.match(text, /note: npm not found/);
  assert.match(text, /locally modified \(2\)/);
  assert.match(text, /changed {2}dist\/index\.js/);
  assert.match(text, /missing {2}webui\/js\/app\.js/);
  assert.match(text, /backed up to: \/tmp\/home\/\.bastra\/update-backups\/1\.2\.3/);
  assert.match(text, /✗ 2 locally modified/);
});

test("verifyProvenance reports SKIPPED — never a failure — when npm cannot be found", (t) => {
  const previous = process.env.PATH;
  process.env.PATH = "";
  try {
    if (findExecutable("npm")) {
      // findExecutable appends the Homebrew bin dirs unconditionally (#79), so on
      // a machine with brew-installed npm this branch is unreachable without
      // actually invoking npm — which this suite refuses to do (slow, networked).
      t.skip("npm still resolvable via the Homebrew fallback dirs");
      return;
    }
    const r = verifyProvenance(process.cwd());
    assert.equal(r.ok, true, "a verifier that cannot run must not block every update");
    assert.match(r.skipped ?? "", /npm not found/);
  } finally {
    process.env.PATH = previous;
  }
});

test("packageRootFromCliPath resolves the root of an npm-global install", () => {
  assert.equal(
    packageRootFromCliPath("/usr/local/lib/node_modules/@bastra-recall/daemon/dist/cli/update.js"),
    "/usr/local/lib/node_modules/@bastra-recall/daemon",
  );
  assert.equal(
    packageRootFromCliPath("/opt/homebrew/Cellar/bastra-recall/0.8.7/libexec/dist/cli/update.js"),
    "/opt/homebrew/Cellar/bastra-recall/0.8.7/libexec",
  );
});

test("--force is off by default and parsed for update", () => {
  assert.equal(parseArgs(["update"]).force, false);
  assert.equal(parseArgs(["update", "--force"]).force, true);
  assert.equal(parseArgs(["update", "--staged"]).force, false, "the auto-update path never carries --force");
});

/* ------------------------------------------------------------------------ *
 * classifyAuditOutput — the burden of proof is on the BLOCK.
 *
 * `npm audit signatures` exits 1 for a long list of reasons that say nothing
 * about a signature. Reading every non-zero exit as "verification failed" made
 * the guard fire on an unreachable registry — and because the provenance branch
 * sat in front of the --force branch, `bastra update` was then dead for good on
 * that machine. The outputs below are npm's real ones (npm 9–11,
 * lib/utils/verify-signatures.js and its error paths).
 * ------------------------------------------------------------------------ */

test("classifyAuditOutput: an unreachable registry (TUF + ENOTCACHED) is SKIPPED, never a block", () => {
  const behindAMirror = [
    "npm warn audit Fetching verification keys using TUF failed.  Fetching directly from https://registry.npmjs.org/.",
    "npm error code ENOTCACHED",
    "npm error request to https://registry.npmjs.org/-/npm/v1/keys failed: cache mode is 'only-if-cached' but no cached response is available.",
  ].join("\n");
  const r = classifyAuditOutput(1, behindAMirror);
  assert.equal(r.ok, true, "a verifier that cannot reach the registry must not block every update");
  assert.match(r.skipped ?? "", /ENOTCACHED/, "the skip must name the reason it came from the output");
});

test("classifyAuditOutput: a root without an installed dep tree is SKIPPED", () => {
  const r = classifyAuditOutput(1, "npm error found no installed dependencies to audit\n");
  assert.equal(r.ok, true);
  assert.match(r.skipped ?? "", /no installed dependencies/);

  const unsupported = classifyAuditOutput(
    1,
    "npm error found no dependencies to audit that were installed from a supported registry\n",
  );
  assert.equal(unsupported.ok, true);
});

test("classifyAuditOutput: an npm too old for the subcommand is SKIPPED with an upgrade hint", () => {
  const r = classifyAuditOutput(1, "npm ERR! Unknown command: \"signatures\"\n");
  assert.equal(r.ok, true);
  assert.match(r.skipped ?? "", /upgrade npm/);
});

test("classifyAuditOutput: exit 0 is a verified result", () => {
  const r = classifyAuditOutput(0, "audited 12 packages in 3s\n\n12 packages have verified registry signatures\n");
  assert.equal(r.ok, true);
  assert.equal(r.skipped, undefined, "a real verification is not a skip");
  assert.match(r.detail ?? "", /verified/);
});

test("classifyAuditOutput: an invalid registry signature DOES block", () => {
  const tampered = [
    "audited 12 packages in 3s",
    "",
    "1 package has an invalid registry signature:",
    "",
    "lodash@4.17.21 (https://registry.npmjs.org/)",
    "",
    "Someone might have tampered with this package since it was published on the registry!",
  ].join("\n");
  const r = classifyAuditOutput(1, tampered);
  assert.equal(r.ok, false, "this is the one case the guard exists for");
  assert.equal(r.skipped, undefined);
  assert.match(r.detail ?? "", /invalid registry signature/);
});

test("classifyAuditOutput: an invalid attestation and a missing signature both block", () => {
  const attestation = classifyAuditOutput(1, "2 packages have invalid attestations:\n\nfoo@1.0.0 (https://registry.npmjs.org/)\n");
  assert.equal(attestation.ok, false);
  assert.match(attestation.detail ?? "", /attestation/);

  const missing = classifyAuditOutput(
    1,
    "1 package has a missing registry signature but the registry is providing signing keys:\n\nfoo@1.0.0 (https://registry.npmjs.org/)\n",
  );
  assert.equal(missing.ok, false, "the registry handed out keys and then served an unsigned package");
});

test("classifyAuditOutput: colour codes cannot hide a failure", () => {
  // npm wraps `invalid` in chalk; piped stdio drops it today, a TTY would not.
  const coloured = "1 package has an [91minvalid[39m registry signature:\n";
  assert.equal(classifyAuditOutput(1, coloured).ok, false);
});

test("preflight: a provenance failure blocks interactively and names the way out", async () => {
  await withSandbox(async (s) => {
    await fakeInstall(s.root);
    await baseline(s);
    const failing = () => ({ ok: false, detail: "invalid registry signature — 1 package has an invalid registry signature:" });

    const refused = await preflight({
      root: s.root, unattended: false, force: false, checkProvenance: true, home: s.home, verify: failing,
    });
    assert.equal(refused.ok, false);
    assert.match(refused.refusal ?? "", /provenance verification failed/);
    assert.match(refused.refusal ?? "", /invalid registry signature/, "the refusal must say WHAT failed");
    assert.match(refused.refusal ?? "", /--force/, "a refusal that hides its own escape hatch is a dead end");
  });
});

test("preflight: an interactive --force overrides a provenance failure, loudly", async () => {
  await withSandbox(async (s) => {
    await fakeInstall(s.root);
    await baseline(s);
    const failing = () => ({ ok: false, detail: "invalid registry signature" });

    const forced = await preflight({
      root: s.root, unattended: false, force: true, checkProvenance: true, home: s.home, verify: failing,
    });
    assert.equal(forced.ok, true, "the provenance branch must not sit in front of the --force branch");
    assert.equal(forced.refusal, undefined);
    assert.ok(
      forced.notes.some((n) => /overridden by --force/.test(n)),
      `an overridden supply-chain finding must still be on the record, got ${JSON.stringify(forced.notes)}`,
    );
  });
});

test("preflight: the unattended path never honours --force on a provenance failure", async () => {
  await withSandbox(async (s) => {
    await fakeInstall(s.root);
    await baseline(s);
    const failing = () => ({ ok: false, detail: "invalid registry signature" });

    const r = await preflight({
      root: s.root, unattended: true, force: true, checkProvenance: true, home: s.home, verify: failing,
    });
    assert.equal(r.ok, false);
    assert.match(r.refusal ?? "", /provenance verification failed/);
    assert.doesNotMatch(r.refusal ?? "", /--force/, "the automatic path may not advertise an override it ignores");
    assert.match(r.refusal ?? "", /bastra update/, "it must point at the interactive run instead");
  });
});

test("preflight: a provenance check that could not run is a note, never a refusal", async () => {
  await withSandbox(async (s) => {
    await fakeInstall(s.root);
    await baseline(s);
    const unreachable = () => ({ ok: true, skipped: "provenance could not be verified here — npm error code ENOTCACHED" });

    const r = await preflight({
      root: s.root, unattended: true, force: false, checkProvenance: true, home: s.home, verify: unreachable,
    });
    assert.equal(r.ok, true, "behind a company mirror `bastra update` must still work");
    assert.equal(r.refusal, undefined);
    assert.ok(r.notes.some((n) => /ENOTCACHED/.test(n)));
  });
});

/* ------------------------------------------------------------------------ *
 * #268 — the unattended path must LEAVE A TRACE.
 *
 * `spawnStagedUpdate()` starts `bastra update --staged` detached with
 * stdio:"ignore", so a refusal printed there is read by nobody — while the
 * SessionStart hook has already announced "an update to Y is being applied"
 * and spent the day throttle. Without the record below, the user is told
 * something that did not happen and nothing ever corrects it.
 * ------------------------------------------------------------------------ */

test("a staged refusal is recorded on disk — reason, findings and backup dir survive the process", async () => {
  await withSandbox(async (s) => {
    await fakeInstall(s.root);
    await baseline(s);
    await writeFile(join(s.root, "dist", "index.js"), "// local locale fix\n", "utf8");
    await rm(join(s.root, "webui", "js", "app.js"));

    const verdict = await preflight({ root: s.root, unattended: true, force: false, checkProvenance: false, home: s.home });
    assert.equal(verdict.ok, false, "precondition: the unattended path refuses on dirty files");
    await recordBlockedUpdate(verdict, VERSION_UNDER_TEST, s.home);

    assert.ok(blockedUpdatePath(s.home).startsWith(s.home), "the record must never land in the real ~/.bastra");
    const back = await readBlockedUpdate(s.home);
    assert.ok(back, "the next session must be able to read the verdict back");
    assert.equal(back.version, VERSION_UNDER_TEST);
    assert.equal(back.reason, verdict.refusal, "the recorded reason is the verdict's own line, not a paraphrase");
    assert.deepEqual(back.files.sort(), ["changed dist/index.js", "missing webui/js/app.js"]);
    assert.equal(back.backup_dir, verdict.backupDir, "the record must point at the copies that were made");
    assert.ok(Date.parse(back.blocked_at) > 0, "blocked_at must be a real timestamp");
  });
});

test("a provenance refusal is recorded too — no files, but the reason survives", async () => {
  await withSandbox(async (s) => {
    await fakeInstall(s.root);
    await baseline(s);
    const verdict = await preflight({
      root: s.root,
      unattended: true,
      force: false,
      checkProvenance: true,
      home: s.home,
      verify: () => ({ ok: false, detail: "invalid registry signature" }),
    });
    assert.equal(verdict.ok, false);
    await recordBlockedUpdate(verdict, VERSION_UNDER_TEST, s.home);

    const back = await readBlockedUpdate(s.home);
    assert.ok(back);
    assert.deepEqual(back.files, [], "a supply-chain refusal is not about local files");
    assert.match(back.reason, /provenance verification failed/);
    assert.equal(back.backup_dir, undefined, "nothing was copied, so nothing may be claimed");
  });
});

test("no record, a malformed record and a cleared record all read as 'nothing is blocked'", async () => {
  await withSandbox(async (s) => {
    assert.equal(await readBlockedUpdate(s.home), null, "a fresh install has no block");

    await mkdir(join(s.home, ".bastra"), { recursive: true });
    await writeFile(blockedUpdatePath(s.home), "{ not json", "utf8");
    assert.equal(await readBlockedUpdate(s.home), null, "a broken file must not silence auto-updates forever");

    await writeFile(blockedUpdatePath(s.home), JSON.stringify({ version: "1.0.0" }), "utf8");
    assert.equal(await readBlockedUpdate(s.home), null, "a record without a reason cannot be reported");

    // Written by hand without `files` — readable, and normalised so the
    // formatter can never trip over it.
    await writeFile(
      blockedUpdatePath(s.home),
      JSON.stringify({ version: "1.0.0", reason: "held back", blocked_at: new Date().toISOString() }),
      "utf8",
    );
    const partial = await readBlockedUpdate(s.home);
    assert.ok(partial);
    assert.deepEqual(partial.files, []);
  });
});

test("clearBlockedUpdate removes the record and is a no-op when there is none", async () => {
  await withSandbox(async (s) => {
    await clearBlockedUpdate(s.home); // nothing there yet — must not throw
    await fakeInstall(s.root);
    await baseline(s);
    await writeFile(join(s.root, "dist", "index.js"), "// patched\n", "utf8");
    const verdict = await preflight({ root: s.root, unattended: true, force: false, checkProvenance: false, home: s.home });
    await recordBlockedUpdate(verdict, VERSION_UNDER_TEST, s.home);
    assert.ok(await exists(blockedUpdatePath(s.home)));

    // The one event that resolves a block: an update that actually installed.
    await clearBlockedUpdate(s.home);
    assert.equal(await exists(blockedUpdatePath(s.home)), false);
    assert.equal(await readBlockedUpdate(s.home), null);
  });
});

test("the SessionStart notice states that NOTHING was installed and how to resolve it", async () => {
  const text = formatBlockedUpdate({
    version: "0.8.7",
    reason: "2 locally modified file(s) found — an automatic update will not replace them. Run 'bastra update' yourself to review and confirm.",
    files: ["changed dist/index.js", "missing webui/js/app.js"],
    backup_dir: "/tmp/home/.bastra/update-backups/0.8.7",
    blocked_at: "2026-07-27T09:00:00.000Z",
  });
  assert.match(text, /was NOT applied/, "the whole point is correcting an 'is being applied' claim");
  assert.match(text, /0\.8\.7/);
  assert.match(text, /2 locally modified file\(s\)/, "the reason must be carried verbatim");
  assert.match(text, /changed dist\/index\.js/);
  assert.match(text, /update-backups\/0\.8\.7/, "the user must be told where their versions went");
  assert.match(text, /bastra update/, "a block that hides its own way out is a dead end");
  assert.doesNotMatch(text, /is being applied|updating in the background/);
});

test("the notice truncates a long finding list instead of pasting a whole tree into the session", () => {
  const files = Array.from({ length: 25 }, (_, i) => `changed dist/chunk-${i}.js`);
  const text = formatBlockedUpdate({
    version: "0.8.7",
    reason: "25 locally modified file(s) found",
    files,
    blocked_at: "2026-07-27T09:00:00.000Z",
  });
  assert.match(text, /… and 15 more/);
  assert.equal(text.includes("chunk-24"), false);
  assert.doesNotMatch(text, /Copies of the local versions/, "no backup dir was recorded, so none is claimed");
});

/* ------------------------------------------------------------------------ *
 * #268 — Homebrew: say it plainly instead of running a check that no-ops.
 *
 * `brew upgrade` builds a NEW keg (…/Cellar/bastra-recall/<version>/libexec)
 * and re-points the symlinks. Nothing in the current keg is replaced in place,
 * and the root this CLI runs from is version-pinned — so a manifest taken from
 * it can never match the next version's root.
 * ------------------------------------------------------------------------ */

test("the dirty check is claimed only where the update replaces the SAME directory", () => {
  assert.equal(hasInPlacePreflight("npm-global"), true, "`npm install -g` overwrites the package root in place");
  assert.equal(hasInPlacePreflight("brew"), false, "Homebrew installs a new keg beside the old one");
  assert.equal(hasInPlacePreflight("source"), false);
  assert.equal(hasInPlacePreflight("unknown"), false);

  // Closing the loop from a real Cellar path: detection → verdict.
  const brew = detectInstallMode("/opt/homebrew/Cellar/bastra-recall/0.8.7/libexec/dist/cli/update.js");
  assert.equal(brew.mode, "brew");
  assert.equal(hasInPlacePreflight(brew.mode), false);

  const npm = detectInstallMode("/usr/local/lib/node_modules/@bastra-recall/daemon/dist/cli/update.js");
  assert.equal(npm.mode, "npm-global");
  assert.equal(hasInPlacePreflight(npm.mode), true);
});

test("why brew gets no baseline: a keg manifest can never match the next version's root", async () => {
  await withSandbox(async (s) => {
    // Mirrors the real shape: the manifest was written from 0.8.7's keg, the CLI
    // now runs from 0.8.8's.
    const oldKeg = join(s.root, "Cellar", "bastra-recall", "0.8.7", "libexec");
    const newKeg = join(s.root, "Cellar", "bastra-recall", "0.8.8", "libexec");
    await fakeInstall(oldKeg);
    await fakeInstall(newKeg);
    await writeManifest(await buildManifest(oldKeg, "0.8.7"), s.home);

    // A local patch in the keg the CLI now runs from — the exact thing #268
    // exists to catch, and the exact thing this arrangement cannot see.
    await writeFile(join(newKeg, "dist", "index.js"), "// local patch\n", "utf8");

    const r = await preflight({ root: newKeg, unattended: true, force: false, checkProvenance: false, home: s.home });
    assert.equal(r.ok, true);
    assert.deepEqual(r.dirty, [], "the dirty check never ran — this is the permanent no-op, not a passing check");
    assert.ok(r.notes.some((n) => /different install root/.test(n)));
    // …which is why cmdUpdate does not take this path for brew at all: it would
    // print "a baseline is written after this update" every single time.
    assert.equal(hasInPlacePreflight("brew"), false);
  });
});

test("the patch series is reapplied onto the keg brew just linked — not skipped on Homebrew", () => {
  const brew = detectInstallMode("/opt/homebrew/Cellar/bastra-recall/1.0.0/libexec/packages/daemon/dist/cli/update.js");
  const oldRoot = packageRootFromCliPath(brew.cliPath);
  const newKegScript = "/opt/homebrew/opt/bastra-recall/libexec/packages/daemon/dist/index.js";
  assert.equal(
    patchReapplyRoot(brew, oldRoot, () => newKegScript),
    "/opt/homebrew/opt/bastra-recall/libexec/packages/daemon",
    "the fresh keg is the tree the user runs next — the running process's keg is superseded",
  );
  assert.equal(patchReapplyRoot(brew, oldRoot, () => null), null, "no installed keg found → nothing to patch, never the old one");

  const npm = detectInstallMode("/usr/local/lib/node_modules/@bastra-recall/daemon/dist/cli/update.js");
  assert.equal(patchReapplyRoot(npm, "/usr/local/lib/node_modules/@bastra-recall/daemon"), "/usr/local/lib/node_modules/@bastra-recall/daemon");
  assert.equal(patchReapplyRoot({ ...npm, mode: "source" }, "/repo/packages/daemon"), null);
  assert.equal(patchReapplyRoot({ ...npm, mode: "unknown" }, "/x"), null);
});

test("the update step reapplies onto the fresh keg, and asks brew nothing when there is no series", () => {
  const brew = detectInstallMode("/opt/homebrew/Cellar/bastra-recall/1.0.0/libexec/packages/daemon/dist/cli/update.js");
  const oldRoot = packageRootFromCliPath(brew.cliPath);
  const calls: Array<{ root: string; version?: string }> = [];
  let rootAsked = 0;
  let recorded = 0;
  const outcome = { applied: [], kept: [], retired: [], setAside: [], ok: true, rolledBack: false };
  const io = {
    root: (m: typeof brew, p: string) => (rootAsked++, patchReapplyRoot(m, p, () => "/opt/homebrew/opt/bastra-recall/libexec/packages/daemon/dist/index.js")),
    apply: ((root: string, opts?: { version?: string }) => (calls.push({ root, version: opts?.version }), outcome)) as never,
    record: (() => void recorded++) as never,
    version: () => "1.0.1",
    out: () => {},
  };

  reapplyPatchSeries(brew, oldRoot, { ...io, series: () => [] });
  assert.equal(rootAsked, 0, "no series → no `brew --prefix` spawn");
  assert.equal(calls.length, 0);

  reapplyPatchSeries(brew, oldRoot, { ...io, series: () => [{}] });
  assert.deepEqual(calls, [{ root: "/opt/homebrew/opt/bastra-recall/libexec/packages/daemon", version: "1.0.1" }]);
  assert.equal(recorded, 1, "the run is recorded so the next one can tell its own work from upstream's");

  calls.length = 0;
  reapplyPatchSeries({ ...brew, mode: "source" }, "/repo/packages/daemon", { ...io, series: () => [{}] });
  assert.equal(calls.length, 0, "a source checkout is the user's own tree");
});

test("a Homebrew update that cannot locate its keg says the patches were not reapplied", () => {
  const brew = detectInstallMode("/opt/homebrew/Cellar/bastra-recall/1.0.0/libexec/packages/daemon/dist/cli/update.js");
  let said = "";
  reapplyPatchSeries(brew, "/x", { series: () => [{}, {}], root: () => null, out: (t) => (said += t) });
  assert.match(said, /2 local patches not reapplied/);
});
