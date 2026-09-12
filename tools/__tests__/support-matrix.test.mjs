/**
 * #525 — the support matrix and its copies must state the same thing.
 *
 * Every assertion here is anchored on code, not on another piece of prose: the
 * client set comes from the CLI's own `SURFACES`, the platform set from the
 * `STUB_TARGETS` the release workflow builds. README.md is the matrix; the
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
  const en = README.slice(README.indexOf("### Supported surfaces"), README.indexOf("### Why"));
  const de = README.slice(
    README.indexOf("### Unterstützte Oberflächen"),
    README.indexOf("### Warum"),
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

test("the platform matrix matches the hook-client targets that are built", () => {
  const targets = hookClientTargets();
  assert.deepEqual(targets.sort(), [
    "aarch64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-apple-darwin",
    "x86_64-unknown-linux-gnu",
  ]);
  const section = README.slice(README.indexOf("### Supported platforms"));
  const table = section.slice(0, section.indexOf("###", 5) === -1 ? undefined : section.indexOf("###", 5));
  // Both macOS architectures and both Linux architectures are built, so the
  // matrix may not present either platform as single-architecture.
  assert.match(table, /Apple Silicon and Intel/);
  assert.match(table, /x86_64 and arm64/);
  // Nothing is built for Windows, so it must not be presented as supported.
  assert.match(table, /\*\*Windows\*\*[^|]*\|[^|]*not covered/);

  const npmReadme = readRepoFile("packages/bastra-recall/README.md");
  assert.doesNotMatch(
    npmReadme,
    /macOS \(Apple Silicon\) today/,
    "the npm README still states an Apple-Silicon-only requirement",
  );
  assert.match(npmReadme, /Linux/, "the npm README does not state the Linux boundary");
});
