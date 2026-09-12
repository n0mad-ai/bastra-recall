/**
 * #535 — the one-click installers must not report success after a failed upgrade.
 *
 * Both public entry points (`distribution/install.sh` and the Finder
 * `distribution/Install Bastra.command`) deliberately survive a failing
 * `brew upgrade bastra-recall`: the already-installed version keeps working, so
 * aborting hard would be worse than useless. What they used to do afterwards was
 * the bug — run the guided setup against the OLD binary and, when those checks
 * passed, print the unconditional `✓ Done.` banner and exit 0. A user coming from
 * the 1.0 release page was told the install had succeeded while still on 0.9.x.
 *
 * The scripts are driven here with a stub `brew`, a stub `curl` for the release
 * API and a healthy stub `bastra` (install/doctor/status all green), in an
 * isolated HOME, so the assertions are about the scripts alone: distinct
 * incomplete wording, non-zero exit, and — the part that matters for a machine
 * that is still running fine — no re-registration against a version that never
 * landed.
 *
 * A failing `brew upgrade` was only the loud half. The quiet half is an upgrade
 * that exits 0 and changes nothing: a stale tap, or a keg Homebrew already
 * considers current. The first fix compared the CLI version only when `brew
 * outdated --verbose` had produced an expectation, and that command prints
 * nothing in exactly those cases — so the check was skipped and the run ended in
 * the success banner with the CLI still on 0.9.2. Worse, the "successful
 * upgrade" test below stubbed precisely that shape and asserted success, which
 * cemented the bug instead of catching it. The expectation is now taken from an
 * authoritative source (the release this installer comes from) and verified
 * after an upgrade AND after a fresh install; the green test correspondingly
 * requires the CLI to actually end up on the requested version.
 *
 * Runner: node --test tools/__tests__/installer-upgrade-failure.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPTS = {
  "install.sh": join(REPO, "distribution", "install.sh"),
  "Install Bastra.command": join(REPO, "distribution", "Install Bastra.command"),
};

/**
 * A stub `brew`.
 *  - `upgrade` fails, or succeeds when UPGRADE_OK=1 (the no-op upgrade: exit 0,
 *    nothing changed — which is what a stale tap looks like)
 *  - `outdated` prints nothing, like Homebrew does for a stale tap and for a keg
 *    it considers current
 *  - `list` says "installed", or "not installed" when BREW_LIST_RC=1
 */
const BREW_STUB = `#!/usr/bin/env bash
echo "brew $*" >> "$STUB_LOG"
case "$1" in
  tap) [ -z "\${2:-}" ] && echo "n0mad-ai/tap"; exit 0 ;;
  list) exit "\${BREW_LIST_RC:-0}" ;;
  outdated) exit 0 ;;
  install) exit 0 ;;
  upgrade)
    if [ "\${UPGRADE_OK:-0}" = "1" ]; then exit 0; fi
    echo "Error: simulated upgrade failure" >&2
    exit 1 ;;
esac
exit 0
`;

/** A stub `bastra` that is perfectly healthy — on $CLI_VERSION. */
const BASTRA_STUB = `#!/usr/bin/env bash
echo "bastra $*" >> "$STUB_LOG"
case "$1" in
  --version) echo "\${CLI_VERSION:-0.9.2}"; exit 0 ;;
  install) echo "installed all surfaces"; exit 0 ;;
  doctor) echo "all good"; exit 0 ;;
  status) echo '{"surfaces":[{"status":"ok"},{"status":"ok"}]}'; exit 0 ;;
esac
exit 0
`;

/**
 * A stub `curl`: the GitHub release the installer belongs to. RELEASE_TAG="" is
 * the unreachable case — the installer cannot learn what it should install.
 */
const CURL_STUB = `#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"
if [ -z "\${RELEASE_TAG:-}" ]; then exit 1; fi
echo "{\\"tag_name\\":\\"\${RELEASE_TAG}\\",\\"name\\":\\"Bastra \${RELEASE_TAG}\\"}"
`;

