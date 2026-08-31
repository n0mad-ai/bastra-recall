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
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { slugify, extractWikilinks, snapshotLocator } from "@bastra-recall/core";
import { sendJsonPlain } from "./webui.js";
import { getUiEnabled } from "./settings.js";
import { saveMemoryWithAuditTrail } from "./audit-trail.js";
import { linkKey, pathHash, safeSlug, uniqueId } from "./import/identity.js";
import { harvestIndex, looksLikeIndexHub } from "./import/index-harvest.js";
import { looksLikeClaudeCode, mapFile, safeParse } from "./import/adapters.js";

/** Reserved subtree for all folder imports — its own graph cluster, and the
 *  atomic unit for delete/re-import. Never a target of the normal scope/type
 *  routing, so it can't overlap a hand-authored memory's path. */
export const IMPORT_ROOT = "memories/imported";

export interface ImportVaultOptions {
  /** Namespace label for this batch; defaults to the source dir's basename.
   *  Becomes the subfolder, the scope, and the id prefix. */
  label?: string;
  /** Re-import in place instead of erroring on an existing id (default true —
   *  a folder import is idempotent by design). */
  overwrite?: boolean;
  /** Map + count without writing anything (default false). */
  dryRun?: boolean;
  /** #220 (zzallirog): additional directory NAMES to skip anywhere in the
   *  tree (case-insensitive). Dotdirs, node_modules and `_archive`/`archive`
   *  are always skipped — retired notes must not compete with live ones for
   *  node identity. */
  exclude?: string[];
}

/** Always-skipped directory names (#220): archives hold retired copies of
 *  live notes — importing them mints `-2`/`-3` collision twins. */
const DEFAULT_EXCLUDED_DIRS = new Set(["_archive", "archive"]);

/** Adapter prefixes the ownership check recognizes in a node's `source` stamp
 *  (`<adapter>:<label>:<relKey>`). A stamp that starts with one of these AND
 *  carries this label is a prior node of THIS importer; anything else on a
 *  colliding id is foreign and must never be overwritten (#240). */
const KNOWN_ADAPTERS = new Set(["claude-code-memory", "markdown"]);

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

export interface ImportVaultSkip {
  path: string;
  reason: string;
}

export interface ImportVaultResult {
  sourceDir: string;
  label: string;
  folder: string;
  scope: string;
  scanned: number;
  imported: number;
  /** #312: every id in `ids` is counted in exactly ONE of these, so the
   *  breakdown always sums to `imported`. `index` is the synthetic
   *  curated-index node (#217) — it is a written memory like any other, but it
   *  comes from no source file and therefore from no adapter, which is why it
   *  used to fall out of the itemisation while still inflating the total.
   *  #365/7: counted is the import that LANDED, not the attempt. A dry-run and
   *  the real run therefore still predict the same numbers as long as no save
   *  fails; a failed write shows up in `skipped` and in no counter — deliberate,
   *  because the breakdown must keep summing to `imported`. */
  byAdapter: { claudeCode: number; generic: number; index: number };
  skipped: ImportVaultSkip[];
  ids: string[];
  /** #217: id of the synthetic curated-index node minted from the source
   *  index (MEMORY.md / hubs), or null when the source carried no index.
   *  #312: a dry-run predicts this id too — it is resolved without writing. */
  indexNode: string | null;
  /** #240/A10: kept for shape compatibility, ALWAYS []. Weg C: the import
   *  never trashes a pre-A10 twin — automatic retirement could not be made
   *  loss-free (see the orchestrator). A pre-A10 duplicate stays active until
   *  the user, or a future opt-in `bastra migrate`, removes it with a
   *  confirmed delete. */
  migrated: Array<{ from: string; to: string }>;
  dryRun: boolean;
}

// ── directory walk ───────────────────────────────────────────────────────────

/** Recursively collect `*.md` files under `dir`, skipping dotdirs and
 *  node_modules (same policy as the vault loader) and the `MEMORY.md` pointer
 *  index (it's a table of contents, not a memory). Returns absolute paths. */
