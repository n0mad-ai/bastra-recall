/** Causal local draft usage (#1084, E), separate from the note usage sidecar. */
import { envOff } from "./env.js";
import { ACTED_ON_WINDOW_MS } from "./telemetry-join-state.js";
import { transactDrafts, type Draft } from "./draft-store.js";
import { tokens } from "./save-similarity.js";
import { cleanDraftText } from "./draft-text.js";

function literals(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._@\/:-]*/gu) ?? [];
}
function literalShape(token: string): boolean {
  return token.length >= 4 && /[\p{N}./_@:-]/u.test(token);
}

/** Both words and command literals come from the quote and application commands.
 * Trigger tokens are removed on both tokenizations; matches are whole tokens. */
export function draftNovelTokens(draft: Draft, triggeringInput: string): string[] {
  const source = [draft.quote, ...draft.situation.after].join("\n");
  const input = new Set([...tokens(triggeringInput), ...literals(triggeringInput)]);
  return [...new Set([
    ...literals(source).filter(literalShape), ...tokens(source).filter(token => !literalShape(token)),
  ])].filter(token => !input.has(token)).slice(0, 32).map(token => cleanDraftText(token, 160));
}

/** Shared by actual in-process lane delivery and /hook/hinted. A replay cannot
 * reset the original novelty set/window; origin sessions never qualify. */
export async function recordDraftHints(ids: string[], sessionId: string | null, triggeringInput: string | null, now = Date.now()): Promise<number> {
  if (!sessionId || triggeringInput === null || envOff("BASTRA_DRAFT_HINTS")) return 0;
  try {
    const selected = new Set(ids.filter(id => /^d-[a-f0-9]{12}$/.test(id)).slice(0, 2));
    if (!selected.size) return 0;
    return await transactDrafts(async rows => {
      let count = 0;
      for (const row of rows) {
        if (row.state !== "open" || !selected.has(row.id) || row.evidence.some(e => e.session_id === sessionId)) continue;
        if (row.surfaced.some(surface => surface.session_id === sessionId)) continue;
        row.surfaced.push({ session_id: sessionId, ts: now, novel: draftNovelTokens(row, triggeringInput) });
        row.surfaced = row.surfaced.slice(-5); row.last_touched = now; count++;
      }
      return count;
    }, now, true) ?? 0;
  } catch { return 0; } // local feedback never breaks a hook
}

export interface DraftUseInput {
  sessionId: string | null;
  toolName: string | null;
  excerpt: string;
  exitCode: number | null;
  now?: number;
}

/** Strict success evidence: unknown exit codes do not qualify. Assumption, not
 * confirmed by the owner; preserves the phase-E acceptance's explicit exit 0. */
export async function recordDraftUse(input: DraftUseInput): Promise<number> {
  const { sessionId, toolName, excerpt, exitCode } = input;
  if (!sessionId || !toolName || !excerpt || exitCode !== 0) return 0;
  const now = input.now ?? Date.now();
  const literalInput = new Set(literals(excerpt));
  const wordInput = new Set(tokens(excerpt));
  try {
    return await transactDrafts(async rows => {
      let count = 0;
      for (const row of rows) {
        if (row.state !== "open" || row.evidence.some(e => e.session_id === sessionId)) continue;
        const surface = row.surfaced.find(s => s.session_id === sessionId);
        if (!surface || surface.used || now <= surface.ts || now - surface.ts > ACTED_ON_WINDOW_MS) continue;
        const literalMatches = surface.novel.filter(token => literalShape(token) && literalInput.has(token));
        const wordMatches = surface.novel.filter(token => !literalShape(token) && wordInput.has(token));
        if (!literalMatches.length && wordMatches.length < 3) continue;
        surface.used = { ts: now, tool: cleanDraftText(toolName, 80), exit_code: 0,
          matched: (literalMatches.length ? literalMatches : wordMatches).slice(0, 3) };
        row.last_touched = now; count++;
      }
      return count;
    }, now, true) ?? 0;
  } catch { return 0; }
}

/** Valid persisted proof remains usable at a later harvest tick. */
export function draftUseProof(draft: Draft): Draft["surfaced"][number] | undefined {
  return draft.surfaced.find(surface => surface.used && surface.used.exit_code === 0
    && surface.used.ts > surface.ts && surface.used.ts - surface.ts <= ACTED_ON_WINDOW_MS
    && !draft.evidence.some(e => e.session_id === surface.session_id));
}
