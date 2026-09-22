/**
 * Tests for the turn-start embedding prewarm (#361).
 *
 * Two halves. The pure half drives `createEmbeddingPrewarmer` with an injected
 * clock — the debounce is a time decision, and a test that sleeps for 60s to
 * observe it is not a test. The lane half runs `runPromptLane` in-process
 * against a mock daemon (same shape as prompt-lane.test.ts) and proves the
 * property the whole feature rests on: the lane never waits for the warm call.
 * A warm that NEVER resolves must not delay the response by a millisecond,
 * because a prewarm that can stall the prompt lane is worse than a cold model.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createEmbeddingPrewarmer,
  PREWARM_DEBOUNCE_MS,
  type PrewarmOutcome,
} from "../src/embedding-prewarm.js";
import { runPromptLane } from "../src/prompt-lane.js";

// ─── pure: gate, debounce, error containment ─────────────────────────────

test("prewarm — fires once, then debounces inside the keep-alive window", () => {
  let nowMs = 1_000_000;
  let calls = 0;
  const prewarm = createEmbeddingPrewarmer({
    denseArmAvailable: () => true,
    warm: async () => {
      calls++;
    },
    now: () => nowMs,
  });

  assert.equal(prewarm(), "fired");
  assert.equal(calls, 1);

  // A second turn one second later: the model is still resident, warming it
  // again is pure noise.
  nowMs += 1_000;
  assert.equal(prewarm(), "skipped-debounce");
  nowMs += PREWARM_DEBOUNCE_MS - 1_001; // one ms short of the window
  assert.equal(prewarm(), "skipped-debounce");
  assert.equal(calls, 1, "no second provider call inside the window");

  // Window elapsed → the next turn start warms again.
  nowMs += 1;
  assert.equal(prewarm(), "fired");
  assert.equal(calls, 2);
});

test("prewarm — debounce stamps the ATTEMPT, not its result", async () => {
  // A cold warm takes ~860ms (#305). If the stamp waited for the promise, a
  // turn starting during that window would fire a second embed against a model
  // that is already loading.
  let nowMs = 0;
  let calls = 0;
  let release: (() => void) | null = null;
  const prewarm = createEmbeddingPrewarmer({
    denseArmAvailable: () => true,
    warm: () => {
      calls++;
      return new Promise<void>((ok) => {
        release = ok;
      });
    },
    now: () => nowMs,
  });

  assert.equal(prewarm(), "fired");
  nowMs += 900; // still inside the window, warm still in flight
  assert.equal(prewarm(), "skipped-debounce");
  assert.equal(calls, 1);
  // #542: `release` is only ever assigned inside the Promise executor above, a
  // separate control-flow container — TS's narrowing can't see that write, so
  // it treats the truthy branch as unreachable (`never`) without this cast.
  (release as (() => void) | null)?.();
});

test("prewarm — no dense arm: no provider call at all", () => {
  let calls = 0;
  let available = false;
  const prewarm = createEmbeddingPrewarmer({
    denseArmAvailable: () => available,
    warm: async () => {
      calls++;
    },
    now: () => 0,
  });

  // Embeddings off, or the breaker open (#165): warming would be exactly the
  // per-call cost against a wedged provider the breaker exists to avoid.
  assert.equal(prewarm(), "skipped-no-provider");
  assert.equal(calls, 0);

  // And a skip must not consume the debounce — the first real turn after the
  // breaker closes has to warm.
  available = true;
  assert.equal(prewarm(), "fired");
  assert.equal(calls, 1);
});

test("prewarm — a hosted provider is never warmed", () => {
  let calls = 0;
  let hosted = true;
  const prewarm = createEmbeddingPrewarmer({
    // Hosted wins over an otherwise perfectly available dense arm: there is no
    // cold model behind a hosted embedding API, only egress.
    hostedProvider: () => hosted,
    denseArmAvailable: () => true,
    warm: async () => {
      calls++;
    },
    now: () => 0,
  });

  assert.equal(prewarm(), "skipped-hosted");
  assert.equal(prewarm(), "skipped-hosted", "and it stays that way — not a debounce");
  assert.equal(calls, 0);

  // The skip must not have consumed the debounce either: switching to a local
  // provider (bastra embeddings ollama) warms on the very next turn.
  hosted = false;
  assert.equal(prewarm(), "fired");
  assert.equal(calls, 1);
});

test("prewarm — embeddings off outranks nothing: the no-provider skip stays distinct", () => {
  // rawProvider === null in index.ts → hostedProvider() is false, and the
  // absent dense arm is what answers. The two skips must not collapse into
  // one, or the before/after cannot tell a hosted host from a broken one.
  const prewarm = createEmbeddingPrewarmer({
    hostedProvider: () => false,
    denseArmAvailable: () => false,
    warm: async () => assert.fail("must not warm"),
    now: () => 0,
  });
  assert.equal(prewarm(), "skipped-no-provider");
});

test("prewarm — a failing warm call never escapes", async () => {
  const seen: unknown[] = [];
  const rejecting = createEmbeddingPrewarmer({
    denseArmAvailable: () => true,
    warm: () => Promise.reject(new Error("ollama down")),
    now: () => 0,
    onError: (err) => seen.push(err),
  });
  assert.equal(rejecting(), "fired");
  // The rejection is handled on the microtask queue, not synchronously.
  await new Promise((ok) => setImmediate(ok));
  assert.equal(seen.length, 1);

  // A provider that throws SYNCHRONOUSLY (bad URL at construction) must not
  // reach the lane either.
  const throwing = createEmbeddingPrewarmer({
    denseArmAvailable: () => true,
    warm: () => {
      throw new Error("bad base URL");
    },
    now: () => 0,
    onError: (err) => seen.push(err),
  });
  assert.equal(throwing(), "fired");
  assert.equal(seen.length, 2);
});

// ─── lane: fire-and-forget, and the telemetry field ──────────────────────

function startMockDaemon(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  return new Promise<{ port: number; close: () => Promise<void> }>((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      ok({
        port,
        close: () => new Promise<void>((done) => void server.close(() => done())),
      });
    });
  });
}

/** Recall + reflex answer empty — these tests are about the prewarm, not hits. */
function emptyDaemon() {
  return startMockDaemon((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/hook/reflex") {
      res.end('{"hits":[],"recall_id":null}');
      return;
    }
    res.end('{"hits":[],"vault_size":0,"latency_ms":1,"recall_id":"x"}');
  });
}

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The single `prompt_hook_call` event written into `logDir`. */
async function readPromptEvent(logDir: string): Promise<Record<string, unknown>> {
  const files = (await readdir(logDir)).filter((f) => f.startsWith("events-"));
  assert.equal(files.length, 1, "exactly one event file");
  const lines = (await readFile(join(logDir, files[0]), "utf8")).trim().split("\n");
  const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const prompt = events.filter((e) => e.kind === "prompt_hook_call");
  assert.equal(prompt.length, 1, "exactly one prompt_hook_call");
  return prompt[0];
}

