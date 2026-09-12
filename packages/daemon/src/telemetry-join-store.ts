import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

/**
 * Persistenz für den In-Memory-Korrelations-State der Telemetry (Audit 26.6.).
 *
 * lastRecall/hookHints/turns/loadedMemories leben sonst nur im Daemon-Prozess
 * und gehen bei jedem Idle-Respawn verloren — dann werden follows_recall /
 * from_hook_recall / recall_episode still null (boot-übergreifend kein Join).
 * Ein atomarer JSON-Snapshot, den jeder Boot wieder einliest, schließt die
 * Lücke unabhängig davon, ob der Daemon zwischendurch neu gestartet ist.
 *
 * Bewusst plain JSON statt SQLite: der State ist klein und kurzlebig (Minuten-
 * TTL). Gelesen wird SYNC beim Boot (vermeidet eine Init-Race mit eingehenden
 * Tool-Calls), geschrieben async + atomar (tmp + rename).
 */

/** Sync read beim Boot — fehlend/korrupt → null (frischer Start, nie ein Throw). */
export function readJoinStateSync(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Atomarer Write: tmp + rename auf demselben Dateisystem.
 *
 * Der tmp-Name trägt einen Zufallsanteil, nicht nur die PID (#532-Scan): der
 * debounced Flush läuft als nicht-awaited fire-and-forget, also können sich
 * zwei Writes DESSELBEN Prozesses überlappen. Bei einem festen Namen pro
 * Prozess schrieben beide in dieselbe tmp-Datei und das rename veröffentlichte
 * ineinander verschachtelte Bytes — ein korrupter Join-State, der beim
 * nächsten Boot still als „kein Zustand" gelesen wird.
 */
export async function writeJoinState(path: string, state: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(state), "utf8");
  await rename(tmp, path);
}
