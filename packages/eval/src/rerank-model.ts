/**
 * The cross-encoder behind the #501 decision — loaded, never shipped.
 *
 * This module exists only so the replay runner can ask one question of one
 * model: given a query and a candidate passage, how related are they?
 *
 * ── The package is GONE, and this file stays ───────────────────────────────
 * #501 ended in "close it", so `@huggingface/transformers` was removed from the
 * repo as the registration required. This file is kept, because the decision it
 * produced has to remain reproducible: someone repeating the measurement needs
 * the exact model ids, dtypes, passage shapes and the language guard, not a
 * description of them. The evidence itself lives elsewhere — the archived
 * artifacts and `registrations/rerank-results.json`, hashed — so this code is
 * documentation of a method, not the proof of a result.
 *
 * To repeat the measurement: `npm i -D --workspace=@bastra-recall/eval
 * @huggingface/transformers@^4.2.0`, which is the version every figure in the
 * plan was measured on. Nothing else has to change; `loadCrossEncoder` finds it
 * again and says so plainly when it is absent.
 *
 * ── Why transformers.js and not Ollama, not Python ─────────────────────────
 * Ollama has no rerank endpoint: a cross-encoder is a sequence classifier, not
 * a generator, and there is nothing to prompt. A Python sidecar would put a
 * second runtime and an IPC hop into the thing whose latency is the question.
 * ONNX Runtime in-process answers both, and after the first download it makes
 * no network call — which the issue requires.
 *
 * ── Which model, and the finding that decided it ───────────────────────────
 * Measured 09.09.2026, real pairs, not documentation:
 *
 *   ms-marco-MiniLM-L-6-v2, EN ("How many people live in Berlin?")
 *     gold +8.85 · distractor -11.25          → works
 *   ms-marco-MiniLM-L-6-v2, DE ("Wie hoch war die Rechnung der Werkstatt?")
 *     gold -11.16 · distractor -11.30         → NO SIGNAL
 *   msmarco-MiniLM-L6-en-de-v1, same DE query
 *     gold +1.75 · related -7.41 · unrelated -10.97 / -11.10
 *
 * The vault is German. An English-only reranker would have produced a null
 * result that read like "reranking does not help" and meant "this model does
 * not speak the language". `MODELS` below therefore carries the language each
 * entry may be measured in, and the runner refuses the combinations that would
 * produce such a number. See `docs/design/2026-09-09-501-cross-encoder-rerank-messplan.md`.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Memory } from "@bastra-recall/core";

/**
 * Where the ONNX weights live.
 *
 * transformers.js defaults `env.cacheDir` to
 * `node_modules/@huggingface/transformers/.cache/`, which is the wrong place
 * for half a gigabyte per model: `npm ci` deletes `node_modules`, so every
 * clean install would re-download the whole set, and the weights would sit
 * inside a directory whose contents are supposed to be disposable.
 *
 * Overridable for a machine that keeps its caches elsewhere; the default is
 * the conventional user cache location.
 */
export const CACHE_DIR =
  process.env.BASTRA_RERANK_CACHE_DIR ?? join(homedir(), ".cache", "bastra-rerank");

/** Passage shape. Registered as a free parameter: it costs more than N does. */
export type PassageMode = "short" | "body";

/**
 * The two registered passage variants, and nothing between them.
 *
 * Measured at 80 tokens/pair (`short`) against 191 (`body`), the same model on
 * the same machine costs 26 ms and 77 ms at N=10, 83 ms and 286 ms at N=30 —
 * a factor of 3.4. Passage length, not N, is the expensive knob, which is why
 * it is pinned here rather than chosen while implementing. A third variant
 * would be a search for the best number.
 */
export const BODY_CHARS = 400;

export function passageFor(mem: Memory, mode: PassageMode): string {
  const fm = mem.fm;
  const parts = [fm.title, fm.summary];
  if (mode === "body") parts.push(mem.body.slice(0, BODY_CHARS));
  return parts.filter((p) => p && p.length > 0).join("\n");
}

export interface ModelSpec {
  /** Hugging Face id. */
  readonly repo: string;
  /** transformers.js dtype. `fp32` where the repo ships no quantized file. */
  readonly dtype: "fp32" | "q8";
  /**
   * Languages this model may be MEASURED in. Not a capability boast — a guard.
   * A model scored outside this list produces a number nobody may read as a
   * statement about reranking.
   */
  readonly languages: readonly ("de" | "en")[];
  readonly note: string;
}

export const MODELS: Readonly<Record<string, ModelSpec>> = {
  "en-de": {
    repo: "cross-encoder/msmarco-MiniLM-L6-en-de-v1",
    dtype: "fp32",
    languages: ["de", "en"],
    note: "MiniLM-L6, bilingual EN+DE. The main arm. No quantized ONNX in the repo.",
  },
  bge: {
    repo: "Xenova/bge-reranker-base",
    dtype: "q8",
    languages: ["de", "en"],
    note: "XLM-R base. Too slow for the query path (956 ms p50 at N=30); runs as the offline quality reference that separates 'model too weak' from 'hypothesis wrong'.",
  },
  "ms-marco": {
    repo: "Xenova/ms-marco-MiniLM-L-6-v2",
    dtype: "q8",
    languages: ["en"],
    note: "English only — measured, see the header. LongMemEval arm only; on German it emits no signal at all.",
  },
};

