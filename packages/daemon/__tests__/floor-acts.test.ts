/**
 * Tests for the append-only affirm log (#198).
 *
 * The load-bearing case is the one the issue exists for: a surface queues two
 * Memory Updates while the daemon is down and drains them out of order. The
 * old single-row affirm made that indistinguishable from a fresh affirm and let
 * the later-arriving, older-intent event win. Here the read side has both acts
 * and orders on the intent clock, so it does not.
 *
 * Run: npx tsx --test packages/daemon/__tests__/floor-acts.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAct, liveIntent, readActs } from "../src/floor-acts.js";
import { addFloor, affirm, listFloors } from "../src/floors.js";

async function tmpPaths(): Promise<{ path: string; actsPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-floor-acts-"));
  return {
    path: join(dir, "floors.json"),
    actsPath: join(dir, "floor-acts.jsonl"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const FLOORED_AT = "2026-07-01T00:00:00.000Z";
const fallback = { last_affirmed: FLOORED_AT };

test("out-of-order drain: the later-arriving, older-intent act does not win", async () => {
  const { actsPath, cleanup } = await tmpPaths();
  try {
    // The surface re-affirmed at T1, superseded and re-affirmed at T2, then
    // drained T2 first and T1 second. Both are real historical affirms.
    await appendAct(
      { memory_id: "m1", occurred_at: "2026-07-20T12:00:00.000Z", affirmed_by: "sweep", why: "still pending (T2)" },
      actsPath,
    );
    await appendAct(
      { memory_id: "m1", occurred_at: "2026-07-10T09:00:00.000Z", affirmed_by: "sweep", why: "still pending (T1)" },
      actsPath,
    );

    const live = liveIntent("m1", FLOORED_AT, await readActs(actsPath), fallback);
    assert.equal(live.source, "log");
    assert.equal(live.occurred_at, "2026-07-20T12:00:00.000Z", "T2 wins on the intent clock");
    assert.equal(live.why, "still pending (T2)");
    assert.equal(live.never_reaffirmed, false);
    assert.ok((live.replay_gap_ms ?? 0) > 0, "the gap between intent and write is visible");
  } finally {
    await cleanup();
  }
});

test("an identical redelivery appends nothing; a differing why is a distinct event", async () => {
  const { actsPath, cleanup } = await tmpPaths();
  try {
    const act = { memory_id: "m1", occurred_at: "2026-07-10T09:00:00.000Z", affirmed_by: "sweep", why: "reason A" };

    assert.ok(await appendAct(act, actsPath), "first delivery lands");
    assert.equal(await appendAct(act, actsPath), null, "at-least-once redelivery is collapsed");
    assert.equal((await readActs(actsPath)).length, 1);

    // A reworded why is not a duplicate — collapsing it would be the engine
    // ruling that the rewording did not count.
    assert.ok(await appendAct({ ...act, why: "reason B" }, actsPath), "differing why is a new act");
    assert.equal((await readActs(actsPath)).length, 2);

    // Same occurred_at, two whys: that pair IS the rewording history, and the
    // tie breaks on the engine clock.
    const live = liveIntent("m1", FLOORED_AT, await readActs(actsPath), fallback);
    assert.equal(live.why, "reason B");
  } finally {
    await cleanup();
  }
});

test("zwei Acts in derselben Millisekunde: die spätere Zeile gewinnt, nicht die frühere", async () => {
  // Der Tiebreak hing an `recorded`, und das hat Millisekunden-Auflösung. Zwei
  // dicht aufeinander geschriebene Acts tragen denselben Wert — dann gewann die
  // FRÜHERE Fassung. Aufgefallen als Node-22-Testfehler; unter Node 24 lief
  // derselbe Test grün, weil er langsam genug war, dass die Millisekunde
  // wechselte. Hier wird der Gleichstand deshalb erzwungen statt erhofft.
  const { actsPath, cleanup } = await tmpPaths();
  try {
    const recorded = "2026-07-11T10:00:00.000Z";
    const base = { memory_id: "m1", occurred_at: "2026-07-10T09:00:00.000Z", affirmed_by: "sweep" };
    // Direkt in den Log geschrieben, damit beide Zeilen garantiert dasselbe
    // `recorded` tragen — appendAct stempelt die echte Uhr.
    await writeFile(
      actsPath,
      `${JSON.stringify({ ...base, why: "erste", recorded })}\n` +
        `${JSON.stringify({ ...base, why: "zweite", recorded })}\n`,
      "utf8",
    );

    const acts = await readActs(actsPath);
    assert.equal(acts.length, 2, "beide Zeilen sind gelesen");
    const live = liveIntent("m1", FLOORED_AT, acts, fallback);
    assert.equal(
      live.why,
      "zweite",
      "bei gleicher Millisekunde entscheidet die Append-Reihenfolge — der Log ist die Ordnung, die die Uhr nicht mehr hergibt",
    );
  } finally {
    await cleanup();
  }
});

test("an inline affirm carries no intent time and is ordered by the write clock", async () => {
  const { actsPath, cleanup } = await tmpPaths();
  try {
    await appendAct({ memory_id: "m1", affirmed_by: "cli", why: "inline" }, actsPath);

    const live = liveIntent("m1", FLOORED_AT, await readActs(actsPath), fallback);
    assert.equal(live.occurred_at, null, "no intent time is reported, not a fabricated one");
    assert.equal(live.replay_gap_ms, null);
    assert.equal(live.source, "log");
    assert.equal(live.why, "inline");
  } finally {
    await cleanup();
  }
});

test("an empty log falls back to the registry row instead of regressing to never-affirmed", async () => {
  const { actsPath, cleanup } = await tmpPaths();
  try {
    const acts = await readActs(actsPath);

    // A floor affirmed before this feature shipped: last_affirmed moved, so it
    // is not "never re-affirmed" even though the log knows nothing about it.
    const affirmed = liveIntent("m1", FLOORED_AT, acts, {
      last_affirmed: "2026-07-15T00:00:00.000Z",
      affirmed_by: "legacy",
      why: "legacy why",
    });
    assert.equal(affirmed.source, "registry_fallback");
    assert.equal(affirmed.never_reaffirmed, false);
    assert.equal(affirmed.recorded, "2026-07-15T00:00:00.000Z");
    assert.equal(affirmed.affirmed_by, "legacy");

    // A floor that was never affirmed keeps the pre-log stand-in.
    const never = liveIntent("m1", FLOORED_AT, acts, { last_affirmed: FLOORED_AT });
    assert.equal(never.never_reaffirmed, true);
  } finally {
    await cleanup();
  }
});

test("a replay carrying a pre-release intent time does not resurrect the dead floor handle", async () => {
  const { actsPath, cleanup } = await tmpPaths();
  try {
    // Affirmed under the first floor handle, then released and re-floored
    // later. The replay lands now but carries the old intent time.
    await appendAct(
      { memory_id: "m1", occurred_at: "2026-07-05T00:00:00.000Z", affirmed_by: "sweep", why: "old handle" },
      actsPath,
    );
    const reFlooredAt = "2026-07-18T00:00:00.000Z";

    const live = liveIntent("m1", reFlooredAt, await readActs(actsPath), { last_affirmed: reFlooredAt });
    assert.equal(live.source, "registry_fallback", "the pre-floor act is filtered out on the intent clock");
    assert.equal(live.never_reaffirmed, true, "the new handle has never been affirmed");
  } finally {
    await cleanup();
  }
});

test("acts are per memory: one floor's history never leaks into another's", async () => {
  const { actsPath, cleanup } = await tmpPaths();
  try {
    await appendAct(
      { memory_id: "m1", occurred_at: "2026-07-20T00:00:00.000Z", affirmed_by: "s", why: "for m1" },
      actsPath,
    );
    const acts = await readActs(actsPath);

    assert.equal(liveIntent("m1", FLOORED_AT, acts, fallback).why, "for m1");
    assert.equal(liveIntent("m2", FLOORED_AT, acts, fallback).source, "registry_fallback");
  } finally {
    await cleanup();
  }
});

test("affirm() writes the act and keeps the registry row as its cache", async () => {
  const { path, actsPath, cleanup } = await tmpPaths();
  try {
    await addFloor({ memory_id: "m1", condition: "decision-a", reason: "hard constraint" }, path);
    const entry = await affirm("m1", "sweep", "still pending", {
      path,
      actsPath,
      occurredAt: "2026-07-20T12:00:00.000Z",
    });

    const acts = await readActs(actsPath);
    assert.equal(acts.length, 1);
    assert.equal(acts[0].occurred_at, "2026-07-20T12:00:00.000Z", "the surface's clock is carried verbatim");
    assert.equal(acts[0].recorded, entry.last_affirmed, "the cached row matches the act it caches");

    // A redelivery of the same act moves nothing.
    const again = await affirm("m1", "sweep", "still pending", {
      path,
      actsPath,
      occurredAt: "2026-07-20T12:00:00.000Z",
    });
    assert.equal((await readActs(actsPath)).length, 1);
    assert.equal(again.last_affirmed, entry.last_affirmed, "the registry row did not move either");
  } finally {
    await cleanup();
  }
});

test("a rewrite-as-affirm through addFloor lands in the log too", async () => {
  const { path, actsPath, cleanup } = await tmpPaths();
  try {
    await addFloor({ memory_id: "m1", condition: "c1", reason: "r1" }, path);
    assert.equal((await readActs(actsPath)).length, 0, "a plain add is not an affirm");

    await addFloor(
      { memory_id: "m1", condition: "c2", reason: "r2", affirmed_by: "surface", why: "rewrite-as-affirm", acts_path: actsPath },
      path,
    );

    const acts = await readActs(actsPath);
    assert.equal(acts.length, 1);
    assert.equal(acts[0].why, "rewrite-as-affirm");

    // The act must survive the filter against the floor it was written with.
    const floors = await listFloors(undefined, path);
    const live = liveIntent("m1", floors[0].floored_at, acts, floors[0]);
    assert.equal(live.source, "log");
    assert.equal(live.never_reaffirmed, false);
  } finally {
    await cleanup();
  }
});
