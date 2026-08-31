/**
 * #48 vs #304 on the Claude Code Stop hook: a Stop hook the user opted into
 * survives an `install` / `bastra update` that does not register one — but it
 * has to survive pointing at the CURRENT bin. Verified in a VM on 0.8.8 → 0.8.9:
 * six of seven hooks moved to the new runtime, Stop alone kept
 * ~/.bastra/runtime/0.8.8/…/stop-hook.js, which pruneOldRuntimes then deletes.
 *
 * planHookEntries is the pure half of patchClaudeCodeHooks, so none of this
 * touches the real ~/.claude/settings.json.
 *
 * Every case here pins `stubPresent: false`: since #369 the Stop lane also has
 * a stub subcommand, so the registered form depends on whether the compiled
 * binary exists on the host running the test. The stub form is asserted at the
 * bottom, and in hook-stub-lanes.test.ts.
 *
 * Run: npx tsx --test packages/daemon/__tests__/stop-hook-path-refresh.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { planHookEntries } from "../src/cli/adapters/claude-code.js";
import { STOP_HOOK_BIN, HOOK_STUB_BIN } from "../src/cli/paths.js";

const OLD_RUNTIME_STOP_BIN =
  "/Users/tester/.bastra/runtime/0.8.8/node_modules/@bastra-recall/daemon/dist/stop-hook.js";

/** A Stop entry as `bastra install --with-stop-hook` wrote it under 0.8.8. */
function ourStopEntry(bin: string): Record<string, unknown> {
  return {
    hooks: [{
      type: "command",
      command: `node ${bin}`,
      timeout: 3,
      __bastraRecall: true,
      __note: "bastra-recall Stop hook (optional autonomous save-eval, #35)",
    }],
  };
}

/** Some other tool's Stop hook — never ours, never to be touched. */
function foreignStopEntry(): Record<string, unknown> {
  return { hooks: [{ type: "command", command: "node /opt/other-tool/stop.js", timeout: 5 }] };
}

function commandsOf(entries: unknown[]): string[] {
  return entries.flatMap((e) => {
    const hooks = (e as { hooks?: unknown[] }).hooks ?? [];
    return hooks.map((h) => (h as { command?: string }).command ?? "");
  });
}

/** Mirrors the adapter's own before/after comparison. */
function changed(plan: { before: Record<string, unknown[]>; after: Record<string, unknown[]> }, ev: string): boolean {
  return JSON.stringify(plan.before[ev]) !== JSON.stringify(plan.after[ev]);
}

// ─── the verified regression ─────────────────────────────────────────────────

test("stop hook: a preserved entry is re-pointed at the current bin (#48 keeps the opt-in, not the path)", () => {
  const plan = planHookEntries("install", { Stop: [ourStopEntry(OLD_RUNTIME_STOP_BIN)] }, { includeStop: false, stubPresent: false });

  assert.equal(plan.stopPreserved, true, "the opt-in decision must survive");
  assert.equal(plan.after.Stop.length, 1, "still exactly one Stop entry — kept, not duplicated");
  assert.deepEqual(commandsOf(plan.after.Stop), [`node ${STOP_HOOK_BIN}`]);
  assert.ok(
    !JSON.stringify(plan.after.Stop).includes("0.8.8"),
    "no trace of the old runtime version may remain",
  );
});

test("stop hook: a stale path is a real change — it must not pass as already-installed", () => {
  const plan = planHookEntries("install", { Stop: [ourStopEntry(OLD_RUNTIME_STOP_BIN)] }, { includeStop: false, stubPresent: false });
  assert.equal(changed(plan, "Stop"), true);
});

test("stop hook: an entry already at the current bin stays byte-identical (no churn on every install)", () => {
  // Build the reference entry the way the adapter writes it, then round-trip it
  // through JSON like settings.json does.
  const fresh = planHookEntries("install", {}, { includeStop: true, stubPresent: false }).after.Stop;
  const settings = JSON.parse(JSON.stringify({ Stop: fresh })) as Record<string, unknown[]>;

  const plan = planHookEntries("install", settings, { includeStop: false, stubPresent: false });
  assert.equal(plan.stopPreserved, true);
  assert.equal(changed(plan, "Stop"), false, "unchanged path → still already-installed");
});

