/**
 * #467 — bounded, lazy facts for a memory.
 *
 * A derived claim stores a formula and the value stays in its source.  This is
 * intentionally narrower than a lifecycle engine: the resolver list is closed
 * and reads one regular file below the vault root.  Vault content reaches a
 * plain file read and stops there — no shell, no regex from content, no
 * network, no write path.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { assertInsideVault, type DerivedClaim } from "@bastra-recall/core";

const MAX_SOURCE_BYTES = 1_000_000;

export interface DerivedClaimResult {
  id: string;
  resolver: DerivedClaim["resolver"];
  source: string;
  case_ref: string;
  status: "observed" | "unverifiable";
  value?: number;
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
    case_ref: claim.case_ref,
  };
  const target = resolve(vaultRoot, claim.source);
  try {
    // Resolve once before reading: a vault-relative spelling may still walk
    // through a symlink.  The real target must remain inside the real vault.
    assertInsideVault(vaultRoot, target, "read derived claim");
    const realTarget = await realpath(target);
    assertInsideVault(vaultRoot, realTarget, "read derived claim");
    const info = await stat(realTarget);
    if (!info.isFile()) return { ...base, status: "unverifiable", reason: "not_a_file" };
    if (info.size > MAX_SOURCE_BYTES) return { ...base, status: "unverifiable", reason: "too_large" };

    const text = await readFile(realTarget, "utf8");
    return {
      ...base,
      status: "observed",
      value: countMarkdownNumberedList(text),
    };
  } catch (error) {
    const reason = error instanceof Error && error.message.includes("outside")
      ? "outside_vault"
      : "unavailable";
    return { ...base, status: "unverifiable", reason };
  }
}

function countMarkdownNumberedList(text: string): number {
  return text.split(/\r?\n/).filter((line) => /^\s*\d+[.)]\s+/.test(line)).length;
}
