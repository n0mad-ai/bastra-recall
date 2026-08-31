import { createHash } from "node:crypto";
import { relative, sep } from "node:path";

export interface ReviewedMissCandidate {
  kind: "reviewed-recall-miss-candidate/v1";
  status: "needs-relevance-label" | "candidate";
  query: string;
  sessionRef: string;
  sourceRef: string | null;
  /** Present only for an explicitly local/private harvest output. */
  sourcePath?: string | null;
  evidence: {
    recall: "explicit-miss" | "nonempty-or-unclassified";
    sourceReadAfterRecall: true;
  };
}

export interface HarvestOptions {
  includePrivateEvidence?: boolean;
}

export interface HotFileTemplate {
  kind: "recall-hot-files-template/v1";
  zone: string;
  validation: "resolve relative to the live zone root; ignore missing paths";
  excludedEphemeralObservations: number;
  files: Array<{
    path: string;
    observations: number;
    explicitMisses: number;
    needsRelevanceLabel: number;
  }>;
}

function isEphemeralPath(path: string): boolean {
  return /(?:^|\/)(?:tmp|private\/tmp)\/|\/\.claude\/projects\/.+\/(?:tool-results|tasks|scratchpad)\/|\/\.claude\/worktrees\//.test(path);
}

interface ToolUse {
  id?: unknown;
  name?: unknown;
  input?: unknown;
}

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function contentText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  if (content.some((part) => typeof part === "object" && part !== null && "tool_use_id" in part)) return null;
  const text = content
    .filter((part): part is { type?: unknown; text?: unknown } => typeof part === "object" && part !== null)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text || null;
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
  return typeof tool.name === "string" && /^(Read|Glob|Grep|Search|find_document|read_document)$/i.test(tool.name);
}

function sourceEvidence(tool: ToolUse): { sourceRef: string | null; sourcePath: string | null } {
  if (!tool.input || typeof tool.input !== "object") return { sourceRef: null, sourcePath: null };
  const input = tool.input as Record<string, unknown>;
  for (const key of ["file_path", "path"]) {
    if (typeof input[key] === "string" && input[key]) {
      return { sourceRef: hash(`${key}:${input[key]}`), sourcePath: input[key] };
    }
  }
  for (const key of ["id", "query"]) {
    if (typeof input[key] === "string" && input[key]) {
      return { sourceRef: hash(`${key}:${input[key]}`), sourcePath: null };
    }
  }
  return { sourceRef: null, sourcePath: null };
}

function explicitMiss(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false;
  if (typeof value === "string") {
    if (/no (?:relevant )?(?:memory|result|hit)/i.test(value)) return true;
    try {
      return explicitMiss(JSON.parse(value), depth + 1);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some((item) => explicitMiss(item, depth + 1));
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.weak_result === true) return true;
  if (Array.isArray(record.hits) && record.hits.length === 0) return true;
  return Object.values(record).some((item) => explicitMiss(item, depth + 1));
}

function toolResultFor(record: Record<string, unknown>, toolIds: Set<string>): boolean {
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return false;
  return content.some((part) =>
    typeof part === "object" && part !== null &&
    typeof (part as { tool_use_id?: unknown }).tool_use_id === "string" &&
    toolIds.has((part as { tool_use_id: string }).tool_use_id),
  );
}

/**
 * Extract review candidates from a raw Claude JSONL session without retaining
 * paths, payloads, or tool output. Nonempty Recall results are intentionally
 * only `needs-relevance-label`: a later file read proves neither that Recall
 * was irrelevant nor that the file belongs in the vault.
 */
export function harvestReviewedMisses(
  jsonl: string,
  sessionIdentity: string,
  options: HarvestOptions = {},
): ReviewedMissCandidate[] {
  const candidates: ReviewedMissCandidate[] = [];
  let intent: string | null = null;
  let pending: { query: string; explicit: boolean; resultSeen: boolean; toolIds: Set<string> } | null = null;
  let evidence: { sourceRef: string | null; sourcePath: string | null } | null = null;

  function emit(): void {
    if (!pending || !evidence) return;
    const candidate: ReviewedMissCandidate = {
      kind: "reviewed-recall-miss-candidate/v1",
      status: pending.explicit ? "candidate" : "needs-relevance-label",
      query: pending.query,
      sessionRef: hash(sessionIdentity),
      sourceRef: evidence.sourceRef,
      evidence: {
        recall: pending.explicit ? "explicit-miss" : "nonempty-or-unclassified",
        sourceReadAfterRecall: true,
      },
    };
    if (options.includePrivateEvidence) candidate.sourcePath = evidence.sourcePath;
    candidates.push(candidate);
  }

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type === "user") {
      const humanText = contentText((record.message as { content?: unknown } | undefined)?.content);
      if (humanText) {
        if (pending && evidence) {
          emit();
        }
        intent = humanText;
        pending = null;
        evidence = null;
      }
      if (pending && toolResultFor(record, pending.toolIds)) {
        pending.resultSeen = true;
        pending.explicit ||= explicitMiss(record);
      }
    }
    if (record.type !== "assistant") continue;
    for (const tool of toolUses(record)) {
      if (isRecall(tool) && intent) {
        pending = {
          query: intent,
          explicit: explicitMiss(record),
          resultSeen: false,
          toolIds: new Set(typeof tool.id === "string" ? [tool.id] : []),
        };
        evidence = null;
      } else if (pending?.resultSeen && isEvidenceRead(tool)) {
        evidence ??= sourceEvidence(tool);
      }
    }
  }
  if (pending && evidence) {
    emit();
  }
  return candidates;
}

/** Build a pathless-root hot-file template from an explicitly private harvest. */
export function buildHotFileTemplate(
  candidates: ReviewedMissCandidate[],
  zoneRoot: string,
  zone: string,
): HotFileTemplate {
  const files = new Map<string, { observations: number; explicitMisses: number; needsRelevanceLabel: number }>();
  let excludedEphemeralObservations = 0;
  for (const candidate of candidates) {
    if (!candidate.sourcePath) continue;
    if (isEphemeralPath(candidate.sourcePath)) {
      excludedEphemeralObservations++;
      continue;
    }
    const path = relative(zoneRoot, candidate.sourcePath);
    if (!path || path === ".." || path.startsWith(`..${sep}`)) continue;
    const current = files.get(path) ?? { observations: 0, explicitMisses: 0, needsRelevanceLabel: 0 };
    current.observations++;
    if (candidate.status === "candidate") current.explicitMisses++;
    else current.needsRelevanceLabel++;
    files.set(path, current);
  }
  return {
    kind: "recall-hot-files-template/v1",
    zone,
    validation: "resolve relative to the live zone root; ignore missing paths",
    excludedEphemeralObservations,
    files: [...files.entries()]
      .map(([path, counts]) => ({ path, ...counts }))
      .sort((left, right) => right.observations - left.observations || left.path.localeCompare(right.path)),
  };
}
