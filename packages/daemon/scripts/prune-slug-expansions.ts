#!/usr/bin/env node
/**
 * prune-slug-expansions.ts — surgical #143 fix: drop slug-chain entries from
 * existing `recall_when_expanded` arrays in the vault, keeping the good
 * paraphrases. Uses the SAME `isSlugChain` gate as the live write-time filter
 * (#145), so the existing corpus matches what new expansions get.
 *
 * Deliberately leaves `recall_when_expanded_src` untouched → the daemon does NOT
 * re-expand (no hours-long qwen3-vl backfill, no re-rolling the clean ~76%). If
 * an array becomes empty (was all slugs), the field is removed.
 *
 * Usage:
 *   tsx scripts/prune-slug-expansions.ts <dir> [--apply]
 *   (default = dry run, reports only; --apply writes, atomic temp+rename)
 */
import { readdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { isSlugChain } from "../../core/src/trigger-expand.js";

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".md")) yield p;
  }
}

type Result = { removed: number; kept: number; total: number; removedSamples: string[] };

async function prune(file: string, apply: boolean): Promise<Result | null> {
  const raw = await readFile(file, "utf8");
  const parsed = matter(raw);
  const fm = { ...(parsed.data as Record<string, unknown>) }; // copy: gray-matter caches & in-place mutation poisons it
  const exp = fm.recall_when_expanded;
  if (!Array.isArray(exp) || exp.length === 0) return null;
  const removedSamples: string[] = [];
  const kept = exp.filter((e) => {
    const slug = typeof e === "string" && isSlugChain(e);
    if (slug) removedSamples.push(e as string);
    return !slug;
  });
  const removed = exp.length - kept.length;
  if (removed === 0) return null;
  if (kept.length > 0) fm.recall_when_expanded = kept;
  else delete fm.recall_when_expanded; // all slugs → drop the field (src stays)
  if (apply) {
    const body = parsed.content.startsWith("\n") ? parsed.content : `\n${parsed.content}`;
    const out = matter.stringify(body, fm);
    const tmp = `${file}.${process.pid}.prune.tmp`;
    await writeFile(tmp, out, "utf8");
    try {
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }
  return { removed, kept: kept.length, total: exp.length, removedSamples };
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!dir) {
    process.stderr.write("usage: tsx scripts/prune-slug-expansions.ts <dir> [--apply]\n");
    process.exit(2);
  }
  let files = 0;
  let slugsRemoved = 0;
  let emptied = 0;
  const samples: string[] = [];
  for await (const f of walk(dir)) {
    const r = await prune(f, apply);
    if (!r) continue;
    files++;
    slugsRemoved += r.removed;
    if (r.kept === 0) emptied++;
    if (samples.length < 12) samples.push(...r.removedSamples.slice(0, 2));
  }
  process.stdout.write(
    `${apply ? "PRUNED" : "would prune"} ${slugsRemoved} slug entries from ${files} files (${emptied} left empty)\n`
  );
  process.stdout.write(`sample of removed slugs:\n  ${samples.slice(0, 12).join("\n  ")}\n`);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
