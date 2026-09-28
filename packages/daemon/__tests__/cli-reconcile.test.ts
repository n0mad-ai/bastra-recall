/**
 * `bastra reconcile <other-store>` (#339) — the CLI around core's
 * store-reconcile: dry run by default, `--yes` copies with backup, usage
 * errors before anything is read.
 *
 * Runner: `tsx --test __tests__/cli-reconcile.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "@bastra-recall/core";
import { cmdReconcile } from "../src/cli/reconcile-cmd.js";
import { parseArgs } from "../src/cli/commands.js";
import { discoverStores, registrationsFromConfig, type StoreDiscoveryEnv } from "../src/cli/store-discovery.js";

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

const NO_DISCOVERY: StoreDiscoveryEnv = { home: "/nonexistent-home", registrations: [], syncRoots: [] };

test("no other store and --yes → usage, exit 2", async () => {
  const r = await capture(() => cmdReconcile(parseArgs(["reconcile", "--vault", tmpdir(), "--yes"]), new Date(), NO_DISCOVERY));
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: bastra reconcile/);
});

test("no other store: discovery finds none and says so", async () => {
  const d = await mkdtemp(join(tmpdir(), "cli-reconcile-alone-"));
  try {
    const r = await capture(() => cmdReconcile(parseArgs(["reconcile", "--vault", d]), new Date(), NO_DISCOVERY));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /no other copy of this vault found/);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

// ─── store discovery (#339) ─────────────────────────────────────────────────

test("discovery: a registration names the mirror, a sync folder holds a copy, another vault stays out, symlinks are aliases", async () => {
  const { a, b, cleanup } = await stores();
  const home = await mkdtemp(join(tmpdir(), "cli-reconcile-home-"));
  try {
    // A sync root with a copy of this vault (shares audit history) and an unrelated vault.
    const cloud = join(home, "Library", "CloudStorage", "Dropbox");
    const copy = join(cloud, "Notes", "vault-copy");
    const other = join(cloud, "Work", "other-vault");
    await mkdir(copy, { recursive: true });
    await mkdir(other, { recursive: true });
    await writeFile(join(copy, "m.md"), memo("m", "old"));
    await new AuditLog(copy).record({ id: "m-9", memory_id: "m", actor: "assistant", operation: "update", diff_before: null, diff_after: null });
    await new AuditLog(other).record({ id: "z-1", memory_id: "zzz", actor: "assistant", operation: "update", diff_before: null, diff_after: null });
    // The home holds a symlink onto the mirror.
    await symlink(b, join(home, "mirror-link"));
    const env: StoreDiscoveryEnv = {
      home,
      registrations: [
        { source: "claude-code registration", path: a },
        { source: "codex registration", path: join(home, "mirror-link") },
        { source: "cursor registration", path: join(home, "gone") },
      ],
      syncRoots: [cloud],
    };
    const d = await discoverStores(a, env);
    assert.deepEqual(d.self.sources, ["claude-code registration"]);
    const paths = d.others.map((s) => s.path).sort();
    assert.deepEqual(paths, [copy, join(home, "gone"), join(home, "mirror-link")].sort());
    const mirror = d.others.find((s) => s.path === join(home, "mirror-link"))!;
    assert.equal(mirror.sharedWithThis, 1, "b's log names c, which a's log names too");
    assert.ok(mirror.aliases.includes(join(home, "mirror-link")));
    const cloudCopy = d.others.find((s) => s.path === copy)!;
    assert.deepEqual(cloudCopy.sources, ["sync folder Dropbox"]);
    assert.equal(cloudCopy.sharedWithThis, 1);
    assert.equal(d.others.find((s) => s.path === join(home, "gone"))!.exists, false);
    assert.equal(d.others.some((s) => s.path === other), false, "no shared history → another vault");

    // The CLI lists them; with several comparable copies it does not pick one.
    const r = await capture(() => cmdReconcile(parseArgs(["reconcile", "--vault", a]), new Date(), env));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /other stores: 3/);
    assert.match(r.out, /found via: sync folder Dropbox/);
    assert.match(r.out, /missing/);
    assert.match(r.out, /compare one with 'bastra reconcile <store>'/);
  } finally {
    await cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("discovery: exactly one other copy → its dry run is printed, nothing written", async () => {
  const { a, b, cleanup } = await stores();
  try {
    const env: StoreDiscoveryEnv = { home: "/nonexistent-home", registrations: [{ source: "claude-desktop registration", path: b }], syncRoots: [] };
    const r = await capture(() => cmdReconcile(parseArgs(["reconcile", "--vault", a]), new Date(), env));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /dry run against /);
    assert.match(r.out, /this ahead → copy to other: 1/);
    assert.equal(await readFile(join(b, "m.md"), "utf8"), memo("m", "old"));
    const j = JSON.parse((await capture(() => cmdReconcile(parseArgs(["reconcile", "--vault", a, "--json"]), new Date(), env))).out);
    assert.equal(j.stores.others[0].path, b);
    assert.equal(j.dry_run, true);
  } finally {
    await cleanup();
  }
});

test("registrationsFromConfig: top-level and Claude Code per-project registrations", () => {
  const cfg = {
    mcpServers: { "bastra-recall": { env: { BASTRA_VAULT_PATH: "/v/main" } }, other: { env: { BASTRA_VAULT_PATH: "/x" } } },
    projects: { "/work/p": { mcpServers: { "bastra-recall": { env: { BASTRA_VAULT_PATH: "/v/project" } } } }, "/work/q": {} },
  };
  assert.deepEqual(registrationsFromConfig("claude-code registration", cfg), [
    { source: "claude-code registration", path: "/v/main" },
    { source: "claude-code registration (project /work/p)", path: "/v/project" },
  ]);
  assert.deepEqual(registrationsFromConfig("x", null), []);
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
