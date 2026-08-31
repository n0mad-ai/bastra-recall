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
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
