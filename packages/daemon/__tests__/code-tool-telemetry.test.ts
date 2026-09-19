/**
 * The row a `find_code` / `find_affected_files` call leaves behind (#589).
 *
 * Two things are load-bearing and neither is arithmetic:
 *
 *   1. PRIVACY. The query, the file, the symbol names and the absolute
 *      repository path are what the user is working on. The row carries shapes,
 *      and this test fails the moment one of them leaks in.
 *   2. The `unavailable` reason is CLASSIFIED, not parsed out of the note the
 *      agent reads. A note is written for a language model and will be reworded;
 *      a reason code is a column.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/code-tool-telemetry.test.ts`
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeGraphCache } from "../src/code-graph/cache.js";
import { findCode } from "../src/code-graph/find-code.js";
import { findCodeEvent, findAffectedFilesEvent } from "../src/code-graph/tool-telemetry.js";
import { unavailableReason } from "../src/code-graph/unavailable-reason.js";

/** A cache that allows nothing — the "not enabled" world, without touching settings. */
const refusingCache = (): CodeGraphCache => {
  const c = new CodeGraphCache();
  (c as unknown as { allows: (r: string) => boolean }).allows = () => false;
  return c;
};

describe("code tool telemetry", () => {
  it("carries shapes, never the query or an absolute path", () => {
    const repo = mkdtempSync(join(tmpdir(), "bastra-code-tel-"));
    const cache = refusingCache();
    const args = { query: "a-very-private-symbol-name", repo };
    const result = findCode(cache, args);
    const row = findCodeEvent(cache, args, result, { surface: "mcp" });

    const serialized = JSON.stringify(row);
    assert.ok(!serialized.includes("a-very-private-symbol-name"), "the query must not be in the row");
    assert.ok(!serialized.includes(repo), "the absolute repo path must not be in the row");
    assert.equal(row.tool, "find_code");
    assert.equal(row.status, "unavailable");
    assert.equal(row.surface, "mcp");
    assert.equal(row.caller_session, null);
    assert.equal(typeof row.took_ms, "number");
  });

  it("classifies why the graph could not answer", () => {
    const repo = mkdtempSync(join(tmpdir(), "bastra-code-tel-"));
    const cache = refusingCache();
    const args = { query: "x", repo };
    const row = findCodeEvent(cache, args, findCode(cache, args), { surface: "mcp" });
    assert.equal(row.unavailable_reason, "not_enabled");
    assert.equal(unavailableReason(cache, repo), "not_enabled");
  });

  it("does not stamp a reason on an answer that was not unavailable", () => {
    const cache = refusingCache();
    const row = findAffectedFilesEvent(
      cache,
      { file: "src/a.ts" },
      {
        status: "no_answer",
        files: [],
        hits: [],
        truncated: false,
        note: "…",
        took_ms: 1,
      },
      { surface: "http", callerSession: "sess-1" },
    );
    assert.equal(row.unavailable_reason, undefined);
    assert.equal(row.tool, "find_affected_files");
    assert.equal(row.caller_session, "sess-1");
    assert.equal(row.files, 0);
  });
});
