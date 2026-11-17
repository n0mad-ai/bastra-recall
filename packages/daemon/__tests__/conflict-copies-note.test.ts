/** #1485 — the doctor names conflict copies relative to the vault, capped, with the full count. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "@bastra-recall/core";
import { conflictCopyLines } from "../src/cli/conflict-copies-note.js";

const note = (summary: string) =>
  `---\nid: alpha\ntitle: Alpha\ntype: lesson\nsummary: ${summary}\nscope: demo\ntopic_path: [demo]\ntags: [demo]\nrecall_when: [checking alpha]\n---\n\n${summary}\n`;

test("doctor lists the conflict copy of a vault and stays silent without one", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-1485-doctor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "Alpha.md"), note("New."));
  await writeFile(join(dir, "Alpha.sync-conflict-20261117-101500-ABCDEF1.md"), note("Old."));
  const vault = new Vault(dir);
  await vault.init();
  t.after(() => vault.stop());

  const lines = conflictCopyLines(dir, vault.conflictCopies());
  assert.match(lines[0] ?? "", /^1 sync conflict copy found/);
  assert.equal(lines[1], "Alpha.sync-conflict-20261117-101500-ABCDEF1.md  (copy of Alpha.md, id 'alpha')");
  assert.deepEqual(conflictCopyLines(dir, []), []);
});

test("doctor caps the list and keeps the full count", () => {
  const copies = Array.from({ length: 12 }, (_, i) => ({
    id: `m${i}`,
    copy: `/v/m${i} (1).md`,
    original: `/v/m${i}.md`,
  }));
  const lines = conflictCopyLines("/v", copies);
  assert.match(lines[0] ?? "", /^12 sync conflict copies/);
  assert.equal(lines.at(-1), "… and 2 more");
  assert.equal(lines.length, 12);
});
