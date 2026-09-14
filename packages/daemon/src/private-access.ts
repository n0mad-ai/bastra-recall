/**
 * #464 — wer `sensitivity: private` sehen und ändern darf.
 *
 * Bis hierher war das Privileg ein FELD der öffentlichen Tool-Schemas
 * (`allow_private`). Damit stellte der Request-Body es selbst aus: derselbe
 * REST-/stdio-Caller, der auf `load_memory` „memory not found" bekam, sah mit
 * `allow_private: true` den vollen Body — und konnte überschreiben,
 * archivieren, umkategorisieren und verschieben, was er nicht lesen durfte.
 * Das `private`-Label überlebte jede dieser Mutationen, die Zerstörung blieb
 * für den Caller unsichtbar.
 *
 * Ab hier ist das Privileg TRANSPORTGEBUNDEN und kein Argument mehr. Es
 * entsteht ausschließlich dadurch, dass ein Transport dieses Objekt an den
 * Handler übergibt; kein JSON-Feld kann es herstellen, weil die Zod-Schemas
 * es nicht mehr kennen (unbekannte Felder verwirft Zod stillschweigend).
 *
 * Die beiden öffentlichen Transporte — der REST-Dispatcher
 * (`http-api-routes.ts`) und der stdio-MCP-Server (`index.ts`) — übergeben es
 * NIE. Der vertrauenswürdige Transport der Mac-App ist die Bridge
 * (`bridge.ts`): ein Kindprozess, den die App selbst spawnt, mit eigenem
 * Protokoll, der den Vault ohnehin ungefiltert liest und schreibt. Sie kann
 * das Privileg nicht „mitschicken" — sie IST es. Für jeden künftigen
 * in-process-Transport der App ist {@link TRUSTED_LOCAL_APP} die eine Stelle,
 * an der es vergeben wird.
 *
 * `SearchIndex.recall(..., { allow_private })` bleibt unverändert: das ist die
 * interne Option, die diese Entscheidung TRANSPORTIERT — sie war nie das
 * Problem, sondern ihr Weg in ein öffentliches Schema.
 */

import matter from "gray-matter";

/** Die Capability. Nur ein Transport kann sie übergeben, kein Argument. */
export interface PrivateAccess {
  readonly trustedPrivate?: boolean;
}

/** Der lokale App-Transport (Bridge / in-process). Einziger Aussteller. */
export const TRUSTED_LOCAL_APP: PrivateAccess = Object.freeze({ trustedPrivate: true });

/**
 * Verbirgt dieser Datensatz sich vor diesem Caller? Ein fehlendes `access`
 * ist die Antwort „externer Caller" — die Handler-Default-Signatur ist damit
 * die sichere, nicht die offene.
 */
export function hiddenFromCaller(access: PrivateAccess | undefined, fm: unknown): boolean {
  if (access?.trustedPrivate) return false;
  return (fm as { sensitivity?: string } | null | undefined)?.sensitivity === "private";
}

/**
 * #464 (wiedereröffnet) — DIESELBE Frage, an die BYTES gestellt.
 *
 * Der Gegenreview fand die Prüfung an der falschen Quelle: `deps.vault.get(id)`
 * ist der INDEX, und der darf veraltet sein. Ein öffentlich indexiertes Memory,
 * auf der Platte auf `private` gesetzt und dann von außen überschrieben oder
 * archiviert, kam durch — in 5 von 5 Läufen, beim Archivieren samt Inhalt in
 * den Trash. Der Vault liegt bei realen Nutzern auf einem Cloud-Sync-Laufwerk,
 * wo der Datei-Watcher ausdrücklich als unzuverlässig gilt: die Abweichung
 * zwischen Index und Platte ist dort kein konstruierter Fall, sondern Alltag.
 *
 * Deshalb steht diese Frage UNTER demselben Claim wie der Schreibvorgang, auf
 * den Bytes, die er gleich ersetzt oder wegbewegt — dasselbe Muster wie
 * `MemoryMutation.precondition` (#519, `packages/core/src/memory-mutate.ts`).
 *
 * Sie ERSETZT die Index-Prüfung nicht, sie ergänzt sie: verborgen ist, was
 * EINE der beiden Quellen als privat ausweist. Die Gegenrichtung (Index sagt
 * privat, Platte sagt öffentlich) bleibt damit refused — fail-closed, weil ein
 * fälschlich verweigerter Schreibvorgang nach einem Reindex wiederholbar ist
 * und ein fälschlich erlaubter nicht.
 *
 * Unlesbares Frontmatter zählt als verborgen: Wer die Datei nicht beurteilen
 * kann, darf sie nicht ersetzen — dieselbe Regel, mit der der Save-Pfad
 * `Occupant.unreadable` behandelt.
 */
export function hiddenOnDisk(access: PrivateAccess | undefined, raw: string): boolean {
  if (access?.trustedPrivate) return false;
  try {
    return hiddenFromCaller(access, matter(raw).data);
  } catch {
    return true;
  }
}
