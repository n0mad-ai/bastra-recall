/**
 * Floor registry (#141/#142) — the pin-with-lifecycle primitive, daemon-side.
 *
 * Recall is pull-by-relevance; some memories must be push-by-state: present
 * regardless of what the current turn thinks it needs (a killed option, a hard
 * constraint). The engine ships the MECHANISM only — a small registry of
 * floored memory ids the session hook injects above the relevance gate. The
 * CURATION (what gets floored, when a condition ends) lives in a governance
 * surface above the engine, never here.
 *
 * Deliberately a daemon-side state file, NOT frontmatter: the engine score and
 * the vault files stay untouched, so the survival-by-id invariant (see
 * docs/survival.md) holds by construction — release drops a memory back to
 * ordinary ranked retrieval, it never deletes anything.
 *
 * Entry shape (issue #142): an opaque per-entry handle, not a bare set.
 *   - `condition` is an opaque, surface-stamped token. The engine keys exactly
 *     two things off it — release-by-token and the audit line — and never
 *     learns what the condition MEANS.
 *   - `last_affirmed` is engine-stamped on affirm and exposed in the preload
 *     audit line; retire policy (when a stale floor falls out) stays in the
 *     surface. Anti-incidental-touch invariant: no `why` = no affirm = the
 *     clock does not move.
 *
 * Persistence: ~/.bastra/floors.json (override: BASTRA_FLOORS_PATH — same
 * per-file pattern as pending-suggestions.ts), atomic tmp+rename writes.
 * Latency is sacred: the whole registry is ONE small file read per session
 * start; the recall hot path (search.ts) is not involved at all.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appendAct } from "./floor-acts.js";
import { scopeEquals } from "@bastra-recall/core/scope";

export interface FloorEntry {
  memory_id: string;
  /** Opaque, surface-stamped condition token — the engine never interprets it. */
  condition: string;
  /** Human-readable why-it's-floored, rendered in the audit line. */
  reason: string;
  /** Optional project scope; unscoped entries apply everywhere. */
  scope?: string;
  /** ISO timestamp, engine-stamped on add. */
  floored_at: string;
  /** ISO timestamp, engine-stamped on add and on each affirm. */
  last_affirmed: string;
  /** Who re-affirmed — stored verbatim, treated as opaque audit payload. */
  affirmed_by?: string;
  /** The re-justification — stored verbatim, never interpreted by the engine. */
  why?: string;
}

/**
 * Hard cap on the registry. The pinned set rations the context window — a set
 * that only grows rebuilds the always-loaded-blob problem one level up (#142).
 * Adding beyond the cap is an error that lists the current entries: the
 * curation decision (what to release first) stays above the engine.
 */
export const MAX_FLOORS = 12;

export function floorsFilePath(): string {
  return process.env.BASTRA_FLOORS_PATH ?? join(homedir(), ".bastra", "floors.json");
}

function isFloorEntry(v: unknown): v is FloorEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.memory_id === "string" && e.memory_id.length > 0 &&
    typeof e.condition === "string" && e.condition.length > 0 &&
    typeof e.reason === "string" &&
    typeof e.floored_at === "string" &&
    typeof e.last_affirmed === "string"
  );
}

/**
 * Reads the registry. Missing/empty file → empty (normal: nothing floored
 * yet). Corrupt file → loud stderr + empty, same policy as settings.ts —
 * the next write repairs it. Never throws.
 */
async function readRegistry(path: string): Promise<FloorEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  if (raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(
      `[bastra-recall] floors.json is corrupt (${(e as Error).message}) — treating as empty. Fix or delete ${path}\n`,
    );
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isFloorEntry);
}

/**
 * #240/A9: every mutation is a read-modify-write, and nothing serialised
 * them. Node serves overlapping HTTP requests concurrently, so a batch of
 * floors added in one `Promise.all` — the natural shape when a surface pins
 * several memories for ONE decision — all read the same empty registry and
 * the last write won. Measured: 12 parallel adds → 1 persisted, deterministic
 * over 10 runs, every call returning HTTP 200 so the caller could not notice.
 * The cap was equally defeated (every read saw an empty registry, so 30 adds
 * produced 0 rejections), and a parallel release left the released floors
 * pinned.
 *
 * A per-path promise chain is enough: this is a single local daemon, the
 * registry is tiny, and the writes are already atomic per file. It does NOT
 * guard against a second process — that would need real file locking, which
 * this feature does not warrant.
 */
