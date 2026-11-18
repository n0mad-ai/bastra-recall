import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import matter from "gray-matter";
import { saveMemory, type SaveMemoryInput } from "@bastra-recall/core";
import { importVault } from "../src/import-vault.js";
import { resetAuditLogCache, saveMemoryWithAuditTrail } from "../src/audit-trail.js";
import { cmdImport } from "../src/cli/import-cmd.js";
import { parseArgs } from "../src/cli/commands.js";

// Fictitious credentials; use the real importer, save plan and audit append.
const secret = "sk-ant-api03-" + "A7b9C2d4E6f8G0h1".repeat(4);
const original = `---\nname: 'Credential note ${secret}'\ndescription: 'Connection password=fictional-summary-42'\ntype: project\n---\n# Connection\n\npassword=fictional-body-72\n\n${secret}\n`;

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "import-redaction-"));
  const vault = join(root, "vault");
  const source = join(root, "source");
  await mkdir(vault);
  await mkdir(source);
  await writeFile(join(source, "note.md"), original);
  resetAuditLogCache();
  t.after(async () => {
    resetAuditLogCache();
    await rm(root, { recursive: true, force: true });
  });
  return { root, vault, source };
}

function assertClean(raw: string) {
  for (const value of [secret, "fictional-summary-42", "fictional-body-72"]) assert.ok(!raw.includes(value));
  assert.ok(raw.includes("[REDACTED]"));
}

test("vault import redacts content and audit postimage, reports fields and preserves no-op imports", async (t) => {
  const { vault, source } = await fixture(t);
  const first = await importVault(vault, source, { label: "notes" });
  assert.equal(first.written.created, 1);
  assert.ok(first.warnings.some((w) => /Credentials were redacted.*title.*summary.*body/.test(w.reason)));
  const path = join(vault, "memories/imported/notes", first.ids[0] + ".md");
  const raw = await readFile(path, "utf8");
  assertClean(raw);
  const stored = matter(raw).data;
  assert.equal(stored.source, "claude-code-memory:notes:note.md");
  assert.equal(stored.write_origin, "user-directed");
  assert.equal(stored.id, first.ids[0]);
  const auditPath = join(vault, ".bastra/audit-log.ndjson");
  const audit = await readFile(auditPath, "utf8");
  assertClean(audit);
  const entry = JSON.parse(audit.trim());
  assert.equal(entry.diff_before, null);
  assert.deepEqual(entry.diff_after, stored);
  assert.equal(entry.actor, "import");
  assert.equal(await readFile(join(source, "note.md"), "utf8"), original);
  const second = await importVault(vault, source, { label: "notes" });
  assert.deepEqual(second.ids, first.ids);
  assert.equal(second.written.unchanged, 1);
  assert.equal(second.written.updated, 0);
  assert.equal(await readFile(path, "utf8"), raw);
  assert.equal(await readFile(auditPath, "utf8"), audit);
});

