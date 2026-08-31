/**
 * Tests für den Folder-Import (#215): `importVault` mappt einen fremden
 * Memory-Ordner deterministisch in den isolierten `memories/imported/<label>/`
 * -Subtree — tolerant gegen die CC-Format-Varianz (flat `type:` vs. nested
 * `metadata.type`, wikilinks-or-not, frontmatter-los) und ohne Review-Gate.
 *
 * Runner: `tsx --test __tests__/import-vault.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import matter from "gray-matter";
import { importVault, listSubdirs } from "../src/import-vault.js";

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeSrc(dir: string, rel: string, content: string): Promise<void> {
  const full = join(dir, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

async function readMem(vault: string, folder: string, id: string): Promise<{ data: Record<string, unknown>; body: string }> {
  const raw = await readFile(join(vault, folder, `${id}.md`), "utf8");
  const { data, content } = matter(raw);
  return { data: data as Record<string, unknown>, body: content };
}

test("CC flat type: maps name/description/type into an isolated namespaced memory", async () => {
  const src = await tmp("iv-src-");
  const vault = await tmp("iv-vault-");
  try {
    await writeSrc(
      src,
      "feedback_no_double_borders.md",
      "---\nname: Keine doppelten Borders\ndescription: IMMER prüfen dass keine doppelten Borders entstehen\ntype: feedback\n---\nBody text here.",
    );
    const r = await importVault(vault, src, { label: "ccmem" });
    assert.equal(r.scanned, 1);
    assert.equal(r.imported, 1);
    assert.equal(r.byAdapter.claudeCode, 1);
    assert.equal(r.folder, "memories/imported/ccmem");
    const id = r.ids[0];
    assert.equal(id, "ccmem-feedback-no-double-borders");
    const { data } = await readMem(vault, r.folder, id);
    assert.equal(data.type, "meta-working"); // feedback → meta-working
    assert.equal(data.title, "Keine doppelten Borders");
    assert.equal(data.scope, "ccmem");
    assert.equal(data.summary, "IMMER prüfen dass keine doppelten Borders entstehen");
    assert.ok((data.recall_when as string[]).includes("IMMER prüfen dass keine doppelten Borders entstehen"));
    assert.deepEqual(data.topic_path, ["imported", "ccmem"]);
    assert.equal(data.write_origin, "user-directed");
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("CC nested metadata.type is honored too (format variance)", async () => {
  const src = await tmp("iv-src-");
  const vault = await tmp("iv-vault-");
  try {
    await writeSrc(
      src,
      "project_windows.md",
      "---\nname: Windows strategy\ndescription: Ship the windows build via CI\nmetadata:\n  type: project\n---\nDetails.",
    );
    const r = await importVault(vault, src, { label: "x" });
    const { data } = await readMem(vault, r.folder, r.ids[0]);
    assert.equal(data.type, "project-fact"); // project → project-fact
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("frontmatter-less file falls to the generic adapter (title from H1, summary from paragraph)", async () => {
  const src = await tmp("iv-src-");
  const vault = await tmp("iv-vault-");
  try {
    await writeSrc(src, "team-setup.md", "# Team setup\n\nWe use Supabase for auth and storage.\n");
    const r = await importVault(vault, src, { label: "legacy" });
    assert.equal(r.imported, 1);
    assert.equal(r.byAdapter.generic, 1);
    const { data } = await readMem(vault, r.folder, r.ids[0]);
    assert.equal(data.title, "Team setup");
    assert.equal(data.summary, "We use Supabase for auth and storage.");
    assert.equal(data.type, "reference");
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("broken/cyrillic YAML degrades to a generic import instead of dropping the file", async () => {
  const src = await tmp("iv-src-");
  const vault = await tmp("iv-vault-");
  try {
    // unbalanced bracket → js-yaml throws → safeParse falls back to no-frontmatter
    await writeSrc(src, "note.md", "---\ntags: [unclosed «кириллица»\n---\n\nActual content survives.\n");
    const r = await importVault(vault, src, { label: "cyr" });
    assert.equal(r.imported, 1);
    assert.equal(r.skipped.length, 0);
    assert.equal(r.byAdapter.generic, 1);
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("isolation: MEMORY.md is skipped and body wikilinks are namespaced (no bare-name leak)", async () => {
  const src = await tmp("iv-src-");
  const vault = await tmp("iv-vault-");
  try {
    await writeSrc(src, "MEMORY.md", "# Index\n- [x](a.md)\n");
    await writeSrc(
      src,
      "a.md",
      "---\nname: Alpha\ndescription: links to beta\ntype: project\n---\nSee [[beta]] for details.",
    );
    const r = await importVault(vault, src, { label: "iso" });
    assert.equal(r.scanned, 1); // MEMORY.md not counted
    const { data } = await readMem(vault, r.folder, r.ids[0]);
    // wikilink [[beta]] must be namespaced to [[iso-beta]] → related holds the
    // namespaced id, never the bare "beta" (which could hit a real memory).
    assert.ok((data.related as string[]).includes("iso-beta"));
    assert.ok(!(data.related as string[]).includes("beta"));
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("unknown type falls back to reference; dry-run writes nothing", async () => {
  const src = await tmp("iv-src-");
  const vault = await tmp("iv-vault-");
  try {
    await writeSrc(src, "weird.md", "---\nname: Weird\ndescription: d\ntype: banana\n---\nb");
    const dry = await importVault(vault, src, { label: "d", dryRun: true });
    assert.equal(dry.imported, 1);
    assert.equal(dry.dryRun, true);
    await assert.rejects(readMem(vault, dry.folder, dry.ids[0])); // nothing on disk
    const real = await importVault(vault, src, { label: "d" });
    const { data } = await readMem(vault, real.folder, real.ids[0]);
    assert.equal(data.type, "reference");
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("frontmatter-less index hub is skipped as navigation, prose note still imports", async () => {
  const src = await tmp("iv-src-");
  const vault = await tmp("iv-vault-");
  try {
    // hand-maintained index: sectioned link list, no frontmatter (zzalli's 4/4 case)
    const indexLines = ["# vault index", "## projects"];
    for (let i = 0; i < 20; i++) indexLines.push(`- [note ${i}](note-${i}.md) — one-line hook`);
    indexLines.push("## semantic", "- [[some-note]] deep link", "- [[other-note]] deep link");
    await writeSrc(src, "index-projects.md", indexLines.join("\n"));
    // a real prose note without frontmatter that mentions two links
    await writeSrc(
      src,
      "supabase-details.md",
      "# Supabase setup\n\nWe use Supabase for auth, see [[project-auth]].\n\nStorage buckets are documented in [docs](docs.md). The service key rotates monthly.\nBackups run nightly via cron.\n",
    );
    const r = await importVault(vault, src, { label: "hub" });
    assert.equal(r.scanned, 2);
    assert.equal(r.imported, 1);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /index\/navigation/);
    assert.ok(r.skipped[0].path.endsWith("index-projects.md"));
    assert.equal(r.ids[0], "hub-supabase-details");
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("a file WITH declared frontmatter is never treated as an index hub", async () => {
  const src = await tmp("iv-src-");
  const vault = await tmp("iv-vault-");
  try {
    const links = Array.from({ length: 15 }, (_, i) => `- [[target-${i}]]`).join("\n");
    await writeSrc(src, "linkheavy.md", `---\nname: Link heavy\ndescription: a legit memory full of links\ntype: project\n---\n${links}\n`);
    const r = await importVault(vault, src, { label: "lh" });
    assert.equal(r.imported, 1); // declared frontmatter wins
    assert.equal(r.skipped.length, 0);
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("listSubdirs: dirs only, dotdirs after visible ones, md counts, parent chain", async () => {
  const root = await tmp("iv-fs-");
  try {
    await mkdir(join(root, "b-visible"), { recursive: true });
    await mkdir(join(root, ".claude"), { recursive: true });
    await mkdir(join(root, "a-vault"), { recursive: true });
    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "a-vault", "note.md"), "# n");
    await writeFile(join(root, "loose-file.md"), "# f"); // files never listed
    const r = await listSubdirs(root);
    assert.deepEqual(r.dirs.map((d) => d.name), ["a-vault", "b-visible", ".claude"]);
    assert.equal(r.dirs[0].md, 1);
    assert.equal(r.dirs[1].md, 0);
    assert.ok(r.parent);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("re-import is idempotent (stable id, overwrite in place)", async () => {
  const src = await tmp("iv-src-");
  const vault = await tmp("iv-vault-");
  try {
    await writeSrc(src, "reference_cookies.md", "---\nname: Cookies\ndescription: akamai cookies\ntype: reference\n---\nx");
    const first = await importVault(vault, src, { label: "r" });
    const second = await importVault(vault, src, { label: "r" });
    assert.deepEqual(first.ids, second.ids);
    assert.equal(second.imported, 1);
    assert.equal(second.skipped.length, 0);
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("self-ingest guard: source == vault, source inside vault, vault inside source all refuse", async () => {
  const vault = await tmp("iv-guard-");
  try {
    await writeSrc(vault, "memories/note.md", "---\nname: N\ndescription: D\ntype: user\n---\nBody.");
    // Quelle == Vault (der zzallirog-Fall: --vault ~/memory import vault ~/memory)
    await assert.rejects(() => importVault(vault, vault), /overlaps the vault/);
    // Quelle INNERHALB des Vaults
    await assert.rejects(() => importVault(vault, join(vault, "memories")), /overlaps the vault/);
    // Vault INNERHALB der Quelle (Import würde die eigene Ausgabe mit-ingesten)
    const parent = await tmp("iv-guard-parent-");
    const innerVault = join(parent, "vault");
    await mkdir(innerVault, { recursive: true });
    await assert.rejects(() => importVault(innerVault, parent), /overlaps the vault/);
    await rm(parent, { recursive: true, force: true });
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test("marker: a successful import writes .bastra-imported into the set (skippable by external tools)", async () => {
  const src = await tmp("iv-marker-src-");
  const vault = await tmp("iv-marker-vault-");
  try {
    await writeSrc(src, "user_probe.md", "---\nname: Probe\ndescription: Marker probe\ntype: user\n---\nBody.");
    const r = await importVault(vault, src, { label: "marked" });
    assert.equal(r.imported, 1);
    const marker = JSON.parse(await readFile(join(vault, r.folder, ".bastra-imported"), "utf8"));
    assert.equal(marker.label, "marked");
    assert.equal(marker.imported, 1);
    assert.ok(typeof marker.source === "string" && marker.source.length > 0);

    // dry-run schreibt keinen Marker
    const dryVault = await tmp("iv-marker-dry-");
    const d = await importVault(dryVault, src, { label: "marked", dryRun: true });
    assert.equal(d.dryRun, true);
    await assert.rejects(() => readFile(join(dryVault, d.folder, ".bastra-imported"), "utf8"));
    await rm(dryVault, { recursive: true, force: true });
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("#219 slug twins: link targets get the SAME slugify as minted ids (underscores → dashes)", async () => {
  const src = await tmp("iv-slug-src-");
  const vault = await tmp("iv-slug-vault-");
  try {
    await writeSrc(
      src,
      "feedback_gate_catalog.md",
      "---\nname: Gate catalog\ndescription: Catalog of gates\ntype: feedback\n---\nGate body.",
    );
    await writeSrc(
      src,
      "linker.md",
      "---\nname: Linker\ndescription: Links the catalog\ntype: reference\n---\nSee [[feedback_gate_catalog]] for details.",
    );
    const r = await importVault(vault, src, { label: "ccx" });
    assert.equal(r.imported, 2);
    assert.ok(r.ids.includes("ccx-feedback-gate-catalog"), "id minting slugifies underscores to dashes");
    const { body } = await readMem(vault, r.folder, "ccx-linker");
    assert.ok(
      body.includes("[[ccx-feedback-gate-catalog]]"),
      `link target must match the minted id, got: ${body}`,
    );
    assert.ok(!body.includes("feedback_gate_catalog]]"), "no underscored ghost twin left behind");
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

/**
 * #312: `imported` counted the synthetic index node (#217), the breakdown did
 * not, and the whole pass was skipped under --dry-run. Three numbers that had
 * to agree disagreed twice: 57 + 16 = 73 next to a reported total of 74, and a
 * dry-run predicting 73 for a run that did 74. The invariants pinned here:
 * breakdown sums to the total, dry-run predicts the real run exactly, and the
 * total matches what ends up on disk.
 */
