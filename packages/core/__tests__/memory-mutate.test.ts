/**
 * `mutateMemoryFile` — der gemeinsame Weg für alle Writer, die nicht der
 * Save-Pfad sind (Conflict-Marking, superseded_by-Stempel, Archiv-Flag).
 *
 * P1 aus dem Codex-Audit: Diese Writer schrieben direkt auf die Zieldatei, ohne
 * Identitätsprüfung und ohne Vergleich vor dem Commit. Was daraus folgte, steht
 * in den drei Tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { mutateMemoryFile } from "../src/index.js";

const memory = (id: string, body = "ALT") =>
  `---\nid: ${id}\ntitle: T\ntype: reference\nsummary: s\ntopic_path:\n  - t\ntags:\n  - t\nscope: proj\nrecall_when:\n  - t\ncreated: 2026-08-26\nupdated: 2026-08-26\n---\n\n${body}\n`;

async function fileWith(content: string): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "mutate-"));
  const file = join(dir, "m.md");
  await writeFile(file, content, "utf8");
  return { dir, file };
}

test("schreibt Frontmatter und Body, atomar und ohne tmp-Leiche", async () => {
  const { dir, file } = await fileWith(memory("m"));
  try {
    const out = await mutateMemoryFile(
      file,
      "m",
      {
        frontmatter: (fm) => ({ ...fm, superseded_by: "neu" }),
        body: (b) => `${b.trimEnd()}\n\nANGEHÄNGT\n`,
      },
      { vaultRoot: dir },
    );
    assert.equal(out.kind, "written");
    const raw = await readFile(file, "utf8");
    assert.equal(matter(raw).data.superseded_by, "neu");
    assert.match(raw, /ANGEHÄNGT/);
    assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("eine fremde Datei am erwarteten Pfad wird nicht angefasst", async () => {
  // Zwei Fälle in einem: ein ANDERES Memory und eine gewöhnliche Notiz.
  for (const [label, content, expectFound] of [
    ["fremdes Memory", memory("other-id"), "other-id"],
    ["gewöhnliche Notiz", "# Notiz\n\nPLAIN\n", null],
  ] as const) {
    const { dir, file } = await fileWith(content);
    try {
      const out = await mutateMemoryFile(
        file,
        "m",
        { frontmatter: (fm) => ({ ...fm, obsolete: true }) },
        { vaultRoot: dir },
      );
      assert.equal(out.kind, "identity-mismatch", label);
      assert.equal(out.kind === "identity-mismatch" ? out.found : "", expectFound, label);
      assert.equal(await readFile(file, "utf8"), content, `${label}: unverändert`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("wer zwischendurch schreibt, gewinnt — die Mutation gibt nach", async () => {
  const { dir, file } = await fileWith(memory("m"));
  try {
    const fremd = memory("m", "NEU VON JEMAND ANDEREM");
    const out = await mutateMemoryFile(
      file,
      "m",
      {
        frontmatter: (fm) => {
          // Genau hier, zwischen Read und Commit, landet der fremde Writer.
          void writeFile(file, fremd, "utf8");
          return { ...fm, obsolete: true };
        },
      },
      { vaultRoot: dir },
    );
    // Der Vergleich vor dem Rename sieht die Änderung.
    assert.equal(out.kind, "raced");
    assert.match(await readFile(file, "utf8"), /NEU VON JEMAND ANDEREM/);
    assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("expectedId null überspringt die Identitätsprüfung — für Dateien im Trash", async () => {
  const { dir, file } = await fileWith(memory("irgendwas"));
  try {
    const out = await mutateMemoryFile(file, null, {
      frontmatter: (fm) => ({ ...fm, obsolete: true }),
    });
    assert.equal(out.kind, "written");
    assert.equal(matter(await readFile(file, "utf8")).data.obsolete, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── #341: mtime preservation for enrichment-only rewrites ──────────
//
// Every file-sync layer (iCloud, Google Drive, Dropbox) resolves a conflict by
// modification time. A rewrite that only adds derived data — and leaves the
// authored content byte-identical — must therefore NOT touch the mtime, or the
// enriched copy outranks a copy a human actually edited elsewhere.

/** Backdate a file so "mtime unchanged" and "mtime is new" are both provable
 *  without depending on the clock's resolution. */
async function backdate(file: string): Promise<number> {
  const when = new Date(Date.now() - 3_600_000);
  await utimes(file, when, when);
  return (await stat(file)).mtimeMs;
}

test("#341: ein Rewrite mit gleichem authored content behält die mtime", async () => {
  const { dir, file } = await fileWith(memory("m"));
  try {
    const before = await backdate(file);
    const out = await mutateMemoryFile(
      file,
      "m",
      {
        frontmatter: (fm) => ({ ...fm, recall_when_expanded: ["a", "b"] }),
        authoredContent: (body) => body,
      },
      { vaultRoot: dir },
    );
    assert.equal(out.kind, "written");
    assert.deepEqual(matter(await readFile(file, "utf8")).data.recall_when_expanded, ["a", "b"]);
    assert.equal((await stat(file)).mtimeMs, before, "mtime unverändert");
    assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#341: eine echte Inhaltsänderung bekommt eine neue mtime — auch mit authoredContent", async () => {
  const { dir, file } = await fileWith(memory("m"));
  try {
    const before = await backdate(file);
    const out = await mutateMemoryFile(
      file,
      "m",
      {
        body: (b) => `${b.trimEnd()}\n\nVOM MENSCHEN\n`,
        authoredContent: (body) => body,
      },
      { vaultRoot: dir },
    );
    assert.equal(out.kind, "written");
    assert.ok((await stat(file)).mtimeMs > before, "mtime neu");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#341: ohne authoredContent bleibt die mtime-Erhaltung aus — der Save-/Edit-Pfad", async () => {
  const { dir, file } = await fileWith(memory("m"));
  try {
    const before = await backdate(file);
    const out = await mutateMemoryFile(
      file,
      "m",
      { frontmatter: (fm) => ({ ...fm, superseded_by: "neu" }) },
      { vaultRoot: dir },
    );
    assert.equal(out.kind, "written");
    assert.ok((await stat(file)).mtimeMs > before, "mtime neu (kein Opt-in)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
