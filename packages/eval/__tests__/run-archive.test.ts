import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { archiveArtifacts, archiveRoot, takeArchiveFlag } from "../src/run-archive.js";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

test("--archive files the artefact under <root>/<harness>-runs/<day>/ with its sha256 (#503)", () => {
  const work = mkdtempSync(join(tmpdir(), "bastra-archive-test-"));
  const out = join(work, "result.json");
  writeFileSync(out, '{"a":1}\n');
  const now = new Date("2026-11-17T10:20:30Z");
  const archived = archiveArtifacts("goldset-run", [out], { root: join(work, "root"), now });
  assert.equal(archived.dir, join(work, "root", "goldset-run-runs", "2026-11-17"));
  assert.deepEqual(archived.files, [{ path: join(archived.dir, "result.json"), sha256: sha('{"a":1}\n') }]);
  assert.equal(readFileSync(join(archived.dir, "result.json"), "utf8"), '{"a":1}\n');
  assert.equal(readFileSync(join(archived.dir, "SHA256SUMS"), "utf8"), `${sha('{"a":1}\n')}  result.json\n`);
});

test("a second artefact of the same name never overwrites the filed one (#503)", () => {
  const work = mkdtempSync(join(tmpdir(), "bastra-archive-test-"));
  const out = join(work, "result.json");
  const root = join(work, "root");
  writeFileSync(out, "first\n");
  archiveArtifacts("h", [out], { root, now: new Date("2026-11-17T10:20:30Z") });
  writeFileSync(out, "second\n");
  const second = archiveArtifacts("h", [out], { root, now: new Date("2026-11-17T11:00:00Z") });
  const dir = second.dir;
  assert.equal(readFileSync(join(dir, "result.json"), "utf8"), "first\n");
  assert.equal(readFileSync(join(dir, "110000-result.json"), "utf8"), "second\n");
  assert.equal(
    readFileSync(join(dir, "SHA256SUMS"), "utf8"),
    `${sha("first\n")}  result.json\n${sha("second\n")}  110000-result.json\n`
  );
});

test("BASTRA_EVAL_ARCHIVE_DIR replaces ~/.bastra as the archive root (#503)", () => {
  assert.equal(archiveRoot({ BASTRA_EVAL_ARCHIVE_DIR: "/x/y" }), "/x/y");
  assert.match(archiveRoot({}), /\.bastra$/);
});

test("--archive is taken out of argv and refused without --out (#503)", () => {
  assert.deepEqual(takeArchiveFlag(["--out", "x.json", "--archive", "--k", "3"]), {
    archive: true,
    rest: ["--out", "x.json", "--k", "3"],
  });
  assert.deepEqual(takeArchiveFlag(["--k", "3"]), { archive: false, rest: ["--k", "3"] });
  assert.throws(() => takeArchiveFlag(["--archive"]), /needs --out/);
});

test("an artefact named SHA256SUMS stays separate from the checksum list", () => {
  const work = mkdtempSync(join(tmpdir(), "bastra-archive-test-"));
  const out = join(work, "SHA256SUMS");
  const body = "fixture artefact\n";
  writeFileSync(out, body);
  const {
    dir,
    files: [archived],
  } = archiveArtifacts("h", [out], {
    root: join(work, "root"),
    now: new Date("2026-11-17T10:20:30Z"),
  });
  assert.equal(readFileSync(archived.path, "utf8"), body, "archiving must preserve the exact bytes");
  assert.equal(readFileSync(join(dir, "SHA256SUMS"), "utf8"), `${sha(body)}  ${basename(archived.path)}\n`);
});
