/**
 * Curator run orchestration (#155/#156) — joins the usage sidecar (#154),
 * the floor registry (#141/#142) and the in-RAM vault into one deterministic
 * pass: decide staleness (curator.ts), persist state, push the score-only
 * demotion set into the search index, and project the human review surface
 * as REPORT.md into the vault (vault-report.ts).
 *
 * Also home of the loopback HTTP handlers (POST /curator/run, GET
 * /curator/state) so http.ts — already past the file-size comfort line —
 * only grows by routing lines.
 */
import { scopeEquals } from "@bastra-recall/core/scope";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { listFloors } from "./floors.js";
import { writeVaultJournal } from "./vault-journal.js";
import { liveIntent, readActs } from "./floor-acts.js";
import { listSkills } from "./skills-registry.js";
import {
  applyDecision,
  decideStale,
  loadCuratorState,
  saveCuratorState,
  shouldRunCurator,
  type CuratorMemoryFacts,
  type CuratorState,
} from "./curator.js";
import { compactUsage, readUsage, type UsageAggregate } from "./usage-sidecar.js";
import { readEventLog, reconstructReaches, type TelemetryEvent } from "./learned-recall/harvest.js";
import { logDirFor } from "./telemetry.js";
import { writePendingSuggestion } from "./pending-suggestions.js";
import { envInt } from "./env.js";
import { collectClaimedTwice } from "./claimed-twice.js";
import { isMarkdownFile } from "@bastra-recall/core";
import {
  claimedTwiceReportLimit,
  writeVaultHealthReport,
  type ReportConflictCluster,
  type ReportDanglingLink,
  type ReportFloorEntry,
  type ReportStaleCandidate,
  type VaultHealthData,
} from "./vault-report.js";

/** Floors older than this without a real affirm land in the report. */
const FLOOR_REVIEW_WEEKS = 4;

// ─── #217: Reflex-Promotion + Konsolidierung (Vorschlags-Relay) ─────────────
// Der Curator VERDRAHTET nie selbst — er schreibt <reflex-candidate>- und
// <consolidation-candidate>-Blöcke in die Pending-Suggestions; der Agent der
// nächsten Session fragt den User, und erst dessen explizites Ja führt zum
// save_memory. Gleiche Relay-Mechanik wie <save-eval>/<taxonomy-drift>.

/** Dieselbe id/Cluster max. 1×/30d vorschlagen. */
const SUGGEST_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
/** Max. Reflex-Vorschläge pro Pass — die nächste Session soll nicht fluten. */
const REFLEX_MAX_PER_PASS = 2;
const ADOPTION_MAX_PER_PASS = 2;
/** Konsolidierung: Cluster-Mindestgröße + Mindestalter der Episoden. */
const CONSOLIDATION_MIN_CLUSTER = 3;
const CONSOLIDATION_MIN_AGE_DAYS = 30;

interface VaultLike {
  list(): Array<{
    fm: Record<string, unknown>;
    body?: string;
    /** #222 — set by the loader when it had to repair a field to keep the
     *  memory in the index. Optional here so the test doubles in this file's
     *  suite stay minimal. */
    damaged?: Array<{ field: string; reason: string }>;
    filePath?: string;
  }>;
  get(id: string): { fm: Record<string, unknown> } | undefined;
  size(): number;
}

