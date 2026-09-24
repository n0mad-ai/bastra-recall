/**
 * Tests für die Live-Updates (#216, #234): Vault-Events werden pro Memory-ID
 * über ein Ruhefenster koalesziert (Burst → EIN Eintrag mit ×N-Zähler, erst
 * nach Fensterablauf sichtbar) und dann VERLUSTFREI ausgeliefert — jeder
 * finalisierte Eintrag trägt eine monotone `seq`, der Client pollt mit der
 * zuletzt gesehenen seq. Kein Event darf durch Trim/Alter verschwinden; läuft
 * der Puffer wirklich über, springt die kleinste seq über die Client-Position
 * (minSeq > since + 1) → der Client kann den Verlust ehrlich anzeigen.
 *
 * Kontrollierte Zeit über ein kleines injiziertes Ruhefenster (`debounceMs`)
 * + reale kurze Waits — im Stil der bestehenden HTTP/Vault-Tests.
 *
 * Runner: `tsx --test __tests__/live-updates.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { Vault, buildGraph } from "@bastra-recall/core";
import { createLiveUpdates, type LiveUpdate } from "../src/live-updates.js";
// #307 pins BOTH halves of the live path, so the map modules the entry ends up
// in are exercised for real instead of being restated in the test.
// @ts-expect-error — plain browser module, no types (same as memory-counter.test.ts).
import { createSimulation } from "../webui/js/simulation.js";
// @ts-expect-error — plain browser module, no types.
import { createLiveNodes } from "../webui/js/live-nodes.js";

const DEBOUNCE = 150; // injected quiet window
const AFTER = 340; // wait comfortably past one window before asserting

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function memoryMarkdown(id: string, title: string): string {
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: reference",
    `summary: Summary of ${id}`,
    "topic_path:\n  - test",
    "tags:\n  - test",
    "scope: live-test",
    `recall_when:\n  - ${id}`,
    "created: 2026-07-18",
    "updated: 2026-07-18",
    "---",
    "",
    "Body.",
  ].join("\n");
}

interface Poll {
  status: number;
  json: { updates: LiveUpdate[]; seq: number; minSeq: number };
}

/** boots a vault + a tiny server around handleUiUpdates; `call(seq?)` polls,
 *  omitting `since` when seq is undefined (baseline request). */
async function harness(
  opts: { debounceMs?: number; maxEntries?: number; maxWaitMs?: number; reannounceMs?: number } = {},
): Promise<{
  vault: Vault;
  live: ReturnType<typeof createLiveUpdates>;
  memDir: string;
  settingsPath: string;
  enableUi: () => Promise<void>;
  call: (since?: number) => Promise<Poll>;
  cleanup: () => Promise<void>;
}> {
  const vaultDir = await mkdtemp(join(tmpdir(), "live-vault-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "live-settings-"));
  const settingsPath = join(settingsDir, "cli-settings.json");
  const memDir = join(vaultDir, "memories", "projects", "live-test");
  await mkdir(memDir, { recursive: true });
  const vault = new Vault(vaultDir);
  await vault.init();
  const live = createLiveUpdates(vault, { debounceMs: DEBOUNCE, maxEntries: 500, ...opts });
  const server = createServer((req, res) => {
    void live.handleUiUpdates(req, res, settingsPath);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const call = (since?: number): Promise<Poll> =>
    new Promise((resolve, reject) => {
      const path = since === undefined ? "/ui/updates" : `/ui/updates?since=${since}`;
      const rq = request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} }));
      });
      rq.on("error", reject);
      rq.end();
    });

  return {
    vault,
    live,
    memDir,
    settingsPath,
    enableUi: () => writeFile(settingsPath, JSON.stringify({ ui: { enabled: true } })),
    call,
    cleanup: async () => {
      live.stop();
      server.close();
      await rm(vaultDir, { recursive: true, force: true });
      await rm(settingsDir, { recursive: true, force: true });
    },
  };
}

