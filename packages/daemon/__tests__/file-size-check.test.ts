/**
 * file-size-check (PreToolUse-Hook) — die Datei-Größen-Konvention wird
 * deterministisch gemessen statt erinnert. Runner:
 * tsx --test __tests__/file-size-check.test.ts
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thresholdsFor, formatSizeNote, fileSizeNote } from "../src/file-size-check.js";

afterEach(() => {
  delete process.env.BASTRA_SIZE_CHECK;
  delete process.env.BASTRA_SIZE_GUIDE;
  delete process.env.BASTRA_SIZE_CRITICAL;
});

test("thresholds: code files 500/800, test files 700/1000, non-code exempt", () => {
  assert.deepEqual(thresholdsFor("/x/app.js"), { guide: 500, critical: 800 });
  assert.deepEqual(thresholdsFor("/x/view.tsx"), { guide: 500, critical: 800 });
  assert.deepEqual(thresholdsFor("/x/__tests__/foo.test.ts"), { guide: 700, critical: 1000 });
  assert.equal(thresholdsFor("/x/README.md"), null);
  assert.equal(thresholdsFor("/x/package-lock.json"), null);
});

test("env override moves the guide value (onboarding hook), tests stay fixed", () => {
  process.env.BASTRA_SIZE_GUIDE = "300";
  assert.deepEqual(thresholdsFor("/x/app.js"), { guide: 300, critical: 800 });
  assert.deepEqual(thresholdsFor("/x/a.test.ts"), { guide: 700, critical: 1000 });
});

test("note fires from ~90% of guide, escalates past critical, silent below", () => {
  const t = { guide: 500, critical: 800 };
  assert.equal(formatSizeNote("/x/app.js", 200, t), null);
  assert.equal(formatSizeNote("/x/app.js", 449, t), null);
  const nearNote = formatSizeNote("/x/app.js", 460, t);
  assert.ok(nearNote?.includes('level="guide"') && nearNote.includes('lines="460"'));
  const critNote = formatSizeNote("/x/app.js", 950, t);
  assert.ok(critNote?.includes('level="critical"') && critNote.includes("propose a coherent module split"));
});

test("throwaway contexts are exempt, ordinary source of the same shape is not (#280)", () => {
  // Directory segments…
  assert.equal(thresholdsFor("/x/sandbox/anims.js"), null);
  assert.equal(thresholdsFor("/x/webui/lab/anims.js"), null);
  assert.equal(thresholdsFor("/x/experiments/orbit/view.tsx"), null);
  assert.equal(thresholdsFor("/x/scratch/foo.py"), null);
  assert.equal(thresholdsFor("/x/prototypes/foo.rs"), null);
  assert.equal(thresholdsFor("/x/sandbox/foo.test.ts"), null, "sandbox beats the test-file branch");
  assert.equal(thresholdsFor("\\x\\sandbox\\anims.js"), null, "windows separators normalize");
  // …and the reported basename case.
  assert.equal(thresholdsFor("/x/webui/mindspace-lab-anims.js"), null);
  assert.equal(thresholdsFor("/x/scratch-pad.js"), null);

  // The regression that counts: whole-segment / delimiter-bounded matching, so
  // ordinary code with those letters inside a word keeps the convention.
  assert.deepEqual(thresholdsFor("/x/collaboration/view.tsx"), { guide: 500, critical: 800 });
  assert.deepEqual(thresholdsFor("/x/labels/view.tsx"), { guide: 500, critical: 800 });
  assert.deepEqual(thresholdsFor("/x/collab-view.ts"), { guide: 500, critical: 800 });
  assert.deepEqual(thresholdsFor("/x/foo-labels.ts"), { guide: 500, critical: 800 });
  assert.deepEqual(
    thresholdsFor("/x/prototype-utils.ts"),
    { guide: 500, critical: 800 },
    "Object.prototype is production code"
  );
});

test("throwaway directories count only BELOW the project anchor, never above it", () => {
  // A checkout that merely LIVES under ~/labs must keep the convention — the
  // ancestor segment is none of the project's business.
  const cwd = "/users/x/labs/myapp";
  assert.deepEqual(thresholdsFor(`${cwd}/src/view.tsx`, {}, cwd), { guide: 500, critical: 800 });
  assert.deepEqual(thresholdsFor(`${cwd}/packages/daemon/src/http.ts`, {}, cwd), { guide: 500, critical: 800 });
  assert.deepEqual(
    thresholdsFor("/users/x/scratch/myapp/src/view.tsx", {}, "/users/x/scratch/myapp/"),
    { guide: 500, critical: 800 },
    "a trailing slash on the anchor changes nothing"
  );
  // Project-INTERNAL throwaway dirs stay exempt, and so does the reported case.
  assert.equal(thresholdsFor(`${cwd}/labs/anims.js`, {}, cwd), null);
  assert.equal(thresholdsFor(`${cwd}/webui/sandbox/anims.js`, {}, cwd), null);
  assert.equal(thresholdsFor(`${cwd}/packages/daemon/webui/mindspace-lab-anims.js`, {}, cwd), null);
  // Anchor that does not contain the file → no anchor at all, old behaviour.
  assert.equal(thresholdsFor(`${cwd}/src/view.tsx`, {}, "/users/x/other"), null);
  assert.equal(thresholdsFor(`${cwd}/src/view.tsx`), null);
});

test("size.exemptPaths from cli-settings silences extra paths, nothing else", () => {
  const settings = { exemptPaths: ["webui/mindspace", "  ", "PACKAGES/Daemon/Demo"] };
  assert.equal(thresholdsFor("/x/webui/mindspace/orbit.js", settings), null);
  assert.equal(thresholdsFor("/x/packages/daemon/demo/app.js", settings), null, "match is case-insensitive");
  assert.deepEqual(thresholdsFor("/x/webui/js/app.js", settings), { guide: 500, critical: 800 });
  assert.deepEqual(thresholdsFor("/x/webui/js/app.js", { exemptPaths: [] }), { guide: 500, critical: 800 });
});

test("exempt paths stay silent end-to-end while the same file elsewhere warns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-size-exempt-"));
  try {
    const body = Array.from({ length: 1299 }, (_, i) => `// line ${i}`).join("\n");
    const lab = join(dir, "mindspace-lab-anims.js");
    const sandboxDir = join(dir, "sandbox");
    const plain = join(dir, "anims.js");
    await mkdir(sandboxDir, { recursive: true });
    await writeFile(lab, body, "utf8");
    await writeFile(join(sandboxDir, "anims.js"), body, "utf8");
    await writeFile(plain, body, "utf8");

    // Every call carries the tmp settingsPath — without it the test would read
    // the developer's real ~/.bastra/cli-settings.json and fail on any machine
    // with a raised size.critical or a wide size.exemptPaths. The file does not
    // exist yet at this point, which is exactly the built-in 500/800 default.
    const settingsPath = join(dir, "cli-settings.json");
    assert.equal(await fileSizeNote(lab, settingsPath), null, "the reported 1299-line sandbox file must stay silent");
    assert.equal(await fileSizeNote(join(sandboxDir, "anims.js"), settingsPath), null, "sandbox/ segment stays silent");
    const note = await fileSizeNote(plain, settingsPath);
    assert.ok(note?.includes('level="critical"'), "identical file outside a sandbox still warns");

    // The anchor reaches the hook entry point: with sandbox/ AS the project
    // root it is an ancestor, not a project-internal throwaway directory.
    const anchored = await fileSizeNote(join(sandboxDir, "anims.js"), settingsPath, sandboxDir);
    assert.ok(anchored?.includes('level="critical"'), "the project root itself is never a sandbox segment");

    await writeFile(settingsPath, JSON.stringify({ size: { exemptPaths: [dir] } }), "utf8");
    assert.equal(await fileSizeNote(plain, settingsPath), null, "settings exemption reaches the hook entry point");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("fileSizeNote measures real files; new files and kill-switch stay silent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-size-"));
  try {
    // Every call passes an explicit settingsPath: without one, readSizeSettings
    // falls back to the developer's real ~/.bastra/cli-settings.json, and a
    // size.critical raised past 900 — or, since #280, any size.exemptPaths
    // entry that happens to be a substring of the tmp path — turns this red on
    // one machine and green on the next.
    const settingsPath = join(dir, "cli-settings.json");
    const big = join(dir, "big.js");
    await writeFile(big, Array.from({ length: 900 }, (_, i) => `// line ${i}`).join("\n"), "utf8");
    const note = await fileSizeNote(big, settingsPath);
    assert.ok(note?.includes('level="critical"'), "900-line js file must warn");

    assert.equal(await fileSizeNote(join(dir, "does-not-exist.js"), settingsPath), null, "new file → silent");

    process.env.BASTRA_SIZE_CHECK = "off";
    assert.equal(await fileSizeNote(big, settingsPath), null, "kill-switch silences the check");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
