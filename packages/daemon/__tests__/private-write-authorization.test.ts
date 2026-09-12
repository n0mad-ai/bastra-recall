/**
 * #464 — private write authorization.
 *
 * A `sensitivity: private` record is hidden from external MCP/REST callers on
 * the READ path. Before this suite existed, every WRITE path was open: the
 * same caller that got "memory not found" could overwrite the body, archive
 * the file, recategorize or move a private sidecar — and the `private` label
 * survived, so the destructive change stayed invisible to the caller that
 * made it.
 *
 * The second half of the defect was the trust boundary itself: `allow_private`
 * was a field of the PUBLIC tool schema, so the request body granted itself
 * the privilege. `dispatchApi()` fed the REST body straight into it and the
 * stdio MCP server did the same with the tool arguments.
 *
 * The rule this suite pins: the capability is transport-bound. No public
 * MCP/REST argument can produce it, the boundary decides, and a refused
 * private mutation leaves the bytes, the file paths and the index untouched.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/private-write-authorization.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { Vault, SearchIndex } from "@bastra-recall/core";
import {
  loadMemoryHandler,
  saveMemoryHandler,
  archiveMemoryHandler,
  recallHandler,
  type ToolDeps,
} from "../src/tool-handlers.js";
import {
  saveDocument,
  recategorizeDocument,
  moveDocument,
} from "../src/documents-write-handler.js";
import { dispatchApi } from "../src/http-api-routes.js";
import { TRUSTED_LOCAL_APP } from "../src/private-access.js";
import { Telemetry } from "../src/telemetry.js";

const PRIVATE_BODY = "ORIGINAL PRIVATE BODY — visible to the Mac app only.";

function memoryFile(id: string, sensitivity: string | null, body: string, title = `Note ${id}`): string {
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: reference",
    "summary: A memory used by the #464 authorization tests.",
    ...(sensitivity ? [`sensitivity: ${sensitivity}`] : []),
    "topic_path:",
    "  - tests",
    "  - authorization",
    "tags:",
    "  - tests",
    "scope: testlabel",
    "recall_when:",
    "  - authorization probe",
    "created: 2026-07-01",
    "updated: 2026-07-01",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

async function harness(t: { after: (fn: () => unknown) => void }): Promise<{
  dir: string;
  deps: ToolDeps;
  vault: Vault;
}> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-464-"));
  await writeFile(join(dir, "secret-id.md"), memoryFile("secret-id", "private", PRIVATE_BODY), "utf8");
  await writeFile(join(dir, "open-id.md"), memoryFile("open-id", null, "A public body."), "utf8");
  // The implicit collision case: a save that carries no `id` folds its title
  // onto exactly this memory.
  await writeFile(
    join(dir, "note-secret-id.md"),
    memoryFile("note-secret-id", "private", PRIVATE_BODY, "Note secret-id"),
    "utf8",
  );
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: dir };
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { dir, deps, vault };
}

/** The REST boundary as http.ts calls it — no trusted-caller marker anywhere. */
function restCtx(deps: ToolDeps) {
  return { toolDeps: deps, documentWriteEnabled: true, ccSessionId: null };
}

