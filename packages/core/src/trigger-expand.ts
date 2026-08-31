/**
 * Trigger-Expander — doc2query-style write-time trigger expansion (#117).
 *
 * The far-recall problem: `recall_when` only fires when a query reuses its
 * words. A reworded query weeks later misses on the lexical layer. A query-time
 * cross-encoder would fix it but blows the 500 ms hook budget. So we move the
 * work to write time: a local LLM paraphrases title/summary/recall_when into
 * *different* words and we index those at a lower BM25 weight. The query path
 * stays byte-identical — the cost is paid once, offline, per memory.
 *
 * Pipeline (mirrors RelatedEnricher so the two compose on the same vault):
 *   EmbeddingIndex.onEmbed(id)
 *     → source unchanged (hash match)? → no-op   [breaks the reindex→embed loop]
 *     → else: chat() generates paraphrases
 *     → self-test filter (Doc2Query--): keep only paraphrases that retrieve
 *       their own memory — drops hallucinations, keeps the valuable far ones
 *       (the self-test is semantic, injected by the daemon as recallHybrid)
 *     → rewrite frontmatter (recall_when_expanded + _src), reindexFile
 *
 * Loop-prevention: the reindex re-embeds and re-fires onEmbed, but the source
 * hash now matches, so the second pass is a no-op. No file write, no loop.
 *
 * Concurrency with RelatedEnricher: both subscribe to onEmbed and rewrite the
 * SAME file. rewriteFile re-reads the file fresh immediately before writing and
 * mutates ONLY its own fields — so neither clobbers the other's (related_via vs
 * recall_when_expanded survive each other). The LLM gen takes ~1-3 s, well after
 * the in-memory related write lands, so the fresh read sees it.
 */
import { createHash } from "node:crypto";
import type { Vault } from "./vault.js";
import { mutateMemoryFile, type MutateOutcome } from "./memory-mutate.js";
import { MEMORY_WRITE_CONFLICT } from "./save-schema.js";
import type { EmbeddingIndex } from "./embeddings.js";
import type { Memory } from "./schema.js";
import { scrubInjectedBlocks } from "./scrub.js";

/** Injected chat function: prompt in, raw model reply out (same shape the
 *  learned-recall reranker uses, so the daemon can pass `ollamaChat`). */
export type ChatFn = (prompt: string) => Promise<string>;

/** Injected self-test: does `paraphrase` retrieve `memoryId` (i.e. is it
 *  on-topic, not a hallucination)? The daemon wires this to recallHybrid so the
 *  test is semantic — a low-lexical-overlap far paraphrase still passes. */
export type SelfTestFn = (paraphrase: string, memoryId: string) => Promise<boolean>;

export interface TriggerExpanderOptions {
  chat: ChatFn;
  /** Self-test filter. Omit to keep every parsed paraphrase (not recommended —
   *  hallucinated paraphrases measurably lower recall). */
  selfTest?: SelfTestFn;
  /** Max paraphrases to keep per memory after filtering. Default 5. */
  maxPhrases?: number;
  /** Single-writer gate (cross-process), same contract as RelatedEnricher:
   *  returns false → skip the write (another process owns expansion). */
  writeGate?: () => boolean | Promise<boolean>;
  /** Run a one-shot backfill sweep over un-expanded memories on start().
   *  Default true. */
  backfillOnStart?: boolean;
}

const DEFAULT_MAX_PHRASES = 5;
/** Consecutive failed generations that stop a backfill sweep (#367). A model
 *  that cannot answer this prompt cannot answer it 900 times either — without
 *  a brake, every daemon start spends hours discovering that one call at a
 *  time. Five is past any plausible run of bad luck on individual memories. */
const MAX_CONSECUTIVE_GEN_FAILURES = 5;
/** Drop generated phrases longer than this — a paraphrase is a short query,
 *  not a sentence; long lines are usually the model narrating, not a trigger. */
const MAX_PHRASE_LEN = 80;

