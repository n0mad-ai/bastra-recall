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
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PendingSuggestion {
  ts: number;
  blocks: string;
}

const MAX_ENTRIES = 5;
export const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function pendingSuggestionsPath(): string {
  return process.env.BASTRA_PENDING_SUGGESTIONS_PATH ?? join(homedir(), ".bastra", "pending-suggestions.json");
}

/** Append (capped, atomic). Best-effort — never throws. */
export async function writePendingSuggestion(blocks: string): Promise<void> {
  try {
    const path = pendingSuggestionsPath();
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
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(entries.slice(-MAX_ENTRIES)), "utf8");
    await rename(tmp, path);
  } catch {
    /* relay is best-effort — never break the Stop hook */
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
    if (rendered.length === 0) {
      // Erster Eintrag sprengt allein das Budget: gekürzt statt ganz weg.
      rendered.push(block.slice(0, Math.max(0, PENDING_BLOCK_CHAR_BUDGET - 1)) + "…");
      clipped = true;
      dropped = entries.length - 1;
    } else {
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

/** Read fresh entries and delete the file (consume-once). Never throws. */
export async function consumePendingSuggestions(now: number = Date.now()): Promise<PendingSuggestion[]> {
  const path = pendingSuggestionsPath();
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    await unlink(path).catch(() => {});
    if (!Array.isArray(parsed)) return [];
    return (parsed as PendingSuggestion[]).filter(
      (e) => typeof e?.blocks === "string" && typeof e?.ts === "number" && now - e.ts <= PENDING_MAX_AGE_MS,
    );
  } catch {
    return [];
  }
}
