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

  const after = await snapshot(join(vault, first.folder));
  assert.deepEqual([...after.keys()], [...before.keys()], "no file appeared or vanished");
  for (const [rel, now] of after) {
    const then = before.get(rel);
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
  const moved = [...after.keys()].filter((rel) => after.get(rel).hash !== before.get(rel)?.hash);
  assert.equal(moved.length, 1, `exactly one file may change, changed: ${moved.join(", ")}`);
  assert.match(moved[0], /two/);

  assert.equal(
    (await auditLines(vault)).length,
    auditBefore.length + 1,
    "one audit event for the one real change",
  );
});
