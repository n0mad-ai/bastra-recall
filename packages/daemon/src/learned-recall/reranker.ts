/**
 * Teacher 2 (#120): a local LLM reranker over a recall's candidate pool. For a far
 * query whose right memory ranked low, a stronger model picks which candidate truly
 * answers it — the offline judgment the bi-encoder/BM25 couldn't make. Runs on a LOCAL
 * Ollama chat model (default gemma3:4b), so it stays OSS-autonomous: no API key, no
 * cloud, no egress. Offline + hard-cases-only, per zzallirog's design.
 *
 * The chat call is injected (ChatFn) so the prompt-building and answer-parsing are
 * unit-testable without a running model.
 */

import { assertLocalOrOptIn } from "@bastra-recall/core";

// Re-exported so existing importers (and tests) keep resolving it from here,
// while the embedding path shares the same assertion. See #124/#125.
export { assertLocalOrOptIn };

export interface RerankCandidate {
  id: string;
  /** Short text the model judges against the query (title + summary). */
  text: string;
}

export interface RerankResult {
  /** The candidate the model judged best, or null when it found none fitting. */
  bestId: string | null;
  /** 1-based rank the chosen candidate had in the input pool (1 = was already top). */
  chosenRank: number | null;
}

/** Injectable chat function: prompt in, raw model reply out. */
export type ChatFn = (prompt: string) => Promise<string>;

// The 16 GB baseline text model — kept in sync with settings.GENERATION_MODEL_DEFAULT.
// A 4B instruction model, chosen over the older vision-language qwen3-vl:4b.
// env BASTRA_RERANK_MODEL still overrides; the install wizard persists per-machine.
export const DEFAULT_RERANK_MODEL = "gemma3:4b";

/**
 * Context window every generation call asks for (#366). Without an explicit
 * `num_ctx` the server default applies, and on this machine that default is
 * `OLLAMA_CONTEXT_LENGTH=262144` — above every installed model's maximum, so
 * each one loads at its own ceiling: 262144 for qwen3:4b, a 36 GB KV cache on a
 * 24 GB box. Only `qwen3-recall` escapes that, and only because its Modelfile
 * pins `PARAMETER num_ctx 4096` — nothing in this code path exempts it.
 *
 * The request body is the right place to fix it: `options.num_ctx` overrides
 * both the server env AND a Modelfile parameter (measured), while the env is a
 * system-wide default we have no business lowering for one client. 4096 matches
 * the working `~/.bastra/qwen3-recall.Modelfile` recipe and covers
 * buildExpandPrompt (title + summary + recall_when).
 * Per-call override via `numCtx`; env override via BASTRA_OLLAMA_NUM_CTX. The
 * rerank lane needs one: buildRerankPrompt scales with the candidate pool and
 * overruns 4096 (see the call site in cli/bridges.ts).
 */
export const DEFAULT_NUM_CTX = 4096;

