/**
 * #537 — `--no-stub` decides which hook client gets registered, even when the
 * compiled binary is already on disk.
 *
 * The defect: `decideStubAction()` answered "present" before it ever looked at
 * `mode === "skip"`, and every adapter then probed `existsSync(HOOK_STUB_BIN)`
 * for itself. Measured on an isolated profile with the binary in place,
 * `bastra install all --yes --no-stub` printed "compiled hook client present"
 * and wrote all eight Claude Code hook commands, the statusLine and all seven
 * Codex hook commands onto that binary — the documented opt-out could not be
 * taken once the download had happened, and no marker was written either, so
 * the next unattended update repeated it.
 *
 * Precedence pinned here: the explicit flag beats the remembered choice, which
 * beats mere artifact presence. Selection and retention stay separate concerns
 * — `--no-stub` keeps the downloaded file, it just stops registering it.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/hook-client-selection.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decideStubAction, ensureHookStub, readStubOptIn } from "../src/cli/stub-install.js";
import { planHookEntries, statuslineCommand } from "../src/cli/adapters/claude-code.js";
import { planCodexHooks } from "../src/cli/adapters/codex.js";
import { HOOK_STUB_BIN } from "../src/cli/paths.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ─── the precedence rule ─────────────────────────────────────────────────────

test("#537 — an explicit flag beats the remembered choice, which beats a present binary", () => {
  const base = {
    present: true,
    mode: "ask" as const,
    ephemeral: false,
    manifest: true,
    target: true,
    dryRun: false,
    remembered: null as boolean | null,
    interactive: false,
  };
  // 1. the explicit flag
  assert.equal(decideStubAction({ ...base, mode: "skip" }), "skip", "--no-stub over a present binary");
  assert.equal(decideStubAction({ ...base, mode: "skip", remembered: true }), "skip", "--no-stub over a remembered yes");
  assert.equal(decideStubAction({ ...base, mode: "yes", remembered: false }), "present", "--stub reverses a remembered no");
  // 2. the remembered choice
  assert.equal(decideStubAction({ ...base, remembered: false }), "declined", "a remembered no over a present binary");
  assert.equal(decideStubAction({ ...base, remembered: true }), "present");
  // 3. only then, presence
  assert.equal(decideStubAction(base), "present");
  assert.equal(decideStubAction({ ...base, present: false }), "non-interactive");
});

// ─── the step hands down one answer ──────────────────────────────────────────

/** A HOME-less fixture: a file standing in for the downloaded binary, plus a
 *  marker path, so nothing here touches the real package or the real HOME. */
function fixture(remembered?: boolean): { stubBin: string; markerPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "bastra-537-"));
  const stubBin = join(dir, "bastra-hook");
  writeFileSync(stubBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const markerPath = join(dir, "hook-stub.json");
  if (remembered !== undefined) {
    writeFileSync(markerPath, `${JSON.stringify({ optIn: remembered, decidedAt: "2026-01-01T00:00:00Z" })}\n`);
  }
  return { stubBin, markerPath };
}

const CASES: Array<{ mode: "yes" | "skip" | "ask"; remembered?: boolean; useStub: boolean; marker?: boolean }> = [
  { mode: "skip", useStub: false, marker: false },
  { mode: "skip", remembered: true, useStub: false, marker: false },
  { mode: "yes", useStub: true, marker: true },
  { mode: "yes", remembered: false, useStub: true, marker: true },
  { mode: "ask", remembered: false, useStub: false, marker: false },
  { mode: "ask", remembered: true, useStub: true },
];

for (const c of CASES) {
  const label = `mode=${c.mode} remembered=${c.remembered ?? "never asked"}`;
  test(`#537 — ensureHookStub selects the node client deterministically (${label})`, async () => {
    const { stubBin, markerPath } = fixture(c.remembered);
    const r = await ensureHookStub({ dryRun: false, mode: c.mode, interactive: false, stubBin, markerPath });
    assert.equal(r.useStub, c.useStub, `${label}: ${r.detail}`);
    if (c.marker !== undefined) {
      assert.equal(await readStubOptIn(markerPath), c.marker, `${label}: the choice must be remembered for updates`);
    }
  });
}

