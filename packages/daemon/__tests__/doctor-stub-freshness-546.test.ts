/**
 * #546 — `bastra doctor` notices a compiled hook binary that is not the code
 * that is here.
 *
 * The finding this exists for: the binary installed on the dev host was from
 * 29.08. and had run for two weeks against sources that had moved on through
 * #305, #543 and #545. It wrote telemetry rows without a `session_id` and
 * under the wrong lane, so the entire #305 measurement rested on numbers an
 * old build produced — and nobody saw it, because nothing ever asked. The
 * parity guard (`hook-stub-binary-parity-546.test.ts`) asks in CI. This asks
 * in everyday use.
 *
 * Six states, six different sentences, each one pinned here:
 *
 *   ok               the registered binary carries the digest of the sources
 *   stale            it carries a different one, with a runnable rebuild hint
 *   unstamped        it answers `version` with no digest (built before #546):
 *                    neither "stale" nor "ok" — it cannot be asked at all
 *   unknown-sources  no stub sources in this installation (npm/Homebrew), so
 *                    the question is not answerable HERE — said out loud, and
 *                    without a rebuild hint nobody there could carry out
 *   missing          the registration points at a file that does not exist
 *   unreadable       the file is there and `version` does not answer
 *
 * And since #547 a second verdict on the same binary, for the statusline
 * bundle it also carries: ok / stale / unstamped (built before #547, so it
 * cannot say) / unknown-bundle (nothing built here to compare against) /
 * unchecked (the binary could not be asked at all).
 *
 * Everything runs against a temp HOME with fabricated registrations and fake
 * `bastra-hook` shell scripts. The developer's real registrations and their
 * live binary are never read and never touched — that binary is what their
 * hooks are running right now.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/doctor-stub-freshness-546.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  STUB_REBUILD_HINT,
  collectRegisteredStubs,
  localStubSourceDigest,
  registeredStubBinary,
  stubFreshness,
  stubFreshnessLines,
  stubRegistrationFiles,
} from "../src/cli/stub-freshness.js";
import { CLAUDE_CODE_SETTINGS, CODEX_HOOKS, DAEMON_PACKAGE_ROOT } from "../src/cli/paths.js";

const made: string[] = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "bastra-546-doctor-"));
  made.push(home);
  return home;
}

test.after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

/** A registration in Claude Code's shape, pointing every lane at `binary`. */
async function writeClaudeHooks(home: string, binary: string): Promise<void> {
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: `${binary} prompt`, __bastraRecall: true }] }],
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: `${binary} session`, __bastraRecall: true }] }],
      },
      statusLine: { type: "command", command: `${binary} statusline --style=powerline` },
    }),
  );
}

/** Codex's shape: the env prefix and the quoting are the two things a
 *  lane-shaped path reader misses. */
async function writeCodexHooks(home: string, binary: string): Promise<void> {
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(
    join(home, ".codex", "hooks.json"),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ command: `BASTRA_HOOK_CLIENT=codex '${binary}' prompt`, timeout: 2 }],
      },
    }),
  );
}

/**
 * A stand-in for the compiled stub: a shell script that answers `version` with
 * a chosen stamp. Enough for everything this check does — it spawns the file
 * and reads one JSON line — and it needs no deno, so this file stays in
 * `npm test` on every runner instead of moving to the deno-only suite.
 */
async function fakeStub(dir: string, stamp: Record<string, unknown> | null): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "bastra-hook");
  const body = stamp === null
    ? "#!/bin/sh\nexit 3\n"
    : `#!/bin/sh\n[ "$1" = version ] && echo '${JSON.stringify(stamp)}' && exit 0\nexit 0\n`;
  await writeFile(path, body);
  await chmod(path, 0o755);
  return path;
}

/** A stamp from a binary built since #547: it carries both digests. Leaving
 *  `statusline` out produces the pre-#547 shape, which several tests need. */
const STAMP = (digest: string, statusline?: string) => ({
  stub_version: "0.9.2-stub",
  source_digest: digest,
  revision: "8a335951234567890",
  dirty: false,
  built_at: "2026-09-13T08:00:00.000Z",
  ...(statusline === undefined ? {} : { statusline_digest: statusline }),
});

/** The statusline bundle is a gitignored build artifact, so both sides of the
 *  #547 comparison are supplied here instead of read off the machine. */
const BUNDLE = "b".repeat(64);
const bundle = (digest: string | null) => async () => digest;

/** A package root with no stub sources at all — an npm or Homebrew install:
 *  `package.json` `files` ships neither `stub/*.ts` nor `scripts/`. */
async function rootWithoutSources(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-546-nosrc-"));
  made.push(dir);
  return dir;
}

