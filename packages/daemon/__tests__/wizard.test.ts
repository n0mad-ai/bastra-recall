/**
 * Tests for the guided-install wizard's pure parts: the gate that decides
 * wizard vs. classic path, the surface-choice builder (detection →
 * preselection), the custom-vault path expansion, and the default-vault
 * option's wording over an existing vault (#318). The interactive clack
 * flow itself is exercised by the expect-based smoke, not here (no TTY on CI).
 *
 * Run: npx tsx --test packages/daemon/__tests__/wizard.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  shouldRunWizard,
  buildSurfaceChoices,
  defaultVaultOption,
  detectSurfaces,
  expandUserPath,
  decideWizardSemantic,
  memoryCountPhrase,
} from "../src/cli/wizard.js";
import { cmdInstall } from "../src/cli/commands.js";
import { createVaultAt, probeVaultPresence } from "../src/cli/helpers.js";
import type { ParsedArgs } from "../src/cli/types.js";

// ─── gate ────────────────────────────────────────────────────────────────────

test("wizard gate: bare install on a TTY → wizard", () => {
  assert.equal(shouldRunWizard({ surface: null, interactive: true, yes: false, dryRun: false }), true);
});

test("wizard gate: every scripted invocation stays on the classic path", () => {
  // named surface / all
  assert.equal(shouldRunWizard({ surface: "all", interactive: true, yes: false, dryRun: false }), false);
  assert.equal(shouldRunWizard({ surface: "claude-code", interactive: true, yes: false, dryRun: false }), false);
  // non-TTY (CI, pipes, hooks) — must keep the deterministic "missing surface" error
  assert.equal(shouldRunWizard({ surface: null, interactive: false, yes: false, dryRun: false }), false);
  // automation flags
  assert.equal(shouldRunWizard({ surface: null, interactive: true, yes: true, dryRun: false }), false);
  assert.equal(shouldRunWizard({ surface: null, interactive: true, yes: false, dryRun: true }), false);
});

// ─── surface choices ─────────────────────────────────────────────────────────

test("surface choices: detected clients are preselected and hinted", () => {
  const { options, initialValues } = buildSurfaceChoices({
    "claude-code": true,
    "claude-desktop": false,
    codex: false,
    cursor: true,
  });
  assert.deepEqual(options.map((o) => o.value), ["claude-desktop", "claude-code", "codex", "cursor"]);
  assert.deepEqual(new Set(initialValues), new Set(["claude-code", "cursor"]));
  assert.equal(options.find((o) => o.value === "claude-code")?.hint, "detected");
  assert.equal(options.find((o) => o.value === "claude-desktop")?.hint, "not detected");
});

test("surface choices: nothing detected → everything preselected (plain Enter = full install)", () => {
  const { options, initialValues } = buildSurfaceChoices({});
  assert.deepEqual(initialValues, options.map((o) => o.value));
});

test("surface choices: labels drop the parenthetical detail", () => {
  const { options } = buildSurfaceChoices({});
  for (const o of options) assert.ok(!o.label.includes("("), `label still has parens: ${o.label}`);
});

// ─── detection ───────────────────────────────────────────────────────────────

test("detectSurfaces: home-relative traces are found in the given home", async () => {
  // Only home-relative traces are assertable: absolute ones (/Applications/…)
  // depend on the machine running the tests.
  const home = await mkdtemp(join(tmpdir(), "bastra-wizard-home-"));
  try {
    assert.equal(detectSurfaces(home)["claude-code"], false);
    await writeFile(join(home, ".claude.json"), "{}", "utf8");
    await mkdir(join(home, ".codex"));
    assert.equal(detectSurfaces(home)["claude-code"], true);
    assert.equal(detectSurfaces(home).codex, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ─── semantic step decision ──────────────────────────────────────────────────

test("wizard semantic: --ollama = consent, never asks (flag beats everything)", () => {
  assert.equal(decideWizardSemantic({ ollamaFlag: "auto", effectiveProvider: "none", daemonSemanticOn: false }), "on");
  assert.equal(decideWizardSemantic({ ollamaFlag: "auto", effectiveProvider: "ollama", daemonSemanticOn: false }), "on");
});

test("wizard semantic: effective provider or semantic daemon → nothing to ask", () => {
  assert.equal(decideWizardSemantic({ ollamaFlag: null, effectiveProvider: "ollama", daemonSemanticOn: false }), "already");
  assert.equal(decideWizardSemantic({ ollamaFlag: null, effectiveProvider: "none", daemonSemanticOn: true }), "already");
  // --no-ollama with an effective provider: skips provisioning, disables nothing
  assert.equal(decideWizardSemantic({ ollamaFlag: "skip", effectiveProvider: "openai", daemonSemanticOn: false }), "already");
});

test("wizard semantic: --no-ollama = opt-out, never asks (review find 2026-07-03)", () => {
  assert.equal(decideWizardSemantic({ ollamaFlag: "skip", effectiveProvider: "none", daemonSemanticOn: false }), "later");
});

test("wizard semantic: no flag, nothing effective → ask", () => {
  assert.equal(decideWizardSemantic({ ollamaFlag: null, effectiveProvider: "none", daemonSemanticOn: false }), "ask");
});

// ─── install --help gate ─────────────────────────────────────────────────────

test("install --help documents instead of acting (wizard or missing-surface error)", async () => {
  const args: ParsedArgs = {
    command: "install", surface: null, dryRun: false, vaultPath: null,
    showHelp: true, showVersion: false, json: false, quiet: false, yes: false,
    fix: false, withStopHook: false, staged: false, ollama: null, positional: ["install"],
  };
  const origWrite = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    const rc = await cmdInstall(args);
    assert.equal(rc, 0);
    assert.match(out, /Usage:/);
  } finally {
    process.stdout.write = origWrite;
  }
});

// ─── path expansion ──────────────────────────────────────────────────────────

test("expandUserPath: tilde, relative, and absolute inputs", () => {
  assert.equal(expandUserPath("~", "/Users/x"), "/Users/x");
  assert.equal(expandUserPath("~/Vault", "/Users/x"), "/Users/x/Vault");
  assert.equal(expandUserPath("  ~/Vault  ", "/Users/x"), "/Users/x/Vault");
  assert.equal(expandUserPath("/abs/path", "/Users/x"), "/abs/path");
  assert.equal(expandUserPath("rel/path", "/Users/x"), resolve("rel/path"));
});

// ─── existing vault at the default location (#318) ───────────────────────────
// "Create ~/BastraVault" was offered over a folder holding 74 memories. The
// prompt has to look before it makes a claim about the folder.

function memoryMarkdown(id: string): string {
  return [
    "---",
    `id: ${id}`,
    `title: ${id}`,
    "type: lesson",
    `summary: summary for ${id}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: all-projects",
    "recall_when:",
    "  - writing a test",
    "---",
    "",
    `Body for ${id}.`,
    "",
  ].join("\n");
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-wizard-vault-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("default vault option: absent or empty folder is really created — 'Create' stays", () => {
  assert.deepEqual(defaultVaultOption({ exists: false, memoryCount: 0 }, "~/BastraVault"), {
    label: "Create ~/BastraVault",
    hint: "recommended",
  });
  assert.deepEqual(defaultVaultOption({ exists: true, memoryCount: 0 }, "~/BastraVault"), {
    label: "Create ~/BastraVault",
    hint: "recommended",
  });
});

test("default vault option: memories already there → 'Use', with the count", () => {
  // clack renders `label (hint)`, so this reads as the issue asked for it:
  //   Use ~/BastraVault (74 memories already there)
  assert.deepEqual(defaultVaultOption({ exists: true, memoryCount: 74 }, "~/BastraVault"), {
    label: "Use ~/BastraVault",
    hint: "74 memories already there",
  });
});

test("default vault option: never says 'Create' about a folder that holds memories", () => {
  const opt = defaultVaultOption({ exists: true, memoryCount: 1 }, "~/BastraVault");
  assert.ok(!opt.label.startsWith("Create"), `still offers to create it: ${opt.label}`);
  assert.equal(opt.hint, "1 memory already there");
});

test("memoryCountPhrase: singular is not '1 memories'", () => {
  assert.equal(memoryCountPhrase(0), "0 memories");
  assert.equal(memoryCountPhrase(1), "1 memory");
  assert.equal(memoryCountPhrase(74), "74 memories");
});

test("probeVaultPresence: a missing folder is absent and empty", async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(await probeVaultPresence(join(dir, "no-such-vault")), { exists: false, memoryCount: 0 });
  });
});

test("probeVaultPresence: a freshly created vault exists but holds no memories", async () => {
  await withTempDir(async (dir) => {
    const vault = join(dir, "BastraVault");
    await createVaultAt(vault);
    // The README createVaultAt writes carries no `type:` — it must not count as
    // a memory, or a first install would offer "Use … (1 memory already there)".
    assert.deepEqual(await probeVaultPresence(vault), { exists: true, memoryCount: 0 });
    assert.equal(defaultVaultOption(await probeVaultPresence(vault), "~/BastraVault").label, "Create ~/BastraVault");
  });
});

test("probeVaultPresence: counts what the daemon indexes — memories, not plain notes", async () => {
  await withTempDir(async (dir) => {
    const vault = join(dir, "BastraVault");
    await createVaultAt(vault);
    await writeFile(join(vault, "a.md"), memoryMarkdown("alpha"), "utf8");
    await mkdir(join(vault, "lessons"), { recursive: true });
    await writeFile(join(vault, "lessons", "b.md"), memoryMarkdown("beta"), "utf8");
    // A plain Obsidian note living in the same folder, and an import-review file
    // — the shapes the #318 report had next to its 74 memories.
    await writeFile(join(vault, "import-review.md"), "# Import review\n\n- candidate\n", "utf8");

    const presence = await probeVaultPresence(vault);
    assert.deepEqual(presence, { exists: true, memoryCount: 2 });
    const opt = defaultVaultOption(presence, "~/BastraVault");
    assert.equal(opt.label, "Use ~/BastraVault");
    assert.equal(opt.hint, "2 memories already there");
  });
});