async function runInstaller(
  script,
  { upgradeOk = false, cliVersion = "0.9.2", releaseTag = "v1.0.0", installed = true } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-installer-535-"));
  try {
    const bin = join(dir, "bin");
    await mkdir(bin, { recursive: true });
    await mkdir(join(dir, "home"), { recursive: true });
    const log = join(dir, "calls.log");
    await writeFile(join(bin, "brew"), BREW_STUB, { mode: 0o755 });
    await writeFile(join(bin, "bastra"), BASTRA_STUB, { mode: 0o755 });
    await writeFile(join(bin, "curl"), CURL_STUB, { mode: 0o755 });
    await writeFile(log, "");

    const child = spawn("bash", [SCRIPTS[script]], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: join(dir, "home"),
        STUB_LOG: log,
        CLI_VERSION: cliVersion,
        RELEASE_TAG: releaseTag,
        BREW_LIST_RC: installed ? "0" : "1",
        ...(upgradeOk ? { UPGRADE_OK: "1" } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // The Finder script ends on `read -n 1`; give it the keypress it waits for.
    child.stdin.end("x");
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const code = await new Promise((resolve) => child.on("close", resolve));
    return { code, out, calls: await readFile(log, "utf8") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

for (const script of Object.keys(SCRIPTS)) {
  test(`#535 ${script}: a failed brew upgrade does not end in the success banner`, async () => {
    const { code, out } = await runInstaller(script);
    assert.notEqual(code, 0, `expected a non-zero exit, got ${code}\n${out}`);
    assert.ok(!out.includes("✓ Done."), `success banner printed anyway:\n${out}`);
    assert.match(out, /Update incomplete/);
    // The version the user is actually left on has to be named.
    assert.match(out, /0\.9\.2/);
  });

  test(`#535 ${script}: a failed upgrade does not re-register against the version that never landed`, async () => {
    const { calls, out } = await runInstaller(script);
    assert.ok(
      !/^bastra install/m.test(calls),
      `setup was re-run after a failed upgrade:\n${calls}\n---\n${out}`,
    );
  });

  test(`#535 ${script}: an upgrade that really lands on the requested version finishes green`, async () => {
    // The version the installer asks for AND the version the CLI reports
    // afterwards. The old shape of this test left the CLI on 0.9.2 and still
    // expected the success banner, which is the bug rather than the fix.
    const { code, out } = await runInstaller(script, {
      upgradeOk: true,
      cliVersion: "1.0.0",
      releaseTag: "v1.0.0",
    });
    assert.equal(code, 0, `expected exit 0, got ${code}\n${out}`);
    assert.ok(out.includes("✓ Done."), `success banner missing:\n${out}`);
  });

  test(`#535 ${script}: a no-op upgrade that leaves the CLI on the old version is not a success`, async () => {
    // `brew outdated` empty (stale tap / already-current keg), `brew upgrade`
    // exit 0, CLI still on 0.9.2 — the shape that used to skip the version
    // check entirely and print ✓ Done.
    const { code, out, calls } = await runInstaller(script, {
      upgradeOk: true,
      cliVersion: "0.9.2",
      releaseTag: "v1.0.0",
    });
    assert.notEqual(code, 0, `a no-op upgrade reported success:\n${out}`);
    assert.ok(!out.includes("✓ Done."), `success banner printed anyway:\n${out}`);
    assert.match(out, /1\.0\.0/);
    assert.match(out, /0\.9\.2/);
    assert.ok(
      !/^bastra install/m.test(calls),
      `setup was re-run against a version that never landed:\n${calls}`,
    );
  });

  test(`#535 ${script}: a fresh install that lands on an old version is not a success either`, async () => {
    // Nothing installed yet, so the upgrade branch never runs — a stale tap
    // installs 0.9.2 and `brew install` exits 0 just the same.
    const { code, out } = await runInstaller(script, {
      installed: false,
      cliVersion: "0.9.2",
      releaseTag: "v1.0.0",
    });
    assert.notEqual(code, 0, `a stale fresh install reported success:\n${out}`);
    assert.ok(!out.includes("✓ Done."), `success banner printed anyway:\n${out}`);
    assert.match(out, /Install incomplete/);
  });

  test(`#535 ${script}: an unknown requested version is not treated as "nothing to check"`, async () => {
    const { code, out } = await runInstaller(script, {
      upgradeOk: true,
      cliVersion: "0.9.2",
      releaseTag: "",
    });
    assert.notEqual(code, 0, `an unverifiable run reported success:\n${out}`);
    assert.ok(!out.includes("✓ Done."), `success banner printed anyway:\n${out}`);
    assert.match(out, /could not determine which version/);
  });
}
