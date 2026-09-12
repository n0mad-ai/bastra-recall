/**
 * Curator phase A (#155) — deterministic usage-driven staleness pass.
 *
 * Reads the usage sidecar (#154) and marks memories that keep getting
 * surfaced but never earn engagement as stale — a **score-only demotion**
 * (survival-by-id contract #146: no file move, no delete, load_memory
 * unaffected, the memory file stays byte-identical). State lives in
 * `<vault>/.bastra/curator/state.json`, next to the usage sidecar.
 *
 * No LLM anywhere: thresholds + protection classes only. Zero usage is
 * absence of evidence, not evidence of staleness — only memories with real
 * surfacing demand and no engagement are candidates. Floored/pinned memories
 * (#141/#142) and young memories are never touched. A real load/acted_on
 * after the demotion clears it on the next pass (reactivation).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { UsageAggregate } from "./usage-sidecar.js";

// ─── state store ─────────────────────────────────────────────────────────────

export interface StaleEntry {
  stale_since: string;
  reason: string;
}

export interface CuratorState {
  last_run_at?: string;
  /** When the usage sidecar started observing this vault — demotions are
   *  gated until a full engagement window of data exists (review find
   *  2026-07-03: 7 days of sidecar must not judge "no engagement in 30d"). */
  observed_since?: string;
  /** memory id → demotion record. Presence = score-only demotion active. */
  stale: Record<string, StaleEntry>;
  /** #217: memory id → ISO des letzten Reflex-Promotion-Vorschlags —
   *  Re-Nag-Schutz, der Curator schlägt dieselbe id max. 1×/30d vor. */
  reflex_suggested?: Record<string, string>;
  /** #217 Phase 3: Cluster-Key → ISO des letzten Konsolidierungs-Vorschlags. */
  consolidation_suggested?: Record<string, string>;
  /** #217 Intake-Adoption: memory id → ISO des letzten Adoption-Vorschlags —
   *  Re-Nag-Schutz analog reflex_suggested (max. 1×/30d pro Intake-Memory). */
  adoption_suggested?: Record<string, string>;
}

const CURATOR_DIR = join(".bastra", "curator");
const STATE_FILE = "state.json";

function statePath(vaultRoot: string): string {
  return join(vaultRoot, CURATOR_DIR, STATE_FILE);
}

export async function loadCuratorState(vaultRoot: string): Promise<CuratorState> {
  try {
    const parsed = JSON.parse(await readFile(statePath(vaultRoot), "utf8"));
    if (parsed && typeof parsed === "object" && typeof parsed.stale === "object" && parsed.stale !== null) {
      return parsed as CuratorState;
    }
  } catch {
    /* missing/corrupt = fresh state */
  }
  return { stale: {} };
}

