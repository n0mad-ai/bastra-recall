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
import { boundaryNote } from "../src/code-graph/boundary-block.js";
import {
  MAX_TOUCHED_FILES,
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
 *   session-state.ts
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

  function session(mutate?: (s: SessionState) => void): ReadonlySessionState {
    const s: SessionState = { shown: {} };
    recordTouched(s, REPO, "src/save.ts", BOOKED, false, T0);
    if (mutate !== undefined) mutate(s);
    return s;
  }
  const cache = { get: () => null };
  const written = async () => T0 + 50;

  it("renders the missed dependents of a confirmed write", async () => {
    const built = await boundaryNote({ session: session(), cache, mtimeOf: written });

    assert.notEqual(built, null);
    assert.equal(built!.files, 2);
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

    assert.equal(built?.files, 2);
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

    assert.equal(built?.files, 1);
    assert.match(built!.note, /src\/audit\.ts:1/);
    assert.match(built!.note, /1 more dependent file was read after the change/);
  });

  it("is silent when every dependent was read after the change", async () => {
    const built = await boundaryNote({
      session: session(),
      cache,
      mtimeOf: written,
      reads: BOOKED.map((h) => ({ path: `/repo/${h.file}`, at: T0 + 1 })),
    });

    assert.equal(built, null);
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
    assert.equal(again?.files, 3);
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
  it("unions dependents across edits of one file, one per dependent file", () => {
    const s: SessionState = { shown: {} };
    recordTouched(s, "/r", "a.ts", [BOOKED[0]!], false, 1);
    recordTouched(s, "/r", "a.ts", BOOKED, false, 2);

    const entry = s.touched!["/r"]!["a.ts"]!;
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

    assert.equal(s.touched!["/r"]!["a.ts"]!.unplaced, true);
  });
});
