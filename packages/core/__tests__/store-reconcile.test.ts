/**
 * #339 — two synthetic copies of one vault: which copy of each memory is
 * ahead, which are the same despite different bytes, and which are conflicts.
 *
 * Runner: `node --import tsx --test packages/core/__tests__/store-reconcile.test.ts`
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AuditLog } from "../src/audit-log.js";
import {
  applyReconcile,
  authoredBody,
  authoredContent,
  authoredKey,
  loadStore,
  planReconcile,
  type PlanItem,
} from "../src/store-reconcile.js";

function memo(id: string, body: string, extra: Record<string, string> = {}): string {
  const fm: Record<string, string> = {
    id,
    title: `Title ${id}`,
    type: "lesson",
    summary: `Summary of ${id}`,
    topic_path: "[ops]",
    tags: "[sync]",
    scope: "reconcile-test",
    recall_when: `["when ${id} comes up"]`,
    created: "2026-08-01",
    updated: "2026-08-01",
    ...extra,
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

async function put(root: string, rel: string, raw: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), raw, "utf8");
}

async function audit(root: string, memoryId: string, entryId: string, operation: "create" | "update" | "delete" = "update") {
  await new AuditLog(root).record({
    id: entryId,
    memory_id: memoryId,
    actor: "assistant",
    operation,
    diff_before: null,
    diff_after: null,
    timestamp: `2026-08-0${entryId.length % 9 + 1}T10:00:00.000Z`,
  });
}

const GENERATED_TAIL =
  "\n## Auto-Related <!-- bastra:auto-related:start -->\n- [[other-note]] — shares a topic\n<!-- bastra:auto-related:end -->\n";

/**
 * A = the vault the daemon served, B = its mirror. Built so every class of
 * the plan shows up once.
 */
async function fixture(): Promise<{ a: string; b: string; cleanup: () => Promise<void> }> {
  const a = await mkdtemp(path.join(tmpdir(), "reconcile-a-"));
  const b = await mkdtemp(path.join(tmpdir(), "reconcile-b-"));

  // same: the daemon enriched A (generated field + auto-related block), B has
  // the body hard-wrapped and a CRLF file — authored content identical.
  await put(a, "same.md", memo("same", "First line of a paragraph that goes on.\n\nSee [[Präferenz|the rule]].", {
    recall_when_expanded: `["paraphrase"]`,
    updated: "2026-09-20",
  }).replace(/\n$/, GENERATED_TAIL));
  await put(b, "same.md", memo("same", "First line of a\nparagraph that goes on.\n\nSee [[praeferenz|the rule]].").replace(/\n/g, "\r\n"));
  await audit(a, "same", "e-same-1", "create");
  await audit(b, "same", "e-same-1", "create");

  // ahead-here: A carries an audited update B lacks.
  await put(a, "notes/ahead-here.md", memo("ahead-here", "Old text.\n\nA retraction added later."));
  await put(b, "notes/ahead-here.md", memo("ahead-here", "Old text."));
  await audit(a, "ahead-here", "e-ah-1", "create");
  await audit(b, "ahead-here", "e-ah-1", "create");
  await audit(a, "ahead-here", "e-ah-2");

  // ahead-there: the mirror took a failover write — and looks OLDER by every
  // cheap signal (A was enriched afterwards). Direction must still be B.
  await put(a, "ahead-there.md", memo("ahead-there", "The lead is live.", { related_via: "[]", updated: "2026-09-25" }).replace(/\n$/, GENERATED_TAIL));
  await put(b, "ahead-there.md", memo("ahead-there", "The lead is live.\n\nRetracted: the lead was wrong."));
  await audit(a, "ahead-there", "e-at-1", "create");
  await audit(b, "ahead-there", "e-at-1", "create");
  await audit(b, "ahead-there", "e-at-2");

  // conflict: both sides wrote.
  await put(a, "both.md", memo("both", "Edited here."));
  await put(b, "both.md", memo("both", "Edited there."));
  await audit(a, "both", "e-both-a");
  await audit(b, "both", "e-both-b");

  // conflict: differs, neither log knows (edited in another editor).
  await put(a, "quiet.md", memo("quiet", "Version one."));
  await put(b, "quiet.md", memo("quiet", "Version two."));

  // summary-only change must count as a difference (frontmatter is authored).
  await put(a, "summary.md", memo("summary", "Same body.", { summary: "A sharper summary" }));
  await put(b, "summary.md", memo("summary", "Same body."));
  await audit(a, "summary", "e-sum-1");

  // only here / only there / deleted there.
  await put(a, "deep/only-here.md", memo("only-here", "New on A."));
  await put(b, "only-there.md", memo("only-there", "New on B."));
  await put(a, "gone.md", memo("gone", "Deleted on B."));
  await audit(b, "gone", "e-gone-del", "delete");

  // join by id, not filename: B keeps the memory under another name.
  await put(a, "renamed.md", memo("renamed", "Body."));
  await put(b, "elsewhere/Renamed Note.md", memo("renamed", "Body."));

  // a plain note is not a memory and never part of the plan.
  await put(a, "README.md", "# just a note\n");

  return { a, b, cleanup: async () => { await rm(a, { recursive: true, force: true }); await rm(b, { recursive: true, force: true }); } };
}

