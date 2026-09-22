/**
 * #530 — an identical re-import is a no-op.
 *
 * The documented `import vault` path reached the right semantic result and
 * created no duplicates, but it was not idempotent in the way a user notices:
 * every unchanged memory was rewritten (new mtime, so a cloud-synced vault saw
 * seven file changes), every run appended an `update` audit event whose
 * `diff_before` and `diff_after` were identical, `.bastra-imported` was
 * restamped, and the CLI reported every source file as imported again.
 *
 * The reproduction from the issue, as a test: import the sample vault, hash
 * everything, import the exact same folder under the same label again, and
 * require that NOTHING moved — bytes, mtimes, the audit log and the marker.
 *
 * Filesystem and clock only; no network, no spawned binary, so the Linux CI
 * runner runs exactly this.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { importVault } from "../src/import-vault.js";
import { resetAuditLogCache } from "../src/audit-trail.js";

const SAMPLE_VAULT = resolve(import.meta.dirname, "..", "..", "..", "fixtures", "sample-vault");

/** Every markdown file under `dir`, as `relative path → {sha256, mtimeMs}`. */
async function snapshot(dir: string): Promise<Map<string, { hash: string; mtimeMs: number }>> {
  const out = new Map<string, { hash: string; mtimeMs: number }>();
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const raw = await readFile(full);
        out.set(rel, {
          hash: createHash("sha256").update(raw).digest("hex"),
          mtimeMs: (await stat(full)).mtimeMs,
        });
      }
    }
  };
  await walk(dir, "");
  return out;
}

async function auditLines(vault: string): Promise<string[]> {
  const path = join(vault, ".bastra", "audit-log.ndjson");
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8")).split("\n").filter((l) => l.trim().length > 0);
}

test("a second identical import writes nothing and claims nothing", async (t) => {
  const vault = await mkdtemp(join(tmpdir(), "iv-reimport-"));
  t.after(async () => {
    resetAuditLogCache();
    await rm(vault, { recursive: true, force: true });
  });
  resetAuditLogCache();

  const first = await importVault(vault, SAMPLE_VAULT, { label: "sample" });
  assert.ok(first.imported > 0, "the fixture must import at least one memory");
  assert.equal(first.written.created, first.imported, "a first import creates everything");
  assert.equal(first.written.updated, 0);
  assert.equal(first.written.unchanged, 0);

  const markerPath = join(vault, first.folder, ".bastra-imported");
  const before = await snapshot(join(vault, first.folder));
  const auditBefore = await auditLines(vault);
  const markerBefore = await readFile(markerPath, "utf8");
  assert.equal(auditBefore.length, first.imported, "one audit entry per written memory");

  // The marker carries an ISO `at`; without a gap a restamp could coincide.
  await new Promise((r) => setTimeout(r, 20));

  const second = await importVault(vault, SAMPLE_VAULT, { label: "sample" });

  assert.equal(second.imported, first.imported, "the same set is still present");
  assert.equal(second.written.created, 0, "nothing may be created twice");
  assert.equal(second.written.updated, 0, "nothing changed, so nothing may be updated");
  assert.equal(second.written.unchanged, second.imported, "everything is unchanged");
  assert.deepEqual(second.skipped, [], "an unchanged file is not a failure");
  assert.deepEqual(second.orphaned, [], "an unchanged source set has nothing orphaned");

  const after = await snapshot(join(vault, first.folder));
  assert.deepEqual([...after.keys()], [...before.keys()], "no file appeared or vanished");
  for (const [rel, now] of after) {
    // #542: the deepEqual on the key sets just above guarantees `rel` is in
    // `before` too.
    const then = before.get(rel)!;
    assert.equal(now.hash, then.hash, `${rel} changed its bytes`);
    assert.equal(now.mtimeMs, then.mtimeMs, `${rel} was rewritten (mtime moved)`);
  }

  assert.deepEqual(
    await auditLines(vault),
    auditBefore,
    "a no-op run must append no audit event",
  );
  assert.equal(
    await readFile(markerPath, "utf8"),
    markerBefore,
    ".bastra-imported must stay stable while the imported set does",
  );
});

