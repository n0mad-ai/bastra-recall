/**
 * The words of the global `bastra doctor` notes — sync conflict copies
 * (#1485), derived claims (#609), the clients' own memory folders (#674),
 * unresolved `affects_files` (#578), learned bridges (#672) and the MCP
 * delivery per client (#1472) —
 * by language.primary (#1602). English is the default and the fallback,
 * byte-identical to before; German complete. Only doctor's screen reads these
 * lines. Text the product writes — never matched against user text.
 */

const en = {
  conflictHeader: "→ sync conflict copies\n",
  conflictCount: (n: number) =>
    `${n} sync conflict ${n === 1 ? "copy" : "copies"} found — not indexed; the original is used. ` +
    `Compare each pair, keep what is right in the original, then remove the copy.`,
  conflictPair: (copy: string, original: string, id: string) => `${copy}  (copy of ${original}, id '${id}')`,
  andMore: (n: number) => `… and ${n} more`,
  claimsSummary: (total: number, memories: number, findings: number) =>
    `${total} claim${total === 1 ? "" : "s"} in ${memories} memor${memories === 1 ? "y" : "ies"}` +
    (findings === 0 ? " — none out of step with its source" : `, ${findings} out of step with its source`),
  claimsUnverifiable: (n: number) =>
    `${n} claim${n === 1 ? "" : "s"} could not be checked (source missing, outside the vault, not a file or over 1 MB)`,
  claimGone: (source: string) => `quoted string no longer in ${source}`,
  claimAmbiguous: (count: string, source: string) => `quoted string occurs ${count} times in ${source}`,
  claimDigest: (source: string) => `${source} changed since the digest was recorded`,
  claimDiffers: (expect: string, source: string, value: string) => `note says ${expect}, ${source} says ${value}`,
  clientFolder: (client: string, dir: string, notes: number, pending: number) =>
    `${pending > 0 ? "⚠ " : ""}${client}: ${dir} — ${notes} note(s)` +
    (pending > 0 ? `, ${pending} not in the vault yet` : ", all imported"),
  clientImport:
    `recall never reads these folders — import them with 'bastra import clients' ` +
    `(add --dry-run to preview; re-running only picks up what changed)`,
  affectsNotChecked: (count: number, memories: number) =>
    `${count} entr${count === 1 ? "y" : "ies"} in ${memories} memor${memories === 1 ? "y" : "ies"} — not checked here (no git repository at this location)`,
  affectsNotRepoPaths: (n: number) =>
    `${n} further entr${n === 1 ? "y names an absolute or home path" : "ies name absolute or home paths"} — not repository paths, nothing to resolve`,
  bridgesChurn: (demoted: number, archived: number, days: number) =>
    `· ${demoted} bridge(s) demoted, ${archived} archived in the last ${days} days — ` +
    "fired without leading to a load or acted-on episode (#129), or minted from machine text (#704); " +
    "see bridges/archive/log.jsonl in the Commons clone, move a file back to restore it",
  bridgesLive: "· query expansion: live — bridges widen recall queries ('bastra bridges live off' returns to shadow)",
  bridgesShadow:
    "· query expansion: shadow — fires are logged (bridge_expansion, applied: false), the ranking is unchanged; " +
    "'bastra bridges live on' once 'bastra bridges verify' passes a bridge",
  bridgesNoMint: (days: number) =>
    `⚠ no bridge mint ran in the last ${days} days — the daemon mints after boot and then daily; start it or run 'bastra bridges mint'`,
  bridgesLearned: (days: number, runs: number, written: number) =>
    `✓ ok: bridges learned in the last ${days} days (${runs} mint run(s), last: ${written} written)`,
  bridgesStalled: (runs: number, days: number, minted: number) =>
    `⚠ bridge learning stalled: ${runs} mint run(s) in ${days} days minted candidates but wrote none (last: ${minted} minted, 0 written) — ` +
    "builds before #672 held back single-reach bridges; update and run 'bastra bridges mint'",
  bridgesNoReach: (days: number, runs: number) =>
    `⚠ no bridge learned in ${days} days: ${runs} mint run(s) found no acted-on recalls in the telemetry log — ` +
    "bridges learn from it, so check that BASTRA_TELEMETRY is not 'off'",
  bridgesNothingToLearn: (runs: number, days: number, reaches: number) =>
    `✓ ok: ${runs} mint run(s) in ${days} days, no recall needed a bridge (last: ${reaches} acted-on reach(es))`,
  deliveryHeader: "→ delivery per client (what the daemon hands each client right now)",
  deliveryOk: (surface: string, tools: number, mcpSurface: string, start: number, full: number) =>
    `  ✓ ${surface}: MCP lists ${tools} tools (surface ${mcpSurface}); estimate from the catalog (~4 characters per token): ` +
    `~${start} tokens if the client defers definitions (tool names + server instructions at start), ` +
    `~${full} tokens if it loads every definition at start; the client's actual mode is not verified`,
  deliveryMissing: (surface: string, detail: string) =>
    `  ⚠ ${surface}: MCP tool list not delivered by the daemon: ${detail}; the client falls back to the bundled list until it is reachable`,
  deliveryHttp: (status: number) => `daemon answered HTTP ${status}`,
  deliveryNoList: "daemon sent no tool list",
  deliveryUnreachable: (message: string) => `daemon not reachable (${message})`,
};
export type DoctorNotesWords = typeof en;

