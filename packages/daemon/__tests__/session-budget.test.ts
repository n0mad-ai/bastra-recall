/**
 * #458 (shadow) — das kumulative Sitzungsbudget über alle Lanes: rechnet
 * zusammen, entscheidet wie der Governor, kürzt nichts, und der Reset-Vertrag
 * (clear ja, compact/resume nein) hält.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/session-budget.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_BUDGET_SHADOW_TOKENS,
  SessionBudgetLedger,
  recordBudgetShadow,
  resetBudgetOnSource,
  shadowBudgetTokens,
} from "../src/session-budget.js";
import { fitsBudget, governContext } from "../src/context-governor.js";
import { HOOK_LANE_KINDS } from "../src/context-ledger.js";

test("#458: emissions across all six lanes accumulate into one session total, and the block that no longer fits is the one flagged", () => {
  const ledger = new SessionBudgetLedger();
  const budget = 1000;
  const sid = "s1";
  const d1 = ledger.charge(sid, "session_hook_call", 600, budget, "startup")!;
  const d2 = ledger.charge(sid, "prompt_hook_call", 300, budget)!;
  const d3 = ledger.charge(sid, "hook_call", 200, budget)!; // 900 + 200 > 1000
  const d4 = ledger.charge(sid, "bash_hook_call", 50, budget)!; // schon überzogen
  assert.equal(d1.would_drop, false);
  assert.equal(d2.would_drop, false);
  assert.deepEqual([d2.spent_before, d2.spent_after, d2.remaining_before], [600, 900, 400]);
  assert.equal(d3.would_drop, true, "the third block exceeds the remaining 100 tokens");
  assert.equal(d3.first_over, true);
  assert.equal(d3.emission_index, 3);
  // Nichts wird gekürzt: die Emission zählt trotzdem — sie fand statt.
  assert.equal(d3.spent_after, 1100);
  assert.equal(d4.would_drop, true);
  assert.equal(d4.first_over, false, "only the first crossing is marked");
  assert.equal(d4.remaining_before, -100);
  assert.equal(ledger.spent(sid), 1150);
  // Andere Sitzung, eigenes Ledger.
  assert.equal(ledger.charge("s2", "todo_hook_call", 900, budget)!.would_drop, false);
});

test("#458: the shadow decision is the governor's rule — same fitsBudget, whole block falls, 0 = unlimited", () => {
  assert.equal(fitsBudget(900, 200, 1000), false);
  assert.equal(fitsBudget(800, 200, 1000), true, "exactly full still fits");
  assert.equal(fitsBudget(999999, 1, 0), true, "0 is unlimited");
  // Derselbe Fall durch governContext: ein Eintrag von 200 Token gegen 100 Rest fällt ganz.
  const g = governContext([{ id: "x", priority: 0, text: "a".repeat(800) }], { tokens: 100 });
  assert.deepEqual(g.dropped, [{ id: "x", reason: "token_budget" }]);
  const ledger = new SessionBudgetLedger();
  assert.equal(ledger.charge("s", "hook_call", 5000, 0)!.would_drop, false, "unlimited only counts");
  assert.equal(ledger.charge("s", "hook_call", 5000, 0)!.remaining_before, Number.POSITIVE_INFINITY);
});

test("#458: zero-token emissions decide nothing, and a missing session id has no ledger", () => {
  const ledger = new SessionBudgetLedger();
  assert.equal(ledger.charge("s", "hook_call", 0, 100), null);
  assert.equal(ledger.spent("s"), 0);
  assert.equal(recordBudgetShadow(null, "hook_call", 500, { ledger, budget: 100 }), null);
  assert.equal(recordBudgetShadow("", "hook_call", 500, { ledger, budget: 100 }), null);
  assert.equal(ledger.size(), 0);
});

test("#458 §1: clear starts a new context, compact and resume keep the ledger", () => {
  const ledger = new SessionBudgetLedger();
  ledger.charge("s", "session_hook_call", 700, 1000);
  resetBudgetOnSource("s", "compact", ledger);
  assert.equal(ledger.spent("s"), 700, "compact must not silently reset — the injected text survives compaction");
  resetBudgetOnSource("s", "resume", ledger);
  assert.equal(ledger.spent("s"), 700);
  resetBudgetOnSource("s", "clear", ledger);
  assert.equal(ledger.spent("s"), 0);
  assert.equal(ledger.charge("s", "session_hook_call", 700, 1000)!.would_drop, false);
});

test("#458: the ledger is bounded — the oldest session falls first", () => {
  const ledger = new SessionBudgetLedger(2);
  ledger.charge("a", "hook_call", 1, 0);
  ledger.charge("b", "hook_call", 1, 0);
  ledger.charge("c", "hook_call", 1, 0);
  assert.equal(ledger.size(), 2);
  assert.equal(ledger.spent("a"), 0, "a was evicted");
  assert.equal(ledger.spent("c"), 1);
});

test("#458: every ledger lane is a valid budget lane and the default budget reads from the env", () => {
  const ledger = new SessionBudgetLedger();
  for (const lane of HOOK_LANE_KINDS) assert.ok(ledger.charge("s", lane, 1, 0));
  assert.equal(shadowBudgetTokens({}), SESSION_BUDGET_SHADOW_TOKENS);
  assert.equal(shadowBudgetTokens({ BASTRA_SESSION_BUDGET_SHADOW: "10000" }), 10000);
  assert.equal(shadowBudgetTokens({ BASTRA_SESSION_BUDGET_SHADOW: "0" }), 0);
  assert.equal(shadowBudgetTokens({ BASTRA_SESSION_BUDGET_SHADOW: "nope" }), SESSION_BUDGET_SHADOW_TOKENS);
});

test("#458: recordBudgetShadow writes a budget_shadow event that reconciles with the lane's hint_tokens_est", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-budget-shadow-"));
  const prev = process.env.BASTRA_LOG_PATH;
  process.env.BASTRA_LOG_PATH = logDir;
  try {
    const ledger = new SessionBudgetLedger();
    const d = recordBudgetShadow("sess", "prompt_hook_call", 480, { ledger, budget: 400, source: null })!;
    assert.equal(d.would_drop, true);
    // Der Schreibvorgang ist fire-and-forget — kurz warten.
    await new Promise((r) => setTimeout(r, 50));
    const day = new Date().toISOString().slice(0, 10);
    const lines = (await readFile(join(logDir, `events-${day}.jsonl`), "utf8")).trim().split("\n");
    const ev = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    assert.equal(ev.kind, "budget_shadow");
    assert.equal(ev.lane, "prompt_hook_call");
    assert.equal(ev.tokens, 480);
    assert.equal(ev.budget, 400);
    assert.equal(ev.would_drop, true);
    assert.equal(ev.remaining_before, 400);
    assert.equal(ev.session_id, "sess");
  } finally {
    if (prev === undefined) delete process.env.BASTRA_LOG_PATH;
    else process.env.BASTRA_LOG_PATH = prev;
    await rm(logDir, { recursive: true, force: true });
  }
});
