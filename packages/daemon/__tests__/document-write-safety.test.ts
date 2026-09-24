/**
 * #240/A5 — a failing document write must never destroy or half-apply.
 *
 * Three defects, all reproduced against the real handler before the fix:
 *  1. self-copy + overwrite: when the source already sits at the destination,
 *     `unlink(originalDest)` deleted the SOURCE and the following
 *     `copyFile(src, src)` failed with ENOENT — the file was gone. Reachable
 *     from a pure round-trip: for linked_file=false the tool writes the
 *     in-vault path back as `original_path`, so a metadata refresh feeds it
 *     straight back in.
 *  2. the original was copied into the vault BEFORE the sidecar collision was
 *     detected, so a reported error left the copy behind.
 *  3. move renamed the original before checking the target sidecar, leaving
 *     the original at the target and the sidecar at the source.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "@bastra-recall/core";
import { saveDocument, moveDocument } from "../src/documents-write-handler.js";

async function harness(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-docwrite-"));
  const vault = new Vault(dir);
  await vault.init();
  t.after(async () => {
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { dir, vault };
}

const BASE = {
  title: "Vertrag",
  category: "vertraege",
  tags: ["vertrag"],
  linked_file: false,
} as const;

test("a metadata refresh of an already-imported document does not destroy it", async (t) => {
  const { dir, vault } = await harness(t);

  const src = join(dir, "Vertrag.pdf");
  await writeFile(src, "IRREPLACEABLE ORIGINAL BYTES", "utf8");

  const first = await saveDocument(vault, {
    ...BASE,
    original_path: src,
    folder_path: "vertraege",
  } as unknown as Parameters<typeof saveDocument>[1]);

  // The tool hands back the in-vault path — feed it straight back, which is
  // exactly what a title/tag correction looks like.
  const refreshed = await saveDocument(vault, {
    ...BASE,
    title: "Vertrag (korrigiert)",
    original_path: first.original_path,
    folder_path: "vertraege",
    overwrite: true,
  } as unknown as Parameters<typeof saveDocument>[1]);

  assert.equal(
    await readFile(refreshed.original_path, "utf8"),
    "IRREPLACEABLE ORIGINAL BYTES",
    "the document must survive a pure round-trip",
  );
});

test("a sidecar collision leaves no copied original behind", async (t) => {
  const { dir, vault } = await harness(t);

  const folder = join(dir, "documents", "rechnungen");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "Rechnung.pdf.md"), "existing sidecar", "utf8");

  const src = join(dir, "Rechnung.pdf");
  await writeFile(src, "PDF BYTES", "utf8");

  await assert.rejects(
    () =>
      saveDocument(vault, {
        ...BASE,
        title: "Rechnung",
        category: "rechnungen",
        original_path: src,
        folder_path: "rechnungen",
      } as unknown as Parameters<typeof saveDocument>[1]),
    /sidecar already exists/,
  );

  const entries = await readdir(folder);
  assert.deepEqual(
    entries.sort(),
    ["Rechnung.pdf.md"],
    `a rejected save must not leave a copy behind, found ${JSON.stringify(entries)}`,
  );
  assert.equal(await readFile(src, "utf8"), "PDF BYTES", "the source is untouched");
});

test("a move that collides on the sidecar does not half-apply", async (t) => {
  const { dir, vault } = await harness(t);

  const src = join(dir, "Akte.pdf");
  await writeFile(src, "AKTE", "utf8");
  const doc = await saveDocument(vault, {
    ...BASE,
    title: "Akte",
    category: "alt",
    original_path: src,
    folder_path: "alt",
  } as unknown as Parameters<typeof saveDocument>[1]);

  // Block the target sidecar so the second half of the move must fail.
  const to = join(dir, "documents", "neu");
  await mkdir(to, { recursive: true });
  await writeFile(join(to, "Akte.pdf.md"), "blocking sidecar", "utf8");

  await assert.rejects(
    () => moveDocument(vault, { id: doc.id, folder_path: "neu" }),
    /already exists/,
  );

  // Both files must still be where they started — no split state.
  const from = join(dir, "documents", "alt");
  assert.deepEqual((await readdir(from)).sort(), ["Akte.pdf", "Akte.pdf.md"]);
  assert.deepEqual((await readdir(to)).sort(), ["Akte.pdf.md"]);
  assert.equal(await readFile(join(from, "Akte.pdf"), "utf8"), "AKTE");
});

test("a moved document survives the next reconcile (#240/A3)", async (t) => {
  const { dir, vault } = await harness(t);

  const src = join(dir, "Police.pdf");
  await writeFile(src, "POLICE", "utf8");
  const doc = await saveDocument(vault, {
    ...BASE,
    title: "Police",
    category: "alt",
    original_path: src,
    folder_path: "alt",
  } as unknown as Parameters<typeof saveDocument>[1]);
  assert.equal(vault.size(), 1);

  await moveDocument(vault, { id: doc.id, folder_path: "neu" });

  // The old sidecar path used to stay registered under the same id, so the
  // periodic reconcile (60 s, or any /vault/count) removed the moved
  // document from the index while its file sat at the new location.
  await vault.reconcile();

  assert.equal(vault.size(), 1, "the document must survive reconcile");
  assert.ok(vault.get(doc.id), "and still be resolvable by id");
  assert.match(vault.get(doc.id)!.filePath, /documents\/neu\//);
});

test("a clean move still moves both files", async (t) => {
  const { dir, vault } = await harness(t);

  const src = join(dir, "Akte.pdf");
  await writeFile(src, "AKTE", "utf8");
  const doc = await saveDocument(vault, {
    ...BASE,
    title: "Akte",
    category: "alt",
    original_path: src,
    folder_path: "alt",
  } as unknown as Parameters<typeof saveDocument>[1]);

  const res = await moveDocument(vault, { id: doc.id, folder_path: "neu" });

  assert.equal(await readFile(res.original_path, "utf8"), "AKTE");
  assert.deepEqual(await readdir(join(dir, "documents", "alt")), []);
});
