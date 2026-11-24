/**
 * HTTP client half of the session-start hook — every call the hook makes to
 * the local daemon (session context, floors, taxonomy, care/import counts, onboarding
 * flag, health probe) plus the request/response shapes. Split out of
 * session-hook.ts (file-size convention).
 *
 * Same discipline as the hook itself: hard per-call timeout, fail-silent on
 * every error path — an unreachable daemon must never break a session start.
 * The hook-CLI import rule (#305) applies here too: node stdlib and sibling
 * leafs only, never the @bastra-recall/core barrel. The transport itself is
 * the shared loopback helper (#1508).
 */
import { getJson, postJson } from "./prompt-loopback.js";
import type { HookRecallResponse as RecallResponse } from "./hook-recall-response.js";
import type { PinnedFloorLean } from "./pinned-block.js";
import type { KernelCandidates } from "./rule-kernel.js";

// P0: der Transporttyp kannte den Score-Modus nicht — `score_kind`/`unfused`
// fielen beim Parsen still weg, und die SessionStart-Lane bandete danach rohe
// BM25-Werte mit Cuts, die nur auf der fusionierten Skala existieren. Jetzt
// derselbe Typ wie in allen anderen Lanes.
export type { HookRecallHit as RecallHit, HookRecallResponse as RecallResponse } from "./hook-recall-response.js";

export interface UpdateAvailable {
  current: string;
  latest: string;
  html_url: string;
  published_at: string;
}

export interface HealthResponse {
  ok: boolean;
  update_available: UpdateAvailable | null;
}

export interface ConventionLean {
  id: string;
  title: string;
  summary: string;
  updated: string;
}

interface TaxonomyResponse {
  conventions: ConventionLean[];
}

/**
 * Die Antwort des projektbewussten Session-Assemblers (#265).
 *
 * Nur die Felder, die die Lane liest. `context` und `vault_size` ignoriert sie
 * bewusst — sie rendert ihr Dokument selbst, mit Banding und eigenen Mengen.
 */
export interface SessionContextResponse {
  data?: {
    recalls?: Array<{ scope: string; resp: RecallResponse | null }>;
    floors?: PinnedFloorLean[];
    conventions?: ConventionLean[];
    care?: { open: number; queued: number };
    imports?: { open: number; queued: number };
    onboarding?: boolean;
    /** #1603: the one-line mention instead of the interview. */
    onboarding_line?: boolean;
    /** #1305: present when the lane asked for the rule kernel; null when it failed. */
    kernel?: KernelCandidates | null;
  };
}

/**
 * EIN Aufruf statt sechs (#265, §26.1).
 *
 * Die Lane holte Recalls, Floors, Taxonomie, Care, Import und Onboarding in
 * sechs einzelnen Loopback-Requests. Der Assembler erhebt dasselbe serverseitig
 * und nebenläufig; hier bleibt der Transport. Gleiche Disziplin wie
 * die Lane-Recalls: harter Timeout, Fehler nach oben, der Aufrufer entscheidet.
 */
export function postSessionContext(
  baseUrl: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<SessionContextResponse> {
  return postJson<SessionContextResponse>(
    baseUrl,
    "/hook/session-context",
    { ...body, assembly_only: true },
    timeoutMs
  );
}

export async function fetchTaxonomy(baseUrl: string, timeoutMs: number): Promise<ConventionLean[]> {
  const data = await getJson<TaxonomyResponse | null>(baseUrl, "/hook/taxonomy", timeoutMs);
  return Array.isArray(data?.conventions) ? data.conventions : [];
}

interface FloorsResponse {
  floors: PinnedFloorLean[];
}

/**
 * Floor-Registry-Fetch (#141/#142). Gleiche Disziplin wie fetchTaxonomy:
 * fail-silent, ein GET, hartes Timeout — der Daemon joint id→title/summary
 * bereits serverseitig (/hook/floors), die Hook-CLI bleibt dumm. Mit Projekt
 * wird scope=<project> angefragt (Daemon liefert scoped + unscoped).
 */
export async function fetchFloors(
  baseUrl: string,
  project: string | null,
  timeoutMs: number
): Promise<PinnedFloorLean[]> {
  // URLSearchParams encodes like `url.searchParams.set` did before #1508.
  const path = project ? `/hook/floors?${new URLSearchParams({ scope: project })}` : "/hook/floors";
  const data = await getJson<FloorsResponse | null>(baseUrl, path, timeoutMs);
  return Array.isArray(data?.floors) ? data.floors : [];
}

export async function probeHealth(baseUrl: string, timeoutMs: number): Promise<HealthResponse | null> {
  const data = await getJson<HealthResponse | null>(baseUrl, "/health", timeoutMs);
  return data && data.ok ? data : null;
}
