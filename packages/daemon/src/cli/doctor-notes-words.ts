/**
 * The words of three global `bastra doctor` notes — sync conflict copies
 * (#1485), derived claims (#609) and the clients' own memory folders (#674) —
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
};

export const DOCTOR_NOTES_WORDS: Readonly<Record<string, DoctorNotesWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function doctorNotesWordsIn(language: string | undefined): DoctorNotesWords {
  return DOCTOR_NOTES_WORDS[language ?? "en"] ?? en;
}
