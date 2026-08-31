import { createHash } from "node:crypto";

export interface ReviewedMissCandidate {
  kind: "reviewed-recall-miss-candidate/v1";
  status: "needs-relevance-label" | "candidate";
  query: string;
  sessionRef: string;
  sourceRef: string | null;
}

interface ToolUse {
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

function sourceRef(tool: ToolUse): string | null {
  if (!tool.input || typeof tool.input !== "object") return null;
  const input = tool.input as Record<string, unknown>;
  for (const key of ["file_path", "path", "query", "id"]) {
    if (typeof input[key] === "string" && input[key]) return hash(`${key}:${input[key]}`);
  }
  return null;
}

function explicitMiss(record: Record<string, unknown>): boolean {
  const serialized = JSON.stringify(record);
  return /"weak_result"\s*:\s*true|"hits"\s*:\s*\[\s*\]|no (?:relevant )?(?:memory|result|hit)/i.test(serialized);
}

/**
 * Extract review candidates from a raw Claude JSONL session without retaining
 * paths, payloads, or tool output. Nonempty Recall results are intentionally
 * only `needs-relevance-label`: a later file read proves neither that Recall
 * was irrelevant nor that the file belongs in the vault.
 */
export function harvestReviewedMisses(jsonl: string, sessionIdentity: string): ReviewedMissCandidate[] {
  const candidates: ReviewedMissCandidate[] = [];
  let intent: string | null = null;
  let pending: { query: string; explicit: boolean } | null = null;
  let evidence: string | null = null;

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
          candidates.push({
            kind: "reviewed-recall-miss-candidate/v1",
            status: pending.explicit ? "candidate" : "needs-relevance-label",
            query: pending.query,
            sessionRef: hash(sessionIdentity),
            sourceRef: evidence,
          });
        }
        intent = humanText;
        pending = null;
        evidence = null;
      }
    }
    if (record.type !== "assistant") continue;
    for (const tool of toolUses(record)) {
      if (isRecall(tool) && intent) {
        pending = { query: intent, explicit: explicitMiss(record) };
        evidence = null;
      } else if (pending && isEvidenceRead(tool)) {
        evidence ??= sourceRef(tool);
      }
    }
  }
  if (pending && evidence) {
    candidates.push({
      kind: "reviewed-recall-miss-candidate/v1",
      status: pending.explicit ? "candidate" : "needs-relevance-label",
      query: pending.query,
      sessionRef: hash(sessionIdentity),
      sourceRef: evidence,
    });
  }
  return candidates;
}
