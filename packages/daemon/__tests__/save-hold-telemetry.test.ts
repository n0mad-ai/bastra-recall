/** #477: claim-gated saves emit one content-free save_hold event. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchIndex, Vault } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { resetSaveFailures, saveMemoryHandler, type ToolDeps } from "../src/tool-handlers.js";

const memo = (title: string, recall_when: string[]) => ({
  title,
  type: "project-fact",
  summary: `Zusammenfassung für ${title}`,
  body: `Inhalt von ${title}.`,
  topic_path: ["deploy"],
  tags: ["deploy"],
  scope: "gateproj",
  recall_when,
});

async function readHolds(logDir: string): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const files = (await readdir(logDir).catch(() => [] as string[])).filter((f) => f.startsWith("events-"));
    const rows: Array<Record<string, unknown>> = [];
    for (const file of files) {
      const raw = await readFile(join(logDir, file), "utf8");
      for (const line of raw.split("\n")) {
        if (!line) continue;
        const row = JSON.parse(line) as Record<string, unknown>;
        if (row.kind === "save_hold") rows.push(row);
      }
    }
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return [];
}

test("a claim-gated save emits exactly one content-free hold event", async (t) => {
  const vaultPath = await mkdtemp(join(tmpdir(), "bastra-save-hold-vault-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-save-hold-logs-"));
  const vault = new Vault(vaultPath);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  resetSaveFailures();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry({ logDir }), vaultPath };
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    await rm(vaultPath, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  });

  await saveMemoryHandler(deps, memo("Staging-Deploy Ablauf", ["das Deployment der Staging-Umgebung vorbereiten"]));
  await saveMemoryHandler(deps, memo("Staging-Deploy Zweitnotiz", ["Deployment der Staging-Umgebung"]));

  const holds = await readHolds(logDir);
  assert.equal(holds.length, 1);
  assert.deepEqual(
    {
      reason: holds[0].reason,
      id: holds[0].id,
      type: holds[0].type,
      scope: holds[0].scope,
      claimed_count: holds[0].claimed_count,
      overwrite: holds[0].overwrite,
    },
    {
      reason: "claim_gate",
      id: "staging-deploy-zweitnotiz",
      type: "project-fact",
      scope: "gateproj",
      claimed_count: 1,
      overwrite: false,
    },
  );
  for (const privateField of ["title", "body", "recall_when", "summary"]) {
    assert.ok(!(privateField in holds[0]), `${privateField} must not be logged`);
  }
});
