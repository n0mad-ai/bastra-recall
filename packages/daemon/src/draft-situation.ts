/** Local Claude capture context, extracted from tool calls rather than prose. */
import { basename } from "node:path";
import { homedir } from "node:os";
import { redactSecrets } from "@bastra-recall/core/scrub";
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
  const clean = (text: string): string => redactSecrets(text, homedir()).text;
  const before = prior.filter(t => t.role === "assistant").flatMap(t => t.commands ?? []).slice(-3).map(clean);
  const after = following.filter(t => t.role === "assistant").flatMap(t => t.commands ?? []).slice(0, 3).map(clean);
  const reads = prior.filter(t => t.role === "assistant").flatMap(t => (t.reads ?? []).map(r => r.path)).slice(-3).map(clean);
  const rawCwd = [...metadata].reverse().find(t => t.cwd !== undefined)?.cwd;
  const cwd = rawCwd ? clean(rawCwd) : undefined;
  const branch = [...metadata].reverse().find(t => t.branch !== undefined)?.branch;
  const project = cwd ? basename(cwd) : undefined;
  const literals = new Set<string>();
  for (const command of [...before, ...after]) {
    const text = command.replaceAll("[REDACTED]", " ");
    for (const match of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}._@\/:-]*/gu)) {
      if (match[0].length >= 3 && text[match.index! - 1] !== "-") literals.add(match[0]);
    }
  }
  for (const read of reads) {
    const name = basename(read);
    if (name.length >= 3 && !name.includes("[REDACTED]")) literals.add(name);
  }
  if (project && project.length >= 3) literals.add(clean(project));
  return { before, after, reads, lits: [...literals].slice(-32),
    ...(cwd ? { cwd: clean(cwd), project: clean(project!) } : {}),
    ...(branch !== undefined ? { branch: clean(branch) } : {}) };
}

/** Later evidence contributes its bounded context without discarding old cues. */
export function mergeSituations(previous: Situation, incoming: Situation): Situation {
  const last = (items: string[], count: number): string[] =>
    items.filter((item, i) => items.lastIndexOf(item) === i).slice(-count);
  return {
    ...previous,
    ...(incoming.cwd !== undefined ? { cwd: incoming.cwd } : {}),
    ...(incoming.project !== undefined ? { project: incoming.project } : {}),
    ...(incoming.branch !== undefined ? { branch: incoming.branch } : {}),
    before: last([...previous.before, ...incoming.before], 3),
    after: [...new Set([...previous.after, ...incoming.after])].slice(0, 3),
    reads: last([...previous.reads, ...incoming.reads], 3),
    lits: last([...previous.lits, ...incoming.lits], 32),
  };
}