test("#546: a binary built from the sources that are here reports ok", async () => {
  const home = await tempHome();
  const digest = await localStubSourceDigest();
  assert.equal(typeof digest, "string", "this checkout must be able to compute its own stub digest");
  const binary = await fakeStub(join(home, "install", "stub"), STAMP(digest!, BUNDLE));
  await writeClaudeHooks(home, binary);

  const report = await stubFreshness({ home, ownBinary: binary, statuslineDigest: bundle(BUNDLE) });
  assert.equal(report.sourcesAvailable, true);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]!.state, "ok");
  assert.equal(report.findings[0]!.foreign, false, "the registered binary is the one this installation owns");

  const lines = stubFreshnessLines(report);
  assert.equal(lines.length, 1, `nothing to warn about, got: ${lines.join(" | ")}`);
  assert.match(lines[0]!, /^✓ ok:/);
  assert.ok(!lines[0]!.includes(STUB_REBUILD_HINT), "a matching binary must not be told to rebuild");
});

test("#546: a binary from other sources is a finding, and says what to do about it", async () => {
  const home = await tempHome();
  const binary = await fakeStub(join(home, "install", "stub"), STAMP("f".repeat(64)));
  await writeClaudeHooks(home, binary);
  await writeCodexHooks(home, binary);

  const report = await stubFreshness({ home, ownBinary: binary });
  assert.equal(report.findings.length, 1, "one binary, however many surfaces register it");
  assert.deepEqual(report.findings[0]!.surfaces, ["claude-code", "codex"], "the codex form must be read too");
  assert.equal(report.findings[0]!.state, "stale");

  const line = stubFreshnessLines(report).join("\n");
  assert.match(line, /^⚠ stale hook binary:/);
  assert.ok(line.includes(binary), "the message must name the binary that is actually running");
  assert.ok(line.includes(STUB_REBUILD_HINT), "a finding without the fix is a finding nobody acts on");
  assert.ok(line.includes("2026-09-13"), "when it was built is what makes 'two weeks old' visible at a glance");
});

test("#546: a binary with no stamp is its own state, not 'stale' and not 'ok'", async () => {
  const home = await tempHome();
  // A binary from before #546: it answers `version`, it just has no digest.
  const binary = await fakeStub(join(home, "install", "stub"), { stub_version: "0.9.1-stub", source_digest: "", revision: null, dirty: false, built_at: null });
  await writeClaudeHooks(home, binary);

  const report = await stubFreshness({ home, ownBinary: binary });
  assert.equal(report.findings[0]!.state, "unstamped");

  const line = stubFreshnessLines(report)[0]!;
  assert.match(line, /^⚠ unstamped hook binary:/);
  assert.ok(!line.includes("stale"), "we do not know that it is stale — only that it cannot say");
  assert.ok(line.includes(STUB_REBUILD_HINT), "in a checkout, one rebuild makes it answerable");
});

test("#546: without a source checkout the answer is 'cannot be decided here', not a guess", async () => {
  const home = await tempHome();
  const binary = await fakeStub(join(home, "install", "stub"), STAMP("a".repeat(64)));
  await writeClaudeHooks(home, binary);

  // A Homebrew or npm install: the binary is there, the sources it would be
  // compared against are not. Calling it stale would be a false alarm on every
  // such host; calling it ok would be the silence #546 is about.
  const report = await stubFreshness({ home, ownBinary: binary, packageRoot: await rootWithoutSources() });
  assert.equal(report.sourcesAvailable, false);
  assert.equal(report.findings[0]!.state, "unknown-sources");

  const line = stubFreshnessLines(report)[0]!;
  assert.match(line, /^· /, "a fact, not a warning: nothing here is broken");
  assert.ok(line.includes("cannot be decided here"), "the non-statement must be stated");
  assert.ok(
    !line.includes(STUB_REBUILD_HINT),
    "advice that cannot be carried out here teaches people to skip the message",
  );
});

test("#546: a registration pointing at a binary that is not there is a finding", async () => {
  const home = await tempHome();
  const binary = join(home, "install", "stub", "bastra-hook");
  await writeClaudeHooks(home, binary); // never created

  const report = await stubFreshness({ home, ownBinary: binary });
  assert.equal(report.findings[0]!.state, "missing");
  const line = stubFreshnessLines(report)[0]!;
  assert.match(line, /^⚠ missing hook binary:/);
  assert.ok(line.includes("bastra install claude-code"), "the repair must be named");
});

test("#546: a binary that cannot answer `version` is reported, not treated as current", async () => {
  const home = await tempHome();
  const binary = await fakeStub(join(home, "install", "stub"), null); // exits non-zero
  await writeClaudeHooks(home, binary);

  const report = await stubFreshness({ home, ownBinary: binary });
  assert.equal(report.findings[0]!.state, "unreadable");
  assert.match(stubFreshnessLines(report)[0]!, /^⚠ unusable hook binary:/);
});

