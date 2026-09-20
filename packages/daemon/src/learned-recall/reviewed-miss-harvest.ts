import {
  hash,
  humanIntent,
  isEvidenceRead,
  isRecall,
  matchingResults,
  readEnvelope,
  resultText,
  sourceRef,
  toolUses,
  type Envelope,
  type ToolUse,
} from "./reviewed-miss-shared.js";

export { hash };

/**
 * The chain a raw session proves on its own: human intent, the exact Recall
 * call, its result envelope, and the first evidence step after that result.
 * Nothing here is classified; the offline engines attach the frozen pool and
 * the vault proofs, and the classifier decides. Raw identifiers stay inside
 * this process — the queue record only ever carries their hashes.
 */
export interface ReviewedMissChain {
  query: string;
  sessionIdentity: string;
  /** `recall_id` from the served envelope, when the envelope carried one. */
  recallId: string | null;
  /** Envelope-level miss signal: `weak_result`, `no_home` or an empty `hits`. */
  explicitMiss: boolean;
  /** Ids the served envelope listed under `hits`, in served order. */
  servedIds: string[];
  /** Transcript timestamp of the matching tool_result, if the record had one. */
  resultTs: string | null;
  evidence: ReviewedMissEvidence;
}

export type ReviewedMissEvidence =
  | { kind: "load-memory"; memoryId: string }
  | { kind: "file-read"; path: string }
  | { kind: "bash-read"; path: string }
  | { kind: "opaque"; sourceRef: string | null };

export interface ReviewedMissCandidate {
  kind: "reviewed-recall-miss-candidate/v1";
  status: "needs-relevance-label" | "candidate";
  query: string;
  sessionRef: string;
  sourceRef: string | null;
  evidence: {
    recall: "explicit-miss" | "nonempty-or-unclassified";
    sourceReadAfterRecall: true;
  };
}

function isLoadMemory(tool: ToolUse): boolean {
  return typeof tool.name === "string" && /(?:^|__)load_memory$/i.test(tool.name);
}

function isBash(tool: ToolUse): boolean {
  return typeof tool.name === "string" && /^Bash$/i.test(tool.name);
}

function evidenceOf(tool: ToolUse): ReviewedMissEvidence {
  const input = (tool.input && typeof tool.input === "object" ? tool.input : {}) as Record<string, unknown>;
  if (isLoadMemory(tool) && typeof input.id === "string" && input.id) return { kind: "load-memory", memoryId: input.id };
  if (typeof tool.name === "string" && /^Read$/i.test(tool.name) && typeof input.file_path === "string" && input.file_path) {
    return { kind: "file-read", path: input.file_path };
  }
  return { kind: "opaque", sourceRef: sourceRef(tool) };
}

/**
 * Split a shell command into its bare-word / quoted-word tokens. No escaping,
 * no expansion — good enough to recognize `cat FILE`, never to run anything.
 * Returns null on an unterminated quote, which the caller treats the same as
 * "does not fit the shape".
 */
function tokenizeSimpleCommand(command: string): string[] | null {
  const tokens: string[] = [];
  const text = command.trim();
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) break;
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      const end = text.indexOf(quote, i + 1);
      if (end === -1) return null;
      tokens.push(text.slice(i + 1, end));
      i = end + 1;
    } else {
      const start = i;
      while (i < text.length && !/\s/.test(text[i])) i += 1;
      tokens.push(text.slice(start, i));
    }
  }
  return tokens;
}

