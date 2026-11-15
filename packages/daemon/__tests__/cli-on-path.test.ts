/**
 * Tests for the `bastra`-command-after-npx logic (#317): the verdict that
 * decides whether the setup has to offer anything at all, the PATH check that
 * keeps a "successful" global install honest, and the wording of every outcome.
 *
 * `installCliGlobally` itself is not exercised — it runs `npm install -g`, and
 * a test that does that is a test that changes the machine it runs on. Every
 * decision it makes before and after the spawn is pure and covered here.
 *
 * Run: npx tsx --test packages/daemon/__tests__/cli-on-path.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { delimiter } from "node:path";

import {
  CLI_DECLINED_NOTE,
  CLI_PACKAGE,
  NPX_FALLBACK_HINT,
  binDirOnPath,
  decideCliOnPath,
  formatGlobalInstallOutcome,
} from "../src/cli/cli-on-path.js";

const NPX_CLI = "/Users/x/.npm/_npx/0123abcd/node_modules/@bastra-recall/daemon/dist/mcp-forwarder.js";
const NPX_BIN = "/Users/x/.npm/_npx/0123abcd/node_modules/.bin/bastra";
const GLOBAL_CLI = "/opt/homebrew/lib/node_modules/@bastra-recall/daemon/dist/mcp-forwarder.js";

// ─── decideCliOnPath ─────────────────────────────────────────────────────────

test("decideCliOnPath: a permanent install already has its bin — nothing to offer", () => {
  assert.equal(decideCliOnPath({ cliPath: GLOBAL_CLI, resolvedBastra: null }), "permanent");
  assert.equal(
    decideCliOnPath({
      cliPath: "/Users/x/Projekte/bastra-recall/packages/daemon/dist/mcp-forwarder.js",
      resolvedBastra: null,
    }),
    "permanent"
  );
});

test("decideCliOnPath: npx run with nothing on PATH → offer (the #317 case)", () => {
  assert.equal(decideCliOnPath({ cliPath: NPX_CLI, resolvedBastra: null }), "offer");
});

test("decideCliOnPath: the npx cache's own bin on PATH proves nothing — still offer", () => {
  // npx puts <cache>/node_modules/.bin on PATH for the child, so a name lookup
  // resolves right back to the process asking. That entry disappears with the
  // cache; treating it as "already installed" is exactly the #317 dead end.
  assert.equal(decideCliOnPath({ cliPath: NPX_CLI, resolvedBastra: NPX_BIN }), "offer");
});

test("decideCliOnPath: a permanent bastra on PATH → never install over it", () => {
  assert.equal(decideCliOnPath({ cliPath: NPX_CLI, resolvedBastra: "/opt/homebrew/bin/bastra" }), "already-on-path");
  assert.equal(decideCliOnPath({ cliPath: NPX_CLI, resolvedBastra: "/usr/local/bin/bastra" }), "already-on-path");
});

// ─── binDirOnPath ────────────────────────────────────────────────────────────

test("binDirOnPath: the bin's own directory counts, a sibling does not", () => {
  const path = ["/usr/bin", "/opt/homebrew/bin"].join(delimiter);
  assert.equal(binDirOnPath("/opt/homebrew/bin/bastra", path), true);
  assert.equal(binDirOnPath("/usr/bin/bastra", path), true);
  // A custom npm prefix nobody's shell searches — success that isn't one.
  assert.equal(binDirOnPath("/Users/x/.npm-global/bin/bastra", path), false);
});

test("binDirOnPath: trailing slashes and empty entries do not change the answer", () => {
  const path = ["/opt/homebrew/bin/", "", "/usr/bin"].join(delimiter);
  assert.equal(binDirOnPath("/opt/homebrew/bin/bastra", path), true);
  assert.equal(binDirOnPath("/opt/homebrew/bin/bastra", ""), false);
});

// ─── outcome wording ─────────────────────────────────────────────────────────
// The whole point of #317 is that a setup can report success and leave the user
// without a command. So only the verifiably-reachable case may read as success,
// and every other shape has to name a way to run something.

test("formatGlobalInstallOutcome: reachable bin is the only success", () => {
  const line = formatGlobalInstallOutcome({
    ok: true,
    binPath: "/opt/homebrew/bin/bastra",
    offPath: false,
    detail: "installed",
  });
  assert.equal(line.level, "success");
  assert.match(line.text, /\/opt\/homebrew\/bin\/bastra/);
  assert.match(line.text, /bastra doctor/);
});

test("formatGlobalInstallOutcome: installed off PATH is a warning that names the directory", () => {
  const line = formatGlobalInstallOutcome({
    ok: true,
    binPath: "/Users/x/.npm-global/bin/bastra",
    offPath: true,
    detail: "installed",
  });
  assert.equal(line.level, "warn");
  assert.match(line.text, /\/Users\/x\/\.npm-global\/bin(?!\/bastra)/, "names the directory to add to PATH");
  assert.ok(line.text.includes(NPX_FALLBACK_HINT), "still offers a way to run commands now");
});

test("formatGlobalInstallOutcome: npm said ok but the bin is unfindable → warn, not success", () => {
  const line = formatGlobalInstallOutcome({ ok: true, detail: "installed" });
  assert.equal(line.level, "warn");
  assert.ok(line.text.includes(NPX_FALLBACK_HINT));
});

test("formatGlobalInstallOutcome: a failure carries npm's reason and both ways forward", () => {
  const line = formatGlobalInstallOutcome({ ok: false, detail: "exit 243" });
  assert.equal(line.level, "warn");
  assert.match(line.text, /exit 243/);
  assert.ok(line.text.includes(NPX_FALLBACK_HINT));
  assert.match(line.text, new RegExp(`npm install -g ${CLI_PACKAGE}`));
});

test("declining still leaves a usable CLI — the note names npx and the global install", () => {
  assert.ok(CLI_DECLINED_NOTE.includes(NPX_FALLBACK_HINT));
  assert.match(CLI_DECLINED_NOTE, new RegExp(`npm install -g ${CLI_PACKAGE}`));
});

test("the npx fallback is a runnable command, not a description", () => {
  assert.match(NPX_FALLBACK_HINT, /^npx bastra-recall <command>/);
  assert.match(NPX_FALLBACK_HINT, /npx bastra-recall doctor/);
});
