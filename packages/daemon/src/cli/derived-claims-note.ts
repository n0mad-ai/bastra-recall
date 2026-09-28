/**
 * The `derived_claims` note in `bastra doctor` (#609).
 *
 * `load_memory` re-checks a note's claims only when that note is loaded, so a
 * claim whose source has moved on stays invisible until somebody happens to
 * open it. This note runs the same read-only resolvers over every memory that
 * declares claims and says which ones no longer agree with their source.
 *
 * Like the other global notes: silent when no memory declares a claim, never a
 * failure, never throws, and it writes nothing — neither the note nor the
 * source. Stale (`differs`, `gone`) and `ambiguous` claims are listed by memory
 * id, capped at {@link MAX_LISTED}; `unverifiable` ones are only counted,
 * because a missing source is neutral under the #235 verdict discipline.
 */
import { Vault, type DerivedClaim } from "@bastra-recall/core";
import { resolveDerivedClaims, type DerivedClaimResult } from "../derived-claims.js";

/** Findings listed by name before the rest becomes a count. */
const MAX_LISTED = 5;

export interface ClaimedMemory {
  id: string;
  claims: readonly DerivedClaim[];
}

/** Everything the note needs from the outside, injectable for tests. */
export interface DerivedClaimsIo {
  memories: () => Promise<ClaimedMemory[]>;
  resolve: (claims: readonly DerivedClaim[]) => Promise<DerivedClaimResult[]>;
}

/** The lines the note prints, or an empty array when no memory declares a claim. */
export async function derivedClaimsLines(io: DerivedClaimsIo): Promise<string[]> {
  const memories = (await io.memories()).filter((m) => m.claims.length > 0);
  if (memories.length === 0) return [];

  let total = 0;
  let unverifiable = 0;
  const findings: string[] = [];
  for (const memory of memories) {
    for (const result of await io.resolve(memory.claims)) {
      total += 1;
      if (result.status === "unverifiable") unverifiable += 1;
      if (result.status === "differs" || result.status === "gone" || result.status === "ambiguous") {
        findings.push(`⚠ ${memory.id} → ${result.id}: ${describe(result)}`);
      }
    }
  }

  const lines = [
    `${total} claim${total === 1 ? "" : "s"} in ${memories.length} memor${memories.length === 1 ? "y" : "ies"}` +
      (findings.length === 0 ? " — none out of step with its source" : `, ${findings.length} out of step with its source`),
    ...findings.slice(0, MAX_LISTED),
  ];
  if (findings.length > MAX_LISTED) lines.push(`… and ${findings.length - MAX_LISTED} more`);
  if (unverifiable > 0) {
    lines.push(
      `${unverifiable} claim${unverifiable === 1 ? "" : "s"} could not be checked (source missing, outside the vault, not a file or over 1 MB)`,
    );
  }
  return lines;
}

function describe(result: DerivedClaimResult): string {
  if (result.status === "gone") return `quoted string no longer in ${result.source}`;
  if (result.status === "ambiguous") return `quoted string occurs ${result.value} times in ${result.source}`;
  if (result.resolver === "sha256.v1") return `${result.source} changed since the digest was recorded`;
  return `note says ${result.expect}, ${result.source} says ${result.value}`;
}

/** The default io: the configured vault, resolved with the load_memory resolvers. */
export function defaultDerivedClaimsIo(vaultPath: string): DerivedClaimsIo {
  return {
    memories: async () => {
      const vault = new Vault(vaultPath);
      await vault.init();
      return vault.list().map((m) => ({ id: m.fm.id, claims: m.fm.derived_claims ?? [] }));
    },
    resolve: (claims) => resolveDerivedClaims(vaultPath, claims),
  };
}
