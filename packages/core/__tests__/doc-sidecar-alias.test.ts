/**
 * Issue #188: Doc-Sidecars tragen ihre eigene doc-id als Obsidian-Alias,
 * damit die `[[<doc-id>]]`-Cross-Links des RelatedEnrichers in Obsidian aufs
 * Sidecar-File auflösen (Obsidian löst Wikilinks gegen die `aliases`-
 * Frontmatter-Liste auf — Standard-Feature) statt beim Klick eine leere
 * Stray-Note anzulegen.
 *
 * Run: npx tsx --test packages/core/__tests__/doc-sidecar-alias.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import matter from "gray-matter";
import { Vault } from "../src/vault.js";
import type { EmbeddingIndex } from "../src/embeddings.js";
import { RelatedEnricher } from "../src/related-enrich.js";
import { parseMemoryWith } from "../src/schema.js";
import { saveMemory } from "../src/save.js";

const DOC_ID = "doc-inbox-photo-2026-01-27-jpg";
const NEIGHBOR_ID = "doc-inbox-other-jpg";

/** Doc-Sidecar wie vom Inbox-Watcher: Filename ≠ id, kein aliases-Feld. */
function docSidecarMd(id: string, extraFm = ""): string {
  return `---
id: ${id}
title: Photo
type: doc
summary: s
topic_path: [documents, Inbox]
tags: [foto]
scope: documents
recall_when: ["find photo"]
created: 2026-05-01
updated: 2026-05-01
${extraFm}---

> Sidecar für \`photo.jpg\`.
`;
}

function lessonMd(id: string): string {
  return `---
id: ${id}
title: ${id}
type: lesson
summary: s
topic_path: [t]
tags: [t]
scope: t
recall_when: ["w"]
created: 2026-05-01
updated: 2026-05-01
---

body ${id}
`;
}

function stubEmbeddings(hits: { id: string; score: number }[]) {
  const stub = {
    current: hits,
    findSimilarById(_id: string, _k: number) {
      return this.current;
    },
    onEmbed(_l: (id: string) => void) {
      return () => {};
    },
  };
  return { stub, index: stub as unknown as EmbeddingIndex };
}

/** Vault mit zwei Doc-Sidecars unter documents/Inbox (Filename ≠ id). */
async function docVault(extraFm = ""): Promise<{ dir: string; vault: Vault; sidecar: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-doc-alias-"));
  const inbox = path.join(dir, "documents", "Inbox");
  await mkdir(inbox, { recursive: true });
  const sidecar = path.join(inbox, "PHOTO-2026-01-27.jpg.md");
  await writeFile(sidecar, docSidecarMd(DOC_ID, extraFm));
  await writeFile(path.join(inbox, "other.jpg.md"), docSidecarMd(NEIGHBOR_ID));
  const vault = new Vault(dir);
  await vault.init();
  return { dir, vault, sidecar };
}

