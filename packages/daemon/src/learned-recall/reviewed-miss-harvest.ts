import { createHash } from "node:crypto";
import { basename } from "node:path";
import { pseudonymousSession } from "../telemetry-dimensions.js";

interface ToolUse {
  id?: unknown;
  name?: unknown;
  input?: unknown;
}

export function hash(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * The one session ref every lane writes. Its input is the client session as
 * the daemon pseudonymizes it (`pseudonymousSession`, stamped on recall
 * events as `dimensions.experiment_session`) — the only spelling of a session
 * that both a transcript and the telemetry can produce. A transcript knows the
 * raw Claude session id and derives the pseudonym (`transcriptSession`);
 * telemetry never holds the raw id for a load.
 */
export function sessionRef(session: string): string {
  return hash("session:" + session);
}

/**
 * The client session a raw transcript belongs to, as its daemon pseudonym:
 * the `sessionId` its records carry, else the file name, which Claude Code
 * names after the same id.
 */
export function transcriptSession(jsonl: string, fileName: string): string {
  let raw: string | null = null;
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"sessionId"')) continue;
    try {
      const id = (JSON.parse(line) as { sessionId?: unknown }).sessionId;
      if (typeof id === "string" && id) {
        raw = id;
        break;
      }
    } catch {
      continue;
    }
  }
  return pseudonymousSession(raw ?? basename(fileName).replace(/\.jsonl$/i, "")) ?? "";
}

function contentText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content) || content.some((part) => typeof part === "object" && part !== null && "tool_use_id" in part)) {
    return null;
  }
  const text = content
    .filter((part): part is { type?: unknown; text?: unknown } => typeof part === "object" && part !== null)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text || null;
}

function humanIntent(record: Record<string, unknown>): string | null {
  if (record.isMeta === true || "sourceToolUseID" in record) return null;
  const text = contentText((record.message as { content?: unknown } | undefined)?.content);
  if (!text || /^\[Image:\s*source:/i.test(text)) return null;
  return text;
}

function toolUses(record: Record<string, unknown>): ToolUse[] {
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is ToolUse & { type: "tool_use" } =>
    typeof part === "object" && part !== null && (part as { type?: unknown }).type === "tool_use",
  );
}

function isRecall(tool: ToolUse): boolean {
  return typeof tool.name === "string" && /(?:^|__)recall$/i.test(tool.name);
}

function isEvidenceRead(tool: ToolUse): boolean {
  // Same MCP-prefix rule as `isRecall`: a real transcript names the tool
  // `mcp__bastra-recall__find_document`, never the bare name.
  return typeof tool.name === "string" && /(?:^|__)(Read|Glob|Grep|Search|find_document|read_document)$/i.test(tool.name);
}

function sourceRef(tool: ToolUse): string | null {
  if (!tool.input || typeof tool.input !== "object") return null;
  const input = tool.input as Record<string, unknown>;
  for (const key of ["file_path", "path", "id", "query"]) {
    if (typeof input[key] === "string" && input[key]) return hash(key + ":" + input[key]);
  }
  return null;
}

/** The text a tool_result part carries: a plain string or joined text parts. */
function resultText(part: Record<string, unknown>): string | null {
  const content = part.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((item): item is { type?: unknown; text?: unknown } => typeof item === "object" && item !== null)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  return text || null;
}

function matchingResults(record: Record<string, unknown>, toolIds: Set<string>): Record<string, unknown>[] {
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is Record<string, unknown> =>
    typeof part === "object" && part !== null &&
    typeof (part as { tool_use_id?: unknown }).tool_use_id === "string" &&
    toolIds.has((part as { tool_use_id: string }).tool_use_id),
  );
}

/**
 * The served envelope is a JSON object that a transport may follow with
 * trailing context text (the session-context block). Parse the leading object
 * only; anything after its closing brace is not the envelope.
 */
function leadingJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, index + 1));
          return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

interface Envelope {
  explicitMiss: boolean;
  recallId: string | null;
  servedIds: string[];
}

/**
 * Read the served Recall envelope and nothing below it. A miss is what the
 * envelope itself states — `weak_result`, `no_home`, or an empty `hits` —
 * never a sentence found inside a hit's summary and never a nested `hits`
 * array. Text that does not parse as an envelope carries no miss signal.
 */
function readEnvelope(text: string | null): Envelope {
  const none: Envelope = { explicitMiss: false, recallId: null, servedIds: [] };
  if (!text) return none;
  const parsed = leadingJsonObject(text);
  if (parsed === null) return none;
  const record = parsed as Record<string, unknown>;
  const hits = Array.isArray(record.hits) ? record.hits : null;
  const servedIds = (hits ?? [])
    .map((hit) => (typeof hit === "object" && hit !== null ? (hit as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return {
    explicitMiss: record.weak_result === true || record.no_home === true || (hits !== null && hits.length === 0),
    recallId: typeof record.recall_id === "string" && record.recall_id ? record.recall_id : null,
    servedIds,
  };
}


/**
 * The chain a raw session proves on its own: human intent, the exact Recall
 * call, its result envelope, and the first evidence step after that result.
 * Nothing here is classified; the offline engines attach the frozen pool and
 * the vault proofs, and the classifier decides. Raw identifiers stay inside
 * this process — the queue record only ever carries their hashes.
 */
export interface ReviewedMissChain {
  query: string;
  /** Client session pseudonym; see `sessionRef`. */
  session: string;
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

export function extractReviewedMissChains(jsonl: string, session: string, stats?: RecallCallStats): ReviewedMissChain[] {
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
  /**
   * An evidence step that produced nothing inspectable. It used to be written
   * straight into `evidence`, which froze the slot: a `Grep(pattern)` with no
   * path, a `find_document`, a `load_memory` with the undocumented plural
   * `ids` key — each of them shut the chain before the real `Read` that
   * followed. The Bash branch below already refused to do that; this is the
   * same rule for the rest. Kept as a fallback rather than dropped, so a chain
   * whose only step really is opaque still reports itself as opaque.
   */
  let opaque: ReviewedMissEvidence | null = null;

  const emit = (): void => {
    const found = evidence ?? opaque;
    if (!pending || found === null) return;
    chains.push({
      query: pending.query,
      session,
      recallId: pending.envelope.recallId,
      explicitMiss: pending.envelope.explicitMiss,
      servedIds: pending.envelope.servedIds,
      resultTs: pending.resultTs,
      evidence: found,
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
        opaque = null;
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
        // A finished chain is handed over before the next recall replaces it.
        // Without this, a second recall in the same turn dropped the first one
        // whole — result, envelope, explicit miss and all.
        emit();
        pending = {
          query: intent,
          envelope: { explicitMiss: false, recallId: null, servedIds: [] },
          resultSeen: false,
          resultTs: null,
          toolIds: new Set(typeof tool.id === "string" ? [tool.id] : []),
        };
        evidence = null;
        opaque = null;
      } else if (pending?.resultSeen && (isEvidenceRead(tool) || isLoadMemory(tool)) && evidence === null) {
        const found = evidenceOf(tool);
        if (found.kind === "opaque") opaque = opaque ?? found;
        else evidence = found;
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
    sessionRef: sessionRef(chain.session),
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
export function harvestReviewedMisses(jsonl: string, session: string): ReviewedMissCandidate[] {
  return extractReviewedMissChains(jsonl, session).map(toCandidate);
}