export class TriggerExpander {
  private detach?: () => void;
  private readonly chat: ChatFn;
  private readonly selfTest?: SelfTestFn;
  private readonly maxPhrases: number;
  private readonly writeGate?: () => boolean | Promise<boolean>;
  private readonly backfillOnStart: boolean;
  /** Guards against re-entrant expansion of the same id (onEmbed can fire again
   *  mid-generation). */
  private readonly inFlight = new Set<string>();
  /** Consecutive failed generations — an empty reply or a throwing chat (#367).
   *  Any generation that produced text resets it. Read by backfill() only;
   *  the onEmbed path has no sweep to stop. */
  private consecutiveGenFailures = 0;

  constructor(
    private readonly vault: Vault,
    private readonly embeddings: EmbeddingIndex,
    opts: TriggerExpanderOptions,
  ) {
    this.chat = opts.chat;
    this.selfTest = opts.selfTest;
    this.maxPhrases = opts.maxPhrases ?? DEFAULT_MAX_PHRASES;
    this.writeGate = opts.writeGate;
    this.backfillOnStart = opts.backfillOnStart ?? true;
  }

  start(): void {
    if (this.detach) return;
    this.detach = this.embeddings.onEmbed((id) => {
      // expand() can reject — the Ollama chat may time out / abort. Swallow it
      // here so a failed expansion never becomes an unhandled promise rejection
      // that crashes the whole daemon. (The backfill path has its own catch.)
      void this.expand(id).catch((err) => {
        // Swallowed, but not silent: an Ollama that rejects the request (an
        // older server refusing `think`, a pulled model gone) would otherwise
        // take doc2query out of service without a single line anywhere (#367).
        console.error(`[bastra.expand] generation failed: ${(err as Error).message}`);
      });
    });
    if (this.backfillOnStart) void this.backfill().catch(() => {});
  }

  stop(): void {
    this.detach?.();
    this.detach = undefined;
  }

  /**
   * One-shot sweep over memories whose source changed since their last
   * expansion (or were never expanded). Sequential — one LLM call at a time is
   * the natural throttle so the backfill doesn't hammer Ollama. Fire-and-forget
   * from start(); errors per memory are swallowed so one bad memory can't stall
   * the sweep.
   */
  async backfill(): Promise<number> {
    let expanded = 0;
    this.consecutiveGenFailures = 0;
    for (const m of this.vault.list()) {
      if (m.fm.obsolete === true) continue;
      if (sourceHash(m) === m.fm.recall_when_expanded_src) continue; // up to date
      try {
        const r = await this.expand(m.fm.id);
        if (r) expanded++;
      } catch (err) {
        // One memory's failure must not stall the whole sweep — but it must not
        // vanish either: a chat that throws every time is the shape of a broken
        // model, and the breaker below needs to see it.
        this.consecutiveGenFailures++;
        console.error(`[bastra.expand] generation failed: ${(err as Error).message}`);
      }
      // Breaker: a model that cannot answer this prompt will not answer the
      // remaining ~900 either, and the sweep runs on every daemon start (#367).
      if (this.consecutiveGenFailures >= MAX_CONSECUTIVE_GEN_FAILURES) {
        console.error(
          `[bastra.expand] backfill stopped after ${MAX_CONSECUTIVE_GEN_FAILURES} consecutive generation failures — check the generation model`,
        );
        break;
      }
    }
    return expanded;
  }

