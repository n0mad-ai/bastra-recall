/**
 * Editing a saved vault-care note (memory browser, UI v2): POST /ui/annotate
 * with `previous` replaces the note of exactly that entry in vault-care.md —
 * kind, date and the done tick stay, everything else stays byte-identical,
 * and an entry changed or removed meanwhile is answered with 409.
 * Temporary vault directories only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARE_FILE, parseCareFile, replaceCareNote, rewriteCareNote, CareConflictError } from "../src/vault-care.js";
import { handleUiAnnotate } from "../src/webui.js";

const FILE = [
  "# Vault Care",
  "",
  "Flags from the vault map.",
  "",
  "- [x] 2026-07-25 · edit · [[alpha]] — done long ago. → 2026-07-26 merged by hand",
  "- [ ] 2026-11-01 · note · [[beta]] — first beta note",
  "  second line",
  "",
  "  after a blank line",
  "- [ ] 2026-11-02 · delete · [[beta]] — second beta flag",
  "- [ ] 2026-11-03 · edit · [[gamma]]",
  "Free text someone typed in Obsidian.",
  "- [x] 2026-11-04 · note · [[delta]] — ticked in Obsidian",
  "",
].join("\n");

const lines = (s: string) => s.split("\n");

test("replace a multi-line note: only its span changes, neighbours stay byte-identical", () => {
  const next = replaceCareNote(
    FILE,
    { id: "beta", kind: "note", date: "2026-11-01", note: "first beta note\nsecond line\n\nafter a blank line" },
    "rewritten in one line"
  );
  assert.ok(next);
  const a = lines(FILE),
    b = lines(next);
  assert.deepEqual(b.slice(0, 5), a.slice(0, 5));
  assert.equal(b[5], "- [ ] 2026-11-01 · note · [[beta]] — rewritten in one line");
  assert.deepEqual(b.slice(6), a.slice(9), "no remains of the old continuation lines");
  const beta = parseCareFile(next).filter((e) => e.id === "beta");
  assert.deepEqual(
    beta.map((e) => [e.kind, e.note]),
    [
      ["note", "rewritten in one line"],
      ["delete", "second beta flag"],
    ]
  );
});

test("replace a single-line note with a long multi-line one; the other note of that memory stays", () => {
  const long = Array.from({ length: 60 }, (_, i) => `Zeile ${i}: ${"wort ".repeat(12).trim()}`)
    .join("\n\n")
    .replace("Zeile 2:", "  - eingerückt:");
  const next = replaceCareNote(
    FILE,
    { id: "beta", kind: "delete", date: "2026-11-02", note: "second beta flag" },
    long
  );
  assert.ok(next);
  const parsed = parseCareFile(next);
  assert.equal(parsed.find((e) => e.kind === "delete")!.note, long);
  assert.equal(parsed.find((e) => e.id === "beta" && e.kind === "note")!.note.startsWith("first beta note"), true);
  const a = lines(FILE),
    b = lines(next);
  assert.deepEqual(b.slice(0, 9), a.slice(0, 9));
  assert.deepEqual(b.slice(-4), a.slice(-4), "the following entries and the hand-typed line stay");
  assert.equal(parsed.length, parseCareFile(FILE).length);
});

test("kind, date and the done tick stay; an empty note becomes a note", () => {
  const ticked = replaceCareNote(
    FILE,
    { id: "delta", kind: "note", date: "2026-11-04", note: "ticked in Obsidian" },
    "still ticked"
  );
  assert.ok(ticked?.includes("- [x] 2026-11-04 · note · [[delta]] — still ticked"));
  const filled = replaceCareNote(FILE, { id: "gamma", kind: "edit", date: "2026-11-03", note: "" }, "now with text");
  assert.ok(filled?.includes("- [ ] 2026-11-03 · edit · [[gamma]] — now with text\nFree text someone typed"));
});

test("an entry changed or removed meanwhile is not found: null, nothing changes", () => {
  assert.equal(
    replaceCareNote(FILE, { id: "beta", kind: "note", date: "2026-11-01", note: "first beta note" }, "x"),
    null
  );
  assert.equal(replaceCareNote(FILE, { id: "gone", kind: "note", date: "2026-11-01", note: "" }, "x"), null);
  assert.equal(
    replaceCareNote(FILE, { id: "beta", kind: "edit", date: "2026-11-02", note: "second beta flag" }, "x"),
    null
  );
});

test("CRLF files keep their line endings", () => {
  const crlf = FILE.replace(/\n/g, "\r\n");
  const next = replaceCareNote(
    crlf,
    { id: "beta", kind: "delete", date: "2026-11-02", note: "second beta flag" },
    "a\nb"
  );
  assert.ok(next);
  assert.ok(next.includes("- [ ] 2026-11-02 · delete · [[beta]] — a\r\n  b\r\n- [ ] 2026-11-03"));
  assert.equal(parseCareFile(next).find((e) => e.kind === "delete")!.note, "a\nb");
});

test("rewriteCareNote: atomic replace, no temp file left, conflict when the entry is gone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-care-edit-"));
  try {
    const file = join(dir, CARE_FILE);
    await writeFile(file, FILE);
    const entry = await rewriteCareNote(
      file,
      { id: "beta", kind: "delete", date: "2026-11-02", note: "second beta flag" },
      "edited"
    );
    assert.deepEqual(entry, { done: false, date: "2026-11-02", kind: "delete", id: "beta", note: "edited" });
    assert.equal(
      await readFile(file, "utf8"),
      FILE.replace("— second beta flag", "— edited"),
      "only that entry changed"
    );
    assert.deepEqual(await readdir(dir), [CARE_FILE]);
    await assert.rejects(
      rewriteCareNote(file, { id: "beta", kind: "delete", date: "2026-11-02", note: "second beta flag" }, "again"),
      CareConflictError
    );
    assert.deepEqual(await readdir(dir), [CARE_FILE]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /ui/annotate with previous edits in place; 409 on conflict, 400 on an empty note", async () => {
  const vaultDir = await mkdtemp(join(tmpdir(), "bastra-care-edit-vault-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "bastra-care-edit-settings-"));
  const settingsPath = join(settingsDir, "cli-settings.json");
  await writeFile(settingsPath, JSON.stringify({ ui: { enabled: true } }));
  await writeFile(join(vaultDir, CARE_FILE), FILE);
  const server = createServer((req, res) => void handleUiAnnotate(req, res, vaultDir, settingsPath));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const post = async (payload: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/ui/annotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { status: r.status, body: (await r.json()) as { entry?: unknown } };
  };
  try {
    const previous = { kind: "note", date: "2026-11-01", note: "first beta note\nsecond line\n\nafter a blank line" };
    const ok = await post({ id: "beta", kind: "note", note: "  new\r\ntext  ", previous });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.entry, { done: false, date: "2026-11-01", kind: "note", id: "beta", note: "new\ntext" });
    const raw = await readFile(join(vaultDir, CARE_FILE), "utf8");
    assert.ok(raw.includes("- [ ] 2026-11-01 · note · [[beta]] — new\n  text\n- [ ] 2026-11-02"));
    assert.equal(parseCareFile(raw).length, parseCareFile(FILE).length, "edit appends nothing");
    // the same previous again: changed meanwhile → 409, file unchanged
    assert.equal((await post({ id: "beta", kind: "note", note: "x", previous })).status, 409);
    assert.equal(await readFile(join(vaultDir, CARE_FILE), "utf8"), raw);
    // an emptied note is never stored as an edit
    const empty = await post({ id: "beta", kind: "note", note: "  ", previous: { ...previous, note: "new\ntext" } });
    assert.equal(empty.status, 400);
    // malformed previous
    assert.equal((await post({ id: "beta", kind: "note", note: "x", previous: { kind: "note" } })).status, 400);
    assert.equal(await readFile(join(vaultDir, CARE_FILE), "utf8"), raw);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(vaultDir, { recursive: true, force: true });
    await rm(settingsDir, { recursive: true, force: true });
  }
});
