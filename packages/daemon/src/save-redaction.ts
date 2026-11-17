/**
 * #1470: credentials are redacted on the main write path — save_memory,
 * edit_memory and save_document — with the same structural detector the
 * drafts, suggestions and tasks use (`redactSecrets`, no word lists). The
 * write goes through without a confirmation prompt; every redacted field is
 * named in the receipt, so nothing is replaced silently.
 *
 * No home-directory abbreviation here: a memory keeps its paths verbatim,
 * only credential values are replaced.
 */
import { redactSecrets } from "@bastra-recall/core/scrub";
import type { SaveMemoryInput } from "@bastra-recall/core";

const PLACEHOLDER = "[REDACTED]";

/** Receipt part: how many credential values each field lost. */
export type SecretsRedacted = Record<string, number>;

/** What a write reports about its redaction; empty when nothing was found. */
export interface RedactionReceipt {
  message?: string;
  fields: { secrets_redacted?: SecretsRedacted };
}

const placeholders = (text: string): number => text.split(PLACEHOLDER).length - 1;

/** Collects redactions field by field. */
export class WriteRedaction {
  private readonly hits: SecretsRedacted = {};

  text(field: string, value: string): string;
  text(field: string, value: string | undefined): string | undefined;
  text(field: string, value: string | undefined): string | undefined {
    if (value === undefined || value === "") return value;
    const out = redactSecrets(value).text;
    if (out === value) return value;
    const added = Math.max(1, placeholders(out) - placeholders(value));
    this.hits[field] = (this.hits[field] ?? 0) + added;
    return out;
  }

  list(field: string, values: string[]): string[];
  list(field: string, values: string[] | undefined): string[] | undefined;
  list(field: string, values: string[] | undefined): string[] | undefined {
    return values?.map((value) => this.text(field, value));
  }

  receipt(): RedactionReceipt {
    const fields = Object.entries(this.hits);
    if (fields.length === 0) return { fields: {} };
    const named = fields.map(([field, count]) => `${field} (${count})`).join(", ");
    return {
      message:
        `Credentials were redacted before writing: ${named}. The stored text holds ${PLACEHOLDER} in their place; ` +
        `keep the secret itself in a password manager, not in memory.`,
      fields: { secrets_redacted: { ...this.hits } },
    };
  }
}

/**
 * Redact a save_memory input in place. Optional fields are only rewritten when
 * sent: an absent field keeps its stored value on overwrite (INV-VAULT-03).
 * The tail sentinel is dropped — it was verified on the body as sent and may
 * name the redacted tail.
 */
export function redactSaveInput(data: SaveMemoryInput): RedactionReceipt {
  const redaction = new WriteRedaction();
  data.title = redaction.text("title", data.title);
  data.summary = redaction.text("summary", data.summary);
  data.body = redaction.text("body", data.body);
  data.recall_when = redaction.list("recall_when", data.recall_when);
  if (data.applies_when !== undefined) data.applies_when = redaction.text("applies_when", data.applies_when);
  if (data.verify_cmd !== undefined) data.verify_cmd = redaction.text("verify_cmd", data.verify_cmd);
  delete data.body_ends_with;
  return redaction.receipt();
}

/** The receipt merged into a write's result: field counts plus the sentence first in `warning`. */
export function withRedactionReceipt<T extends object>(
  result: T,
  receipt: RedactionReceipt
): T & RedactionReceipt["fields"] & { warning?: string } {
  if (!receipt.message) return result;
  const previous = (result as { warning?: string }).warning;
  const warning = [receipt.message, previous].filter(Boolean).join(" ");
  return { ...result, ...receipt.fields, warning };
}
