/**
 * #525 — the support matrix and its copies must state the same thing.
 *
 * Every assertion here is anchored on code, not on another piece of prose: the
 * client set comes from the CLI's own `SURFACES`, the platform set from the
 * `STUB_TARGETS` configured in the release workflow. Target configuration
 * does not establish successful artifact production or platform acceptance.
 * README.md is the matrix; the
 * Homebrew caveat, the npm package README and the two published package
 * descriptions are copies, and a copy that drifts fails here.
 *
 * Offline and filesystem-only, so it runs identically on the Linux CI runner.
 * The LIVE tap formula is a different repository and needs the network — that
 * comparison is `tools/check-tap-drift.mjs`, run by its own CI workflow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  installableSurfaces,
  hookClientTargets,
  formulaCaveatClients,
  readRepoFile,
  SURFACE_LABELS,
} from "../support-matrix.mjs";

const README = readRepoFile("README.md");

test("the CLI's surface list is the four clients the matrix names", () => {
  assert.deepEqual(installableSurfaces().sort(), [
    "claude-code",
    "claude-desktop",
    "codex",
    "cursor",
  ]);
});

test("README names every installable client in both language matrices", () => {
  // Match whole heading lines: "### Why not just CLAUDE.md?" also starts with "### Why".
  const en = README.slice(README.indexOf("### Supported surfaces"), README.indexOf("\n### Why\n"));
  const de = README.slice(
    README.indexOf("### Unterstützte Oberflächen"),
    README.indexOf("\n### Warum\n"),
  );
  assert.ok(en.length > 0 && de.length > 0, "both matrix sections must exist");
  for (const surface of installableSurfaces()) {
    const label = SURFACE_LABELS[surface];
    assert.ok(label, `no prose label registered for '${surface}'`);
    // "Codex/ChatGPT Desktop" is written "Codex + ChatGPT Desktop" in the
    // table; compare on the distinguishing word.
    const needle = label.split(/[/ +]/)[0];
    assert.match(en, new RegExp(needle), `EN matrix does not name ${label}`);
    assert.match(de, new RegExp(needle), `DE matrix does not name ${label}`);
  }
});

test("the Homebrew caveat lists exactly the installable clients", () => {
  const clients = formulaCaveatClients();
  assert.ok(clients, "the caveat's client list could not be parsed");
  assert.deepEqual(
    clients,
    installableSurfaces().map((s) => SURFACE_LABELS[s]).sort((a, b) => {
      const order = ["Claude Code", "Claude Desktop", "Codex/ChatGPT Desktop", "Cursor"];
      return order.indexOf(a) - order.indexOf(b);
    }),
  );
});

test("the Homebrew caveat's on-demand sentence names the same clients", () => {
  const formula = readRepoFile("distribution/homebrew/bastra-recall.rb");
  const sentence = formula.match(/That is all([\s\S]*?)need\./);
  assert.ok(sentence, "the on-demand sentence is gone — update this test with it");
  for (const surface of installableSurfaces()) {
    const needle = SURFACE_LABELS[surface].split(/[/ +]/)[0];
    assert.match(sentence[1], new RegExp(needle), `the caveat forgets ${needle}`);
  }
});

test("the published package descriptions do not contradict the matrix", () => {
  const installer = JSON.parse(readRepoFile("packages/bastra-recall/package.json"));
  for (const surface of installableSurfaces()) {
    const needle = SURFACE_LABELS[surface].split(/[/ +]/)[0];
    assert.match(
      installer.description,
      new RegExp(needle),
      `the bastra-recall package description forgets ${needle}`,
    );
  }
  const daemon = JSON.parse(readRepoFile("packages/daemon/package.json"));
  // #525: it described itself as exposing recall + load_memory only, long
  // after the save, edit and document tools shipped.
  for (const tool of ["recall", "load_memory", "save_memory", "edit_memory"]) {
    assert.match(daemon.description, new RegExp(tool), `the daemon description omits ${tool}`);
  }
});

test("the platform matrix matches configured hook-client targets and their validation boundaries", () => {
  const targets = hookClientTargets();
  assert.deepEqual(targets.sort(), [
    "aarch64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
  ]);
  const workflow = readRepoFile(".github/workflows/publish-npm.yml");
  const configuredTargets = [...workflow.matchAll(/^\s+targets: (.+)$/gm)]
    .flatMap((m) => m[1].trim().split(/\s+/));
  assert.deepEqual(configuredTargets.sort(), targets, "installer and release target configuration drifted");
  const section = README.slice(README.indexOf("### Supported platforms"));
  const table = section.slice(0, section.indexOf("###", 5) === -1 ? undefined : section.indexOf("###", 5));
  // Both macOS architectures and both Linux architectures are built, so the
  // matrix may not present either platform as single-architecture.
  assert.match(table, /Apple Silicon and Intel/);
  assert.match(table, /x86_64 and arm64/);
  // Windows has build configuration, but artifact production and actual
  // execution remain unvalidated. The matrix must preserve that boundary.
  const windows = table.split("\n").find((row) => row.includes("**Windows**"));
  assert.ok(windows, "Windows configuration needs an explicit support boundary");
  assert.match(windows, /x64/);
  assert.match(windows, /Experimental preparation only/);
  assert.match(windows, /executable production and real Windows use not validated/);
  assert.match(windows, /#348/);
  const deWindows = README.split("\n").find((row) => row.includes("**Windows**") && row.includes("Experimentell"));
  assert.ok(deWindows, "DE matrix must state the experimental Windows boundary too");
  assert.match(deWindows, /echtem Windows noch nicht geprüft/);

  const npmReadme = readRepoFile("packages/bastra-recall/README.md");
  assert.doesNotMatch(
    npmReadme,
    /macOS \(Apple Silicon\) today/,
    "the npm README still states an Apple-Silicon-only requirement",
  );
  assert.match(npmReadme, /Linux/, "the npm README does not state the Linux boundary");
  assert.match(npmReadme, /Windows[^\n]+experimental preparation only/);
  assert.match(npmReadme, /executable production and real Windows use not validated/);
});