test("Enricher ergänzt die eigene id als Alias auf einem Doc-Sidecar ohne aliases", async () => {
  const { dir, vault, sidecar } = await docVault();
  try {
    const { index } = stubEmbeddings([{ id: NEIGHBOR_ID, score: 0.95 }]);
    const enricher = new RelatedEnricher(vault, index);

    const written = await enricher.enrich(DOC_ID);
    assert.ok(written);

    const raw = await readFile(sidecar, "utf8");
    const fm = matter(raw).data as { aliases?: string[] };
    assert.deepEqual(fm.aliases, [DOC_ID]);
    assert.match(raw, new RegExp(`\\[\\[${NEIGHBOR_ID}\\]\\]`));

    // Schema-Round-Trip: der Alias überlebt reindex → vault.get().
    const indexed = vault.get(DOC_ID);
    assert.ok(indexed);
    assert.deepEqual(indexed.fm.aliases, [DOC_ID]);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("Alias-only Write: Links unverändert, aber Alias fehlt → Enricher schreibt trotzdem", async () => {
  const { dir, vault, sidecar } = await docVault();
  try {
    const { index } = stubEmbeddings([{ id: NEIGHBOR_ID, score: 0.95 }]);
    const enricher = new RelatedEnricher(vault, index);
    await enricher.enrich(DOC_ID);

    // Alias von Hand entfernen (simuliert Bestands-Sidecar von vor #188).
    const raw = await readFile(sidecar, "utf8");
    const parsed = matter(raw);
    const fm = { ...(parsed.data as Record<string, unknown>) };
    delete fm.aliases;
    await writeFile(sidecar, matter.stringify(parsed.content, fm));
    await vault.reindexFile(sidecar);

    // Similarity-Set identisch → sameVia && sameBody, nur der Alias fehlt.
    const written = await enricher.enrich(DOC_ID);
    assert.ok(written, "erwartet Write wegen fehlendem Alias");
    const after = matter(await readFile(sidecar, "utf8")).data as { aliases?: string[] };
    assert.deepEqual(after.aliases, [DOC_ID]);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("Alias vorhanden + Links unverändert → no-op (kein Write-Loop)", async () => {
  const { dir, vault, sidecar } = await docVault();
  try {
    const { index } = stubEmbeddings([{ id: NEIGHBOR_ID, score: 0.95 }]);
    const enricher = new RelatedEnricher(vault, index);
    await enricher.enrich(DOC_ID);
    const before = await readFile(sidecar, "utf8");

    const result = await enricher.enrich(DOC_ID);
    assert.equal(result, null);
    assert.equal(await readFile(sidecar, "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("bestehende User-Aliases überleben, die id wird nur angehängt", async () => {
  const { dir, vault, sidecar } = await docVault('aliases: ["Foto Mai"]\n');
  try {
    const { index } = stubEmbeddings([{ id: NEIGHBOR_ID, score: 0.95 }]);
    const enricher = new RelatedEnricher(vault, index);
    await enricher.enrich(DOC_ID);

    const fm = matter(await readFile(sidecar, "utf8")).data as { aliases?: string[] };
    assert.deepEqual(fm.aliases, ["Foto Mai", DOC_ID]);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("Nicht-Doc-Memories bekommen keinen Alias (Filename == id, Obsidian löst direkt)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-doc-alias-"));
  try {
    await writeFile(path.join(dir, "a.md"), lessonMd("a"));
    await writeFile(path.join(dir, "b.md"), lessonMd("b"));
    const vault = new Vault(dir);
    await vault.init();
    const { index } = stubEmbeddings([{ id: "b", score: 0.95 }]);
    const enricher = new RelatedEnricher(vault, index);
    await enricher.enrich("a");

    const raw = await readFile(path.join(dir, "a.md"), "utf8");
    assert.doesNotMatch(raw, /aliases:/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("Schema-Round-Trip: aliases übersteht parse → stringify → parse", () => {
  const raw = docSidecarMd(DOC_ID, `aliases: ["${DOC_ID}", "Foto Mai"]\n`);
  const m = parseMemoryWith(matter, raw, "/x.md", 0);
  assert.deepEqual(m.fm.aliases, [DOC_ID, "Foto Mai"]);

  const rewritten = matter.stringify(m.body, m.fm as unknown as Record<string, unknown>);
  const again = parseMemoryWith(matter, rewritten, "/x.md", 0);
  assert.deepEqual(again.fm.aliases, [DOC_ID, "Foto Mai"]);
});

test("Schema toleriert Obsidians Bare-String-Form und coerct zu Liste", () => {
  const raw = docSidecarMd(DOC_ID, `aliases: ${DOC_ID}\n`);
  const m = parseMemoryWith(matter, raw, "/x.md", 0);
  assert.deepEqual(m.fm.aliases, [DOC_ID]);
});

// ─── Koerzierungs-Matrix (#188): ein Memory darf NIE über seine aliases
// aus dem Vault fallen — hand-editierte Frontmatter liefert Zahlen, YAML-
// Dates, Bare-Scalars, dangling `aliases:` (null) oder leere Listen. ───
const COERCION_MATRIX: { name: string; fm: string; want: string[] | undefined }[] = [
  { name: "Zahl in Liste (aliases: [2024])", fm: "aliases: [2024]\n", want: ["2024"] },
  { name: "YAML-Date in Liste (aliases: [2026-05-01] → JS Date)", fm: "aliases: [2026-05-01]\n", want: ["2026-05-01"] },
  { name: "Bare-Zahl (aliases: 2024)", fm: "aliases: 2024\n", want: ["2024"] },
  { name: "Bare-YAML-Date (aliases: 2026-05-01)", fm: "aliases: 2026-05-01\n", want: ["2026-05-01"] },
  { name: "dangling aliases: (null)", fm: "aliases:\n", want: undefined },
  { name: "leere Liste (aliases: [])", fm: "aliases: []\n", want: undefined },
  {
    name: "gemischte Liste (Zahl + String + null-Member)",
    fm: 'aliases: [2024, "Foto Mai", null]\n',
    want: ["2024", "Foto Mai"],
  },
];

for (const { name, fm, want } of COERCION_MATRIX) {
  test(`Schema-Koerzierung statt Reject: ${name}`, () => {
    const raw = docSidecarMd(DOC_ID, fm);
    // Darf nicht throwen — sonst fällt das ganze Memory aus dem Vault.
    const m = parseMemoryWith(matter, raw, "/x.md", 0);
    assert.deepEqual(m.fm.aliases, want);
  });
}

// ─── saveMemory-Serializer (#188): aliases werden geschrieben und ein
// Overwrite ohne explizite aliases erhält die bestehenden File-Aliases. ───
function saveInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "alias-save-test",
    title: "Alias Save Test",
    type: "lesson",
    summary: "s",
    body: "body",
    topic_path: ["t"],
    tags: ["t"],
    scope: "t",
    recall_when: ["w"],
    ...overrides,
  } as Parameters<typeof saveMemory>[1];
}

test("saveMemory schreibt aliases und Overwrite ohne aliases erhält sie", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-doc-alias-"));
  try {
    // 1) Erst-Save mit aliases → Serializer schreibt sie ins File.
    const first = await saveMemory(dir, saveInput({ aliases: ["Foto Mai", DOC_ID] }));
    const fm1 = matter(await readFile(first.file_path, "utf8")).data as { aliases?: string[] };
    assert.deepEqual(fm1.aliases, ["Foto Mai", DOC_ID]);

    // 2) Overwrite OHNE aliases → bestehende File-Aliases bleiben erhalten.
    const second = await saveMemory(dir, saveInput({ overwrite: true, summary: "s2" }));
    assert.equal(second.file_path, first.file_path);
    const fm2 = matter(await readFile(second.file_path, "utf8")).data as { aliases?: string[]; summary?: string };
    assert.deepEqual(fm2.aliases, ["Foto Mai", DOC_ID]);
    assert.equal(fm2.summary, "s2");

    // 3) Overwrite MIT expliziten aliases → sie ersetzen die alten.
    await saveMemory(dir, saveInput({ overwrite: true, aliases: ["Neu"] }));
    const fm3 = matter(await readFile(first.file_path, "utf8")).data as { aliases?: string[] };
    assert.deepEqual(fm3.aliases, ["Neu"]);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("saveMemory ohne aliases auf neuem File schreibt kein aliases-Feld", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-doc-alias-"));
  try {
    const result = await saveMemory(dir, saveInput());
    const raw = await readFile(result.file_path, "utf8");
    assert.doesNotMatch(raw, /aliases:/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
