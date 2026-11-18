/**
 * `bastra import` (#208/#209/#211) — stage memories from other AI tools for
 * review. Four paths, one gate:
 *   <file|->    a memory list (ChatGPT/Claude/Gemini export, free text) —
 *               staged directly into `import-review.md`
 *   <file>      a conversations.json data export — queued locally, the AI
 *               session mines it chunk-wise via `bastra import mine`
 *   rules       local instruction files (CLAUDE.md, AGENTS.md, Cursor rules)
 *   clients     Claude Code's and Codex's own memory folders (#674) —
 *               imported like `import vault`, one label per folder
 *   mine|clear  work off / discard the conversation mining queue
 * Nothing is ever auto-saved: candidates wait in `import-review.md` until
 * the session distills them WITH the user.
 */
import { open, readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  extractCandidates,
  detectSource,
  stageImport,
  ConversationExportError,
  SelfImportError,
  IMPORT_FILE,
  IMPORT_SOURCES,
  type ImportSource,
  type StageResult,
} from "../import-review.js";
import { findRulesFiles, extractRulesCandidates } from "../import-rules.js";
import { parseConversationExport, buildQueue, readNextChunk, clearQueue, queueStatus } from "../import-mining.js";
import { importVault, IMPORT_ROOT } from "../import-vault.js";
import { findClientMemoryDirs, migrateClientLabels } from "./client-memory.js";
import { IMPORT_CLI_WRITER, writeCallerStore } from "../caller-session.js";
import { resolveVault } from "./helpers.js";
import type { ParsedArgs } from "./types.js";
import { usageBlocks } from "./usage-block-words.js";
import { importWords, type ImportWords } from "./import-words.js";

/** JSON.parse peak memory is a multiple of the input — refuse absurd files
 *  instead of OOM-killing the CLI. Real exports are tens of MB. */
const MAX_IMPORT_FILE_BYTES = 256 * 1024 * 1024;

/** #313: files bastra itself writes into the vault are never import sources.
 *  import-review.md is also caught by content (SelfImportError); the others
 *  have formats a lenient parser would happily mis-stage. */
const BASTRA_OWN_FILES = new Set(["import-review.md", "vault-care.md", "report.md"]);

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

export async function cmdImport(args: ParsedArgs): Promise<number> {
  // `mine` speaks to the AI session, in the English it always had.
  if (args.surface === "mine") return cmdImportMine();
  const w = await importWords();
  if (args.surface === "rules") return cmdImportRules(args, w);
  // #1469: the two surfaces that write memories name their writer in the audit.
  if (args.surface === "vault") return writeCallerStore.run(IMPORT_CLI_WRITER, () => cmdImportVault(args, w));
  if (args.surface === "clients") return writeCallerStore.run(IMPORT_CLI_WRITER, () => cmdImportClients(args, w));
  if (args.surface === "clear") return cmdImportClear(w);

  const vault = await resolveVault({ dryRun: false, vaultPath: args.vaultPath });
  if ("error" in vault) {
    process.stderr.write(`${vault.error}\n`);
    return 1;
  }

  const fileArg = args.surface; // bastra import <file|-> [source]
  const sourceOverride = args.positional[2] ?? null;
  if (sourceOverride && !(IMPORT_SOURCES as readonly string[]).includes(sourceOverride)) {
    process.stderr.write(w.unknownSource(sourceOverride, IMPORT_SOURCES.join(", ")));
    return 2;
  }

  let raw: string;
  let fileName: string | null = null;
  if (!fileArg || fileArg === "-") {
    if (process.stdin.isTTY) {
      process.stderr.write((await usageBlocks()).import);
      return 2;
    }
    raw = await readStdin();
  } else {
    try {
      // Size-check and read on the SAME handle — a stat-then-read on the
      // path could be raced past the size cap via a file swap.
      const fh = await open(fileArg, "r");
      try {
        const info = await fh.stat();
        if (info.size > MAX_IMPORT_FILE_BYTES) {
          process.stderr.write(w.tooLarge(fileArg, Math.round(info.size / 1024 / 1024)));
          return 1;
        }
        raw = await fh.readFile({ encoding: "utf8" });
      } finally {
        await fh.close();
      }
      fileName = basename(fileArg);
    } catch (err) {
      process.stderr.write(w.cannotRead(fileArg, (err as Error).message));
      return 1;
    }
    if (BASTRA_OWN_FILES.has(fileName.toLowerCase())) {
      process.stderr.write(w.ownFile(fileName));
      return 1;
    }
  }

  let candidates: string[];
  try {
    candidates = extractCandidates(raw);
  } catch (err) {
    if (err instanceof ConversationExportError) return queueConversations(raw, w);
    if (err instanceof SelfImportError) {
      process.stderr.write(w.error(err.message));
      return 1;
    }
    throw err;
  }
  if (candidates.length === 0) {
    process.stdout.write(w.noCandidates);
    return 1;
  }

  const source = detectSource(fileName, sourceOverride);
  const result = await stageImport(vault.path, source, candidates);
  printStaged(result, source, w);
  return 0;
}

