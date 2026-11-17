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
  testedSurfaces,
  UNTESTED_SURFACES,
  hookClientTargets,
  formulaCaveatClients,
  readRepoFile,
  SURFACE_LABELS,
} from "../support-matrix.mjs";

const README = readRepoFile("README.md");

test("the CLI's surface list is the four installable clients", () => {
  assert.deepEqual(installableSurfaces().sort(), ["claude-code", "claude-desktop", "codex", "cursor"]);
});

test("README names exactly the tested installable clients in both language matrices", () => {
  // Match whole heading lines: "### Why not just CLAUDE.md?" also starts with "### Why".
  const en = README.slice(README.indexOf("### Supported surfaces"), README.indexOf("\n### Why\n"));
  const de = README.slice(README.indexOf("### Unterstützte Oberflächen"), README.indexOf("\n### Warum\n"));
  assert.ok(en.length > 0 && de.length > 0, "both matrix sections must exist");
  for (const surface of testedSurfaces()) {
    const label = SURFACE_LABELS[surface];
    assert.ok(label, `no prose label registered for '${surface}'`);
    // "Codex/ChatGPT Desktop" is written differently in the table; compare on
    // the distinguishing word.
    const needle = label.split(/[/ +]/)[0];
    assert.match(en, new RegExp(needle), `EN matrix does not name ${label}`);
    assert.match(de, new RegExp(needle), `DE matrix does not name ${label}`);
  }
  // Untested clients are not listed at all, not even with a status.
  for (const surface of UNTESTED_SURFACES) {
    assert.ok(installableSurfaces().includes(surface), `'${surface}' is no longer installable; drop it`);
    const pattern = new RegExp(SURFACE_LABELS[surface], "i");
    assert.doesNotMatch(en, pattern, `EN matrix still names untested ${surface}`);
    assert.doesNotMatch(de, pattern, `DE matrix still names untested ${surface}`);
  }
});

test("the Homebrew caveat lists exactly the installable clients", () => {
  const clients = formulaCaveatClients();
  assert.ok(clients, "the caveat's client list could not be parsed");
  assert.deepEqual(
    clients,
    installableSurfaces()
      .map((s) => SURFACE_LABELS[s])
      .sort((a, b) => {
        const order = ["Claude Code", "Claude Desktop", "Codex/ChatGPT Desktop", "Cursor"];
        return order.indexOf(a) - order.indexOf(b);
      })
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
  for (const surface of testedSurfaces()) {
    const needle = SURFACE_LABELS[surface].split(/[/ +]/)[0];
    assert.match(installer.description, new RegExp(needle), `the bastra-recall package description forgets ${needle}`);
  }
  for (const surface of UNTESTED_SURFACES) {
    assert.doesNotMatch(
      installer.description,
      new RegExp(SURFACE_LABELS[surface]),
      `the description names untested ${surface}`
    );
  }
  const daemon = JSON.parse(readRepoFile("packages/daemon/package.json"));
  // #525: it described itself as exposing recall + load_memory only, long
  // after the save, edit and document tools shipped.
  for (const tool of ["recall", "load_memory", "save_memory", "edit_memory"]) {
    assert.match(daemon.description, new RegExp(tool), `the daemon description omits ${tool}`);
  }
});

test("every statement of the Node.js floor names MIN_NODE_VERSION, and CI no longer tests Node 22", () => {
  const source = readRepoFile("packages/daemon/src/node-support.ts");
  const floor = source.match(/export const MIN_NODE_VERSION = "((\d+)\.(\d+)\.\d+)";/);
  assert.ok(floor, "MIN_NODE_VERSION is gone or no longer a plain x.y.z string");
  const [, full, major, minor] = floor;
  const engines = [
    "package.json",
    "packages/core/package.json",
    "packages/daemon/package.json",
    "packages/statusline/package.json",
    "packages/bastra-recall/package.json",
    "packages/eval/package.json",
  ];
  for (const file of engines) {
    assert.equal(JSON.parse(readRepoFile(file)).engines?.node, `>=${full}`, `${file} engines.node`);
  }
  const lock = JSON.parse(readRepoFile("package-lock.json"));
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "" || path.startsWith("packages/")) {
      assert.equal(entry.engines?.node, `>=${full}`, `package-lock.json "${path}" engines.node`);
    }
  }
  const mcpb = JSON.parse(readRepoFile("packages/daemon/mcpb/manifest.template.json"));
  assert.equal(mcpb.compatibility.runtimes.node, `>=${full}`, "the desktop extension's Node requirement");

  const shown = `${major}.${minor}`;
  assert.match(README, new RegExp(`with Node ${shown}–`), "EN README install line");
  assert.match(README, new RegExp(`mit Node ${shown}–`), "DE README install line");
  assert.match(readRepoFile("docs/INSTALL.md"), new RegExp(`Supported Node versions are ${shown}–`));
  assert.match(readRepoFile("packages/bastra-recall/README.md"), new RegExp(`Node ${shown} or newer`));

  const ci = readRepoFile(".github/workflows/ci.yml").match(/^\s+node: \[(.+)\]$/m);
  assert.ok(ci, "the CI Node matrix could not be read");
  const tested = ci[1].split(",").map((v) => Number(v.trim().replace(/'/g, "")));
  assert.ok(!tested.includes(22), "CI still tests Node 22");
  assert.ok(Math.min(...tested) >= Number(major), "CI tests a Node major below the floor");
  for (const workflow of ["publish-npm.yml", "formula-drift.yml"]) {
    for (const m of readRepoFile(`.github/workflows/${workflow}`).matchAll(/node-version: "?(\d+)/g)) {
      assert.ok(Number(m[1]) >= Number(major), `${workflow} runs Node ${m[1]}, below the floor`);
    }
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
  const configuredTargets = [...workflow.matchAll(/^\s+targets: (.+)$/gm)].flatMap((m) => m[1].trim().split(/\s+/));
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
    "the npm README still states an Apple-Silicon-only requirement"
  );
  assert.match(npmReadme, /Linux/, "the npm README does not state the Linux boundary");
  assert.match(npmReadme, /Windows[^\n]+experimental preparation only/);
  assert.match(npmReadme, /executable production and real Windows use not validated/);
});
