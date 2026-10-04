/**
 * #513: the pending relay has two lanes. `recency` is shown once and gone;
 * `trends` is shown at every real session start, never consumed on read, and
 * ages out after N counted sessions — not after wall-clock days.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumePendingSuggestions,
  formatPendingRelay,
  isCountableSessionStart,
  PENDING_BLOCK_CHAR_BUDGET,
  PENDING_MAX_AGE_MS,
  PENDING_TRENDS_SESSIONS_DEFAULT,
  type PendingSuggestion,
  takePendingRelay,
  writePendingSuggestion,
} from "../src/pending-suggestions.js";
import { runSessionLane } from "../src/session-lane.js";
import { summarizeSessionStart } from "../src/telemetry-report.js";

async function withRelay(fn: (path: string) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-pending-lanes-"));
  const keys = ["BASTRA_PENDING_SUGGESTIONS_PATH", "BASTRA_TELEMETRY", ...Object.keys(env)];
  const prev = new Map(keys.map((k) => [k, process.env[k]]));
  const path = join(dir, "pending.json");
  process.env.BASTRA_PENDING_SUGGESTIONS_PATH = path;
  process.env.BASTRA_TELEMETRY = "off";
  Object.assign(process.env, env);
  try {
    await fn(path);
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const start = (id: string) => takePendingRelay({ sessionId: id, countable: isCountableSessionStart(id, "startup") });

test("#513: a recency entry is shown at exactly the next start and gone on the following one", async () => {
  await withRelay(async () => {
    await writePendingSuggestion("<save-eval>hot</save-eval>");
    const first = await start("s-1");
    assert.equal(first.recency.length, 1);
    assert.equal(first.trends.length, 0);
    const second = await start("s-2");
    assert.equal(second.recency.length, 0);
  });
});

test("#513: a trends entry is shown at every start, not deleted on read, and ages out after N sessions", async () => {
  await withRelay(async (path) => {
    await writePendingSuggestion("<taxonomy-drift>x</taxonomy-drift>", { lane: "trends", key: "drift" });
    for (let i = 1; i <= PENDING_TRENDS_SESSIONS_DEFAULT; i++) {
      const r = await start(`s-${i}`);
      assert.equal(r.trends.length, 1, `start ${i} must still show the trend`);
      assert.equal(r.trends[0].sessions, i);
    }
    // Still on disk after N reads — reading never consumed it.
    assert.match(await readFile(path, "utf8"), /taxonomy-drift/);
    const past = await start(`s-${PENDING_TRENDS_SESSIONS_DEFAULT + 1}`);
    assert.equal(past.trends.length, 0, "aged out after N counted sessions");
  });
});

test("#513: wall-clock age does not expire a trend", async () => {
  await withRelay(async () => {
    await writePendingSuggestion("<t>old but alive</t>", { lane: "trends", key: "k" });
    const muchLater = Date.now() + 10 * PENDING_MAX_AGE_MS;
    const r = await takePendingRelay({ now: muchLater, sessionId: "s-1", countable: true });
    assert.equal(r.trends.length, 1);
  });
});

test("#513: N is configurable", async () => {
  await withRelay(
    async () => {
      await writePendingSuggestion("<t>x</t>", { lane: "trends", key: "k" });
      assert.equal((await start("a-1")).trends.length, 1);
      assert.equal((await start("a-2")).trends.length, 1);
      assert.equal((await start("a-3")).trends.length, 0);
    },
    { BASTRA_PENDING_TRENDS_SESSIONS: "2" },
  );
});

test("#513: a standing trend that aged out stays retired until its text changes", async () => {
  // Regression: the Stop hook rewrites the same drift text after every session,
  // so the row aged out at one start and was reborn with sessions: 0 at the next Stop.
  await withRelay(async () => {
    const stop = () => writePendingSuggestion("<t>3 memories share tag a</t>", { lane: "trends", key: "drift" });
    await stop();
    for (let i = 1; i <= PENDING_TRENDS_SESSIONS_DEFAULT; i++) {
      assert.equal((await start(`s-${i}`)).trends.length, 1, `start ${i} shows it`);
      await stop();
    }
    const aged = await start(`s-${PENDING_TRENDS_SESSIONS_DEFAULT + 1}`);
    assert.equal(aged.trends.length, 0, "aged out");
    await stop(); // same standing condition, same text
    assert.equal((await start(`s-${PENDING_TRENDS_SESSIONS_DEFAULT + 2}`)).trends.length, 0, "not revived by an identical rewrite");
    await stop();
    assert.equal((await start(`s-${PENDING_TRENDS_SESSIONS_DEFAULT + 3}`)).trends.length, 0, "still retired");
    // New counts are news: a fresh row with a fresh counter.
    await writePendingSuggestion("<t>5 memories share tag a</t>", { lane: "trends", key: "drift" });
    const fresh = await start(`s-${PENDING_TRENDS_SESSIONS_DEFAULT + 4}`);
    assert.equal(fresh.trends.length, 1);
    assert.equal(fresh.trends[0].sessions, 1);
  });
});

test("#513: identical trends dedupe to one row, and only changed text restarts the counter", async () => {
  await withRelay(async () => {
    await writePendingSuggestion("<t>3 memories share tag a</t>", { lane: "trends", key: "drift" });
    await start("s-1");
    await start("s-2");
    // An unchanged re-write used to reset `sessions` to 0, so a STANDING trend
    // (written again at every Stop, e.g. taxonomy-drift) never reached the
    // threshold that ages it out. It keeps its progress from s-1/s-2.
    await writePendingSuggestion("<t>3 memories share tag a</t>", { lane: "trends", key: "drift" });
    const same = await start("s-3");
    assert.equal(same.trends.length, 1, "never stacked");
    assert.equal(same.trends[0].sessions, 3, "the unchanged re-write kept the counter's progress");

    // #771 follow-up: this used to pin 3 → 4 here (changed text on a LIVE trend
    // kept the counter) while changed text on an AGED-OUT trend started at 0.
    // One rule now: changed text is news in both states and gets its N starts.
    await writePendingSuggestion("<t>4 memories share tag a</t>", { lane: "trends", key: "drift" });
    await writePendingSuggestion("<t>4 memories share tag a</t>", { lane: "trends", key: "drift" });
    const r = await start("s-4");
    assert.equal(r.trends.length, 1, "never stacked");
    assert.match(r.trends[0].blocks, /4 memories/);
    assert.equal(r.trends[0].sessions, 1, "changed text on a live trend restarts the counter");

    // Without a key the text itself is the identity.
    await writePendingSuggestion("<t>same</t>", { lane: "trends" });
    await writePendingSuggestion("<t>same</t>", { lane: "trends" });
    assert.equal((await start("s-5")).trends.length, 2);
  });
});

test("#771: a tombstone ends once N starts pass without a re-write, and the file goes with it", async () => {
  await withRelay(
    async (path) => {
      const stop = () => writePendingSuggestion("<t>standing</t>", { lane: "trends", key: "drift" });
      await stop();
      await start("s-1");
      await start("s-2");
      assert.equal((await start("s-3")).trends.length, 0, "aged out");
      assert.match(await readFile(path, "utf8"), /"retired":true/);

      // While the condition stands, every Stop writes it again and pushes the
      // tombstone's end back: it outlasts any number of starts.
      for (let i = 4; i <= 9; i++) {
        await stop();
        assert.equal((await start(`s-${i}`)).trends.length, 0, `start ${i}: still retired`);
      }
      // The condition is gone: nobody writes the trend any more. The tombstone
      // lasts N more starts and is dropped at the next; nothing else is left,
      // so the file is removed.
      await start("s-10");
      await start("s-11");
      await assert.rejects(readFile(path, "utf8"), /ENOENT/);
      // The same text coming up again after that is a new trend.
      await stop();
      const back = await start("s-12");
      assert.equal(back.trends.length, 1);
      assert.equal(back.trends[0].sessions, 1);
    },
    { BASTRA_PENDING_TRENDS_SESSIONS: "2" },
  );
});

test("#771: a start that does not count leaves a tombstone alone", async () => {
  await withRelay(
    async (path) => {
      await writePendingSuggestion("<t>standing</t>", { lane: "trends", key: "drift" });
      await start("s-1");
      await start("s-2"); // aged out
      for (let i = 0; i < 5; i++) await start(`eval-${i}`);
      await consumePendingSuggestions();
      assert.match(await readFile(path, "utf8"), /"retired":true/);
    },
    { BASTRA_PENDING_TRENDS_SESSIONS: "1" },
  );
});

test("#771: tombstones take no slot in the trends cap and are never reported as dropped", async () => {
  await withRelay(
    async (path) => {
      const errs: string[] = [];
      const write = process.stderr.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        errs.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        const trend = (name: string) => writePendingSuggestion(`<t>${name}</t>`, { lane: "trends", key: name });
        const tombstonesOnDisk = async () =>
          (JSON.parse(await readFile(path, "utf8")) as { retired?: boolean }[]).filter((e) => e.retired).length;
        // Five trends age out at the same start: five tombstones.
        for (let i = 0; i < 5; i++) await trend(`old-${i}`);
        await start("s-1");
        assert.equal((await start("s-2")).trends.length, 0, "all aged out");
        // Five live trends next to them: none is pushed out, nothing is reported.
        for (let i = 0; i < 5; i++) await trend(`new-${i}`);
        assert.equal((await start("s-3")).trends.length, 5, "the tombstones did not use up the cap");
        // The old ones are still standing (re-written), the new ones age out
        // too: ten tombstones. The next write trims them to their own bound —
        // without a notice, a tombstone is nothing a session would have seen.
        for (let i = 0; i < 5; i++) await trend(`old-${i}`);
        assert.equal((await start("s-4")).trends.length, 0);
        assert.equal(await tombstonesOnDisk(), 10);
        await trend("live-0");
        assert.equal(await tombstonesOnDisk(), 5, "tombstones are bounded on their own");
        for (let i = 1; i < 5; i++) await trend(`live-${i}`);
        assert.deepEqual(errs.filter((l) => /dropped/.test(l)), []);
        // A sixth LIVE trend still drops the oldest live one, and says so.
        await trend("live-5");
        assert.equal(errs.filter((l) => /1 oldest entry dropped/.test(l)).length, 1);
        assert.equal((await takePendingRelay()).trends.length, 5);
      } finally {
        process.stderr.write = write;
      }
    },
    { BASTRA_PENDING_TRENDS_SESSIONS: "1" },
  );
});

// #997: taxonomy-drift passes its cluster keys with their sizes; the text
// (counts, example ids) changes with every save, so it is no identity.
const drift = (clusters: Record<string, number>) =>
  writePendingSuggestion(
    `<taxonomy-drift>${Object.entries(clusters).map(([k, n]) => `${n} share ${k}`).join("; ")}</taxonomy-drift>`,
    { lane: "trends", key: "taxonomy-drift", clusters },
  );

/** Shows the drift trend until it retires (N = 2), then returns its tombstone. */
async function retire(path: string, clusters: Record<string, number>): Promise<PendingSuggestion> {
  await drift(clusters);
  await start("r-1");
  await start("r-2");
  assert.equal((await start("r-3")).trends.length, 0, "aged out");
  const rows = JSON.parse(await readFile(path, "utf8")) as PendingSuggestion[];
  return rows.find((e) => e.retired)!;
}