test("lane — a warm call that never resolves does not delay the response", async () => {
  const daemon = await emptyDaemon();
  let warmSettled = false;
  const prewarm = createEmbeddingPrewarmer({
    denseArmAvailable: () => true,
    // Never resolves — a wedged Ollama holding the socket open. The lane must
    // not notice.
    warm: () =>
      new Promise<void>(() => {
        /* deliberately never settles */
      }).then(() => {
        warmSettled = true;
      }),
  });

  try {
    const stdout = await withEnv(
      { BASTRA_TELEMETRY: "off" },
      () =>
        runPromptLane(
          { hook_event_name: "UserPromptSubmit", prompt: "lass uns das implementieren", cwd: process.cwd() },
          null,
          `http://127.0.0.1:${daemon.port}`,
          prewarm,
        ),
    );
    assert.equal(stdout.trim(), "{}");
    assert.equal(warmSettled, false, "the lane returned while the warm call was still in flight");
  } finally {
    await daemon.close();
  }
});

test("lane — the outcome lands on prompt_hook_call, gated prompts included", async () => {
  const daemon = await emptyDaemon();
  const logDir = await mkdtemp(join(tmpdir(), "bastra-prewarm-log-"));
  const outcomes: PrewarmOutcome[] = [];
  // Real prewarmer, real debounce, injected clock: the first turn fires, the
  // second one lands inside the window.
  let nowMs = 5_000;
  const prewarm = createEmbeddingPrewarmer({
    denseArmAvailable: () => true,
    warm: async () => {},
    now: () => nowMs,
  });
  const traced = (): PrewarmOutcome => {
    const out = prewarm();
    outcomes.push(out);
    return out;
  };

  try {
    await withEnv({ BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: logDir }, async () => {
      // A slash command — the trivial gate (#151) returns early, but the turn
      // it starts still fills with tool calls, so it must still warm.
      const stdout = await runPromptLane(
        { hook_event_name: "UserPromptSubmit", prompt: "/review", cwd: process.cwd() },
        null,
        `http://127.0.0.1:${daemon.port}`,
        traced,
      );
      assert.equal(stdout.trim(), "{}");
    });
    const gatedEvent = await readPromptEvent(logDir);
    assert.equal(gatedEvent.status, "gated");
    assert.equal(gatedEvent.prewarm, "fired");
    assert.deepEqual(outcomes, ["fired"]);
  } finally {
    await rm(logDir, { recursive: true, force: true });
    await daemon.close();
  }

  // Second turn, seconds later, ordinary prompt: debounced, and the skip is
  // recorded — without it the before/after in #305 cannot tell "warm was
  // unnecessary" from "warm never ran".
  const daemon2 = await emptyDaemon();
  const logDir2 = await mkdtemp(join(tmpdir(), "bastra-prewarm-log2-"));
  try {
    nowMs += 3_000;
    await withEnv({ BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: logDir2 }, async () => {
      await runPromptLane(
        { hook_event_name: "UserPromptSubmit", prompt: "refactor the daemon please", cwd: process.cwd() },
        null,
        `http://127.0.0.1:${daemon2.port}`,
        traced,
      );
    });
    const event = await readPromptEvent(logDir2);
    assert.equal(event.prewarm, "skipped-debounce");
    assert.deepEqual(outcomes, ["fired", "skipped-debounce"]);
  } finally {
    await rm(logDir2, { recursive: true, force: true });
    await daemon2.close();
  }
});

