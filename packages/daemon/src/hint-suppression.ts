/**
 * #479 — live cross-session circuit breaker for repeatedly ignored hints.
 *
 * It applies only to automatic hook injection. Manual recall/load is never
 * filtered, directive memories and explicit reflex wiring are exempt, and a
 * content/trigger edit changes the revision hash and starts a clean trial.
 */
import { createHash } from "node:crypto";
import { envFirst, envInt } from "./env.js";
import type { UsageAggregate } from "./usage-sidecar.js";

const DIRECTIVE_TYPES = new Set(["preference", "user-preference", "meta-working", "workflow"]);

export interface HintMemory {
  fm: {
    title?: unknown;
    type?: unknown;
    summary?: unknown;
    recall_when?: unknown;
    recall_mode?: unknown;
    updated?: unknown;
  };
  body: string;
}

export interface SuppressibleHit {
  id: string;
  type: string;
}

export interface SuppressedHint {
  id: string;
  type: string;
  surfaced: number;
  tokens_est: number;
}

export type HintSuppressionMode = "off" | "shadow" | "live";

/**
 * #484: the breaker decides on explicit loads alone — `acted_on` can never be
 * the deciding half, because it is only ever written for memories that went
 * through the load path (telemetry.ts matchLoadedMemories iterates
 * `loadedMemories`). Since #478 established that loaded/surfaced is a lower
 * bound — a hint can be read and followed inside the injected block without
 * the note ever being opened — removing on that basis cuts a class of hints
 * that were in fact used. Default is `shadow`: count and report what WOULD be
 * removed, remove nothing.
 */
export function hintSuppressionMode(): HintSuppressionMode {
  const raw = (envFirst("BASTRA_HINT_SUPPRESS") ?? "shadow").toLowerCase();
  return raw === "off" || raw === "live" ? raw : "shadow";
}

/** Eight actual emissions means eight sessions under the per-session MAX_SHOW=1 guard. */
export function hintSuppressionThreshold(): number {
  return Math.max(0, envInt("BASTRA_HINT_SUPPRESS_AFTER", 8));
}

/** Hash only fields that can change what the injected hint says or when it fires. */
export function hintRevision(memory: HintMemory | undefined): string | undefined {
  if (!memory) return undefined;
  const fm = memory.fm;
  return createHash("sha1")
    .update(JSON.stringify({
      updated: fm.updated,
      title: fm.title,
      type: fm.type,
      summary: fm.summary,
      recall_when: fm.recall_when,
      body: memory.body,
    }))
    .digest("hex");
}

export function suppressRepeatedUnused<T extends SuppressibleHit>(
  hits: T[],
  memoryOf: (id: string) => HintMemory | undefined,
  usage: UsageAggregate,
  threshold = hintSuppressionThreshold(),
  tokenEstimate: (hit: T) => number = () => 0,
): { kept: T[]; suppressed: SuppressedHint[] } {
  if (threshold <= 0) return { kept: hits, suppressed: [] };
  const kept: T[] = [];
  const suppressed: SuppressedHint[] = [];
  for (const hit of hits) {
    const memory = memoryOf(hit.id);
    const entry = usage[hit.id];
    const revision = hintRevision(memory);
    const directive = DIRECTIVE_TYPES.has(String(memory?.fm.type ?? hit.type));
    const explicitReflex = memory?.fm.recall_mode === "reflex";
    const surfaced = entry?.revision_surfaced ?? 0;
    const used = (entry?.revision_loaded ?? 0) > 0 || (entry?.revision_acted_on ?? 0) > 0;
    if (!directive && !explicitReflex && revision && entry?.revision === revision && surfaced >= threshold && !used) {
      suppressed.push({ id: hit.id, type: hit.type, surfaced, tokens_est: tokenEstimate(hit) });
    } else {
      kept.push(hit);
    }
  }
  return { kept, suppressed };
}
