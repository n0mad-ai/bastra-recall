/**
 * Bastra Commons on the backend side (#1518): where the clone lives, the
 * verification records and the ranking factor built from them. The daemon
 * (boot, recall ranking) reads these; the `bastra commons` CLI in
 * `cli/commons.ts` builds on them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { bastraDataDir } from "./platform-paths.js";

export function commonsPath(): string {
  return process.env.BASTRA_COMMONS_PATH ?? join(bastraDataDir(), "commons");
}

// Ein Verification-Record ist die kleinste Beweis-Einheit: "works/fails for
// me" + Umgebung. Ein Record pro Verifier+Rezept — die Datei wird bei
// Meinungsänderung überschrieben, die Historie liegt im git-Log (append-only
// durch git, nicht durch uns). Aus den Records entsteht die Hitlist: Status
// wird berechnet, nie vergeben.

export interface VerificationRecord {
  recipe_id: string;
  result: "works" | "fails";
  environment: { os: string; arch: string; node: string; note: string | null };
  verifier: string;
  date: string;
}

export function buildVerificationRecord(
  recipeId: string,
  result: "works" | "fails",
  note: string | null,
  verifier: string,
  date: string = new Date().toISOString().slice(0, 10)
): VerificationRecord {
  return {
    recipe_id: recipeId,
    result,
    environment: { os: platform(), arch: arch(), node: process.version, note },
    verifier,
    date,
  };
}

export function verificationRecordPath(rootDir: string, recipeId: string, verifier: string): string {
  return join(rootDir, "verifications", recipeId, `${verifier}.json`);
}

/** Liest alle Records unter <root>/verifications → counts pro Rezept-ID.
 *  Synchron + defensiv; der Daemon ruft das einmal beim Boot. */
export function loadVerificationCounts(rootDir: string): Map<string, { works: number; fails: number }> {
  const counts = new Map<string, { works: number; fails: number }>();
  const base = join(rootDir, "verifications");
  try {
    for (const recipeDir of readdirSync(base, { withFileTypes: true })) {
      if (!recipeDir.isDirectory()) continue;
      counts.set(recipeDir.name, countRecipeVerifications(join(base, recipeDir.name)));
    }
  } catch {
    /* no verifications dir yet */
  }
  return counts;
}

/** works/fails of one recipe's record directory; corrupt records are skipped. */
function countRecipeVerifications(recipeDir: string): { works: number; fails: number } {
  const entry = { works: 0, fails: 0 };
  for (const f of readdirSync(recipeDir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(recipeDir, f), "utf8")) as { result?: string };
      if (rec.result === "works") entry.works++;
      else if (rec.result === "fails") entry.fails++;
    } catch {
      /* skip corrupt record */
    }
  }
  return entry;
}

/** Evidenz → Ranking: Basis-Dämpfung 0.8 (persönliche Memories gewinnen),
 *  unabhängige works heben (bis +0.15), fails senken. Geclampt, damit ein
 *  Rezept nie über persönliche Hits hinaus geboostet wird oder ganz
 *  verschwindet — Abstieg ist sichtbar, nicht Zensur. */
export function commonsRankFactor(works: number, fails: number): number {
  const factor = 0.8 + Math.min(0.15, works * 0.05) - Math.min(0.25, fails * 0.08);
  return Math.max(0.5, Math.min(0.95, factor));
}
