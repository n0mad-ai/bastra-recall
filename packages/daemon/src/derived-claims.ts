/**
 * #467 — bounded, lazy facts for a memory.
 *
 * A derived claim stores a formula and the value stays in its source.  This is
 * intentionally narrower than a lifecycle engine: the resolver list is closed
 * and reads one regular file below the vault root.  Vault content reaches a
 * plain file read and stops there — no shell, no regex from content, no
 * network, no write path.
 *
 * #609 adds the verdict half: a claim that carries `expect` is compared with
 * what the source holds now, and the reader is told whether the note still
 * agrees with it.  The comparison is display-only, exactly like #235's anchor:
 * a difference is shown, and the reader decides.
 */
import { createHash } from "node:crypto";
import { open, realpath, stat, constants, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { assertInsideVault, type DerivedClaim } from "@bastra-recall/core";

const MAX_SOURCE_BYTES = 1_000_000;

/** Every file touch a claim makes, in one object so a test can watch them. */
export const claimSourceIo = { open, realpath, stat };

/**
 * `observed` is the pre-#609 shape: a value with nothing to compare it to.
 * The other four are verdicts on a claim that says what it expects.
 */
export type DerivedClaimStatus =
  | "observed"
  | "matches"
  | "differs"
  | "gone"
  | "ambiguous"
  | "unverifiable";

export interface DerivedClaimResult {
  id: string;
  resolver: DerivedClaim["resolver"];
  source: string;
  case_ref?: string;
  status: DerivedClaimStatus;
  /** What the source holds now: a count for the count resolver, the number of
   *  occurrences for `quote.v1`, the digest for `sha256.v1`. */
  value?: number | string;
  /** Echoed back so a reader sees both halves of a `differs` next to each other. */
  expect?: number | string;
  /** The string `quote.v1` looked for. */
  exact?: string;
  reason?: "outside_vault" | "unavailable" | "not_a_file" | "too_large";
}

export async function resolveDerivedClaims(
  vaultRoot: string,
  claims: readonly DerivedClaim[],
): Promise<DerivedClaimResult[]> {
  return Promise.all(claims.map((claim) => resolveClaim(vaultRoot, claim)));
}

async function resolveClaim(vaultRoot: string, claim: DerivedClaim): Promise<DerivedClaimResult> {
  const base = {
    id: claim.id,
    resolver: claim.resolver,
    source: claim.source,
    ...(claim.case_ref === undefined ? {} : { case_ref: claim.case_ref }),
    ...(claim.expect === undefined ? {} : { expect: claim.expect }),
    ...(claim.exact === undefined ? {} : { exact: claim.exact }),
  };
  let bytes: Buffer;
  try {
    bytes = await readSource(vaultRoot, claim.source);
  } catch (error) {
    return { ...base, status: "unverifiable", reason: reasonFor(error) };
  }
  if (claim.resolver === "sha256.v1") {
    // The digest of the bytes on disk, so it equals what `shasum -a 256`
    // prints — a UTF-8 round trip would change it for any non-UTF-8 byte.
    const value = createHash("sha256").update(bytes).digest("hex");
    return { ...base, value, status: value === claim.expect ? "matches" : "differs" };
  }
  const text = bytes.toString("utf8");
  if (claim.resolver === "quote.v1") {
    const value = occurrences(normalizeQuote(text), normalizeQuote(claim.exact ?? ""));
    return { ...base, value, status: value === 1 ? "matches" : value === 0 ? "gone" : "ambiguous" };
  }
  const value = countMarkdownNumberedList(text);
  return {
    ...base,
    value,
    status: claim.expect === undefined ? "observed" : value === claim.expect ? "matches" : "differs",
  };
}

/** Thrown when the source is inside the vault yet unfit to read as text. */
class SourceOutOfBounds extends Error {
  constructor(readonly reason: DerivedClaimResult["reason"]) {
    super(`derived claim source is ${reason}`);
  }
}

/**
 * The one door to a claim's source, shared by every resolver: inside the vault,
 * a regular file, up to 1 MB. The bytes come back as they are on disk; the
 * text resolvers decode them as UTF-8.
 */
async function readSource(vaultRoot: string, source: string): Promise<Buffer> {
  const target = resolve(vaultRoot, source);
  // `assertInsideVault` resolves the path through its symlinks before it
  // compares, so a vault-relative spelling that walks out through a link lands
  // outside the vault here and is reported instead of read.
  assertInsideVault(vaultRoot, target, "read derived claim");
  const handle = await claimSourceIo.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new SourceOutOfBounds("not_a_file");
    if (info.size > MAX_SOURCE_BYTES) throw new SourceOutOfBounds("too_large");
    // The path may have changed after the first containment check. Compare
    // its current inode with the handle before reading any source bytes.
    const canonical = await claimSourceIo.realpath(target);
    assertInsideVault(vaultRoot, canonical, "read derived claim");
    const atPath = await claimSourceIo.stat(target);
    if (atPath.dev !== info.dev || atPath.ino !== info.ino) throw new SourceOutOfBounds("unavailable");
    const bytes = await readBoundedSource(handle, MAX_SOURCE_BYTES);
    if (bytes === null) throw new SourceOutOfBounds("too_large");
    const after = await handle.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new SourceOutOfBounds("unavailable");
    return bytes;
  } finally {
    await handle.close();
  }
}

/** The size limit applies to bytes read, including growth after fstat. */
export async function readBoundedSource(handle: Pick<FileHandle, "read">, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return null;
}

function reasonFor(error: unknown): DerivedClaimResult["reason"] {
  if (error instanceof SourceOutOfBounds) return error.reason;
  return error instanceof Error && error.message.includes("outside") ? "outside_vault" : "unavailable";
}

/** Count every occurrence, including overlaps; an empty needle stands nowhere. */
function occurrences(text: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) count++;
  return count;
}

function normalizeQuote(text: string): string {
  return text.normalize("NFC").replace(/\r\n?/g, "\n");
}

function countMarkdownNumberedList(text: string): number {
  let count = 0;
  let fence: { char: string; length: number } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (fence === null) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && marker[2].trim() === "") fence = null;
      continue;
    }
    if (fence === null && /^\s*\d+[.)]\s+/.test(line)) count++;
  }
  return count;
}
