/**
 * #643 — how often the "re-asserts a replaced claim" advisory is right.
 *
 * The advisory lives in `daemon/src/save-quality.ts` (`replacedClaimAdvisory`).
 * The issue names two numbers: warning precision/recall on replaced claims that
 * get saved again, and the false-warning rate on ordinary saves (target < 2%).
 *
 * Default fixture mode: the corpus is invented (`fixtures/replaced-claim-advisory.json`): correction
 * chains of two and three versions in English and German, living neighbours in
 * the same scopes, and fresh saves. The vault is BUILT through the production
 * `saveMemoryHandler`, so `superseded_by` is stamped by the real `replaces`
 * path, inside a temporary directory that is removed afterwards. No real vault,
 * no daemon, no network. There is no random draw: the corpus order is the only
 * order, so a rerun on the same commit reproduces `verdict_sha256`.
 *
 * Probes, all through the production handlers:
 *  - `reassert-paraphrase` / `reassert-verbatim` (positive): a NEW save of the
 *    first version's claim. Correct = an advisory naming a chain member.
 *  - `agrees-with-correction`: a NEW save restating the chain head. Reported on
 *    its own. The advisory stays silent when the save repeats the current
 *    claim text (`restatesCurrent`).
 *  - `fresh-*`: NEW saves that replace nothing (unrelated, same topic, near
 *    duplicate of a living memory).
 *  - `overwrite`: `save_memory(overwrite)` of every non-superseded memory.
 *  - `edit`: `edit_memory(append)` of every non-superseded memory, undone again.
 * Every non-positive probe that warns is a false warning. New saves use
 * `dry_run`, so they leave the temporary vault unchanged.
 *
 * Existing-copy mode: --vault-copy <private-temp-root>/vault --out <private-temp-root>/aggregate.json
 * reads a pre-existing physical Markdown copy, uses isolated host state, and
 * reports replay/routing aggregates without semantic gold labels.
 *
 * Requires the daemon build (`npm run build -w @bastra-recall/daemon`); the
 * handlers are read from `daemon/dist`, as in `trigger-collisions.ts`.
 *
 *   node --import tsx --import ./scripts/test-env.mjs \
 *     packages/eval/src/replaced-claim-advisory.ts --out <artifact.json>
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Memory } from "@bastra-recall/core";

interface Memo {
  title: string;
  summary: string;
  trigger: string;
}
interface Shelf {
  language: string;
  scope: string;
  type: string;
  topic_path: string[];
  tags: string[];
}
interface Chain extends Shelf {
  id: string;
  versions: Memo[];
  reassert: Memo;
}
type Living = Shelf & Memo;
type Fresh = Living & { kind: string };
interface Corpus {
  chains: Chain[];
  living: Living[];
  fresh: Fresh[];
}
interface Quality {
  issues: string[];
}
type Handler = (deps: unknown, args: unknown) => Promise<{ save_quality?: Quality; created?: boolean; id?: string }>;

// Validate before importing core/daemon: their module singletons can bind host state.
const argv = process.argv.slice(2);
const cli = new Map<string, string>();
for (let i = 0; i < argv.length; i += 2) {
  const key = argv[i];
  if (!["--out", "--vault-copy"].includes(key) || cli.has(key) || !argv[i + 1] || argv[i + 1].startsWith("--")) {
    console.error("EVAL643_INVALID_ARGUMENTS");
    process.exit(1);
  }
  cli.set(key, argv[i + 1]);
}
if (!cli.has("--out")) {
  console.error("EVAL643_INVALID_ARGUMENTS");
  process.exit(1);
}
const copyInput = cli.get("--vault-copy");
const output = cli.get("--out")!;
const inside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};
const fail = (): never => {
  throw new Error("EVAL643_COPY_ISOLATION");
};
const hash = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
let copyFiles = 0;
let copyDigest = "";
let suppressedDiagnostics = 0;
const publicLog = console.log.bind(console);
if (copyInput) {
  // Handler diagnostics may carry corpus text or IDs; only fixed errors/aggregates leave this process.
  console.log =
    console.warn =
    console.error =
    console.info =
    console.debug =
      () => {
        suppressedDiagnostics++;
      };
  process.on("uncaughtException", () => {
    process.stderr.write("EVAL643_COPY_FAILED\n");
    process.exit(1);
  });
  process.on("unhandledRejection", () => {
    process.stderr.write("EVAL643_COPY_FAILED\n");
    process.exit(1);
  });
  process.umask(0o077);
  const run = process.env.BASTRA_TEST_RUN_ROOT;
  if (!run || process.env.BASTRA_TEST_KEEP_ENV === "1" || !process.env.HOME) fail();
  const runRoot = await realpath(run!);
  if (!inside(runRoot, await realpath(process.env.HOME!)) || (await realpath(process.env.HOME!)) === runRoot) fail();
  // test-env clears inherited BASTRA variables. Set these AFTER preload, BEFORE imports.
  const app = join(runRoot, "eval643-app");
  await mkdir(app, { recursive: true, mode: 0o700 });
  process.env.BASTRA_DB_PATH = join(app, "recall.db");
  process.env.BASTRA_VAULT_ROOTS_PATH = join(app, "vault-roots.json");
  if (!isAbsolute(copyInput) || !isAbsolute(output)) fail();
  const parent = dirname(copyInput);
  const physicalParent = await realpath(parent);
  const tempParents = await Promise.all(["/tmp", "/private/tmp", tmpdir()].map((p) => realpath(p).catch(() => "")));
  if (
    !tempParents.some((p) => p && dirname(physicalParent) === p) ||
    !basename(parent).startsWith("bastra-eval643-copy-")
  )
    fail();
  const parentStat = await lstat(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    (parentStat.mode & 0o077) !== 0 ||
    parentStat.uid !== process.getuid?.()
  )
    fail();
  if (
    (await realpath(copyInput)) !== resolve(copyInput) ||
    (await realpath(dirname(output))) !== physicalParent ||
    inside(copyInput, output)
  )
    fail();
  if ((await lstat(output).catch(() => undefined)) !== undefined) fail();
  const digest = createHash("sha256");
  async function inspect(dir: string): Promise<void> {
    const st = await lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) fail();
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) fail();
      if (entry.isDirectory()) await inspect(path);
      else if (!entry.isFile() || entry.nlink !== 1 || !name.endsWith(".md")) fail();
      else {
        copyFiles++;
        digest.update(relative(copyInput!, path));
        digest.update(await readFile(path));
      }
    }
  }
  await inspect(copyInput);
  copyDigest = digest.digest("hex");
}
const { Vault, SearchIndex } = await import("@bastra-recall/core");
const daemonDist = new URL("../../daemon/dist/", import.meta.url);
const load = async <T>(file: string): Promise<T> => (await import(new URL(file, daemonDist).href)) as T;
const { saveMemoryHandler } = await load<{ saveMemoryHandler: Handler }>("save-memory-handler.js");
const { editMemoryHandler } = await load<{ editMemoryHandler: Handler }>("edit-memory-handler.js");
const { Telemetry } = await load<{ Telemetry: new () => unknown }>("telemetry.js");
const fixture = new URL("../fixtures/replaced-claim-advisory.json", import.meta.url);
const corpus = copyInput ? undefined : (JSON.parse(readFileSync(fixture, "utf8")) as Corpus);

const ISSUE_PREFIX = "re-asserts a replaced claim: ";
/** `<matched> (similarity <n>) was superseded by <direct>[ (current version: <head>)]` —
 *  the advisory's own wording. `successor` is the version it tells the author to load. */
