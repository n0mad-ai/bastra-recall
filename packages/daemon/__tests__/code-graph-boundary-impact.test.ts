import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadGraph,
  graphDirOf,
  GRAPH_FILE_NAME,
  type LoadedGraph,
} from "../src/code-graph/reader.js";
import {
  boundaryImpact,
  type BookedHit,
  type BoundaryTouch,
} from "../src/code-graph/boundary-impact.js";
import { MIN_BOUNDARY_MISSED_FILES, boundaryNote } from "../src/code-graph/boundary-block.js";
import {
  MAX_TOUCHED_CHARS,
  MAX_TOUCHED_FILES,
  parkBoundary,
  recordTouched,
  type ReadonlySessionState,
  type SessionState,
} from "../src/session-state.js";

/**
 * REVERT-CHECK, so this file is a guard and not a receipt. Each line below was
 * broken once, by hand, and the named case went red:
 *   boundary-impact.ts
 *   - drop `if (written.has(hit.file)) continue;` → "drops a dependent the task
 *     wrote" — a file the agent edited comes back as forgotten.
 *   - answer an unplaced touch with `[]` instead of asking the graph →
 *     "asks the current graph about an edit the lane could not look at".
 *   - drop the `unanswered.push` → "says which files it could not ask about".
 *   - stop filtering `missed` on `readAfter` → "moves a dependent read after
 *     the change to seen".
 *   boundary-block.ts
 *   - drop the mtime check → "ignores a booking the disk never confirmed".
 *   - count every timed read, not only those past the change → "does not
 *     count a read from before the change".
 *   - drop the `touchedOverflow` return → "is silent once the accumulator
 *     overflowed".
 *   - drop the `gone` branch → "does not read a deleted file the graph already
 *     dropped as 'nothing depends on it'".
 *   - `continue` on empty `missed` alone → "renders unanswered alongside missed
 *     dependents from another repository, in one block".
 *   - drop the `allows()` check in the repo loop → "says nothing about a
 *     repository code awareness is off for".
 *   - let `unanswered` render without a graph → "says nothing when there was no
 *     graph to ask at all".
 *   - drop the volume gate → "stays under the volume gate at two files".
 *   - put back `&& unanswered === 0` on the volume gate (#612, owner call) →
 *     "a single unanswered file no longer buys its way past the volume gate".
 *   boundary-impact.ts
 *   - push a deleted NON-code file into `unanswered` → "does not claim unknown
 *     dependents for a deleted file the graph could never have held".
 *   session-state.ts
 *   - drop the character budget → "overflows on characters, not only on counts".
 *   - drop the `builtFrom` comparison → "does not let an older Stop overwrite".
 *   - clear `unplaced` on a later sighted edit → "keeps a file unplaced once
 *     any edit of it was blind".
 */

/** Graphify's real node shape, same helper the affected test uses. */
function node(id: string, label: string, file: string, line = 1) {
  return {
    id,
    label,
    file_type: "code",
    source_file: file,
    source_location: `L${line}`,
    community: 0,
    _origin: "ast",
  };
}

function edge(source: string, target: string, relation: string) {
  return {
    source,
    target,
    relation,
    confidence: "EXTRACTED",
    confidence_score: 0.9,
    _origin: "ast",
  };
}

// The graph AFTER the task: `saveMemory` was deleted from `src/save.ts`, and
// with it every edge that pointed at it. Only `keep()` and its one caller are
// left. This is the graph the Stop lane really has (the watcher reindexes
// after each edit), and the reason hits are booked at edit time.
const GRAPH_AFTER = {
  directed: true,
  multigraph: false,
  graph: {},
  built_at_commit: "0000000000000000000000000000000000000000",
  nodes: [
    node("keep_fn", "keep()", "src/save.ts", 1),
    node("user_fn", "useKeep()", "src/user.ts", 1),
    node("audit_fn", "auditSave()", "src/audit.ts", 1),
    node("report_fn", "buildReport()", "src/report.ts", 1),
  ],
  links: [edge("user_fn", "keep_fn", "calls")],
  hyperedges: [],
};