/**
 * The language guard, as a function that actually runs.
 *
 * An earlier version of this file carried `ModelSpec.languages` and a comment
 * claiming the runner would refuse a forbidden combination. Nothing read the
 * field: `--models ms-marco --gold <german set>` ran happily over 272 German
 * cases and would have reported the resulting null as a statement about
 * reranking. The guard was the human typing the flag.
 *
 * `neutral` and `mixed` are deliberately NOT checked. `neutral` cases are
 * keyword chains with no function words — they belong to no language pool, and
 * refusing them would rule out 205 of 584 cases for every model. `mixed` is
 * four cases and is reported as not evaluable anyway.
 *
 * @throws when the set carries a language the model was not measured in.
 */
export function assertLanguagesAllowed(spec: ModelSpec, langs: Iterable<string>): void {
  const seen = new Set(langs);
  const forbidden = [...seen].filter(
    (l) => (l === "de" || l === "en") && !spec.languages.includes(l),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `${spec.repo} was measured in [${spec.languages.join(", ")}] and this set carries ` +
        `[${forbidden.join(", ")}]. Scoring it would produce a number that reads as ` +
        `"reranking does not help" and means "this model does not speak the language". ` +
        `See the spike in docs/design/2026-09-09-501-cross-encoder-rerank-messplan.md.`,
    );
  }
}

/**
 * What the runner needs from a model. A stub implementing this is how the
 * replay is tested without a 400 MB download or an ONNX session.
 */
export interface PairScorer {
  readonly id: string;
  /** One batch: the same query against every passage. Higher means more related. */
  score(query: string, passages: readonly string[]): Promise<number[]>;
  /** Milliseconds the model needed to become usable in this process. */
  readonly loadMs: number;
  close(): void;
}

/**
 * Load a cross-encoder through transformers.js.
 *
 * The import is dynamic and the types are declared locally, both on purpose:
 * the package is no longer installed, so a `typeof import(...)` would break
 * `check:types` for the whole workspace, and a static import would break every
 * module that merely sits beside this one. A missing dependency must say so in
 * one sentence at the moment it is needed — not fail at load time in a file
 * that has nothing to do with it.
 *
 * The surface below is the whole of what this harness ever used. It is written
 * out rather than imported so that the compiler does not need the package to
 * exist, and it is deliberately minimal: three entry points and one settings
 * field.
 */
interface TransformersModule {
  env: { cacheDir: string };
  AutoTokenizer: {
    from_pretrained(repo: string): Promise<
      (queries: string[], opts: { text_pair: string[]; padding: boolean; truncation: boolean; max_length: number }) => unknown
    >;
  };
  AutoModelForSequenceClassification: {
    from_pretrained(repo: string, opts: { dtype: string }): Promise<
      (inputs: unknown) => Promise<{ logits: { tolist(): unknown } }>
    >;
  };
}

export async function loadCrossEncoder(key: keyof typeof MODELS | string): Promise<PairScorer> {
  const spec = MODELS[key];
  if (!spec) {
    throw new Error(`unknown model key ${JSON.stringify(key)} — registered: ${Object.keys(MODELS).join(", ")}`);
  }
  let mod: TransformersModule;
  try {
    // Built from a variable so the compiler does not try to resolve a package
    // that is intentionally absent.
    const pkg = "@huggingface/transformers";
    mod = (await import(/* @vite-ignore */ pkg)) as unknown as TransformersModule;
  } catch (e) {
    throw new Error(
      "@huggingface/transformers is not installed — it was removed when #501 closed. " +
        "To repeat the measurement, install the version it was measured on: " +
        `npm i -D --workspace=@bastra-recall/eval @huggingface/transformers@^4.2.0 (${(e as Error).message})`,
    );
  }
  // Must be set BEFORE the first `from_pretrained` — the value is read when a
  // file is resolved, so setting it afterwards would leave the first model in
  // `node_modules` and split the cache across two directories.
  mod.env.cacheDir = CACHE_DIR;
  const t0 = Date.now();
  const tokenizer = await mod.AutoTokenizer.from_pretrained(spec.repo);
  const model = await mod.AutoModelForSequenceClassification.from_pretrained(spec.repo, {
    dtype: spec.dtype,
  });
  const loadMs = Date.now() - t0;

  return {
    id: `${spec.repo}@${spec.dtype}`,
    loadMs,
    async score(query: string, passages: readonly string[]): Promise<number[]> {
      if (passages.length === 0) return [];
      const inputs = tokenizer(new Array(passages.length).fill(query), {
        text_pair: [...passages],
        padding: true,
        truncation: true,
        max_length: 512,
      });
      const { logits } = await model(inputs);
      // Single-logit relevance head: [[s], [s], …]. A model with two columns
      // would need a softmax and is not one of the registered three, so this
      // asserts rather than guesses.
      const rows = logits.tolist() as number[][];
      if (rows.length !== passages.length) {
        throw new Error(`${spec.repo}: scored ${rows.length} of ${passages.length} pairs`);
      }
      return rows.map((r) => {
        if (r.length !== 1) {
          throw new Error(`${spec.repo}: expected a single-logit relevance head, got ${r.length} columns`);
        }
        return r[0];
      });
    },
    close(): void {
      // ONNX sessions are freed when the model object goes out of scope; there
      // is no explicit dispose in the Node build. Kept as a seam so the runner
      // does not have to know that.
    },
  };
}
