/**
 * The words `bastra drafts` prints, by language.primary (#1602): English is
 * the default and the fallback (byte-identical to before), German complete.
 * Text the product writes — never matched against user text. `--json` output
 * and the undo refusals of draft-promote.ts stay as they are.
 */
const en = {
  storeFull: (rows: number, max: number) =>
    `Draft store is full (${rows} of ${max} rows): new captures still come in; the oldest confirmed drafts make room for them.\n`,
  noVault: "error: configure a vault or pass --vault\n",
  undone: (id: string) => `Draft promotion undone: ${id}\n`,
  rejected: (id: string) => `Draft rejected: ${id}\n`,
  alreadyRejected: (id: string) => `Draft already rejected: ${id}\n`,
  alreadyPromoted: (id: string) => `Draft already promoted, not rejected: ${id}; use bastra drafts undo ${id}\n`,
  noOpenDraft: (id: string) => `No open draft with this id: ${id}\n`,
  purged: (pendingRelay: boolean) =>
    `Local drafts, vectors and decision receipts cleared; pending relay ${pendingRelay ? "cleared" : "not present"}.\n`,
  noDrafts: "No local drafts.\n",
  error: (message: string) => `error: ${message}\n`,
  cannotAccess: "cannot access local drafts",
};
export type DraftsCmdWords = typeof en;

const de: DraftsCmdWords = {
  storeFull: (rows: number, max: number) =>
    `Der Entwurfsspeicher ist voll (${rows} von ${max} Zeilen): Neue Erfassungen kommen weiter hinein, dafür fallen die ältesten bestätigten Entwürfe heraus.\n`,
  noVault: "Fehler: einen Vault einrichten oder --vault angeben\n",
  undone: (id: string) => `Übernahme des Entwurfs rückgängig gemacht: ${id}\n`,
  rejected: (id: string) => `Entwurf abgelehnt: ${id}\n`,
  alreadyRejected: (id: string) => `Entwurf schon abgelehnt: ${id}\n`,
  alreadyPromoted: (id: string) =>
    `Entwurf schon übernommen, nicht abgelehnt: ${id}; rückgängig mit bastra drafts undo ${id}\n`,
  noOpenDraft: (id: string) => `Kein offener Entwurf mit dieser id: ${id}\n`,
  purged: (pendingRelay: boolean) =>
    `Lokale Entwürfe, Vektoren und Entscheidungsbelege gelöscht; ausstehende Weitergabe ${pendingRelay ? "gelöscht" : "nicht vorhanden"}.\n`,
  noDrafts: "Keine lokalen Entwürfe.\n",
  error: (message: string) => `Fehler: ${message}\n`,
  cannotAccess: "kein Zugriff auf die lokalen Entwürfe",
};

export const DRAFTS_CMD_WORDS: Readonly<Record<string, DraftsCmdWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function draftsCmdWordsIn(language: string | undefined): DraftsCmdWords {
  return DRAFTS_CMD_WORDS[language ?? "en"] ?? en;
}
