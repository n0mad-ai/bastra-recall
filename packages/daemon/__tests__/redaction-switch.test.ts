/**
 * Owner decision 25.11.2026 (1.3.0): `redaction.enabled` switches credential
 * redaction in user content off. On (the default) every site redacts as
 * before; off, the text stays byte for byte at every site that changes the
 * user's content. The audit trail is a log and stays redacted.
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/redaction-switch.test.ts
 */
import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, Vault, SearchIndex } from "@bastra-recall/core";
import { mutateSettings, readSettings, settingsFilePath } from "../src/settings.js";
import { applySettingChanges, settingEntry } from "../src/settings-registry.js";
import { redactionEnabled, redactUserText } from "../src/user-text-redaction.js";
import { Telemetry } from "../src/telemetry.js";
import { saveMemoryHandler, type SaveMemoryResult } from "../src/save-memory-handler.js";
import { editMemoryHandler, type EditMemoryResult } from "../src/edit-memory-handler.js";
import { saveDocument } from "../src/documents-write-handler.js";
import { saveProductDocHandler } from "../src/product-doc-handler.js";
import { createBridgeMethods } from "../src/bridge-methods.js";
import { resetAuditLogCache } from "../src/audit-trail.js";
import { cleanDraftLine, cleanDraftText } from "../src/draft-text.js";
import { draftFingerprint, draftId, listDrafts, upsertDraft, type Draft } from "../src/draft-store.js";
import { situationForTurn } from "../src/draft-situation.js";
import { writePendingSuggestion } from "../src/pending-suggestions.js";
import { readAppRecord } from "../src/app-record-store.js";
import { cleanText } from "../src/task-store.js";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import type { ToolDeps } from "../src/tool-deps.js";

// Assembled from chunks so the fixture is not itself a scannable token.
const TOKEN = ["gh", "p_", "a1B2c3D4e5F6", "g7H8i9J0k1L2", "m3N4o5P6q7R8"].join("");
const TEXT = `Export GITHUB_TOKEN=${TOKEN} before the deploy.`;

async function setRedaction(on: boolean | null): Promise<void> {
  await mutateSettings(settingsFilePath(), (c) => applySettingChanges(c, { "redaction.enabled": on }));
}

/** Runs `work` once with the switch on and once off; the default is restored after. */
async function bothWays(work: (on: boolean) => Promise<void>): Promise<void> {
  try {
    for (const on of [true, false]) {
      await setRedaction(on);
      await work(on);
    }
  } finally {
    await setRedaction(null);
  }
}