/** What the Write/Edit lane booked the moment before `saveMemory` went away. */
const BOOKED: BookedHit[] = [
  { file: "src/audit.ts", location: "src/audit.ts:1", via: "saveMemory", relation: "calls" },
  { file: "src/report.ts", location: "src/report.ts:1", via: "saveMemory", relation: "calls" },
];

let root: string;
let graph: LoadedGraph;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "bastra-boundary-"));
  const files: Array<[string, string]> = [
    ["package.json", JSON.stringify({ name: "acme" })],
    ["src/save.ts", "export function keep() {}\n"],
    ["src/user.ts", 'import { keep } from "./save.js";\nexport function useKeep() { keep(); }\n'],
    ["src/audit.ts", "export function auditSave() {}\n"],
    ["src/report.ts", "export function buildReport() {}\n"],
  ];
  for (const [path, body] of files) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), body, "utf8");
  }
  await mkdir(graphDirOf(root), { recursive: true });
  await writeFile(join(graphDirOf(root), GRAPH_FILE_NAME), JSON.stringify(GRAPH_AFTER), "utf8");
  const loaded = await loadGraph(root);
  assert.equal(loaded.ok, true);
  graph = (loaded as { ok: true; graph: LoadedGraph }).graph;
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const placed = (file: string, hits: BookedHit[] = []): BoundaryTouch => ({ file, hits });
const blind = (file: string): BoundaryTouch => ({ file, hits: null });

describe("boundary impact — the pure sum", () => {
  it("names the callers of a symbol the task deleted, which the current graph forgot", () => {
    const result = boundaryImpact(graph, [placed("src/save.ts", BOOKED)]);

    // The current graph has no `saveMemory` and no edge to it. Asking it would
    // return `src/user.ts` at best. The booked hits are the only witness.
    assert.deepEqual(
      result.missed.map((m) => [m.file, m.via, m.basis, m.changedFile]),
      [
        ["src/audit.ts", "saveMemory", "edit_time", "src/save.ts"],
        ["src/report.ts", "saveMemory", "edit_time", "src/save.ts"],
      ],
    );
    assert.equal(result.truncated, false);
  });

  it("drops a dependent the task wrote — that is the whole point", () => {
    const result = boundaryImpact(graph, [placed("src/save.ts", BOOKED), placed("src/audit.ts")]);

    assert.deepEqual(
      result.missed.map((m) => m.file),
      ["src/report.ts"],
    );
  });

  it("stays silent when nothing depended on what changed", () => {
    const result = boundaryImpact(graph, [placed("src/report.ts")]);

    assert.deepEqual(result.missed, []);
    assert.deepEqual(result.unanswered, []);
  });

  it("asks the current graph about an edit the lane could not look at", () => {
    const result = boundaryImpact(graph, [blind("src/save.ts")]);

    // Late and whole-file, and it says so — but not silence.
    assert.deepEqual(
      result.missed.map((m) => [m.file, m.basis]),
      [["src/user.ts", "whole_file_now"]],
    );
  });

  it("says which files it could not ask about when there is no graph", () => {
    const result = boundaryImpact(null, [blind("src/save.ts"), placed("src/x.ts", BOOKED)]);

    assert.deepEqual(result.unanswered, ["src/save.ts"]);
    // The booked half of the answer does not need a graph at all.
    assert.equal(result.missed.length, 2);
  });

  it("does not read a deleted file the graph already dropped as 'nothing depends on it'", () => {
    const result = boundaryImpact(graph, [{ file: "src/removed.ts", hits: null, gone: true }]);

    assert.deepEqual(result.missed, []);
    assert.deepEqual(result.unanswered, ["src/removed.ts"]);
  });

  it("does not claim unknown dependents for a deleted file the graph could never have held", () => {
    // A deleted CHANGELOG.md is unknown to the graph because it was never
    // indexed, not because the reindex forgot it. "Dependents unknown" about it
    // is a claim with nothing behind it.
    const result = boundaryImpact(graph, [{ file: "CHANGELOG.md", hits: null, gone: true }]);

    assert.deepEqual(result.missed, []);
    assert.deepEqual(result.unanswered, []);
  });

  it("moves a dependent read after the change to seen, and keeps counting it", () => {
    const result = boundaryImpact(graph, [placed("src/save.ts", BOOKED)], {
      readAfter: ["src/report.ts"],
    });

    assert.deepEqual(
      result.missed.map((m) => m.file),
      ["src/audit.ts"],
    );
    assert.deepEqual(result.seen, ["src/report.ts"]);
  });

  it("passes a package-level hit through like any other", () => {
    const pkg: BookedHit = {
      file: "packages/cli/src/main.ts",
      location: "packages/cli/src/main.ts",
      via: "packages/core/src/index.ts",
      relation: "package_import",
    };
    const result = boundaryImpact(null, [placed("packages/core/src/save.ts", [pkg])]);

    assert.deepEqual(
      result.missed.map((m) => m.relation),
      ["package_import"],
    );
  });

  it("orders by path so the same session renders the same block twice", () => {
    const a = boundaryImpact(graph, [placed("src/save.ts", BOOKED), blind("src/report.ts")]);
    const b = boundaryImpact(graph, [blind("src/report.ts"), placed("src/save.ts", BOOKED)]);

    assert.deepEqual(a, b);
  });

  it("caps the list and says so", () => {
    const result = boundaryImpact(graph, [placed("src/save.ts", BOOKED)], { maxMissed: 1 });

    assert.equal(result.missed.length, 1);
    assert.equal(result.truncated, true);
  });
});

