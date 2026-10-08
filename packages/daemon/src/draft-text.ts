/** The existing Phase-A text bounds, shared by storage and literal extraction. */
import { homedir } from "node:os";
import { redactSecrets } from "@bastra-recall/core/scrub";

export function clipDraftText(text: string, max: number): string {
  if (text.length <= max) return text;
  // A complete marker must stay atomic even when redaction expands a value.
  const marker = "[REDACTED]";
  const start = text.lastIndexOf(marker, max);
  const end = start >= 0 && start < max && start + marker.length > max ? start : max;
  let prefix = text.slice(0, end);
  const last = prefix.charCodeAt(prefix.length - 1);
  const next = text.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) prefix = prefix.slice(0, -1);
  if (/\s/.test(text[prefix.length]) || /\s$/.test(prefix)) return prefix;
  const boundary = prefix.search(/\s+\S*$/u);
  return boundary < 0 ? prefix : prefix.slice(0, boundary);
}

export function cleanDraftText(text: string, max = 200): string {
  return clipDraftText(redactSecrets(clipDraftText(text, max), homedir()).text, max);
}

/** Opaque client metadata is single-line, bounded and secret-redacted. */
export function cleanDraftField(text: string, max = 200): string {
  return redactSecrets(text.replace(/[\p{Cc}\p{Cf}]/gu,""),homedir()).text.slice(0,max);
}