/** Shell features that turn "one command" into "a script" — never guess through these. */
const SHELL_METACHARACTERS = /[;&|`$<>\n]/;
const GLOB_CHARACTERS = /[*?[\]{}]/;

/**
 * `resolveTarget` runs offline, in the harvester's own process — it has no
 * access to the cwd the session's shell actually had. A relative token would
 * resolve against the wrong directory and silently mislabel a vault hit as
 * external (or the reverse); only an absolute path can be resolved honestly.
 */
function looksLikeSinglePath(token: string): boolean {
  return token.length > 0 && token.startsWith("/") && !GLOB_CHARACTERS.test(token);
}

const CAT_FLAG = /^-[A-Za-z]+$/;
const HEAD_TAIL_FLAG = /^-(?:f|c\d+|n\d+|\d+)$/;
const GREP_BOOL_CHARS = new Set([..."ivcnlwxoEF"]);

function isGrepFlag(token: string): boolean {
  return /^-[A-Za-z]+$/.test(token) && [...token.slice(1)].every((ch) => GREP_BOOL_CHARS.has(ch));
}

/**
 * Recognize a single-file read from a small, closed set of shapes: `cat`,
 * `head`/`tail` (bare or with a self-contained flag like `-n40`/`-60`/`-f`),
 * `grep PATTERN FILE`. Anything with a pipe, redirect, subshell, variable
 * expansion, glob, or more than one positional argument returns null — an
 * honest `unknown` beats a guessed path.
 */
function bashReadPath(command: string): string | null {
  if (SHELL_METACHARACTERS.test(command)) return null;
  const tokens = tokenizeSimpleCommand(command);
  if (!tokens || tokens.length < 2) return null;
  const [cmd, ...rest] = tokens;
  if (cmd === "cat" || cmd === "head" || cmd === "tail") {
    const flag = cmd === "cat" ? CAT_FLAG : HEAD_TAIL_FLAG;
    const positional = rest.filter((t) => !flag.test(t));
    if (positional.length !== 1) return null;
    return looksLikeSinglePath(positional[0]) ? positional[0] : null;
  }
  if (cmd === "grep") {
    const positional = rest.filter((t) => !isGrepFlag(t));
    if (positional.length !== 2) return null;
    const path = positional[1];
    return looksLikeSinglePath(path) ? path : null;
  }
  return null;
}

/**
 * Extract the intent → Recall → result → evidence chains a raw Claude JSONL
 * session proves. Results join their Recall call by tool_use_id, never by
 * adjacency. The chain keeps raw ids for the engines; `toCandidate` is the
 * only shape that leaves the process.
 */
export interface RecallCallStats {
  /** Recall calls whose result arrived. */
  recalls: number;
  /** Of those, results whose envelope carried a `recall_id`. */
  withRecallId: number;
}

export function extractReviewedMissChains(jsonl: string, sessionIdentity: string, stats?: RecallCallStats): ReviewedMissChain[] {
  const chains: ReviewedMissChain[] = [];
  let intent: string | null = null;
  let pending: {
    query: string;
    envelope: Envelope;
    resultSeen: boolean;
    resultTs: string | null;
    toolIds: Set<string>;
  } | null = null;
  let evidence: ReviewedMissEvidence | null = null;

  const emit = (): void => {
    if (!pending || evidence === null) return;
    chains.push({
      query: pending.query,
      sessionIdentity,
      recallId: pending.envelope.recallId,
      explicitMiss: pending.envelope.explicitMiss,
      servedIds: pending.envelope.servedIds,
      resultTs: pending.resultTs,
      evidence,
    });
  };

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type === "user") {
      const intentText = humanIntent(record);
      if (intentText) {
        emit();
        intent = intentText;
        pending = null;
        evidence = null;
      }
      if (pending) {
        for (const part of matchingResults(record, pending.toolIds)) {
          if (!pending.resultSeen && stats) stats.recalls += 1;
          pending.resultSeen = true;
          pending.resultTs = typeof record.timestamp === "string" ? record.timestamp : pending.resultTs;
          const envelope = readEnvelope(resultText(part));
          if (stats && envelope.recallId && !pending.envelope.recallId) stats.withRecallId += 1;
          pending.envelope = {
            explicitMiss: pending.envelope.explicitMiss || envelope.explicitMiss,
            recallId: pending.envelope.recallId ?? envelope.recallId,
            servedIds: pending.envelope.servedIds.length > 0 ? pending.envelope.servedIds : envelope.servedIds,
          };
        }
      }
    }
    if (record.type !== "assistant") continue;
    for (const tool of toolUses(record)) {
      if (isRecall(tool) && intent) {
        pending = {
          query: intent,
          envelope: { explicitMiss: false, recallId: null, servedIds: [] },
          resultSeen: false,
          resultTs: null,
          toolIds: new Set(typeof tool.id === "string" ? [tool.id] : []),
        };
        evidence = null;
      } else if (pending?.resultSeen && (isEvidenceRead(tool) || isLoadMemory(tool)) && evidence === null) {
        evidence = evidenceOf(tool);
      } else if (pending?.resultSeen && isBash(tool) && evidence === null) {
        // Most Bash calls are not evidence reads at all (uptime, find, ps…).
        // Unlike Read/load_memory, an unrecognized shape does not consume the
        // slot — it would otherwise freeze every chain on the first `find`.
        const input = (tool.input && typeof tool.input === "object" ? tool.input : {}) as Record<string, unknown>;
        const path = typeof input.command === "string" ? bashReadPath(input.command) : null;
        if (path) evidence = { kind: "bash-read", path };
      }
    }
  }
  emit();
  return chains;
}

/** The pathless v1 queue record: hashed identities, verbatim query, no payload. */
export function toCandidate(chain: ReviewedMissChain): ReviewedMissCandidate {
  const ref = chain.evidence.kind === "load-memory"
    ? hash("id:" + chain.evidence.memoryId)
    : chain.evidence.kind === "file-read" || chain.evidence.kind === "bash-read"
      ? hash("file_path:" + chain.evidence.path)
      : chain.evidence.sourceRef;
  return {
    kind: "reviewed-recall-miss-candidate/v1",
    status: chain.explicitMiss ? "candidate" : "needs-relevance-label",
    query: chain.query,
    sessionRef: hash(chain.sessionIdentity),
    sourceRef: ref,
    evidence: {
      recall: chain.explicitMiss ? "explicit-miss" : "nonempty-or-unclassified",
      sourceReadAfterRecall: true,
    },
  };
}

/**
 * Extract review candidates from a raw Claude JSONL session without retaining
 * paths, payloads, or tool output. A later source read does not prove a
 * nonempty Recall irrelevant, so only an envelope-level miss is a candidate.
 */
export function harvestReviewedMisses(jsonl: string, sessionIdentity: string): ReviewedMissCandidate[] {
  return extractReviewedMissChains(jsonl, sessionIdentity).map(toCandidate);
}