function byId(items: PlanItem[]): Map<string, PlanItem> {
  return new Map(items.map((i) => [i.id, i]));
}

test("plan: same / ahead either way / conflicts / only one side", async () => {
  const { a, b, cleanup } = await fixture();
  try {
    const plan = await planReconcile(await loadStore(a), await loadStore(b));
    const m = byId(plan.items);

    const same = m.get("same")!;
    assert.equal(same.kind, "same");
    assert.equal(same.kind === "same" && same.bytesDiffer, true, "bytes differ, authored content does not");

    const ah = m.get("ahead-here")!;
    assert.equal(ah.kind, "copy");
    assert.ok(ah.kind === "copy" && ah.from === "a" && ah.why === "ahead");
    assert.deepEqual(ah.kind === "copy" && ah.carryAudit, ["e-ah-2"]);
    assert.equal(ah.kind === "copy" && ah.diff?.paragraphsOnlyA, 1);

    const at = m.get("ahead-there")!;
    assert.ok(at.kind === "copy" && at.from === "b" && at.why === "ahead", "the mirror's failover write is ahead");

    const both = m.get("both")!;
    assert.ok(both.kind === "conflict" && both.reason === "both-changed");
    const quiet = m.get("quiet")!;
    assert.ok(quiet.kind === "conflict" && quiet.reason === "unrecorded");

    const summary = m.get("summary")!;
    assert.ok(summary.kind === "copy" && summary.from === "a");
    assert.deepEqual(summary.kind === "copy" && summary.diff?.fields, ["summary"]);

    const onlyHere = m.get("only-here")!;
    assert.ok(onlyHere.kind === "copy" && onlyHere.from === "a" && onlyHere.why === "only-here");
    const onlyThere = m.get("only-there")!;
    assert.ok(onlyThere.kind === "copy" && onlyThere.from === "b" && onlyThere.why === "only-here");
    const gone = m.get("gone")!;
    assert.ok(gone.kind === "conflict" && gone.reason === "deleted-on-one-side");

    assert.equal(m.get("renamed")!.kind, "same", "joined by frontmatter id");
    assert.equal(m.has("README"), false);
  } finally {
    await cleanup();
  }
});

test("plan never writes", async () => {
  const { a, b, cleanup } = await fixture();
  try {
    const before = await readFile(path.join(b, "notes/ahead-here.md"), "utf8");
    await planReconcile(await loadStore(a), await loadStore(b));
    assert.equal(await readFile(path.join(b, "notes/ahead-here.md"), "utf8"), before);
    await assert.rejects(readdir(path.join(b, ".bastra", "reconcile-backup")));
  } finally {
    await cleanup();
  }
});

test("apply: copies with backup, carries audit entries, leaves conflicts alone", async () => {
  const { a, b, cleanup } = await fixture();
  try {
    const bothA = await readFile(path.join(a, "both.md"), "utf8");
    const bothB = await readFile(path.join(b, "both.md"), "utf8");
    const oldB = await readFile(path.join(b, "notes/ahead-here.md"), "utf8");
    const plan = await planReconcile(await loadStore(a), await loadStore(b));
    const results = await applyReconcile(plan, new Date("2026-09-28T12:00:00.000Z"));

    assert.ok(results.every((r) => r.status === "copied"), JSON.stringify(results));
    assert.equal(
      await readFile(path.join(b, "notes/ahead-here.md"), "utf8"),
      await readFile(path.join(a, "notes/ahead-here.md"), "utf8"),
    );
    const backup = results.find((r) => r.id === "ahead-here")?.backup;
    assert.ok(backup?.includes("/.bastra/reconcile-backup/2026-09-28T12-00-00Z/notes/ahead-here.md."));
    if (!backup) throw new Error("expected overwritten copy backup");
    assert.equal(await readFile(backup, "utf8"), oldB, "the overwritten copy is kept");
    assert.match(await readFile(path.join(a, "ahead-there.md"), "utf8"), /Retracted/);
    assert.equal(await readFile(path.join(b, "deep/only-here.md"), "utf8"), await readFile(path.join(a, "deep/only-here.md"), "utf8"));
    assert.equal(await readFile(path.join(a, "only-there.md"), "utf8"), await readFile(path.join(b, "only-there.md"), "utf8"));

    // conflicts untouched on both sides
    assert.equal(await readFile(path.join(a, "both.md"), "utf8"), bothA);
    assert.equal(await readFile(path.join(b, "both.md"), "utf8"), bothB);
    await assert.rejects(readFile(path.join(b, "gone.md"), "utf8"));

    // A second run: everything copied is now the same, conflicts stay.
    const again = await planReconcile(await loadStore(a), await loadStore(b));
    const m = byId(again.items);
    for (const id of ["ahead-here", "ahead-there", "summary", "only-here", "only-there"]) {
      assert.equal(m.get(id)!.kind, "same", id);
    }
    assert.equal(again.items.filter((i) => i.kind === "copy").length, 0);

    // …and a later write on the formerly-behind side reads as "ahead", not as
    // a conflict — because the audit entries travelled with the copy.
    await put(b, "notes/ahead-here.md", memo("ahead-here", "Old text.\n\nA retraction added later.\n\nMore from B."));
    await audit(b, "ahead-here", "e-ah-3");
    const third = byId((await planReconcile(await loadStore(a), await loadStore(b))).items);
    const ah = third.get("ahead-here")!;
    assert.ok(ah.kind === "copy" && ah.from === "b", JSON.stringify(ah.kind));
  } finally {
    await cleanup();
  }
});

