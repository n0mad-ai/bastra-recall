/**
 * Tests für das #48-Redesign: Stop-Hook-Vorschläge laufen über die stille
 * Pending-Datei (statt systemMessage-Chat-Spam), und system-injizierte
 * Transcript-Turns (Skill-Body!) triggern die Heuristiken nicht mehr.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writePendingSuggestion,
  consumePendingSuggestions,
  PENDING_MAX_AGE_MS,
} from "../src/pending-suggestions.js";
import { normalizeTurns, evaluateHeuristics } from "../src/stop-lane.js";

test("pending-suggestions (#48): write → consume-once round-trip, stale entries dropped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-pending-"));
  const prev = process.env.BASTRA_PENDING_SUGGESTIONS_PATH;
  process.env.BASTRA_PENDING_SUGGESTIONS_PATH = join(dir, "pending.json");
  try {
    await writePendingSuggestion("<save-eval>block one</save-eval>");
    await writePendingSuggestion("<save-eval>block two</save-eval>");

    const consumed = await consumePendingSuggestions();
    assert.equal(consumed.length, 2);
    assert.match(consumed[0].blocks, /block one/);
    assert.match(consumed[1].blocks, /block two/);

    // consume-once: die Datei ist weg, zweiter Aufruf liefert nichts.
    assert.deepEqual(await consumePendingSuggestions(), []);

    // Same body written twice is one entry, not a stack the next session
    // consumes five times. Refresh the timestamp so the row stays fresh.
    await writePendingSuggestion("<save-eval>same</save-eval>");
    await writePendingSuggestion("<save-eval>same</save-eval>");
    const deduped = await consumePendingSuggestions();
    assert.equal(deduped.length, 1);
    assert.match(deduped[0].blocks, /same/);

    // Staleness: ein Eintrag älter als das Fenster wird verworfen.
    await writePendingSuggestion("<save-eval>old</save-eval>");
    const later = Date.now() + PENDING_MAX_AGE_MS + 60_000;
    assert.deepEqual(await consumePendingSuggestions(later), []);
  } finally {
    if (prev === undefined) delete process.env.BASTRA_PENDING_SUGGESTIONS_PATH;
    else process.env.BASTRA_PENDING_SUGGESTIONS_PATH = prev;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("stop-hook (#48): injected skill body in role=user does not feed the heuristics", () => {
  // Der bastra-Skill dokumentiert die Frust-Trigger selbst — als role=user
  // injiziert. Vor dem Fix triggerte das frustration-density jede Session.
  const skillBody =
    "Base directory for this skill: /Users/x/.claude/skills/bastra-recall\n" +
    "wieder schon wieder wie oft WIEDER SCHON WIEDER frustration CAPS " +
    "wieder schon wieder wie oft immer nie kaputt nervt";
  const turns = normalizeTurns([
    { role: "user", content: skillBody },
    { role: "user", content: "<system-reminder>wieder schon wieder wie oft kaputt nervt immer nie</system-reminder>" },
  ]);
  assert.ok(
    turns.every((t) => t.role !== "user"),
    `injected turns must not keep role=user, got: ${turns.map((t) => t.role).join(",")}`,
  );
  const suggestions = evaluateHeuristics(turns, { cwd: "/tmp" });
  assert.deepEqual(suggestions, [], "no heuristic may fire on injected system content");
});
