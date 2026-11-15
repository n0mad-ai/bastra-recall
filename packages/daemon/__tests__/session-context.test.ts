/**
 * Tests für den Session-Kontext hookless Clients (Claude Desktop, Cursor):
 *   - buildSessionContext — Assembly aus pinned/hints/conventions/offenen
 *     Workflows, projekt-gescopte Floors raus, leere Quellen = leerer Block
 *   - Tool-Annotations — Lese-Tools tragen readOnlyHint, Schreib-Tools nicht
 *
 * Runner: `tsx --test __tests__/session-context.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionContext } from "../src/session-context.js";
import { MEMORY_TOOL_DEFS } from "../src/tool-handlers.js";
import { documentTools } from "../src/documents-handler.js";
import type { ToolDeps } from "../src/tool-handlers.js";
import type { Vault } from "@bastra-recall/core";

function fakeVault(size: number, memories: Record<string, { title: string; summary: string }>): Vault {
  return {
    size: () => size,
    get: (id: string) => {
      const m = memories[id];
      return m ? { fm: { title: m.title, summary: m.summary } } : undefined;
    },
  } as unknown as Vault;
}

test("buildSessionContext: assembles pinned + hints + conventions + open workflows, drops scoped floors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-sc-"));
  try {
    await writeFile(
      join(dir, "vault-care.md"),
      "# Vault Care\n\n- [ ] 2026-07-01 · delete · [[stale-memory]]\n- [x] 2026-07-01 · edit · [[done-memory]] — fixed\n",
      "utf8"
    );
    await writeFile(
      join(dir, "import-review.md"),
      "# Import Review\n\n- [ ] 2026-07-17 · chatgpt · Prefers dark mode everywhere\n",
      "utf8"
    );
    const vault = fakeVault(42, {
      "pinned-rule": { title: "Pinned rule", summary: "Never push without explicit instruction" },
    });
    const context = await buildSessionContext({ vaultPath: dir } as unknown as ToolDeps, vault, {
      recallFn: (async () => ({
        hits: [
          { id: "user-profile", type: "user-preference", summary: "German, informal, terse", score: 140 },
          { id: "below-floor", type: "lesson", summary: "noise", score: 12 },
        ],
      })) as never,
      listFloorsFn: (async () => [
        { memory_id: "pinned-rule", condition: "c", reason: "r", added_at: "2026-07-01" },
        { memory_id: "project-only", condition: "c", reason: "r", scope: "someproject", added_at: "2026-07-01" },
      ]) as never,
      listConventionsFn: (() => [
        { id: "people-convention", title: "People", summary: "one memo per person", updated: "2026-07-01" },
      ]) as never,
    });

    assert.match(context, /<bastra-session-context>/);
    assert.match(context, /vault: 42 memories/);
    assert.match(context, /\[pinned\] pinned-rule: Never push without explicit instruction/);
    assert.ok(!context.includes("project-only"), "project-scoped floor stays out of a hookless session");
    assert.match(context, /user-profile \(user-preference\): German, informal, terse/);
    assert.ok(!context.includes("below-floor"), "hits under the score floor stay out");
    assert.match(context, /Conventions \(BINDING.*people-convention/);
    assert.match(context, /Vault care: 1 open flag/);
    assert.match(context, /Import review: 1 open candidate/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("buildSessionContext: everything empty → empty string (no block spam)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-sc-empty-"));
  try {
    const context = await buildSessionContext({ vaultPath: dir } as unknown as ToolDeps, fakeVault(500, {}), {
      recallFn: (async () => ({ hits: [] })) as never,
      listFloorsFn: (async () => []) as never,
      listConventionsFn: (() => []) as never,
    });
    assert.equal(context, "");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("tool annotations: read tools carry readOnlyHint, write tools do not", () => {
  const all = [...MEMORY_TOOL_DEFS, ...documentTools] as Array<{
    name: string;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  }>;
  const byName = new Map(all.map((t) => [t.name, t]));
  for (const name of ["recall", "load_memory", "find_document", "read_document"]) {
    const t = byName.get(name);
    assert.ok(t, `${name} def exists`);
    assert.equal(t?.annotations?.readOnlyHint, true, `${name} is read-only`);
    assert.equal(t?.annotations?.destructiveHint, false, `${name} is non-destructive`);
  }
  assert.equal(byName.get("save_memory")?.annotations, undefined, "save_memory must NOT claim read-only");
});