function advisory(q: Quality | undefined): { matched: string; successor: string } | undefined {
  const issue = q?.issues.find((i) => i.startsWith(ISSUE_PREFIX));
  if (issue === undefined) return undefined;
  const m = issue.match(
    /^re-asserts a replaced claim: (\S+) \(similarity [\d.]+\) was superseded by (\S+?)(?: \(current version: (\S+)\))?$/
  );
  if (!m) throw new Error("EVAL643_ADVISORY_FORMAT");
  return { matched: m[1], successor: m[3] ?? m[2] };
}

const save = (shelf: Shelf, memo: Memo, extra: Record<string, unknown> = {}) => ({
  title: memo.title,
  type: shelf.type,
  summary: memo.summary,
  body: memo.summary,
  topic_path: shelf.topic_path,
  tags: shelf.tags,
  scope: shelf.scope,
  recall_when: [memo.trigger],
  ...extra,
});

interface Row {
  probe: string;
  language: string;
  target: string;
  positive: boolean;
  warned: boolean;
  matched: string | null;
  named: string | null;
  names_chain_member: boolean;
  names_head: boolean;
}

// Existing-copy mode deliberately has no semantic labels or precision/recall.
if (copyInput) {
  const vault = new Vault(copyInput);
  let search: InstanceType<typeof SearchIndex> | undefined;
  try {
    const init = await vault.init();
    search = new SearchIndex(vault); // lexical BM25 + field Jaccard; no embedding provider
    search.start();
    const deps = { vault, search, telemetry: new Telemetry(), vaultPath: copyInput };
    const memories = vault.list().sort((a, b) => a.fm.id.localeCompare(b.fm.id));
    const inventory = {
      markdown_files: copyFiles,
      loaded: init.loaded,
      skipped: init.skipped.length,
      unindexed_markdown: copyFiles - init.loaded,
      unreadable: vault.scanBlindSpots().length,
      duplicate_ids: memories.filter((m) => vault.pathsFor(m.fm.id).length > 1).length,
      private_memories: memories.filter((m) => m.fm.sensitivity === "private").length,
      superseded: 0,
      complete_predecessor_paths: 0,
      distinct_chain_heads: 0,
      missing_targets: 0,
      cycles: 0,
      private_chains: 0,
    };
    type Probe = {
      candidates: number;
      eligible: number;
      attempted: number;
      executed: number;
      rejected: number;
      failed: number;
      quality_missing: number;
      warnings: number;
      names_chain_member: number;
      names_head: number;
    };
    const blank = (): Probe => ({
      candidates: 0,
      eligible: 0,
      attempted: 0,
      executed: 0,
      rejected: 0,
      failed: 0,
      quality_missing: 0,
      warnings: 0,
      names_chain_member: 0,
      names_head: 0,
    });
    const chainHeads = new Set<string>();
    const probes = { predecessor_replay: blank(), head_restatement: blank(), overwrite: blank(), edit: blank() };
    const head = (start: Memory): Memory[] | undefined => {
      const chain: Memory[] = [],
        seen = new Set<string>();
      let current: Memory | undefined = start;
      while (current) {
        if (seen.has(current.fm.id)) {
          inventory.cycles++;
          return undefined;
        }
        seen.add(current.fm.id);
        chain.push(current);
        if (current.fm.sensitivity === "private") {
          inventory.private_chains++;
          return undefined;
        }
        if (!current.fm.superseded_by) return chain;
        current = vault.get(current.fm.superseded_by);
        if (!current) {
          inventory.missing_targets++;
          return undefined;
        }
      }
      return undefined;
    };
    const args = (m: Memory) => ({
      title: m.fm.title,
      summary: m.fm.summary,
      body: m.body,
      type: m.fm.type,
      scope: m.fm.scope,
      tags: m.fm.tags,
      topic_path: m.fm.topic_path,
      recall_when: m.fm.recall_when,
    });
    let serial = 0;
    const run = async (p: Probe, action: () => ReturnType<Handler>, chain: Memory[] = []): Promise<void> => {
      p.eligible++;
      p.attempted++;
      try {
        const response = await action();
        p.executed++;
        if (!response.save_quality) p.quality_missing++;
        if ((response as { error?: unknown }).error || "claim_gate" in response) p.rejected++;
        const a = advisory(response.save_quality);
        if (a) {
          p.warnings++;
          if (chain.some((m) => m.fm.id === a.successor)) p.names_chain_member++;
          if (chain.at(-1)?.fm.id === a.successor) p.names_head++;
        }
      } catch {
        p.failed++;
      }
    };
    // Never invent links, paraphrases, languages, negatives or gold labels from stored text.
    for (const m of memories) {
      if (!m.fm.superseded_by) continue;
      inventory.superseded++;
      probes.predecessor_replay.candidates++;
      probes.head_restatement.candidates++;
      const chain = head(m);
      if (!chain || chain.some((m) => vault.pathsFor(m.fm.id).length !== 1)) continue;
      inventory.complete_predecessor_paths++;
      chainHeads.add(chain.at(-1)!.fm.id);
      const dry = (memo: Memory) =>
        saveMemoryHandler(deps, { ...args(memo), id: `eval643-copy-probe-${++serial}`, dry_run: true });
      await run(probes.predecessor_replay, () => dry(m), chain);
      await run(probes.head_restatement, () => dry(chain.at(-1)!), chain);
    }
    for (const m of memories) {
      if (m.fm.superseded_by) continue;
      probes.overwrite.candidates++;
      probes.edit.candidates++;
      if (m.fm.sensitivity === "private" || vault.pathsFor(m.fm.id).length !== 1) continue;
      await run(probes.overwrite, () =>
        saveMemoryHandler(deps, { ...args(m), id: m.fm.id, overwrite: true, dry_run: true })
      );
      // Restore exact bytes even when append/quality fails. AppDB/audit effects stay in this copy's isolated run.
      const bytes = await readFile(m.filePath);
      try {
        await run(probes.edit, () =>
          editMemoryHandler(deps, { id: m.fm.id, append: "\n\nReviewed for the measurement." })
        );
      } finally {
        await writeFile(m.filePath, bytes);
        await vault.reindexFile(m.filePath);
      }
    }
    inventory.distinct_chain_heads = chainHeads.size;
    const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 1e6) / 1e6 : null);
    const result = {
      schema_version: 2,
      issue: 643,
      corpus_mode: "existing-copy",
      retrieval: "lexical-only BM25 / weighted field Jaccard; no embedding provider",
      code_sha256: hash(readFileSync(new URL(import.meta.url))),
      copy_snapshot_sha256: copyDigest,
      engine: {
        repo_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8" }).trim(),
        repo_dirty:
          execFileSync("git", ["status", "--porcelain"], { cwd: import.meta.dirname, encoding: "utf8" }).trim().length >
          0,
        daemon_save_quality_sha256: hash(readFileSync(new URL("save-quality.js", daemonDist))),
        daemon_save_handler_sha256: hash(readFileSync(new URL("save-memory-handler.js", daemonDist))),
        daemon_edit_handler_sha256: hash(readFileSync(new URL("edit-memory-handler.js", daemonDist))),
        core_index_sha256: hash(readFileSync(new URL("../../core/dist/index.js", import.meta.url))),
      },
      inventory,
      coverage_limited: copyFiles !== init.loaded || init.skipped.length > 0 || inventory.unreadable > 0,
      probes: Object.fromEntries(
        Object.entries(probes).map(([k, p]) => [
          k,
          {
            ...p,
            skipped: p.candidates - p.eligible,
            quality_scored: p.executed - p.quality_missing,
            warning_frequency: ratio(p.warnings, p.executed),
            structural_head_routing: ratio(p.names_head, p.warnings),
          },
        ])
      ),
      suppressed_diagnostics: suppressedDiagnostics,
      limits: [
        "Existing stored text replayed as artificial new input; warning frequency is not a false-warning rate.",
        "Unlabelled corpus: semantic precision and recall are unmeasured; no language/paraphrase claim.",
        "Chain routing is structural evidence only, restricted to explicit complete accessible superseded_by links.",
        "Physical copy is a per-file snapshot, not an atomic snapshot of concurrent owner writes.",
        "Skipped/unindexed files and rejected/missing-quality probes limit coverage; hybrid retrieval is unmeasured.",
      ],
    };
    await writeFile(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    publicLog(JSON.stringify(result));
  } finally {
    search?.stop();
    await vault.stop();
  }
} else {
  const root = await mkdtemp(join(tmpdir(), "replaced-claim-advisory-"));
  const rows: Row[] = [];
  try {
    const vault = new Vault(root);
    await vault.init();
    const search = new SearchIndex(vault);
    search.start();
    const deps = { vault, search, telemetry: new Telemetry(), vaultPath: root };
    const mustCreate = async (args: Record<string, unknown>): Promise<string> => {
      const r = await saveMemoryHandler(deps, args);
      if (r.created !== true || typeof r.id !== "string") throw new Error(`fixture save held: ${String(args.title)}`);
      return r.id;
    };

    // ── Build the vault: chains through `replaces`, then the living neighbours.
    const chainIds = new Map<string, string[]>();
    for (const c of corpus!.chains) {
      const ids: string[] = [];
      for (const [i, v] of c.versions.entries()) {
        ids.push(await mustCreate(save(c, v, { id: `${c.id}-v${i + 1}`, ...(i ? { replaces: ids[i - 1] } : {}) })));
      }
      if (ids.slice(0, -1).some((id) => typeof vault.get(id)?.fm.superseded_by !== "string")) {
        throw new Error("fixture predecessor link not stamped");
      }
      chainIds.set(c.id, ids);
    }
    const livingIds: Array<{ id: string; language: string }> = [];
    for (const [i, l] of corpus!.living.entries()) {
      livingIds.push({ id: await mustCreate(save(l, l, { id: `living-${i + 1}` })), language: l.language });
    }

    const record = (probe: string, language: string, target: string, positive: boolean, q?: Quality): void => {
      const a = advisory(q);
      const chain = [...chainIds.values()].find((ids) => ids.includes(target)) ?? [];
      rows.push({
        probe,
        language,
        target,
        positive,
        warned: a !== undefined,
        matched: a?.matched ?? null,
        named: a?.successor ?? null,
        names_chain_member: a !== undefined && chain.includes(a.successor),
        names_head: a !== undefined && chain.at(-1) === a.successor,
      });
    };
    const dry = async (shelf: Shelf, memo: Memo, id: string): Promise<Quality | undefined> =>
      (await saveMemoryHandler(deps, save(shelf, memo, { id, dry_run: true }))).save_quality;

    // ── New saves (dry_run: nothing lands).
    for (const c of corpus!.chains) {
      const ids = chainIds.get(c.id) ?? [];
      record("reassert-paraphrase", c.language, ids[0], true, await dry(c, c.reassert, `${c.id}-probe-paraphrase`));
      const verbatim = { ...c.versions[0], trigger: c.reassert.trigger };
      record("reassert-verbatim", c.language, ids[0], true, await dry(c, verbatim, `${c.id}-probe-verbatim`));
      const head = { ...c.versions.at(-1)!, trigger: c.reassert.trigger };
      record("agrees-with-correction", c.language, ids.at(-1)!, false, await dry(c, head, `${c.id}-probe-agree`));
    }
    for (const [i, f] of corpus!.fresh.entries()) {
      record(`fresh-${f.kind}`, f.language, `fresh-${i + 1}`, false, await dry(f, f, `fresh-${i + 1}`));
    }

    // ── Changes to existing memories: every memory nobody superseded.
    const current = [
      ...corpus!.chains.map((c) => ({ id: chainIds.get(c.id)!.at(-1)!, language: c.language })),
      ...livingIds,
    ];
    for (const { id, language } of current) {
      const fm = vault.get(id)!.fm;
      const memo = { title: fm.title, summary: fm.summary, trigger: fm.recall_when[0] };
      const shelf = { language, scope: fm.scope, type: fm.type, topic_path: fm.topic_path, tags: fm.tags };
      const over = await saveMemoryHandler(deps, save(shelf, memo, { id, overwrite: true, dry_run: true }));
      record("overwrite", language, id, false, over.save_quality);
      const note = "\n\nReviewed for the measurement.";
      const edited = await editMemoryHandler(deps, { id, append: note });
      record("edit", language, id, false, edited.save_quality);
      await editMemoryHandler(deps, { id, str_replace: { old_str: note.trim(), new_str: "" } });
    }
    search.stop();
    await vault.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const summarize = (xs: Row[]) => {
    const pos = xs.filter((r) => r.positive);
    const neg = xs.filter((r) => !r.positive);
    const tp = pos.filter((r) => r.warned && r.names_chain_member).length;
    const fp = neg.filter((r) => r.warned).length;
    const ratio = (a: number, b: number): number | null => (b === 0 ? null : Math.round((1000 * a) / b) / 1000);
    return {
      n: xs.length,
      positives: pos.length,
      true_warnings: tp,
      positives_naming_head: pos.filter((r) => r.names_head).length,
      negatives: neg.length,
      false_warnings: fp,
      precision: ratio(tp, tp + fp),
      recall: ratio(tp, pos.length),
      false_warning_rate: ratio(fp, neg.length),
    };
  };
  const by = (key: keyof Row) =>
    Object.fromEntries(
      [...new Set(rows.map((r) => String(r[key])))].map((v) => [v, summarize(rows.filter((r) => String(r[key]) === v))])
    );
  const ordinary = rows.filter((r) => !r.positive && r.probe !== "agrees-with-correction");
  const opts = { cwd: import.meta.dirname, encoding: "utf8" as const };
  const result = {
    schema_version: 1,
    issue: 643,
    harness: "replaced-claim-advisory",
    engine: {
      repo_commit: execFileSync("git", ["rev-parse", "HEAD"], opts).trim(),
      repo_dirty: execFileSync("git", ["status", "--porcelain"], opts).trim().length > 0,
    },
    corpus_sha256: hash(readFileSync(fixture)),
    code_sha256: hash(readFileSync(new URL(import.meta.url))),
    seed: "none — deterministic corpus order, no random draw",
    summary: summarize(rows),
    ordinary_saves: summarize(ordinary),
    by_probe: by("probe"),
    by_language: by("language"),
    verdict_sha256: hash(JSON.stringify(rows)),
    rows,
  };
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        engine: result.engine,
        summary: result.summary,
        ordinary_saves: result.ordinary_saves,
        by_probe: result.by_probe,
      },
      null,
      2
    )
  );
}
