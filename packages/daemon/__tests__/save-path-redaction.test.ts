/**
 * #1470 — credentials are redacted on the main write path (save_memory,
 * edit_memory, save_document) and named in the receipt; text without a
 * credential is written byte for byte.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { saveMemoryHandler, type SaveMemoryResult } from "../src/save-memory-handler.js";
import { editMemoryHandler, type EditMemoryResult } from "../src/edit-memory-handler.js";
import { saveDocument } from "../src/documents-write-handler.js";
import { resetAuditLogCache } from "../src/audit-trail.js";
import type { ToolDeps } from "../src/tool-deps.js";

// Assembled from chunks so the fixture is not itself a scannable token.
const GITHUB_TOKEN = ["gh", "p_", "a1B2c3D4e5F6", "g7H8i9J0k1L2", "m3N4o5P6q7R8"].join("");
const API_KEY = ["sk", "-", "proj", "Xy7Qw2Lp9Rt", "4Zm8Kd3Vb6Nc"].join("");

/** Text a memory legitimately holds: none of it is a credential value. */
const HARMLESS = [
  "Run `git log 3f9c2a1b7d4e6f8091a2b3c4d5e6f7a8b9c0d1e2` before the release.",
  `Config lives in ${join(homedir(), ".config", "bastra", "settings.json")}.`,
  "The key comes from $API_TOKEN and password: ${DB_PASSWORD} in CI.",
  "Run id 0b9e5f62-1c3a-4d7e-9f20-6a8b7c5d4e31, docs at https://example.org/guide?page=2.",
  "We spent the token budget on the summary; the secret of a good test is a clear name.",
].join("\n");

async function fixture(t: { after: (fn: () => unknown) => void }) {
  resetAuditLogCache();
  const vaultRoot = await mkdtemp(join(tmpdir(), "bastra-1470-"));
  const vault = new Vault(vaultRoot);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: vaultRoot };
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    resetAuditLogCache();
    await rm(vaultRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { deps, vault, vaultRoot };
}

const memory = (over: Record<string, unknown> = {}) => ({
  title: "Deploy notes",
  type: "lesson",
  summary: "How the deploy works.",
  body: "Deploy with the script.\n",
  topic_path: ["ops", "deploy"],
  tags: ["deploy"],
  scope: "ops",
  recall_when: ["deploying the service"],
  ...over,
});

test("save_memory redacts credentials in every text field and names them in the receipt", async (t) => {
  const { deps } = await fixture(t);
  const result = (await saveMemoryHandler(
    deps,
    memory({
      summary: `Deploy uses token ${GITHUB_TOKEN}.`,
      body: `Export GITHUB_TOKEN=${GITHUB_TOKEN}\ncurl -H "Authorization: Bearer ${API_KEY}" https://api.example.org\n`,
      recall_when: ["deploying the service", `api key ${API_KEY}`],
      body_ends_with: "https://api.example.org",
    })
  )) as SaveMemoryResult;
  const raw = await readFile(result.file_path, "utf8");
  assert.ok(!raw.includes(GITHUB_TOKEN), raw);
  assert.ok(!raw.includes(API_KEY), raw);
  assert.match(raw, /\[REDACTED\]/);
  assert.deepEqual(result.secrets_redacted, { summary: 1, body: 2, recall_when: 1 });
  assert.match(
    result.warning ?? "",
    /Credentials were redacted before writing: summary \(1\), body \(2\), recall_when \(1\)/
  );
});

test("save_memory writes text without a credential byte for byte and reports nothing", async (t) => {
  const { deps } = await fixture(t);
  const result = (await saveMemoryHandler(deps, memory({ body: HARMLESS + "\n" }))) as SaveMemoryResult;
  assert.equal(result.secrets_redacted, undefined);
  assert.ok(!(result.warning ?? "").includes("redacted"));
  const raw = await readFile(result.file_path, "utf8");
  assert.ok(raw.includes(HARMLESS), raw);
  assert.ok(!raw.includes("[REDACTED]"));
});

test("edit_memory redacts the new text, never the text it has to match", async (t) => {
  const { deps } = await fixture(t);
  const saved = (await saveMemoryHandler(deps, memory({ body: "Step one.\n\nStep two.\n" }))) as SaveMemoryResult;
  const edited = (await editMemoryHandler(deps, {
    id: saved.id,
    str_replace: { old_str: "Step two.", new_str: `Step two: login with ${GITHUB_TOKEN}.` },
    append: `Fallback key: ${API_KEY}`,
    frontmatter: { summary: `Deploy, token ${GITHUB_TOKEN}.` },
  })) as EditMemoryResult;
  const raw = await readFile(edited.file_path, "utf8");
  assert.ok(!raw.includes(GITHUB_TOKEN) && !raw.includes(API_KEY), raw);
  assert.match(raw, /Step one\./);
  assert.deepEqual(edited.secrets_redacted, { body: 2, summary: 1 });
  assert.match(edited.warning ?? "", /Credentials were redacted/);
});

test("edit_memory without a credential reports nothing", async (t) => {
  const { deps } = await fixture(t);
  const saved = (await saveMemoryHandler(deps, memory())) as SaveMemoryResult;
  const edited = (await editMemoryHandler(deps, { id: saved.id, append: HARMLESS })) as EditMemoryResult;
  assert.equal(edited.secrets_redacted, undefined);
  assert.ok((await readFile(edited.file_path, "utf8")).includes(HARMLESS));
});

test("save_document redacts the sidecar text and names it in the receipt", async (t) => {
  const { vault, vaultRoot } = await fixture(t);
  const src = join(vaultRoot, "notes.txt");
  await writeFile(src, "original bytes stay untouched", "utf8");
  const result = await saveDocument(vault, {
    original_path: src,
    folder_path: "",
    title: "Server notes",
    tags: ["server"],
    category: "notiz",
    linked_file: true,
    body: `ssh deploy@host\nAPI_KEY=${API_KEY}\n${HARMLESS}`,
    overwrite: false,
  });
  const raw = await readFile(result.sidecar_path, "utf8");
  assert.ok(!raw.includes(API_KEY), raw);
  assert.ok(raw.includes(HARMLESS), "harmless text stays verbatim");
  assert.deepEqual(result.secrets_redacted, { body: 1 });
  assert.match(result.warning ?? "", /Credentials were redacted before writing: body \(1\)/);
  assert.equal(await readFile(src, "utf8"), "original bytes stay untouched");
});

test("save_document without a credential reports nothing", async (t) => {
  const { vault, vaultRoot } = await fixture(t);
  const src = join(vaultRoot, "plain.txt");
  await writeFile(src, "x", "utf8");
  const result = await saveDocument(vault, {
    original_path: src,
    folder_path: "",
    title: "Plain",
    tags: ["plain"],
    category: "notiz",
    linked_file: true,
    body: HARMLESS,
    overwrite: false,
  });
  assert.equal(result.secrets_redacted, undefined);
  assert.ok((await readFile(result.sidecar_path, "utf8")).includes(HARMLESS));
});
