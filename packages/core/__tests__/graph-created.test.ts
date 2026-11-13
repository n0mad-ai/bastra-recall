import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph } from "../src/graph.js";
import type { Vault } from "../src/vault.js";
import type { Memory } from "../src/schema.js";

function projected(created: string): string | undefined {
  const m = { fm: { id: "fixture", title: "Fixture", type: "project-fact", scope: "test", tags: [], related: [], related_via: [], created, updated: "2026-11-12" }, filePath: "/vault/memories/projects/test/fixture.md" } as unknown as Memory;
  const vault = { root: "/vault", list: () => [m], size: () => 1, get: () => m } as unknown as Vault;
  return buildGraph(vault).nodes[0].created;
}

test("graph keeps ISO creation dates across either UTC day boundary", () => {
  for (const value of ["2026-11-12T00:30:00+02:00", "2026-11-12T23:30:00-02:00", "2026-11-12T00:30:00", "2024-02-29", "2026-11-12T09:10:11Z"])
    assert.equal(projected(value), value);
});

test("graph rejects invalid calendar dates and time components", () => {
  for (const value of ["2026-02-29", "2026-02-30T00:30:00+02:00", "2026-04-31T23:30:00-02:00", "2026-13-01", "2026-11-12T25:00:00Z", "not-a-date"])
    assert.equal(projected(value), undefined, value);
});