test("live updates: coalescing finalizes after the quiet window; seq delivers losslessly; ui gate", async () => {
  const h = await harness();
  const { vault, memDir, call } = h;
  const write = (id: string, title: string) => writeFile(join(memDir, `${id}.md`), memoryMarkdown(id, title));
  const reindex = (id: string) => vault.reindexFile(join(memDir, `${id}.md`));

  try {
    assert.equal((await call()).status, 404, "ui disabled → 404");
    await h.enableUi();

    // baseline (no cursor yet) → high-water mark, no history replay
    const base = await call();
    assert.equal(base.status, 200);
    assert.deepEqual(base.json.updates, []);
    assert.equal(base.json.seq, 0);

    // a fresh memory = an add event — held until the window elapses
    await write("fresh-one", "Fresh one");
    await reindex("fresh-one");
    assert.equal((await call(0)).json.updates.length, 0, "not visible before the window");

    await delay(AFTER);
    let r = await call(0);
    assert.equal(r.json.updates.length, 1);
    assert.equal(r.json.updates[0].id, "fresh-one");
    assert.equal(r.json.updates[0].kind, "add");
    assert.equal(r.json.updates[0].cluster, "live-test");
    assert.equal(r.json.updates[0].count, 1);
    assert.equal(r.json.updates[0].seq, 1);

    // save → enrich burst: add + change within the SAME window collapse into
    // one entry, hottest kind (add) wins, data is the latest (v2), count = 2
    await write("fresh-two", "Fresh two");
    await reindex("fresh-two");
    await write("fresh-two", "Fresh two v2");
    await reindex("fresh-two");
    await delay(AFTER);
    r = await call(0);
    const two = r.json.updates.find((u) => u.id === "fresh-two")!;
    assert.equal(two.kind, "add", "newborn stays 'add' through its enrich burst");
    assert.equal(two.title, "Fresh two v2", "coalesced entry carries the latest data");
    assert.equal(two.count, 2);

    // seq is a lossless cursor: since=1 (saw fresh-one) yields only fresh-two
    r = await call(1);
    assert.equal(r.json.updates.length, 1);
    assert.equal(r.json.updates[0].id, "fresh-two");
    assert.equal((await call(two.seq)).json.updates.length, 0, "caught up → nothing newer");
  } finally {
    await h.cleanup();
  }
});

test("live updates: same-memory read burst → one ×N entry; kind hotness (delete>add>change>read)", async () => {
  // pre-existing memories index silently (before the subscription), so only
  // the later read/change/delete events reach the buffer
  const vaultDir = await mkdtemp(join(tmpdir(), "live-kinds-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "live-kinds-settings-"));
  const settingsPath = join(settingsDir, "cli-settings.json");
  await writeFile(settingsPath, JSON.stringify({ ui: { enabled: true } }));
  const memDir = join(vaultDir, "memories", "projects", "live-test");
  await mkdir(memDir, { recursive: true });
  const f1 = join(memDir, "old-note.md");
  const f2 = join(memDir, "quiet-note.md");
  await writeFile(f1, memoryMarkdown("old-note", "Old note"));
  await writeFile(f2, memoryMarkdown("quiet-note", "Quiet note"));
  const vault = new Vault(vaultDir);
  await vault.init();
  const live = createLiveUpdates(vault, { debounceMs: DEBOUNCE, maxEntries: 500 });
  const server = createServer((req, res) => void live.handleUiUpdates(req, res, settingsPath));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const call = (since = 0): Promise<{ updates: LiveUpdate[] }> =>
    new Promise((resolve, reject) => {
      const rq = request({ hostname: "127.0.0.1", port, path: `/ui/updates?since=${since}`, method: "GET" }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve(JSON.parse(raw)));
      });
      rq.on("error", reject);
      rq.end();
    });
  const entry = (updates: LiveUpdate[], id: string) => updates.find((u) => u.id === id);
  // the buffer is a lossless log — an id can hold several entries over time;
  // `.at(-1)` is its most recent (highest-seq) one
  const latest = (updates: LiveUpdate[], id: string) => updates.filter((u) => u.id === id).at(-1);

  try {
    // five rapid reads of the SAME memory → exactly one entry, ×5, and nothing
    // before the window elapses
    for (let i = 0; i < 5; i++) live.notifyRead("quiet-note");
    assert.equal((await call()).updates.length, 0, "burst invisible before the window");
    await delay(AFTER);
    let r = await call();
    assert.equal(r.updates.length, 1, "five reads collapse into one entry");
    assert.equal(entry(r.updates, "quiet-note")?.kind, "read");
    assert.equal(entry(r.updates, "quiet-note")?.count, 5);

    // a read must never mask a hotter kind: change + read of old-note in the
    // same window → one 'change' entry (count 2), not a 'read'
    await writeFile(f1, memoryMarkdown("old-note", "Old note v2"));
    await vault.reindexFile(f1);
    live.notifyRead("old-note");
    await delay(AFTER);
    r = await call();
    assert.equal(entry(r.updates, "old-note")?.kind, "change");
    assert.equal(entry(r.updates, "old-note")?.title, "Old note v2");
    assert.equal(entry(r.updates, "old-note")?.count, 2);

    // delete always wins; title comes from the last known snapshot. The log
    // now holds both the earlier 'change' and this 'delete' for old-note —
    // the client sees them in seq order; the latest must be the delete.
    vault.forgetFile(f1);
    await delay(AFTER);
    r = await call();
    assert.equal(latest(r.updates, "old-note")?.kind, "delete");
    assert.equal(latest(r.updates, "old-note")?.title, "Old note v2");
  } finally {
    live.stop();
    server.close();
    await rm(vaultDir, { recursive: true, force: true });
    await rm(settingsDir, { recursive: true, force: true });
  }
});

