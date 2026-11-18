/**
 * Import P4 (#215) — ingest a whole folder of FOREIGN memory files into the
 * vault, deterministically, with NO per-item review. Unlike the P1–P3 paths
 * (which stage candidates in `import-review.md` for a human to distill), a
 * folder of already-structured memory files carries every field a memory
 * needs — so a known format maps straight through `saveMemory`, no gate.
 *
 * Two adapters, tried per file:
 *   - claude-code: Claude Code / "Anthropic standard" auto-memory. The format
 *     is NOT singular — some vaults write flat `type:`, others nested
 *     `metadata.type:`, some carry `[[wikilinks]]` in the body, others none,
 *     and ~10% of real files have no frontmatter at all. The adapter is
 *     deliberately tolerant of all of these.
 *   - generic-markdown: fallback for any other markdown note — title from the
 *     first H1 (or filename), summary from the first paragraph.
 *
 * Isolation: everything lands under `memories/imported/<label>/` with
 * label-namespaced ids, so (a) no existing memory is ever read or modified,
 * (b) ids can't collide with hand-authored memories, (c) the whole set is
 * delete-/re-importable atomically (one folder, one scope, one source tag).
 */
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { slugify, extractWikilinks, snapshotLocator } from "@bastra-recall/core";
import type { MemoryLocator, SaveMemoryInput } from "@bastra-recall/core";
import { sendJsonPlain } from "./webui.js";
import { getUiEnabled } from "./settings.js";
import { saveMemoryWithAuditTrail } from "./audit-trail.js";
import { IMPORT_WEBUI_WRITER, writeCallerStore } from "./caller-session.js";
import { linkKey, pathHash, safeSlug, uniqueId } from "./import/identity.js";
import { harvestIndex, looksLikeIndexHub, type IndexEntry } from "./import/index-harvest.js";
import { KNOWN_ADAPTERS, looksLikeClaudeCode, mapFile, safeParse } from "./import/adapters.js";
import { findOrphanedMemories } from "./import/orphans.js";
import { ensureVaultDir } from "@bastra-recall/core";
import {
  IMPORT_ROOT,
  listSourceMarkdown,
  type ImportVaultOptions,
  type ImportVaultResult,
  type ImportVaultSkip,
} from "./import-vault-shared.js";
export type { ImportVaultOrphan } from "./import/orphans.js";
// #680: split modules — re-exported so no importer has to change.
export { IMPORT_ROOT, listSourceMarkdown } from "./import-vault-shared.js";
export type { ImportVaultOptions, ImportVaultResult, ImportVaultSkip } from "./import-vault-shared.js";
export { listSubdirs, handleUiFsBrowse } from "./import-vault-fs-browse.js";
export type { FsBrowseEntry } from "./import-vault-fs-browse.js";

/** Who owns the node currently sitting on a candidate id, together with the
 * exact preimage the commit must still see. `unverifiable` means the node
 * exists but could not be read, so unknown behaves like foreign. */
type OwnershipCheck =
  | { owner: "free"; target: null }
  | { owner: "mine" | "foreign"; target: string }
  /** Fremd, aber die Datei steht woanders — es gibt keinen `target` am
   *  Importpfad zu zeigen. */
  | { owner: "foreign"; target: null }
  | { owner: "unverifiable" };

/** Result of minting an id: either a usable one, or a reason to skip the file
 *  visibly. The import never forces a write onto an id it could not clear. */
type Allocation = { id: string; skip?: undefined } | { id?: undefined; skip: string };

/** Deterministic hash-suffix candidates tried after the readable id is taken
 *  by a foreign node. Exhausting them is astronomically unlikely — and if it
 *  happens, the file is skipped rather than written onto a stranger (#245 P2). */
const HASH_CANDIDATES = 8;

// ── orchestration ────────────────────────────────────────────────────────────

/** What one `importVault` invocation carries through its passes. */
interface ImportRun {
  vaultRoot: string;
  sourceDir: string;
  label: string;
  folder: string;
  overwrite: boolean;
  dryRun: boolean;
  /** Correlation key, not an event id: allocated once before the write passes
   *  and reused for every content node and the synthetic index. A later
   *  import invocation must receive a different UUID. */
  runId: string;
  vaultIds: MemoryLocator;
  /** ONE allocator for the whole batch — see `mintIds`. */
  used: Set<string>;
  skipped: ImportVaultSkip[];
  warnings: ImportVaultSkip[];
  ids: string[];
  byAdapter: { claudeCode: number; generic: number; index: number };
  /** #530: created / updated / unchanged, gezählt aus dem, was der Save
   *  gemeldet hat — nicht aus dem, was der Import vorhatte. */
  written: { created: number; updated: number; unchanged: number };
}

