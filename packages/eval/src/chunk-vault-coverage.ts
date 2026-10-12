/** Read-only coverage census for #1082; no Vault init, watchers or sidecars. */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import matter from "gray-matter";
import { parseMemoryWith, stripAutoRelatedSection } from "@bastra-recall/core";
import { sourceChunks } from "./chunk-maxsim.js";
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const vault = args.get("--vault"), out = args.get("--out");
if (!vault || !out) throw new Error("require --vault <read-only-root> --out <aggregate>");
const child = relative(resolve(vault), resolve(out));
if (!child.startsWith("..")) throw new Error("output must be outside vault");
const files: string[] = [];
let unreadable = 0, symlinksSkipped = 0;
const walk = (dir: string): void => {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const path = join(dir, e.name);
      if (e.isSymbolicLink()) { symlinksSkipped++; continue; }
      if (e.isDirectory()) walk(path);
      else if (e.isFile() && e.name.endsWith(".md")) files.push(path);
    }
  } catch { unreadable++; }
};
walk(vault);
const seen = new Set<string>(), corpus = createHash("sha256");
const byType: Record<string, { n: number; multi_chunk: number; chunks: number; body_chars: number }> = {};
let duplicateIds = 0, skippedParsing = 0;
for (const file of files.sort()) {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch { unreadable++; continue; }
  corpus.update(relative(vault, file)).update("\0").update(raw);
  try {
    const m = parseMemoryWith(matter, raw, file, statSync(file).mtimeMs);
    if (seen.has(m.fm.id)) { duplicateIds++; continue; } seen.add(m.fm.id);
    const body = stripAutoRelatedSection(m.body).trimEnd(), chunks = sourceChunks(body).length;
    const row = byType[m.fm.type] ??= { n: 0, multi_chunk: 0, chunks: 0, body_chars: 0 };
    row.n++; row.multi_chunk += Number(chunks > 1); row.chunks += chunks; row.body_chars += body.length;
  } catch { skippedParsing++; }
}
const git = (args: string[]): string => execFileSync("git", args, { cwd: import.meta.dirname, encoding: "utf8" }).trim();
const result = { schema_version: 1, issue: 1082, measured_at: new Date().toISOString(),
  engine: { repo_commit: git(["rev-parse", "HEAD"]), repo_dirty: !!git(["status", "--porcelain"]) },
  code_sha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).update(readFileSync(new URL("chunk-maxsim.ts", import.meta.url))).digest("hex"),
  corpus_sha256: corpus.digest("hex"), markdown_files_seen: files.length, unique_memories: seen.size,
  duplicate_ids: duplicateIds, unreadable, symlinks_skipped: symlinksSkipped, skipped_parsing_or_nonmemory: skippedParsing,
  by_type: byType, inputs_modified: false,
  limitation: "non-doc memories include imports; authored status not independently labelled; census is size coverage, not retrieval benefit" };
writeFileSync(out, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
