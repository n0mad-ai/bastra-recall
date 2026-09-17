/**
 * Stiller Relay-Kanal für Stop-Hook-Vorschläge (#48 Redesign).
 *
 * Claude-Code-Stop-Hooks haben keinen stillen Output-Kanal: das einzige
 * sichtbare Feld ist `systemMessage`, und das rendert Claude Code 1:1 in den
 * Chat — die „Zeichenflut", die den Hook 2026-05-30 deaktiviert hat. Statt
 * dorthin zu emittieren, schreibt der Stop-Hook seine <save-eval>-Blöcke in
 * diese Datei; der SessionStart-Hook der NÄCHSTEN Session liest sie still als
 * additionalContext ein (für den Agent sichtbar, im Chat unsichtbar) und
 * konsumiert die Datei.
 *
 * #513: zwei Spuren in derselben Datei — `recency` (einmal zeigen, dann weg)
 * und `trends` (bei jedem Start zeigen, nach N gezählten Sessions weg).
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withPathLock } from "./path-lock.js";
import { envInt } from "./env.js";

/**
 * The two jobs the relay serves (#513). `recency`: something just happened —
 * shown at the next session start, then gone (consume-once, the pre-#513
 * behaviour). `trends`: something keeps coming up — shown at EVERY start while
 * it is alive, never consumed on read, aged out by counted sessions instead of
 * wall-clock days. An entry without `lane` is a recency entry, so a file
 * written before #513 reads exactly as it did.
 */
export type PendingLane = "recency" | "trends";

export interface PendingSuggestion {
  ts: number;
  blocks: string;
  lane?: PendingLane;
  /** Trends only: dedupe key. A refreshed trend (same key, new counts in the
   *  text) replaces its row instead of stacking next to it. */
  key?: string;
  /** Trends only: real session starts this entry has been shown at. */
  sessions?: number;
  /** Trends only: the session that last advanced `sessions` — a second hook
   *  call for the same session must not count twice. */
  last_session?: string;
}

function laneOf(e: PendingSuggestion): PendingLane {
  return e.lane === "trends" ? "trends" : "recency";
}

/**
 * How many real session starts a trends entry is shown at before it ages out
 * (#513). 6 sits in the issue's 5–7 placeholder range until the session
 * distribution is measured; `BASTRA_PENDING_TRENDS_SESSIONS` overrides it.
 */
export const PENDING_TRENDS_SESSIONS_DEFAULT = 6;

export function pendingTrendsSessions(): number {
  const n = envInt("BASTRA_PENDING_TRENDS_SESSIONS", PENDING_TRENDS_SESSIONS_DEFAULT);
  return n >= 1 ? n : PENDING_TRENDS_SESSIONS_DEFAULT;
}

/**
 * Synthetic/eval session ids never advance the trends counter (#513). There is
 * no shared marker for them in the codebase, so the rule is the conservative
 * one: a start counts only when it carries a real session id, is a fresh start
 * (compact/clear/resume keep the session it already counted), and the id does
 * not carry one of the prefixes our harnesses and tests use.
 */
const SYNTHETIC_SESSION_RE = /^(eval|test|synthetic|smoke|probe|bench|fixture)[-_:.]/i;

export function isCountableSessionStart(sessionId: string | null | undefined, source: string | null | undefined): boolean {
  if (typeof sessionId !== "string" || sessionId.trim() === "") return false;
  if (source != null && source !== "startup") return false;
  return !SYNTHETIC_SESSION_RE.test(sessionId);
}

const MAX_ENTRIES = 5;
/**
 * Bound on the lost-write diagnostics (#532). A relay that swallows losses is
 * the actual bug: 40 overlapping writes persisted ONE entry and nothing said
 * so. Losing an entry must be visible somewhere, but a Stop hook must never
 * turn a bad day into a wall of stderr — so only the first few of a relay
 * cycle are reported. The budget resets on consume: one write-many →
 * consume-once cycle gets its own notices, a later cycle is not muted by an
 * earlier bad one.
 */
const MAX_LOSS_DIAGNOSTICS = 5;
let lossDiagnostics = 0;

function reportLoss(detail: string): void {
  if (lossDiagnostics >= MAX_LOSS_DIAGNOSTICS) return;
  lossDiagnostics++;
  const tail = lossDiagnostics === MAX_LOSS_DIAGNOSTICS ? " (further notices suppressed)" : "";
  process.stderr.write(`[bastra-recall] pending suggestions: ${detail}${tail}\n`);
}

export const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function pendingSuggestionsPath(): string {
  return process.env.BASTRA_PENDING_SUGGESTIONS_PATH ?? join(homedir(), ".bastra", "pending-suggestions.json");
}