/** Pass B's harvest: file basename → section and description from the index. */
type IndexHarvest = Map<string, IndexEntry>;

/** The ids minted from the source paths (Pass 0). */
interface MintedIds {
  idByBase: Map<string, string>;
  idByPath: Map<string, string>;
  relKeyByPath: Map<string, string>;
}

/**
 * Import every markdown memory file under `sourceDir` into the vault at
 * `vaultRoot`, isolated under `memories/imported/<label>/`. Deterministic,
 * gate-free, idempotent (stable ids + overwrite). Never reads or writes any
 * file outside the import subtree.
 */
export async function importVault(
  vaultRoot: string,
  sourceDir: string,
  options: ImportVaultOptions = {}
): Promise<ImportVaultResult> {
  const srcReal = await assertImportableSource(vaultRoot, sourceDir);
  const label = slugify(options.label ?? (basename(sourceDir) || "import"));
  const files = await listSourceMarkdown(
    sourceDir,
    new Set((options.exclude ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean))
  );
  const skipped: ImportVaultSkip[] = [];
  // Pass 0: read every file once — the inbound-veto and the index harvest both
  // need a view of the WHOLE set before any single file is mapped.
  const rawByFile = await readSources(files, skipped);

  // #240 (Codex gegencheck 5cf71bb): the import must NEVER overwrite a FOREIGN
  // node. saveMemory(overwrite:true) is itself a silent replace — temp+rename,
  // no trash — so removing the migration (Weg C) was not enough: a colliding
  // batch-allocated id could still land on a stranger. Ownership is read back
  // from the `source` stamp: files carry "<adapter>:<label>:<relKey>", the
  // synthetic index carries "index:<label>".
  // Codex-Gegenreview: Die Prüfung sah nur den ERWARTETEN Importpfad. Ein
  // fremdes Memory mit derselben id an einem anderen Ort — von Hand angelegt,
  // aus einem anderen Import, re-filed — blieb unsichtbar, und der Import
  // schrieb seine Datei daneben. Danach tragen zwei Dateien dieselbe id, und
  // der Vault lädt beim nächsten Start still nur eine davon; gewinnt der
  // Import alphabetisch, verdrängt er das Original aus dem aktiven Index.
  // Ein Snapshot des ganzen Vaults, EINMAL: die Frage lautet "gehört diese id
  // schon jemandem, bevor ich anfange", und die beantwortet der Ausgangsstand.
  // Der Snapshot beantwortet das ROUTING (welches Regal, welche Schreibweise)
  // für alle Quelldateien mit EINEM Scan. Er ist ausdrücklich NICHT mehr die
  // Kollisionsauskunft:
  //
  // Codex-Gegenreview (P0): Als Authority eingesetzt war er nicht
  // prozesssicher. `used` kennt nur die ids, die dieser Import selbst vergeben
  // hat — nicht die Saves eines parallel laufenden Daemons oder einer zweiten
  // Maschine auf demselben Vault. Nachgestellt: Snapshot auf leerem Vault,
  // danach ein normaler Save von `race-id`, danach der Import mit der alten
  // Authority — zwei Dateien mit `race-id`. „Ein Prozess pro Import" ist keine
  // Zusicherung, solange andere Prozesse denselben Vault schreiben dürfen.
  //
  // Der Import zahlt deshalb die autoritative Prüfung je id wie jeder andere
  // Writer. Das kostet einen Vaultscan pro Datei; ein Import ist ein einmaliger
  // Vorgang, und Korrektheit ist hier den Preis wert.
  const run: ImportRun = {
    vaultRoot,
    sourceDir,
    label,
    folder: `${IMPORT_ROOT}/${label}`,
    overwrite: options.overwrite ?? true,
    dryRun: options.dryRun ?? false,
    runId: randomUUID(),
    vaultIds: snapshotLocator(vaultRoot),
    used: new Set<string>(),
    skipped,
    warnings: [],
    ids: [],
    byAdapter: { claudeCode: 0, generic: 0, index: 0 },
    written: { created: 0, updated: 0, unchanged: 0 },
  };

  const minted = await mintIds(run, files);

  // #240/A10 legacy migration — REMOVED (Weg C). The import NEVER trashes an
  // existing node.
  //
  // Four re-audit rounds proved that automatically retiring a pre-A10 node
  // cannot be made loss-free: the node carries no record of which source path
  // produced it (that is the whole reason A10 exists), so any automatic rule —
  // id-shape, collision-suffix, or body-equality — has a case where it trashes
  // content that is not reproduced elsewhere (an orphaned node of a removed
  // source, an enriched frontmatter/body, a mid-run edit). Since the only
  // failure mode of the automatic pass is SILENT, IRREVERSIBLE loss, and the
  // only thing it buys is not leaving a duplicate behind after the rare
  // reimport-across-the-A10-change, the trade is wrong. So: import writes the
  // new ids and leaves any pre-A10 twin as a VISIBLE, ACTIVE duplicate. The
  // user (or a future opt-in `bastra migrate` that SHOWS each pair and asks)
  // cleans up — a confirmed delete can never lose data the way an automatic
  // one can. `migrated` stays in the result shape for compatibility, always [].
  /** #240/A10: retired legacy nodes. Weg C: always empty (see above). */
  const migrated: Array<{ from: string; to: string }> = [];

  // Pass A: every namespaced id that SOME body links to — the inbound-veto set
  // (Finding #2). A hub OTHERS point at is a real target, not a throwaway index.
  const referenced = collectReferenced(run, rawByFile, minted.idByBase);

  // Pass B: harvest the index/hubs into section + description structure
  // (Finding #5).
  const harvest = await harvestSources(sourceDir, rawByFile);

  // Pass C: map + save. Weg C — imports write ids and never trash anything, so
  // a pre-A10 twin simply stays active alongside the new node (see above).
  for (const filePath of files) {
    await importFile(run, filePath, rawByFile.get(filePath), minted, referenced, harvest);
  }

  const indexNode = await writeIndexNode(run, harvest, minted.idByBase);

  // #530 follow-up: orphaned memories (source file gone) — read-only, see orphans.ts.
  const orphaned = await findOrphanedMemories(vaultRoot, run.folder, label, new Set(minted.relKeyByPath.values()));

  await restampMarker(run, srcReal);

  return {
    sourceDir,
    label,
    folder: run.folder,
    scope: label,
    scanned: files.length,
    imported: run.ids.length,
    byAdapter: run.byAdapter,
    written: run.written,
    skipped: run.skipped,
    warnings: run.warnings,
    ids: run.ids,
    indexNode,
    migrated,
    orphaned,
    dryRun: run.dryRun,
  };
}