function printStaged(result: StageResult, source: ImportSource, w: ImportWords): void {
  process.stdout.write(w.staged(result.staged, IMPORT_FILE, source, result.skippedDuplicates, result.openTotal));
}

/** #211: a conversations.json landed on the P1 path — queue it for mining. */
async function queueConversations(raw: string, w: ImportWords): Promise<number> {
  const parsed = parseConversationExport(raw);
  if (!parsed) {
    process.stderr.write(w.unrecognizedJson);
    return 2;
  }
  const result = await buildQueue(parsed.conversations);
  const st = await queueStatus();
  process.stdout.write(w.queued(result.queued, result.messages, parsed.source, result.queueFile, st.remaining));
  return 0;
}

/** #209: stage local rules files through the same review gate. */
async function cmdImportRules(args: ParsedArgs, w: ImportWords): Promise<number> {
  const vault = await resolveVault({ dryRun: false, vaultPath: args.vaultPath });
  if ("error" in vault) {
    process.stderr.write(`${vault.error}\n`);
    return 1;
  }
  const files = await findRulesFiles(process.cwd());
  if (files.length === 0) {
    process.stdout.write(w.noRulesFiles);
    return 1;
  }
  const all: string[] = [];
  for (const f of files) {
    // #314: a 0 always names its reason — empty vs. no list lines vs. unreadable
    let line: string;
    try {
      const r = extractRulesCandidates(await readFile(f.path, "utf8"));
      all.push(...r.candidates);
      line = r.candidates.length > 0 ? w.candidates(r.candidates.length) : w.noCandidatesBecause(r.emptyReason);
    } catch (err) {
      line = w.unreadable((err as Error).message);
    }
    process.stdout.write(`  ${f.label} — ${line}\n`);
  }
  if (all.length === 0) {
    process.stdout.write(w.nothingToStage);
    return 1;
  }
  const result = await stageImport(vault.path, "rules", all);
  printStaged(result, "rules", w);
  return 0;
}

/**
 * #215: import a whole folder of foreign memory files (Claude Code memory
 * dir, or any markdown notes) directly — no review gate. Lands in its own
 * isolated `memories/imported/<label>/` subtree; nothing existing is touched.
 *   bastra import vault <dir> [label] [--dry-run]
 */
async function cmdImportVault(args: ParsedArgs, w: ImportWords): Promise<number> {
  const dir = args.positional[2];
  if (!dir) {
    process.stderr.write((await usageBlocks()).importVault);
    return 2;
  }
  const vault = await resolveVault({ dryRun: false, vaultPath: args.vaultPath });
  if ("error" in vault) {
    process.stderr.write(`${vault.error}\n`);
    return 1;
  }
  const label = args.positional[3];
  let result;
  try {
    result = await importVault(vault.path, dir, { label, dryRun: args.dryRun, exclude: args.exclude });
  } catch (err) {
    process.stderr.write(w.error((err as Error).message));
    return 1;
  }
  // #530: Ein zweiter, identischer Lauf meldete früher erneut „imported 7/7“,
  // obwohl er keine einzige Datei anfasste. Die Zeile trennt jetzt, was wirklich
  // passiert ist — im Dry-Run bleibt sie weg, weil ohne Write niemand weiß, was
  // ein echter Lauf vorgefunden hätte.
  const changeBreakdown = result.dryRun
    ? ""
    : `  ${w.written(result.written.created, result.written.updated, result.written.unchanged)}` +
      (result.skipped.length > 0 ? w.failed(result.skipped.length) : "") +
      `\n`;
  process.stdout.write(
    w.imported(result.dryRun, result.imported, result.scanned, result.folder, result.scope) +
      changeBreakdown +
      w.adapters(result.byAdapter.claudeCode, result.byAdapter.generic) +
      // #312: the synthetic index (#217) is part of the reported total, so it
      // has to appear here as well — otherwise the breakdown reads one short
      // of the number printed directly above it.
      (result.byAdapter.index > 0 ? w.curatedIndex(result.byAdapter.index) : "") +
      (result.skipped.length > 0 ? w.skippedCount(result.skipped.length) : "") +
      (result.orphaned.length > 0 ? w.orphanedCount(result.orphaned.length) : "") +
      `\n`
  );
  for (const s of result.skipped.slice(0, 10)) {
    process.stdout.write(w.skipped(basename(s.path), s.reason));
  }
  if (result.skipped.length > 10) {
    process.stdout.write(w.andMore(result.skipped.length - 10));
  }
  // #710: imported, but a field was fixed on the way in — say so.
  for (const warning of result.warnings.slice(0, 10)) {
    process.stdout.write(w.warning(basename(warning.path), warning.reason));
  }
  if (result.warnings.length > 10) {
    process.stdout.write(w.andMoreWarnings(result.warnings.length - 10));
  }
  // #530 follow-up: a source file that disappeared since the last import never
  // takes its memory down with it — a vanished file can be a stuck cloud sync.
  // Nothing is removed; the human decides.
  for (const o of result.orphaned.slice(0, 10)) {
    process.stdout.write(w.sourceGone(o.sourcePath, `${result.folder}/${o.id}.md`));
  }
  if (result.orphaned.length > 10) {
    process.stdout.write(w.andMoreOrphaned(result.orphaned.length - 10));
  }
  if (result.orphaned.length > 0) {
    process.stdout.write(w.nothingRemoved);
  }
  if (!result.dryRun && result.imported > 0) {
    process.stdout.write(w.indexesThem(result.folder));
  }
  return 0;
}

