/**
 * #373 — the SessionStart lane's telemetry row, pinned like the other lanes'
 * (#356 series): `session_id` comes from the hook payload, a synthetic UUID is
 * the fallback only, `hook_version` is present, the event kind is right. #372
 * (both lanes stamping `randomUUID()`) sat unnoticed because no test read this
 * row at all.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/session-lane-telemetry.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSessionLane } from "../src/session-lane.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

async function readEvents(logDir: string): Promise<Record<string, unknown>[]> {
  const files = (await readdir(logDir)).filter((n) => n.startsWith("events-") && n.endsWith(".jsonl"));
  const out: Record<string, unknown>[] = [];
  for (const f of files) {
    for (const l of (await readFile(join(logDir, f), "utf8")).split("\n")) {
      if (l.trim()) out.push(JSON.parse(l) as Record<string, unknown>);
    }
  }
  return out;
}

const SESSION_CONTEXT = JSON.stringify({
  budget: {},
  aborted: [],
  data: {
    recalls: [
      {
        scope: "user-preference",
        resp: {
          hits: [{ id: "m1", title: "Session fact", type: "reference", scope: "user-preference", summary: "Ein Fakt.", score: 150 }],
          vault_size: 1,
          latency_ms: 1,
          recall_id: "r1",
          score_kind: "rrf",
        },
      },
    ],
    floors: [],
    conventions: [],
    care: { open: 0, queued: 0 },
    imports: { open: 0, queued: 0 },
    onboarding: false,
  },
});

async function withDaemon(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const bodies: Record<string, string> = {
    "/hook/session-context": SESSION_CONTEXT,
    "/health": JSON.stringify({ ok: true }),
    "/hook/hinted": "{}",
  };
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    req.on("data", () => {});
    req.on("end", () => {
      const body = bodies[path];
      res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
      res.end(body ?? "{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("#373: session_hook_call carries the payload session_id, hook_version and the per-part tokens", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-session-telemetry-"));
  try {
    await withDaemon(async (base) => {
      const out = await withEnv({ BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: logDir }, () =>
        runSessionLane({ hook_event_name: "SessionStart", source: "startup", cwd: "/tmp", session_id: "sess-373" }, base),
      );
      assert.doesNotThrow(() => JSON.parse(out));
    });
    const ev = (await readEvents(logDir)).find((e) => e.kind === "session_hook_call");
    assert.ok(ev, "a session_hook_call event must be written");
    assert.equal(ev.session_id, "sess-373", "the payload session, not a synthetic one (#372)");
    assert.equal(typeof ev.hook_version, "string");
    assert.equal(ev.source, "startup");
    assert.equal(ev.daemon_reachable, true);
    assert.equal(ev.hint_count, 1);
    assert.equal(typeof ev.hint_tokens_est, "number");
    assert.ok((ev.hint_tokens_est as number) > 0);
    const parts = ev.hint_tokens_by_part as Record<string, number>;
    assert.ok(parts && typeof parts === "object", "#462: per-part tokens ride on the row");
    assert.ok(parts.recalls > 0, "the hint list is the measured part here");
    assert.equal(parts.taxonomy, 0);
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
});

test("#373: without a payload session_id the row carries a synthetic UUID — fallback only", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-session-telemetry-uuid-"));
  try {
    await withDaemon(async (base) => {
      await withEnv({ BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: logDir }, () =>
        runSessionLane({ hook_event_name: "SessionStart", source: "resume", cwd: "/tmp" }, base),
      );
    });
    const ev = (await readEvents(logDir)).find((e) => e.kind === "session_hook_call");
    assert.ok(ev);
    assert.match(String(ev.session_id), UUID);
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
});

test("#373: an unreachable daemon still yields a row with the payload session and status daemon-unreachable", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-session-telemetry-down-"));
  try {
    const out = await withEnv({ BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: logDir }, () =>
      runSessionLane({ hook_event_name: "SessionStart", source: "clear", cwd: "/tmp", session_id: "sess-down" }, "http://127.0.0.1:1"),
    );
    assert.doesNotThrow(() => JSON.parse(out), "fail-open: always a JSON document");
    const ev = (await readEvents(logDir)).find((e) => e.kind === "session_hook_call");
    assert.ok(ev);
    assert.equal(ev.session_id, "sess-down");
    assert.equal(ev.daemon_reachable, false);
    assert.equal(ev.status, "daemon-unreachable");
    // Local parts (language hint, banners) can still be injected without a
    // daemon — the row must carry a number either way, never undefined.
    assert.equal(typeof ev.hint_tokens_est, "number");
    assert.equal(ev.hint_count, 0);
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
});

test("#458 (shadow): the SessionStart lane charges its emitted block to the session budget and writes a reconciling budget_shadow row; clear resets, compact does not", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-session-budget-"));
  try {
    await withDaemon(async (base) => {
      await withEnv({ BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: logDir, BASTRA_SESSION_BUDGET_SHADOW: "100" }, async () => {
        await runSessionLane({ hook_event_name: "SessionStart", source: "startup", cwd: "/tmp", session_id: "sess-458" }, base);
        await runSessionLane({ hook_event_name: "SessionStart", source: "compact", cwd: "/tmp", session_id: "sess-458" }, base);
        await runSessionLane({ hook_event_name: "SessionStart", source: "clear", cwd: "/tmp", session_id: "sess-458" }, base);
      });
    });
    // fire-and-forget writes — give them a tick
    await new Promise((r) => setTimeout(r, 50));
    const events = await readEvents(logDir);
    const calls = events.filter((e) => e.kind === "session_hook_call");
    const shadow = events.filter((e) => e.kind === "budget_shadow" && e.session_id === "sess-458");
    assert.equal(calls.length, 3);
    assert.equal(shadow.length, 3, "one decision per emission");
    for (let i = 0; i < 3; i++) {
      assert.equal(shadow[i].lane, "session_hook_call");
      assert.equal(shadow[i].tokens, calls[i].hint_tokens_est, "the shadow charges exactly the lane's hint_tokens_est (#457 reconciliation)");
      assert.equal(shadow[i].budget, 100);
    }
    const t = calls[0].hint_tokens_est as number;
    assert.ok(t > 100, "fixture block exceeds the 100-token test budget");
    assert.equal(shadow[0].spent_before, 0);
    assert.equal(shadow[0].would_drop, true, "even the first block would fall against a 100-token budget");
    assert.equal(shadow[1].spent_before, t, "compact keeps the ledger — the injected text survives compaction");
    assert.equal(shadow[2].spent_before, 0, "clear starts a new context");
    // and nothing was trimmed: every call still injected its block
    for (const c of calls) assert.equal(c.hint_count, 1);
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
});
