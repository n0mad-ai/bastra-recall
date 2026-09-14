/**
 * A vault path that names nothing must be said out loud instead of serving
 * `vault_size: 0` and empty recalls — without breaking the one legitimate
 * missing vault, the Desktop extension's default that is "created on first
 * save". Found on a Windows stand where `install --vault <new dir> --yes`
 * registered a directory it never created.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/vault-presence.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { missingVaultReason } from "../src/vault-presence.js";
import { installVaultPresenceStep } from "../src/cli/commands.js";
import { buildHealthPayload } from "../src/http-health.js";
import { recallHandler, saveMemoryHandler, type ToolDeps } from "../src/tool-handlers.js";
import { Telemetry } from "../src/telemetry.js";
import { startHttpServer } from "../src/http.js";
import { projectRecallResult } from "../src/recall-batch.js";
import { request } from "node:http";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "bastra-vault-presence-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) };
}

test("missingVaultReason: a directory is fine, a missing path and a file are named", () => {
  const s = scratch();
  try {
    assert.equal(missingVaultReason(s.dir), null);
    assert.equal(missingVaultReason(undefined), null);
    assert.match(missingVaultReason(join(s.dir, "nope"))!, /does not exist/);
    writeFileSync(join(s.dir, "file"), "");
    assert.match(missingVaultReason(join(s.dir, "file"))!, /not a directory/);
  } finally {
    s.cleanup();
  }
});

test("recall on a missing vault says so; the first save creates it and the signal goes away", async () => {
  const s = scratch();
  const vaultPath = join(s.dir, "BastraVault");
  const vault = new Vault(vaultPath);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath };
  try {
    const before = await recallHandler(deps, { query: "zebra quartz" });
    assert.deepEqual(before.hits, []);
    assert.match(before.vault_missing ?? "", /does not exist/, "an empty hit list from no directory must not read as 'nothing on this'");

    // The Desktop extension's promise: the default folder is created on first save.
    await saveMemoryHandler(deps, {
      title: "Zebra quartz checklist",
      type: "reference",
      summary: "Marker memory for the missing-vault test.",
      body: "Zebra quartz marker body.",
      topic_path: ["test"],
      tags: ["test"],
      scope: "test",
      recall_when: ["zebra quartz checklist"],
    });
    assert.ok(existsSync(vaultPath));
    const after = await recallHandler(deps, { query: "zebra quartz checklist" });
    assert.equal(after.vault_missing, undefined);
    assert.ok(after.hits.length > 0);
  } finally {
    search.stop();
    await vault.stop?.();
    s.cleanup();
  }
});

test("/health carries the missing vault next to vault_size", () => {
  const base = { vaultSize: () => 0, version: "t", embedding: { on: false, source: "test" } as never, updateState: () => null };
  assert.equal(buildHealthPayload({ ...base, vaultMissing: () => "the vault path /x does not exist" }).vault_missing, "the vault path /x does not exist");
  assert.equal(buildHealthPayload({ ...base, vaultMissing: () => null }).vault_missing, null);
});

test("install: an explicit --vault that does not exist is created", async () => {
  const s = scratch();
  try {
    const target = join(s.dir, "BastraVault");
    const created: string[] = [];
    assert.equal(
      await installVaultPresenceStep({ flagPath: target, resolvedPath: target, dryRun: false }, { create: async (p) => (created.push(p), { path: p }), out: () => {} }),
      null,
    );
    assert.deepEqual(created, [target]);
    const dry: string[] = [];
    await installVaultPresenceStep({ flagPath: target, resolvedPath: target, dryRun: true }, { create: async (p) => (dry.push(p), { path: p }), out: () => {} });
    assert.deepEqual(dry, [], "a dry run creates nothing");
  } finally {
    s.cleanup();
  }
});

test("install: a missing path from the environment or a registration is named, never created", async () => {
  const s = scratch();
  try {
    const target = join(s.dir, "mnt", "vault");
    const created: string[] = [];
    let said = "";
    await installVaultPresenceStep({ flagPath: null, resolvedPath: target, dryRun: false }, { create: async (p) => (created.push(p), { path: p }), out: (t) => (said += t) });
    assert.deepEqual(created, [], "an empty dir on an unmounted mountpoint is the failure itself");
    assert.match(said, /does not exist/);
  } finally {
    s.cleanup();
  }
});

test("`bastra install <surface> --vault <missing> --dry-run` runs the step (wired, not just defined)", () => {
  const s = scratch();
  try {
    const target = join(s.dir, "NewVault");
    const r = spawnSync(process.execPath, ["--import", "tsx", join(SRC, "cli.ts"), "install", "cursor", "--vault", target, "--dry-run"], {
      env: { ...process.env, HOME: s.dir, USERPROFILE: s.dir },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.match(r.stdout, /would create the vault at .*NewVault/, `stdout: ${r.stdout.slice(0, 400)} stderr: ${r.stderr.slice(-300)}`);
    assert.equal(existsSync(target), false);
  } finally {
    s.cleanup();
  }
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

test("the daemon's doors carry it: /health, and /hook/recall — the MCP forwarder's recall path", async (t) => {
  const s = scratch();
  const vaultPath = join(s.dir, "not-mounted");
  const vault = new Vault(vaultPath);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const handle = await startHttpServer({
    port: 0, vault, search, telemetry, version: "test",
    toolDeps: { vault, search, telemetry, vaultPath },
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
  });
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    await handle.close();
    s.cleanup();
  });
  const health = (await (await fetch(`http://127.0.0.1:${handle.port}/health`)).json()) as Record<string, unknown>;
  assert.match(String(health.vault_missing), /does not exist/);
  const recall = await post(handle.port!, "/hook/recall", { query: "anything", k: 5 });
  assert.match(String(recall.vault_missing), /does not exist/, `hook recall payload: ${JSON.stringify(recall).slice(0, 300)}`);
  // …and the forwarder's projection passes it on instead of dropping an unknown field.
  assert.match(String(projectRecallResult("anything", recall as never).vault_missing), /does not exist/);
});