/**
 * Append (capped, atomic). Best-effort — never throws.
 *
 * #532: this was an UNLOCKED read-modify-write on one shared file, the same
 * bug #240/A9 fixed for the floor registry. Overlapping Stop-hook and curator
 * writes all read the same snapshot and the last rename won; measured, 40
 * concurrent unique writes left exactly ONE entry, well inside the documented
 * five-entry cap, and every call returned normally. The temp name was only
 * PID-scoped on top of that, so two writes in the same daemon shared it.
 *
 * Fix: the shared per-path lock (path-lock.ts) plus an operation-unique temp
 * name. Serialising costs nothing the hook can feel — the file holds at most
 * five short entries and one write is a read plus a rename — and the hook
 * stays non-blocking because the Stop lane already awaits this off the
 * session's critical path.
 *
 * In-process only, deliberately: every writer and the consumer live in the
 * daemon. `writePendingSuggestion` is called from stop-lane.ts and
 * curator-run.ts, `consumePendingSuggestions` from session-lane.ts, and all
 * three lanes are reached exclusively through the daemon's HTTP routes
 * (http-lane-routes.ts, daemon-jobs.ts) — the hook CLI (hook.ts) is a thin
 * client that POSTs and never imports a lane. So there is no second process to
 * lock against, and the relay does not pay for a lock file it has no writer
 * for. If a lane ever runs in the hook process (the local fallback #346
 * sketches), this call gains `{ crossProcess: true }` and nothing else.
 */