export async function saveCuratorState(vaultRoot: string, state: CuratorState): Promise<void> {
  const dir = join(vaultRoot, CURATOR_DIR);
  await mkdir(dir, { recursive: true });
  // Zufallsanteil, nicht nur die PID (#532-Scan): ein Curator-Pass kann vom
  // 15-Minuten-Job und von POST /curator/run gleichzeitig laufen, und zwei
  // Pässe DESSELBEN Prozesses teilten sich sonst diese tmp-Datei.
  const tmp = join(dir, `${STATE_FILE}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(tmp, statePath(vaultRoot));
}

// ─── run gate ────────────────────────────────────────────────────────────────

export const CURATOR_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // ~7d
export const CURATOR_MIN_IDLE_MS = 10 * 60 * 1000; // no requests for 10min

/**
 * Cheap poll → real gate. Callers poll opportunistically (session start,
 * hourly tick); this decides. Pure — exported for tests.
 */
export function shouldRunCurator(i: {
  nowMs: number;
  lastRunAt?: string;
  /** Timestamp of the daemon's last served request (activity signal). */
  lastActivityMs?: number;
  intervalMs?: number;
  minIdleMs?: number;
}): boolean {
  const interval = i.intervalMs ?? CURATOR_INTERVAL_MS;
  const minIdle = i.minIdleMs ?? CURATOR_MIN_IDLE_MS;
  if (i.lastRunAt) {
    const last = Date.parse(i.lastRunAt);
    if (Number.isFinite(last) && i.nowMs - last < interval) return false;
  }
  // Idle guard: never race a busy session with an index-wide pass.
  if (i.lastActivityMs !== undefined && i.nowMs - i.lastActivityMs < minIdle) return false;
  return true;
}

// ─── decision (pure) ─────────────────────────────────────────────────────────

export interface CuratorMemoryFacts {
  id: string;
  /** ISO date the memory was created (frontmatter). */
  created?: string;
  floored: boolean;
  pinned: boolean;
  /** Referenced by hook config or other operational wiring — never demote. */
  protected: boolean;
}

export interface CuratorThresholds {
  /** Surfacing demand needed before absence-of-engagement means anything. */
  minSurfaced: number;
  /** Grace period for young memories (days since created). */
  minAgeDays: number;
  /** Engagement (loaded/acted_on) within this window keeps a memory fresh. */
  staleAfterDays: number;
}

export const DEFAULT_THRESHOLDS: CuratorThresholds = {
  minSurfaced: 3,
  minAgeDays: 14,
  staleAfterDays: 30,
};

export interface CuratorDecision {
  /** New demotions this run (id → reason). */
  demote: Record<string, string>;
  /** Previously-stale ids that earned engagement again — plus pruned ghosts
   *  (stale ids whose memory left the vault) and newly-protected ids. */
  reactivate: string[];
  /** Would-be demotions still inside the observation window: the sidecar has
   *  not watched long enough to judge absence of engagement. Report-only —
   *  never persisted, never demoted. */
  pendingObservation: Record<string, string>;
}

function daysBetween(nowMs: number, iso?: string): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  return (nowMs - t) / 86_400_000;
}

/**
 * The whole phase-A judgment, pure and deterministic — exported for tests.
 * Conservative by construction:
 *   protected/floored/pinned        → never touched; if currently stale →
 *                                     reactivated (protection wins over an
 *                                     earlier demotion)
 *   stale id no longer in the vault → reactivated (ghost pruning)
 *   observation window immature     → pendingObservation only, never demote
 *                                     ("no engagement in 30d" needs 30d of
 *                                     sidecar data to even be observable)
 *   age < minAgeDays                → young, grace period
 *   surfaced < minSurfaced          → no demand evidence (zero usage ≠ stale)
 *   loaded/acted_on within window   → engaged, never touched
 *   already stale                   → stays (idempotent), unless reactivated
 */
export function decideStale(i: {
  nowMs: number;
  facts: CuratorMemoryFacts[];
  usage: UsageAggregate;
  currentStale: Record<string, StaleEntry>;
  /** Epoch of the usage sidecar for this vault (ms). Undefined = unknown =
   *  window immature = nothing demotes. */
  observedSinceMs?: number;
  thresholds?: CuratorThresholds;
}): CuratorDecision {
  const t = i.thresholds ?? DEFAULT_THRESHOLDS;
  const decision: CuratorDecision = { demote: {}, reactivate: [], pendingObservation: {} };
  const windowMature =
    i.observedSinceMs !== undefined &&
    i.nowMs - i.observedSinceMs >= t.staleAfterDays * 86_400_000;

  // Ghost pruning: a stale entry whose memory left the vault (deleted,
  // trashed, re-filed under a new id) must not linger as a demotion forever.
  const factIds = new Set(i.facts.map((f) => f.id));
  for (const id of Object.keys(i.currentStale)) {
    if (!factIds.has(id)) decision.reactivate.push(id);
  }

  for (const m of i.facts) {
    const u = i.usage[m.id];
    const existing = i.currentStale[m.id];
    const isProtected = m.protected || m.floored || m.pinned;

    if (existing) {
      // Protection wins over an earlier demotion: flooring/pinning a stale
      // memory clears it (review find 2026-07-03 — the old order made this
      // unreachable).
      if (isProtected) {
        decision.reactivate.push(m.id);
        continue;
      }
      // Engagement after the demotion clears it — even for memories that
      // would re-qualify (they get a fresh observation window).
      const engagedAt = [u?.last_acted_on_at, u?.last_loaded_at].filter(Boolean).sort().pop();
      if (engagedAt && engagedAt > existing.stale_since) decision.reactivate.push(m.id);
      continue; // never re-demote in the same run; idempotent otherwise
    }

    if (isProtected) continue;
    const ageDays = daysBetween(i.nowMs, m.created);
    if (ageDays === undefined || ageDays < t.minAgeDays) continue;
    if (!u || u.surfaced < t.minSurfaced) continue;

    const actedDays = daysBetween(i.nowMs, u.last_acted_on_at);
    if (actedDays !== undefined && actedDays < t.staleAfterDays) continue;
    const loadedDays = daysBetween(i.nowMs, u.last_loaded_at);
    if (loadedDays !== undefined && loadedDays < t.staleAfterDays) continue;

    const lastEngagement = u.last_acted_on_at ?? u.last_loaded_at ?? "never";
    const reason = `surfaced ${u.surfaced}× without recent engagement (last: ${lastEngagement}) — context tax`;
    if (windowMature) decision.demote[m.id] = reason;
    else decision.pendingObservation[m.id] = reason;
  }
  return decision;
}

/** Apply a decision to state (pure). */
export function applyDecision(
  state: CuratorState,
  decision: CuratorDecision,
  nowIso: string,
): CuratorState {
  const stale: Record<string, StaleEntry> = { ...state.stale };
  for (const id of decision.reactivate) delete stale[id];
  for (const [id, reason] of Object.entries(decision.demote)) {
    stale[id] = { stale_since: nowIso, reason };
  }
  return { ...state, last_run_at: nowIso, stale };
}
