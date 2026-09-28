/**
 * #609 pilot against a running daemon: the derived-claims resolvers (count,
 * quote, sha256) as an agent meets them — notes saved and loaded over the
 * daemon's HTTP API (`POST /api/v1/save_memory`, `/api/v1/load_memory`, the
 * route the MCP forwarder calls), with the vault watcher running.
 *
 * derived-claims.test.ts pins each verdict on the handlers. This test starts
 * the daemon's HTTP server on an ephemeral port (as http-api-health and
 * daemon-port-race do), saves seven notes — six with claims, one decision note
 * without any — then edits the sources on disk and loads again. It checks
 * that the verdicts move, that a note without claims gets no `derived` block,
 * and that neither the notes nor the sources change on a load.
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/derived-claims-daemon.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";

type Json = Record<string, unknown>;
interface Claim {
  id: string;
  status: string;
  value?: unknown;
  expect?: unknown;
}

async function post(port: number, tool: string, body: Json): Promise<Json> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/${tool}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  assert.equal(res.status, 200, `${tool}: ${text}`);
  return JSON.parse(text) as Json;
}

const note = (title: string, extra: Json = {}): Json => ({
  title,
  type: "project-fact",
  summary: `${title} — pilot note for derived claims against the daemon.`,
  body: `${title}.`,
  topic_path: ["pilot", "claims"],
  tags: ["pilot"],
  scope: "pilot609",
  recall_when: [`when ${title.toLowerCase()} matters`],
  ...extra,
});

const sha = (s: string): string => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

const FILES: Record<string, string> = {
  "catalog/failure-modes.md": "# Failure modes\n\n1. timeout\n2. retry storm\n3. stale cache\n",
  "ops/deploy.md": "region: eu-central\ntimeout: 30s\nretries: 3\n",
  "release/NOTES.md": "Release 1.4.2\n\nSigned tags only.\n",
  "ops/owners.md": "owner: platform\nowner: platform\n",
};

test("#609 pilot: count, quote and sha256 claims resolve through the daemon's load_memory and move when the source changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-609-daemon-"));
  for (const [rel, text] of Object.entries(FILES)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text, "utf8");
  }
  const vault = new Vault(dir);
  await vault.init();
  vault.startWatching();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test-609",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    onActivity: () => undefined,
    embedding: { on: false, providerId: null, source: "none" },
  });
  const port = handle.port!;
  try {
    const decls: Array<[string, Json]> = [
      ["Failure mode count", { derived_claims: [{ id: "modes", resolver: "count.markdown-numbered-list.v1", source: "catalog/failure-modes.md", expect: 3 }] }],
      ["Deploy timeout", { derived_claims: [{ id: "timeout", resolver: "quote.v1", source: "ops/deploy.md", exact: "timeout: 30s" }] }],
      ["Release notes digest", { derived_claims: [{ id: "notes", resolver: "sha256.v1", source: "release/NOTES.md", expect: sha(FILES["release/NOTES.md"]) }] }],
      ["Failure mode count observed", { derived_claims: [{ id: "modes-observed", resolver: "count.markdown-numbered-list.v1", source: "catalog/failure-modes.md" }] }],
      ["Service owner", { derived_claims: [{ id: "owner", resolver: "quote.v1", source: "ops/owners.md", exact: "owner: platform" }] }],
      ["Runbook reference", { derived_claims: [{ id: "runbook", resolver: "quote.v1", source: "ops/runbook.md", exact: "page the on-call" }] }],
      ["Staging uses its own database", { type: "decision", body: "Decided: staging never shares the production database." }],
    ];
    const ids: string[] = [];
    for (const [title, extra] of decls) {
      const saved = await post(port, "save_memory", note(title, extra));
      assert.equal(typeof saved.id, "string", JSON.stringify(saved));
      ids.push(saved.id as string);
    }

    const claimsOf = async (id: string): Promise<Claim[] | undefined> =>
      ((await post(port, "load_memory", { id })).derived as { claims?: Claim[] } | undefined)?.claims;
    const verdicts = async (): Promise<string[]> => {
      const out: string[] = [];
      for (const id of ids.slice(0, 6)) out.push((await claimsOf(id))?.[0]?.status ?? "none");
      return out;
    };

    assert.deepEqual(await verdicts(), ["matches", "matches", "matches", "observed", "ambiguous", "unverifiable"]);
    assert.equal(await claimsOf(ids[6]), undefined, "a decision note without claims carries no derived block");
    assert.equal((await claimsOf(ids[3]))?.[0]?.value, 3);

    const notesBefore = await Promise.all(ids.map((id) => readFile(vault.get(id)!.filePath, "utf8")));

    // The sources move on; the notes do not.
    await writeFile(join(dir, "catalog/failure-modes.md"), FILES["catalog/failure-modes.md"] + "4. clock skew\n", "utf8");
    await writeFile(join(dir, "ops/deploy.md"), "region: eu-central\ntimeout: 90s\nretries: 3\n", "utf8");
    await writeFile(join(dir, "release/NOTES.md"), "Release 1.4.3\n\nSigned tags only.\n", "utf8");
    await writeFile(join(dir, "ops/owners.md"), "owner: platform\n", "utf8");
    await writeFile(join(dir, "ops/runbook.md"), "Step 1: page the on-call.\n", "utf8");
    const sourcesAfter = await Promise.all(
      ["catalog/failure-modes.md", "ops/deploy.md", "release/NOTES.md", "ops/owners.md", "ops/runbook.md"].map((r) => readFile(join(dir, r), "utf8")),
    );

    assert.deepEqual(await verdicts(), ["differs", "gone", "differs", "observed", "matches", "matches"]);
    const count = (await claimsOf(ids[0]))?.[0];
    assert.equal(count?.value, 4);
    assert.equal(count?.expect, 3, "the reader sees both halves");
    assert.equal((await claimsOf(ids[3]))?.[0]?.value, 4);

    // A load is read-only on both sides.
    assert.deepEqual(await Promise.all(ids.map((id) => readFile(vault.get(id)!.filePath, "utf8"))), notesBefore);
    assert.deepEqual(
      await Promise.all(
        ["catalog/failure-modes.md", "ops/deploy.md", "release/NOTES.md", "ops/owners.md", "ops/runbook.md"].map((r) => readFile(join(dir, r), "utf8")),
      ),
      sourcesAfter,
    );
  } finally {
    await handle.close();
    search.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
