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