test("#546: a binary from another tree than this installation's is itself a finding", async () => {
  const home = await tempHome();
  const digest = await localStubSourceDigest();
  const elsewhere = await fakeStub(join(home, "other-checkout", "stub"), STAMP(digest!, BUNDLE));
  await writeClaudeHooks(home, elsewhere);

  const report = await stubFreshness({
    home,
    ownBinary: join(home, "install", "stub", "bastra-hook"),
    statuslineDigest: bundle(BUNDLE),
  });
  assert.equal(report.findings[0]!.state, "ok", "the registered binary is current…");
  assert.equal(report.findings[0]!.foreign, true, "…and it is not the one this installation manages");

  const lines = stubFreshnessLines(report);
  assert.equal(lines.length, 2, "the freshness and the wrong-tree finding are two statements");
  assert.ok(lines[1]!.includes(elsewhere), "the user runs something other than what they are looking at");
});

test("#546: hosts on the node thin client have nothing to report", async () => {
  const home = await tempHome();
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "node /opt/bastra/dist/prompt-hook.js", __bastraRecall: true }] }],
      },
    }),
  );
  const report = await stubFreshness({ home, ownBinary: join(home, "nope", "bastra-hook") });
  assert.deepEqual(report.findings, [], "the node client ships inside dist and cannot drift from it");
  assert.deepEqual(stubFreshnessLines(report), []);
});

test("#546: the binary is read out of both registered command shapes", () => {
  const home = "/home/x";
  assert.equal(registeredStubBinary("/opt/b/stub/bastra-hook prompt", home), "/opt/b/stub/bastra-hook");
  assert.equal(
    registeredStubBinary("BASTRA_HOOK_CLIENT=codex '/opt/b/stub/bastra-hook' write", home),
    "/opt/b/stub/bastra-hook",
    "the codex env prefix must not hide the binary",
  );
  assert.equal(
    registeredStubBinary('"/opt/my stuff/stub/bastra-hook" stop', home),
    "/opt/my stuff/stub/bastra-hook",
    "a quoted path with spaces is the only way such a path can be registered",
  );
  assert.equal(
    registeredStubBinary("~/.bastra/stub/bastra-hook statusline --style=powerline", home),
    "/home/x/.bastra/stub/bastra-hook",
    "the statusline entry runs the same binary (#347) and is registered without a lane",
  );
  assert.equal(registeredStubBinary("node /opt/b/dist/prompt-hook.js", home), null);
  assert.equal(registeredStubBinary("/usr/bin/some-other-hook run", home), null);
});

test("#546: the check reads the same registration files the installers write", () => {
  // The paths are rebuilt from `home` so the guard above can point at a temp
  // one. That is exactly how they could drift away from the real locations and
  // leave the check reading nothing on a real host.
  const files = stubRegistrationFiles(homedir()).map((f) => f.path);
  assert.deepEqual(files, [CLAUDE_CODE_SETTINGS, CODEX_HOOKS]);
});

test("#546: the digest comes from the one module the build stamps with", async () => {
  // Not a second implementation: `scripts/stub-source-digest.mjs` is what
  // `build-stub.mjs` writes into the binary and what the parity guard compares
  // against. Two definitions of "the stub's sources" is how a check goes green
  // against a binary that is wrong.
  const { stubSourceDigest } = await import("../scripts/stub-source-digest.mjs");
  assert.equal(await localStubSourceDigest(DAEMON_PACKAGE_ROOT), stubSourceDigest());
  assert.equal(
    await localStubSourceDigest(await rootWithoutSources()),
    null,
    "an installation without stub sources has no reference digest, and must say null rather than invent one",
  );
});

// ─── #547: the statusline bundle inside the same binary ──────────

test("#547: a current hook binary carrying an older statusline bundle is a finding of its own", async () => {
  const home = await tempHome();
  const digest = await localStubSourceDigest();
  const binary = await fakeStub(join(home, "install", "stub"), STAMP(digest!, "9".repeat(64)));
  await writeClaudeHooks(home, binary);

  const report = await stubFreshness({ home, ownBinary: binary, statuslineDigest: bundle(BUNDLE) });
  assert.equal(report.findings[0]!.state, "ok", "every hook lane in this binary IS current…");
  assert.equal(report.findings[0]!.statusline, "stale", "…and the statusline it also ships is not");

  const lines = stubFreshnessLines(report);
  assert.equal(lines.length, 2, "the hook verdict and the statusline verdict are two statements");
  assert.match(lines[0]!, /^✓ ok:/);
  assert.match(lines[1]!, /^⚠ stale statusline/);
  assert.ok(lines[1]!.includes("#547"), "the reasoning has an address");
  assert.ok(lines[1]!.includes(STUB_REBUILD_HINT), "rebuilding the stub embeds the bundle that is here now");
});