test("#997: a count bump does not revive a retired drift hint, and does not restart a live one", async () => {
  await withRelay(
    async (path) => {
      await drift({ "tag:foo": 8 });
      assert.equal((await start("s-1")).trends[0].sessions, 1);
      await drift({ "tag:foo": 9 });
      const live = await start("s-2");
      assert.equal(live.trends[0].sessions, 2, "8 → 9 on a live hint keeps the counter");
      assert.match(live.trends[0].blocks, /9 share tag:foo/, "and shows the current numbers");
      assert.equal((await start("s-3")).trends.length, 0, "aged out");
      const tomb = JSON.parse(await readFile(path, "utf8")) as PendingSuggestion[];
      assert.deepEqual(tomb[0].clusters, { "tag:foo": 9 }, "the tombstone carries the keys and the size at retirement");
      for (const n of [10, 17, 12]) {
        await drift({ "tag:foo": n });
        assert.equal((await start(`s-n${n}`)).trends.length, 0, `${n} < 2 × 9 stays retired`);
      }
      // Clusters swapping order or one dropping out is not news either.
      await drift({ "tag:foo": 9, "topic:bar": 8 });
      assert.equal((await start("s-4")).trends.length, 1, "a new key is news (see the next test)");
      await start("s-5"); // retire it again, now with both keys
      await start("s-6");
      await drift({ "topic:bar": 9 });
      await drift({ "tag:foo": 8, "topic:bar": 8 });
      assert.equal((await start("s-7")).trends.length, 0, "a known key dropping out and back in is not news");
    },
    { BASTRA_PENDING_TRENDS_SESSIONS: "2" },
  );
});