test("a changed source file is updated, and only that one", async (t) => {
  const src = await mkdtemp(join(tmpdir(), "iv-reimport-src-"));
  const vault = await mkdtemp(join(tmpdir(), "iv-reimport-vault-"));
  t.after(async () => {
    resetAuditLogCache();
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  });
  resetAuditLogCache();

  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(src, { recursive: true });
  await writeFile(join(src, "one.md"), "# One\n\nFirst note.\n", "utf8");
  await writeFile(join(src, "two.md"), "# Two\n\nSecond note.\n", "utf8");

  const first = await importVault(vault, src, { label: "delta" });
  assert.equal(first.written.created, 2);

  const before = await snapshot(join(vault, first.folder));
  const auditBefore = await auditLines(vault);

  await writeFile(join(src, "two.md"), "# Two\n\nSecond note, corrected.\n", "utf8");
  const second = await importVault(vault, src, { label: "delta" });

  assert.equal(second.written.created, 0);
  assert.equal(second.written.updated, 1, "exactly the edited note is written");
  assert.equal(second.written.unchanged, 1, "the untouched note stays untouched");

  const after = await snapshot(join(vault, first.folder));
  // #542: `rel` comes from after.keys(), so after.get(rel) is always defined.
  const moved = [...after.keys()].filter((rel) => after.get(rel)!.hash !== before.get(rel)?.hash);
  assert.equal(moved.length, 1, `exactly one file may change, changed: ${moved.join(", ")}`);
  assert.match(moved[0], /two/);

  assert.equal(
    (await auditLines(vault)).length,
    auditBefore.length + 1,
    "one audit event for the one real change",
  );
});

test("#530 follow-up: the marker mirrors a shrunk source set", async (t) => {
  const src = await mkdtemp(join(tmpdir(), "iv-reimport-shrink-src-"));
  const vault = await mkdtemp(join(tmpdir(), "iv-reimport-shrink-vault-"));
  t.after(async () => {
    resetAuditLogCache();
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  });
  resetAuditLogCache();

  const { writeFile, mkdir, rm: rmFile } = await import("node:fs/promises");
  await mkdir(src, { recursive: true });
  await writeFile(join(src, "one.md"), "# One\n\nFirst note.\n", "utf8");
  await writeFile(join(src, "two.md"), "# Two\n\nSecond note.\n", "utf8");

  const first = await importVault(vault, src, { label: "shrink" });
  assert.equal(first.imported, 2);
  const markerPath = join(vault, first.folder, ".bastra-imported");
  const markerAfterFirst = JSON.parse(await readFile(markerPath, "utf8"));
  assert.equal(markerAfterFirst.imported, 2, "marker mirrors the full source set");

  // The source set shrinks: "two.md" is removed. The one remaining file is
  // already in the vault unchanged, so the run creates and updates nothing —
  // the marker still has to catch up to the smaller set.
  await rmFile(join(src, "two.md"));
  const second = await importVault(vault, src, { label: "shrink" });

  assert.equal(second.imported, 1, "only the surviving file is part of the set");
  assert.equal(second.written.created, 0);
  assert.equal(second.written.updated, 0);
  assert.equal(second.written.unchanged, 1, "the surviving file is written to nothing");

  const markerAfterSecond = JSON.parse(await readFile(markerPath, "utf8"));
  assert.equal(markerAfterSecond.imported, 1, "marker was updated to the shrunk set's count");
});

