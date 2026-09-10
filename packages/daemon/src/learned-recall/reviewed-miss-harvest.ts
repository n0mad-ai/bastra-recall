import { createHash } from "node:crypto";

interface ToolUse {
  id?: unknown;
  name?: unknown;
  input?: unknown;
}

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

function hash(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex").slice(0, 32);
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
  return typeof tool.name === "string" && /^(Read|Glob|Grep|Search|find_document|read_document)$/i.test(tool.name);
}

function sourceRef(tool: ToolUse): string | null {
  if (!tool.input || typeof tool.input !== "object") return null;
  const input = tool.input as Record<string, unknown>;
  for (const key of ["file_path", "path", "id", "query"]) {
    if (typeof input[key] === "string" && input[key]) return hash(key + ":" + input[key]);
  }
  return null;
}

function explicitMiss(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false;
  if (typeof value === "string") {
    try {
      return explicitMiss(JSON.parse(value), depth + 1);
    } catch {
      return /no (?:relevant )?(?:memory|result|hit)/i.test(value);
    }
  }
  if (Array.isArray(value)) return value.some((item) => explicitMiss(item, depth + 1));
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.weak_result === true || (Array.isArray(record.hits) && record.hits.length === 0) ||
    Object.values(record).some((item) => explicitMiss(item, depth + 1));
}

function resultMatches(record: Record<string, unknown>, toolIds: Set<string>): boolean {
  const content = (record.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) && content.some((part) =>
    typeof part === "object" && part !== null &&
    typeof (part as { tool_use_id?: unknown }).tool_use_id === "string" &&
    toolIds.has((part as { tool_use_id: string }).tool_use_id),
  );
}

/**
 * Extract review candidates from a raw Claude JSONL session without retaining
 * paths, payloads, or tool output. A later source read does not prove a
 * nonempty Recall irrelevant, so only explicit weak/empty results are candidates.
 */
export function harvestReviewedMisses(jsonl: string, sessionIdentity: string): ReviewedMissCandidate[] {
  const candidates: ReviewedMissCandidate[] = [];
  let intent: string | null = null;
  let pending: { query: string; explicit: boolean; resultSeen: boolean; toolIds: Set<string> } | null = null;
  let evidence: { sourceRef: string | null } | null = null;

  const emit = (): void => {
    if (!pending || evidence === null) return;
    candidates.push({
      kind: "reviewed-recall-miss-candidate/v1",
      status: pending.explicit ? "candidate" : "needs-relevance-label",
      query: pending.query,
      sessionRef: hash(sessionIdentity),
      sourceRef: evidence.sourceRef,
      evidence: {
        recall: pending.explicit ? "explicit-miss" : "nonempty-or-unclassified",
        sourceReadAfterRecall: true,
      },
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
      if (pending && resultMatches(record, pending.toolIds)) {
        pending.resultSeen = true;
        pending.explicit ||= explicitMiss(record);
      }
    }
    if (record.type !== "assistant") continue;
    for (const tool of toolUses(record)) {
      if (isRecall(tool) && intent) {
        pending = { query: intent, explicit: false, resultSeen: false, toolIds: new Set(typeof tool.id === "string" ? [tool.id] : []) };
        evidence = null;
      } else if (pending?.resultSeen && isEvidenceRead(tool) && evidence === null) {
        evidence = { sourceRef: sourceRef(tool) };
      }
    }
  }
  emit();
  return candidates;
}