async function listSourceMarkdown(dir: string, exclude: Set<string> = new Set()): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === "node_modules" || (e.name.startsWith(".") && e.name.length > 1)) continue;
      const full = join(current, e.name);
      if (e.isDirectory()) {
        const name = e.name.toLowerCase();
        if (DEFAULT_EXCLUDED_DIRS.has(name) || exclude.has(name)) continue;
        await walk(full);
      } else if (e.isFile() && extname(e.name).toLowerCase() === ".md" && e.name.toLowerCase() !== "memory.md") {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

// ── orchestration ────────────────────────────────────────────────────────────

/**
 * Import every markdown memory file under `sourceDir` into the vault at
 * `vaultRoot`, isolated under `memories/imported/<label>/`. Deterministic,
 * gate-free, idempotent (stable ids + overwrite). Never reads or writes any
 * file outside the import subtree.
 */
export async function importVault(
  vaultRoot: string,
  sourceDir: string,
  options: ImportVaultOptions = {},
): Promise<ImportVaultResult> {
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
  const within = (child: string, parent: string): boolean =>
    child === parent || child.startsWith(parent + sep);
  if (within(srcReal, vaultReal) || within(vaultReal, srcReal)) {
    throw new Error(
      `import source (${srcReal}) overlaps the vault (${vaultReal}) — refusing to self-ingest. ` +
        `The vault indexes its own files natively; importing it into itself would write a duplicate ` +
        `slugified copy under ${IMPORT_ROOT}/. Point "import vault" at a folder OUTSIDE the vault ` +
        `(or copy the notes out first).`,
    );
  }
  const label = slugify(options.label ?? (basename(sourceDir) || "import"));
  const overwrite = options.overwrite ?? true;
  const dryRun = options.dryRun ?? false;
  const folder = `${IMPORT_ROOT}/${label}`;
  // Correlation key, not an event id: allocate once before the write passes
  // and reuse it for every content node and the synthetic index. A later
  // import invocation must receive a different UUID.
  const runId = randomUUID();

  const files = await listSourceMarkdown(
    sourceDir,
    new Set((options.exclude ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean)),
  );
  const used = new Set<string>();
  const skipped: ImportVaultSkip[] = [];
  const ids: string[] = [];
  const byAdapter = { claudeCode: 0, generic: 0, index: 0 };

  // Pass 0: read every file once — the inbound-veto and the index harvest both
  // need a view of the WHOLE set before any single file is mapped.
  const rawByFile = new Map<string, string>();
  for (const filePath of files) {
    try {
      rawByFile.set(filePath, await readFile(filePath, "utf8"));
    } catch (err) {
      skipped.push({ path: filePath, reason: `unreadable: ${(err as Error).message}` });
    }
  }

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
  const vaultIds = snapshotLocator(vaultRoot);
  const importPathOf = (id: string): string => join(vaultRoot, folder, `${id}.md`);

  const ownership = async (
    id: string,
    myKey: string,
    isIndex: boolean,
  ): Promise<OwnershipCheck> => {
    // Liegt die id ANDERSWO im Vault, ist sie vergeben — unabhängig davon,
    // was am Importpfad steht. Auch `ambiguous` ist vergeben: Dann ist der
    // Vault schon defekt, und ein weiterer Anwärter macht es nicht besser.
    const located = vaultIds.locate(id);
    if (located.kind === "ambiguous") return { owner: "foreign", target: null };
    if (located.kind === "unique" && located.filePath !== importPathOf(id)) {
      return { owner: "foreign", target: null };
    }
    let raw: string;
    try {
      raw = await readFile(importPathOf(id), "utf8");
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
        owner: src === `index:${label}` ? "mine" : "foreign",
        target: raw,
      };
    }
    const parts = src.split(":");
    if (parts[1] === label && KNOWN_ADAPTERS.has(parts[0])) {
      // #245 P1: a stamp WITHOUT a relKey predates the provenance stamp, so
      // its source path is unknowable — it may belong to a source file that
      // was since renamed or removed. Treating it as this file's predecessor
      // was an overwrite on a guess, and it hit every existing user on the
      // first reimport after the update. Unknown provenance is FOREIGN: the
      // import lands beside it as a visible duplicate (Weg C) instead of
      // replacing content it cannot prove it produced.
      return {
        owner:
          parts.length >= 3 && parts.slice(2).join(":") === myKey
            ? "mine"
            : "foreign",
        target: raw,
      };
    }
    return { owner: "foreign", target: raw }; // hand-authored, index role, or another label
  };
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
  const allocateOwnedId = async (base: string, seed: string, isIndex = false): Promise<Allocation> => {
    let id = uniqueId(base, used);
    for (let guard = 0; ; guard++) {
      const check = await ownership(id, seed, isIndex);
      if (check.owner === "free" || check.owner === "mine") return { id };
      if (check.owner === "unverifiable")
        return { skip: `ownership of ${folder}/${id}.md is unverifiable (node exists but is unreadable) — refusing to overwrite` };
      if (guard >= HASH_CANDIDATES) break;
      id = uniqueId(`${base}-${pathHash(guard === 0 ? seed : `${seed}#${guard}`)}`, used);
    }
    return { skip: `no free id: "${base}" and all ${HASH_CANDIDATES} hash candidates are owned by foreign nodes` };
  };

  // #240/A10 Pass 0: mint every final id from the SOURCE PATHS first, before
  // a single body is mapped. The ids carry the relative directory now, so
  // each resolver below has to look the target up here instead of
  // recomputing `slugify(label + basename)` — that recomputation resolved
  // nested files to ids that were never minted and turned every intra-set
  // link into a ghost. Deterministic: `files` is sorted, so a genuine
  // basename collision resolves to the same winner on every run.
  // ONE allocator for the whole batch (`used`): Pass 0 and the synthetic index
  // in Pass D must draw from the same set. A separate Pass-0 set left `used`
  // empty, so a source file literally named `index.md` minted `<label>-index`
  // here and the synthetic index picked the same id and overwrote it — the
  // source note's content was gone.
  const idByBase = new Map<string, string>();
  const idByPath = new Map<string, string>();
  const relKeyByPath = new Map<string, string>();
  for (const filePath of files) {
    const relKey = relative(sourceDir, filePath).split(sep).join("/"); // POSIX provenance key
    relKeyByPath.set(filePath, relKey);
    const relDir = relative(sourceDir, filePath).split(sep).slice(0, -1).join(sep);
    const fileBase = basename(filePath, extname(filePath));
    const relSegments = relDir ? relDir.split(sep).filter(Boolean) : [];
    const alloc = await allocateOwnedId(slugify([label, ...relSegments, fileBase].join("-")), relKey);
    if (alloc.skip !== undefined) {
      // #245: no id could be cleared for this file. Skipping is VISIBLE — the
      // caller surfaces skipped[] — where the old behaviour was a silent
      // overwrite of somebody else's node.
      skipped.push({ path: filePath, reason: alloc.skip });
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

  // Pass A: every namespaced id that SOME body links to — the inbound-veto set
  // (Finding #2). A hub OTHERS point at is a real target, not a throwaway index.
  /** #240/A10: retired legacy nodes. Weg C: always empty (see above). */
  const migrated: Array<{ from: string; to: string }> = [];
  const referenced = new Set<string>();
  for (const raw of rawByFile.values()) {
    const { content } = safeParse(raw);
    for (const x of extractWikilinks(content)) {
      const id = idByBase.get(linkKey(x) ?? x) ?? safeSlug(`${label}-${x}`);
      if (id) referenced.add(id);
    }
  }

  // Pass B: harvest the index/hubs into section + description structure
  // (Finding #5). The root MEMORY.md is read explicitly — the walker skips it —
  // plus any file recognized as a link hub inside the set.
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
  const harvest = harvestIndex(indexSources);

  // Pass C: map + save. Weg C — imports write ids and never trash anything, so
  // a pre-A10 twin simply stays active alongside the new node (see above).
  for (const filePath of files) {
    const raw = rawByFile.get(filePath);
    if (raw === undefined) continue; // unreadable — already recorded in skipped
    const relDir = relative(sourceDir, filePath).split(sep).slice(0, -1).join(sep);
    const fileBase = basename(filePath, extname(filePath));
    const selfId = idByPath.get(filePath);
    if (selfId === undefined) continue; // not part of the minted set
    const relKey = relKeyByPath.get(filePath) ?? relative(sourceDir, filePath).split(sep).join("/");
    const mapped = mapFile(fileBase, raw, { label, folder, relDir, relKey, overwrite, used, referenced, harvest, idByBase, selfId });
    if (!mapped.ok) {
      skipped.push({ path: filePath, reason: mapped.reason });
      continue;
    }
    let expectedTarget: string | null = null;
    if (!dryRun) {
      // #245 P1 (TOCTOU): the id was cleared back in Pass 0, and Pass C runs
      // much later — long enough for another writer to land a node on it.
      // #285 closes the remaining check→commit window: pass the exact raw
      // preimage into saveMemory's ownership-aware commit.
      const check = await ownership(mapped.input.id as string, relKey, false);
      if (check.owner !== "free" && check.owner !== "mine") {
        skipped.push({
          path: filePath,
          reason: `ownership of ${folder}/${mapped.input.id}.md changed after the id was minted (${check.owner}) — refusing to overwrite`,
        });
        continue;
      }
      expectedTarget = check.target;
    }
    if (!dryRun) {
      try {
        await saveMemoryWithAuditTrail({
          vaultRoot,
          input: mapped.input,
          actor: "import",
          actorDetail: "import:vault",
          sessionId: runId,
          commit: { expectedTarget, locator: vaultIds },
        });
      } catch (err) {
        // `recordAudit` absorbs audit-only failures. Reaching this catch means
        // target resolution or the memory write itself failed, so `skipped`
        // remains an honest list of content that did not land.
        skipped.push({ path: filePath, reason: `save failed: ${(err as Error).message}` });
        continue;
      }
    }
    // #365/7: erst zählen, wenn der Save wirklich gelandet ist. Vorher stand das
    // Inkrement VOR dem Write — ein nicht beschreibbarer Vault meldete
    // `byAdapter.generic: 80` neben `imported: 0, ids: []` und brach damit genau
    // die Invariante, die der Header dieser Datei zusichert. Der Dry-Run bleibt
    // unberührt: ohne Write gibt es kein Fehler-`continue`, und der
    // Ownership-Check darüber ist per `if (!dryRun)` ohnehin übersprungen — eine
    // gemappte Datei erreicht diese Zeile im Dry-Run wie zuvor. Pass D unten
    // zählt bereits nach demselben Muster.
    if (mapped.input.source?.startsWith("claude-code-memory")) byAdapter.claudeCode++;
    else byAdapter.generic++;
    ids.push(mapped.input.id as string);
  }

  // Pass D: the curated index as ONE navigation node (Finding #5). Native CC
  // memory keeps its only connective tissue in MEMORY.md; rather than discard
  // it, mint a single reference memory whose body wikilinks EACH imported file,
  // grouped by section. Links point only at ids that actually imported, so it
  // adds edges (the star that ties the islands together), never ghosts.
  let indexNode: string | null = null;
  // #312: the dry-run runs this pass too. Everything up to the write is pure
  // computation over the already-read sources, and the pass mints a node that
  // counts in `imported` — skipping it made the preview predict one node fewer
  // than the run it previews, which is the one thing a preview must not do.
  if (harvest.size > 0 && ids.length > 0) {
    const importedIds = new Set(ids);
    const bySection = new Map<string, string[]>(); // section → wikilink ids, in index order
    for (const [fileBase, entry] of harvest) {
      const linkId = idByBase.get(linkKey(fileBase) ?? fileBase) ?? safeSlug(`${label}-${fileBase}`);
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
    if (linkCount > 0) {
      // Role-scoped ownership: the synthetic index may only overwrite a node
      // that is itself `source: index:<label>` — never a foreign node that
      // happens to sit on the `-index`/`-index-2` fallback id (#240 P1-b).
      const indexSeed = `index:${label}`;
      const alloc = await allocateOwnedId(slugify(`${label}-index`), indexSeed, true);
      const sectionCount = [...bySection.keys()].filter((s) => s.length > 0).length;
      // #245 P2: if no id could be cleared, the index is simply not written.
      // It is navigation, not content — the notes themselves already imported,
      // and no foreign node is worth a nav star.
      const indexCheck =
        alloc.id === undefined
          ? ({ owner: "foreign", target: "" } as const)
          : await ownership(alloc.id, indexSeed, true); // #245 P1: TOCTOU re-check
      if (
        alloc.id !== undefined &&
        (indexCheck.owner === "free" || indexCheck.owner === "mine")
      ) {
        const id = alloc.id;
        // A dry-run has nothing to write, so nothing can fail — it lands by
        // definition; a real run only lands if the write returns.
        let landed = dryRun;
        if (!dryRun) {
          try {
            await saveMemoryWithAuditTrail({
              vaultRoot,
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
                overwrite,
                source: `index:${label}`,
              },
              actor: "import",
              actorDetail: "import:vault",
              sessionId: runId,
              commit: { expectedTarget: indexCheck.target, locator: vaultIds },
            });
            landed = true;
          } catch {
            // Audit-only failures were already absorbed by `recordAudit`.
            // A routing/write failure here still cannot fail the imported notes:
            // the synthetic index is navigation and remains best-effort.
          }
        }
        if (landed) {
          ids.push(id);
          indexNode = id;
          // #312: it goes into `ids`, so it must go into the breakdown in the
          // same breath — an id counted in the total but in no category is the
          // itemisation contradicting the number above it.
          byAdapter.index++;
        }
      }
    }
  }

  if (!dryRun && ids.length > 0) {
    // Fix-Leiter Stufe 3 (zzallirog): ein Marker im Import-Subtree, damit
    // FREMDE Tools auf dem geteilten Ordner (Atlas, Indexer, grep) das Set
    // als maschinell erzeugte Kopie erkennen und überspringen können. Kein
    // .md — der Vault-Loader ignoriert die Datei.
    try {
      const markerDir = join(vaultRoot, folder);
      await mkdir(markerDir, { recursive: true });
      await writeFile(
        join(markerDir, ".bastra-imported"),
        JSON.stringify(
          {
            tool: "bastra-recall import vault",
            label,
            source: srcReal,
            imported: ids.length,
            at: new Date().toISOString(),
            note: "Machine-imported copy of an external folder — safe for external tools to skip.",
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
    } catch {
      /* marker is best-effort — never fail an import over it */
    }
  }

  return {
    sourceDir,
    label,
    folder,
    scope: label,
    scanned: files.length,
    imported: ids.length,
    byAdapter,
    skipped,
    ids,
    indexNode,
    migrated,
    dryRun,
  };
}

export interface FsBrowseEntry {
  name: string;
  path: string;
  /** Number of markdown files directly inside — a quick "is this a vault?" cue. */
  md: number;
}

/**
 * Subdirectories of `dir`, for the map's folder picker. Directories only —
 * never file names, never file contents. Dot-directories are included (the
 * common import source `~/.claude/projects/<x>/memory` lives behind one) but
 * sorted after the visible ones; node_modules is dropped.
 */
export async function listSubdirs(dir: string): Promise<{ path: string; parent: string | null; dirs: FsBrowseEntry[] }> {
  const abs = resolve(dir);
  const entries = await readdir(abs, { withFileTypes: true });
  const dirs: FsBrowseEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name === "node_modules") continue;
    const full = join(abs, e.name);
    let md = 0;
    try {
      md = (await readdir(full)).filter((n) => n.toLowerCase().endsWith(".md")).length;
    } catch {
      // unreadable subdir — still listed, just without the count
    }
    dirs.push({ name: e.name, path: full, md });
  }
  dirs.sort((a, b) => {
    const da = a.name.startsWith(".") ? 1 : 0;
    const db = b.name.startsWith(".") ? 1 : 0;
    return da - db || a.name.localeCompare(b.name);
  });
  const parent = dirname(abs);
  return { path: abs, parent: parent === abs ? null : parent, dirs };
}

/**
 * GET /ui/fs?path=<abs> — the folder picker's data source. Directory names
 * only, loopback + ui-gated like the rest of /ui (same trust boundary as the
 * import itself, which reads arbitrary local folders). Defaults to $HOME.
 */
export async function handleUiFsBrowse(
  req: IncomingMessage,
  res: ServerResponse,
  settingsPath?: string,
): Promise<void> {
  if (!(await getUiEnabled(settingsPath))) {
    sendJsonPlain(res, 404, { error: "ui disabled" });
    return;
  }
  const u = new URL(req.url ?? "/", "http://127.0.0.1");
  const raw = u.searchParams.get("path");
  const dir = raw && raw.trim().length > 0 ? raw.trim() : homedir();
  if (!isAbsolute(dir)) {
    sendJsonPlain(res, 400, { error: "path must be absolute" });
    return;
  }
  try {
    sendJsonPlain(res, 200, await listSubdirs(dir));
  } catch (err) {
    sendJsonPlain(res, 400, { error: (err as Error).message });
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
  settingsPath?: string,
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
    result = await importVault(vaultPath, dir, { label, dryRun: body.dryRun === true });
  } catch (err) {
    sendJsonPlain(res, 400, { error: (err as Error).message });
    return;
  }
  if (!result.dryRun && result.imported > 0 && onIndexed) {
    await onIndexed().catch(() => {});
  }
  sendJsonPlain(res, 200, {
    imported: result.imported,
    scanned: result.scanned,
    folder: result.folder,
    scope: result.scope,
    by_adapter: result.byAdapter,
    skipped: result.skipped.length,
    dry_run: result.dryRun,
  });
}