test("#537 — --no-stub keeps the downloaded binary; selection and retention are different concerns", async () => {
  const { stubBin, markerPath } = fixture();
  await ensureHookStub({ dryRun: false, mode: "skip", interactive: false, stubBin, markerPath });
  assert.equal(await readFile(stubBin, "utf8"), "#!/bin/sh\nexit 0\n", "the binary was deleted");
});

// ─── every generated hook command, per adapter ───────────────────────────────

function claudeCommands(useStub: boolean): string[] {
  const plan = planHookEntries("install", {}, { includeStop: true, stubPresent: useStub });
  return Object.values(plan.after).flatMap((entries) =>
    entries.flatMap((e) => ((e as { hooks?: unknown[] }).hooks ?? []).map((h) => (h as { command?: string }).command ?? "")),
  );
}

function codexCommands(useStub: boolean): string[] {
  const plan = planCodexHooks("install", {}, { includeStop: true, stubPresent: useStub });
  return Object.values(plan.after).flatMap((entries) =>
    entries.flatMap((e) => ((e as { hooks?: unknown[] }).hooks ?? []).map((h) => (h as { command?: string }).command ?? "")),
  );
}

test("#537 — with the client deselected, every Claude Code command runs on node", () => {
  const cmds = claudeCommands(false);
  assert.equal(cmds.length, 8);
  for (const cmd of cmds) {
    assert.ok(cmd.startsWith("node "), `not on the node client: ${cmd}`);
    assert.ok(!cmd.includes(HOOK_STUB_BIN), `still points at the compiled binary: ${cmd}`);
  }
  assert.equal(
    statuslineCommand("/pkg/statusline/dist/index.mjs", false),
    "node /pkg/statusline/dist/index.mjs --style=powerline",
    "the statusLine is part of the same choice",
  );
});

test("#537 — with the client selected, every Claude Code command runs on the binary", () => {
  const cmds = claudeCommands(true);
  assert.equal(cmds.length, 8);
  for (const cmd of cmds) assert.ok(cmd.startsWith(`${HOOK_STUB_BIN} `), `not on the compiled client: ${cmd}`);
  assert.equal(
    statuslineCommand("/pkg/statusline/dist/index.mjs", true),
    `${HOOK_STUB_BIN} statusline --style=powerline`,
  );
});

test("#537 — with the client deselected, every Codex command runs on node", () => {
  const cmds = codexCommands(false);
  assert.equal(cmds.length, 7);
  for (const cmd of cmds) {
    assert.ok(cmd.startsWith("BASTRA_HOOK_CLIENT=codex node "), `not on the node client: ${cmd}`);
    assert.ok(!cmd.includes(HOOK_STUB_BIN), `still points at the compiled binary: ${cmd}`);
  }
});

test("#537 — with the client selected, every Codex command runs on the binary", () => {
  const cmds = codexCommands(true);
  assert.equal(cmds.length, 7);
  for (const cmd of cmds) assert.ok(cmd.includes(HOOK_STUB_BIN), `not on the compiled client: ${cmd}`);
});

// ─── the seam stays connected ────────────────────────────────────────────────

/**
 * The planners above always honoured `stubPresent`; the bug was that nobody
 * passed it, so each adapter fell back to its own disk probe. This gate pins
 * the wiring — one source read per file, no fixture can stand in for it.
 */
test("#537 — the selection reaches both hook adapters instead of each probing the disk", async () => {
  const read = (rel: string) => readFile(join(HERE, "..", "src", "cli", rel), "utf8");
  const commands = await read("commands.ts");
  assert.match(commands, /opts\.useStub = stub\.useStub/, "cmdInstall does not hand the selection to the adapters");
  const wizard = await read("wizard.ts");
  assert.match(wizard, /useStub/, "the guided setup does not hand the selection to the adapters");
  for (const adapter of ["adapters/claude-code.ts", "adapters/codex.ts"]) {
    assert.match(await read(adapter), /stubPresent: opts\.useStub/, `${adapter} re-derives the hook client`);
  }
});

/** Keeps the fixture honest: the marker is a file, and a missing one is "never
 *  asked" rather than a remembered no. */
test("#537 — an unwritten marker reads as 'never asked', not as an opt-out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bastra-537-marker-"));
  assert.equal(await readStubOptIn(join(dir, "absent.json")), null);
  await writeFile(join(dir, "present.json"), `${JSON.stringify({ optIn: false, decidedAt: "x" })}\n`);
  assert.equal(await readStubOptIn(join(dir, "present.json")), false);
});
