/**
 * #245 — the import must never overwrite a FOREIGN node, and must never
 * silently guess when it cannot tell. Follow-up to #240 (`f72ce5f`), which
 * closed the two standard cases; a counter-audit found four more paths on
 * which `saveMemory(overwrite:true)` — temp+rename, no trash — could land on
 * a stranger.
 *
 * Each test here is the repro for one point of that issue.
 *
 * #285 closes P1c: the final ownership read is passed as saveMemory's exact
 * expectedTarget preimage. Deterministic commit-race coverage lives in core's
 * save-concurrency.test.ts, at the writer boundary where the race exists.
 *
 * Runner: `tsx --test __tests__/import-overwrite-guard.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import matter from "gray-matter";
import { importVault } from "../src/import-vault.js";
import { pathHash } from "../src/import/identity.js";

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeSrc(dir: string, rel: string, content: string): Promise<void> {
  const full = join(dir, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

/** Plant a node that is NOT ours on `<folder>/<id>.md`. `source` is what the
 *  ownership check reads back, so it is the only field that matters here. */
async function plantNode(vault: string, folder: string, id: string, source: string, marker: string): Promise<void> {
  const full = join(vault, folder, `${id}.md`);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(
    full,
    `---\nid: ${id}\ntitle: Fremder Knoten ${id}\ntype: reference\nsummary: ${marker}\nscope: lbl\n${source ? `source: ${source}\n` : ""}---\n${marker}\n`,
    "utf8",
  );
}

async function readNode(vault: string, folder: string, id: string): Promise<{ data: Record<string, unknown>; body: string }> {
  const raw = await readFile(join(vault, folder, `${id}.md`), "utf8");
  const { data, content } = matter(raw);
  return { data: data as Record<string, unknown>, body: content };
}

