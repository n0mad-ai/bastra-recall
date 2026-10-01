/**
 * The MCP and product-doc saves pass the vault's knowledge of its root to
 * saveMemory: a save into a root that vanished under the running daemon is
 * refused through the handlers too, not only when saveMemory is called
 * directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { saveMemoryHandler, type ToolDeps } from "../src/tool-handlers.js";
import { saveProductDocHandler } from "../src/product-doc-handler.js";
import { resetAuditLogCache } from "../src/audit-trail.js";

async function vanishedVault(t: { after: (fn: () => unknown) => void }): Promise<{ deps: ToolDeps; root: string }> {
  resetAuditLogCache();
  const parent = await mkdtemp(join(tmpdir(), "bastra-vanished-handler-"));
  const root = join(parent, "vault");
  await mkdir(root);
  const vault = new Vault(root);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    resetAuditLogCache();
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  // The mount goes away under the running daemon.
  await rm(root, { recursive: true, force: true });
  return { deps: { vault, search, telemetry: new Telemetry(), vaultPath: root }, root };
}

test("save_memory refuses to recreate a vault root that vanished", async (t) => {
  const { deps, root } = await vanishedVault(t);
  await assert.rejects(
    saveMemoryHandler(deps, {
      title: "Mount check",
      type: "lesson",
      summary: "a save into a vanished vault",
      body: "Body.",
      topic_path: ["ops"],
      tags: ["mount"],
      scope: "testproj",
      recall_when: ["when the vault mount is gone"],
    }),
    /missing/,
  );
  assert.equal(existsSync(root), false, "the vault root must not be recreated");
});

test("save_product_doc refuses to recreate a vault root that vanished", async (t) => {
  const { deps, root } = await vanishedVault(t);
  await assert.rejects(
    saveProductDocHandler(deps, { project: "demo", area: "ops", title: "Mount check", summary: "s", body: "Body." }),
    /missing/,
  );
  assert.equal(existsSync(root), false, "the vault root must not be recreated");
});
