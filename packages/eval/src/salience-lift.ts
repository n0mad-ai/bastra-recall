/**
 * Salience-Shadow-Auswertung (#217) — das Gate-Instrument für
 * BASTRA_SALIENCE_RANK=live (Disziplin wie #160: erst Lift-Nachweis,
 * dann Live-Schaltung).
 *
 * Joint `salience_shadow` (an recall/hook_recall-Events) mit den
 * recall_episodes derselben recall_id: Hätte die Shadow-Reihenfolge das
 * später tatsächlich engagierte Memory (loaded/acted_on) höher oder
 * niedriger platziert? Manueller Lauf, bewusst kein CI-Gate:
 *
 *   npm run salience-lift --workspace @bastra-recall/eval
 *   (optional: BASTRA_LOG_PATH=/pfad/zu/logs — dieselbe Env-Var wie der
 *   Telemetrie-Writer und alle Hook-CLIs)
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface ShadowHit {
  id: string;
  salience: number | null;
  rank: number;
  shadow_rank: number;
}

function logDir(): string {
  // Gleiche Auflösung wie telemetry.logDirFor: BASTRA_LOG_PATH (Legacy:
  // NEXUS_LOG_PATH), sonst migration-aware Default.
  const override = process.env.BASTRA_LOG_PATH ?? process.env.NEXUS_LOG_PATH;
  if (override) return override;
  const next = join(homedir(), ".bastra", "logs");
  const legacy = join(homedir(), ".nexus-recall", "logs");
  if (existsSync(next)) return next;
  return existsSync(legacy) ? legacy : next;
}

function readEvents(dir: string): Record<string, unknown>[] {
  if (!existsSync(dir)) return [];
  const events: Record<string, unknown>[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.startsWith("events-") && f.endsWith(".jsonl"))
    .sort()) {
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // halbe Zeile am File-Ende o.ä. — überspringen
      }
    }
  }
  return events;
}

const dir = logDir();
const events = readEvents(dir);

// recall_id → shadow-Hits (aus recall- und hook_recall-Events)
const shadows = new Map<string, ShadowHit[]>();
for (const e of events) {
  if ((e.kind === "recall" || e.kind === "hook_recall") && e.salience_shadow) {
    const shadow = e.salience_shadow as { hits?: ShadowHit[] };
    if (typeof e.recall_id === "string" && Array.isArray(shadow.hits)) {
      shadows.set(e.recall_id, shadow.hits);
    }
  }
}

// Engagement-Episoden derselben recall_id gegen die Shadow-Ränge halten.
let engaged = 0;
let improved = 0;
let worsened = 0;
let unchanged = 0;
for (const e of events) {
  if (e.kind !== "recall_episode") continue;
  const recallId = typeof e.recall_id === "string" ? e.recall_id : null;
  if (!recallId || !shadows.has(recallId)) continue;
  const actedOn = e.acted_on === true;
  const surfacedLoad = e.surfaced === true;
  if (!actedOn && !surfacedLoad) continue;
  const hit = shadows.get(recallId)!.find((h) => h.id === e.memory_id);
  if (!hit) continue;
  engaged += 1;
  if (hit.shadow_rank < hit.rank) improved += 1;
  else if (hit.shadow_rank > hit.rank) worsened += 1;
  else unchanged += 1;
}

console.log(`salience-lift (#217) — log dir: ${dir}`);
console.log(`shadow recalls: ${shadows.size}, engaged episodes joined: ${engaged}`);
if (engaged === 0) {
  console.log("no joined engagement yet — let the shadow log accumulate before gating live.");
} else {
  const pct = (n: number): string => `${((n / engaged) * 100).toFixed(1)}%`;
  console.log(`shadow would have ranked the engaged memory HIGHER: ${improved} (${pct(improved)})`);
  console.log(`shadow would have ranked the engaged memory LOWER:  ${worsened} (${pct(worsened)})`);
  console.log(`unchanged: ${unchanged} (${pct(unchanged)})`);
  console.log(
    improved > worsened
      ? "→ positive lift: candidates for BASTRA_SALIENCE_RANK=live (keep watching the margin)."
      : "→ no lift yet: keep shadow mode."
  );
}
