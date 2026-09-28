/**
 * A pin that the 1200-char budget truncates out of <pinned-memories> must stay
 * eligible for a ranked hint slot. Runs the whole lane against a stub daemon,
 * so it bites on the wiring in session-lane.ts, not on formatPinnedBlock alone.
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/session-lane-pinned-overflow.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { runSessionLane } from "../src/session-lane.js";

const floor = (id: string) => ({
  memory_id: id,
  title: `Pinned ${id}`,
  reason: "x".repeat(190),
  floored_at: "2026-07-01T10:00:00.000Z",
  last_affirmed: "2026-07-01T10:00:00.000Z",
});

// Eight long pins overflow the budget; the last one is also the only ranked hit.
const PINS = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p-overflow"].map(floor);

const RECALL_RESP = {
  hits: [
    {
      id: "p-overflow",
      title: "Overflow ranked hit",
      type: "reference",
      scope: "user-preference",
      summary: "ranked copy of the pin that did not fit",
      score: 150,
      rrf: { rank_bm25: 1, rank_vector: 1, personal_score: 0.03, raw: 0.03 },
    },
  ],
  vault_size: 1,
  latency_ms: 1,
  recall_id: "r1",
  score_kind: "rrf",
};

const SESSION_CONTEXT = JSON.stringify({
  context: "",
  vault_size: 1,
  blocks: [],
  retrieval: "hybrid",
  budget: {},
  aborted: [],
  data: {
    recalls: [{ scope: "user-preference", resp: RECALL_RESP }],
    floors: PINS,
    conventions: [],
    care: { open: 0, queued: 0 },
    imports: { open: 0, queued: 0 },
    onboarding: false,
  },
});

test("a pin truncated out of the pinned block still gets its ranked hint slot", async () => {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(path === "/hook/session-context" ? SESSION_CONTEXT : path === "/health" ? '{"ok":true}' : "{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const out = await runSessionLane(
      { hook_event_name: "SessionStart", source: "startup", cwd: "/tmp", session_id: "s-overflow" },
      `http://127.0.0.1:${port}`,
    );
    const ctx = (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
      .additionalContext;
    const pinnedBlock = ctx.slice(ctx.indexOf("<pinned-memories"), ctx.indexOf("</pinned-memories>"));
    assert.match(pinnedBlock, /\[p1\]/, "the first pin is rendered");
    assert.doesNotMatch(pinnedBlock, /\[p-overflow\]/, "precondition: the last pin did not fit the budget");
    assert.match(pinnedBlock, /not shown|truncat|exceeds/i, "the block says it truncated");
    const rest = ctx.slice(ctx.indexOf("</pinned-memories>"));
    assert.match(rest, /- p-overflow \(/, "the truncated-out pin competes for a ranked slot");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
