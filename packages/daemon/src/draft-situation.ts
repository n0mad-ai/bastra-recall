/** Local Claude capture context, extracted from tool calls rather than prose. */
import { basename } from "node:path";
import { homedir } from "node:os";
import { redactSecrets } from "@bastra-recall/core/scrub";
import { cleanDraftText } from "./draft-text.js";
import type { TranscriptTurn } from "./stop-transcript.js";
import type { Draft } from "./draft-store.js";

type Situation = Draft["situation"];

export function situationForTurn(
  turns: TranscriptTurn[], index: number, typed: (turn: TranscriptTurn) => boolean,
): Situation {
  const empty: Situation = { before: [], after: [], reads: [], lits: [] };
  let start = index - 1;
  while (start >= 0 && !typed(turns[start])) start--;
  let end = index + 1;
  while (end < turns.length && !typed(turns[end])) end++;
  const prior = turns.slice(start + 1, index);
  const following = turns.slice(index + 1, end);
  const metadata = [...prior, turns[index]];
  // Codex parsing is unchanged in B2 and supplies none of these Claude fields.
  if (!metadata.some(t => t.cwd !== undefined || t.branch !== undefined || t.at !== undefined || t.failed !== undefined)) return empty;
  // Preserve full-command redaction; only derive cues after the store's bounds.
  const clean = (text: string): string => cleanDraftText(redactSecrets(text, homedir()).text);
  const before = prior.filter(t => t.role === "assistant").flatMap(t => t.commands ?? []).slice(-3).map(clean);
  const after = following.filter(t => t.role === "assistant").flatMap(t => t.commands ?? []).slice(0, 3).map(clean);
  const reads = prior.filter(t => t.role === "assistant").flatMap(t => (t.reads ?? []).map(r => r.path)).slice(-3).map(clean);
  const rawCwd = [...metadata].reverse().find(t => t.cwd !== undefined)?.cwd;
  const cwd = rawCwd ? clean(rawCwd) : undefined;
  const branch = [...metadata].reverse().find(t => t.branch !== undefined && (!rawCwd || t.cwd === rawCwd))?.branch;
  const project = cwd ? basename(cwd) : undefined;
  const situation: Situation = { before, after, reads, lits: [],
    ...(cwd ? { cwd: clean(cwd), project: clean(project!) } : {}),
    ...(branch !== undefined ? { branch: clean(branch) } : {}) };
  situation.lits = situationLiterals(situation);
  return situation;
}

/** Later evidence contributes its bounded context without discarding old cues. */
export function mergeSituations(previous: Situation, incoming: Situation): Situation {
  const last = (items: string[], count: number): string[] =>
    items.filter((item, i) => items.lastIndexOf(item) === i).slice(-count);
  const changedCwd = incoming.cwd !== undefined && incoming.cwd !== previous.cwd;
  const merged: Situation = {
    ...previous,
    ...(incoming.cwd !== undefined ? { cwd: incoming.cwd } : {}),
    ...(incoming.project !== undefined ? { project: incoming.project } : {}),
    branch: incoming.branch !== undefined ? incoming.branch : changedCwd ? undefined : previous.branch,
    before: last([...previous.before, ...incoming.before], 3),
    after: [...new Set([...previous.after, ...incoming.after])].slice(0, 3),
    reads: last([...previous.reads, ...incoming.reads], 3),
    lits: [],
  };
  merged.lits = situationLiterals(merged);
  return merged;
}

/** Cues are bounded exactly like their source fields, in retrieval priority order. */
export function situationLiterals(situation: Situation): string[] {
  const literals = new Set<string>();
  const add = (value: string): void => {
    if (value.includes("[REDACTED]")) return;
    const text = cleanDraftText(value, 160);
    if (text.length >= 3 && !text.includes("[REDACTED]")) literals.add(text);
  };
  const command = (value: string): void => {
    const text = cleanDraftText(value).replaceAll("[REDACTED]", " ");
    for (const match of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}._@\/:-]*/gu)) {
      if (text[match.index! - 1] !== "-") add(match[0]);
    }
  };
  for (const before of [...situation.before].reverse()) command(before);
  if (situation.project !== undefined) add(situation.project);
  for (const read of [...situation.reads].reverse()) add(basename(cleanDraftText(read)));
  for (const after of situation.after) command(after);
  return [...literals].slice(0, 32);
}

/** Assumption pending owner confirmation: assistant prose does not reset failure.
 * The last tool result since the preceding typed turn decides; a later success
 * or unknown result suppresses the label. */
export function afterFailureForTurn(
  turns: TranscriptTurn[], index: number, typed: (turn: TranscriptTurn) => boolean,
): boolean {
  for (let i = index - 1; i >= 0 && !typed(turns[i]); i--) {
    if (turns[i].role === "tool") return turns[i].failed === true;
  }
  return false;
}