/** `[[target]]` / `[[target|label]]` / `[[target#heading]]` in a body. */
const BODY_WIKILINK_RE = /\[\[([^\]|#\n]+)/g;

export interface CuratorRunDeps {
  vaultRoot: string;
  vault: VaultLike;
  /** SearchIndex.setDemotions — the engine side of the score-only demotion. */
  setDemotions: (ids: Iterable<string>) => void;
}

export interface CuratorRunResult {
  ran: boolean;
  skipped?: "interval" | "busy";
  /** "acting" persisted demotions; "review-first" wrote only report +
   *  last_run_at (the very first pass never demotes — a human gets a full
   *  interval to read REPORT.md before anything acts); "dry-run" persisted
   *  nothing at all. */
  mode: "acting" | "review-first" | "dry-run";
  dryRun: boolean;
  demoted: string[];
  reactivated: string[];
  /** Would-be demotions still inside the observation window (report-only). */
  pendingObservation: string[];
  staleTotal: number;
  reportWritten: boolean;
  /** #288: months whose journal projection was (re)written this pass. */
  journalMonths?: string[];
  /** Set when the pass failed internally (never thrown — see contract). */
  error?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function collectFacts(vault: VaultLike, flooredIds: Set<string>): CuratorMemoryFacts[] {
  const facts: CuratorMemoryFacts[] = [];
  for (const mem of vault.list()) {
    const id = str(mem.fm.id);
    if (!id) continue;
    facts.push({
      id,
      created: str(mem.fm.created),
      floored: flooredIds.has(id),
      // No pin source exists beyond floors today — the class stays explicit
      // so future sources slot in.
      pinned: false,
      // Protected classes (review find 2026-07-03): documents have no
      // engagement path (read_document records no usage — they would demote
      // deterministically AND stack with DOC_TYPE_DAMPING to 0.25); taxonomy
      // conventions are injected via <vault-taxonomy>, not load_memory, so
      // they are equally engagement-blind. user-directed memories (#158) are
      // untouchable for automated lifecycle passes by definition.
      protected:
        mem.fm.type === "doc" ||
        scopeEquals(String(mem.fm.scope ?? ""), "taxonomy") ||
        mem.fm.write_origin === "user-directed",
    });
  }
  return facts;
}

// ─── report data collection ──────────────────────────────────────────────────

function collectStaleCandidates(
  vault: VaultLike,
  state: CuratorState,
  usage: UsageAggregate,
): ReportStaleCandidate[] {
  return Object.entries(state.stale)
    .map(([id, entry]) => ({
      id,
      title: str(vault.get(id)?.fm.title),
      usage: usage[id],
      entry,
    }))
    .sort((a, b) => (b.usage?.surfaced ?? 0) - (a.usage?.surfaced ?? 0));
}

async function collectFloorReview(vault: VaultLike, nowMs: number): Promise<ReportFloorEntry[]> {
  const [floors, acts] = await Promise.all([listFloors(), readActs()]);
  const out: ReportFloorEntry[] = [];
  for (const f of floors) {
    // #198: the act log answers "when was this last affirmed", not the
    // registry row. Staleness is measured on the INTENT clock — a replay
    // delivered yesterday of an affirm meant ten weeks ago leaves the floor
    // ten weeks stale, which is exactly the row this section exists to raise.
    const live = liveIntent(f.memory_id, f.floored_at, acts, f);
    const affirmedMs = Date.parse(live.occurred_at ?? live.recorded);
    if (!Number.isFinite(affirmedMs)) continue;
    const weeks = Math.floor((nowMs - affirmedMs) / (7 * 86_400_000));
    if (weeks < FLOOR_REVIEW_WEEKS) continue;
    out.push({
      memory_id: f.memory_id,
      title: str(vault.get(f.memory_id)?.fm.title),
      reason: f.reason,
      floored_at: f.floored_at,
      last_affirmed: live.occurred_at ?? live.recorded,
      affirmed_by: live.affirmed_by,
      why: live.why,
      weeksSinceAffirm: weeks,
      neverReaffirmed: live.never_reaffirmed,
    });
  }
  return out.sort((a, b) => b.weeksSinceAffirm - a.weeksSinceAffirm);
}

function collectConflictsAndDangling(vault: VaultLike, skillIds: Set<string> = new Set()): {
  conflicts: ReportConflictCluster[];
  dangling: ReportDanglingLink[];
} {
  const members = vault.list();
  const ids = new Set<string>();
  for (const m of members) {
    const id = str(m.fm.id);
    if (id) ids.add(id);
  }

  const byTopic = new Map<string, string[]>();
  const dangling: ReportDanglingLink[] = [];
  for (const m of members) {
    const id = str(m.fm.id);
    if (!id || m.fm.obsolete === true) continue;

    const tp = Array.isArray(m.fm.topic_path) ? (m.fm.topic_path as string[]) : [];
    if (tp.length > 0) {
      const key = tp.join("\u0000");
      const bucket = byTopic.get(key) ?? [];
      bucket.push(id);
      byTopic.set(key, bucket);
    }

    const targets = new Set<string>();
    if (Array.isArray(m.fm.related)) for (const r of m.fm.related) if (typeof r === "string") targets.add(r);
    if (Array.isArray(m.fm.related_via)) {
      for (const rv of m.fm.related_via as Array<{ id?: unknown }>) {
        if (rv && typeof rv.id === "string") targets.add(rv.id);
      }
    }
    // Body wikilinks too: save_memory mirrors them into related[], but
    // Obsidian hand-edits never pass through the save path (review find
    // 2026-07-03) — without this the section reads "all clean" wrongly.
    if (typeof m.body === "string") {
      for (const match of m.body.matchAll(BODY_WIKILINK_RE)) {
        const t = match[1]?.trim();
        if (t) targets.add(t);
      }
    }
    for (const t of targets) {
      // Declared skills (#215) live on another surface by design — a link to
      // one is a reference, not a dangling link to fix.
      if (!ids.has(t) && !skillIds.has(t)) dangling.push({ fromId: id, target: t });
    }
  }

  const conflicts: ReportConflictCluster[] = [];
  for (const [key, memberIds] of byTopic) {
    if (memberIds.length >= 2) conflicts.push({ topicPath: key.split("\u0000"), memberIds: memberIds.sort() });
  }
  conflicts.sort((a, b) => b.memberIds.length - a.memberIds.length);
  return { conflicts, dangling };
}

/** #147: captures whose sidecar carries injection_flags from the ingest scan. */
function collectFlaggedCaptures(vault: VaultLike): Array<{ id: string; title?: string; flags: string[] }> {
  const out: Array<{ id: string; title?: string; flags: string[] }> = [];
  for (const m of vault.list()) {
    const id = str(m.fm.id);
    const flags = Array.isArray(m.fm.injection_flags)
      ? (m.fm.injection_flags as unknown[]).filter((f): f is string => typeof f === "string")
      : [];
    if (id && flags.length > 0) out.push({ id, title: str(m.fm.title), flags });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * #222: memories the loader repaired to keep them in the index. `Memory.damaged`
 * is set at parse time and never written back to disk, so this report section
 * is the only surface where the degradation is visible — the alternative was a
 * `console.warn` on a daemon stderr nobody reads, which is how 28 dropped files
 * went unnoticed in the first place.
 */
function collectDamagedFrontmatter(
  vault: VaultLike,
  vaultRoot: string,
): Array<{ id: string; title?: string; path: string; fields: Array<{ field: string; reason: string }> }> {
  const out: Array<{ id: string; title?: string; path: string; fields: Array<{ field: string; reason: string }> }> = [];
  for (const m of vault.list()) {
    const id = str(m.fm.id);
    if (!id || !m.damaged || m.damaged.length === 0) continue;
    const full = m.filePath ?? "";
    const rel = full.startsWith(vaultRoot) ? full.slice(vaultRoot.length).replace(/^[/\\]/, "") : full;
    out.push({ id, title: str(m.fm.title), path: rel, fields: m.damaged });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 0-byte .md files anywhere in the vault (dotfolders excluded) — typically
 * Obsidian's auto-created empty notes from clicking an unresolved wikilink
 * (e.g. a bastra doc-id link; real-vault find 2026-07-04). Best-effort:
 * returns [] on any error.
 */
async function collectEmptyFiles(vaultRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(vaultRoot, { recursive: true, withFileTypes: true });
    const empty: string[] = [];
    for (const e of entries) {
      // Dieselbe Extension-Regel wie der Vault-Index (Codex-Befund 7):
      // eine leere `.MD` ist genauso eine leere Obsidian-Notiz.
      if (!e.isFile() || !isMarkdownFile(e.name)) continue;
      const rel = relative(vaultRoot, join(e.parentPath, e.name));
      if (rel.split(sep).some((part) => part.startsWith("."))) continue;
      try {
        if ((await stat(join(vaultRoot, rel))).size === 0) empty.push(rel);
      } catch {
        /* raced deletion — skip */
      }
    }
    return empty.sort();
  } catch {
    return [];
  }
}

// ─── the pass ────────────────────────────────────────────────────────────────

/**
 * One curator pass. `force` skips the interval/idle gate (manual trigger),
 * `dryRun` decides + reports but persists nothing and demotes nothing —
 * REPORT.md then shows what WOULD happen (the #156 review-first default for
 * a first run on a real vault).
 */
export async function runCuratorPass(
  deps: CuratorRunDeps,
  opts: { force?: boolean; dryRun?: boolean; lastActivityMs?: number; nowMs?: number } = {},
): Promise<CuratorRunResult> {
  // Never-throws contract: a broken curator must never take the daemon down
  // (the 15-min tick has no business crashing MCP service).
  try {
    return await runCuratorPassInner(deps, opts);
  } catch (err) {
    return {
      ran: false,
      mode: opts.dryRun ? "dry-run" : "acting",
      dryRun: opts.dryRun ?? false,
      demoted: [],
      reactivated: [],
      pendingObservation: [],
      staleTotal: 0,
      reportWritten: false,
      error: (err as Error)?.message ?? String(err),
    };
  }
}

/**
 * #217 Phase 2: Reflex-Kandidaten aus der Telemetrie — Memories, die im
 * Fenster wiederholt (≥ BASTRA_REFLEX_PROMOTION_MIN, default 3) nach einem
 * Recall acted_on waren und noch nicht reflex sind. `events` ist für Tests
 * injizierbar; default liest das echte Event-Log (30 Tage).
 */
export async function collectReflexCandidates(
  vault: VaultLike,
  state: CuratorState,
  nowMs: number,
  events?: TelemetryEvent[],
): Promise<{ id: string; title: string; count: number }[]> {
  // logDirFor (nicht der harvest-Default): honoriert NEXUS_LOG_PATH + das
  // Legacy-Verzeichnis ~/.nexus-recall/logs — sonst liest die Promotion auf
  // Migrations-Layouts ein leeres Verzeichnis (Review-Finding #217).
  const evts = events ?? (await readEventLog(logDirFor(), 30));
  const counts = new Map<string, number>();
  for (const r of reconstructReaches(evts)) {
    counts.set(r.memoryId, (counts.get(r.memoryId) ?? 0) + 1);
  }
  const min = Math.max(1, envInt("BASTRA_REFLEX_PROMOTION_MIN", 3));
  const out: { id: string; title: string; count: number }[] = [];
  for (const [id, count] of counts) {
    if (count < min) continue;
    const mem = vault.get(id);
    if (!mem) continue;
    if (mem.fm.recall_mode === "reflex") continue;
    const suggestedAt = state.reflex_suggested?.[id];
    if (suggestedAt && nowMs - Date.parse(suggestedAt) < SUGGEST_COOLDOWN_MS) continue;
    out.push({ id, title: str(mem.fm.title) ?? id, count });
  }
  out.sort((a, b) => b.count - a.count);
  return out.slice(0, REFLEX_MAX_PER_PASS);
}

export function formatReflexCandidateBlock(c: { id: string; title: string; count: number }): string {
  return [
    `<reflex-candidate memory-id="${c.id}" evidence="${c.count} acted-on recalls in 30d">`,
    `Ask the user whether to promote "${c.title}" to reflex recall — it would ` +
      `then self-inject (budgeted, max 2/turn) whenever one of its recall_when ` +
      `triggers hard-matches a prompt. ONLY on an explicit yes: load_memory` +
      `("${c.id}"), then save_memory with overwrite:true, the unchanged fields ` +
      `and recall_mode:"reflex". Never promote without explicit confirmation.`,
    `</reflex-candidate>`,
  ].join("\n");
}

/**
 * #217 Phase 3: episodische Häufungen — ≥3 project-facts gleicher
 * scope+topic_path[0..1], alle älter als 30 Tage, nicht obsolete, nicht
 * user-directed (Schutzklasse wie bei Demotions). Liefert max. 1 Cluster
 * pro Pass; die Destillation zur Lesson macht der Agent MIT dem User.
 */
export function collectConsolidationCandidates(
  vault: VaultLike,
  state: CuratorState,
  nowMs: number,
): { key: string; label: string; scope: string; ids: string[] }[] {
  const clusters = new Map<string, { label: string; scope: string; ids: string[] }>();
  const cutoffMs = nowMs - CONSOLIDATION_MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
  for (const mem of vault.list()) {
    const fm = mem.fm;
    if (fm.type !== "project-fact") continue;
    if (fm.obsolete === true) continue;
    if (fm.write_origin === "user-directed") continue;
    const id = str(fm.id);
    const scope = str(fm.scope);
    if (!id || !scope) continue;
    const createdMs = Date.parse(String(fm.created ?? ""));
    if (!Number.isFinite(createdMs) || createdMs > cutoffMs) continue;
    const tp = Array.isArray(fm.topic_path) ? fm.topic_path.slice(0, 2).map(String) : [];
    // "\0"-Join wie collectConflictsAndDangling: Segmente mit "/" dürfen
    // nicht mit gesplitteten Varianten kollidieren.
    const key = [scope, ...tp].join("\u0000");
    const cluster = clusters.get(key) ?? { label: [scope, ...tp].join(" / "), scope, ids: [] };
    cluster.ids.push(id);
    clusters.set(key, cluster);
  }
  const out: { key: string; label: string; scope: string; ids: string[] }[] = [];
  for (const [key, c] of clusters) {
    if (c.ids.length < CONSOLIDATION_MIN_CLUSTER) continue;
    const suggestedAt = state.consolidation_suggested?.[key];
    if (suggestedAt && nowMs - Date.parse(suggestedAt) < SUGGEST_COOLDOWN_MS) continue;
    out.push({ key, label: c.label, scope: c.scope, ids: c.ids.sort() });
  }
  // größter Cluster zuerst; nur einer pro Pass wird vorgeschlagen
  out.sort((a, b) => b.ids.length - a.ids.length);
  return out;
}

/**
 * #217 Intake-Adoption: importierte Memories (topic_path[0]==="imported"),
 * die im 30-Tage-Fenster wiederholt acted_on waren, aber nie ins Vollformat
 * adoptiert wurden. Gleiche Telemetrie-Mechanik wie die Reflex-Promotion
 * (readEventLog + reconstructReaches), eigener Cooldown-Topf. Der Vorschlag
 * landet als <adoption-candidate> im Pending-Relay — adoptieren tut der
 * Agent MIT dem User, nie der Daemon.
 */
export async function collectAdoptionCandidates(
  vault: VaultLike,
  state: CuratorState,
  nowMs: number,
  events?: TelemetryEvent[],
): Promise<{ id: string; title: string; count: number }[]> {
  const evts = events ?? (await readEventLog(logDirFor(), 30));
  const counts = new Map<string, number>();
  for (const r of reconstructReaches(evts)) {
    counts.set(r.memoryId, (counts.get(r.memoryId) ?? 0) + 1);
  }
  const min = Math.max(1, envInt("BASTRA_ADOPTION_PROMOTION_MIN", 2));
  const out: { id: string; title: string; count: number }[] = [];
  for (const [id, count] of counts) {
    if (count < min) continue;
    const mem = vault.get(id);
    if (!mem) continue;
    const fm = mem.fm;
    if (fm.obsolete === true) continue;
    const tp = Array.isArray(fm.topic_path) ? fm.topic_path : [];
    if (String(tp[0] ?? "") !== "imported") continue;
    const suggestedAt = state.adoption_suggested?.[id];
    if (suggestedAt && nowMs - Date.parse(suggestedAt) < SUGGEST_COOLDOWN_MS) continue;
    out.push({ id, title: str(fm.title) ?? id, count });
  }
  out.sort((a, b) => b.count - a.count);
  return out.slice(0, ADOPTION_MAX_PER_PASS);
}

export function formatAdoptionCandidateBlock(c: { id: string; title: string; count: number }): string {
  return [
    `<adoption-candidate memory-id="${c.id}" evidence="${c.count} acted-on recalls in 30d">`,
    `The imported intake memory "${c.title}" keeps proving useful. With the ` +
      `user's ok, adopt it into the real vault: load_memory("${c.id}") and READ ` +
      `it, then save_memory a full-format version (real type, the scope it ` +
      `actually belongs to, recall_when from the situations it fired in, ` +
      `[[links]] to related memories, source: "migrated:${c.id}"), and finish ` +
      `with archive_memory({id: "${c.id}", superseded_by: "<new-id>"}). ` +
      // #232: the gate names its own reference file — the rules AROUND the
      // adoption (one per turn, never adopt a body you did not read) live there.
      `The skill's intake.md has the surrounding rules. ` +
      `Skip silently if the user declines.`,
    `</adoption-candidate>`,
  ].join("\n");
}

export function formatConsolidationBlock(c: { label: string; scope: string; ids: string[] }): string {
  return [
    `<consolidation-candidate scope="${c.scope}" ids="${c.ids.join(",")}">`,
    `These ${c.ids.length} project-facts share the topic "${c.label}" and are ` +
      `all older than ${CONSOLIDATION_MIN_AGE_DAYS} days — episodic memory ready for semantic ` +
      `consolidation. With the user: load the members, distill ONE lesson ` +
      `that captures the durable pattern (link each episode via [[id]] ` +
      `wikilinks), save it, and leave the episodes in place — the curator ` +
      `handles their decay. Skip silently if the user declines.`,
    `</consolidation-candidate>`,
  ].join("\n");
}

async function runCuratorPassInner(
  deps: CuratorRunDeps,
  opts: { force?: boolean; dryRun?: boolean; lastActivityMs?: number; nowMs?: number },
): Promise<CuratorRunResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const state = await loadCuratorState(deps.vaultRoot);
  const dryRun = opts.dryRun ?? false;

  if (!opts.force) {
    if (!shouldRunCurator({ nowMs, lastRunAt: state.last_run_at, lastActivityMs: opts.lastActivityMs })) {
      const busy =
        opts.lastActivityMs !== undefined && nowMs - opts.lastActivityMs < 10 * 60 * 1000;
      return {
        ran: false,
        skipped: busy ? "busy" : "interval",
        mode: dryRun ? "dry-run" : "acting",
        dryRun,
        demoted: [],
        reactivated: [],
        pendingObservation: [],
        staleTotal: Object.keys(state.stale).length,
        reportWritten: false,
      };
    }
  }

  await compactUsage(deps.vaultRoot);
  const usage = await readUsage(deps.vaultRoot);
  const floors = await listFloors();
  const facts = collectFacts(deps.vault, new Set(floors.map((f) => f.memory_id)));

  // Observation epoch: demotions need a full engagement window of sidecar
  // data ("no engagement in 30d" is unobservable from 7 days of records).
  // Stamped on the first persisting pass; a legacy state without it counts
  // as immature this run and matures from now on.
  const nowIso = new Date(nowMs).toISOString();
  const observedSince = state.observed_since ?? nowIso;
  const observedSinceMs = Date.parse(observedSince);

  const decision = decideStale({
    nowMs,
    facts,
    usage,
    currentStale: state.stale,
    observedSinceMs: Number.isFinite(observedSinceMs) ? observedSinceMs : undefined,
  });
  const nextState = applyDecision({ ...state, observed_since: observedSince }, decision, nowIso);

  // Review-first (#155 acceptance: "first run … manual review of the report"):
  // the very first non-dry pass writes REPORT.md and starts the interval
  // clock but demotes NOTHING — a human gets a full interval to review
  // before the curator ever acts.
  const firstEverRun = !state.last_run_at;
  const mode: CuratorRunResult["mode"] = dryRun ? "dry-run" : firstEverRun ? "review-first" : "acting";
  if (mode === "acting") {
    // #217: Vorschlags-Relay (nie stilles Selbst-Verdrahten) — Reflex-
    // Kandidaten + Konsolidierungs-Cluster für die nächste Session, mit
    // Cooldown-Stempel im State. Best-effort: ein Relay-Fehler bricht den
    // Pass nicht.
    try {
      const blocks: string[] = [];
      for (const c of await collectReflexCandidates(deps.vault, nextState, nowMs)) {
        blocks.push(formatReflexCandidateBlock(c));
        nextState.reflex_suggested = { ...(nextState.reflex_suggested ?? {}), [c.id]: nowIso };
      }
      for (const c of await collectAdoptionCandidates(deps.vault, nextState, nowMs)) {
        blocks.push(formatAdoptionCandidateBlock(c));
        nextState.adoption_suggested = { ...(nextState.adoption_suggested ?? {}), [c.id]: nowIso };
      }
      const cluster = collectConsolidationCandidates(deps.vault, nextState, nowMs)[0];
      if (cluster) {
        blocks.push(formatConsolidationBlock(cluster));
        nextState.consolidation_suggested = {
          ...(nextState.consolidation_suggested ?? {}),
          [cluster.key]: nowIso,
        };
      }
      if (blocks.length > 0) await writePendingSuggestion(blocks.join("\n"));
    } catch {
      /* suggestions are best-effort */
    }
    await saveCuratorState(deps.vaultRoot, nextState);
    deps.setDemotions(Object.keys(nextState.stale));
  } else if (mode === "review-first") {
    await saveCuratorState(deps.vaultRoot, { ...state, observed_since: observedSince, last_run_at: nowIso });
  }

  const data: VaultHealthData = {
    generatedAt: nowIso,
    vaultSize: deps.vault.size(),
    stale: collectStaleCandidates(deps.vault, nextState, usage),
    pending: Object.entries(decision.pendingObservation).map(([id, reason]) => ({
      id,
      title: str(deps.vault.get(id)?.fm.title),
      usage: usage[id],
      reason,
    })),
    floors: await collectFloorReview(deps.vault, nowMs),
    ...collectConflictsAndDangling(deps.vault, new Set((await listSkills()).map((s) => s.id))),
    // #360: the claim gate holds new saves; this is the same question asked of
    // everything written before the gate existed.
    claimedTwice: collectClaimedTwice(deps.vault, claimedTwiceReportLimit()),
    emptyFiles: await collectEmptyFiles(deps.vaultRoot),
    flagged: collectFlaggedCaptures(deps.vault),
    damaged: collectDamagedFrontmatter(deps.vault, deps.vaultRoot),
    ...(mode !== "acting" ? { pendingReview: true } : {}),
  };
  const reportWritten = await writeVaultHealthReport(deps.vaultRoot, data);
  // #288: monthly journal projection of the audit log — same cadence as the
  // report, best-effort like it (writeVaultJournal never throws).
  const journalMonths = await writeVaultJournal(deps.vaultRoot);

  return {
    ran: true,
    mode,
    dryRun,
    demoted: Object.keys(decision.demote),
    reactivated: decision.reactivate,
    pendingObservation: Object.keys(decision.pendingObservation),
    staleTotal: mode === "acting" ? Object.keys(nextState.stale).length : Object.keys(state.stale).length,
    reportWritten,
    journalMonths,
  };
}

// ─── loopback HTTP handlers (routed from http.ts) ────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

/** GET /curator/state — last run + active demotions (loopback, read-only). */
export function handleCuratorState(_req: IncomingMessage, res: ServerResponse, deps: CuratorRunDeps): void {
  loadCuratorState(deps.vaultRoot)
    .then((state) => sendJson(res, 200, {
      last_run_at: state.last_run_at ?? null,
      stale_count: Object.keys(state.stale).length,
      stale: state.stale,
    }))
    .catch(() => sendJson(res, 200, { last_run_at: null, stale_count: 0, stale: {} }));
}

/**
 * POST /curator/run {force?, dryRun?} — manual trigger (loopback). Defaults
 * to dryRun:true: a hand-triggered run is a review request, not consent to
 * demote — the periodic pass is the acting path.
 */
/**
 * HTTP boundary sanitizer (CodeQL js/stack-trace-exposure, alert #23):
 * runCuratorPass is never-throw and carries the exception detail in
 * `result.error` — useful for the daemon log (index.ts tick), but it must
 * not reach an HTTP response. Loopback-only today; the hygiene rule holds
 * regardless of audience. Exported for tests.
 */
export function sanitizeRunResultForHttp(
  result: CuratorRunResult,
): { status: number; body: CuratorRunResult } {
  if (!result.error) return { status: 200, body: result };
  return { status: 500, body: { ...result, error: "curator run failed — see daemon log" } };
}

export function handleCuratorRun(req: IncomingMessage, res: ServerResponse, deps: CuratorRunDeps): void {
  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
  req.on("end", () => {
    let body: { force?: boolean; dryRun?: boolean } = {};
    try { body = raw.trim() ? JSON.parse(raw) : {}; } catch { /* defaults */ }
    runCuratorPass(deps, { force: body.force ?? true, dryRun: body.dryRun ?? true })
      .then((result) => {
        if (result.error) console.error(`[bastra-recall] /curator/run failed: ${result.error}`);
        const { status, body: payload } = sanitizeRunResultForHttp(result);
        sendJson(res, status, payload);
      })
      .catch(() => {
        // Unreachable by contract (runCuratorPass never throws) — and
        // deliberately detail-free if it ever happens anyway.
        sendJson(res, 500, { error: "curator run failed — see daemon log" });
      });
  });
}