const de: DoctorNotesWords = {
  conflictHeader: "→ Sync-Konfliktkopien\n",
  conflictCount: (n) =>
    `${n} Sync-${n === 1 ? "Konfliktkopie" : "Konfliktkopien"} gefunden — nicht indiziert; verwendet wird das Original. ` +
    `Vergleiche jedes Paar, übernimm das Richtige ins Original und entferne dann die Kopie.`,
  conflictPair: (copy, original, id) => `${copy}  (Kopie von ${original}, ID '${id}')`,
  andMore: (n) => `… und ${n} weitere`,
  claimsSummary: (total, memories, findings) =>
    `${total} ${total === 1 ? "Angabe" : "Angaben"} in ${memories} ${memories === 1 ? "Memory" : "Memories"}` +
    (findings === 0
      ? " — keine weicht von ihrer Quelle ab"
      : `, ${findings} ${findings === 1 ? "weicht" : "weichen"} von ihrer Quelle ab`),
  claimsUnverifiable: (n) =>
    `${n} ${n === 1 ? "Angabe ließ" : "Angaben ließen"} sich nicht prüfen (Quelle fehlt, liegt außerhalb des Vaults, ist keine Datei oder größer als 1 MB)`,
  claimGone: (source) => `zitierter Text steht nicht mehr in ${source}`,
  claimAmbiguous: (count, source) => `zitierter Text kommt ${count}-mal in ${source} vor`,
  claimDigest: (source) => `${source} hat sich seit dem gespeicherten Prüfwert geändert`,
  claimDiffers: (expect, source, value) => `Notiz sagt ${expect}, ${source} sagt ${value}`,
  clientFolder: (client, dir, notes, pending) =>
    `${pending > 0 ? "⚠ " : ""}${client}: ${dir} — ${notes} ${notes === 1 ? "Notiz" : "Notizen"}` +
    (pending > 0 ? `, ${pending} noch nicht im Vault` : ", alle importiert"),
  clientImport:
    `Recall liest diese Ordner nie — importiere sie mit 'bastra import clients' ` +
    `(--dry-run zeigt vorher, was passiert; ein erneuter Lauf holt nur Geändertes)`,
  affectsNotChecked: (count, memories) =>
    `${count} ${count === 1 ? "Eintrag" : "Einträge"} in ${memories} ${memories === 1 ? "Memory" : "Memories"} — hier nicht geprüft (an diesem Ort gibt es kein git-Repository)`,
  affectsNotRepoPaths: (n) =>
    `${n} weitere${n === 1 ? "r Eintrag nennt einen absoluten oder Home-Pfad" : " Einträge nennen absolute oder Home-Pfade"} — keine Pfade im Repository, nichts aufzulösen`,
  bridgesChurn: (demoted, archived, days) =>
    `· ${demoted} Brücke(n) herabgestuft, ${archived} archiviert in den letzten ${days} Tagen — ` +
    "ausgelöst, ohne zu einem Laden oder einer genutzten Episode zu führen (#129), oder aus Maschinentext gebildet (#704); " +
    "siehe bridges/archive/log.jsonl im Commons-Klon, eine Datei zurückschieben stellt sie wieder her",
  bridgesLive:
    "· Anfrageerweiterung: live — Brücken erweitern Suchanfragen ('bastra bridges live off' schaltet zurück in den Schatten)",
  bridgesShadow:
    "· Anfrageerweiterung: Schatten — Auslösungen werden protokolliert (bridge_expansion, applied: false), die Rangfolge bleibt unverändert; " +
    "'bastra bridges live on', sobald 'bastra bridges verify' eine Brücke bestehen lässt",
  bridgesNoMint: (days) =>
    `⚠ in den letzten ${days} Tagen lief keine Brückenbildung — der Daemon bildet nach dem Start und dann täglich; ihn starten oder 'bastra bridges mint' ausführen`,
  bridgesLearned: (days, runs, written) =>
    `✓ ok: Brücken in den letzten ${days} Tagen gelernt (${runs} Bildungslauf/-läufe, zuletzt: ${written} geschrieben)`,
  bridgesStalled: (runs, days, minted) =>
    `⚠ Brückenlernen steht still: ${runs} Bildungslauf/-läufe in ${days} Tagen haben Kandidaten gebildet, aber keine geschrieben (zuletzt: ${minted} gebildet, 0 geschrieben) — ` +
    "Builds vor #672 hielten Brücken aus nur einem Treffer zurück; aktualisieren und 'bastra bridges mint' ausführen",
  bridgesNoReach: (days, runs) =>
    `⚠ in ${days} Tagen keine Brücke gelernt: ${runs} Bildungslauf/-läufe fanden keine genutzten Suchen im Telemetrie-Protokoll — ` +
    "Brücken lernen daraus, also prüfen, dass BASTRA_TELEMETRY nicht 'off' ist",
  bridgesNothingToLearn: (runs, days, reaches) =>
    `✓ ok: ${runs} Bildungslauf/-läufe in ${days} Tagen, keine Suche brauchte eine Brücke (zuletzt: ${reaches} genutzte(r) Treffer)`,
  deliveryHeader: "→ Auslieferung je Client (was der Daemon jedem Client gerade übergibt)",
  deliveryOk: (surface, tools, mcpSurface, start, full) =>
    `  ✓ ${surface}: MCP listet ${tools} Werkzeuge (Oberfläche ${mcpSurface}); Schätzung aus dem Katalog (~4 Zeichen je Token): ` +
    `~${start} Tokens, wenn der Client Definitionen nachlädt (beim Start nur Werkzeugnamen + Server-Anleitung), ` +
    `~${full} Tokens, wenn er alle Definitionen sofort lädt; die tatsächliche Ladeart des Clients ist nicht geprüft`,
  deliveryMissing: (surface, detail) =>
    `  ⚠ ${surface}: die MCP-Werkzeugliste kam nicht vom Daemon: ${detail}; der Client nutzt die mitgelieferte Liste, bis er erreichbar ist`,
  deliveryHttp: (status) => `der Daemon antwortete mit HTTP ${status}`,
  deliveryNoList: "der Daemon schickte keine Werkzeugliste",
  deliveryUnreachable: (message) => `Daemon nicht erreichbar (${message})`,
};

export const DOCTOR_NOTES_WORDS: Readonly<Record<string, DoctorNotesWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function doctorNotesWordsIn(language: string | undefined): DoctorNotesWords {
  return DOCTOR_NOTES_WORDS[language ?? "en"] ?? en;
}
