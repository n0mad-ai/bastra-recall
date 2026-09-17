import { describe, it, before, after, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGraph, graphDirOf, GRAPH_FILE_NAME } from "../src/code-graph/reader.js";
import { CodeGraphCache } from "../src/code-graph/cache.js";
import {
  AppliesToIndex,
  appliesToIndex,
  bindAppliesToVault,
  unbindAppliesToVault,
  type AppliesToVaultSource,
} from "../src/code-graph/applies-to.js";
import { appliesToDedupeKey, appliesToNote } from "../src/code-graph/applies-to-note.js";

const SAVE = "packages/core/src/save.ts";
const AUDIT = "packages/core/src/audit-save.ts";

function node(id: string, label: string, file: string) {
  return {
    id,
    label,
    file_type: "code",
    source_file: file,
    source_location: "L1",
    community: 0,
    _origin: "ast",
  };
}

/** audit-save.ts calls saveMemory in save.ts. */
const FIXTURE = {
  directed: true,
  multigraph: false,
  graph: {},
  nodes: [node("save_savememory", "saveMemory", SAVE), node("audit_auditsave", "auditSave", AUDIT)],
  links: [
    {
      source: "audit_auditsave",
      target: "save_savememory",
      relation: "calls",
      confidence: "EXTRACTED",
      confidence_score: 0.9,
      _origin: "ast",
    },
  ],
  hyperedges: [],
};

let repo: string;
let cache: CodeGraphCache;

before(async () => {
  repo = await mkdtemp(join(tmpdir(), "applies-note-"));
  await mkdir(graphDirOf(repo), { recursive: true });
  await writeFile(join(graphDirOf(repo), GRAPH_FILE_NAME), JSON.stringify(FIXTURE), "utf8");
  const r = await loadGraph(repo);
  assert.equal(r.ok, true);
  cache = new CodeGraphCache();
  await cache.ensureLoaded(repo);
});

after(async () => {
  unbindAppliesToVault();
  await rm(repo, { recursive: true, force: true });
});

const index = new AppliesToIndex([
  { id: "m-save", title: "Save path keeps optional fields", affects_files: [`${SAVE}#saveMemory`] },
  { id: "m-audit", title: "Audit rows are append-only", affects_files: [AUDIT] },
]);

const opts = (over: Record<string, unknown> = {}) => ({
  filePath: join(repo, SAVE),
  repoRoot: repo,
  index,
  cache,
  ...over,
});

describe("the applies_to block", () => {
  it("names the memory that declares the edited file", async () => {
    const note = await appliesToNote(opts());
    assert.ok(note);
    assert.match(note.note, /Names this file: Save path keeps optional fields \(m-save\) #saveMemory/);
  });

  it("separates the one-hop memory and says where it came from", async () => {
    const note = await appliesToNote(opts());
    assert.ok(note);
    assert.match(note.note, /Attached to a file that depends on it[^\n]*m-audit[^\n]*via packages\/core\/src\/audit-save\.ts/);
  });

  it("never claims required — every line is optional on this path", async () => {
    const note = await appliesToNote(opts());
    assert.ok(note);
    assert.match(note.note, /All of these are optional/);
    assert.equal(/required/.test(note.note), false);
  });

  it("keeps the direct half when the graph is cold", async () => {
    const note = await appliesToNote(opts({ cache: new CodeGraphCache() }));
    assert.ok(note);
    assert.equal(note.candidates.length, 1);
    assert.equal(note.candidates[0]?.hop, "direct");
  });

  it("is silent for a file nothing declares", async () => {
    assert.equal(await appliesToNote(opts({ filePath: join(repo, "packages/core/src/other.ts") })), null);
  });

  it("is silent for a path outside the anchor, and for a relative one", async () => {
    assert.equal(await appliesToNote(opts({ filePath: "/elsewhere/save.ts" })), null);
    assert.equal(await appliesToNote(opts({ filePath: SAVE })), null);
  });

  it("is silent without a bound index", async () => {
    assert.equal(await appliesToNote(opts({ index: null })), null);
  });

  it("is silent once the block was shown for this file in this session", async () => {
    const key = appliesToDedupeKey(SAVE);
    const session = { shown: { [key]: { count: 1, at: Date.now() } } };
    assert.equal(await appliesToNote(opts({ session })), null);
  });

  it("is silent when code awareness is switched off", async () => {
    process.env.BASTRA_CODE_AWARENESS = "off";
    try {
      assert.equal(await appliesToNote(opts()), null);
    } finally {
      delete process.env.BASTRA_CODE_AWARENESS;
    }
  });
});

describe("the process-wide index", () => {
  afterEach(() => {
    unbindAppliesToVault();
  });

  function fakeVault(): AppliesToVaultSource & { memories: Array<{ fm: { id: string; affects_files: string[] } }>; fire: () => void } {
    const listeners = new Set<() => void>();
    return {
      memories: [{ fm: { id: "m1", affects_files: [SAVE] } }],
      list() {
        return this.memories;
      },
      on(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      fire() {
        for (const l of listeners) l();
      },
    };
  }

  it("answers null until a vault is bound", () => {
    assert.equal(appliesToIndex(), null);
  });

  it("builds from the bound vault and caches the build", () => {
    bindAppliesToVault(fakeVault());
    const first = appliesToIndex();
    assert.ok(first);
    assert.deepEqual(first.directOn(SAVE).map((c) => c.memoryId), ["m1"]);
    assert.equal(appliesToIndex(), first, "a second call reuses the build");
  });

  it("rebuilds when the vault says something changed", () => {
    const vault = fakeVault();
    bindAppliesToVault(vault);
    const first = appliesToIndex();
    vault.memories.push({ fm: { id: "m2", affects_files: [SAVE] } });
    assert.equal(appliesToIndex(), first, "a change nobody announced does not rebuild");
    vault.fire();
    const second = appliesToIndex();
    assert.notEqual(second, first);
    assert.deepEqual(second?.directOn(SAVE).map((c) => c.memoryId), ["m1", "m2"]);
  });

  it("lets go of the listener on unbind", () => {
    const vault = fakeVault();
    const release = bindAppliesToVault(vault);
    release();
    assert.equal(appliesToIndex(), null);
    vault.fire(); // must not resurrect anything
    assert.equal(appliesToIndex(), null);
  });
});
