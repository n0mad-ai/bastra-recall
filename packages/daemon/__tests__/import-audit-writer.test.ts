/**
 * #1469 — the import write paths name their transport, client and client
 * session in the audit, like the tool paths in `audit-writer.test.ts`:
 * `bastra import vault`, `bastra import clients` and the map's folder import
 * (`POST /ui/import-vault`). A record, never a gate: every import below runs
 * unasked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resetAuditLogCache } from "../src/audit-trail.js";
import { handleUiImportVault } from "../src/import-vault.js";
import { cmdImport } from "../src/cli/import-cmd.js";
import { parseArgs } from "../src/cli/commands.js";

interface AuditLine {
  memory_id: string;
  actor?: string;
  actor_detail?: string;
  session_id?: string;
  transport?: string;
  client?: string | null;
  caller_session?: string | null;
}

async function auditLines(vaultDir: string): Promise<AuditLine[]> {
  const raw = await readFile(join(vaultDir, ".bastra", "audit-log.ndjson"), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditLine);
}

async function withDirs(fn: (root: string, vaultDir: string, sourceDir: string) => Promise<void>): Promise<void> {
  resetAuditLogCache();
  const root = await mkdtemp(join(tmpdir(), "bastra-1469-import-"));
  const vaultDir = join(root, "vault");
  const sourceDir = join(root, "notes");
  await mkdir(vaultDir);
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, "first.md"), "# First note\n\nThe first imported note.\n");
  await writeFile(join(sourceDir, "second.md"), "# Second note\n\nThe second imported note.\n");
  try {
    await fn(root, vaultDir, sourceDir);
  } finally {
    resetAuditLogCache();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function assertWriter(lines: AuditLine[], transport: string, client: string): void {
  assert.ok(lines.length >= 2, JSON.stringify(lines));
  for (const line of lines) {
    assert.equal(line.actor, "import");
    assert.equal(line.transport, transport, JSON.stringify(line));
    assert.equal(line.client, client);
    // No client session exists on these paths; the run id stays in session_id.
    assert.equal(line.caller_session, null);
    assert.equal(typeof line.session_id, "string");
  }
}

test("#1469 bastra import vault: the CLI is named as writer in every audit entry", async () => {
  await withDirs(async (_root, vaultDir, sourceDir) => {
    const code = await cmdImport(parseArgs(["import", "vault", sourceDir, "notes", "--vault", vaultDir]));
    assert.equal(code, 0);
    const lines = await auditLines(vaultDir);
    assertWriter(lines, "cli", "bastra-cli");
    assert.ok(lines.every((l) => l.actor_detail === "import:vault"));
  });
});

test("#1469 bastra import clients: the CLI is named as writer", async () => {
  await withDirs(async (root, vaultDir) => {
    const codexHome = join(root, "codex");
    await mkdir(join(codexHome, "memories"), { recursive: true });
    await writeFile(join(codexHome, "memories", "codex-note.md"), "# Codex note\n\nA note Codex kept.\n");
    await writeFile(join(codexHome, "memories", "codex-other.md"), "# Other note\n\nAnother Codex note.\n");
    const saved = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
    process.env.CLAUDE_CONFIG_DIR = join(root, "claude-empty");
    process.env.CODEX_HOME = codexHome;
    try {
      const code = await cmdImport(parseArgs(["import", "clients", "--vault", vaultDir]));
      assert.equal(code, 0);
    } finally {
      if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved.claude;
      if (saved.codex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved.codex;
    }
    assertWriter(await auditLines(vaultDir), "cli", "bastra-cli");
  });
});

test("#1469 POST /ui/import-vault: the web UI is named as writer", async () => {
  await withDirs(async (root, vaultDir, sourceDir) => {
    const settingsPath = join(root, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ ui: { enabled: true } }));
    const req = Readable.from([Buffer.from(JSON.stringify({ dir: sourceDir, label: "notes" }))]);
    let status = 0;
    let body = "";
    const res = {
      writeHead(code: number) {
        status = code;
        return this;
      },
      end(chunk?: string) {
        body = chunk ?? "";
      },
    };
    await handleUiImportVault(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      vaultDir,
      undefined,
      settingsPath
    );
    assert.equal(status, 200, body);
    assertWriter(await auditLines(vaultDir), "webui", "bastra-web-ui");
  });
});
