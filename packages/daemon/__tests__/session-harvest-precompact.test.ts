/**
 * #1486 — harvest before compaction. Claude Code's PreCompact rides the Stop
 * client; the lane books the session so the next harvest pass reads the turns
 * the compaction summary replaces, instead of waiting 30 quiet minutes.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/session-harvest-precompact.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bookPreCompact, noteSessionForHarvest, runSessionHarvest } from "../src/session-harvest.js";
import { loadTranscript, runStopLane } from "../src/stop-lane.js";
import { planHookEntries, installedLanes } from "../src/cli/adapters/claude-code-hooks.js";

async function sandbox<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "harvest-compact-"));
  const env: Record<string, string> = {
    BASTRA_TELEMETRY: "on",
    BASTRA_LOG_PATH: join(dir, "logs"),
    BASTRA_PENDING_SUGGESTIONS_PATH: join(dir, "pending.json"),
    BASTRA_DRAFTS_PATH: join(dir, "drafts.json"),
    BASTRA_HARVEST_QUEUE_PATH: join(dir, "queue.json"),
    BASTRA_HOOK_STATE_DIR: join(dir, "state"),
  };
  const before = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn(dir);
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

const TRANSCRIPT = [
  { role: "user", content: "wire up the release script" },
  { role: "assistant", content: [{ type: "text", text: "Should the script tag the release too?" }] },
  { role: "user", content: "Yes, and it must always sign the tag with the release key, never unsigned." },
]
  .map((r) => JSON.stringify({ type: r.role, message: { role: r.role, content: r.content } }))
  .join("\n");

const loadTurns = (p: string) => loadTranscript({ transcript_path: p });

async function harvestTriggers(dir: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (const f of await readdir(join(dir, "logs")))
    for (const line of (await readFile(join(dir, "logs", f), "utf8")).split("\n"))
      if (line) {
        const e = JSON.parse(line) as { kind?: string; trigger?: unknown };
        if (e.kind === "session_harvest") rows.push(e.trigger);
      }
  return rows;
}

test("#1486 PreCompact: harvested on the next pass without the idle wait; the answer steers no summary", async () => {
  await sandbox(async (dir) => {
    const transcript = join(dir, "sess.jsonl");
    await writeFile(transcript, TRANSCRIPT);
    const out = await bookPreCompact(
      { hook_event_name: "PreCompact", session_id: "c-1", transcript_path: transcript, cwd: "/work" } as never,
      "claude-code"
    );
    // One JSON object without fields: Claude Code reads it as hook output, not
    // as instructions for the compaction summary.
    assert.equal(out, "{}");
    const [row] = JSON.parse(await readFile(join(dir, "queue.json"), "utf8")) as { last_stop: number }[];

    const r = await runSessionHarvest({ loadTurns, now: row.last_stop + 1000 });
    assert.equal(r.harvested, 1, "due at once, although the transcript was just written");
    assert.ok(r.candidates >= 1);
    assert.deepEqual(await harvestTriggers(dir), ["pre_compact"]);

    // The session goes on: a second pass right after harvests nothing new.
    const again = await runSessionHarvest({ loadTurns, now: row.last_stop + 2000 });
    assert.equal(again.harvested, 0);
  });
});

test("#1486 the Stop that ends the compacting turn does not cancel the harvest", async () => {
  await sandbox(async (dir) => {
    const transcript = join(dir, "sess.jsonl");
    await writeFile(transcript, TRANSCRIPT);
    const t0 = 1_800_000_000_000;
    await noteSessionForHarvest({ session_id: "c-2", transcript_path: transcript, compacting: true, now: t0 });
    // Auto-compaction fires mid-turn; the Stop follows seconds later.
    await noteSessionForHarvest({ session_id: "c-2", transcript_path: transcript, now: t0 + 5000 });
    const r = await runSessionHarvest({ loadTurns, now: t0 + 6000 });
    assert.equal(r.harvested, 1);
  });
});

test("#1486 PreCompact through the Stop lane books the session", async () => {
  await sandbox(async (dir) => {
    const transcript = join(dir, "sess.jsonl");
    await writeFile(transcript, TRANSCRIPT);
    const out = await runStopLane(
      { hook_event_name: "PreCompact", session_id: "c-3", transcript_path: transcript, cwd: "/work" },
      "http://127.0.0.1:1"
    );
    assert.equal(out, "{}");
    const queue = JSON.parse(await readFile(join(dir, "queue.json"), "utf8")) as {
      session_id: string;
      compact_at?: number;
    }[];
    assert.equal(queue[0].session_id, "c-3");
    assert.equal(typeof queue[0].compact_at, "number");

    // Any other non-Stop event is answered `{}` and books nothing.
    assert.equal(
      await runStopLane(
        { hook_event_name: "Notification", session_id: "c-4", transcript_path: transcript },
        "http://127.0.0.1:1"
      ),
      "{}"
    );
    const after = JSON.parse(await readFile(join(dir, "queue.json"), "utf8")) as { session_id: string }[];
    assert.deepEqual(
      after.map((e) => e.session_id),
      ["c-3"]
    );
  });
});

test("#1486 adapter: PreCompact is registered with Stop on the Stop client, and follows a preserved Stop opt-in", () => {
  const commandsOf = (entries: unknown[]) =>
    entries.flatMap((e) => ((e as { hooks: { command: string }[] }).hooks ?? []).map((h) => h.command));
  const withStop = planHookEntries("install", {}, { includeStop: true, stubPresent: false });
  const compact = withStop.after.PreCompact;
  assert.equal(compact.length, 1);
  assert.equal((compact[0] as { matcher?: string }).matcher, undefined, "manual and auto compaction alike");
  assert.match(commandsOf(compact)[0], /stop-hook\.js$/);

  const without = planHookEntries("install", {}, { includeStop: false, stubPresent: false });
  assert.equal(without.after.PreCompact.length, 0, "--no-stop-hook leaves it out");

  const preserved = planHookEntries(
    "install",
    { Stop: withStop.after.Stop },
    { includeStop: false, stubPresent: false }
  );
  assert.equal(preserved.stopPreserved, true);
  assert.equal(commandsOf(preserved.after.PreCompact).length, 1);

  const removed = planHookEntries("uninstall", { PreCompact: compact }, { includeStop: false, stubPresent: false });
  assert.equal(removed.after.PreCompact.length, 0);
  assert.match(installedLanes(true, false), /PreCompact \(harvest\)/);
});
