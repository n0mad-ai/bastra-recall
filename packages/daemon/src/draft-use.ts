/** Causal local draft usage (#1084, E), separate from the note usage sidecar. */
import { envOff } from "./env.js";
import { writeDraftEvent } from "./draft-events.js";
import { ACTED_ON_WINDOW_MS } from "./telemetry-join-state.js";
import { transactDrafts } from "./draft-store.js";
import { tokens } from "./save-similarity.js";
import { cleanDraftField } from "./draft-text.js";
import {
  DRAFT_USE_MIN_WORD_TOKENS,
  draftNovelTokens,
  literalShape,
  literals,
  retainDraftSurfaces,
  sourceTokens,
} from "./draft-use-proof.js";

export {
  DRAFT_USE_LITERAL_MIN_CHARS,
  DRAFT_USE_MIN_WORD_TOKENS,
  draftNovelTokens,
  draftUseProof,
  retainDraftSurfaces,
} from "./draft-use-proof.js";

/** Shared by actual in-process lane delivery and /hook/hinted. A replay cannot
 * reset the original novelty set/window; origin sessions never qualify. */
export async function recordDraftHints(
  ids: string[],
  sessionId: string | null,
  triggeringInput: string | null,
  now = Date.now(),
  offeredNovel?: ReadonlyMap<string, string[]>
): Promise<number> {
  if (!sessionId || triggeringInput === null || envOff("BASTRA_DRAFT_HINTS")) return 0;
  sessionId = cleanDraftField(sessionId);
  const inputTokens = new Set([...tokens(triggeringInput), ...literals(triggeringInput)]);
  try {
    const selected = new Set(ids.filter((id) => /^d-[a-f0-9]{12}$/.test(id)).slice(0, 2));
    if (!selected.size) return 0;
    const count =
      (await transactDrafts(
        async (rows) => {
          let count = 0;
          for (const row of rows) {
            if (row.state !== "open" || !selected.has(row.id) || row.evidence.some((e) => e.session_id === sessionId))
              continue;
            if (row.surfaced.some((surface) => surface.session_id === sessionId)) continue;
            const novel =
              offeredNovel?.get(row.id)?.filter((t) => !inputTokens.has(t)) ?? draftNovelTokens(row, triggeringInput);
            row.surfaced.push({ session_id: sessionId, ts: now, novel });
            row.surfaced = retainDraftSurfaces(row);
            count++;
          }
          return count;
        },
        now,
        true
      )) ?? 0;
    if (count > 0) void writeDraftEvent({ kind: "draft_hint_registered", count });
    return count;
  } catch {
    return 0;
  } // local feedback never breaks a hook
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
  const sessionId = input.sessionId === null ? null : cleanDraftField(input.sessionId);
  const toolName = input.toolName === null ? null : cleanDraftField(input.toolName, 80);
  const { excerpt, exitCode } = input;
  if (!sessionId || !toolName || !excerpt || exitCode !== 0) return 0;
  const now = input.now ?? Date.now();
  const literalInput = new Set(literals(excerpt));
  const wordInput = new Set(tokens(excerpt));
  try {
    const count =
      (await transactDrafts(
        async (rows) => {
          let count = 0;
          for (const row of rows) {
            if (row.state !== "open" || row.evidence.some((e) => e.session_id === sessionId)) continue;
            const surface = row.surfaced.find((s) => s.session_id === sessionId);
            if (!surface || surface.used || now <= surface.ts || now - surface.ts > ACTED_ON_WINDOW_MS) continue;
            const eligible = new Set(sourceTokens(row));
            const novel = surface.novel.filter((token) => eligible.has(token));
            const literalMatches = [
              ...new Set(novel.filter((token) => literalShape(token) && literalInput.has(token))),
            ];
            const wordMatches = [
              ...new Set(novel.filter((token) => !literalShape(token) && /\p{L}/u.test(token) && wordInput.has(token))),
            ];
            if (!literalMatches.length && wordMatches.length < DRAFT_USE_MIN_WORD_TOKENS) continue;
            surface.used = {
              ts: now,
              tool: toolName,
              exit_code: 0,
              matched: (literalMatches.length ? literalMatches : wordMatches).slice(0, 3),
            };
            row.last_touched = now;
            count++;
          }
          return count;
        },
        now,
        true
      )) ?? 0;
    if (count > 0) void writeDraftEvent({ kind: "draft_hint_used", count });
    return count;
  } catch {
    return 0;
  }
}