/** The source must be a directory, and it must not overlap the vault. Returns
 *  its real path, which the marker records. */
async function assertImportableSource(vaultRoot: string, sourceDir: string): Promise<string> {
  const info = await stat(sourceDir).catch(() => null);
  if (!info || !info.isDirectory()) {
    throw new Error(`not a directory: ${sourceDir}`);
  }
  // Self-Ingest-Guard (zzallirog field report, 2026-07-18): Quelle und Vault
  // dürfen sich NICHT überlappen. `import vault <vault>` schrieb eine
  // komplette slugifizierte Kopie des Vaults in den Vault selbst — der Daemon
  // scoped sauber und versteckt es, aber jedes andere Tool auf dem geteilten
  // Ordner (Atlas, Indexer, grep) sieht ein Halb-Echo-Korpus. Für Nutzer,
  // deren Memory-Verzeichnis DER Vault ist, gilt: die Files sind bereits
  // nativ indexiert — Import ist für FREMDE Ordner. realpath, damit Symlinks
  // (~, Cloud-Mounts) die Prüfung nicht umgehen.
  const srcReal = await realpath(sourceDir).catch(() => resolve(sourceDir));
  const vaultReal = await realpath(vaultRoot).catch(() => resolve(vaultRoot));
  const within = (child: string, parent: string): boolean => child === parent || child.startsWith(parent + sep);
  if (within(srcReal, vaultReal) || within(vaultReal, srcReal)) {
    throw new Error(
      `import source (${srcReal}) overlaps the vault (${vaultReal}) — refusing to self-ingest. ` +
        `The vault indexes its own files natively; importing it into itself would write a duplicate ` +
        `slugified copy under ${IMPORT_ROOT}/. Point "import vault" at a folder OUTSIDE the vault ` +
        `(or copy the notes out first).`
    );
  }
  return srcReal;
}