  /**
   * Generate, filter, and persist paraphrases for one memory. Returns the kept
   * phrases (possibly an empty array when the parser or the self-test dropped
   * them all — the model still answered), or null when nothing was written:
   * source unchanged, gated out, re-entrant, or the generation came back empty
   * (#367).
   */
  async expand(id: string): Promise<string[] | null> {
    const memory = this.vault.get(id);
    if (!memory) return null;

    const srcHash = sourceHash(memory);
    // Source unchanged since last expansion → nothing to do. This is also what
    // breaks the reindex→re-embed→onEmbed loop after we write.
    if (srcHash === memory.fm.recall_when_expanded_src) return null;

    if (this.inFlight.has(id)) return null;
    this.inFlight.add(id);
    try {
      const raw = await this.chat(buildExpandPrompt(memory));

      // The model returned nothing at all — a failed generation, not an empty
      // answer. A thinking model puts its whole reply in `message.thinking` and
      // leaves `content` empty, which reaches us as "" (#367). Stamping that
      // against an unchanged source would freeze the failure: neither expand()
      // nor backfill() revisits a matching hash, so the memory would keep an
      // empty expansion until its author edits it. Refuse the write instead.
      //
      // Keyed on the RAW reply, deliberately, not on the parse result. Text
      // that parses to nothing — the model echoed the existing triggers, or
      // wrote only over-long lines — is a real answer *for this source*, and
      // gets the stamp below like any other. Generation here is deterministic
      // (temperature 0, same prompt), so retrying that case would regenerate
      // the identical nothing on every sweep, forever.
      if (raw.trim().length === 0) {
        this.consecutiveGenFailures++;
        console.error(`[bastra.expand] empty generation for ${id} — not written, will retry`);
        return null;
      }
      this.consecutiveGenFailures = 0;

      const candidates = parseExpansions(raw, memory.fm.recall_when, this.maxPhrases);
      const kept: string[] = [];
      for (const phrase of candidates) {
        if (this.selfTest && !(await this.selfTest(phrase, id))) continue;
        kept.push(phrase);
      }

      // Persist even when kept is empty: the model DID answer, so writing the
      // src hash marks "we tried, source is X" and we don't regenerate this same
      // source on every embed. Empty here means the parser or the self-test
      // dropped everything — the failed-generation case returned above.
      if (this.writeGate && !(await this.writeGate())) return null;
      const outcome = await rewriteFile(this.vault.root, memory.filePath, id, kept, srcHash);
      // Ein Hintergrundlauf darf ausfallen: Hat ein anderer Writer die Datei
      // inzwischen angefasst, bleibt dessen Fassung stehen.
      if (outcome.kind !== "written") return null;
      await this.vault.reindexFile(memory.filePath);
      return kept;
    } finally {
      this.inFlight.delete(id);
    }
  }
}

/** Stable short hash of the fields a paraphrase is derived from. Changes iff
 *  the author edits title/summary/recall_when — which is exactly when the
 *  expansion is stale and must be regenerated. */
export function sourceHash(m: Memory): string {
  const src = JSON.stringify([m.fm.title, m.fm.summary, m.fm.recall_when]);
  return createHash("sha256").update(src).digest("hex").slice(0, 16);
}

/** Build the doc2query prompt: ask for short, reworded search phrases in the
 *  note's own language(s), deliberately avoiding the existing trigger words.
 *  Source fields are scrubbed of injected context blocks (#149) so quoted hook
 *  scaffolding never seeds paraphrases; sourceHash stays on the RAW fields —
 *  re-expansion keys on author edits, not on scrub behavior. */
export function buildExpandPrompt(m: Memory): string {
  const clean = (s: string) => scrubInjectedBlocks(s).text;
  return [
    "A user saved this personal memory. Write 3-5 alternative search queries they",
    "might type WEEKS LATER to find it again, using DIFFERENT words than the memory",
    "itself (synonyms, the problem described by its symptom or effect, related",
    "concepts).",
    "",
    "Rules:",
    "- Each line is a natural phrase a person would actually type into a search box,",
    '  like "why does my panel close by itself" or "fenster schließt sich von',
    '  selbst" — NOT a slug, tag, id, filename, or hyphen-chain like "panel-close-fix".',
    "- Use ONLY concepts that appear in the memory below. Never invent product names,",
    "  companies, people, dates, or files that are not in it.",
    "- Write every query in the SAME language(s) the note itself uses — never",
    "  translate. A note in one language gets queries in that language; a note",
    "  that mixes languages may mix the same way.",
    "- One query per line. No numbering, no quotes, no commentary, no headings.",
    "",
    `Title: ${clean(m.fm.title)}`,
    `Summary: ${clean(m.fm.summary)}`,
    `Existing triggers: ${m.fm.recall_when.map(clean).join(" | ")}`,
  ].join("\n");
}

