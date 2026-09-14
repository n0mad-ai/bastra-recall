/**
 * Tests für den Import-Review-Pfad (#208):
 *   - extractCandidates — Memory-Listen parsen, Rauschen filtern,
 *     Conversation-Exporte ablehnen
 *   - stageImport / parseImportFile / countOpenImports — Staging-Datei,
 *     Dedupe (auch gegen abgelehnte Einträge), Tick-Semantik
 *
 * Runner: `tsx --test __tests__/import-review.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import {
  extractCandidates,
  detectSource,
  stageImport,
  parseImportFile,
  countOpenImports,
  ConversationExportError,
  SelfImportError,
  handleUiImport,
  IMPORT_FILE,
} from "../src/import-review.js";

test("extractCandidates: strips bullets/numbering, drops noise, dedupes", () => {
  const raw = [
    "# My exported memories", // heading → dropped
    "- Prefers concise replies without preamble",
    "2) Works at a small AI startup in Berlin",
    "• Prefers concise replies without preamble", // duplicate (case-insensitive after clean)
    "ok", // too short
    "",
    "Uses TypeScript and vanilla ES modules for frontend work",
  ].join("\n");
  const c = extractCandidates(raw);
  assert.deepEqual(c, [
    "Prefers concise replies without preamble",
    "Works at a small AI startup in Berlin",
    "Uses TypeScript and vanilla ES modules for frontend work",
  ]);
});

test("extractCandidates: JSON array of strings works, conversation export is rejected", () => {
  const arr = extractCandidates(JSON.stringify(["Likes espresso more than filter coffee", "x"]));
  assert.deepEqual(arr, ["Likes espresso more than filter coffee"]);

  const conversations = JSON.stringify([
    { title: "chat 1", mapping: { a: { message: { content: "hi" } } } },
  ]);
  assert.throws(() => extractCandidates(conversations), ConversationExportError);
});

// #313: the staging file itself (or a copy under any name) is never a source —
// re-staging would nest checkbox lines inside themselves.
test("extractCandidates: bastra's own staging format is refused by content", () => {
  const reviewCopy = [
    "# Import Review",
    "- [ ] 2026-08-01 · chatgpt · Reads diffs rather than summaries when reviewing work.",
    "- [x] 2026-08-01 · text · Uses Homebrew on macOS and avoids global npm installs.",
  ].join("\n");
  assert.throws(() => extractCandidates(reviewCopy), SelfImportError);

  // one staged line among ordinary bullets still identifies the file
  const mixed = "- A perfectly ordinary exported memory line\n- [ ] 2026-08-01 · gemini · staged entry here";
  assert.throws(() => extractCandidates(mixed), SelfImportError);

  // ordinary checkboxes WITHOUT the date·source prefix stay importable
  const todoList = extractCandidates("- [ ] Prefers concise replies without preamble");
  assert.deepEqual(todoList, ["Prefers concise replies without preamble"]);
});

test("detectSource: override wins, filename hints, text fallback", () => {
  assert.equal(detectSource("whatever.txt", "claude"), "claude");
  assert.equal(detectSource("chatgpt-memories.txt", null), "chatgpt");
  assert.equal(detectSource("Takeout-gemini.json", null), "gemini");
  assert.equal(detectSource("notes.txt", null), "text");
});

test("stageImport: creates the review file, dedupes against ticked AND open entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-import-test-"));
  try {
    const first = await stageImport(dir, "chatgpt", [
      "Prefers concise replies without preamble",
      "Works at a small AI startup in Berlin",
    ]);
    assert.equal(first.staged, 2);
    assert.equal(first.openTotal, 2);

    // second run: one duplicate, one new
    const second = await stageImport(dir, "chatgpt", [
      "Prefers concise replies without preamble",
      "Enjoys long-distance running on weekends",
    ]);
    assert.equal(second.staged, 1);
    assert.equal(second.skippedDuplicates, 1);
    assert.equal(second.openTotal, 3);

    // the session ticks one line (rejected) — count drops, re-import stays deduped
    const filePath = join(dir, IMPORT_FILE);
    const content = await readFile(filePath, "utf8");
    await writeFile(filePath, content.replace("- [ ] ", "- [x] "), "utf8"); // tick the first
    assert.equal(await countOpenImports(dir), 2);
    const third = await stageImport(dir, "chatgpt", ["Prefers concise replies without preamble"]);
    assert.equal(third.staged, 0, "a ticked (worked-off) fact must not resurface");
    assert.equal(third.skippedDuplicates, 1);

    const entries = parseImportFile(await readFile(filePath, "utf8"));
    assert.equal(entries.length, 3);
    assert.equal(entries.filter((e) => e.done).length, 1);
    assert.ok(entries.every((e) => e.source === "chatgpt" && /\d{4}-\d{2}-\d{2}/.test(e.date)));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("countOpenImports: missing file → 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-import-empty-"));
  try {
    assert.equal(await countOpenImports(dir), 0);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("POST /ui/import: gated on ui.enabled, stages like the CLI", async () => {
  const vaultDir = await mkdtemp(join(tmpdir(), "bastra-import-ui-vault-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "bastra-import-ui-settings-"));
  const settingsPath = join(settingsDir, "cli-settings.json");
  const server = createServer((req, res) => {
    void handleUiImport(req, res, vaultDir, settingsPath);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const post = (body: unknown): Promise<{ status: number; json: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const req = request(
        { hostname: "127.0.0.1", port, path: "/ui/import", method: "POST", headers: { "Content-Type": "application/json" } },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw) as Record<string, unknown> }),
          );
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });

  try {
    // ui disabled → 404, nothing staged
    const off = await post({ text: "- Prefers concise replies without preamble", source: "chatgpt" });
    assert.equal(off.status, 404);
    assert.equal(await countOpenImports(vaultDir), 0);

    await writeFile(settingsPath, JSON.stringify({ ui: { enabled: true } }));

    const ok = await post({ text: "- Prefers concise replies without preamble\n- short\n- Works at a small AI startup in Berlin", source: "chatgpt" });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.staged, 2);
    assert.equal(ok.json.open_total, 2);
    assert.equal(await countOpenImports(vaultDir), 2);

    const empty = await post({ text: "   ", source: "chatgpt" });
    assert.equal(empty.status, 400);

    const convo = await post({ text: JSON.stringify([{ mapping: {} }]), source: "chatgpt" });
    assert.equal(convo.status, 422, "conversation export rejected with a hint");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(vaultDir, { recursive: true, force: true });
    await rm(settingsDir, { recursive: true, force: true });
  }
});

test("#529: overlapping stageImport writers keep the union and report durable counts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-import-race-"));
  try {
    const writers = 40;
    const shared = "Every writer stages this very same shared candidate line";
    const results = await Promise.all(
      Array.from({ length: writers }, (_, i) =>
        stageImport(dir, "text", [`independent import candidate number ${String(i).padStart(3, "0")}`, shared]),
      ),
    );

    // Durable union: every unique candidate plus the shared one exactly once.
    const persisted = parseImportFile(await readFile(join(dir, IMPORT_FILE), "utf8"));
    assert.equal(persisted.length, writers + 1);
    assert.equal(persisted.filter((e) => e.text === shared).length, 1, "the shared candidate is staged once");
    assert.equal(await countOpenImports(dir), writers + 1);

    // Reported numbers describe what is on disk, not an overwritten draft.
    const staged = results.reduce((n, r) => n + r.staged, 0);
    const skipped = results.reduce((n, r) => n + r.skippedDuplicates, 0);
    assert.equal(staged, writers + 1);
    assert.equal(skipped, writers - 1, "every writer but the first sees the shared line as a duplicate");
    assert.equal(Math.max(...results.map((r) => r.openTotal)), writers + 1);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("#529: an aborted stageImport write leaves the review file intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-import-crash-"));
  try {
    await stageImport(dir, "text", ["A first candidate that must survive a crashed write"]);
    const filePath = join(dir, IMPORT_FILE);
    const before = await readFile(filePath, "utf8");

    // What a crash mid-write leaves behind: a half-written tmp file. The live
    // file is only ever replaced by rename, so it is never truncated.
    const halfWritten = `${filePath}.tmp-${process.pid}-deadbeef`;
    await writeFile(halfWritten, "# Import Review\n\n- [ ] 2026-09-12 · text · trunc", "utf8");
    assert.equal(await readFile(filePath, "utf8"), before);
    assert.equal(await countOpenImports(dir), 1);

    // A write-protected review file proves the point: the old read/modify/
    // write opened it for truncation, the fix renames a fresh file over it.
    await chmod(filePath, 0o444);
    const second = await stageImport(dir, "text", ["A second candidate staged over a write-protected file"]);
    assert.equal(second.staged, 1);
    assert.equal(second.openTotal, 2);
    assert.equal(await countOpenImports(dir), 2);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