test("#997: a retired drift hint returns when a cluster doubles or a new cluster key appears", async () => {
  await withRelay(
    async (path) => {
      await retire(path, { "tag:foo": 8 });
      await drift({ "tag:foo": 16 });
      const grown = await start("s-1");
      assert.equal(grown.trends.length, 1, "growth to 2× revives");
      assert.equal(grown.trends[0].sessions, 1, "with a fresh counter");
    },
    { BASTRA_PENDING_TRENDS_SESSIONS: "2" },
  );
  await withRelay(
    async (path) => {
      await retire(path, { "tag:foo": 8 });
      await drift({ "tag:foo": 8, "topic:bar": 8 });
      const added = await start("s-1");
      assert.equal(added.trends.length, 1, "a new key revives");
      assert.deepEqual(added.trends[0].clusters, { "tag:foo": 8, "topic:bar": 8 });
    },
    { BASTRA_PENDING_TRENDS_SESSIONS: "2" },
  );
});

test("#997: a tombstone written by the text rule is compared by text once, then carries the keys", async () => {
  await withRelay(
    async (path) => {
      // Pre-#997 tombstone: no `clusters`.
      const legacy = { ts: Date.now(), blocks: "<taxonomy-drift>8 share tag:foo</taxonomy-drift>", lane: "trends", key: "taxonomy-drift", sessions: 0, retired: true };
      await writeFile(path, JSON.stringify([legacy]), "utf8");
      await drift({ "tag:foo": 8 }); // same text → stays retired and learns its keys
      assert.equal((await start("s-1")).trends.length, 0);
      const rows = JSON.parse(await readFile(path, "utf8")) as PendingSuggestion[];
      assert.deepEqual(rows[0].clusters, { "tag:foo": 8 });
      await drift({ "tag:foo": 9 });
      assert.equal((await start("s-2")).trends.length, 0, "from here on the keys decide");

      // A legacy tombstone meeting changed text revives once (unknown size).
      await writeFile(path, JSON.stringify([legacy]), "utf8");
      await drift({ "tag:foo": 9 });
      assert.equal((await start("s-3")).trends.length, 1);
    },
    { BASTRA_PENDING_TRENDS_SESSIONS: "2" },
  );
});

