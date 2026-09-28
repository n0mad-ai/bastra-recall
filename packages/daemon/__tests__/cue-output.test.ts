import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { cuePartialPath, publishCueSidecar } from "../scripts/cue-output.js";

test("#427: concurrent cue batches use separate partials and cannot overwrite without opt-in", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-cue-output-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, "cues.jsonl");
  const first = cuePartialPath(out);
  const second = cuePartialPath(out);
  assert.notEqual(first, second);
  assert.equal(dirname(first), dir);
  await writeFile(first, "first\n");
  await writeFile(second, "second\n");

  const results = await Promise.allSettled([
    publishCueSidecar(first, out, false),
    publishCueSidecar(second, out, false),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.ok(["first\n", "second\n"].includes(await readFile(out, "utf8")));

  await publishCueSidecar(second, out, true);
  assert.equal(await readFile(out, "utf8"), "second\n");
});