test("apply skips a target that changed after the plan", async () => {
  const { a, b, cleanup } = await fixture();
  try {
    const plan = await planReconcile(await loadStore(a), await loadStore(b));
    await put(b, "notes/ahead-here.md", memo("ahead-here", "Someone wrote in between."));
    const results = await applyReconcile(plan);
    const r = results.find((x) => x.id === "ahead-here")!;
    assert.equal(r.status, "skipped");
    assert.match(await readFile(path.join(b, "notes/ahead-here.md"), "utf8"), /in between/);
  } finally {
    await cleanup();
  }
});

test("#339: a writer arriving after backup wins the target path", async () => {
  const { a, b, cleanup } = await fixture();
  try {
    const plan = await planReconcile(await loadStore(a), await loadStore(b));
    const external = memo("ahead-here", "An external writer arrived during publication.");
    const results = await applyReconcile(plan, new Date("2026-09-28T12:00:00.000Z"), {
      beforePublish: async (target) => {
        if (target === path.join(b, "notes/ahead-here.md")) await writeFile(target, external);
      },
    });
    const row = results.find((r) => r.id === "ahead-here")!;
    assert.equal(row.status, "skipped");
    assert.equal(await readFile(path.join(b, "notes/ahead-here.md"), "utf8"), external);
    assert.ok(row.backup, "the previous target remains available independently");
    assert.equal(await readFile(row.backup, "utf8"), memo("ahead-here", "Old text."));
  } finally {
    await cleanup();
  }
});

test("#339: a new file with the same id at another path blocks a stale copy plan", async () => {
  const { a, b, cleanup } = await fixture();
  try {
    const plan = await planReconcile(await loadStore(a), await loadStore(b));
    await put(b, "another-folder/only-here.md", memo("only-here", "A newer local save."));
    const results = await applyReconcile(plan);
    const row = results.find((r) => r.id === "only-here")!;
    assert.equal(row.status, "skipped");
    assert.match(row.reason ?? "", /target id changed/);
    await assert.rejects(readFile(path.join(b, "deep/only-here.md"), "utf8"));
  } finally {
    await cleanup();
  }
});

test("#339: a committed copy reports an audit-log failure as a warning", async () => {
  const { a, b, cleanup } = await fixture();
  try {
    const plan = await planReconcile(await loadStore(a), await loadStore(b));
    const log = path.join(b, ".bastra", "audit-log.ndjson");
    await rename(log, `${log}.saved`);
    await mkdir(log);
    const rows = await applyReconcile(plan);
    const row = rows.find((r) => r.id === "ahead-here")!;
    assert.equal(row.status, "copied");
    assert.match(row.warning ?? "", /audit entries could not all be copied/);
    assert.match(await readFile(path.join(b, "notes/ahead-here.md"), "utf8"), /retraction added later/);
  } finally {
    await cleanup();
  }
});

test("authored body: links normalised outside code only, alias kept, order matters", () => {
  assert.deepEqual(authoredBody("See [[Präferenz|Anzeige]] and `[[Präferenz]]`."), [
    "See [[praeferenz|Anzeige]] and `[[Präferenz]]`.",
  ]);
  assert.deepEqual(authoredBody("```\n[[Keep Me]]\n  indented\n```"), ["```\n[[Keep Me]]\n  indented\n```"]);
  const fm = { id: "x", title: "t" };
  const k1 = authoredKey(authoredContent(fm, "one\n\ntwo"));
  const k2 = authoredKey(authoredContent(fm, "two\n\none"));
  assert.notEqual(k1, k2, "reordering is an authored change");
  const k3 = authoredKey(authoredContent({ ...fm, updated: "2026-01-01", related_via: [] }, "﻿one\r\n\r\ntwo"));
  assert.equal(k1, k3, "generated fields, BOM and CRLF do not count");
});
