import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { CueBatchReport } from "@bastra-recall/core";
import { cuePartialPath, finishCueRun, publishCueRun, publishCueSidecar } from "../scripts/cue-output.js";

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

function report(over: Partial<CueBatchReport>): CueBatchReport {
  return {
    memories_seen: 5,
    memories_with_cues: 0,
    cues_written: 0,
    dropped_unparsable: 0,
    dropped_self_test: 0,
    dropped_low_confidence: 0,
    generation_failures: 0,
    stopped_early: false,
    ...over,
  };
}

test("#427: a run stopped by the brake or with no cues keeps the previous sidecar", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-cue-output-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, "cues.jsonl");
  const old = '{"old":"cue-1"}\n{"old":"cue-2"}\n';
  await writeFile(out, old);

  // The brake stopped the sweep after a run of generation failures.
  const braked = cuePartialPath(out);
  await writeFile(braked, "");
  await assert.rejects(
    publishCueRun(report({ generation_failures: 5, stopped_early: true }), braked, out, true),
    /Generierungsbremse/,
  );
  assert.equal(await readFile(out, "utf8"), old);

  // The model answered empty for every memory: nothing written, not braked.
  const empty = cuePartialPath(out);
  await writeFile(empty, "");
  await assert.rejects(publishCueRun(report({ dropped_unparsable: 5 }), empty, out, true), /keine Cues/);
  assert.equal(await readFile(out, "utf8"), old);

  // A successful run replaces it.
  const ok = cuePartialPath(out);
  await writeFile(ok, "new\n");
  await publishCueRun(report({ memories_with_cues: 1, cues_written: 1 }), ok, out, true);
  assert.equal(await readFile(out, "utf8"), "new\n");
});

test("#427: the end of a cue run gates on the report, the vector arm and dry-run", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-cue-output-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, "cues.jsonl");
  const old = '{"old":"cue-1"}\n';
  await writeFile(out, old);
  const opts = (partial: string, over: Partial<Parameters<typeof finishCueRun>[1]> = {}) => ({
    armLost: undefined,
    dryRun: false,
    partial,
    out,
    overwrite: true,
    ...over,
  });

  const braked = cuePartialPath(out);
  await writeFile(braked, "");
  await assert.rejects(
    finishCueRun(report({ generation_failures: 5, stopped_early: true }), opts(braked)),
    /Generierungsbremse/,
  );
  assert.equal(await readFile(out, "utf8"), old);

  const lost = cuePartialPath(out);
  await writeFile(lost, "new\n");
  await assert.rejects(
    finishCueRun(report({ memories_with_cues: 1, cues_written: 1 }), opts(lost, { armLost: "embed timeout" })),
    /Vektorarm/,
  );
  assert.equal(await readFile(out, "utf8"), old);

  await finishCueRun(report({ memories_with_cues: 1, cues_written: 1 }), opts(lost, { dryRun: true }));
  assert.equal(await readFile(out, "utf8"), old);

  await finishCueRun(report({ memories_with_cues: 1, cues_written: 1 }), opts(lost));
  assert.equal(await readFile(out, "utf8"), "new\n");
});