const registryLocks = new Map<string, Promise<unknown>>();

function withRegistryLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = registryLocks.get(path) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain alive but never let a rejection poison the next waiter.
  registryLocks.set(
    path,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** Atomic tmp+rename, owner-only perms (same hardening as settings.ts). */
async function writeRegistry(entries: FloorEntry[], path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(entries, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

export interface AddFloorInput {
  memory_id: string;
  condition: string;
  reason: string;
  scope?: string;
  /** Only together with `why` — a surface rewriting a floor AS its re-affirm. */
  affirmed_by?: string;
  why?: string;
  /** Surface-supplied intent time for the rewrite-as-affirm act (#198). */
  occurred_at?: string;
  /** Act-log path override. */
  acts_path?: string;
}

/**
 * Adds (or rewrites) a floor. Stamps `floored_at` + `last_affirmed` = now;
 * upsert by `memory_id` — a rewrite is a NEW floor handle (new condition/
 * reason), so both clocks restart. Rejects a brand-new entry once the registry
 * holds {@link MAX_FLOORS} entries, listing the current set in the error.
 */
export async function addFloor(input: AddFloorInput, path: string = floorsFilePath()): Promise<FloorEntry> {
  const memoryId = input.memory_id?.trim() ?? "";
  const condition = input.condition?.trim() ?? "";
  const reason = input.reason?.trim() ?? "";
  if (!memoryId) throw new Error("memory_id is required");
  if (!condition) throw new Error("condition is required");
  if (!reason) throw new Error("reason is required — a floor without its why is unauditable at the gate");
  const hasBy = typeof input.affirmed_by === "string" && input.affirmed_by.trim().length > 0;
  const hasWhy = typeof input.why === "string" && input.why.trim().length > 0;
  if (hasBy !== hasWhy) {
    throw new Error("affirmed_by and why must be provided together (no why = no affirm)");
  }
  const scope = typeof input.scope === "string" && input.scope.trim().length > 0 ? input.scope.trim() : undefined;

  return withRegistryLock(path, async () => {
    const entries = await readRegistry(path);
    const existing = entries.findIndex((e) => e.memory_id === memoryId);
    if (existing === -1 && entries.length >= MAX_FLOORS) {
      const current = entries.map((e) => `${e.memory_id} (condition: ${e.condition})`).join(", ");
      throw new Error(
        `floor cap reached (${MAX_FLOORS}) — the pinned set rations the context window; ` +
          `release a condition before adding. Current floors: ${current}`,
      );
    }

    const now = new Date().toISOString();
    // A rewrite carrying affirmed_by + why IS an affirm (see the doc comment
    // above), so it belongs in the act log too — otherwise the log is
    // incomplete from day one and live-intent misses a real re-justification.
    if (hasBy) {
      await appendAct(
        {
          memory_id: memoryId,
          ...(input.occurred_at !== undefined ? { occurred_at: input.occurred_at } : {}),
          affirmed_by: input.affirmed_by!,
          why: input.why!,
        },
        input.acts_path,
      );
    }
    const entry: FloorEntry = {
      memory_id: memoryId,
      condition,
      reason,
      ...(scope !== undefined ? { scope } : {}),
      floored_at: now,
      last_affirmed: now,
      // Stored verbatim — opaque audit payload, never interpreted.
      ...(hasBy ? { affirmed_by: input.affirmed_by, why: input.why } : {}),
    };
    if (existing >= 0) entries[existing] = entry;
    else entries.push(entry);
    await writeRegistry(entries, path);
    return entry;
  });
}

/**
 * Releases every entry stamped with `condition` — unpinning is keyed on the
 * condition, not a per-id chore, so a surface can drop a whole decision's
 * floors in the same write that marks the decision settled. Returns the
 * removed memory ids.
 *
 * Release is drop-to-ranked, never delete: the vault file and the engine score
 * are untouched by construction (this module never sees them); the memory just
 * stops being guaranteed-present and competes through normal ranking again.
 */
export async function release(condition: string, path: string = floorsFilePath()): Promise<string[]> {
  const token = condition?.trim() ?? "";
  if (!token) throw new Error("condition is required");
  return withRegistryLock(path, async () => {
    const entries = await readRegistry(path);
    const removed = entries.filter((e) => e.condition === token).map((e) => e.memory_id);
    if (removed.length === 0) return [];
    await writeRegistry(entries.filter((e) => e.condition !== token), path);
    return removed;
  });
}

export interface AffirmOptions {
  /**
   * Surface-supplied intent time, carried opaquely into the act log (#198).
   * Omit when affirming inline — the engine never back-fills it.
   */
  occurredAt?: string;
  /** Registry path override. */
  path?: string;
  /** Act-log path override. */
  actsPath?: string;
}

/**
 * Re-affirms a floor: appends the act to the log (#198) and refreshes the
 * registry row, which is a cache of the act log's answer.
 *
 * Anti-incidental-touch invariant (#142 design thread): BOTH `affirmed_by` and
 * `why` are required. No why = no affirm = the clock does not move — an affirm
 * is a deliberate re-justification, never a side effect of some other write
 * brushing past the entry.
 *
 * Append-first: the crash window between the two files then degrades to a
 * stale cache rather than a lost act — the shape the usage sidecar already
 * runs, where the events file is truth and the aggregate is derived. A
 * redelivery of an identical act appends nothing and leaves the row untouched.
 *
 * Options bag, not a fourth positional: `path` used to sit in that position,
 * and inserting `occurredAt` ahead of it would have bound a filesystem path to
 * an intent time with no type error.
 */
export async function affirm(
  memoryId: string,
  affirmedBy: string,
  why: string,
  opts: AffirmOptions = {},
): Promise<FloorEntry> {
  const id = memoryId?.trim() ?? "";
  if (!id) throw new Error("memory_id is required");
  if (!affirmedBy?.trim() || !why?.trim()) {
    throw new Error(
      "affirm requires affirmed_by AND why — without a re-justification the last_affirmed clock does not move",
    );
  }
  const path = opts.path ?? floorsFilePath();
  return withRegistryLock(path, async () => {
    const entries = await readRegistry(path);
    const idx = entries.findIndex((e) => e.memory_id === id);
    if (idx === -1) throw new Error(`memory is not floored: ${id}`);

    const act = await appendAct(
      {
        memory_id: id,
        ...(opts.occurredAt !== undefined ? { occurred_at: opts.occurredAt } : {}),
        affirmed_by: affirmedBy,
        why,
      },
      opts.actsPath,
    );
    // Duplicate redelivery: nothing happened, so nothing moves.
    if (!act) return entries[idx];

    const next: FloorEntry = {
      ...entries[idx],
      last_affirmed: act.recorded,
      affirmed_by: affirmedBy,
      why,
    };
    entries[idx] = next;
    await writeRegistry(entries, path);
    return next;
  });
}

/**
 * Lists floors. With a `scope`, returns the entries for that scope PLUS the
 * unscoped (global) ones — mirrors how global memory scopes apply in every
 * project context. Without a scope, returns the full registry.
 *
 * #360-Folgefund: `scope` here is usually `detectProject(cwd)`'s raw result
 * ("CarNexus"), while a floor's `e.scope` is written in vault-convention
 * lowercase ("carnexus") — an unfaded `===` silently dropped every project-
 * bound floor for such a project. Compared via `scopeEquals` now, same fix
 * as the recall-side scope filters in `@bastra-recall/core/search.ts`.
 */
export async function listFloors(scope?: string, path: string = floorsFilePath()): Promise<FloorEntry[]> {
  const entries = await readRegistry(path);
  if (!scope) return entries;
  return entries.filter((e) => !e.scope || scopeEquals(e.scope, scope));
}
