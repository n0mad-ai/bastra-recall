import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  safeString,
  safeRepoPath,
  safeLine,
  safeNode,
  safeEdge,
} from "../src/code-graph/validate.js";
import { CODE_FILE_TYPE, EXTRACTED, MAX_STRING_BYTES } from "../src/code-graph/limits.js";

/**
 * `graph.json` is written by a third-party tool into a repository we do not
 * own, and everything in it can end up verbatim in an agent's context. These
 * are the adversarial cases the pre-build counter-review said the planned
 * format guard did not cover (#575).
 */
describe("code graph: untrusted strings", () => {
  it("strips control characters instead of passing them through", () => {
    assert.equal(safeString("save\u0007Memory"), "saveMemory");
    assert.equal(safeString("a\u001Bb"), "ab");
  });

  it("strips bidirectional overrides, which change how a path renders", () => {
    assert.equal(safeString("safe\u202Egnp.exe"), "safegnp.exe");
  });

  it("refuses a string over the byte limit rather than truncating it", () => {
    assert.equal(safeString("x".repeat(MAX_STRING_BYTES + 1)), null);
    assert.equal(safeString("x".repeat(MAX_STRING_BYTES)), "x".repeat(MAX_STRING_BYTES));
  });

  it("measures the limit in bytes, not code units", () => {
    // Four bytes per emoji: a string well under the limit by .length is over
    // it by the measure that actually bounds context.
    const emoji = "\u{1F600}".repeat(MAX_STRING_BYTES / 4 + 1);
    assert.ok(emoji.length < MAX_STRING_BYTES);
    assert.equal(safeString(emoji), null);
  });

  it("refuses non-strings and strings that are empty after stripping", () => {
    assert.equal(safeString(42), null);
    assert.equal(safeString(null), null);
    assert.equal(safeString(undefined), null);
    assert.equal(safeString("\u0000\u0001"), null);
  });
});

describe("code graph: untrusted paths", () => {
  it("accepts a normal repo-relative path", () => {
    assert.equal(safeRepoPath("packages/core/src/save.ts"), "packages/core/src/save.ts");
  });

  it("refuses traversal, in both separator styles", () => {
    assert.equal(safeRepoPath("../../etc/passwd"), null);
    assert.equal(safeRepoPath("packages/../../etc/passwd"), null);
    // Backslashes are normalized BEFORE the check, so this must not slip past.
    assert.equal(safeRepoPath("..\\..\\etc\\passwd"), null);
  });

  it("refuses absolute, drive-letter and UNC paths", () => {
    assert.equal(safeRepoPath("/etc/passwd"), null);
    assert.equal(safeRepoPath("C:\\Windows\\System32"), null);
    assert.equal(safeRepoPath("\\\\server\\share"), null);
  });

  it("refuses a NUL byte outright rather than cleaning it into a valid path", () => {
    assert.equal(safeRepoPath("packages/core\u0000/save.ts"), null);
  });

  it("normalizes redundant segments", () => {
    assert.equal(safeRepoPath("./packages//core/src/save.ts"), "packages/core/src/save.ts");
  });

  it("refuses a path that normalizes to nothing", () => {
    assert.equal(safeRepoPath("."), null);
    assert.equal(safeRepoPath("///"), null);
  });
});

describe("code graph: source locations", () => {
  it("parses Graphify's L-prefixed line numbers", () => {
    assert.equal(safeLine("L42"), 42);
  });

  it("drops a malformed location rather than guessing", () => {
    assert.equal(safeLine("42"), null);
    assert.equal(safeLine("L0"), null);
    assert.equal(safeLine("L-3"), null);
    assert.equal(safeLine("Labc"), null);
    assert.equal(safeLine(undefined), null);
  });
});

describe("code graph: node and edge allowlist", () => {
  const node = {
    id: "packages_core_src_save_savememory",
    label: "saveMemory",
    file_type: CODE_FILE_TYPE,
    source_file: "packages/core/src/save.ts",
    source_location: "L40",
    community: 3,
    _origin: "ast",
    secret_field: "must not survive",
  };

  it("keeps only the allowlisted fields", () => {
    const n = safeNode(node, CODE_FILE_TYPE);
    assert.ok(n);
    assert.deepEqual(Object.keys(n!).sort(), ["community", "file", "id", "label", "line"]);
    assert.equal(n!.file, "packages/core/src/save.ts");
    assert.equal(n!.line, 40);
  });

  it("drops non-code nodes, which exist even under --code-only", () => {
    // Measured on the real graph: 220 `concept` and 24 `rationale` nodes,
    // with ids like `docref_rfc_6761`. They are not navigable locations.
    assert.equal(safeNode({ ...node, file_type: "concept" }, CODE_FILE_TYPE), null);
    assert.equal(safeNode({ ...node, file_type: "rationale" }, CODE_FILE_TYPE), null);
  });

  it("drops a node whose path escapes the repository", () => {
    assert.equal(safeNode({ ...node, source_file: "../../../etc/passwd" }, CODE_FILE_TYPE), null);
  });

  it("keeps a node whose line number is unusable, without the line", () => {
    const n = safeNode({ ...node, source_location: "nonsense" }, CODE_FILE_TYPE);
    assert.ok(n);
    assert.equal(n!.line, null);
  });

  it("admits extracted edges and refuses inferred ones per EDGE", () => {
    // `calls` carries 4363 extracted and 153 inferred edges in the real graph,
    // so the relation name alone cannot decide this.
    const base = { source: "a", target: "b", relation: "calls" };
    assert.ok(safeEdge({ ...base, confidence: EXTRACTED }, EXTRACTED));
    assert.equal(safeEdge({ ...base, confidence: "INFERRED" }, EXTRACTED), null);
    assert.equal(safeEdge(base, EXTRACTED), null);
  });
});

import {
  MAX_GRAPH_BYTES as DOC_MAX_GRAPH_BYTES,
  MAX_NODES as DOC_MAX_NODES,
  MAX_EDGES as DOC_MAX_EDGES,
  MAX_TOTAL_HEAP_BYTES as DOC_MAX_TOTAL_HEAP_BYTES,
} from "../src/code-graph/limits.js";

describe("code-graph limits are the numbers the architecture doc promises", () => {
  // docs/Evolution Architecture V1 to V2.md, C-093: "(64 MB file size, 500,000 nodes,
  // 2,000,000 edges, 512 bytes per string)"; LRU heap budget: "256 MB". Every other test
  // here reads its expectation through these same constants, so a changed limit stayed
  // green (night 09-22). The doc names the numbers — so does this test, as literals.
  it("file size 64 MB, 500,000 nodes, 2,000,000 edges, 512 bytes per string, 256 MB heap", () => {
    assert.equal(DOC_MAX_GRAPH_BYTES, 64 * 1024 * 1024);
    assert.equal(DOC_MAX_NODES, 500_000);
    assert.equal(DOC_MAX_EDGES, 2_000_000);
    assert.equal(MAX_STRING_BYTES, 512);
    assert.equal(DOC_MAX_TOTAL_HEAP_BYTES, 256 * 1024 * 1024);
  });
});