test("#312 index node is counted and predicted: breakdown sums to the total, dry-run == real run", async () => {
  const src = await tmp("iv-312-src-");
  const dryVault = await tmp("iv-312-dry-");
  const vault = await tmp("iv-312-vault-");
  try {
    // A source index (the only thing that mints the synthetic index node) plus
    // one file per adapter, so all three categories are non-zero.
    await writeSrc(
      src,
      "MEMORY.md",
      "# Memory Index\n\n## Projekte\n- [Alpha](alpha.md) — das Alpha-Projekt\n- [Beta](beta.md) — die Beta-Notiz\n",
    );
    await writeSrc(src, "alpha.md", "---\nname: Alpha\ndescription: Alpha-Projekt\ntype: project\n---\nAlpha body.");
    await writeSrc(src, "beta.md", "# Beta\n\nDie Beta-Notiz ohne Frontmatter.\n");

    const dry = await importVault(dryVault, src, { label: "sum", dryRun: true });
    const real = await importVault(vault, src, { label: "sum" });

    // the itemisation must account for every id in the total
    for (const r of [dry, real]) {
      assert.equal(
        r.byAdapter.claudeCode + r.byAdapter.generic + r.byAdapter.index,
        r.imported,
        `breakdown must sum to imported (${JSON.stringify(r.byAdapter)} vs ${r.imported})`,
      );
      assert.equal(r.imported, r.ids.length);
      assert.equal(r.byAdapter.claudeCode, 1);
      assert.equal(r.byAdapter.generic, 1);
      assert.equal(r.byAdapter.index, 1, "the synthetic index has its own category");
    }

    // the preview must describe the run it previews
    assert.equal(dry.imported, real.imported);
    assert.deepEqual(dry.ids, real.ids);
    assert.deepEqual(dry.byAdapter, real.byAdapter);
    assert.equal(dry.indexNode, real.indexNode);
    assert.equal(real.indexNode, "sum-index");

    // …and the total must match reality on disk
    const onDisk = (await readdir(join(vault, real.folder))).filter((n) => n.endsWith(".md"));
    assert.equal(onDisk.length, real.imported);
    // a dry-run still writes nothing, index node included
    await assert.rejects(() => readdir(join(dryVault, dry.folder)));
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dryVault, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("#220 archive skip: _archive/, archive/ and --exclude dirs never import", async () => {
  const src = await tmp("iv-arch-src-");
  const vault = await tmp("iv-arch-vault-");
  try {
    await writeSrc(src, "live.md", "---\nname: Live\ndescription: Live note\ntype: user\n---\nBody.");
    await writeSrc(src, "_archive/old.md", "---\nname: Old\ndescription: Retired\ntype: user\n---\nBody.");
    await writeSrc(src, "archive/older.md", "---\nname: Older\ndescription: Retired too\ntype: user\n---\nBody.");
    await writeSrc(src, "Drafts/wip.md", "---\nname: WIP\ndescription: Draft\ntype: user\n---\nBody.");
    const r = await importVault(vault, src, { label: "arch", exclude: ["drafts"] });
    assert.equal(r.scanned, 1, "only the live note is scanned (case-insensitive exclude)");
    assert.deepEqual(r.ids, ["arch-live"]);
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

/**
 * #365/7: `byAdapter` was incremented BEFORE the save, so it counted attempts.
 * A vault the process cannot write to reported `byAdapter.generic: 80` next to
 * `imported: 0, ids: []` — the itemisation contradicting the total it exists to
 * itemise, i.e. exactly the invariant the #312 block above pins. The counter now
 * sits immediately before `ids.push`, the one place that means "this landed".
 */
test(
  "#365 a failed save lands in neither counter: byAdapter still sums to imported",
  { skip: typeof process.getuid === "function" && process.getuid() === 0 ? "root writes through 0555" : false },
  async () => {
    const src = await tmp("iv-365-src-");
    const vault = await tmp("iv-365-vault-");
    try {
      // one per adapter, so a regression would show up in either counter
      await writeSrc(src, "alpha.md", "---\nname: Alpha\ndescription: Alpha-Projekt\ntype: project\n---\nAlpha body.");
      await writeSrc(src, "beta.md", "# Beta\n\nDie Beta-Notiz ohne Frontmatter.\n");
      // r-x: the sources still map cleanly, every write below fails with EACCES.
      await chmod(vault, 0o555);

      const r = await importVault(vault, src, { label: "eacces" });

      assert.equal(r.scanned, 2, "both files are scanned and mapped — the failure is at the write");
      assert.equal(r.imported, 0, "nothing landed");
      assert.deepEqual(r.ids, []);
      assert.equal(
        r.byAdapter.claudeCode + r.byAdapter.generic + r.byAdapter.index,
        r.imported,
        `breakdown must sum to imported (${JSON.stringify(r.byAdapter)} vs ${r.imported})`,
      );
      assert.equal(r.skipped.length, 2, "content that did not land is reported as skipped");
      for (const sk of r.skipped) assert.match(sk.reason, /save failed/);
    } finally {
      await chmod(vault, 0o755).catch(() => {});
      await rm(src, { recursive: true, force: true });
      await rm(vault, { recursive: true, force: true });
    }
  },
);
