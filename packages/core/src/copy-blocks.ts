/**
 * Copy blocks (#1309): split a finished text into channel-sized blocks the user
 * copies one by one, and prove nothing was lost on the way.
 *
 * Pure — no I/O. The caller hands in the canonical text and the full
 * validation contract (channel, limit, counting unit, line-ending policy, the
 * rule and task state it was produced under); the result names every block
 * with its offsets and count OUTSIDE the payload, the separators that sit
 * between blocks, whether payloads + separators rebuild the canonical text byte
 * for byte, and every finding that blocks delivery. A receipt is issued only
 * when nothing failed, and it is a SHA-256 over the artifact bytes and every
 * contract field, so any later edit or parameter change gives another receipt.
 *
 * What a receipt proves: this exact text, split this way, passed these
 * mechanical checks. It says nothing about translation quality or whether a
 * draft was approved.
 *
 * No content is ever shortened, rewritten, trimmed or Unicode-normalized. The
 * only normalization is the named `crlf-to-lf`.
 */
import { createHash } from "node:crypto";

export const COPY_BLOCKS_VALIDATOR_VERSION = "copy-blocks.v1";

export type CopyBlocksUnit = "codepoints" | "utf16";
/**
 * The unit a count was taken in. `max(codepoints,utf16)` is the stricter of
 * both, used when a channel's own unit is not verified from its primary docs.
 */
export type CopyBlocksUnitApplied = CopyBlocksUnit | "max(codepoints,utf16)";
export type CopyBlocksNormalize = "crlf-to-lf" | "none";

/**
 * Channel limits default when omitted. Discord's counting unit remains
 * unverified, so discord-dm always enforces the stricter of both counts,
 * including when a caller requests codepoints or utf16.
 * Primary references (neither establishes the counting unit):
 * https://docs.discord.com/developers/resources/message#create-message
 * https://support.discord.com/hc/en-us/articles/360034632292
 */
export const COPY_BLOCKS_CHANNEL_DEFAULTS: Readonly<Record<string, { limit: number; unit: CopyBlocksUnitApplied }>> = {
  "discord-dm": { limit: 2000, unit: "max(codepoints,utf16)" },
};

export interface CopyBlocksInput {
  text: string;
  channel: string;
  limit?: number;
  unit?: CopyBlocksUnit;
  normalize: CopyBlocksNormalize;
  rule?: { id: string; revision: string };
  task?: { kind: string; generation: number };
}

export interface CopyBlock {
  /** 1-based position. Labels are built from this, never written into the payload. */
  index: number;
  payload: string;
  /** UTF-16 offsets into the canonical text, `end` exclusive. */
  start: number;
  end: number;
  /** Payload length in `unit_applied`. */
  count: number;
  /** A backtick fence longer than any backtick run in the payload, for a safe code-block container. */
  fence: string;
}

export interface CopyBlocksSeparator {
  /** The block this separator follows. */
  after_block: number;
  text: string;
  start: number;
  end: number;
}

export type CopyBlocksErrorCode =
  | "empty"
  | "quote_prefix"
  | "counter_in_payload"
  | "unsplittable"
  | "over_limit"
  | "reconstruction_failed";

export interface CopyBlocksError {
  code: CopyBlocksErrorCode;
  /** The block concerned, when there is one. */
  block?: number;
  message: string;
}

export interface CopyBlocksResult {
  validator_version: string;
  channel: string;
  limit: number;
  unit_applied: CopyBlocksUnitApplied;
  normalize: CopyBlocksNormalize;
  /** SHA-256 of the canonical text (after `normalize`), UTF-8. */
  artifact_sha256: string;
  blocks: CopyBlock[];
  separators: CopyBlocksSeparator[];
  reconstruction_ok: boolean;
  errors: CopyBlocksError[];
  /** `sha256:<hex>` when every check passed, otherwise null. */
  receipt: string | null;
}

/** Separators by preference: paragraph, line, sentence end, word. */
const BOUNDARIES: readonly RegExp[] = [/(?:\r?\n){2,}/g, /\r?\n/g, /(?<=[.!?…])[ \t]+/g, /[ \t]+/g];

