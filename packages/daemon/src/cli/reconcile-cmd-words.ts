/**
 * The words `bastra reconcile` prints, by language.primary (#1602): English
 * is the default and the fallback (byte-identical to before), German
 * complete. Text the product writes — never matched against user text.
 * `--json` keeps its machine keys and reason codes; the usage block lives in
 * usage-block-words.ts.
 */
const en = {
  reason: {
    "both-changed": "both sides have audited writes the other lacks",
    unrecorded: "content differs, neither audit log says why (edited outside bastra?)",
    "deleted-on-one-side": "deleted on one side, still present on the other",
    "duplicate-id": "two files with this id in one store",
    "path-taken": "the other store already has a different file at this path",
  } as Record<string, string>,
  paragraphs: (here: number, there: number) => `paragraphs: ${here} only here, ${there} only there`,
  fields: (list: string) => `fields: ${list}`,
  thisStore: (root: string, n: number) => `this store:  ${root}  (${n} memories)`,
  otherStore: (root: string, n: number) => `other store: ${root}  (${n} memories)`,
  same: (n: number) => `same:        ${n}`,
  generatedOnly: (n: number) => `  (${n} differ only in generated fields/blocks)`,
  auditEntries: (n: number) => `  [${n} audit entr${n === 1 ? "y" : "ies"} the other lacks]`,
  thisAhead: "this ahead → copy to other",
  otherAhead: "other ahead → copy here",
  onlyHere: "only here → copy to other",
  onlyThere: "only there → copy here",
  conflicts: (n: number) => `conflicts (left alone, decide by hand): ${n}`,
  here: "here",
  there: "there",
  unreadable: (list: string) => `unreadable (not compared): ${list}`,
  exclusive: "bastra reconcile: --yes and --dry-run exclude each other",
  needsOther: "bastra reconcile: --yes needs the other store as an argument",
  failed: (message: string) => `bastra reconcile: ${message}`,
  notDir: (path: string) => `bastra reconcile: not a directory: ${path}`,
  sameStore: "bastra reconcile: both paths are the same store",
  dryRun: (other: string, n: number, stamp: string) =>
    `\ndry run — nothing written. 'bastra reconcile ${other} --yes' copies the ${n} above; ` +
    `overwritten files go to <store>/.bastra/reconcile-backup/${stamp}/ first.`,
  nothingToCopyAfterPlan: "\nnothing to copy.",
  copied: (id: string, target: string | undefined, backup: string | undefined, warning: string | undefined) =>
    `copied   ${id} → ${target}${backup ? `  (backup: ${backup})` : ""}${warning ? `  WARNING: ${warning}` : ""}`,
  skipped: (id: string, reason: string | undefined, backup: string | undefined) =>
    `skipped  ${id}: ${reason}${backup ? `  (backup: ${backup})` : ""}`,
  nothingToCopy: "nothing to copy.",
  dryRunAgainst: (path: string) => `\ndry run against ${path}:\n`,
  nothingWritten: (path: string) => `\nnothing written. 'bastra reconcile ${path} --yes' copies the unambiguous ones.`,
  compareOne: `\ncompare one with 'bastra reconcile <store>'.`,
};
export type ReconcileCmdWords = typeof en;

const de: ReconcileCmdWords = {
  reason: {
    "both-changed": "beide Seiten haben protokollierte Schreibvorgänge, die der anderen fehlen",
    unrecorded: "Inhalt weicht ab, kein Protokoll sagt warum (außerhalb von bastra bearbeitet?)",
    "deleted-on-one-side": "auf einer Seite gelöscht, auf der anderen noch vorhanden",
    "duplicate-id": "zwei Dateien mit dieser id in einem Speicher",
    "path-taken": "der andere Speicher hat unter diesem Pfad schon eine andere Datei",
  },
  paragraphs: (here: number, there: number) => `Absätze: ${here} nur hier, ${there} nur dort`,
  fields: (list: string) => `Felder: ${list}`,
  thisStore: (root: string, n: number) => `dieser Speicher:  ${root}  (${n} Memories)`,
  otherStore: (root: string, n: number) => `anderer Speicher: ${root}  (${n} Memories)`,
  same: (n: number) => `gleich:           ${n}`,
  generatedOnly: (n: number) => `  (${n} unterscheiden sich nur in erzeugten Feldern/Blöcken)`,
  auditEntries: (n: number) => `  [${n} Protokolleintr${n === 1 ? "ag" : "äge"}, die der anderen Seite fehlen]`,
  thisAhead: "dieser vorn → zum anderen kopieren",
  otherAhead: "anderer vorn → hierher kopieren",
  onlyHere: "nur hier → zum anderen kopieren",
  onlyThere: "nur dort → hierher kopieren",
  conflicts: (n: number) => `Konflikte (unberührt, von Hand entscheiden): ${n}`,
  here: "hier",
  there: "dort",
  unreadable: (list: string) => `unlesbar (nicht verglichen): ${list}`,
  exclusive: "bastra reconcile: --yes und --dry-run schließen sich aus",
  needsOther: "bastra reconcile: --yes braucht den anderen Speicher als Argument",
  failed: (message: string) => `bastra reconcile: Fehler: ${message}`,
  notDir: (path: string) => `bastra reconcile: kein Ordner: ${path}`,
  sameStore: "bastra reconcile: beide Pfade sind derselbe Speicher",
  dryRun: (other: string, n: number, stamp: string) =>
    `\nProbelauf — nichts geschrieben. 'bastra reconcile ${other} --yes' kopiert die ${n} oben; ` +
    `überschriebene Dateien kommen vorher nach <speicher>/.bastra/reconcile-backup/${stamp}/.`,
  nothingToCopyAfterPlan: "\nnichts zu kopieren.",
  copied: (id: string, target: string | undefined, backup: string | undefined, warning: string | undefined) =>
    `kopiert       ${id} → ${target}${backup ? `  (Sicherung: ${backup})` : ""}${warning ? `  WARNUNG: ${warning}` : ""}`,
  skipped: (id: string, reason: string | undefined, backup: string | undefined) =>
    `übersprungen  ${id}: ${reason}${backup ? `  (Sicherung: ${backup})` : ""}`,
  nothingToCopy: "nichts zu kopieren.",
  dryRunAgainst: (path: string) => `\nProbelauf gegen ${path}:\n`,
  nothingWritten: (path: string) =>
    `\nnichts geschrieben. 'bastra reconcile ${path} --yes' kopiert die eindeutigen Fälle.`,
  compareOne: `\neinen davon vergleichen mit 'bastra reconcile <speicher>'.`,
};

export const RECONCILE_CMD_WORDS: Readonly<Record<string, ReconcileCmdWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function reconcileCmdWordsIn(language: string | undefined): ReconcileCmdWords {
  return RECONCILE_CMD_WORDS[language ?? "en"] ?? en;
}