test("client CLI import redacts frontmatter and body before the CLI-attributed audit append", async (t) => {
  const { root, vault } = await fixture(t);
  const codex = join(root, "codex");
  await mkdir(join(codex, "memories"), { recursive: true });
  await writeFile(join(codex, "memories/note.md"), original);
  const previous = { codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
  process.env.CODEX_HOME = codex;
  process.env.CLAUDE_CONFIG_DIR = join(root, "empty-claude");
  try {
    assert.equal(await cmdImport(parseArgs(["import", "clients", "--vault", vault])), 0);
    const audit = await readFile(join(vault, ".bastra/audit-log.ndjson"), "utf8");
    assertClean(audit);
    const entry = JSON.parse(audit.trim());
    assert.equal(entry.transport, "cli");
    assert.equal(entry.client, "bastra-cli");
    assert.equal(entry.caller_session, null);
    assertClean(await readFile(join(vault, "memories/imported/codex", entry.memory_id + ".md"), "utf8"));
    assert.equal(await readFile(join(codex, "memories/note.md"), "utf8"), original);
  } finally {
    if (previous.codex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous.codex;
    if (previous.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous.claude;
  }
});

test("direct save redaction preserves caller input, original-tail validation and exact CAS preimages", async (t) => {
  const { vault } = await fixture(t);
  const input: SaveMemoryInput = {
    id: "credential-note",
    title: "Connection",
    type: "reference",
    summary: "Connection details",
    body: "password=fictional-body-72",
    body_ends_with: "fictional-body-72",
    topic_path: ["connection"],
    tags: ["connection"],
    scope: "test",
    recall_when: ["connection"],
    write_origin: "user-directed",
    source: "generic:notes:note.md",
  };
  const before = structuredClone(input);
  const args = { vaultRoot: vault, input, actor: "import" as const, actorDetail: "import:vault", sessionId: "fixture" };
  const first = await saveMemoryWithAuditTrail({ ...args, commit: { expectedTarget: null } });
  assert.deepEqual(input, before);
  assert.deepEqual(first.secrets_redacted, { body: 1 });
  const raw = await readFile(first.file_path, "utf8");
  assertClean(raw);
  const auditPath = join(vault, ".bastra/audit-log.ndjson");
  const firstAudit = await readFile(auditPath, "utf8");
  await assert.rejects(saveMemoryWithAuditTrail({ ...args, input: { ...input, body_ends_with: "missing-tail" } }));
  await assert.rejects(
    saveMemoryWithAuditTrail({ ...args, input: { ...input, overwrite: true }, commit: { expectedTarget: null } })
  );
  assert.equal(await readFile(first.file_path, "utf8"), raw);
  assert.equal(await readFile(auditPath, "utf8"), firstAudit);
  const update = await saveMemoryWithAuditTrail({
    ...args,
    input: { ...input, overwrite: true, body: "password=fictional-new-92", body_ends_with: undefined },
    commit: { expectedTarget: raw },
  });
  assert.equal(update.created, false);
  const entries = (await readFile(auditPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(entries[1].diff_before, matter(raw).data);
  assert.deepEqual(entries[1].diff_after, matter(await readFile(first.file_path, "utf8")).data);
});

test("updating a legacy credential note sanitizes only new audit bytes and preserves the raw CAS snapshot", async (t) => {
  const { vault } = await fixture(t);
  const input: SaveMemoryInput = {
    id: "legacy-note",
    title: `Connection ${secret}`,
    type: "reference",
    summary: "Connection password=fictional-summary-42",
    body: "password=fictional-body-72",
    topic_path: ["connection"],
    tags: ["connection"],
    scope: "test",
    recall_when: ["connection"],
    write_origin: "user-directed",
    source: "generic:notes:legacy.md",
    rulebook_proposed: { rulebook: "always", applies_when: "During connection setup" },
  };
  const legacy = await saveMemory(vault, input);
  const oldRaw = await readFile(legacy.file_path, "utf8");
  const oldFm = matter(oldRaw).data;
  const auditPath = join(vault, ".bastra/audit-log.ndjson");
  await mkdir(join(vault, ".bastra"), { recursive: true });
  const oldHistory = JSON.stringify({ id: "historical", memory_id: legacy.id, diff_after: oldFm }) + "\n";
  await writeFile(auditPath, oldHistory);
  const args = {
    vaultRoot: vault,
    input: { ...input, overwrite: true },
    actor: "import" as const,
    actorDetail: "import:vault",
    sessionId: "fixture",
  };
  const originalInput = structuredClone(args.input);
  await assert.rejects(saveMemoryWithAuditTrail({ ...args, commit: { expectedTarget: oldRaw + "stale" } }));
  assert.equal(await readFile(legacy.file_path, "utf8"), oldRaw);
  assert.equal(await readFile(auditPath, "utf8"), oldHistory);
  const updated = await saveMemoryWithAuditTrail({ ...args, commit: { expectedTarget: oldRaw } });
  assert.deepEqual(args.input, originalInput);
  assert.deepEqual(updated.audit_before, oldFm, "the mutation's exact preimage is not modified");
  assert.ok(updated.warning?.includes("audit_before.title"));
  assert.equal(updated.secrets_redacted?.body, 1, "audit redaction retains the save receipt counts");
  assert.equal(updated.secrets_redacted?.["audit_before.title"], 1);
  const history = await readFile(auditPath, "utf8");
  assert.equal(history.slice(0, oldHistory.length), oldHistory, "old ledger bytes stay untouched");
  const append = history.slice(oldHistory.length);
  assertClean(append);
  const entry = JSON.parse(append.trim());
  assert.equal(entry.diff_before.source, oldFm.source);
  assert.equal(entry.diff_before.id, oldFm.id);
  assert.deepEqual(entry.diff_before.rulebook_proposed, oldFm.rulebook_proposed);
  assert.deepEqual(entry.diff_after.rulebook_proposed, oldFm.rulebook_proposed);
  assertClean(await readFile(updated.file_path, "utf8"));
});

test("the synthetic navigation index redacts a credential section and reports its warning", async (t) => {
  const { vault, source } = await fixture(t);
  const index = `# Memory\n\n## Connection ${secret}\n- [Connection](note.md) — connection details\n`;
  await writeFile(join(source, "MEMORY.md"), index);
  const result = await importVault(vault, source, { label: "notes" });
  assert.equal(result.written.created, 2);
  assert.ok(
    result.warnings.some(
      (warning) => warning.path === "MEMORY.md" && /Credentials were redacted.*body/.test(warning.reason)
    )
  );
  const storedIndex = await readFile(join(vault, "memories/imported/notes", result.indexNode + ".md"), "utf8");
  assertClean(storedIndex);
  assert.equal(matter(storedIndex).data.source, "index:notes");
  assertClean(await readFile(join(vault, ".bastra/audit-log.ndjson"), "utf8"));
  assert.equal(await readFile(join(source, "MEMORY.md"), "utf8"), index);
});
