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
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { assertInsideVault, type DerivedClaim } from "@bastra-recall/core";

const MAX_SOURCE_BYTES = 1_000_000;

/** Every file touch a claim makes, in one object so a test can watch them. */
export const claimSourceIo = { readFile, realpath, stat };

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
  let text: string;
  try {
    text = await readSource(vaultRoot, claim.source);
  } catch (error) {
    return { ...base, status: "unverifiable", reason: reasonFor(error) };
  }
  if (claim.resolver === "sha256.v1") {
    const value = createHash("sha256").update(text).digest("hex");
    return { ...base, value, status: value === claim.expect ? "matches" : "differs" };
  }
  if (claim.resolver === "quote.v1") {
    const value = occurrences(text, claim.exact ?? "");
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
 * a regular file, up to 1 MB, read as UTF-8.
 */
async function readSource(vaultRoot: string, source: string): Promise<string> {
  const target = resolve(vaultRoot, source);
  // Resolve once before reading: a vault-relative spelling may still walk
  // through a symlink.  The real target stays inside the real vault.
  assertInsideVault(vaultRoot, target, "read derived claim");
  const realTarget = await claimSourceIo.realpath(target);
  assertInsideVault(vaultRoot, realTarget, "read derived claim");
  const info = await claimSourceIo.stat(realTarget);
  if (!info.isFile()) throw new SourceOutOfBounds("not_a_file");
  if (info.size > MAX_SOURCE_BYTES) throw new SourceOutOfBounds("too_large");
  return claimSourceIo.readFile(realTarget, "utf8");
}

function reasonFor(error: unknown): DerivedClaimResult["reason"] {
  if (error instanceof SourceOutOfBounds) return error.reason;
  return error instanceof Error && error.message.includes("outside") ? "outside_vault" : "unavailable";
}

/** How often `needle` stands in `text`, counting overlaps apart. */
function occurrences(text: string, needle: string): number {
  let found = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) found += 1;
  return found;
}

function countMarkdownNumberedList(text: string): number {
  return text.split(/\r?\n/).filter((line) => /^\s*\d+[.)]\s+/.test(line)).length;
}
