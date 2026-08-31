/**
 * Tests für die Floor-Registry (#141/#142) — pin-with-lifecycle, daemon-side.
 *
 * Modul-Ebene: add/upsert, release-by-condition, affirm-Invariante (kein why =
 * kein affirm = Uhr bewegt sich nicht), Cap, Persistenz-Roundtrip, Scope-Filter.
 * HTTP-Ebene: /hook/floors-Enrichment (Join id→title/summary) und die
 * /api/v1/floors-Endpoints gegen einen echten Server (Pattern hook-act.test.ts).
 *
 * Außerdem der dritte Arm der survival-by-id-Invariante (#153): der Floor ist
 * injection-layer-only, retire/unpin lässt Vault-File und Engine-Ranking
 * byte-/wertidentisch — er wohnt HIER statt in packages/core/__tests__/
 * survival-by-id.test.ts, weil die Registry Daemon-State ist und core nicht
 * gegen daemon importieren darf (Cross-Package-Imports laufen im Repo nur in
 * Richtung daemon → core).
 *
 * Runner: tsx --test packages/daemon/__tests__/floors.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";
import { addFloor, affirm, listFloors, release, MAX_FLOORS, type FloorEntry } from "../src/floors.js";

function memoryMarkdown(id: string, title: string, scope: string): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: lesson",
    `summary: ${title}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    `scope: ${scope}`,
    "recall_when:",
    `  - ${title}`,
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    `Body for ${title}.`,
    "",
  ].join("\n");
}

async function tmpFloorsPath(): Promise<{ path: string; actsPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-floors-test-"));
  return {
    path: join(dir, "floors.json"),
    // #198: affirms append here. Without the override a test would write into
    // the real ~/.bastra/floor-acts.jsonl.
    actsPath: join(dir, "floor-acts.jsonl"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// ─── Modul-Ebene ─────────────────────────────────────────────────

test("addFloor stamps floored_at + last_affirmed and upserts by memory_id", async () => {
  const { path, actsPath, cleanup } = await tmpFloorsPath();
  try {
    const first = await addFloor({ memory_id: "m1", condition: "decision-a", reason: "killed option" }, path);
    assert.ok(first.floored_at, "floored_at is stamped");
    assert.equal(first.last_affirmed, first.floored_at, "fresh floor: last_affirmed = floored_at");
    assert.equal(first.affirmed_by, undefined, "no affirm on plain add");

    // Upsert: rewriting the floor for the same id replaces the entry — the
    // registry never grows a duplicate handle for one memory.
    const second = await addFloor({ memory_id: "m1", condition: "decision-b", reason: "superseded" }, path);
    const all = await listFloors(undefined, path);
    assert.equal(all.length, 1);
    assert.equal(all[0].condition, "decision-b");
    assert.equal(all[0].reason, "superseded");
    assert.equal(all[0].floored_at, second.floored_at);
  } finally {
    await cleanup();
  }
});

test("release(condition) removes ALL entries sharing the token and returns the removed ids", async () => {
  const { path, actsPath, cleanup } = await tmpFloorsPath();
  try {
    await addFloor({ memory_id: "m1", condition: "migration-x", reason: "constraint 1" }, path);
    await addFloor({ memory_id: "m2", condition: "migration-x", reason: "constraint 2" }, path);
    await addFloor({ memory_id: "m3", condition: "decision-y", reason: "open decision" }, path);

    const removed = await release("migration-x", path);
    assert.deepEqual(removed.sort(), ["m1", "m2"], "both entries of the token are gone in ONE call");

    const remaining = await listFloors(undefined, path);
    assert.deepEqual(remaining.map((e) => e.memory_id), ["m3"], "unrelated condition survives");

    assert.deepEqual(await release("migration-x", path), [], "releasing an unknown/spent token removes nothing");
  } finally {
    await cleanup();
  }
});

test("affirm without why (or without affirmed_by) is rejected — the clock does not move", async () => {
  const { path, actsPath, cleanup } = await tmpFloorsPath();
  try {
    const entry = await addFloor({ memory_id: "m1", condition: "decision-a", reason: "hard constraint" }, path);

    // Anti-incidental-touch invariant (#142): an affirm is a deliberate
    // re-justification. No why = no affirm.
    await assert.rejects(() => affirm("m1", "cowork-os", "", { path, actsPath }), /affirm requires affirmed_by AND why/);
    await assert.rejects(() => affirm("m1", "", "still valid", { path, actsPath }), /affirm requires affirmed_by AND why/);
    await assert.rejects(() => affirm("m1", "  ", "   ", { path, actsPath }), /affirm requires affirmed_by AND why/);

    const after = await listFloors(undefined, path);
    assert.equal(after[0].last_affirmed, entry.last_affirmed, "rejected affirm left last_affirmed untouched");
    assert.equal(after[0].affirmed_by, undefined);

    await assert.rejects(() => affirm("nope", "cowork-os", "why", { path, actsPath }), /not floored/);
  } finally {
    await cleanup();
  }
});

test("affirm with affirmed_by + why stamps last_affirmed and stores both verbatim", async () => {
  const { path, actsPath, cleanup } = await tmpFloorsPath();
  try {
    const entry = await addFloor({ memory_id: "m1", condition: "decision-a", reason: "hard constraint" }, path);
    await new Promise((r) => setTimeout(r, 5)); // let the clock visibly move

    const affirmedBy = "cowork-os/memory-update";
    const why = "migration X still pending — reviewed in the weekly sweep";
    const next = await affirm("m1", affirmedBy, why, { path, actsPath });

    assert.ok(next.last_affirmed > entry.last_affirmed, "last_affirmed moved forward");
    assert.equal(next.floored_at, entry.floored_at, "floored_at never moves on affirm");
    // Verbatim: the engine stores, never interprets.
    assert.equal(next.affirmed_by, affirmedBy);
    assert.equal(next.why, why);

    const persisted = await listFloors(undefined, path);
    assert.equal(persisted[0].affirmed_by, affirmedBy);
    assert.equal(persisted[0].why, why);
  } finally {
    await cleanup();
  }
});

test(`cap: entry ${MAX_FLOORS + 1} is rejected with an error listing the current set; upsert still passes`, async () => {
  const { path, actsPath, cleanup } = await tmpFloorsPath();
  try {
    for (let i = 1; i <= MAX_FLOORS; i++) {
      await addFloor({ memory_id: `m${i}`, condition: `cond-${i}`, reason: `reason ${i}` }, path);
    }
    await assert.rejects(
      () => addFloor({ memory_id: "overflow", condition: "cond-x", reason: "one too many" }, path),
      (err: Error) => {
        assert.match(err.message, new RegExp(`floor cap reached \\(${MAX_FLOORS}\\)`));
        // Curation stays above the engine: the error lists what is currently
        // floored so the surface can decide what to release.
        assert.match(err.message, /m1 \(condition: cond-1\)/);
        assert.match(err.message, new RegExp(`m${MAX_FLOORS} \\(condition: cond-${MAX_FLOORS}\\)`));
        return true;
      },
    );

    // Rewriting an EXISTING entry at the cap is not an add — it must pass.
    await addFloor({ memory_id: "m3", condition: "cond-3b", reason: "rewritten" }, path);
    const all = await listFloors(undefined, path);
    assert.equal(all.length, MAX_FLOORS);
    assert.equal(all.find((e) => e.memory_id === "m3")?.condition, "cond-3b");
  } finally {
    await cleanup();
  }
});

test("persistence roundtrip: entries survive as valid JSON on disk and re-read identically", async () => {
  const { path, actsPath, cleanup } = await tmpFloorsPath();
  try {
    const a = await addFloor({ memory_id: "m1", condition: "c1", reason: "r1", scope: "proj-a" }, path);
    const b = await addFloor(
      { memory_id: "m2", condition: "c2", reason: "r2", affirmed_by: "surface", why: "rewrite-as-affirm", acts_path: actsPath },
      path,
    );

    const raw = JSON.parse(await readFile(path, "utf8")) as FloorEntry[];
    assert.equal(raw.length, 2, "registry is a plain JSON array on disk");

    const reread = await listFloors(undefined, path);
    assert.deepEqual(reread, [a, b], "listFloors returns exactly what add persisted");
    assert.equal(reread[1].affirmed_by, "surface", "add with affirmed_by+why keeps both (rewrite-as-affirm)");

    // Both-or-neither on add: a lone why is not an affirm.
    await assert.rejects(
      () => addFloor({ memory_id: "m3", condition: "c3", reason: "r3", why: "lonely why" }, path),
      /affirmed_by and why must be provided together/,
    );
  } finally {
    await cleanup();
  }
});

test("listFloors(scope) returns scoped + unscoped (global) entries only", async () => {
  const { path, actsPath, cleanup } = await tmpFloorsPath();
  try {
    await addFloor({ memory_id: "ga", condition: "c", reason: "global floor" }, path);
    await addFloor({ memory_id: "pa", condition: "c", reason: "proj-a floor", scope: "proj-a" }, path);
    await addFloor({ memory_id: "pb", condition: "c", reason: "proj-b floor", scope: "proj-b" }, path);

    const a = await listFloors("proj-a", path);
    assert.deepEqual(a.map((e) => e.memory_id).sort(), ["ga", "pa"]);

    const all = await listFloors(undefined, path);
    assert.equal(all.length, 3, "no scope = full registry");
  } finally {
    await cleanup();
  }
});

// #360-Folgefund B: `fetchFloors()` schickt den rohen `detectProject()`-Namen
// ("CarNexus") als scope, Floors werden konventionell klein gescopet
// ("carnexus") — ein ungefaltetes `===` liess ein projektgebundenes Floor für
// genau sein eigenes Projekt lautlos verschwinden. Ohne den Fix in
// `listFloors` (scopeEquals statt `===`) ist dieser Test rot.
test("listFloors: a capitalised project name still finds its own lowercase-scoped floor (#360)", async () => {
  const { path, actsPath, cleanup } = await tmpFloorsPath();
  try {
    await addFloor({ memory_id: "ga", condition: "c", reason: "global floor" }, path);
    await addFloor({ memory_id: "pc", condition: "c", reason: "CarNexus floor", scope: "carnexus" }, path);

    const scoped = await listFloors("CarNexus", path);
    assert.deepEqual(
      scoped.map((e) => e.memory_id).sort(),
      ["ga", "pc"],
      "the project's own floor must not vanish just because the detected cwd segment is capitalised",
    );
  } finally {
    await cleanup();
  }
});

// ─── HTTP-Ebene (echter Server, Pattern hook-act.test.ts) ────────

function httpPost(port: number, path: string, payload: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

interface FloorsBody {
  floors: Array<FloorEntry & { title?: string; summary?: string }>;
}

async function makeServer(): Promise<{ port: number; floorsPath: string; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-floors-http-"));
  await writeFile(join(dir, "m1.md"), memoryMarkdown("m1", "deploy staging lesson", "floors-http"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const floorsPath = join(dir, "floors.json");
  const prevEnv = process.env.BASTRA_FLOORS_PATH;
  const prevActs = process.env.BASTRA_FLOOR_ACTS_PATH;
  process.env.BASTRA_FLOORS_PATH = floorsPath;
  process.env.BASTRA_FLOOR_ACTS_PATH = join(dir, "floor-acts.jsonl");
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
  });
  return {
    port: handle.port!,
    floorsPath,
    close: async () => {
      if (prevEnv === undefined) delete process.env.BASTRA_FLOORS_PATH;
      else process.env.BASTRA_FLOORS_PATH = prevEnv;
      if (prevActs === undefined) delete process.env.BASTRA_FLOOR_ACTS_PATH;
      else process.env.BASTRA_FLOOR_ACTS_PATH = prevActs;
      search.stop();
      await vault.stop?.();
      await handle.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

test("/hook/floors joins id→title/summary daemon-side and honors ?scope=", async () => {
  const srv = await makeServer();
  try {
    await addFloor({ memory_id: "m1", condition: "c1", reason: "constraint", scope: "floors-http" }, srv.floorsPath);
    await addFloor({ memory_id: "ghost", condition: "c2", reason: "stale handle" }, srv.floorsPath);

    const res = await httpGet(srv.port, "/hook/floors");
    assert.equal(res.status, 200);
    const { floors } = JSON.parse(res.body) as FloorsBody;
    assert.equal(floors.length, 2);
    const m1 = floors.find((f) => f.memory_id === "m1")!;
    assert.equal(m1.title, "deploy staging lesson", "resolvable id is enriched with its title");
    assert.equal(m1.summary, "deploy staging lesson", "…and its summary");
    const ghost = floors.find((f) => f.memory_id === "ghost")!;
    assert.equal(ghost.title, undefined, "unresolvable id stays visible, just without a title");

    const scoped = await httpGet(srv.port, "/hook/floors?scope=floors-http");
    const scopedFloors = (JSON.parse(scoped.body) as FloorsBody).floors;
    assert.deepEqual(scopedFloors.map((f) => f.memory_id).sort(), ["ghost", "m1"], "scoped + global entries");

    const foreign = await httpGet(srv.port, "/hook/floors?scope=other-project");
    const foreignFloors = (JSON.parse(foreign.body) as FloorsBody).floors;
    assert.deepEqual(foreignFloors.map((f) => f.memory_id), ["ghost"], "foreign scope sees only global entries");
  } finally {
    await srv.close();
  }
});

test("/api/v1/floors add + list + affirm-guard + release over the REST surface", async () => {
  const srv = await makeServer();
  try {
    const add = await httpPost(srv.port, "/api/v1/floors", {
      memory_id: "m1",
      condition: "decision-open",
      reason: "killed option — do not revisit",
    });
    assert.equal(add.status, 200);
    const added = JSON.parse(add.body) as { ok: boolean; entry: FloorEntry };
    assert.equal(added.ok, true);
    assert.ok(added.entry.floored_at);

    const invalid = await httpPost(srv.port, "/api/v1/floors", { memory_id: "m2", condition: "c" });
    assert.equal(invalid.status, 400, "missing reason is a 400");

    const list = await httpGet(srv.port, "/api/v1/floors");
    assert.equal(list.status, 200);
    assert.deepEqual((JSON.parse(list.body) as FloorsBody).floors.map((f) => f.memory_id), ["m1"]);

    // The anti-incidental-touch invariant crosses the wire: no why → 400.
    const badAffirm = await httpPost(srv.port, "/api/v1/floors/affirm", { memory_id: "m1", affirmed_by: "surface" });
    assert.equal(badAffirm.status, 400);
    assert.match(JSON.parse(badAffirm.body).error as string, /affirm requires affirmed_by AND why/);

    const goodAffirm = await httpPost(srv.port, "/api/v1/floors/affirm", {
      memory_id: "m1",
      affirmed_by: "surface",
      why: "still blocking",
    });
    assert.equal(goodAffirm.status, 200);
    assert.equal((JSON.parse(goodAffirm.body) as { entry: FloorEntry }).entry.affirmed_by, "surface");

    const rel = await httpPost(srv.port, "/api/v1/floors/release", { condition: "decision-open" });
    assert.equal(rel.status, 200);
    assert.deepEqual(JSON.parse(rel.body), { released: ["m1"] });

    const empty = await httpGet(srv.port, "/api/v1/floors");
    assert.deepEqual(JSON.parse(empty.body), { floors: [] });
  } finally {
    await srv.close();
  }
});

// ─── Survival-Arm (#153) — der dritte Arm der by-id-Invariante ───

test("survival-by-id: retire/unpin drops to ranked without delete — file and ranking identical before/during/after (#142/#153)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-floors-survival-"));
  const file = join(dir, "floored.md");
  await writeFile(file, memoryMarkdown("floored-probe", "floored survival probe", "floors-survival"), "utf8");
  await writeFile(join(dir, "other.md"), memoryMarkdown("other-probe", "unrelated other memory", "floors-survival"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const floorsPath = join(dir, "floors.json");

  // Fresh index per phase — SearchIndex caches identical queries, and a cache
  // hit would make the "identical ranking" assertion vacuous.
  const rank = (): Array<{ id: string; score: number }> => {
    const s = new SearchIndex(vault);
    s.start();
    const hits = s.recall("floored survival probe", { k: 5 });
    s.stop();
    return hits.map((h) => ({ id: h.id, score: h.score }));
  };

  try {
    const bytesBefore = await readFile(file);
    const rankBefore = rank();
    assert.ok(rankBefore.some((h) => h.id === "floored-probe"), "probe ranks before flooring");

    // FLOOR: the primitive is injection-layer-only — a daemon-side registry
    // entry, never a frontmatter write, never a score input to search.ts.
    await addFloor({ memory_id: "floored-probe", condition: "decision-open", reason: "hard constraint" }, floorsPath);
    assert.ok((await readFile(file)).equals(bytesBefore), "DURING: vault file is byte-identical");
    assert.deepEqual(rank(), rankBefore, "DURING: engine ranking is identical — the floor never touches the score");
    assert.ok(vault.get("floored-probe"), "DURING: id resolves");

    // RELEASE = drop-to-ranked, never delete: the memory just stops being
    // guaranteed-present and competes through normal ranking again.
    const released = await release("decision-open", floorsPath);
    assert.deepEqual(released, ["floored-probe"]);
    assert.ok((await readFile(file)).equals(bytesBefore), "AFTER: vault file is byte-identical");
    assert.deepEqual(rank(), rankBefore, "AFTER: engine ranking is identical");
    assert.ok(vault.get("floored-probe"), "AFTER: id still resolves — nothing evaporated");
    assert.deepEqual(await listFloors(undefined, floorsPath), [], "only the guarantee is gone, not the memory");
  } finally {
    await vault.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