test("#513: synthetic/eval ids, resumed sessions and a repeated id never advance the counter", async () => {
  assert.equal(isCountableSessionStart("eval-123", "startup"), false);
  assert.equal(isCountableSessionStart("test_abc", "startup"), false);
  assert.equal(isCountableSessionStart("", "startup"), false);
  assert.equal(isCountableSessionStart(null, "startup"), false);
  assert.equal(isCountableSessionStart("01a05b6f-real", "compact"), false);
  assert.equal(isCountableSessionStart("01a05b6f-real", "resume"), false);
  assert.equal(isCountableSessionStart("01a05b6f-real", "startup"), true);
  assert.equal(isCountableSessionStart("01a05b6f-real", undefined), true);

  await withRelay(async () => {
    await writePendingSuggestion("<t>x</t>", { lane: "trends", key: "k" });
    for (let i = 0; i < 20; i++) {
      const r = await takePendingRelay({ sessionId: `eval-${i}`, countable: isCountableSessionStart(`eval-${i}`, "startup") });
      assert.equal(r.trends.length, 1, "a synthetic start still sees the trend");
      assert.equal(r.trends[0].sessions, 0, "…but never ages it");
    }
    await start("real-1");
    const again = await start("real-1");
    assert.equal(again.trends[0].sessions, 1, "the same session id counts once");
  });
});