describe("boundary block — what the Stop lane parks", () => {
  const REPO = "/repo";
  const T0 = 1_000_000;

  // Four dependents, because the volume gate (MIN_BOUNDARY_MISSED_FILES) is
  // about how many unopened files are worth a turn: a fixture at the gate could
  // not tell a case that went silent from one that fell under it.
  const BOOKED_FOUR: BookedHit[] = [
    ...BOOKED,
    { file: "src/notify.ts", location: "src/notify.ts:1", via: "saveMemory", relation: "calls" },
    { file: "src/mail.ts", location: "src/mail.ts:1", via: "saveMemory", relation: "calls" },
  ];

  function session(mutate?: (s: SessionState) => void): ReadonlySessionState {
    const s: SessionState = { shown: {} };
    recordTouched(s, REPO, "src/save.ts", BOOKED_FOUR, false, T0);
    if (mutate !== undefined) mutate(s);
    return s;
  }
  // Booked hits are the graph AS IT WAS; answering from them needs no graph at
  // all, which is why this stub is enough for every case about `missed`.
  const cache = { get: () => null };
  const withGraph = { get: () => graph };
  const written = async () => T0 + 50;

  it("renders the missed dependents of a confirmed write", async () => {
    const built = await boundaryNote({ session: session(), cache, mtimeOf: written });

    assert.notEqual(built, null);
    assert.equal(built!.files, 4);
    assert.match(built!.note, /src\/audit\.ts:1 — calls saveMemory \(src\/save\.ts\)/);
    assert.match(built!.note, /src\/report\.ts:1/);
  });

  it("ignores a booking the disk never confirmed", async () => {
    // The lane fires before the tool runs. The call was denied; the file still
    // carries an mtime from long before the booking.
    const built = await boundaryNote({
      session: session(),
      cache,
      mtimeOf: async () => T0 - 60_000,
    });

    assert.equal(built, null);
  });

  it("treats a file that is gone as written", async () => {
    const built = await boundaryNote({ session: session(), cache, mtimeOf: async () => null });

    assert.equal(built?.files, 4);
  });

  it("does not count a read from before the change", async () => {
    const built = await boundaryNote({
      session: session(),
      cache,
      mtimeOf: written,
      reads: [
        { path: "/repo/src/audit.ts", at: T0 - 1 },
        { path: "/repo/src/report.ts", at: T0 + 1 },
        { path: "/repo/src/audit.ts", at: null },
      ],
    });

    assert.equal(built?.files, 3);
    assert.match(built!.note, /src\/audit\.ts:1/);
    assert.match(built!.note, /1 more dependent file was read after the change/);
  });

  it("is silent when every dependent was read after the change", async () => {
    const built = await boundaryNote({
      session: session(),
      cache,
      mtimeOf: written,
      reads: BOOKED_FOUR.map((h) => ({ path: `/repo/${h.file}`, at: T0 + 1 })),
    });

    assert.equal(built, null);
  });

  it("stays under the volume gate at two files, and speaks at three", async () => {
    const few = (n: number): ReadonlySessionState => {
      const s: SessionState = { shown: {} };
      recordTouched(s, REPO, "src/save.ts", BOOKED_FOUR.slice(0, n), false, T0);
      return s;
    };

    assert.equal(MIN_BOUNDARY_MISSED_FILES, 3);
    assert.equal(await boundaryNote({ session: few(2), cache, mtimeOf: written }), null);
    assert.equal((await boundaryNote({ session: few(3), cache, mtimeOf: written }))?.files, 3);
  });

  it("is silent for an answer already given, and speaks again when it grows", async () => {
    const first = await boundaryNote({ session: session(), cache, mtimeOf: written });
    const told = session((s) => {
      s.shown[first!.dedupeKey] = { count: 1, at: T0 };
    });
    assert.equal(await boundaryNote({ session: told, cache, mtimeOf: written }), null);

    const grown = session((s) => {
      s.shown[first!.dedupeKey] = { count: 1, at: T0 };
      recordTouched(
        s,
        REPO,
        "src/other.ts",
        [{ file: "src/far.ts", location: "src/far.ts:9", via: "other", relation: "calls" }],
        false,
        T0,
      );
    });
    const again = await boundaryNote({ session: grown, cache, mtimeOf: written });
    assert.equal(again?.files, 5);
  });

  it("stays under the volume gate on a single unanswered file — owner call, #612: could not look is no longer a free pass", async () => {
    // Used to speak on its own: "Dependents unknown" and nothing else, a whole
    // turn for one line. The volume gate exists to ration exactly that, and
    // `unanswered` was the one section that skipped it. The owner's call was
    // to count `files` only — a lone deleted file the reindex forgot now stays
    // silent, same as a lone missed dependent would.
    const s: SessionState = { shown: {} };
    recordTouched(s, REPO, "src/removed.ts", null, false, T0);
    const built = await boundaryNote({ session: s, cache: withGraph, mtimeOf: async () => null });

    assert.equal(built, null);
  });

  it("renders unanswered alongside missed dependents from another repository, in one block — the header only claims missed dependents where there are some", async () => {
    // Two repositories in one session: repoA clears the volume gate on its own
    // three missed dependents; repoB has nothing but a deleted file the
    // reindexed graph already forgot. repoB's section rides along INSIDE the
    // block repoA's count earned — that is the "own strength" the gate now
    // requires (`boundary-block.ts`'s comment on `MIN_BOUNDARY_MISSED_FILES`).
    const REPO_A = "/repoA";
    const REPO_B = "/repoB";
    const s: SessionState = { shown: {} };
    recordTouched(s, REPO_A, "src/save.ts", BOOKED_FOUR.slice(0, 3), false, T0);
    recordTouched(s, REPO_B, "src/removed.ts", null, false, T0);

    const built = await boundaryNote({
      session: s,
      cache: withGraph,
      mtimeOf: async (p: string) => (p.endsWith("removed.ts") ? null : T0 + 50),
    });

    assert.notEqual(built, null);
    // Only repoA's missed dependents count toward `files` — repoB contributed
    // none of its own, just the section it rides in on.
    assert.equal(built!.files, 3);
    assert.match(built!.note, /\(\/repoA\): files written in this session had dependents/);
    assert.match(built!.note, /Not opened \(3 candidate files\):/);
    assert.match(built!.note, /Dependents unknown — no graph could be asked about: src\/removed\.ts\./);
    // repoB never claims dependents it does not have — see the render() fix.
    assert.match(built!.note, /\(\/repoB\): dependents of files written in this session could not be asked about/);
    assert.doesNotMatch(built!.note, /\(\/repoB\): files written in this session had dependents/);
  });

  it("says nothing when there was no graph to ask at all", async () => {
    // `get()` answers null for a cold, loading or degraded graph. Every touch
    // then lands in `unanswered`, and a block built from that describes the
    // graph's state, not the task.
    const s: SessionState = { shown: {} };
    recordTouched(s, REPO, "src/save.ts", null, false, T0);

    assert.equal(await boundaryNote({ session: s, cache, mtimeOf: written }), null);
  });

  it("says nothing about a repository code awareness is off for", async () => {
    // `bastra code disable` after the edits were booked: the bookings are still
    // in the table, and the cache answers null for the graph exactly as it does
    // when one is merely cold.
    const off = { get: () => null, allows: () => false };

    assert.equal(await boundaryNote({ session: session(), cache: off, mtimeOf: written }), null);
  });

  it("is silent once the accumulator overflowed", async () => {
    const full = session((s) => {
      for (let i = 0; i <= MAX_TOUCHED_FILES; i++) {
        recordTouched(s, REPO, `src/f${i}.ts`, [], false, T0);
      }
    });

    assert.equal(full.touchedOverflow, true);
    assert.equal(await boundaryNote({ session: full, cache, mtimeOf: written }), null);
  });
});

