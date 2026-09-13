/**
 * #457 — der Kontext-Ledger zählt ALLES, was Recall ins Transkript schreibt,
 * und erfindet für alte Zeilen keine Nullen.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/context-ledger.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import {
  buildContextLedger,
  HOOK_LANE_KINDS,
  TOOL_PAYLOAD_KINDS,
  type LedgerEvent,
} from "../src/context-ledger.js";
import { loadMemoryHandler, recallHandler, type ToolDeps } from "../src/tool-handlers.js";
import { Telemetry } from "../src/telemetry.js";

const sid = "cc-session-1";

test("#457: a fixture session reconciles part by part to the session total", () => {
  const events: LedgerEvent[] = [
    { kind: "session_hook_call", session_id: sid, hint_tokens_est: 2300 },
    { kind: "prompt_hook_call", session_id: sid, hint_tokens_est: 480 },
    { kind: "recall", caller_session: sid, payload_tokens_est: 610, presentation: "lean" },
    { kind: "load_memory", caller_session: sid, found: true, delivered_tokens_est: 300, presentation: "lean" },
    { kind: "load_memory", caller_session: sid, found: true, delivered_tokens_est: 900, presentation: "full" },
    { kind: "read_document", caller_session: sid, found: true, delivered_tokens_est: 4000 },
    // Nicht gefunden = nichts geliefert = kein Posten.
    { kind: "load_memory", caller_session: sid, found: false },
    // Fremde Ereignisarten zählen nicht.
    { kind: "hook_recall", session_id: sid, hint_tokens_est: 99999 },
  ];
  const ledger = buildContextLedger(events);
  const s = ledger.sessions.get(sid)!;
  assert.equal(s.lanes.session_hook_call.tokens, 2300);
  assert.equal(s.lanes.prompt_hook_call.tokens, 480);
  assert.equal(s.tools.recall.tokens, 610);
  assert.equal(s.tools.load_memory.tokens, 1200);
  assert.equal(s.loadByPresentation.lean.tokens, 300);
  assert.equal(s.loadByPresentation.full.tokens, 900);
  assert.equal(s.tools.read_document.tokens, 4000);
  assert.equal(s.totalTokens, 2300 + 480 + 610 + 1200 + 4000);
  assert.equal(s.totalUnknown, 0);
  assert.equal(ledger.total.totalTokens, s.totalTokens);
  assert.equal(s.tools.load_memory.emissions, 2, "the not-found load is no emission");
});

test("#457: Prompt, Todo and Bash-fail tokens cannot fall out of the complete numerator", () => {
  // Die drei Lanes, die der historische ROI-Numerator ausließ.
  for (const kind of ["prompt_hook_call", "todo_hook_call", "bash_fail_hook_call"] as const) {
    assert.ok((HOOK_LANE_KINDS as readonly string[]).includes(kind), `${kind} is a ledger lane`);
    const ledger = buildContextLedger([{ kind, session_id: sid, hint_tokens_est: 123 }]);
    assert.equal(ledger.total.totalTokens, 123, `${kind} tokens reach the total`);
  }
  // Und jede Lane, die ein Ereignis mit hint_tokens_est schreibt, steht in der Liste.
  assert.deepEqual(
    [...HOOK_LANE_KINDS].sort(),
    ["bash_fail_hook_call", "bash_hook_call", "hook_call", "prompt_hook_call", "session_hook_call", "todo_hook_call"],
  );
  assert.deepEqual([...TOOL_PAYLOAD_KINDS].sort(), ["load_memory", "read_document", "recall"]);
});

test("#457: old rows without a size field are unknown, never a free load", () => {
  const ledger = buildContextLedger([
    { kind: "load_memory", session_id: "boot", found: true }, // pre-#457 row
    { kind: "recall", session_id: "boot", hit_count: 5 }, // pre-#457 row
    { kind: "hook_call", session_id: sid }, // pre-#72 row
    { kind: "load_memory", caller_session: sid, found: true, delivered_tokens_est: 250, presentation: "lean" },
  ]);
  assert.equal(ledger.total.totalTokens, 250);
  assert.equal(ledger.total.totalUnknown, 3);
  assert.equal(ledger.total.tools.load_memory.unknown, 1);
  assert.equal(ledger.total.tools.recall.unknown, 1);
  assert.equal(ledger.total.lanes.hook_call.unknown, 1);
});

// ─── delivered size is measured after the projection ───────────────────────

function memoryWithRelated(id: string): string {
  return [
    "---",
    `id: ${id}`,
    `title: ${id} title`,
    "type: lesson",
    `summary: ${id} summary`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: ledger-test",
    "recall_when:",
    `  - ${id} title`,
    "related_via:",
    "  - { id: other-1, cosine: 0.91 }",
    "  - { id: other-2, cosine: 0.88 }",
    "source: manual",
    "confidence: 0.9",
    "created: 2026-07-01",
    "updated: 2026-07-01",
    "---",
    "",
    `Body of ${id}. `.repeat(20),
    "",
    "<!-- bastra:auto-related:start -->",
    "## Related (auto)",
    "",
    "- other-1 (0.91)",
    "- other-2 (0.88)",
    "<!-- bastra:auto-related:end -->",
    "",
  ].join("\n");
}

test("#457: load_memory records the size it delivered after the lean/full projection, not the vault file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-ledger-"));
  await writeFile(join(dir, "m-1.md"), memoryWithRelated("m-1"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const logged: Record<string, unknown>[] = [];
  (telemetry as unknown as { logLoadMemory: (p: Record<string, unknown>) => Promise<void> }).logLoadMemory =
    async (p) => {
      logged.push(p);
    };
  const deps: ToolDeps = { vault, search, telemetry, vaultPath: dir };
  try {
    const lean = await loadMemoryHandler(deps, { id: "m-1" });
    const full = await loadMemoryHandler(deps, { id: "m-1", verbosity: "full" });
    assert.equal(logged.length, 2);
    const [l, f] = logged;
    assert.equal(l.presentation, "lean");
    assert.equal(f.presentation, "full");
    assert.equal(l.delivered_chars, JSON.stringify(lean, null, 2).length);
    assert.equal(f.delivered_chars, JSON.stringify(full, null, 2).length);
    assert.equal(l.body_chars, lean.body.length);
    assert.ok((l.body_chars as number) < (f.body_chars as number), "lean strips the auto-related block");
    assert.ok((l.delivered_chars as number) < (f.delivered_chars as number), "lean payload is smaller than full");
    assert.equal(l.delivered_tokens_est, Math.ceil((l.delivered_chars as number) / 4));
    assert.equal(l.origin, "direct");
    assert.equal(l.found, true);
    await assert.rejects(loadMemoryHandler(deps, { id: "nope" }), /memory not found/);
    assert.equal(logged[2].found, false);
    assert.equal(logged[2].delivered_chars, undefined, "nothing delivered, nothing sized");
  } finally {
    search.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("#457: recall records the serialized payload it returned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-ledger-recall-"));
  await writeFile(join(dir, "m-1.md"), memoryWithRelated("m-1"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const logged: Record<string, unknown>[] = [];
  (telemetry as unknown as { logRecall: (p: Record<string, unknown>) => Promise<void> }).logRecall = async (p) => {
    logged.push(p);
  };
  const deps: ToolDeps = { vault, search, telemetry, vaultPath: dir };
  try {
    const result = await recallHandler(deps, { query: "m-1 title", k: 3 });
    assert.equal(logged.length, 1);
    assert.equal(logged[0].payload_chars, JSON.stringify(result, null, 2).length);
    assert.equal(logged[0].payload_tokens_est, Math.ceil(JSON.stringify(result, null, 2).length / 4));
    assert.equal(logged[0].presentation, "lean");
  } finally {
    search.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true });
  }
});
