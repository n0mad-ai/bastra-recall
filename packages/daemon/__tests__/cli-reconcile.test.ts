/**
 * `bastra reconcile <other-store>` (#339) — the CLI around core's
 * store-reconcile: dry run by default, `--yes` copies with backup, usage
 * errors before anything is read.
 *
 * Runner: `tsx --test __tests__/cli-reconcile.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "@bastra-recall/core";
import { cmdReconcile } from "../src/cli/reconcile-cmd.js";
import { parseArgs } from "../src/cli/commands.js";

function memo(id: string, body: string): string {
  return `---\nid: ${id}\ntitle: T ${id}\ntype: lesson\nsummary: S ${id}\ntopic_path: [ops]\ntags: [sync]\nscope: t\nrecall_when: ["${id}"]\ncreated: 2026-08-01\nupdated: 2026-08-01\n---\n\n${body}\n`;
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const log = console.log;
  const error = console.error;
  let out = "";
  let err = "";
  console.log = (...a: unknown[]) => { out += a.join(" ") + "\n"; };
  console.error = (...a: unknown[]) => { err += a.join(" ") + "\n"; };
  try {
    return { code: await fn(), out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
}

async function stores() {
  const a = await mkdtemp(join(tmpdir(), "cli-reconcile-a-"));
  const b = await mkdtemp(join(tmpdir(), "cli-reconcile-b-"));
  await writeFile(join(a, "m.md"), memo("m", "old\n\nnew paragraph"));
  await writeFile(join(b, "m.md"), memo("m", "old"));
  await writeFile(join(a, "c.md"), memo("c", "here"));
  await writeFile(join(b, "c.md"), memo("c", "there"));
  const rec = (root: string, id: string) => new AuditLog(root).record({
    id, memory_id: id.split("-")[0], actor: "assistant", operation: "update", diff_before: null, diff_after: null,
  });
  await rec(a, "m-1");
  await rec(a, "c-1");
  await rec(b, "c-2");
  return { a, b, cleanup: async () => { await rm(a, { recursive: true, force: true }); await rm(b, { recursive: true, force: true }); } };
}

test("no other store → usage, exit 2", async () => {
  const r = await capture(() => cmdReconcile(parseArgs(["reconcile", "--vault", tmpdir()])));
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: bastra reconcile/);
});

test("same store twice is refused", async () => {
  const d = await mkdtemp(join(tmpdir(), "cli-reconcile-same-"));
  try {
    const r = await capture(() => cmdReconcile(parseArgs(["reconcile", d, "--vault", d])));
    assert.equal(r.code, 2);
    assert.match(r.err, /same store/);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("dry run prints the plan and writes nothing", async () => {
  const { a, b, cleanup } = await stores();
  try {
    const r = await capture(() => cmdReconcile(parseArgs(["reconcile", b, "--vault", a])));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /this ahead → copy to other: 1\n {2}m {2}m\.md/);
    assert.match(r.out, /conflicts \(left alone, decide by hand\): 1\n {2}c {2}both sides/);
    assert.match(r.out, /dry run — nothing written/);
    assert.equal(await readFile(join(b, "m.md"), "utf8"), memo("m", "old"));
  } finally {
    await cleanup();
  }
});

test("--json carries the plan", async () => {
  const { a, b, cleanup } = await stores();
  try {
    const r = await capture(() => cmdReconcile(parseArgs(["reconcile", b, "--vault", a, "--json"])));
    const j = JSON.parse(r.out);
    assert.equal(j.dry_run, true);
    const m = j.items.find((i: { id: string }) => i.id === "m");
    assert.equal(m.from, "this");
    assert.equal(j.items.find((i: { id: string }) => i.id === "c").reason, "both-changed");
  } finally {
    await cleanup();
  }
});

test("--yes copies the unambiguous one with a backup, leaves the conflict", async () => {
  const { a, b, cleanup } = await stores();
  try {
    const now = new Date("2026-09-28T12:00:00.000Z");
    const r = await capture(() => cmdReconcile(parseArgs(["reconcile", b, "--vault", a, "--yes"]), now));
    assert.equal(r.code, 0, r.err);
    assert.equal(await readFile(join(b, "m.md"), "utf8"), memo("m", "old\n\nnew paragraph"));
    assert.equal(await readFile(join(b, ".bastra/reconcile-backup/2026-09-28T12-00-00Z/m.md"), "utf8"), memo("m", "old"));
    assert.equal(await readFile(join(b, "c.md"), "utf8"), memo("c", "there"));
    assert.match(r.out, /copied {3}m → /);
  } finally {
    await cleanup();
  }
});

test("--yes with --dry-run is a usage error", async () => {
  await mkdir(tmpdir(), { recursive: true });
  const r = await capture(() => cmdReconcile(parseArgs(["reconcile", tmpdir(), "--yes", "--dry-run"])));
  assert.equal(r.code, 2);
});