test("live updates: 30 distinct memories all arrive; a late cursor loses nothing within the buffer", async () => {
  const h = await harness({ debounceMs: 120, maxEntries: 500 });
  const { vault, memDir, call } = h;
  try {
    await h.enableUi();
    // 30 events on 30 DIFFERENT memories in quick succession — different ids
    // never coalesce, so all 30 must survive to the poll
    for (let i = 0; i < 30; i++) {
      const id = `burst-${String(i).padStart(2, "0")}`;
      await writeFile(join(memDir, `${id}.md`), memoryMarkdown(id, id));
      await vault.reindexFile(join(memDir, `${id}.md`));
    }
    await delay(400);
    const all = await call(0);
    assert.equal(all.json.updates.length, 30, "every distinct memory delivered");
    assert.equal(new Set(all.json.updates.map((u) => u.id)).size, 30, "all ids distinct");
    assert.equal(all.json.minSeq, 1, "buffer holds everything (no overflow)");

    // a client that fell behind (cursor at 10) still gets 11..30 and no gap
    const late = await call(10);
    assert.equal(late.json.updates.length, 20, "late cursor receives every missed entry");
    assert.ok(late.json.minSeq <= 10 + 1, "no gap → no silent loss signalled");
  } finally {
    await h.cleanup();
  }
});

test("live updates: buffer overflow surfaces a gap signal, never a silent drop", async () => {
  const h = await harness({ debounceMs: 120, maxEntries: 5 });
  const { vault, memDir, call } = h;
  try {
    await h.enableUi();
    // 12 finalized entries into a 5-slot buffer → seq 8..12 survive, 1..7 age out
    for (let i = 0; i < 12; i++) {
      const id = `flood-${String(i).padStart(2, "0")}`;
      await writeFile(join(memDir, `${id}.md`), memoryMarkdown(id, id));
      await vault.reindexFile(join(memDir, `${id}.md`));
    }
    await delay(400);

    // a client at cursor 3 asks for more: the buffer now starts at seq 8, so
    // minSeq (8) jumps past since+1 (4) — the client can compute "+4 older"
    const since = 3;
    const r = await call(since);
    assert.equal(r.json.minSeq, 8, "oldest surviving seq");
    assert.equal(r.json.updates.length, 5, "only the 5 buffered entries remain");
    assert.ok(r.json.minSeq > since + 1, "overflow is detectable, not silent");
    assert.equal(r.json.minSeq - since - 1, 4, "exactly 4 older changes dropped");
  } finally {
    await h.cleanup();
  }
});