test("#530 follow-up: the marker mirrors a source set that shrinks to zero", async (t) => {
  const src = await mkdtemp(join(tmpdir(), "iv-reimport-shrink0-src-"));
  const vault = await mkdtemp(join(tmpdir(), "iv-reimport-shrink0-vault-"));
  t.after(async () => {
    resetAuditLogCache();
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  });
  resetAuditLogCache();

  const { writeFile, mkdir, rm: rmFile } = await import("node:fs/promises");
  await mkdir(src, { recursive: true });
  await writeFile(join(src, "one.md"), "# One\n\nFirst note.\n", "utf8");

  const first = await importVault(vault, src, { label: "shrink0" });
  assert.equal(first.imported, 1);
  const markerPath = join(vault, first.folder, ".bastra-imported");
  const markerAfterFirst = JSON.parse(await readFile(markerPath, "utf8"));
  assert.equal(markerAfterFirst.imported, 1);

  // The LAST source file is removed: `ids.length` goes to zero, the same
  // n -> n-1 bug the shrink test above covers, only for n -> 0. Before the
  // fix, the previous-marker read and the write were both gated on
  // `ids.length > 0`, so a marker still claiming "1" would be left behind
  // forever once the source folder emptied out.
  await rmFile(join(src, "one.md"));
  const second = await importVault(vault, src, { label: "shrink0" });

  assert.equal(second.imported, 0, "the source set is now empty");
  assert.equal(second.written.created, 0);
  assert.equal(second.written.updated, 0);

  const markerAfterSecond = JSON.parse(await readFile(markerPath, "utf8"));
  assert.equal(markerAfterSecond.imported, 0, "marker was updated to reflect the now-empty set");
});

test("#530 follow-up: an empty source set with no prior marker writes none", async (t) => {
  const src = await mkdtemp(join(tmpdir(), "iv-reimport-empty-src-"));
  const vault = await mkdtemp(join(tmpdir(), "iv-reimport-empty-vault-"));
  t.after(async () => {
    resetAuditLogCache();
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  });
  resetAuditLogCache();

  const { mkdir } = await import("node:fs/promises");
  await mkdir(src, { recursive: true });
  // No markdown files at all — a first-ever import of an empty (or
  // already-fully-excluded) folder must stay a true no-op: there was never a
  // marker to catch up, so none may be created out of nothing.

  const result = await importVault(vault, src, { label: "empty" });

  assert.equal(result.imported, 0);
  assert.equal(result.written.created, 0);
  assert.equal(result.written.updated, 0);
  const markerPath = join(vault, result.folder, ".bastra-imported");
  assert.equal(existsSync(markerPath), false, "no marker for a set that was always empty");
});

test("#530 follow-up: the marker mirrors a grown source set", async (t) => {
  const src = await mkdtemp(join(tmpdir(), "iv-reimport-grow-src-"));
  const vault = await mkdtemp(join(tmpdir(), "iv-reimport-grow-vault-"));
  t.after(async () => {
    resetAuditLogCache();
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  });
  resetAuditLogCache();

  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(src, { recursive: true });
  await writeFile(join(src, "one.md"), "# One\n\nFirst note.\n", "utf8");

  const first = await importVault(vault, src, { label: "grow" });
  assert.equal(first.imported, 1);
  const markerPath = join(vault, first.folder, ".bastra-imported");
  const markerAfterFirst = JSON.parse(await readFile(markerPath, "utf8"));
  assert.equal(markerAfterFirst.imported, 1);

  // The source set grows: "two.md" is added, as before (#530's original fix
  // already covered this path — a real write already updates the marker).
  await writeFile(join(src, "two.md"), "# Two\n\nSecond note.\n", "utf8");
  const second = await importVault(vault, src, { label: "grow" });

  assert.equal(second.imported, 2);
  assert.equal(second.written.created, 1, "only the new file is created");
  assert.equal(second.written.unchanged, 1, "the existing file is untouched");

  const markerAfterSecond = JSON.parse(await readFile(markerPath, "utf8"));
  assert.equal(markerAfterSecond.imported, 2, "marker was updated to the grown set's count");
});

// ─── #530 follow-up: report, never remove, a memory whose source vanished ───
//
// Owner decision (2026-09-21): a source file missing on reimport can be a
// stuck cloud sync, not a real deletion — the import must never delete, move
// or trash the memory it once produced. It only ever REPORTS the mismatch, so
// a human decides. Detection reads each memory's own `source` provenance
// stamp back (no new marker format needed).