/** Pass 0: every source file's text; an unreadable one is recorded as skipped. */
async function readSources(files: string[], skipped: ImportVaultSkip[]): Promise<Map<string, string>> {
  const rawByFile = new Map<string, string>();
  for (const filePath of files) {
    try {
      rawByFile.set(filePath, await readFile(filePath, "utf8"));
    } catch (err) {
      skipped.push({ path: filePath, reason: `unreadable: ${(err as Error).message}` });
    }
  }
  return rawByFile;
}

function importPathOf(run: ImportRun, id: string): string {
  return join(run.vaultRoot, run.folder, `${id}.md`);
}

/** Who owns the node on `id` — see the ownership notes in `importVault`. */
async function ownershipOf(run: ImportRun, id: string, myKey: string, isIndex: boolean): Promise<OwnershipCheck> {
  // Liegt die id ANDERSWO im Vault, ist sie vergeben — unabhängig davon,
  // was am Importpfad steht. Auch `ambiguous` ist vergeben: Dann ist der
  // Vault schon defekt, und ein weiterer Anwärter macht es nicht besser.
  const located = run.vaultIds.locate(id);
  if (located.kind === "ambiguous") return { owner: "foreign", target: null };
  if (located.kind === "unique" && located.filePath !== importPathOf(run, id)) {
    return { owner: "foreign", target: null };
  }
  let raw: string;
  try {
    raw = await readFile(importPathOf(run, id), "utf8");
  } catch (err) {
    // #245 P1: fail CLOSED. Only a confirmed ENOENT means "no node here".
    // Any other failure — EACCES/EIO/ETIMEDOUT are all reachable on the
    // cloud mounts this project explicitly supports — leaves ownership
    // UNKNOWN, and an unknown owner must never be overwritten.
    return (err as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { owner: "free", target: null }
      : { owner: "unverifiable" };
  }
  const data = safeParse(raw).data;
  const src = typeof data.source === "string" ? data.source : "";
  if (isIndex) {
    return {
      owner: src === `index:${run.label}` ? "mine" : "foreign",
      target: raw,
    };
  }
  const parts = src.split(":");
  if (parts[1] === run.label && KNOWN_ADAPTERS.has(parts[0])) {
    // #245 P1: a stamp WITHOUT a relKey predates the provenance stamp, so
    // its source path is unknowable — it may belong to a source file that
    // was since renamed or removed. Treating it as this file's predecessor
    // was an overwrite on a guess, and it hit every existing user on the
    // first reimport after the update. Unknown provenance is FOREIGN: the
    // import lands beside it as a visible duplicate (Weg C) instead of
    // replacing content it cannot prove it produced.
    return {
      owner: parts.length >= 3 && parts.slice(2).join(":") === myKey ? "mine" : "foreign",
      target: raw,
    };
  }
  return { owner: "foreign", target: raw }; // hand-authored, index role, or another label
}

/** Batch-unique id that never resolves onto a FOREIGN on-disk node: on
 *  foreign collision, fall back to a path-stable hash suffix (same across
 *  runs because `seed` is stable).
 *
 *  #245 P2: the loop used to mint a candidate on its last pass and return it
 *  WITHOUT checking it — an exhausted allocator handed back an id that could
 *  belong to a stranger. Every candidate is now checked before it is handed
 *  out, and running out is a SKIP, never a forced write. Same for an
 *  unverifiable target: refusing beats guessing, because the write path is
 *  temp+rename with no trash. */
async function allocateOwnedId(run: ImportRun, base: string, seed: string, isIndex = false): Promise<Allocation> {
  let id = uniqueId(base, run.used);
  for (let guard = 0; ; guard++) {
    const check = await ownershipOf(run, id, seed, isIndex);
    if (check.owner === "free" || check.owner === "mine") return { id };
    if (check.owner === "unverifiable")
      return {
        skip: `ownership of ${run.folder}/${id}.md is unverifiable (node exists but is unreadable) — refusing to overwrite`,
      };
    if (guard >= HASH_CANDIDATES) break;
    id = uniqueId(`${base}-${pathHash(guard === 0 ? seed : `${seed}#${guard}`)}`, run.used);
  }
  return { skip: `no free id: "${base}" and all ${HASH_CANDIDATES} hash candidates are owned by foreign nodes` };
}

/**
 * #240/A10 Pass 0: mint every final id from the SOURCE PATHS first, before
 * a single body is mapped. The ids carry the relative directory now, so
 * each resolver below has to look the target up here instead of
 * recomputing `slugify(label + basename)` — that recomputation resolved
 * nested files to ids that were never minted and turned every intra-set
 * link into a ghost. Deterministic: `files` is sorted, so a genuine
 * basename collision resolves to the same winner on every run.
 * ONE allocator for the whole batch (`used`): Pass 0 and the synthetic index
 * in Pass D must draw from the same set. A separate Pass-0 set left `used`
 * empty, so a source file literally named `index.md` minted `<label>-index`
 * here and the synthetic index picked the same id and overwrote it — the
 * source note's content was gone.
 */
async function mintIds(run: ImportRun, files: string[]): Promise<MintedIds> {
  const idByBase = new Map<string, string>();
  const idByPath = new Map<string, string>();
  const relKeyByPath = new Map<string, string>();
  for (const filePath of files) {
    const relKey = relative(run.sourceDir, filePath).split(sep).join("/"); // POSIX provenance key
    relKeyByPath.set(filePath, relKey);
    const relDir = relative(run.sourceDir, filePath).split(sep).slice(0, -1).join(sep);
    const fileBase = basename(filePath, extname(filePath));
    const relSegments = relDir ? relDir.split(sep).filter(Boolean) : [];
    const alloc = await allocateOwnedId(run, slugify([run.label, ...relSegments, fileBase].join("-")), relKey);
    if (alloc.skip !== undefined) {
      // #245: no id could be cleared for this file. Skipping is VISIBLE — the
      // caller surfaces skipped[] — where the old behaviour was a silent
      // overwrite of somebody else's node.
      run.skipped.push({ path: filePath, reason: alloc.skip });
      continue;
    }
    const id = alloc.id;
    idByPath.set(filePath, id);
    // Keyed by the LINK form, not the raw basename: a body writes `[[two]]`
    // while the file is `Two.md`, so both sides have to pass through the same
    // normalization or the lookup misses and mints a ghost.
    const key = linkKey(fileBase);
    if (key && !idByBase.has(key)) idByBase.set(key, id);
  }
  return { idByBase, idByPath, relKeyByPath };
}

/** Pass A: the namespaced ids some body links to. */
function collectReferenced(run: ImportRun, rawByFile: Map<string, string>, idByBase: Map<string, string>): Set<string> {
  const referenced = new Set<string>();
  for (const raw of rawByFile.values()) {
    const { content } = safeParse(raw);
    for (const x of extractWikilinks(content)) {
      const id = idByBase.get(linkKey(x) ?? x) ?? safeSlug(`${run.label}-${x}`);
      if (id) referenced.add(id);
    }
  }
  return referenced;
}

/** Pass B: the root MEMORY.md is read explicitly — the walker skips it — plus
 *  any file recognized as a link hub inside the set. */
async function harvestSources(sourceDir: string, rawByFile: Map<string, string>): Promise<IndexHarvest> {
  const indexSources: string[] = [];
  for (const name of ["MEMORY.md", "memory.md", "Memory.md"]) {
    try {
      indexSources.push(await readFile(join(sourceDir, name), "utf8"));
      break;
    } catch {
      /* no index by that name — try the next spelling */
    }
  }
  for (const raw of rawByFile.values()) {
    const { data, content } = safeParse(raw);
    if (!looksLikeClaudeCode(data) && looksLikeIndexHub(content)) indexSources.push(content);
  }
  return harvestIndex(indexSources);
}

/** Tally one save by what it reported (#530). */
function countWrite(run: ImportRun, saved: { unchanged?: boolean; created?: boolean }): void {
  if (saved.unchanged) run.written.unchanged++;
  else if (saved.created) run.written.created++;
  else run.written.updated++;
}

/** Pass C for one source file: map, re-check ownership, save, count. */
async function importFile(
  run: ImportRun,
  filePath: string,
  raw: string | undefined,
  minted: MintedIds,
  referenced: Set<string>,
  harvest: IndexHarvest
): Promise<void> {
  if (raw === undefined) return; // unreadable — already recorded in skipped
  const relDir = relative(run.sourceDir, filePath).split(sep).slice(0, -1).join(sep);
  const fileBase = basename(filePath, extname(filePath));
  const selfId = minted.idByPath.get(filePath);
  if (selfId === undefined) return; // not part of the minted set
  const relKey = minted.relKeyByPath.get(filePath) ?? relative(run.sourceDir, filePath).split(sep).join("/");
  const mapped = mapFile(fileBase, raw, {
    label: run.label,
    folder: run.folder,
    relDir,
    relKey,
    overwrite: run.overwrite,
    used: run.used,
    referenced,
    harvest,
    idByBase: minted.idByBase,
    selfId,
  });
  if (!mapped.ok) {
    run.skipped.push({ path: filePath, reason: mapped.reason });
    return;
  }
  for (const reason of mapped.warnings) run.warnings.push({ path: filePath, reason });
  if (!run.dryRun && !(await saveImportedFile(run, filePath, mapped.input, relKey))) return;
  // #365/7: erst zählen, wenn der Save wirklich gelandet ist. Vorher stand das
  // Inkrement VOR dem Write — ein nicht beschreibbarer Vault meldete
  // `byAdapter.generic: 80` neben `imported: 0, ids: []` und brach damit genau
  // die Invariante, die der Header dieser Datei zusichert. Der Dry-Run bleibt
  // unberührt: ohne Write gibt es kein Fehler-`continue`, und der
  // Ownership-Check darüber ist per `if (!dryRun)` ohnehin übersprungen — eine
  // gemappte Datei erreicht diese Zeile im Dry-Run wie zuvor. Pass D unten
  // zählt bereits nach demselben Muster.
  if (run.dryRun) run.written.created++;
  if (mapped.input.source?.startsWith("claude-code-memory")) run.byAdapter.claudeCode++;
  else run.byAdapter.generic++;
  run.ids.push(mapped.input.id as string);
}

/** The real write of one mapped file; false when it did not land (recorded in
 *  `skipped`). */
async function saveImportedFile(
  run: ImportRun,
  filePath: string,
  input: SaveMemoryInput,
  relKey: string
): Promise<boolean> {
  // #245 P1 (TOCTOU): the id was cleared back in Pass 0, and Pass C runs
  // much later — long enough for another writer to land a node on it.
  // #285 closes the remaining check→commit window: pass the exact raw
  // preimage into saveMemory's ownership-aware commit.
  const check = await ownershipOf(run, input.id as string, relKey, false);
  if (check.owner !== "free" && check.owner !== "mine") {
    run.skipped.push({
      path: filePath,
      reason: `ownership of ${run.folder}/${input.id}.md changed after the id was minted (${check.owner}) — refusing to overwrite`,
    });
    return false;
  }
  try {
    // #530: `skipUnchanged` — eine Datei, die schon genau so dasteht, wird
    // nicht neu geschrieben. Sie zählt trotzdem als importiert: sie liegt
    // im Vault, und der Index-Knoten unten darf auf sie verlinken.
    const saved = await saveMemoryWithAuditTrail({
      vaultRoot: run.vaultRoot,
      input,
      actor: "import",
      actorDetail: "import:vault",
      sessionId: run.runId,
      commit: { expectedTarget: check.target, locator: run.vaultIds, skipUnchanged: true },
    });
    countWrite(run, saved);
    return true;
  } catch (err) {
    // `recordAudit` absorbs audit-only failures. Reaching this catch means
    // target resolution or the memory write itself failed, so `skipped`
    // remains an honest list of content that did not land.
    run.skipped.push({ path: filePath, reason: `save failed: ${(err as Error).message}` });
    return false;
  }
}

/** The index body grouped by section, linking only ids that imported. */
function indexSections(
  run: ImportRun,
  harvest: IndexHarvest,
  idByBase: Map<string, string>
): { lines: string[]; linkCount: number; sectionCount: number } {
  const importedIds = new Set(run.ids);
  const bySection = new Map<string, string[]>(); // section → wikilink ids, in index order
  for (const [fileBase, entry] of harvest) {
    const linkId = idByBase.get(linkKey(fileBase) ?? fileBase) ?? safeSlug(`${run.label}-${fileBase}`);
    if (!linkId || !importedIds.has(linkId)) continue;
    const sec = entry.section ?? "";
    const list = bySection.get(sec) ?? [];
    list.push(linkId);
    bySection.set(sec, list);
  }
  const lines: string[] = [];
  let linkCount = 0;
  for (const [sec, linkIds] of bySection) {
    if (sec) lines.push(`## ${sec}`);
    for (const linkId of linkIds) {
      lines.push(`- [[${linkId}]]`);
      linkCount++;
    }
    lines.push("");
  }
  const sectionCount = [...bySection.keys()].filter((s) => s.length > 0).length;
  return { lines, linkCount, sectionCount };
}

/**
 * Pass D: the curated index as ONE navigation node (Finding #5). Native CC
 * memory keeps its only connective tissue in MEMORY.md; rather than discard
 * it, mint a single reference memory whose body wikilinks EACH imported file,
 * grouped by section. Links point only at ids that actually imported, so it
 * adds edges (the star that ties the islands together), never ghosts.
 *
 * #312: the dry-run runs this pass too. Everything up to the write is pure
 * computation over the already-read sources, and the pass mints a node that
 * counts in `imported` — skipping it made the preview predict one node fewer
 * than the run it previews, which is the one thing a preview must not do.
 */
async function writeIndexNode(
  run: ImportRun,
  harvest: IndexHarvest,
  idByBase: Map<string, string>
): Promise<string | null> {
  if (harvest.size === 0 || run.ids.length === 0) return null;
  const sections = indexSections(run, harvest, idByBase);
  if (sections.linkCount === 0) return null;
  // Role-scoped ownership: the synthetic index may only overwrite a node
  // that is itself `source: index:<label>` — never a foreign node that
  // happens to sit on the `-index`/`-index-2` fallback id (#240 P1-b).
  const indexSeed = `index:${run.label}`;
  const alloc = await allocateOwnedId(run, slugify(`${run.label}-index`), indexSeed, true);
  // #245 P2: if no id could be cleared, the index is simply not written.
  // It is navigation, not content — the notes themselves already imported,
  // and no foreign node is worth a nav star.
  if (alloc.id === undefined) return null;
  const id = alloc.id;
  const indexCheck = await ownershipOf(run, id, indexSeed, true); // #245 P1: TOCTOU re-check
  if (indexCheck.owner !== "free" && indexCheck.owner !== "mine") return null;
  // A dry-run has nothing to write, so nothing can fail — it lands by
  // definition; a real run only lands if the write returns.
  const landed = run.dryRun || (await saveIndexNode(run, id, sections, indexCheck.target));
  if (!landed) return null;
  if (run.dryRun) run.written.created++;
  run.ids.push(id);
  // #312: it goes into `ids`, so it must go into the breakdown in the
  // same breath — an id counted in the total but in no category is the
  // itemisation contradicting the number above it.
  run.byAdapter.index++;
  return id;
}

/** The real write of the synthetic index; false when it did not land. */
async function saveIndexNode(
  run: ImportRun,
  id: string,
  sections: { lines: string[]; linkCount: number; sectionCount: number },
  expectedTarget: string | null
): Promise<boolean> {
  const { label, folder } = run;
  const { lines, linkCount, sectionCount } = sections;
  try {
    const savedIndex = await saveMemoryWithAuditTrail({
      vaultRoot: run.vaultRoot,
      input: {
        id,
        title: `${label} — Index`,
        type: "reference",
        summary: `Navigations-Index für den Import „${label}" (${linkCount} Notizen${sectionCount ? `, ${sectionCount} Bereiche` : ""}).`,
        body: `Kuratierter Index des importierten Ordners „${label}" — die Verbindungsstruktur aus dem Quell-Index.\n\n${lines.join("\n")}`,
        topic_path: ["imported", label],
        tags: [...new Set(["imported", label, "index"])],
        scope: label,
        recall_when: [`${label} index`, `${label} übersicht`],
        folder,
        write_origin: "user-directed",
        overwrite: run.overwrite,
        source: `index:${label}`,
      },
      actor: "import",
      actorDetail: "import:vault",
      sessionId: run.runId,
      commit: { expectedTarget, locator: run.vaultIds, skipUnchanged: true },
    });
    countWrite(run, savedIndex);
    return true;
  } catch {
    // Audit-only failures were already absorbed by `recordAudit`.
    // A routing/write failure here still cannot fail the imported notes:
    // the synthetic index is navigation and remains best-effort.
    return false;
  }
}

/** The count the existing marker stores, and whether there is one at all. */
async function readMarker(run: ImportRun): Promise<{ markerExisted: boolean; previousImported?: number }> {
  try {
    const prevRaw = await readFile(join(run.vaultRoot, run.folder, ".bastra-imported"), "utf8");
    const prev = JSON.parse(prevRaw) as { imported?: unknown };
    return { markerExisted: true, previousImported: typeof prev.imported === "number" ? prev.imported : undefined };
  } catch {
    /* no marker yet, or unreadable — nothing to compare against */
    return { markerExisted: false };
  }
}

/**
 * #530: the marker mirrors the CURRENT source set, not a cumulative log
 * (product decision) — so a run that writes nothing can still owe the
 * marker an update: the source set may have SHRUNK (a file was removed),
 * leaving `ids.length` below what the marker already claims even though
 * every remaining file was already in the vault (written.created ===
 * written.updated === 0). This read is NOT gated on `ids.length > 0`: the
 * same shrink can go all the way to zero (the last source file removed),
 * and a marker still claiming the old count would be exactly as stale as
 * the n -> n-1 case this fix was written for. Compare against the count
 * the existing marker already stores — no new marker format, `imported`
 * was always there — and treat a stale count as a change too. A run that
 * writes nothing AND matches the marker's count stays a true no-op: no
 * read finds a mismatch, so no restamp.
 */
async function restampMarker(run: ImportRun, srcReal: string): Promise<void> {
  if (run.dryRun) return;
  const { markerExisted, previousImported } = await readMarker(run);
  // A count mismatch only counts as a change when a marker was actually
  // there to be stale: an empty source set with no prior marker (ids.length
  // === 0, markerExisted === false) must stay a true no-op — nothing to
  // reflect and nothing to skip. Once a marker exists, it mirrors the
  // current set even when that set is now empty (product decision: the
  // marker reflects reality, it is never deleted here).
  const countChanged = markerExisted && previousImported !== run.ids.length;
  const setChanged = run.written.created > 0 || run.written.updated > 0 || countChanged;
  if (!setChanged) return;
  // Fix-Leiter Stufe 3 (zzallirog): ein Marker im Import-Subtree, damit
  // FREMDE Tools auf dem geteilten Ordner (Atlas, Indexer, grep) das Set
  // als maschinell erzeugte Kopie erkennen und überspringen können. Kein
  // .md — der Vault-Loader ignoriert die Datei.
  try {
    const markerDir = join(run.vaultRoot, run.folder);
    await ensureVaultDir(run.vaultRoot, markerDir);
    await writeFile(
      join(markerDir, ".bastra-imported"),
      JSON.stringify(
        {
          tool: "bastra-recall import vault",
          label: run.label,
          source: srcReal,
          imported: run.ids.length,
          at: new Date().toISOString(),
          note: "Machine-imported copy of an external folder — safe for external tools to skip.",
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  } catch {
    /* marker is best-effort — never fail an import over it */
  }
}

/**
 * POST /ui/import-vault — the map's folder-import: the user picks a local
 * folder (the loopback daemon has local file access) and it imports
 * through the same `importVault` core as the CLI. Unlike /ui/import (staging
 * only), this writes directly — but only into the isolated import subtree.
 * ui-gated + loopback-only like the rest of /ui. `onIndexed` reconciles the
 * vault so the new nodes show up on the map immediately.
 */
export async function handleUiImportVault(
  req: IncomingMessage,
  res: ServerResponse,
  vaultPath: string,
  onIndexed?: () => Promise<unknown>,
  settingsPath?: string
): Promise<void> {
  if (!(await getUiEnabled(settingsPath))) {
    sendJsonPlain(res, 404, { error: "ui disabled" });
    return;
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) {
      sendJsonPlain(res, 413, { error: "body too large" });
      return;
    }
  }
  let body: { dir?: unknown; label?: unknown; dryRun?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    sendJsonPlain(res, 400, { error: "invalid JSON body" });
    return;
  }
  const dir = typeof body.dir === "string" ? body.dir.trim() : "";
  if (!dir) {
    sendJsonPlain(res, 400, { error: "dir required — the path to a folder of memory files" });
    return;
  }
  const label = typeof body.label === "string" && body.label.trim().length > 0 ? body.label.trim() : undefined;
  let result: ImportVaultResult;
  try {
    result = await writeCallerStore.run(IMPORT_WEBUI_WRITER, () =>
      importVault(vaultPath, dir, { label, dryRun: body.dryRun === true })
    );
  } catch (err) {
    sendJsonPlain(res, 400, { error: (err as Error).message });
    return;
  }
  if (!result.dryRun && result.imported > 0 && onIndexed) {
    await onIndexed().catch(() => {});
  }
  sendJsonPlain(res, 200, {
    imported: result.imported,
    // #530: dieselbe Trennung wie in der CLI — die Map soll nicht „importiert"
    // melden, wo nichts geschrieben wurde.
    written: result.written,
    scanned: result.scanned,
    folder: result.folder,
    scope: result.scope,
    by_adapter: result.byAdapter,
    skipped: result.skipped.length,
    warnings: result.warnings.length, // #710: fields the adapter fixed on the way in
    orphaned: result.orphaned.length, // #530 follow-up: source gone, memory kept
    dry_run: result.dryRun,
  });
}