/** Everything on disk, path → bytes. The proof that a refusal changed nothing. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const next = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(next);
      else out.set(next, await readFile(join(dir, next), "utf8"));
    }
  };
  await walk("");
  return out;
}

function assertUnchanged(before: Map<string, string>, after: Map<string, string>, what: string): void {
  assert.deepEqual(
    [...after.keys()].sort(),
    [...before.keys()].sort(),
    `${what}: no file may appear, vanish or move`,
  );
  for (const [path, bytes] of before) {
    assert.equal(after.get(path), bytes, `${what}: ${path} must be byte-identical`);
  }
}

// ─── The trust boundary itself ──────────────────────────────────

test("#464: a REST caller cannot grant itself private read access through the request body", async (t) => {
  const { deps } = await harness(t);

  await assert.rejects(
    dispatchApi("load_memory", { id: "secret-id" }, restCtx(deps)),
    /memory not found: secret-id/,
    "baseline: the read path hides it",
  );
  // The review's reproduction: the very same dispatch with the flag set.
  await assert.rejects(
    dispatchApi("load_memory", { id: "secret-id", allow_private: true }, restCtx(deps)),
    /memory not found: secret-id/,
    "allow_private in the body is not a capability",
  );

  // The public memory still loads — the gate is about sensitivity, not about
  // breaking load_memory.
  const open = (await dispatchApi("load_memory", { id: "open-id" }, restCtx(deps))) as {
    body: string;
  };
  assert.match(open.body, /A public body\./);
});

test("#464: a stdio MCP caller cannot grant itself private read access either", async (t) => {
  const { deps } = await harness(t);
  // index.ts passes the client's tool arguments into the handler verbatim.
  await assert.rejects(
    loadMemoryHandler(deps, { id: "secret-id", allow_private: true }),
    /memory not found: secret-id/,
  );
  const hits = (await recallHandler(deps, {
    query: "authorization probe",
    k: 10,
    min_score: 0,
    allow_private: true,
  })) as { hits: { id: string }[] };
  assert.ok(
    !hits.hits.some((h) => h.id === "secret-id"),
    "recall stays filtered however the arguments are decorated",
  );
});

test("#464: the trusted local-app transport still reaches the private memory", async (t) => {
  const { deps } = await harness(t);
  const loaded = await loadMemoryHandler(deps, { id: "secret-id" }, TRUSTED_LOCAL_APP);
  assert.match(loaded.body, /ORIGINAL PRIVATE BODY/);
});

// ─── save_memory(overwrite) ─────────────────────────────────────

const OVERWRITE_PAYLOAD = {
  id: "secret-id",
  title: "Note secret-id",
  type: "reference",
  summary: "Replaced by an external caller.",
  body: "REPLACED BODY",
  topic_path: ["tests", "authorization"],
  tags: ["tests"],
  scope: "testlabel",
  recall_when: ["authorization probe"],
  overwrite: true,
};

test("#464: save_memory(overwrite) on a hidden private memory is refused and changes nothing", async (t) => {
  const { dir, deps } = await harness(t);
  const before = await snapshot(dir);

  await assert.rejects(
    dispatchApi("save_memory", { ...OVERWRITE_PAYLOAD }, restCtx(deps)),
    /memory not found: secret-id/,
    "the write answers exactly like the read — no id-existence oracle",
  );
  await assert.rejects(
    saveMemoryHandler(deps, { ...OVERWRITE_PAYLOAD, allow_private: true }),
    /memory not found: secret-id/,
    "and a self-granted flag does not change that",
  );

  assertUnchanged(before, await snapshot(dir), "refused save_memory(overwrite)");
  const stillPrivate = await readFile(join(dir, "secret-id.md"), "utf8");
  assert.match(stillPrivate, /ORIGINAL PRIVATE BODY/);
  assert.ok(!stillPrivate.includes("REPLACED BODY"));
});

test("#464: the trusted local-app transport may still overwrite a private memory", async (t) => {
  const { dir, deps } = await harness(t);
  const result = (await saveMemoryHandler(deps, { ...OVERWRITE_PAYLOAD }, TRUSTED_LOCAL_APP)) as {
    created: boolean;
  };
  assert.equal(result.created, false);
  const after = await readFile(join(dir, "secret-id.md"), "utf8");
  assert.match(after, /REPLACED BODY/);
});

test("#464: an implicit slug collision with a private memory is refused too", async (t) => {
  const { dir, deps } = await harness(t);
  const before = await snapshot(dir);
  // No explicit id: the title folds onto the existing private id.
  const { id: _id, ...withoutId } = OVERWRITE_PAYLOAD;
  void _id;
  await assert.rejects(
    dispatchApi("save_memory", { ...withoutId }, restCtx(deps)),
    /memory not found: note-secret-id/,
  );
  assertUnchanged(before, await snapshot(dir), "refused implicit-collision save");
});

// ─── archive_memory ─────────────────────────────────────────────

test("#464: archive_memory cannot be authorized from the request body", async (t) => {
  const { dir, deps } = await harness(t);
  const before = await snapshot(dir);

  await assert.rejects(
    dispatchApi("archive_memory", { id: "secret-id", allow_private: true }, restCtx(deps)),
    /unknown memory: secret-id/,
  );
  assertUnchanged(before, await snapshot(dir), "refused archive_memory");
  assert.ok(deps.vault.get("secret-id"), "still indexed");

  // The trusted transport keeps the capability it always had.
  const archived = await archiveMemoryHandler(deps, { id: "secret-id" }, TRUSTED_LOCAL_APP);
  assert.equal(archived.id, "secret-id");
  await assert.rejects(stat(join(dir, "secret-id.md")));
});

// ─── the two paths the review did not list, same defect ─────────

test("#464: save_product_doc cannot replace a private memory under the derived id", async (t) => {
  const { dir, deps } = await harness(t);
  // A product doc the user marked private. `save_product_doc` derives its id
  // from project+area and always writes with `overwrite: true`.
  await writeFile(
    join(dir, "doku-testlabel-hints.md"),
    memoryFile("doku-testlabel-hints", "private", PRIVATE_BODY, "Testlabel — Hints"),
    "utf8",
  );
  await deps.vault.reindexFile(join(dir, "doku-testlabel-hints.md"));
  const before = await snapshot(dir);

  await assert.rejects(
    dispatchApi(
      "save_product_doc",
      { project: "testlabel", area: "hints", title: "T", summary: "S", body: "B" },
      restCtx(deps),
    ),
    /memory not found: doku-testlabel-hints/,
  );
  assertUnchanged(before, await snapshot(dir), "refused save_product_doc");
});

test("#464: a private memory cannot be superseded by a caller that may not read it", async (t) => {
  const { dir, deps } = await harness(t);
  const before = await snapshot(dir);
  // `replaces` stamps `superseded_by` onto the predecessor — a mutation of a
  // hidden record, and its success/failure would be an existence oracle.
  await assert.rejects(
    dispatchApi(
      "save_memory",
      {
        ...OVERWRITE_PAYLOAD,
        id: "successor",
        // A trigger of its own, so the claim gate does not divert the save
        // before the supersede check is reached.
        recall_when: ["successor of the hidden record"],
        summary: "A successor nobody asked for.",
        body: "A body that would take over from the private one.",
        overwrite: false,
        replaces: "secret-id",
      },
      restCtx(deps),
    ),
    /replaces: unknown memory 'secret-id'/,
  );
  assertUnchanged(before, await snapshot(dir), "refused supersede of a private predecessor");
});

// ─── document writes ────────────────────────────────────────────

const DOC_BASE = {
  title: "Vertrag",
  category: "vertrag",
  tags: ["vertrag"],
  linked_file: false,
  folder_path: "vertraege",
  overwrite: false,
} as const;

/** A document sidecar the user marked private, plus its copied original. */
async function privateDocument(dir: string, vault: Vault): Promise<{
  id: string;
  sidecarPath: string;
  originalPath: string;
}> {
  const src = join(dir, "Vertrag.pdf");
  await writeFile(src, "PDF BYTES", "utf8");
  const doc = await saveDocument(vault, {
    ...DOC_BASE,
    original_path: src,
    body: "Der vertrauliche Vertragstext.",
  } as Parameters<typeof saveDocument>[1]);
  const parsed = matter(await readFile(doc.sidecar_path, "utf8"));
  await writeFile(
    doc.sidecar_path,
    matter.stringify(parsed.content, { ...parsed.data, sensitivity: "private" }),
    "utf8",
  );
  await vault.reindexFile(doc.sidecar_path);
  return { id: doc.id, sidecarPath: doc.sidecar_path, originalPath: doc.original_path };
}