test("#530 follow-up: a memory is reported orphaned, not removed, when its source file disappears", async (t) => {
  const src = await mkdtemp(join(tmpdir(), "iv-orphan-src-"));
  const vault = await mkdtemp(join(tmpdir(), "iv-orphan-vault-"));
  t.after(async () => {
    resetAuditLogCache();
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  });
  resetAuditLogCache();

  const { writeFile, mkdir, rm: rmFile } = await import("node:fs/promises");
  await mkdir(src, { recursive: true });
  await writeFile(join(src, "one.md"), "# One\n\nFirst note.\n", "utf8");
  await writeFile(join(src, "two.md"), "# Two\n\nSecond note.\n", "utf8");

  const first = await importVault(vault, src, { label: "orphan" });
  assert.deepEqual(first.orphaned, [], "nothing is orphaned on the first import");
  assert.ok(first.ids.includes("orphan-two"));

  const twoPath = join(vault, first.folder, "orphan-two.md");
  const twoBefore = await readFile(twoPath);
  const auditBefore = await auditLines(vault);

  await rmFile(join(src, "two.md"));
  const second = await importVault(vault, src, { label: "orphan" });

  assert.equal(second.imported, 1, "only the surviving file is part of the set");
  assert.equal(second.written.created, 0);
  assert.equal(second.written.updated, 0);
  assert.equal(second.orphaned.length, 1, "the removed file's memory is reported exactly once");
  assert.equal(second.orphaned[0].id, "orphan-two");
  assert.equal(second.orphaned[0].sourcePath, "two.md");
  assert.equal(second.orphaned[0].path, twoPath);

  const twoAfter = await readFile(twoPath);
  assert.deepEqual(twoAfter, twoBefore, "the orphaned memory's bytes must stay byte-identical — nothing removed");

  assert.deepEqual(
    await auditLines(vault),
    auditBefore,
    "reporting an orphan must not itself create an audit event (no delete, no touch)",
  );
});

test("#530 follow-up: a dry run reports orphaned memories and writes nothing", async (t) => {
  const src = await mkdtemp(join(tmpdir(), "iv-orphan-dry-src-"));
  const vault = await mkdtemp(join(tmpdir(), "iv-orphan-dry-vault-"));
  t.after(async () => {
    resetAuditLogCache();
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  });
  resetAuditLogCache();

  const { writeFile, mkdir, rm: rmFile } = await import("node:fs/promises");
  await mkdir(src, { recursive: true });
  await writeFile(join(src, "one.md"), "# One\n\nFirst note.\n", "utf8");
  await writeFile(join(src, "two.md"), "# Two\n\nSecond note.\n", "utf8");

  const first = await importVault(vault, src, { label: "orphan-dry" });
  await rmFile(join(src, "two.md"));

  const markerPath = join(vault, first.folder, ".bastra-imported");
  const before = await snapshot(join(vault, first.folder));
  const markerBefore = await readFile(markerPath, "utf8");

  const dry = await importVault(vault, src, { label: "orphan-dry", dryRun: true });

  assert.equal(dry.orphaned.length, 1, "a dry run detects the orphan too — detection is read-only");
  assert.equal(dry.orphaned[0].sourcePath, "two.md");

  const after = await snapshot(join(vault, first.folder));
  assert.deepEqual(after, before, "a dry run must not write anything, even to report an orphan");
  assert.equal(await readFile(markerPath, "utf8"), markerBefore, "a dry run must not touch the marker");
});

test("#530 follow-up: a returned source file clears the orphaned report", async (t) => {
  const src = await mkdtemp(join(tmpdir(), "iv-orphan-return-src-"));
  const vault = await mkdtemp(join(tmpdir(), "iv-orphan-return-vault-"));
  t.after(async () => {
    resetAuditLogCache();
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  });
  resetAuditLogCache();

  const { writeFile, mkdir, rm: rmFile } = await import("node:fs/promises");
  await mkdir(src, { recursive: true });
  await writeFile(join(src, "one.md"), "# One\n\nFirst note.\n", "utf8");
  await writeFile(join(src, "two.md"), "# Two\n\nSecond note.\n", "utf8");
  await importVault(vault, src, { label: "orphan-return" });

  await rmFile(join(src, "two.md"));
  const gone = await importVault(vault, src, { label: "orphan-return" });
  assert.equal(gone.orphaned.length, 1, "orphaned while the source stays missing");

  await writeFile(join(src, "two.md"), "# Two\n\nSecond note.\n", "utf8");
  const back = await importVault(vault, src, { label: "orphan-return" });

  assert.deepEqual(back.orphaned, [], "no longer orphaned once its source file returns");
  assert.ok(back.ids.includes("orphan-return-two"));
});
