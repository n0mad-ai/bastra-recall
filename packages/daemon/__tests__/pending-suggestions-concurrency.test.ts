/**
 * #532 — concurrent stop-hook suggestions silently collapsed to one pending
 * candidate. `writePendingSuggestion` was an unlocked read-modify-write on one
 * shared JSON file: overlapping Stop-hook and curator writes all read the same
 * snapshot and the last rename won. Measured on the broken code, 40 unique
 * concurrent writes left exactly ONE entry — a loss INSIDE the documented
 * five-entry cap — and every call returned normally, so nothing said so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePendingSuggestion, consumePendingSuggestions } from "../src/pending-suggestions.js";

/** Captures the module's own stderr notices, passing everything else through. */
function captureDiagnostics(): { lines: string[]; restore: () => void } {
  const real = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (text.includes("pending suggestions:")) {
      lines.push(text);
      return true;
    }
    return (real as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  return { lines, restore: () => void (process.stderr.write = real) };
}

test("#532 — concurrent writes keep the durable set up to the cap, and losses are not silent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-pending-532-"));
  const path = join(dir, "pending.json");
  const prev = process.env.BASTRA_PENDING_SUGGESTIONS_PATH;
  process.env.BASTRA_PENDING_SUGGESTIONS_PATH = path;
  const diag = captureDiagnostics();
  try {
    const attempted = Array.from({ length: 40 }, (_, i) => `<save-eval>concurrent #${i}</save-eval>`);
    await Promise.all(attempted.map((blocks) => writePendingSuggestion(blocks)));
    diag.restore();

    const persisted = JSON.parse(await readFile(path, "utf8")) as { blocks: string }[];
    // The cap is enforced against the DURABLE state, not an in-memory snapshot:
    // 40 attempts must leave the full five, not one arbitrary winner.
    assert.equal(persisted.length, 5, `40 concurrent writes must persist the full cap, got ${persisted.length}`);
    const bodies = persisted.map((e) => e.blocks);
    assert.equal(new Set(bodies).size, 5, "the persisted entries must be five DIFFERENT suggestions");
    for (const body of bodies) {
      assert.ok(attempted.includes(body), `persisted an entry nobody wrote: ${body}`);
    }
    // Entries that fall off the cap are a durable loss — bounded, but visible.
    assert.ok(diag.lines.length > 0, "dropping entries at the cap must emit a diagnostic, not happen in silence");
    assert.ok(diag.lines.length <= 5, `the diagnostics must stay bounded, got ${diag.lines.length} lines`);
  } finally {
    diag.restore();
    if (prev === undefined) delete process.env.BASTRA_PENDING_SUGGESTIONS_PATH;
    else process.env.BASTRA_PENDING_SUGGESTIONS_PATH = prev;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/**
 * The write/consume half: a session start must not unlink a set a writer
 * published between the consumer's read and its unlink. Consumed plus leftover
 * must account for every suggestion written.
 */
test("#532 — a concurrent consume destroys no suggestion it did not read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-pending-532-consume-"));
  const path = join(dir, "pending.json");
  const prev = process.env.BASTRA_PENDING_SUGGESTIONS_PATH;
  process.env.BASTRA_PENDING_SUGGESTIONS_PATH = path;
  try {
    // Four writers, well inside the cap, with a consume interleaved: nothing
    // may be dropped for capacity reasons, so anything missing was destroyed.
    const attempted = Array.from({ length: 4 }, (_, i) => `<save-eval>overlap #${i}</save-eval>`);
    const outcome = await Promise.all([
      writePendingSuggestion(attempted[0]),
      writePendingSuggestion(attempted[1]),
      consumePendingSuggestions(),
      writePendingSuggestion(attempted[2]),
      writePendingSuggestion(attempted[3]),
    ]);
    const consumed = outcome[2];
    const leftover = await consumePendingSuggestions();
    const seen = new Set([...consumed, ...leftover].map((e) => e.blocks));
    assert.deepEqual(
      attempted.filter((b) => !seen.has(b)),
      [],
      "every written suggestion must be either consumed or still pending — none may vanish",
    );
  } finally {
    if (prev === undefined) delete process.env.BASTRA_PENDING_SUGGESTIONS_PATH;
    else process.env.BASTRA_PENDING_SUGGESTIONS_PATH = prev;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