// Function words that sit in the seam of an idiomatic multi-part term
// (left-to-right, end-to-end, state-of-the-art). A slug glues only content words.
const SEAM_WORDS = new Set(["to", "of", "the", "and", "or", "in", "on", "by", "for", "vs"]);

/**
 * A slug/tag/id/filename chain — a single whitespace-free token glued by 2+
 * delimiters, or by mixed delimiters. The prompt forbids these ("NOT a slug ...
 * like panel-close-fix"), but a small local model emits them anyway, and a
 * length filter can't catch them (a slug is short). They poison the BM25 index
 * with noise terms, so they're dropped structurally rather than trusted to the
 * prompt.
 *
 * Deliberately keeps real single-token search terms: a clean word ("fenster"),
 * a 2-segment term ("z-index", "min-width", "ci/cd"), a version ("gpt-4"). Only
 * 3+-segment or mixed-delimiter glue reads as a slug. (A phrase with any
 * whitespace is a real query and never a slug.)
 *
 * Exception: a hyphen-only chain with a function word in an inner segment is an
 * idiomatic term (left-to-right, end-to-end, state-of-the-art), not a slug — a
 * slug glues only content words (panel-close-fix). The hyphen-only guard keeps
 * "path/to/file.md" (also contains "to") a slug: only pure "-" chains get the
 * exception, so paths and mixed-delimiter junk still drop.
 */
export function isSlugChain(phrase: string): boolean {
  if (/\s/.test(phrase)) return false;
  const delims = phrase.match(/[-_/.]/g) ?? [];
  if (delims.length < 2 && new Set(delims).size < 2) return false;
  if (delims.every((d) => d === "-")) {
    const segs = phrase.toLowerCase().split("-").filter(Boolean);
    if (segs.slice(1, -1).some((s) => SEAM_WORDS.has(s))) return false;
  }
  return true;
}

/**
 * Parse the model's reply into clean phrases: split on lines, strip bullets/
 * numbering/quotes, drop empties, over-long lines, and slug-chains (see
 * isSlugChain), dedupe (case-insensitive) against each other AND the existing
 * triggers (a paraphrase that just repeats a trigger is dead weight), cap at
 * `max`.
 */
export function parseExpansions(raw: string, existing: string[], max: number): string[] {
  const seen = new Set(existing.map((t) => t.trim().toLowerCase()));
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const phrase = line
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "") // bullet / "1." / "1)"
      .replace(/^["'`]|["'`]$/g, "") // wrapping quotes
      .trim();
    if (!phrase || phrase.length > MAX_PHRASE_LEN || isSlugChain(phrase)) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(phrase);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Rewrite the memory file's frontmatter with the expanded triggers + source
 * hash, preserving body and every other field. Re-reads the file FRESH right
 * before writing (not the cached Memory) so a concurrent RelatedEnricher write
 * isn't clobbered. Atomic via temp+rename, same as RelatedEnricher.
 */
/**
 * Codex-Gegenreview (P0): Auch hier stand eine Handkopie von
 * `mutateMemoryFile` — ohne ID-Transaktion und ohne Identitätsprüfung. Ein
 * Hintergrundlauf stempelte damit auf eine Datei, die inzwischen ein anderes
 * Memory hielt, und sein Rename konnte einen parallelen Save rückgängig
 * machen. Jetzt derselbe Weg wie jeder andere Writer; ein Write-Conflict am
 * id-Lock ist für einen Hintergrundlauf schlicht `raced`.
 */
async function rewriteFile(
  vaultRoot: string,
  filePath: string,
  id: string,
  expanded: string[],
  srcHash: string,
): Promise<MutateOutcome> {
  try {
    return await mutateMemoryFile(
      filePath,
      id,
      {
        frontmatter: (parsed) => ({
          ...parsed,
          recall_when_expanded: expanded,
          recall_when_expanded_src: srcHash,
        }),
        body: (content) => (content.startsWith("\n") ? content : `\n${content}`),
      },
      { vaultRoot },
    );
  } catch (err) {
    if ((err as { code?: string })?.code === MEMORY_WRITE_CONFLICT) return { kind: "raced" };
    throw err;
  }
}