test("#245 P1: an un-stamped prior import (no relKey) is foreign, not mine — reimport lands beside it", async () => {
  const src = await tmp("iog-src-");
  const vault = await tmp("iog-vault-");
  const folder = "memories/imported/lbl";
  try {
    // A pre-relKey import node: right adapter, right label, NO relKey. Its
    // origin is unknowable — it may belong to a source path that no longer
    // exists — so it must not be treated as this file's predecessor.
    await plantNode(vault, folder, "lbl-note", "markdown:lbl", "ALTBESTAND");
    await writeSrc(src, "note.md", "# Note\n\nNeuer Inhalt aus der Quelle.\n");

    const r = await importVault(vault, src, { label: "lbl" });

    // The old node survives untouched.
    const old = await readNode(vault, folder, "lbl-note");
    assert.equal(old.data.summary, "ALTBESTAND", "un-stamped prior import was overwritten");

    // The new node landed on the deterministic hash fallback, beside it.
    assert.equal(r.imported, 1);
    const mintedId = r.ids[0];
    assert.notEqual(mintedId, "lbl-note");
    assert.equal(mintedId, `lbl-note-${pathHash("note.md")}`);
    const fresh = await readNode(vault, folder, mintedId);
    assert.match(fresh.body, /Neuer Inhalt/);
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("#245 P1: a fully stamped prior import of the SAME source path is still mine (overwrite in place)", async () => {
  const src = await tmp("iog-src-");
  const vault = await tmp("iog-vault-");
  const folder = "memories/imported/lbl";
  try {
    await writeSrc(src, "note.md", "# Note\n\nErster Lauf.\n");
    const first = await importVault(vault, src, { label: "lbl" });
    assert.equal(first.ids[0], "lbl-note", "first run should mint the readable id");

    await writeSrc(src, "note.md", "# Note\n\nZweiter Lauf.\n");
    const second = await importVault(vault, src, { label: "lbl" });

    assert.deepEqual(second.ids, ["lbl-note"], "re-import of the same path must stay idempotent");
    const node = await readNode(vault, folder, "lbl-note");
    assert.match(node.body, /Zweiter Lauf/);
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("#245 P1: ownership is fail-closed on read errors — an unreadable node is skipped, never overwritten", async (t) => {
  const src = await tmp("iog-src-");
  const vault = await tmp("iog-vault-");
  const folder = "memories/imported/lbl";
  const target = join(vault, folder, "lbl-note.md");
  try {
    await plantNode(vault, folder, "lbl-note", "markdown:lbl:note.md", "UNLESBAR");
    await chmod(target, 0o000);

    // Running as root (or on a filesystem that ignores the mode) defeats the
    // premise — verify the read really fails before asserting on it.
    let readable = true;
    try {
      await readFile(target, "utf8");
    } catch {
      readable = false;
    }
    if (readable) {
      t.skip("cannot make the file unreadable in this environment (root or permissive fs)");
      return;
    }

    await writeSrc(src, "note.md", "# Note\n\nDarf den unlesbaren Knoten nicht ersetzen.\n");
    const r = await importVault(vault, src, { label: "lbl" });

    assert.equal(r.imported, 0, "an unverifiable target must not be imported over");
    assert.equal(r.ids.length, 0);
    const skip = r.skipped.find((s) => s.path.endsWith("note.md"));
    assert.ok(skip, "the file must be recorded in skipped[]");
    assert.match(skip!.reason, /ownership/i, `skip reason should name the cause, got: ${skip!.reason}`);

    await chmod(target, 0o600);
    const survived = await readNode(vault, folder, "lbl-note");
    assert.equal(survived.data.summary, "UNLESBAR", "the unreadable node was replaced");
  } finally {
    await chmod(target, 0o600).catch(() => {});
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("#245 P2: when every hash candidate is foreign the allocator skips — it never returns an unchecked id", async () => {
  const src = await tmp("iog-src-");
  const vault = await tmp("iog-vault-");
  const folder = "memories/imported/lbl";
  const relKey = "note.md";
  try {
    // Occupy the readable id AND all eight deterministic hash candidates with
    // foreign nodes. The allocator's `guard < 8` loop used to mint a ninth
    // candidate and return it WITHOUT checking it.
    await plantNode(vault, folder, "lbl-note", "hand-authored", "BASIS");
    const candidates = [
      `lbl-note-${pathHash(relKey)}`,
      ...Array.from({ length: 7 }, (_, i) => `lbl-note-${pathHash(`${relKey}#${i + 1}`)}`),
    ];
    for (const [i, id] of candidates.entries()) {
      await plantNode(vault, folder, id, "hand-authored", `KANDIDAT-${i}`);
    }

    await writeSrc(src, relKey, "# Note\n\nDarf keinen der Fremdknoten treffen.\n");
    const r = await importVault(vault, src, { label: "lbl" });

    assert.equal(r.imported, 0, "no id was free — the file must be skipped, not forced");
    const skip = r.skipped.find((s) => s.path.endsWith(relKey));
    assert.ok(skip, "the file must be recorded in skipped[]");

    // Every planted node is byte-for-byte intact.
    const base = await readNode(vault, folder, "lbl-note");
    assert.equal(base.data.summary, "BASIS");
    for (const [i, id] of candidates.entries()) {
      const node = await readNode(vault, folder, id);
      assert.equal(node.data.summary, `KANDIDAT-${i}`, `candidate ${id} was overwritten`);
    }
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("#245 P2: the synthetic index skips instead of landing on a foreign node when candidates are exhausted", async () => {
  const src = await tmp("iog-src-");
  const vault = await tmp("iog-vault-");
  const folder = "memories/imported/lbl";
  const seed = "index:lbl";
  try {
    await plantNode(vault, folder, "lbl-index", "hand-authored", "FREMDER-INDEX");
    const candidates = [
      `lbl-index-${pathHash(seed)}`,
      ...Array.from({ length: 7 }, (_, i) => `lbl-index-${pathHash(`${seed}#${i + 1}`)}`),
    ];
    for (const [i, id] of candidates.entries()) {
      await plantNode(vault, folder, id, "hand-authored", `IDX-KANDIDAT-${i}`);
    }

    // A source set with a real index hub, so Pass D actually tries to write.
    await writeSrc(src, "MEMORY.md", "# Index\n\n- [[one]]\n- [[two]]\n");
    await writeSrc(src, "one.md", "# One\n\nErster Text.\n");
    await writeSrc(src, "two.md", "# Two\n\nZweiter Text.\n");

    const r = await importVault(vault, src, { label: "lbl" });

    assert.equal(r.indexNode, null, "the index node must not be minted onto a foreign id");
    const base = await readNode(vault, folder, "lbl-index");
    assert.equal(base.data.summary, "FREMDER-INDEX");
    for (const [i, id] of candidates.entries()) {
      const node = await readNode(vault, folder, id);
      assert.equal(node.data.summary, `IDX-KANDIDAT-${i}`, `index candidate ${id} was overwritten`);
    }
    // The regular notes still import — the index is best-effort, not a gate.
    assert.equal(r.imported, 2);
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

/**
 * Codex-Gegenreview: Die Besitzprüfung sah nur den erwarteten Importpfad. Ein
 * fremdes Memory mit derselben id an einem ANDEREN Ort blieb unsichtbar — der
 * Import schrieb daneben, und danach trugen zwei Dateien dieselbe id.
 */
test("import: eine id, die anderswo im Vault vergeben ist, gilt als fremd", async () => {
  const vault = await tmp("guard-elsewhere-vault-");
  const src = await tmp("guard-elsewhere-src-");
  try {
    // Ein von Hand angelegtes Memory, dessen id der Import gleich minten will
    // — aber NICHT am Importpfad, sondern in einem gewöhnlichen Projektregal.
    const handmade = join(vault, "memories", "projects", "proj", "lbl-note.md");
    await mkdir(dirname(handmade), { recursive: true });
    await writeFile(
      handmade,
      "---\nid: lbl-note\ntitle: Handgeschrieben\ntype: reference\nsummary: s\ntopic_path:\n  - t\ntags:\n  - t\nscope: proj\nrecall_when:\n  - t\ncreated: 2026-08-26\nupdated: 2026-08-26\n---\n\nORIGINAL\n",
      "utf8",
    );
    await writeSrc(src, "note.md", "# Note\n\nAus der Quelle.\n");

    const result = await importVault(vault, src, { label: "lbl" });

    // Das Original bleibt unberührt …
    assert.match(await readFile(handmade, "utf8"), /ORIGINAL/);
    // … und der Import hat die fremde id nicht beansprucht: er weicht auf
    // einen Hash-Kandidaten aus (oder überspringt), aber legt keine zweite
    // Datei mit derselben id an.
    assert.ok(!result.ids.includes("lbl-note"), "die fremde id wurde nicht beansprucht");
  } finally {
    await rm(vault, { recursive: true, force: true });
    await rm(src, { recursive: true, force: true });
  }
});
