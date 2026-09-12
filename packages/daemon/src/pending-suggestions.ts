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
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withPathLock } from "./path-lock.js";

export interface PendingSuggestion {
  ts: number;
  blocks: string;
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
export async function writePendingSuggestion(blocks: string): Promise<void> {
  const path = pendingSuggestionsPath();
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
      const dup = entries.find((e) => e.blocks === blocks);
      if (dup) dup.ts = Date.now();
      else entries.push({ ts: Date.now(), blocks });
      const kept = entries.slice(-MAX_ENTRIES);
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
 * Formatiert die Pending-Einträge als <pending-save-suggestions>-Block —
 * leere Liste → leerer String (kein Block). Der Inhalt wird auf
 * {@link PENDING_BLOCK_CHAR_BUDGET} Zeichen rationiert: Einträge werden in
 * Speicher-Reihenfolge (ältester zuerst) aufgenommen, bis das Budget greift;
 * der Rest fällt vom Ende und wird als Truncation-Zeile ausgewiesen. Ein
 * einzelner Eintrag, der allein schon größer als das Budget ist (der 2.648-
 * Token-Fall), wird auf das Budget gekürzt statt ganz verworfen — sonst
 * verschwände genau der Ausreißer, um den es geht, unsichtbar.
 *
 * Achtung: `consumePendingSuggestions` hat die Datei bereits gelöscht
 * (consume-once), also sind gedroppte Vorschläge in DIESER Session endgültig
 * fort — die Truncation-Zeile sagt das ehrlich, sie tut nicht so, als warteten
 * sie weiter.
 */
export function formatPendingBlock(entries: PendingSuggestion[]): string {
  if (entries.length === 0) return "";
  const head = `<pending-save-suggestions source="stop-hook">`;
  const intro =
    `From earlier session(s) — evaluate silently, save via bastra-recall:save_memory only what genuinely qualifies:`;
  const foot = `</pending-save-suggestions>`;

  const rendered: string[] = [];
  let used = 0;
  let dropped = 0;
  let clipped = false;
  for (let i = 0; i < entries.length; i++) {
    const block = entries[i].blocks;
    const sep = rendered.length > 0 ? 1 : 0; // Join-Newline zwischen Blöcken.
    if (used + sep + block.length <= PENDING_BLOCK_CHAR_BUDGET) {
      rendered.push(block);
      used += sep + block.length;
      continue;
    }
    const room = PENDING_BLOCK_CHAR_BUDGET - used - sep - 1;
    if (block.length > PENDING_BLOCK_CHAR_BUDGET && room > 0) {
      // Dieser Eintrag sprengt ALLEIN das Budget — der Ausreißer, für den die
      // Kürzung existiert. Egal an welcher Position: in den Restplatz kürzen
      // statt ganz zu verwerfen. (Vorher an `rendered.length === 0` gekoppelt,
      // also wurde nur der ERSTE Eintrag gekürzt; ein späterer Ausreißer fiel
      // still komplett weg — genau der Fall, den die Kürzung abfangen soll.)
      // Ohne Restplatz bliebe nur ein nacktes „…" — dann zählt er als
      // unterdrückt statt als gekürzt.
      rendered.push(block.slice(0, room) + "…");
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
    lines.push(
      `… ${parts.join(", ")} — the pending set exceeded the ${PENDING_BLOCK_CHAR_BUDGET}-char budget ` +
        `and the rest were not shown this session.`,
    );
  }
  return lines.join("\n") + "\n" + foot;
}

/**
 * Read fresh entries and delete the file (consume-once). Never throws.
 *
 * #532: read and unlink run under the SAME per-path lock as the writers, so a
 * session start can no longer unlink a set that a writer published between its
 * own read and its unlink — that suggestion would have been destroyed without
 * ever being shown.
 */
export async function consumePendingSuggestions(now: number = Date.now()): Promise<PendingSuggestion[]> {
  const path = pendingSuggestionsPath();
  try {
    return await withPathLock(path, async () => {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      await unlink(path).catch(() => {});
      lossDiagnostics = 0;
      if (!Array.isArray(parsed)) return [];
      return (parsed as PendingSuggestion[]).filter(
        (e) => typeof e?.blocks === "string" && typeof e?.ts === "number" && now - e.ts <= PENDING_MAX_AGE_MS,
      );
    });
  } catch {
    return [];
  }
}