test("live updates: a recall notice carries its band and re-announces at most once per window", async () => {
  // #221: recall is the loudest path in the system — the same memory is a top
  // hit dozens of times per working session. Coalescing does not cover that
  // (those events are minutes apart, not milliseconds), so the id-level
  // re-announce window is what keeps the card from looping the same title.
  const REANN = 500;
  const QUIET = REANN + 120; // comfortably past one re-announce window
  const h = await harness({ reannounceMs: REANN });
  const { vault, memDir, live, call } = h;
  const file = join(memDir, "hot-note.md");

  try {
    await h.enableUi();
    await writeFile(file, memoryMarkdown("hot-note", "Hot note"));
    await vault.reindexFile(file);
    await delay(AFTER);
    let r = await call(0);
    assert.equal(r.json.updates.length, 1, "the memory is born");
    let cursor = r.json.updates[0].seq;
    await delay(QUIET); // let the birth's window expire

    // a served hit announces itself, and says which band served it
    live.notifyRead("hot-note", "required");
    await delay(AFTER);
    r = await call(cursor);
    assert.equal(r.json.updates.length, 1);
    assert.equal(r.json.updates[0].kind, "read");
    assert.equal(r.json.updates[0].band, "required", "the band travels with the notice");
    cursor = r.json.updates[0].seq;

    // a recall storm inside the window adds nothing — this is the flood guard
    live.notifyRead("hot-note", "optional");
    live.notifyRead("hot-note", "required");
    await delay(AFTER);
    assert.equal((await call(cursor)).json.updates.length, 0, "re-surfaced inside the window stays quiet");

    // what the user actually changes is never silenced by the read cooldown
    await writeFile(file, memoryMarkdown("hot-note", "Hot note v2"));
    await vault.reindexFile(file);
    await delay(AFTER);
    r = await call(cursor);
    assert.equal(r.json.updates.length, 1);
    assert.equal(r.json.updates[0].kind, "change", "vault events ignore the read cooldown");
    cursor = r.json.updates[0].seq;

    // past the window the same memory may speak again
    await delay(QUIET);
    live.notifyRead("hot-note", "optional");
    await delay(AFTER);
    r = await call(cursor);
    assert.equal(r.json.updates.length, 1, "the window reopens");
    assert.equal(r.json.updates[0].band, "optional");
  } finally {
    await h.cleanup();
  }
});

test("live updates: a memory that never goes quiet still finalizes at the max-wait cap", async () => {
  // Regression: the quiet window was re-armed on EVERY follow-up event, with no
  // ceiling. A memory an enricher/reindexer touches faster than the window was
  // therefore never delivered — no notice, no supernova, and the topbar memory
  // counter (webui bumpCounter) stopped moving. The cap bounds how long one
  // entry may be held back without giving up the "one entry with ×N" guarantee
  // from #234.
  const h = await harness({ debounceMs: 150, maxWaitMs: 400 });
  const { vault, memDir, call } = h;

  try {
    await h.enableUi();
    await writeFile(join(memDir, "busy-one.md"), memoryMarkdown("busy-one", "Busy one"));

    // an event every 80 ms: shorter than the 150 ms quiet window, and in sum
    // well past the 400 ms cap
    for (let i = 0; i < 8; i++) {
      await vault.reindexFile(join(memDir, "busy-one.md"));
      await delay(80);
    }

    const r = await call(0);
    assert.ok(r.json.updates.length >= 1, "the cap delivers despite the steady stream");
    assert.equal(r.json.updates[0].id, "busy-one");
    assert.ok(r.json.updates[0].count > 1, "the held-back events count as ×N");
  } finally {
    await h.cleanup();
  }
});