test("#464: recategorize_document refuses a private sidecar and leaves it byte-identical", async (t) => {
  const { dir, deps, vault } = await harness(t);
  const doc = await privateDocument(dir, vault);
  const before = await snapshot(dir);

  await assert.rejects(
    dispatchApi("recategorize_document", { id: doc.id, title: "Umbenannt", force: true }, restCtx(deps)),
    new RegExp(`document not found: ${doc.id}`),
  );
  await assert.rejects(
    recategorizeDocument(vault, { id: doc.id, title: "Umbenannt", force: true }),
    new RegExp(`document not found: ${doc.id}`),
    "the stdio surface gets the same answer",
  );
  assertUnchanged(before, await snapshot(dir), "refused recategorize_document");

  // Trusted transport keeps working.
  await recategorizeDocument(vault, { id: doc.id, title: "Umbenannt", force: true }, TRUSTED_LOCAL_APP);
  const after = matter(await readFile(doc.sidecarPath, "utf8")).data as Record<string, unknown>;
  assert.equal(after.title, "Umbenannt");
  assert.equal(after.sensitivity, "private", "and the label survives the legitimate patch");
});

test("#464: move_document refuses a private sidecar — sidecar and original stay put", async (t) => {
  const { dir, deps, vault } = await harness(t);
  const doc = await privateDocument(dir, vault);
  const before = await snapshot(dir);

  await assert.rejects(
    dispatchApi("move_document", { id: doc.id, folder_path: "woanders" }, restCtx(deps)),
    new RegExp(`document not found: ${doc.id}`),
  );
  assertUnchanged(before, await snapshot(dir), "refused move_document");
  await stat(doc.sidecarPath);
  await stat(doc.originalPath);

  const moved = await moveDocument(vault, { id: doc.id, folder_path: "woanders" }, TRUSTED_LOCAL_APP);
  assert.match(moved.sidecar_path, /woanders/);
});

