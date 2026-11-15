/**
 * Tests for the fail-loud JSONL helper (#274).
 *
 * The interesting cases are the two inversions of the repo default: a read
 * error that is not ENOENT must throw rather than degrade to an empty log,
 * and an unserialisable value must throw rather than write the string
 * "undefined". Everything else is round-trip and tolerance for a torn tail.
 *
 * Run: npx tsx --test packages/daemon/__tests__/jsonl-store.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonl, readJsonl } from "../src/jsonl-store.js";

interface Rec {
  id: string;
  n: number;
}
const isRec = (v: unknown): v is Rec =>
  !!v && typeof v === "object" && typeof (v as Rec).id === "string" && typeof (v as Rec).n === "number";

async function tmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "jsonl-store-"));
}

test("append → read round-trips in file order", async () => {
  const dir = await tmp();
  try {
    const path = join(dir, "log.jsonl");
    await appendJsonl(path, { id: "a", n: 1 });
    await appendJsonl(path, { id: "b", n: 2 });
    await appendJsonl(path, { id: "c", n: 3 });

    assert.deepEqual(await readJsonl(path, isRec), [
      { id: "a", n: 1 },
      { id: "b", n: 2 },
      { id: "c", n: 3 },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing file is an empty log, not an error", async () => {
  const dir = await tmp();
  try {
    assert.deepEqual(await readJsonl(join(dir, "never-written.jsonl"), isRec), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a read error that is not ENOENT throws instead of degrading to empty", async () => {
  const dir = await tmp();
  try {
    // A directory in the file's place: readFile fails with EISDIR, which the
    // floors registry would swallow as "corrupt → treat as empty".
    await assert.rejects(
      () => readJsonl(dir, isRec),
      (e: NodeJS.ErrnoException) => {
        assert.notEqual(e.code, "ENOENT");
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a torn last line is skipped and the records before it survive", async () => {
  const dir = await tmp();
  try {
    const path = join(dir, "log.jsonl");
    await appendJsonl(path, { id: "a", n: 1 });
    await appendJsonl(path, { id: "b", n: 2 });
    await appendFile(path, '{"id":"c","n":', "utf8"); // crash mid-append

    assert.deepEqual(await readJsonl(path, isRec), [
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a line that parses but fails the guard is skipped", async () => {
  const dir = await tmp();
  try {
    const path = join(dir, "log.jsonl");
    await appendJsonl(path, { id: "a", n: 1 });
    await appendJsonl(path, { id: "b", n: "not-a-number" });
    await appendJsonl(path, { id: "c", n: 3 });

    assert.deepEqual(await readJsonl(path, isRec), [
      { id: "a", n: 1 },
      { id: "c", n: 3 },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("blank lines are ignored", async () => {
  const dir = await tmp();
  try {
    const path = join(dir, "log.jsonl");
    await writeFile(path, '\n\n{"id":"a","n":1}\n\n', "utf8");
    assert.deepEqual(await readJsonl(path, isRec), [{ id: "a", n: 1 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unserialisable value throws instead of writing the string undefined", async () => {
  const dir = await tmp();
  try {
    const path = join(dir, "log.jsonl");
    await assert.rejects(() => appendJsonl(path, undefined), TypeError);
    await assert.rejects(() => appendJsonl(path, () => 1), TypeError);
    // Nothing was written, so the log is still the missing-file case.
    assert.deepEqual(await readJsonl(path, isRec), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a created log is owner-only and lives in an owner-only directory", async () => {
  const dir = await tmp();
  try {
    const path = join(dir, "nested", "log.jsonl");
    await appendJsonl(path, { id: "a", n: 1 });

    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "nested"))).mode & 0o777, 0o700);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