const QUOTE_PREFIX_RE = /^>{1,3} /m;
// Counters as an agent writes them: "(1/3)", "[2/3]", "[123 chars]" in any
// language (a bracketed number and one word, #679: no language word list),
// and the label line renderForChat itself produces ("Block 1/3").
const COUNTER_RES: readonly RegExp[] = [
  /[([]\s*\d+\s*\/\s*\d+\s*[)\]]/,
  /\[\s*\d+\s*\p{L}+\s*\]/u,
  /\bBlock\s+\d+\s*\/\s*\d+/,
];

export function countCopyUnits(text: string, unit: CopyBlocksUnitApplied): number {
  const codepoints = unit === "utf16" ? 0 : [...text].length;
  if (unit === "codepoints") return codepoints;
  return Math.max(codepoints, text.length);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** UTF-16 offsets where a grapheme cluster starts, plus the text end. */
function graphemeBoundaries(text: string): number[] {
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  const out: number[] = [];
  for (const s of segmenter.segment(text)) out.push(s.index);
  out.push(text.length);
  return out;
}

function fenceFor(payload: string): string {
  let longest = 0;
  for (const run of payload.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The receipt for a validated artifact. Exported so a later holder of the
 * same contract can recompute it; key order is fixed here, not left to the caller.
 */
export function copyBlocksReceipt(contract: {
  artifact_sha256: string;
  channel: string;
  limit: number;
  unit_applied: CopyBlocksUnitApplied;
  normalize: CopyBlocksNormalize;
  rule?: { id: string; revision: string };
  task?: { kind: string; generation: number };
}): string {
  const canonical = JSON.stringify([
    ["artifact_sha256", contract.artifact_sha256],
    ["channel", contract.channel],
    ["limit", contract.limit],
    ["unit", contract.unit_applied],
    ["normalize", contract.normalize],
    ["rule_id", contract.rule?.id ?? null],
    ["rule_revision", contract.rule?.revision ?? null],
    ["task_kind", contract.task?.kind ?? null],
    ["task_generation", contract.task?.generation ?? null],
    ["validator_version", COPY_BLOCKS_VALIDATOR_VERSION],
    ["result", "ok"],
  ]);
  return `sha256:${sha256(canonical)}`;
}

export function validateCopyBlocks(input: CopyBlocksInput): CopyBlocksResult {
  const defaults = COPY_BLOCKS_CHANNEL_DEFAULTS[input.channel];
  const limit = input.limit ?? defaults?.limit;
  if (limit === undefined) throw new Error(`copy-blocks: no limit given and no default for channel "${input.channel}"`);
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`copy-blocks: limit must be a positive integer, got ${limit}`);
  const unit: CopyBlocksUnitApplied = input.channel === "discord-dm"
    ? "max(codepoints,utf16)"
    : input.unit ?? defaults?.unit ?? "max(codepoints,utf16)";
  const text = input.normalize === "crlf-to-lf" ? input.text.replace(/\r\n/g, "\n") : input.text;

  const errors: CopyBlocksError[] = [];
  const blocks: CopyBlock[] = [];
  const separators: CopyBlocksSeparator[] = [];
  const boundaries = graphemeBoundaries(text);
  const isBoundary = new Set(boundaries);

  const pushBlock = (start: number, end: number) => {
    const payload = text.slice(start, end);
    blocks.push({ index: blocks.length + 1, payload, start, end, count: countCopyUnits(payload, unit), fence: fenceFor(payload) });
  };

  if (text.length === 0) errors.push({ code: "empty", message: "The artifact is empty." });

  let pos = 0;
  let g = 0; // index into `boundaries` of `pos`
  while (pos < text.length) {
    // Furthest grapheme boundary whose slice from `pos` still fits. Counts add
    // up per cluster: UTF-16 is never below code points, so the max of the
    // sums is the sum of the per-cluster maxima.
    let fit = g;
    let count = 0;
    while (fit + 1 < boundaries.length) {
      const next = count + countCopyUnits(text.slice(boundaries[fit]!, boundaries[fit + 1]), unit);
      if (next > limit) break;
      count = next;
      fit++;
    }
    const maxEnd = boundaries[fit]!;
    if (maxEnd === text.length) {
      pushBlock(pos, text.length);
      break;
    }
    let cut: { at: number; sep: string } | null = null;
    for (const re of BOUNDARIES) {
      re.lastIndex = pos;
      for (let m = re.exec(text); m && m.index <= maxEnd; m = re.exec(text)) {
        if (m.index > pos && isBoundary.has(m.index) && isBoundary.has(m.index + m[0].length)) cut = { at: m.index, sep: m[0] };
      }
      if (cut) break;
    }
    let end: number;
    let sep = "";
    if (cut) {
      end = cut.at;
      sep = cut.sep;
    } else if (maxEnd > pos) {
      // One word longer than the limit: cut at a grapheme boundary so the
      // result still reconstructs, but it is not deliverable.
      end = maxEnd;
      errors.push({ code: "unsplittable", block: blocks.length + 1, message: `Block ${blocks.length + 1}: a word is longer than the limit of ${limit}; it was cut without a boundary.` });
    } else {
      end = boundaries[g + 1]!;
      errors.push({ code: "over_limit", block: blocks.length + 1, message: `Block ${blocks.length + 1}: one grapheme cluster exceeds the limit of ${limit}.` });
    }
    pushBlock(pos, end);
    pos = end + sep.length;
    if (pos < text.length || sep) separators.push({ after_block: blocks.length, text: sep, start: end, end: pos });
    while (boundaries[g]! < pos) g++;
  }

  for (const b of blocks) {
    if (QUOTE_PREFIX_RE.test(b.payload)) {
      errors.push({ code: "quote_prefix", block: b.index, message: `Block ${b.index}: a line starts with a "> " quote prefix.` });
    }
    if (COUNTER_RES.some((re) => re.test(b.payload))) {
      errors.push({ code: "counter_in_payload", block: b.index, message: `Block ${b.index}: the payload contains a block counter or character count; counts belong outside the payload.` });
    }
  }

  // Splitting can move part of a marker into a separator or another payload.
  // Check the canonical text too, without repeating a finding already reported.
  if (QUOTE_PREFIX_RE.test(text) && !errors.some((e) => e.code === "quote_prefix")) {
    errors.push({ code: "quote_prefix", message: 'The canonical text contains a line starting with a "> " quote prefix.' });
  }
  if (COUNTER_RES.some((re) => re.test(text)) && !errors.some((e) => e.code === "counter_in_payload")) {
    errors.push({ code: "counter_in_payload", message: "The canonical text contains a block counter or character count; counts belong outside the payload." });
  }

  let rebuilt = "";
  for (const b of blocks) {
    rebuilt += b.payload;
    rebuilt += separators.find((s) => s.after_block === b.index)?.text ?? "";
  }
  const reconstruction_ok = rebuilt === text;
  if (!reconstruction_ok) errors.push({ code: "reconstruction_failed", message: "Payloads and separators do not rebuild the canonical text." });

  const artifact_sha256 = sha256(text);
  const contract = { artifact_sha256, channel: input.channel, limit, unit_applied: unit, normalize: input.normalize, rule: input.rule, task: input.task };
  return {
    validator_version: COPY_BLOCKS_VALIDATOR_VERSION,
    channel: input.channel,
    limit,
    unit_applied: unit,
    normalize: input.normalize,
    artifact_sha256,
    blocks,
    separators,
    reconstruction_ok,
    errors,
    receipt: errors.length === 0 ? copyBlocksReceipt(contract) : null,
  };
}

/**
 * Chat rendering: one label line per block, then the payload in a fenced code
 * block whose fence is longer than any backtick run inside. The label sits
 * outside the fence, so copying the block copies only the payload.
 */
export function renderForChat(result: Pick<CopyBlocksResult, "blocks" | "unit_applied">): string {
  const n = result.blocks.length;
  return result.blocks
    .map((b) => `Block ${b.index}/${n} · ${b.count} ${result.unit_applied}\n${b.fence}\n${b.payload}\n${b.fence}`)
    .join("\n\n");
}
