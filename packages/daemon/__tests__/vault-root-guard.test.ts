/**
 * #892, the daemon's writers and its restart. A vault root the daemon has seen
 * — in this run or, through the marker in its own state dir, in an earlier one —
 * and that is missing now is a drive that is not mounted: save_document, the
 * usage sidecar and the curator state create nothing there, /health and recall
 * keep saying vault_missing, and `createVaultAt` does not recreate it either.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/vault-root-guard.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Vault, SearchIndex, vaultRootsPath } from "@bastra-recall/core";
import { saveDocument } from "../src/documents-write-handler.js";
import { recordUsage } from "../src/usage-sidecar.js";
import { saveCuratorState } from "../src/curator.js";
import { createVaultAt } from "../src/cli/helpers.js";
import { saveMemoryHandler } from "../src/tool-handlers.js";
import { Telemetry } from "../src/telemetry.js";
import { startHttpServer } from "../src/http.js";

// This file's own marker, so a "restart" can be staged by writing it directly.
process.env.BASTRA_VAULT_ROOTS_PATH = join(await mkdtemp(join(tmpdir(), "bastra-guard-roots-")), "vault-roots.json");

async function scratch(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "bastra-guard-daemon-"));
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return parent;
}

/** A vault the daemon saw at init, then the mount goes away under it. */
async function vanished(t: { after: (fn: () => unknown) => void }): Promise<{ root: string; vault: Vault; parent: string }> {
  const parent = await scratch(t);
  const root = join(parent, "vault");
  await mkdir(root);
  const vault = new Vault(root);
  await vault.init();
  t.after(() => vault.stop?.());
  await rm(root, { recursive: true, force: true });
  return { root, vault, parent };
}

test("save_document refuses a vanished root", async (t) => {
  const { root, vault, parent } = await vanished(t);
  const src = join(parent, "Vertrag.pdf");
  await writeFile(src, "BYTES", "utf8");
  await assert.rejects(
    saveDocument(vault, { title: "Vertrag", category: "vertraege", tags: ["vertrag"], linked_file: false, original_path: src, folder_path: "vertraege" } as unknown as Parameters<typeof saveDocument>[1]),
    /missing/,
  );
  assert.equal(existsSync(root), false);
});

test("the usage sidecar and the curator state create nothing under a vanished root", async (t) => {
  const { root } = await vanished(t);
  await recordUsage(root, [{ id: "x", kind: "surfaced", ts: new Date().toISOString() } as never]);
  await assert.rejects(saveCuratorState(root, { stale: {} }), /missing/);
  assert.equal(existsSync(root), false);
});

test("createVaultAt makes a new vault, but does not recreate one that is not mounted", async (t) => {
  const parent = await scratch(t);
  const fresh = join(parent, "fresh");
  assert.deepEqual(await createVaultAt(fresh), { path: fresh });
  assert.ok(existsSync(join(fresh, "README.md")));

  // install and the wizard name the path explicitly, so a deep new path gets
  // its parents — unlike a first save, which the guard stops on a missing parent.
  const deep = join(parent, "not", "yet", "there", "vault");
  assert.deepEqual(await createVaultAt(deep), { path: deep });
  assert.ok(existsSync(join(deep, "README.md")));

  const { root, parent: driveParent } = await vanished(t);
  await rm(driveParent, { recursive: true, force: true });
  const out = await createVaultAt(root);
  assert.match("error" in out ? out.error : "", /missing/);
  assert.equal(existsSync(root), false);
  assert.equal(existsSync(driveParent), false, "a known vault's parent chain is not rebuilt either");
});

test("createVaultAt with a broken root history creates nothing, not even the parents", async (t) => {
  const parent = await scratch(t);
  const marker = process.env.BASTRA_VAULT_ROOTS_PATH!;
  const before = await readFile(marker, "utf8").catch(() => null);
  t.after(() => (before === null ? rm(marker, { force: true }) : writeFile(marker, before)));
  await writeFile(marker, "{broken");
  const out = await createVaultAt(join(parent, "deep", "new", "vault"));
  assert.match("error" in out ? out.error : "", /vault-roots\.json is empty or corrupt\. If the vault is mounted, delete that file/);
  assert.equal(existsSync(join(parent, "deep")), false);
});

function post(port: number, path: string, payload: unknown): Promise<Record<string, unknown>> {
  const body = JSON.stringify(payload);
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => ok(JSON.parse(raw || "{}")));
    });
    req.on("error", fail);
    req.end(body);
  });
}

test("a daemon restart with the marker present and the root missing: vault_missing, nothing created", async (t) => {
  const parent = await scratch(t);
  const root = join(parent, "GoogleDrive", "vault");
  // An earlier daemon run saw this vault; this process never did.
  const roots = JSON.parse(await readFile(vaultRootsPath(), "utf8").catch(() => "{}")) as Record<string, unknown>;
  roots[resolve(root)] = { first_seen: "2026-01-02T03:04:05.000Z" };
  await writeFile(vaultRootsPath(), JSON.stringify(roots));

  const vault = new Vault(root);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const toolDeps = { vault, search, telemetry, vaultPath: root };
  const handle = await startHttpServer({
    port: 0, vault, search, telemetry, version: "test", toolDeps,
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
  });
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    await handle.close();
  });

  const health = (await (await fetch(`http://127.0.0.1:${handle.port}/health`)).json()) as Record<string, unknown>;
  assert.match(String(health.vault_missing), /held a vault \(first seen 2026-01-02/);
  const recall = await post(handle.port!, "/hook/recall", { query: "anything", k: 5 });
  assert.match(String(recall.vault_missing), /not mounted/);

  await assert.rejects(
    saveMemoryHandler(toolDeps, {
      title: "Mount check", type: "lesson", summary: "a save before the mount is back", body: "Body.",
      topic_path: ["ops"], tags: ["mount"], scope: "testproj", recall_when: ["when the vault mount is gone"],
    }),
    /missing/,
  );
  await recordUsage(root, [{ id: "x", kind: "surfaced", ts: new Date().toISOString() } as never]);
  assert.equal(existsSync(root), false, "the vault root must not appear on the parent filesystem");
  assert.equal(existsSync(join(parent, "GoogleDrive")), false, "nor any parent of it");

  // Still missing on the next ask: nothing quietly brought the root back.
  const again = (await (await fetch(`http://127.0.0.1:${handle.port}/health`)).json()) as Record<string, unknown>;
  assert.match(String(again.vault_missing), /held a vault/);
});
