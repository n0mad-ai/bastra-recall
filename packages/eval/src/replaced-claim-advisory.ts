/**
 * #643 — how often the "re-asserts a replaced claim" advisory is right.
 *
 * The advisory lives in `daemon/src/save-quality.ts` (`replacedClaimAdvisory`).
 * The issue names two numbers: warning precision/recall on replaced claims that
 * get saved again, and the false-warning rate on ordinary saves (target < 2%).
 *
 * The corpus is invented (`fixtures/replaced-claim-advisory.json`): correction
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
 *    its own — the advisory cannot tell old and new values apart.
 *  - `fresh-*`: NEW saves that replace nothing (unrelated, same topic, near
 *    duplicate of a living memory).
 *  - `overwrite`: `save_memory(overwrite)` of every non-superseded memory.
 *  - `edit`: `edit_memory(append)` of every non-superseded memory, undone again.
 * Every non-positive probe that warns is a false warning. New saves use
 * `dry_run`, so they leave the temporary vault unchanged.
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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";

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

const daemonDist = new URL("../../daemon/dist/", import.meta.url);
const load = async <T>(file: string): Promise<T> => (await import(new URL(file, daemonDist).href)) as T;
const { saveMemoryHandler } = await load<{ saveMemoryHandler: Handler }>("save-memory-handler.js");
const { editMemoryHandler } = await load<{ editMemoryHandler: Handler }>("edit-memory-handler.js");
const { Telemetry } = await load<{ Telemetry: new () => unknown }>("telemetry.js");

const fixture = new URL("../fixtures/replaced-claim-advisory.json", import.meta.url);
const corpus = JSON.parse(readFileSync(fixture, "utf8")) as Corpus;
const hash = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== "--out") throw new Error("usage: --out <artifact>");

const ISSUE_PREFIX = "re-asserts a replaced claim: ";
/** `<matched> (similarity <n>) was superseded by <direct>[ (current version: <head>)]` —
 *  the advisory's own wording. `successor` is the version it tells the author to load. */
function advisory(q: Quality | undefined): { matched: string; successor: string } | undefined {
  const issue = q?.issues.find((i) => i.startsWith(ISSUE_PREFIX));
  if (issue === undefined) return undefined;
  const m = issue.match(
    /^re-asserts a replaced claim: (\S+) \(similarity [\d.]+\) was superseded by (\S+?)(?: \(current version: (\S+)\))?$/
  );
  if (!m) throw new Error(`unparsed advisory: ${issue}`);
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
  for (const c of corpus.chains) {
    const ids: string[] = [];
    for (const [i, v] of c.versions.entries()) {
      ids.push(await mustCreate(save(c, v, { id: `${c.id}-v${i + 1}`, ...(i ? { replaces: ids[i - 1] } : {}) })));
    }
    for (const id of ids.slice(0, -1)) {
      if (typeof vault.get(id)?.fm.superseded_by !== "string") throw new Error(`${id}: superseded_by not stamped`);
    }
    chainIds.set(c.id, ids);
  }
  const livingIds: Array<{ id: string; language: string }> = [];
  for (const [i, l] of corpus.living.entries()) {
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
  for (const c of corpus.chains) {
    const ids = chainIds.get(c.id) ?? [];
    record("reassert-paraphrase", c.language, ids[0], true, await dry(c, c.reassert, `${c.id}-probe-paraphrase`));
    const verbatim = { ...c.versions[0], trigger: c.reassert.trigger };
    record("reassert-verbatim", c.language, ids[0], true, await dry(c, verbatim, `${c.id}-probe-verbatim`));
    const head = { ...c.versions.at(-1)!, trigger: c.reassert.trigger };
    record("agrees-with-correction", c.language, ids.at(-1)!, false, await dry(c, head, `${c.id}-probe-agree`));
  }
  for (const [i, f] of corpus.fresh.entries()) {
    record(`fresh-${f.kind}`, f.language, `fresh-${i + 1}`, false, await dry(f, f, `fresh-${i + 1}`));
  }

  // ── Changes to existing memories: every memory nobody superseded.
  const current = [
    ...corpus.chains.map((c) => ({ id: chainIds.get(c.id)!.at(-1)!, language: c.language })),
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
await writeFile(argv[1], JSON.stringify(result, null, 2) + "\n");
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