export async function writePendingSuggestion(
  blocks: string,
  opts: { lane?: PendingLane; key?: string } = {},
): Promise<void> {
  const lane: PendingLane = opts.lane ?? "recency";
  const path = pendingSuggestionsPath();
  const capped =
    blocks.length > PENDING_ENTRY_CHAR_CAP
      ? blocks.slice(0, PENDING_ENTRY_CHAR_CAP - 1) + "…"
      : blocks;
  if (capped !== blocks) {
    reportLoss(
      `one suggestion of ${blocks.length} chars clipped to the ` +
        `${PENDING_ENTRY_CHAR_CAP}-char per-entry cap before it was stored`,
    );
  }
  try {
    await withPathLock(path, async () => {
      await mkdir(dirname(path), { recursive: true });
      let entries: PendingSuggestion[] = [];
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
        if (Array.isArray(parsed)) entries = parsed as PendingSuggestion[];
      } catch {
        /* missing/corrupt → start fresh */
      }
      if (lane === "trends") {
        // #513: one row per trend. A refresh replaces the text and restarts the
        // session counter — the trend just came up again.
        const dup = entries.find(
          (e) => laneOf(e) === "trends" && (opts.key ? e.key === opts.key : e.blocks === capped),
        );
        const row: PendingSuggestion = { ts: Date.now(), blocks: capped, lane: "trends", sessions: 0 };
        if (opts.key) row.key = opts.key;
        if (dup) entries.splice(entries.indexOf(dup), 1);
        entries.push(row);
      } else {
        const dup = entries.find((e) => laneOf(e) === "recency" && e.blocks === capped);
        if (dup) dup.ts = Date.now();
        else entries.push({ ts: Date.now(), blocks: capped });
      }
      // The cap holds per lane: a burst of hot suggestions must not evict a
      // trend that is still alive, nor the other way round.
      const keep = new Set<PendingSuggestion>();
      for (const l of ["recency", "trends"] as const) {
        for (const e of entries.filter((x) => laneOf(x) === l).slice(-MAX_ENTRIES)) keep.add(e);
      }
      const kept = entries.filter((e) => keep.has(e));
      // Dropping the oldest is the documented contract, not a bug — but it IS
      // a durable loss, so it gets a line instead of happening in silence.
      const droppedAtCap = entries.length - kept.length;
      if (droppedAtCap > 0) {
        reportLoss(
          `${droppedAtCap} oldest ${droppedAtCap === 1 ? "entry" : "entries"} dropped ` +
            `at the ${MAX_ENTRIES}-entry cap`,
        );
      }
      const tmp = `${path}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(tmp, JSON.stringify(kept), "utf8");
      await rename(tmp, path);
    });
  } catch (e) {
    // The relay stays best-effort — never break the Stop hook — but a write
    // that failed outright is a lost suggestion and must not be invisible.
    reportLoss(`write failed (${(e as Error).message}) — one suggestion lost`);
  }
}

/**
 * Zeichen-Budget für den GESAMTEN Entry-Inhalt des Blocks (#510). Die
 * Schreibseite kappt die ANZAHL (`MAX_ENTRIES = 5`), nichts die GRÖSSE — im
 * #462-Baseline war `pending` mit 2.648 Tokens der größte Einzel-Part eines
 * Session-Starts, größer als jeder andere. Gebudgetet wird gegen die
 * gemessene Verteilung (Median 332, Schnitt-wenn-präsent 667 Tokens), nicht
 * gegen den Ausreißer: ~3.000 Zeichen ≈ 750 Tokens lassen den Normalfall
 * unangetastet und schneiden nur den Ausreißer. Form wie `pinned-block.ts`:
 * Gesamt-Budget, Einträge fallen vom Ende, eine sichtbare Truncation-Zeile —
 * ein unterdrückter Vorschlag ist sichtbar statt still weg.
 */
export const PENDING_BLOCK_CHAR_BUDGET = 3000;

/**
 * Per-entry size cap on the WRITE side (#551).
 *
 * `MAX_ENTRIES` capped how MANY entries are stored and nothing capped how LARGE
 * one may be, so a single Stop-hook turn could put an unbounded string on disk.
 * CodeQL reads that as `js/http-to-file-access`, because the text is derived
 * from a transcript that reaches this lane over the daemon's HTTP routes. The
 * rule's arbitrary-upload shape does not apply — the destination path is a
 * constant (or an operator's own env var) and was never request-controlled —
 * but the unbounded size was real, and this is the half worth fixing.
 *
 * Deliberately well ABOVE {@link PENDING_BLOCK_CHAR_BUDGET} rather than equal to
 * it. The render budget is what a session may SEE; an entry that exceeds it is
 * clipped by `formatPendingBlock` and announced with a visible truncation line.
 * Capping the stored entry AT the render budget would make every outlier fit
 * exactly, and that honest line would silently stop appearing — the ehrlichkeit
 * #510 built would be the thing this fix broke. Four times the budget leaves
 * every path that was ever visible untouched and still bounds the file at
 * MAX_ENTRIES × this.
 */
export const PENDING_ENTRY_CHAR_CAP = 4 * PENDING_BLOCK_CHAR_BUDGET;

/**
 * Formatiert die Pending-Einträge als <pending-save-suggestions>-Block —
 * leere Liste → leerer String (kein Block). Der Inhalt wird auf
 * {@link PENDING_BLOCK_CHAR_BUDGET} Zeichen rationiert: Einträge werden in
 * Speicher-Reihenfolge (ältester zuerst) aufgenommen, bis das Budget greift;
 * der Rest fällt vom Ende und wird als Truncation-Zeile ausgewiesen. Ein
 * einzelner Eintrag, der allein schon größer als das Budget ist (der 2.648-
 * Token-Fall), wird auf das Budget gekürzt statt ganz verworfen — sonst
 * verschwände genau der Ausreißer, um den es geht, unsichtbar.
 *
 * Achtung: Recency-Einträge sind beim Rendern bereits konsumiert
 * (consume-once), also sind gedroppte Vorschläge in DIESER Session endgültig
 * fort — die Truncation-Zeile sagt das ehrlich, sie tut nicht so, als warteten
 * sie weiter. Trends (#513) bleiben dagegen liegen; ihre Zeile sagt genau das.
 */
export function formatPendingBlock(entries: PendingSuggestion[]): string {
  return renderLane(entries, "recency", PENDING_BLOCK_CHAR_BUDGET).text;
}

/**
 * Both lanes as two labelled blocks (#513) — "hot, act now" first, "recurring,
 * watch" second. They share the one #510 budget: recency is rendered first and
 * trends get what is left, so the relay as a whole never grows past it. A trend
 * squeezed out this way is announced and stays alive for the next start.
 */
export function formatPendingRelay(relay: PendingRelay): { text: string; recencyChars: number; trendsChars: number } {
  const recency = renderLane(relay.recency, "recency", PENDING_BLOCK_CHAR_BUDGET);
  const trends = renderLane(relay.trends, "trends", Math.max(0, PENDING_BLOCK_CHAR_BUDGET - recency.used));
  return {
    text: [recency.text, trends.text].filter(Boolean).join("\n"),
    recencyChars: recency.text.length,
    trendsChars: trends.text.length,
  };
}

function renderLane(
  entries: PendingSuggestion[],
  lane: PendingLane,
  budget: number,
): { text: string; used: number } {
  if (entries.length === 0) return { text: "", used: 0 };
  const head = lane === "trends" ? `<pending-trends source="stop-hook">` : `<pending-save-suggestions source="stop-hook">`;
  const intro =
    lane === "trends"
      ? `Recurring — shown at every session start until it ages out after ${pendingTrendsSessions()} sessions; ` +
        `watch it, save via bastra-recall:save_memory only once it genuinely qualifies:`
      : `From earlier session(s) — evaluate silently, save via bastra-recall:save_memory only what genuinely qualifies:`;
  const foot = lane === "trends" ? `</pending-trends>` : `</pending-save-suggestions>`;

  const rendered: string[] = [];
  let used = 0;
  let dropped = 0;
  let clipped = false;
  for (let i = 0; i < entries.length; i++) {
    const block = entries[i].blocks;
    const sep = rendered.length > 0 ? 1 : 0; // Join-Newline zwischen Blöcken.
    if (used + sep + block.length <= budget) {
      rendered.push(block);
      used += sep + block.length;
      continue;
    }
    const room = budget - used - sep - 1;
    if (block.length > PENDING_BLOCK_CHAR_BUDGET && room > 0) {
      // Dieser Eintrag sprengt ALLEIN das Budget — der Ausreißer, für den die
      // Kürzung existiert. Egal an welcher Position: in den Restplatz kürzen
      // statt ganz zu verwerfen. (Vorher an `rendered.length === 0` gekoppelt,
      // also wurde nur der ERSTE Eintrag gekürzt; ein späterer Ausreißer fiel
      // still komplett weg — genau der Fall, den die Kürzung abfangen soll.)
      // Ohne Restplatz bliebe nur ein nacktes „…" — dann zählt er als
      // unterdrückt statt als gekürzt.
      rendered.push(block.slice(0, room) + "…");
      used = budget;
      clipped = true;
      dropped = entries.length - i - 1;
    } else {
      // Ein normaler Eintrag, der nur den Restplatz nicht mehr trifft — er und
      // alles danach fallen vom Ende.
      dropped = entries.length - i;
    }
    break;
  }

  const lines = [head, intro, ...rendered];
  if (clipped || dropped > 0) {
    const parts: string[] = [];
    if (clipped) parts.push("one suggestion was clipped to fit");
    if (dropped > 0)
      parts.push(`${dropped} earlier ${dropped === 1 ? "suggestion" : "suggestions"} suppressed`);
    const tail =
      lane === "trends"
        ? `they stay pending and come back at the next session start.`
        : `the rest were not shown this session.`;
    lines.push(
      `… ${parts.join(", ")} — the pending set exceeded the ${PENDING_BLOCK_CHAR_BUDGET}-char budget ` +
        `and ${tail}`,
    );
  }
  return { text: lines.join("\n") + "\n" + foot, used };
}

export interface PendingRelay {
  recency: PendingSuggestion[];
  trends: PendingSuggestion[];
}

/**
 * Session-start read of both lanes (#513). Never throws.
 *
 * - recency: fresh entries are returned and removed (consume-once);
 * - trends: every live entry is returned and KEPT. On a countable start
 *   (see {@link isCountableSessionStart}) each entry's session counter advances
 *   once per session id; an entry past {@link pendingTrendsSessions} is dropped
 *   instead of shown.
 *
 * #532: read and write-back run under the SAME per-path lock as the writers, so
 * a session start can no longer drop a set that a writer published between its
 * own read and its write-back.
 */
export async function takePendingRelay(
  opts: { now?: number; sessionId?: string | null; countable?: boolean } = {},
): Promise<PendingRelay> {
  const now = opts.now ?? Date.now();
  const path = pendingSuggestionsPath();
  const advanceFor = opts.countable && opts.sessionId ? opts.sessionId : null;
  const maxSessions = pendingTrendsSessions();
  try {
    return await withPathLock(path, async () => {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      lossDiagnostics = 0;
      const valid = Array.isArray(parsed)
        ? (parsed as PendingSuggestion[]).filter((e) => typeof e?.blocks === "string" && typeof e?.ts === "number")
        : [];
      const recency = valid.filter((e) => laneOf(e) === "recency" && now - e.ts <= PENDING_MAX_AGE_MS);
      const trends: PendingSuggestion[] = [];
      for (const e of valid) {
        if (laneOf(e) !== "trends") continue;
        let sessions = typeof e.sessions === "number" && e.sessions >= 0 ? e.sessions : 0;
        let last = e.last_session;
        if (advanceFor && last !== advanceFor) {
          sessions += 1;
          last = advanceFor;
        }
        if (sessions > maxSessions) continue; // aged out — this start no longer shows it
        const row: PendingSuggestion = { ...e, sessions };
        if (last !== undefined) row.last_session = last;
        trends.push(row);
      }
      if (trends.length > 0) {
        const tmp = `${path}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
        await writeFile(tmp, JSON.stringify(trends), "utf8");
        await rename(tmp, path);
      } else {
        await unlink(path).catch(() => {});
      }
      return { recency, trends };
    });
  } catch {
    return { recency: [], trends: [] };
  }
}

/**
 * Recency lane only, consume-once — the pre-#513 contract. Trends entries stay
 * in the file untouched (no session is counted). Never throws.
 */
export async function consumePendingSuggestions(now: number = Date.now()): Promise<PendingSuggestion[]> {
  return (await takePendingRelay({ now })).recency;
}
