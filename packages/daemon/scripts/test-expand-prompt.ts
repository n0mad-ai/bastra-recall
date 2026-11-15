/**
 * READ-ONLY test of the sharpened doc2query prompt (#117). For a sample of real
 * memories it regenerates expansions with qwen2.5:3b and prints OLD (slug-ish,
 * from the file) vs NEW (sharpened prompt) side by side. Writes nothing.
 *
 * Usage: BASTRA_VAULT_PATH=… SAMPLE_N=8 tsx scripts/test-expand-prompt.ts
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { buildExpandPrompt, parseExpansions } from "@bastra-recall/core";
import type { Memory } from "@bastra-recall/core";
import { ollamaChat } from "../src/learned-recall/reranker.js";

const VAULT = process.env.BASTRA_VAULT_PATH;
const N = parseInt(process.env.SAMPLE_N ?? "8", 10);
const MODEL = process.env.BASTRA_EXPAND_MODEL ?? "qwen2.5:3b";

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".md")) yield p;
  }
}

async function main(): Promise<void> {
  if (!VAULT) {
    process.stderr.write("set BASTRA_VAULT_PATH\n");
    process.exit(2);
  }
  const chat = ollamaChat({ model: MODEL, timeoutMs: 60_000 });

  const files: string[] = [];
  for await (const f of walk(join(VAULT, "memories"))) files.push(f);
  // deterministic spread across the list
  const step = Math.max(1, Math.floor(files.length / N));
  const sample = files.filter((_, i) => i % step === 0).slice(0, N);

  for (const f of sample) {
    const { data } = matter(await readFile(f, "utf8"));
    const fm = data as Record<string, unknown>;
    const recall_when = Array.isArray(fm.recall_when) ? (fm.recall_when as string[]) : [];
    if (!fm.title || !fm.summary || recall_when.length === 0) continue;
    const m = { fm: { title: fm.title, summary: fm.summary, recall_when } } as unknown as Memory;
    const oldExp = Array.isArray(fm.recall_when_expanded) ? (fm.recall_when_expanded as string[]) : [];

    let raw = "";
    try {
      raw = await chat(buildExpandPrompt(m));
    } catch (e) {
      raw = `<chat error: ${(e as Error).message}>`;
    }
    const fresh = parseExpansions(raw, recall_when, 5);

    process.stdout.write(`\n● ${String(fm.title).slice(0, 70)}\n`);
    process.stdout.write(`  triggers: ${recall_when.slice(0, 3).join(" | ")}\n`);
    process.stdout.write(`  OLD (qwen3-vl/slug): ${oldExp.length ? oldExp.join(" · ") : "(empty)"}\n`);
    process.stdout.write(`  NEW (sharpened):     ${fresh.length ? fresh.join(" · ") : "(empty)"}\n`);
  }
  process.stdout.write("\n[done — nothing written to any memory]\n");
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