// ─── foreign entries ─────────────────────────────────────────────────────────

test("stop hook: a foreign Stop hook is never removed and never rewritten", () => {
  const foreign = foreignStopEntry();
  const plan = planHookEntries("install", { Stop: [foreign, ourStopEntry(OLD_RUNTIME_STOP_BIN)] }, { includeStop: false, stubPresent: false });

  assert.equal(plan.after.Stop.length, 2);
  assert.equal(
    JSON.stringify(plan.after.Stop[0]),
    JSON.stringify(foreign),
    "the foreign entry passes through verbatim, in place",
  );
  assert.deepEqual(commandsOf([plan.after.Stop[1]]), [`node ${STOP_HOOK_BIN}`]);
});

test("stop hook: foreign-only Stop → nothing added, nothing changed", () => {
  const plan = planHookEntries("install", { Stop: [foreignStopEntry()] }, { includeStop: false, stubPresent: false });
  assert.equal(plan.stopPreserved, false, "a foreign hook is not our opt-in");
  assert.equal(changed(plan, "Stop"), false);
});

test("stop hook: no Stop entry at all → an opted-out run still adds none (#48 default-off on update)", () => {
  const plan = planHookEntries("install", {}, { includeStop: false, stubPresent: false });
  assert.equal(plan.stopPreserved, false);
  assert.deepEqual(plan.after.Stop, []);
});

// ─── the neighbouring paths this must not disturb ────────────────────────────

test("stop hook: the stable-runtime mapping reaches the preserved entry too (#180)", () => {
  const mapBin = (bin: string) => `/Users/tester/.bastra/runtime/0.8.9/node_modules/@bastra-recall/daemon/dist/${bin.split("/").pop()}`;
  const plan = planHookEntries("install", { Stop: [ourStopEntry(OLD_RUNTIME_STOP_BIN)] }, { includeStop: false, mapBin, stubPresent: false });

  assert.deepEqual(commandsOf(plan.after.Stop), [
    "node /Users/tester/.bastra/runtime/0.8.9/node_modules/@bastra-recall/daemon/dist/stop-hook.js",
  ]);
});

test("stop hook: --with-stop-hook replaces a stale entry and keeps the foreign one", () => {
  const foreign = foreignStopEntry();
  const plan = planHookEntries("install", { Stop: [foreign, ourStopEntry(OLD_RUNTIME_STOP_BIN)] }, { includeStop: true, stubPresent: false });

  assert.deepEqual(commandsOf(plan.after.Stop), [
    "node /opt/other-tool/stop.js",
    `node ${STOP_HOOK_BIN}`,
  ]);
});

test("stop hook: uninstall still strips ours and keeps the foreign one", () => {
  const foreign = foreignStopEntry();
  const plan = planHookEntries("uninstall", { Stop: [foreign, ourStopEntry(OLD_RUNTIME_STOP_BIN)] }, { includeStop: false, stubPresent: false });

  assert.equal(plan.after.Stop.length, 1);
  assert.equal(JSON.stringify(plan.after.Stop[0]), JSON.stringify(foreign));
});

// ─── the same plan on a host that HAS the compiled stub (#369) ───────────────

test("stop hook: with the stub present the preserved entry moves to the stub lane", () => {
  const plan = planHookEntries(
    "install",
    { Stop: [ourStopEntry(OLD_RUNTIME_STOP_BIN)] },
    { includeStop: false, stubPresent: true },
  );

  assert.equal(plan.stopPreserved, true, "the opt-in decision must survive the client swap");
  assert.deepEqual(commandsOf(plan.after.Stop), [`${HOOK_STUB_BIN} stop`]);
});

test("stop hook: the stable-runtime mapping does not touch the stub path (#180 maps bins, not the binary)", () => {
  const mapBin = (bin: string) => `/Users/tester/.bastra/runtime/0.8.9/node_modules/@bastra-recall/daemon/dist/${bin.split("/").pop()}`;
  const plan = planHookEntries("install", {}, { includeStop: true, mapBin, stubPresent: true });
  assert.deepEqual(commandsOf(plan.after.Stop), [`${HOOK_STUB_BIN} stop`]);
});
