import { createHash } from "node:crypto";

/**
 * Shared between the deterministic harvester (`reviewed-miss-harvest.ts`) and
 * the model-judge reviewer (`reviewed-miss-judge.ts`): both walk the same raw
 * session JSONL shape looking for the same Recall-call / evidence-read
 * pattern. Extracted so the two stop drifting against each other — see
 * `docs/design/2026-09-01-v2-offline-harvester-and-access-clusters.md` §2.
 */
export interface ToolUse {
  id?: unknown;
  name?: unknown;
  input?: unknown;
}

export function hash(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function contentText(content: unknown): string | null {
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

export function humanIntent(record: Record<string, unknown>): string | null {
  if (record.isMeta === true || "sourceToolUseID" in record) return null;
  const text = contentText((record.message as { content?: unknown } | undefined)?.content);
  if (!text || /^\[Image:\s*source:/i.test(text)) return null;
  return text;
}

export function toolUses(record: Record<string, unknown>): ToolUse[] {
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is ToolUse & { type: "tool_use" } =>
    typeof part === "object" && part !== null && (part as { type?: unknown }).type === "tool_use",
  );
}

export function isRecall(tool: ToolUse): boolean {
  return typeof tool.name === "string" && /(?:^|__)recall$/i.test(tool.name);
}

export function isEvidenceRead(tool: ToolUse): boolean {
  return typeof tool.name === "string" && /^(Read|Glob|Grep|Search|find_document|read_document)$/i.test(tool.name);
}

export function sourceRef(tool: ToolUse): string | null {
  if (!tool.input || typeof tool.input !== "object") return null;
  const input = tool.input as Record<string, unknown>;
  for (const key of ["file_path", "path", "id", "query"]) {
    if (typeof input[key] === "string" && input[key]) return hash(key + ":" + input[key]);
  }
  return null;
}

/** The text a tool_result part carries: a plain string or joined text parts. */
export function resultText(part: Record<string, unknown>): string | null {
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

export function matchingResults(record: Record<string, unknown>, toolIds: Set<string>): Record<string, unknown>[] {
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
export function leadingJsonObject(text: string): Record<string, unknown> | null {
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

export interface Envelope {
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
export function readEnvelope(text: string | null): Envelope {
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