describe("recordTouched — the accumulator", () => {
  it("overflows on characters, not only on counts", () => {
    const s: SessionState = { shown: {} };
    const long = "x".repeat(500);
    for (let f = 0; f < 60 && s.touchedOverflow !== true; f++) {
      const hits = Array.from({ length: 40 }, (_, i) => ({
        file: `${long}/${f}/${i}.ts`,
        location: `${long}/${f}/${i}.ts:1`,
        via: long,
        relation: "calls",
      }));
      recordTouched(s, "/r", `src/f${f}.ts`, hits, false, 1);
    }

    assert.equal(s.touchedOverflow, true);
    assert.ok(JSON.stringify(s.touched).length < 2 * MAX_TOUCHED_CHARS);
  });

  it("does not let an older Stop overwrite a newer one's block", () => {
    const s: SessionState = { shown: {} };
    parkBoundary(s, { note: "NEW", dedupeKey: "k2", files: 3 }, 200);
    parkBoundary(s, { note: "OLD", dedupeKey: "k1", files: 4 }, 100);
    assert.equal(s.boundary?.note, "NEW");
    parkBoundary(s, null, 100);
    assert.equal(s.boundary?.note, "NEW");
    parkBoundary(s, null, 300);
    assert.equal(s.boundary, undefined);
  });

  it("unions dependents across edits of one file, one per dependent file", () => {
    const s: SessionState = { shown: {} };
    recordTouched(s, "/r", "a.ts", [BOOKED[0]!], false, 1);
    recordTouched(s, "/r", "a.ts", BOOKED, false, 2);

    const entry = s.touched!.get("/r")!.get("a.ts")!;
    assert.deepEqual(
      entry.hits.map((h) => h.file),
      ["src/audit.ts", "src/report.ts"],
    );
    assert.equal(entry.at, 1);
    assert.equal(entry.last, 2);
  });

  it("keeps a file unplaced once any edit of it was blind", () => {
    const s: SessionState = { shown: {} };
    recordTouched(s, "/r", "a.ts", null, false, 1);
    recordTouched(s, "/r", "a.ts", BOOKED, false, 2);

    assert.equal(s.touched!.get("/r")!.get("a.ts")!.unplaced, true);
  });
});