async function vaultFixture(t: { after: (fn: () => unknown) => void }) {
  resetAuditLogCache();
  const vaultRoot = await mkdtemp(join(tmpdir(), "redaction-switch-"));
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

test("the switch is a registry setting, on by default, and settable like any other", async () => {
  const entry = settingEntry("redaction.enabled");
  assert.ok(entry);
  assert.equal(entry.default, true);
  assert.equal(entry.kind, "boolean");
  assert.equal(redactionEnabled(), true, "nothing stored: on");
  await bothWays(async (on) => {
    assert.equal((await readSettings()).redaction?.enabled, on);
    assert.equal(redactionEnabled(), on, "a write in this process applies at once");
  });
  assert.equal(redactionEnabled(), true);
});

test("redactUserText: on redacts, off returns the text unchanged", () =>
  bothWays(async (on) => {
    const out = redactUserText(TEXT);
    if (on) assert.ok(!out.text.includes(TOKEN) && out.redactedChars > 0);
    else assert.deepEqual(out, { text: TEXT, redactedChars: 0 });
  }));

test("save_memory: on redacts and names it; off writes the text byte for byte and says nothing", (t) =>
  bothWays(async (on) => {
    const { deps, vaultRoot } = await vaultFixture(t);
    const result = (await saveMemoryHandler(
      deps,
      memory({ title: `Deploy ${on}`, summary: TEXT, body: `${TEXT}\n` })
    )) as SaveMemoryResult;
    const raw = await readFile(result.file_path, "utf8");
    const audit = await readFile(join(vaultRoot, ".bastra", "audit-log.ndjson"), "utf8");
    assert.ok(!audit.includes(TOKEN), "the audit log stays redacted either way");
    if (on) {
      assert.ok(!raw.includes(TOKEN));
      assert.deepEqual(result.secrets_redacted, { summary: 1, body: 1 });
    } else {
      assert.ok(raw.includes(`summary: ${TEXT}`) || raw.includes(TEXT), raw);
      assert.ok(raw.includes(`${TEXT}\n`), raw);
      assert.equal(result.secrets_redacted, undefined);
      assert.equal(result.warning, undefined, "no receipt claims a placeholder the note does not hold");
    }
  }));

test("edit_memory: off appends the text byte for byte", (t) =>
  bothWays(async (on) => {
    const { deps } = await vaultFixture(t);
    const saved = (await saveMemoryHandler(deps, memory({ title: `Edit ${on}` }))) as SaveMemoryResult;
    const edited = (await editMemoryHandler(deps, { id: saved.id, append: TEXT })) as EditMemoryResult;
    const raw = await readFile(saved.file_path, "utf8");
    assert.equal(raw.includes(TOKEN), !on, raw);
    assert.equal(edited.secrets_redacted === undefined, !on);
  }));

test("turning redaction back on keeps older credentials out of new audit entries", async (t) => {
  const { deps, vaultRoot } = await vaultFixture(t);
  t.after(() => setRedaction(null));
  await setRedaction(false);
  const saved = (await saveMemoryHandler(deps, memory({ summary: TEXT }))) as SaveMemoryResult;
  await setRedaction(true);
  await editMemoryHandler(deps, { id: saved.id, append: "Deployment succeeded." });

  assert.ok((await readFile(saved.file_path, "utf8")).includes(TOKEN), "existing note keeps its original summary");
  const audit = await readFile(join(vaultRoot, ".bastra", "audit-log.ndjson"), "utf8");
  assert.ok(!audit.includes(TOKEN), "new entries redact old content too");
});

test("Mac bridge saves follow the switch while audit reasons and snapshots stay redacted", (t) =>
  bothWays(async (on) => {
    const { deps, vault, vaultRoot } = await vaultFixture(t);
    const bridge = createBridgeMethods({
      vault,
      search: deps.search,
      auditLog: new AuditLog(vaultRoot),
      vaultPath: vaultRoot,
      learnedBridges: null,
      sharedRecallLang: null,
    });
    const result = (await bridge.save_memory(
      memory({ summary: TEXT, body: TEXT, body_ends_with: TEXT, audit_context: { actor: "user", reason: TEXT } })
    )) as SaveMemoryResult;
    assert.equal((await readFile(result.file_path, "utf8")).includes(TOKEN), !on);
    assert.equal(result.secrets_redacted === undefined, !on);
    await bridge.delete_memory({ id: result.id });
    await bridge.restore_memory({ id: result.id });
    assert.equal((await readFile(result.file_path, "utf8")).includes(TOKEN), !on);
    const audit = await readFile(join(vaultRoot, ".bastra", "audit-log.ndjson"), "utf8");
    assert.ok(!audit.includes(TOKEN));
    assert.ok(audit.includes("[REDACTED]"));
  }));

test("product documentation honors the same switch and reports redacted fields", (t) =>
  bothWays(async (on) => {
    const { deps } = await vaultFixture(t);
    const result = await saveProductDocHandler(deps, {
      project: "ops",
      area: "deploy",
      title: "Deploy notes",
      summary: TEXT,
      body: TEXT,
    });
    assert.equal((await readFile(result.file_path, "utf8")).includes(TOKEN), !on);
    assert.equal("secrets_redacted" in result, on);
  }));

test("save_document: off keeps the sidecar text byte for byte", (t) =>
  bothWays(async (on) => {
    const { vault, vaultRoot } = await vaultFixture(t);
    const src = join(vaultRoot, "notes.txt");
    await writeFile(src, "original bytes", "utf8");
    const result = await saveDocument(vault, {
      original_path: src,
      folder_path: "",
      title: `Server notes ${on}`,
      tags: ["server"],
      category: "notiz",
      linked_file: true,
      body: TEXT,
      overwrite: false,
    });
    const raw = await readFile(result.sidecar_path, "utf8");
    assert.equal(raw.includes(TEXT), !on, raw);
    assert.equal(result.secrets_redacted === undefined, !on);
  }));

test("draft text, lines and situations: off keeps them byte for byte", () =>
  bothWays(async (on) => {
    assert.equal(cleanDraftText(TEXT, 600) === TEXT, !on);
    assert.equal(cleanDraftLine(TEXT) === TEXT, !on);
    const turns = [
      { role: "user", text: "deploy it", cwd: "/repo" },
      { role: "assistant", commands: [TEXT], cwd: "/repo" },
      { role: "user", text: "why did it fail", cwd: "/repo" },
    ] as never[];
    const situation = situationForTurn(turns, 2, (turn) => (turn as { role: string }).role === "user");
    assert.equal(JSON.stringify(situation).includes(TOKEN), !on, JSON.stringify(situation));
  }));

test("draft store: off stores the quote byte for byte", async () => {
  const dir = await mkdtemp(join(tmpdir(), "redaction-switch-drafts-"));
  const previous = process.env.BASTRA_DRAFTS_PATH;
  process.env.BASTRA_DRAFTS_PATH = join(dir, "drafts.json");
  const now = 1_800_000_000_000;
  try {
    await bothWays(async (on) => {
      const quote = `The deploy failed until we ran this first, then it worked on every host: ${TEXT} (${on})`;
      const fp = draftFingerprint(quote);
      const draft: Draft = {
        id: draftId(`s-${on}`, 1, fp),
        fp,
        kind: "after-failure",
        quote,
        situation: { before: [], after: [], reads: [], lits: [] },
        evidence: [{ session_id: `s-${on}`, turn: 1, ts: now }],
        created: now,
        last_touched: now,
        surfaced: [],
        state: "open",
      };
      await upsertDraft(draft, now);
      const stored = (await listDrafts(now)).find((d) => d.id === draft.id);
      assert.ok(stored);
      assert.equal(stored.quote === quote, !on, stored.quote);
    });
  } finally {
    if (previous === undefined) delete process.env.BASTRA_DRAFTS_PATH;
    else process.env.BASTRA_DRAFTS_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("suggestion relay: off stores the blocks byte for byte", async () => {
  const dir = await mkdtemp(join(tmpdir(), "redaction-switch-pending-"));
  const path = join(dir, "pending.json");
  const keys = ["BASTRA_PENDING_SUGGESTIONS_PATH", "BASTRA_DRAFTS_PATH"] as const;
  const previous = keys.map((k) => process.env[k]);
  process.env.BASTRA_PENDING_SUGGESTIONS_PATH = path;
  process.env.BASTRA_DRAFTS_PATH = join(dir, "drafts.json");
  try {
    await bothWays(async (on) => {
      const block = `<save-eval>${TEXT} ${on}</save-eval>`;
      await writePendingSuggestion(block);
      const rows = JSON.parse(readAppRecord("pending-suggestions", path)) as Array<{ blocks: string }>;
      assert.equal(
        rows.some((r) => r.blocks === block),
        !on,
        JSON.stringify(rows)
      );
    });
  } finally {
    keys.forEach((k, i) => (previous[i] === undefined ? delete process.env[k] : (process.env[k] = previous[i])));
    await rm(dir, { recursive: true, force: true });
  }
});

test("task text: off keeps it byte for byte", () =>
  bothWays(async (on) => {
    assert.equal(cleanText(TEXT) === TEXT, !on);
  }));

test("task reports: off stores the body byte for byte", async () => {
  const root = await mkdtemp(join(tmpdir(), "redaction-switch-reports-"));
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => 1_000 };
  const agent = await mintTaskCredential(ctx.authPath, { actor_id: "claude", domains: ["personal"], role: "agent" });
  const call = (op: string, input: unknown) =>
    callTaskCrud(ctx, `Bearer ${agent.token}`, op as never, input) as Promise<{ id: string; body: string }>;
  try {
    await bothWays(async (on) => {
      const body = `## Result\n\n${TEXT}\n`;
      const saved = await call("task_report_save", {
        title: `Deploy ${on}`,
        body,
        origin: { client: "claude-code", session: "s-1" },
      });
      const stored = (await call("task_report_read", { id: saved.id })).body;
      assert.equal(stored === body, !on, stored);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
