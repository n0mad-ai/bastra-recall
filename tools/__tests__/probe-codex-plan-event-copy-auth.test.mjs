/**
 * #506 — `tools/probes/codex-plan-event/run.sh --copy-auth` copies the
 * operator's ~/.codex/auth.json into the probe home. The copy sat in a fixed,
 * predictable temp path until someone remembered to delete the directory.
 * It is now made with umask 077 and removed when the run ends; a login made in
 * the probe home by the operator is not ours to overwrite or remove, with or
 * without --copy-auth.
 *
 * The probe needs a live `codex`; here a fake one on PATH records what it saw
 * and exits, so only the script's own handling of the credential is exercised.
 *
 * Runner: node --test tools/__tests__/probe-codex-plan-event-copy-auth.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RUN = fileURLToPath(new URL("../probes/codex-plan-event/run.sh", import.meta.url));
const run = promisify(execFile);

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "bastra-codex-probe-"));
  const home = join(root, "home");
  const probeHome = join(root, "probe");
  const bin = join(root, "bin");
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(probeHome, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(home, ".codex", "auth.json"), '{"token":"fake-not-a-credential"}\n');
  // The fake codex reports whether the probe home held a credential while it ran.
  await writeFile(
    join(bin, "codex"),
    `#!/bin/sh
case "$1" in --version) echo "codex 0.0.0-fake"; exit 0;; esac
if [ -f "$CODEX_HOME/auth.json" ]; then
  echo "present $(ls -l "$CODEX_HOME/auth.json" | cut -c1-10)" >> "$CODEX_HOME/seen.txt"
else
  echo absent >> "$CODEX_HOME/seen.txt"
fi
exit 0
`,
  );
  await chmod(join(bin, "codex"), 0o755);
  const env = {
    ...process.env,
    HOME: home,
    CODEX_PROBE_HOME: probeHome,
    PATH: `${bin}:${process.env.PATH}`,
  };
  return { root, home, probeHome, env };
}

test("--copy-auth: the copied credential is private while it exists and gone when the run ends", { skip: process.platform === "win32" }, async () => {
  const s = await sandbox();
  try {
    await run("bash", [RUN, "--copy-auth"], { env: s.env });
    const seen = await readFile(join(s.probeHome, "seen.txt"), "utf8");
    assert.match(seen, /present -rw-------/, `the copy was not owner-only while codex ran:\n${seen}`);
    assert.equal(existsSync(join(s.probeHome, "auth.json")), false, "the copied auth.json outlived the run");
    assert.equal((await stat(s.probeHome)).mode & 0o777, 0o700, "the fixed probe home was not private");
    // The operator's own credential is untouched.
    assert.ok((await stat(join(s.home, ".codex", "auth.json"))).isFile());
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test("--copy-auth refuses a symlinked probe home before copying the credential", { skip: process.platform === "win32" }, async () => {
  const s = await sandbox();
  try {
    const foreign = join(s.root, "foreign");
    await mkdir(foreign);
    await rmdir(s.probeHome);
    await symlink(foreign, s.probeHome);
    await assert.rejects(() => run("bash", [RUN, "--copy-auth"], { env: s.env }), /probe home is a symlink/);
    assert.equal(existsSync(join(foreign, "auth.json")), false);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test("--copy-auth refuses a dangling auth symlink before copying the credential", { skip: process.platform === "win32" }, async () => {
  const s = await sandbox();
  try {
    const redirected = join(s.root, "redirected-auth.json");
    await symlink(redirected, join(s.probeHome, "auth.json"));
    await assert.rejects(() => run("bash", [RUN, "--copy-auth"], { env: s.env }), /probe path is a symlink/);
    assert.equal(existsSync(redirected), false);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test("without --copy-auth a login the operator made in the probe home is left alone", { skip: process.platform === "win32" }, async () => {
  const s = await sandbox();
  try {
    await writeFile(join(s.probeHome, "auth.json"), '{"token":"operator-login"}\n');
    await run("bash", [RUN], { env: s.env });
    assert.equal(await readFile(join(s.probeHome, "auth.json"), "utf8"), '{"token":"operator-login"}\n');
    assert.equal((await stat(join(s.probeHome, "auth.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

// Regression: copying over an existing login and then removing "our" copy at exit
// deleted the operator's credential from the probe home.
test("--copy-auth with a login already in the probe home keeps that login", { skip: process.platform === "win32" }, async () => {
  const s = await sandbox();
  try {
    await writeFile(join(s.probeHome, "auth.json"), '{"token":"operator-login"}\n');
    const { stdout } = await run("bash", [RUN, "--copy-auth"], { env: s.env });
    assert.equal(await readFile(join(s.probeHome, "auth.json"), "utf8"), '{"token":"operator-login"}\n');
    assert.match(stdout, /already holds a login/);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});