test("lane — no prewarmer wired: the field stays absent, the lane is unchanged", async () => {
  const daemon = await emptyDaemon();
  const logDir = await mkdtemp(join(tmpdir(), "bastra-prewarm-log3-"));
  try {
    await withEnv({ BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: logDir }, async () => {
      const stdout = await runPromptLane(
        { hook_event_name: "UserPromptSubmit", prompt: "refactor the daemon please", cwd: process.cwd() },
        null,
        `http://127.0.0.1:${daemon.port}`,
      );
      assert.equal(stdout.trim(), "{}");
    });
    const event = await readPromptEvent(logDir);
    assert.ok(!("prewarm" in event), "no prewarmer injected → no field");
  } finally {
    await rm(logDir, { recursive: true, force: true });
    await daemon.close();
  }
});

test("lane — a non-UserPromptSubmit payload never warms", async () => {
  let calls = 0;
  const prewarm = createEmbeddingPrewarmer({
    denseArmAvailable: () => true,
    warm: async () => {
      calls++;
    },
  });
  const stdout = await runPromptLane(
    { hook_event_name: "PreToolUse", prompt: "such mal meinen Strafzettel" },
    null,
    "http://127.0.0.1:1",
    prewarm,
  );
  assert.equal(stdout.trim(), "{}");
  assert.equal(calls, 0, "no turn started — nothing to warm");
});
