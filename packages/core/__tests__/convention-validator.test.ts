import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { ConventionValidatorSchema, FrontmatterSchema, parseMemory, parseMemoryWith } from "../src/schema.js";
import { SaveMemoryInput } from "../src/save-schema.js";
import { saveMemory } from "../src/save.js";

const validator = { tool: "validate_artifact", channel: "invented-channel", limit: 500, unit: "codepoints" } as const;
const input = { id: "invented-convention", title: "Invented convention", type: "workflow" as const,
  summary: "An invented rule", body: "Check the approved copy.", topic_path: ["fixture"], tags: ["fixture"],
  scope: "all-projects", recall_when: ["invented copy"] };
const fm = { ...input, created: "2026-10-29", updated: "2026-10-29" };

test("optional validator keeps old memories valid; lenient malformed metadata drops only that field", () => {
  assert.equal(FrontmatterSchema.parse(fm).validator, undefined);
  assert.equal(SaveMemoryInput.parse(input).validator, undefined);
  for (const invalid of [{ ...validator, tool: "shell" }, { ...validator, limit: 0 },
    { ...validator, limit: 1.5 }, { ...validator, channel: " " }, { ...validator, unit: "bytes" }, null]) {
    assert.equal(ConventionValidatorSchema.safeParse(invalid).success, false);
    const raw = matter.stringify(input.body, { ...fm, validator: invalid });
    const memory = parseMemoryWith(matter, raw, "invented.md", Date.now());
    assert.equal(memory.fm.id, input.id);
    assert.equal(memory.fm.validator, undefined);
    assert.ok(memory.damaged?.some((d) => d.field === "validator"));
    if (invalid !== null) assert.equal(SaveMemoryInput.safeParse({ ...input, validator: invalid }).success, false);
  }
});

test("save/load roundtrip preserves metadata on ordinary overwrite, replaces it explicitly, removes with null", async () => {
  const root = await mkdtemp(join(tmpdir(), "bastra-validator-save-"));
  try {
    const saved = await saveMemory(root, SaveMemoryInput.parse({ ...input, validator }));
    const load = async () => parseMemoryWith(matter, await readFile(saved.file_path, "utf8"), saved.file_path, Date.now()).fm;
    assert.deepEqual((await load()).validator, validator);
    await saveMemory(root, SaveMemoryInput.parse({ ...input, overwrite: true }));
    assert.deepEqual((await load()).validator, validator);
    await saveMemory(root, SaveMemoryInput.parse({ ...input, overwrite: true, validator: { ...validator, limit: 1000, unit: "utf16" } }));
    assert.equal((await load()).validator?.limit, 1000);
    await saveMemory(root, SaveMemoryInput.parse({ ...input, overwrite: true, validator: null }));
    assert.equal((await load()).validator, undefined);
    assert.equal(Object.hasOwn(matter(await readFile(saved.file_path, "utf8")).data, "validator"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("parseMemory keeps gray-matter cache pristine across file-specific lenient fallbacks", () => {
  const raw = "---\ntype: workflow\nvalidator: {tool: invalid}\n---\nAn invented cache isolation rule.\n";
  const first = parseMemory(raw, "/fixture/source-probe.md", 0);
  const second = parseMemory(raw, "/fixture/real-vault-note.md", Date.UTC(2026, 9, 29));
  assert.equal(first.fm.id, "source-probe");
  assert.equal(first.fm.created, "1970-01-01");
  assert.equal(second.fm.id, "real-vault-note");
  assert.equal(second.fm.created, "2026-10-29");
  assert.equal(second.fm.updated, "2026-10-29");
  assert.equal(first.fm.validator, undefined);
  assert.equal(second.fm.validator, undefined);
  assert.deepEqual(matter(raw).data, { type: "workflow", validator: { tool: "invalid" } });
});