test("#547: a matching bundle says nothing extra", async () => {
  const home = await tempHome();
  const digest = await localStubSourceDigest();
  const binary = await fakeStub(join(home, "install", "stub"), STAMP(digest!, BUNDLE));
  await writeClaudeHooks(home, binary);

  const report = await stubFreshness({ home, ownBinary: binary, statuslineDigest: bundle(BUNDLE) });
  assert.equal(report.findings[0]!.statusline, "ok");
  assert.equal(stubFreshnessLines(report).length, 1);
});

test("#547: a binary built before this change is readable, and says it cannot say", async () => {
  const home = await tempHome();
  const digest = await localStubSourceDigest();
  // The pre-#547 shape: `version` answers without a `statusline_digest` key.
  const binary = await fakeStub(join(home, "install", "stub"), STAMP(digest!));
  await writeClaudeHooks(home, binary);

  const report = await stubFreshness({ home, ownBinary: binary, statuslineDigest: bundle(BUNDLE) });
  assert.equal(report.findings[0]!.state, "ok", "the missing field must not break the hook verdict");
  assert.equal(report.findings[0]!.statusline, "unstamped");

  const line = stubFreshnessLines(report)[1]!;
  assert.match(line, /^⚠ /);
  assert.ok(line.includes("predates #547"), "not stale, not ok: it cannot be asked");
  assert.ok(!line.includes("stale statusline"), "we do not know that it is stale");
});

test("#547: with no bundle built here the statusline question is left open, not answered", async () => {
  const home = await tempHome();
  const digest = await localStubSourceDigest();
  const binary = await fakeStub(join(home, "install", "stub"), STAMP(digest!, "9".repeat(64)));
  await writeClaudeHooks(home, binary);

  // `packages/statusline/dist` is a build artifact: a fresh checkout, an npm
  // install and a Homebrew install all have none. Calling the binary stale
  // there would be a false alarm on every one of them.
  const report = await stubFreshness({ home, ownBinary: binary, statuslineDigest: bundle(null) });
  assert.equal(report.findings[0]!.statusline, "unknown-bundle");
  assert.equal(stubFreshnessLines(report).length, 1, "nothing is claimed about what could not be compared");
});

test("#547: a binary that cannot be asked at all gets no second verdict", async () => {
  const home = await tempHome();
  const binary = join(home, "install", "stub", "bastra-hook");
  await writeClaudeHooks(home, binary); // never created

  const report = await stubFreshness({ home, ownBinary: binary, statuslineDigest: bundle(BUNDLE) });
  assert.equal(report.findings[0]!.state, "missing");
  assert.equal(report.findings[0]!.statusline, "unchecked");
  assert.equal(stubFreshnessLines(report).length, 1);
});

test("#547: the bundle digest hashes the very file the binary embeds, and the stub digest still does not", async () => {
  const { STATUSLINE_BUNDLE, statuslineBundleDigest, stubSourceFiles } = await import(
    "../scripts/stub-source-digest.mjs"
  );
  const { createHash } = await import("node:crypto");
  const { existsSync, readFileSync } = await import("node:fs");
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");

  // The specifier in stub/bastra-hook.ts is what `deno compile` embeds. If it
  // ever moves, the digest must move with it or it hashes the wrong file.
  const stubEntry = await readFile(join(DAEMON_PACKAGE_ROOT, "stub", "bastra-hook.ts"), "utf8");
  const spec = /import\(\s*"(\.\.\/\.\.\/statusline\/[^"]+)"\s*\)/.exec(stubEntry);
  assert.ok(spec, "the stub must still import the statusline bundle by a static specifier");
  assert.equal(resolve(DAEMON_PACKAGE_ROOT, "stub", spec![1]!), STATUSLINE_BUNDLE);

  assert.ok(
    !stubSourceFiles().includes(STATUSLINE_BUNDLE),
    "the boundary #547 kept: a build artifact stays out of the hook-lane digest",
  );

  const digest = statuslineBundleDigest();
  if (existsSync(STATUSLINE_BUNDLE)) {
    assert.equal(digest, createHash("sha256").update(readFileSync(STATUSLINE_BUNDLE)).digest("hex"));
  } else {
    assert.equal(digest, null, "no bundle here is null, not an invented value");
  }
});

test("#546: a registration file that is absent or unparseable contributes nothing", async () => {
  const home = await tempHome(); // nothing written at all
  assert.deepEqual(await collectRegisteredStubs(home), []);
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(join(home, ".claude", "settings.json"), "{ not json");
  assert.deepEqual(
    await collectRegisteredStubs(home),
    [],
    "a broken registration is the surface adapter's finding, not this check's",
  );
});
