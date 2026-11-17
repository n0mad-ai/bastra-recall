/**
 * #1460 — the character budget of the pre-tool lanes, and the draft quote
 * counting inside a lane's budget (prompt and pre-tool alike).
 *
 * Runner: npm test (scripts/test-env.mjs isolates HOME and the logs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fitOptional, PRE_TOOL_CONTEXT_CHAR_BUDGET } from "../src/pretool-budget.js";
import { runTodoLane } from "../src/todo-lane.js";
import { appendLaneDrafts } from "../src/draft-search.js";
import { captureDrafts, draftFingerprint, draftId, type Draft } from "../src/draft-store.js";

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("fitOptional keeps sections in order while they fit and skips the ones that do not", () => {
  const { kept, dropped } = fitOptional(90, ["aaaa", "bbbbbbbbbbbbbbbbbbbb", "cc"], (s) => s.length, 100);
  // 90 + 5 = 95; 95 + 21 > 100 → skipped; 95 + 3 = 98
  assert.deepEqual(kept, ["aaaa", "cc"]);
  assert.equal(dropped, 1);
});

const TODOS = {
  todos: [
    { content: "Migrate the auth middleware to the new session store", status: "pending" },
    { content: "Write regression tests for the session store migration", status: "pending" },
    { content: "Update the deployment notes for the session store", status: "pending" },
  ],
};

async function withRecall(hits: unknown[], fn: (base: string) => Promise<void>): Promise<void> {
  const body = JSON.stringify({ hits, vault_size: hits.length, latency_ms: 1, recall_id: "r1", score_kind: "rrf" });
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(path === "/hook/recall" ? body : "{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("#1460: the plan lane drops its lowest-ranked hits until the block fits the pre-tool budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-pretool-budget-"));
  // Five hits, each ~1,000 characters once rendered: 5,000 > 4,000.
  const hits = [1, 2, 3, 4, 5].map((n) => ({
    id: `hit-${n}-${"x".repeat(760)}`,
    title: `Fact ${n}`,
    type: "project-fact",
    scope: "all-projects",
    summary: "s".repeat(220),
    score: 160 - n,
  }));
  try {
    await withRecall(hits, async (base) => {
      const out = await withEnv(
        { BASTRA_TELEMETRY: "off", BASTRA_LOG_PATH: dir, BASTRA_HOOK_STATE_DIR: dir, BASTRA_SESSION_STATE_DIR: dir },
        () =>
          runTodoLane(
            {
              hook_event_name: "PreToolUse",
              tool_name: "TodoWrite",
              session_id: "budget-1460",
              cwd: "/tmp",
              tool_input: TODOS,
            },
            base
          )
      );
      const context = (JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
        ?.additionalContext;
      assert.ok(context, "the lane still emits");
      assert.ok(context.length <= PRE_TOOL_CONTEXT_CHAR_BUDGET, `${context.length} <= ${PRE_TOOL_CONTEXT_CHAR_BUDGET}`);
      assert.match(context, /hit-1-/, "the best hit stays");
      assert.doesNotMatch(context, /hit-5-/, "the lowest-ranked hit leaves");
      assert.ok(context.endsWith("</recall-hints>"), "the frame is never cut");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function draft(quote: string): Draft {
  const fp = draftFingerprint(quote);
  return {
    id: draftId("origin-0", 0, fp),
    fp,
    quote,
    kind: "typed",
    evidence: [{ session_id: "origin-0", turn: 0, ts: Date.now() }],
    created: Date.now(),
    last_touched: Date.now(),
    state: "open",
    surfaced: [],
    situation: { before: [], after: [], reads: [], lits: [] },
  };
}

test("#1460: a draft quote that would cross the lane's budget stays out and unclaimed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-pretool-drafts-"));
  try {
    await withEnv(
      {
        BASTRA_DRAFTS_PATH: join(dir, "drafts.json"),
        BASTRA_HOOK_STATE_DIR: join(dir, "sessions"),
        BASTRA_DRAFT_HINTS: "1",
        BASTRA_TELEMETRY: "0",
      },
      async () => {
        await captureDrafts([draft("The spectrometer calibration uses tungsten lamps")]);
        const full = JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "n".repeat(3950) },
        });
        assert.equal(
          await appendLaneDrafts(
            full,
            "PreToolUse",
            "spectrometer calibration",
            "s-1460",
            [],
            1,
            false,
            undefined,
            Date.now() + 5000,
            4000
          ),
          full,
          "no room left: the lane output is unchanged"
        );
        // Not claimed by the refusal: the same session still gets it where it fits.
        const roomy = await appendLaneDrafts(
          "{}",
          "PreToolUse",
          "spectrometer calibration",
          "s-1460",
          [],
          1,
          false,
          undefined,
          Date.now() + 5000,
          4000
        );
        assert.match(roomy, /<draft-hints>/);
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