test("#464: save_document(overwrite) refuses a private sidecar and keeps its bytes", async (t) => {
  const { dir, deps, vault } = await harness(t);
  const doc = await privateDocument(dir, vault);
  const before = await snapshot(dir);

  await assert.rejects(
    dispatchApi(
      "save_document",
      {
        ...DOC_BASE,
        title: "Fremder Titel",
        tags: ["fremd"],
        original_path: doc.originalPath,
        overwrite: true,
      },
      restCtx(deps),
    ),
    /document not found|refusing to overwrite/,
  );
  assertUnchanged(before, await snapshot(dir), "refused save_document(overwrite)");
  const sidecar = matter(await readFile(doc.sidecarPath, "utf8")).data as Record<string, unknown>;
  assert.equal(sidecar.title, "Vertrag", "the visible metadata is untouched");
});

test("#464: a document write the caller may not see is not a Pro-feature question", async (t) => {
  const { dir, deps, vault } = await harness(t);
  await privateDocument(dir, vault);
  // With document write disabled the flag still answers first — the point is
  // only that enabling it never becomes the authorization.
  await assert.rejects(
    dispatchApi("move_document", { id: "doc-vertraege-vertrag-pdf", folder_path: "x" }, {
      toolDeps: deps,
      documentWriteEnabled: false,
      ccSessionId: null,
    }),
    /Pro feature/,
  );
});

// ─── the index is not an oracle either ──────────────────────────

test("#464: refused private mutations leave the vault index entry intact", async (t) => {
  const { dir, deps, vault } = await harness(t);
  const doc = await privateDocument(dir, vault);
  const beforeMemory = vault.get("secret-id");
  const beforeDoc = vault.get(doc.id);
  assert.ok(beforeMemory && beforeDoc);

  await assert.rejects(dispatchApi("save_memory", { ...OVERWRITE_PAYLOAD }, restCtx(deps)), /memory not found/);
  await assert.rejects(dispatchApi("archive_memory", { id: "secret-id" }, restCtx(deps)), /unknown memory/);
  await assert.rejects(
    dispatchApi("move_document", { id: doc.id, folder_path: "x" }, restCtx(deps)),
    /document not found/,
  );

  assert.equal(vault.get("secret-id")?.filePath, beforeMemory.filePath);
  assert.equal(vault.get(doc.id)?.filePath, beforeDoc.filePath);
  await mkdir(join(dir, ".keep"), { recursive: true });
});