/**
 * #674: import the clients' own memory folders — each through `importVault`
 * under its own label, so a re-run only writes what changed (#530).
 *   bastra import clients [--dry-run]
 */
async function cmdImportClients(args: ParsedArgs, w: ImportWords): Promise<number> {
  const vault = await resolveVault({ dryRun: false, vaultPath: args.vaultPath });
  if ("error" in vault) {
    process.stderr.write(`${vault.error}\n`);
    return 1;
  }
  const dirs = await findClientMemoryDirs(vault.path);
  if (dirs.length === 0) {
    process.stdout.write(w.noClientNotes);
    return 0;
  }
  let failed = 0;
  // #885: an import under a label that carried the OS user name moves first,
  // so the re-import below finds its notes instead of writing them twice.
  // Stopped halfway, nothing is imported: the next run finishes the move.
  try {
    for (const m of await migrateClientLabels(vault.path, dirs, { dryRun: args.dryRun })) {
      const where = `${IMPORT_ROOT}/${m.from}/ → ${IMPORT_ROOT}/${m.to}/`;
      process.stdout.write(m.skipped ? w.notMoved(where, m.skipped) : w.moved(where, m.memories, args.dryRun));
      for (const f of m.left ?? []) {
        process.stdout.write(w.leftUntouched(f, `${IMPORT_ROOT}/${m.from}/`));
      }
    }
  } catch (err) {
    process.stdout.write(w.moveFailed((err as Error).message));
    return 1;
  }
  for (const d of dirs) {
    try {
      const r = await importVault(vault.path, d.dir, { label: d.label, dryRun: args.dryRun });
      const counts = r.dryRun
        ? w.wouldImport(r.imported, r.scanned)
        : w.written(r.written.created, r.written.updated, r.written.unchanged) +
          (r.skipped.length > 0 ? w.skippedCount(r.skipped.length) : "");
      process.stdout.write(`✓ ${d.client} ${d.dir} → ${r.folder}/ — ${counts}\n`);
    } catch (err) {
      failed += 1;
      process.stdout.write(`✗ ${d.client} ${d.dir}: ${(err as Error).message}\n`);
    }
  }
  if (!args.dryRun) {
    process.stdout.write(w.originalsStay);
  }
  return failed > 0 ? 1 : 0;
}

/** #211: print the next mining chunk for the AI session to distill. */
async function cmdImportMine(): Promise<number> {
  const chunk = await readNextChunk();
  if (!chunk) {
    process.stdout.write(
      "mining queue is empty — queue a data export first: bastra import <path/to/conversations.json>\n"
    );
    return 0;
  }
  process.stdout.write(
    `── import mining · ${chunk.conversations} conversation(s) in this chunk · ${chunk.remaining} remaining ──\n\n` +
      chunk.body +
      `\n\n── end of chunk ──\n` +
      `USER messages only, newest conversations first. Distill durable lessons, decisions and\n` +
      `preferences (skip one-off tasks, stale facts, code/log dumps) into one-line candidate\n` +
      `facts, then stage them for review:\n` +
      `  printf '%s\\n' "fact one" "fact two" | bastra import - ${chunk.source}\n` +
      (chunk.remaining > 0
        ? "Then run `bastra import mine` for the next chunk.\n"
        : "Queue drained — the staged candidates are distilled with the user via import-review.md.\n")
  );
  return 0;
}

async function cmdImportClear(w: ImportWords): Promise<number> {
  const st = await queueStatus();
  await clearQueue();
  process.stdout.write(st.remaining > 0 ? w.cleared(st.remaining) : w.alreadyEmpty);
  return 0;
}
