/**
 * Pure draft-usage evidence (#1084, E): token sets of a draft, the proof that a
 * surfaced draft was causally used, and the bounded surface list. No store
 * access, so both the draft store and the usage booking in draft-use.ts build
 * on it without importing each other (#1515 B2).
 */
import { ACTED_ON_WINDOW_MS } from "./telemetry-join-state.js";
import type { Draft } from "./draft-store.js";
import { tokens } from "./save-similarity.js";
import { cleanDraftText } from "./draft-text.js";

/** Unmeasured heuristics; use the existing acted-on time window. */
export const DRAFT_USE_MIN_WORD_TOKENS = 3;
export const DRAFT_USE_LITERAL_MIN_CHARS = 4;

export function literals(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}/@:_][\p{L}\p{N}._@\/:-]*/gu) ?? []).map((t) => {
    let end = t.length;
    while (end > 0 && (t[end - 1] === "." || t[end - 1] === ":")) end--;
    return t.slice(0, end);
  });
}
export function literalShape(token: string): boolean {
  return [...token].length >= DRAFT_USE_LITERAL_MIN_CHARS && /[\p{N}./_@:-]/u.test(token);
}

/** Both words and command literals come from the quote and application commands.
 * Trigger tokens are removed on both tokenizations; matches are whole tokens. */
export function sourceTokens(draft: Draft): string[] {
  const source = [draft.quote, ...draft.situation.after].join("\n").replace(/\S*\[REDACTED(?:[^\]]*)\]\S*/gi, " ");
  return [
    ...new Set([
      ...literals(source).filter(literalShape),
      ...tokens(source).filter((token) => !literalShape(token) && /\p{L}/u.test(token)),
    ]),
  ].map((token) => cleanDraftText(token, 160));
}
export function draftNovelTokens(draft: Draft, triggeringInput: string): string[] {
  const input = new Set([...tokens(triggeringInput), ...literals(triggeringInput)]);
  return sourceTokens(draft)
    .filter((token) => !input.has(token))
    .slice(0, 32);
}

/** Valid persisted proof remains usable at a later harvest tick. */
export function draftUseProof(draft: Draft): Draft["surfaced"][number] | undefined {
  return draft.surfaced.find(
    (surface) =>
      surface.used &&
      surface.used.exit_code === 0 &&
      surface.used.ts > surface.ts &&
      surface.used.ts - surface.ts <= ACTED_ON_WINDOW_MS &&
      !draft.evidence.some((e) => e.session_id === surface.session_id) &&
      surface.used.matched.length > 0 &&
      surface.used.matched.every((token) => surface.novel.includes(token) && sourceTokens(draft).includes(token)) &&
      (surface.used.matched.some(literalShape) ||
        new Set(surface.used.matched.filter((token) => /\p{L}/u.test(token))).size >= DRAFT_USE_MIN_WORD_TOKENS)
  );
}

/** Keep the first valid causal receipt while retaining the five-entry bound. */
export function retainDraftSurfaces(draft: Draft): Draft["surfaced"] {
  const proof = draftUseProof(draft);
  return proof ? [proof, ...draft.surfaced.filter((s) => s !== proof).slice(-4)] : draft.surfaced.slice(-5);
}