test("#513: the lanes do not evict each other at the per-lane cap", async () => {
  await withRelay(async () => {
    await writePendingSuggestion("<t>trend</t>", { lane: "trends", key: "k" });
    for (let i = 0; i < 12; i++) await writePendingSuggestion(`<save-eval>hot ${i}</save-eval>`);
    const r = await start("s-1");
    assert.equal(r.recency.length, 5);
    assert.equal(r.trends.length, 1, "a burst of hot suggestions must not push the trend out");
  });
});

test("#513: consumePendingSuggestions keeps its contract and leaves trends alone", async () => {
  await withRelay(async () => {
    await writePendingSuggestion("<t>trend</t>", { lane: "trends", key: "k" });
    await writePendingSuggestion("<save-eval>hot</save-eval>");
    const consumed = await consumePendingSuggestions();
    assert.deepEqual(consumed.map((e) => e.blocks), ["<save-eval>hot</save-eval>"]);
    const r = await start("s-1");
    assert.equal(r.recency.length, 0);
    assert.equal(r.trends.length, 1);
    assert.equal(r.trends[0].sessions, 1, "the plain consume did not count a session");
  });
});

test("#513: the lanes render as two labelled blocks that share the #510 budget", () => {
  const both = formatPendingRelay({
    recency: [{ ts: 1, blocks: "<save-eval>hot</save-eval>" }],
    trends: [{ ts: 1, blocks: "<taxonomy-drift>recurring</taxonomy-drift>", lane: "trends" }],
  });
  assert.match(both.text, /^<pending-save-suggestions source="stop-hook">\n[\s\S]*<\/pending-save-suggestions>\n<pending-trends source="stop-hook">\n/);
  assert.match(both.text, /Recurring — shown at every session start/);
  assert.match(both.text, /<\/pending-trends>$/);
  assert.ok(both.recencyChars > 0 && both.trendsChars > 0);

  assert.equal(formatPendingRelay({ recency: [], trends: [] }).text, "");

  // Recency fills the budget → the trend is squeezed out, announced, and told it comes back.
  const full = formatPendingRelay({
    recency: [{ ts: 1, blocks: "h".repeat(PENDING_BLOCK_CHAR_BUDGET) }],
    trends: [{ ts: 1, blocks: "<t>recurring</t>", lane: "trends" }],
  });
  assert.ok(!full.text.includes("<t>recurring</t>"));
  assert.match(full.text, /1 earlier suggestion suppressed .* they stay pending and come back at the next session start\./);
});

test("#513: SessionStart delivers both lanes and keeps delivering the trend", async () => {
  await withRelay(async () => {
    await writePendingSuggestion("<save-eval>hot one</save-eval>");
    await writePendingSuggestion("<taxonomy-drift>recurring one</taxonomy-drift>", { lane: "trends", key: "taxonomy-drift" });
    const ctxOf = async (id: string) => {
      const out = await runSessionLane(
        { hook_event_name: "SessionStart", source: "startup", cwd: "/tmp", session_id: id },
        "http://127.0.0.1:1",
      );
      return (JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "";
    };
    const first = await ctxOf("lane-wiring-1");
    assert.match(first, /hot one/);
    assert.match(first, /<pending-trends[\s\S]*recurring one/);
    const second = await ctxOf("lane-wiring-2");
    assert.doesNotMatch(second, /hot one/);
    assert.match(second, /recurring one/);
  });
});

test("#513: the telemetry report counts lanes and keeps pre-#513 starts out of them", () => {
  const section = summarizeSessionStart([
    { kind: "session_hook_call", pending_lanes: { recency: 2, trends: 1, recency_chars: 300, trends_chars: 100 } },
    { kind: "session_hook_call", pending_lanes: { recency: 0, trends: 1, recency_chars: 0, trends_chars: 100 } },
    { kind: "session_hook_call" },
  ] as never);
  assert.equal(section.pendingLanes.withLanes, 2);
  assert.equal(section.pendingLanes.withoutLanes, 1);
  assert.deepEqual(section.pendingLanes.recency, { entries: 2, presentIn: 1, avgChars: 150 });
  assert.deepEqual(section.pendingLanes.trends, { entries: 2, presentIn: 2, avgChars: 100 });
});