test("live updates: an area born after page load arrives WITH its grouping (#307)", async () => {
  // The onboarding interview on a fresh vault writes the user area into
  // existence — the profile memories are what CREATES it. The map derives every
  // grouping layer (cluster/group lists and their colors, cloud anchors,
  // galaxies) from the graph it fetched once at load, so a newborn from an area
  // that did not exist then arrived as a loose point and only found its cloud
  // after a manual browser reload.
  //
  // Both halves of that boundary are pinned here, against the real modules:
  // the live entry has to carry the FULL grouping coordinate (cluster + group +
  // sub, not the cluster alone), and adopting it has to announce that a
  // grouping came into existence so the map can grow one.
  const h = await harness();
  const { vault, memDir, call } = h;
  const anyGlobal = globalThis as unknown as { innerWidth: number; innerHeight: number };
  anyGlobal.innerWidth = 1200;
  anyGlobal.innerHeight = 800;

  try {
    await h.enableUi();
    // the vault the page loaded: one project area, no user area
    await writeFile(join(memDir, "task.md"), memoryMarkdown("task", "A task"));
    await vault.reindexFile(join(memDir, "task.md"));
    await delay(AFTER);
    const base = await call(0);

    const graph = buildGraph(vault);
    assert.ok(!graph.clusters.some((c) => c.key === "user"), "no user cluster at load time");
    assert.ok(!graph.groups.some((g) => g.key === "self"), "no self block at load time");
    for (const n of graph.nodes) (n as { baseCluster?: string }).baseCluster = n.cluster;

    // the interview writes the first profile memory — a brand new area
    const userDir = join(vault.root, "memories", "user");
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, "profile-work.md"), memoryMarkdown("profile-work", "How I work"));
    await vault.reindexFile(join(userDir, "profile-work.md"));
    await delay(AFTER);

    const born = (await call(base.json.seq)).json.updates.find((u) => u.id === "profile-work");
    assert.ok(born, "the newborn is delivered");
    assert.equal(born.kind, "add");
    assert.equal(born.cluster, "user");
    assert.equal(born.group, "self", "the building block travels with the entry");
    assert.equal(born.sub, "general", "so does the sub-area");

    // ── client half: the map adopts a memory from a cluster it never heard of
    const sim = createSimulation(graph, 1200, 800, null);
    assert.ok(sim.centers.has("live-test"), "the loaded cluster has a cloud anchor");
    assert.ok(!sim.centers.has("user"), "the new one cannot, it did not exist yet");

    const adopted: Array<{ cluster: string; group: string; sub: string; baseCluster: string }> = [];
    const { adoptLiveNode } = createLiveNodes({
      sim,
      inspector: { show: () => {} },
      select: () => {},
      getStructureMode: () => "clusters",
      // what app.js wires in: grow the grouping layers around the newborn
      onAdopt: (node: { cluster: string; group: string; sub: string; baseCluster: string }) => {
        adopted.push(node);
        sim.regroup(null);
      },
    });
    adoptLiveNode(born);

    assert.equal(adopted.length, 1, "adopting announces the newborn's grouping");
    assert.equal(adopted[0].group, "self", "filed in its real block, not the 'other' fallback");
    assert.equal(adopted[0].sub, "general");
    assert.equal(adopted[0].baseCluster, "user");
    assert.ok(sim.centers.has("user"), "the cloud comes into existence live");
    assert.equal(sim.centers.get("user").count, 1, "with the newborn as its member");
    assert.ok(sim.centers.has("live-test"), "and the existing clouds survive it");

    // in blocks structure the DISPLAYED cluster is the building block — the
    // adopted node must join the same layer as everyone else, not sit beside it
    const blockSim = createSimulation(graph, 1200, 800, null);
    const blocks = createLiveNodes({
      sim: blockSim,
      inspector: { show: () => {} },
      select: () => {},
      getStructureMode: () => "blocks",
      onAdopt: () => blockSim.regroup(null),
    });
    blocks.adoptLiveNode(born);
    assert.equal(blockSim.byId.get("profile-work").cluster, "self");
    assert.equal(blockSim.byId.get("profile-work").baseCluster, "user", "the fine layer is kept");
  } finally {
    await h.cleanup();
  }
});