/** A live Ollama chat client (POST /api/chat, non-streaming). */
export function ollamaChat(
  opts: { baseURL?: string; model?: string; timeoutMs?: number; numCtx?: number } = {},
): ChatFn {
  const baseURL = (opts.baseURL ?? process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434").replace(/\/+$/, "");
  assertLocalOrOptIn(baseURL);
  const model = opts.model ?? process.env.BASTRA_RERANK_MODEL ?? DEFAULT_RERANK_MODEL;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const envCtx = Number.parseInt(process.env.BASTRA_OLLAMA_NUM_CTX ?? "", 10);
  const numCtx = opts.numCtx ?? (envCtx > 0 ? envCtx : DEFAULT_NUM_CTX);
  return async (prompt: string): Promise<string> => {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(`${baseURL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          stream: false,
          // A thinking model otherwise puts its whole answer in
          // `message.thinking` and returns an empty `content` — 0 phrases, no
          // error, and the expander stamps that void into the vault (#367).
          // Verified live: non-thinking models accept the field without
          // complaint, so it is sent unconditionally rather than probed.
          think: false,
          options: { temperature: 0, num_ctx: numCtx },
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`Ollama chat HTTP ${resp.status}`);
      const json = (await resp.json()) as { message?: { content?: string } };
      return json.message?.content ?? "";
    } finally {
      clearTimeout(tid);
    }
  };
}

/**
 * Installed Ollama models via GET /api/tags. Throws a clear error when Ollama is not
 * reachable — so the harvest path can distinguish "daemon down" from "model not pulled"
 * instead of dying on a cryptic 404 at the first /api/chat call.
 */
export async function listOllamaModels(opts: { baseURL?: string; timeoutMs?: number } = {}): Promise<string[]> {
  const baseURL = (opts.baseURL ?? process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434").replace(/\/+$/, "");
  assertLocalOrOptIn(baseURL);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseURL}/api/tags`, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`Ollama tags HTTP ${resp.status}`);
    const json = (await resp.json()) as { models?: Array<{ name?: string }> };
    return (json.models ?? []).map((m) => m.name ?? "").filter(Boolean);
  } finally {
    clearTimeout(tid);
  }
}

export interface RerankModelChoice {
  /** The model to use, or null when nothing usable is installed. */
  model: string | null;
  /** True when the preferred model was absent and a fallback was chosen. */
  fellBack: boolean;
}

/**
 * Resolve the reranker model against what Ollama actually has installed. Prefers the
 * exact requested tag; then the same family under a different tag (gemma3:12b for a
 * requested gemma3:4b); then any other installed chat model, skipping embedding models
 * (they cannot answer a pick-one prompt). Returns model:null when nothing usable is
 * installed, so the caller tells the user to pull one instead of firing a request that
 * 404s at case 1/50 — the first-run trap zzallirog hit on a machine without gemma3:4b.
 */
export function resolveRerankModel(installed: string[], preferred: string): RerankModelChoice {
  const base = (m: string): string => m.split(":")[0];
  if (installed.includes(preferred)) return { model: preferred, fellBack: false };
  const sameFamily = installed.find((m) => base(m) === base(preferred));
  if (sameFamily) return { model: sameFamily, fellBack: true };
  const fallback = installed.find((m) => !/embed/i.test(m));
  return { model: fallback ?? null, fellBack: fallback != null };
}

/** Build the RankGPT-light prompt: query + numbered candidates, pick-one-or-none. */
export function buildRerankPrompt(query: string, candidates: RerankCandidate[]): string {
  const list = candidates.map((c, i) => `${i + 1}. ${c.text.replace(/\s+/g, " ").slice(0, 200)}`).join("\n");
  return [
    "A user searched their personal memory with this query:",
    `"${query}"`,
    "",
    "Candidate memories (numbered):",
    list,
    "",
    `Which single candidate best answers the query? Reply with ONLY the number (1-${candidates.length}), or 0 if none truly fits.`,
  ].join("\n");
}

/** Parse the model's reply to a 1-based index, or null (0 / no number / out of range). */
export function parseRerankAnswer(answer: string, n: number): number | null {
  const m = answer.match(/\d+/);
  if (!m) return null;
  const num = parseInt(m[0], 10);
  if (num < 1 || num > n) return null;
  return num; // 1-based
}

/**
 * Ask the reranker which pooled candidate best answers the query. Returns the chosen
 * candidate's id and the rank it had in the pool — so the caller can tell a "far"
 * rescue (model picked a low-ranked candidate) from a no-op (it picked the top one).
 */
export async function rerank(query: string, candidates: RerankCandidate[], chat: ChatFn): Promise<RerankResult> {
  if (candidates.length === 0) return { bestId: null, chosenRank: null };
  const answer = await chat(buildRerankPrompt(query, candidates));
  const idx1 = parseRerankAnswer(answer, candidates.length);
  if (idx1 === null) return { bestId: null, chosenRank: null };
  return { bestId: candidates[idx1 - 1].id, chosenRank: idx1 };
}
