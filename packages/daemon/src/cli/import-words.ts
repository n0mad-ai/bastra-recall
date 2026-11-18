/**
 * The words `bastra import` prints for people, by language.primary (#1602):
 * English is the default and the fallback (byte-identical to before), German
 * complete. `bastra import mine` is read by the AI session and keeps its
 * English instructions. Text the product writes — never matched against user text.
 */
import { taskCliLanguage } from "./task-cli-words.js";

const en = {
  error: (message: string) => `error: ${message}\n`,
  unknownSource: (source: string, sources: string) => `error: unknown source '${source}' — one of: ${sources}\n`,
  tooLarge: (file: string, mb: number) => `error: ${file} is ${mb} MB — too large to parse safely (max 256 MB)\n`,
  cannotRead: (file: string, message: string) => `error: cannot read ${file}: ${message}\n`,
  ownFile: (file: string) => `error: ${file} is written by bastra itself — it is never an import source.\n`,
  noCandidates: "no candidates found — is this a memory list (one fact per line)?\n",
  staged: (staged: number, file: string, source: string, duplicates: number, open: number) =>
    `✓ ${staged} candidate(s) staged in ${file} (source: ${source})` +
    (duplicates > 0 ? ` · ${duplicates} duplicate(s) skipped` : "") +
    `\n  ${open} open in total — your next AI session will offer to distill them with you.\n` +
    `  Nothing is saved to the vault without your accept.\n`,
  unrecognizedJson:
    "error: unrecognized JSON shape — expected a memory list (JSON array of strings) " +
    "or a ChatGPT/Claude conversations.json data export\n",
  queued: (queued: number, messages: number, source: string, file: string, pending: number) =>
    `✓ ${queued} conversation(s) queued for mining — ${messages} of YOUR messages kept, ` +
    `assistant turns dropped (source: ${source})\n` +
    `  Queue: ${file} (${pending} pending) — local only, never leaves this\n` +
    `  machine, deleted when mining completes. Discard anytime: bastra import clear\n` +
    `  In your AI session say "mine the imported chat history" — it combs the queue\n` +
    `  chunk-wise via \`bastra import mine\` and stages candidate facts for your review.\n`,
  noRulesFiles:
    "no rules files found — looked for CLAUDE.md, AGENTS.md, .cursorrules and .cursor/rules/ " +
    "here, and ~/.claude/CLAUDE.md\n",
  candidates: (n: number) => `${n} candidate(s)`,
  noCandidatesBecause: (reason: string | null) => `0 candidates: ${reason}`,
  unreadable: (message: string) => `0 candidates: unreadable (${message})`,
  nothingToStage: "nothing to stage — see the per-file reasons above\n",
  imported: (dryRun: boolean, imported: number, scanned: number, folder: string, scope: string) =>
    `✓ ${dryRun ? "would import" : "imported"} ${imported}/${scanned} file(s) → ${folder}/ ` + `(scope: ${scope})\n`,
  written: (created: number, updated: number, unchanged: number) =>
    `${created} created · ${updated} updated · ` + `${unchanged} unchanged`,
  failed: (n: number) => ` · ${n} failed`,
  adapters: (claudeCode: number, generic: number) =>
    `  ${claudeCode} via Claude-Code adapter · ${generic} generic markdown`,
  curatedIndex: (n: number) => ` · ${n} curated index`,
  skippedCount: (n: number) => ` · ${n} skipped`,
  orphanedCount: (n: number) => ` · ${n} orphaned`,
  skipped: (file: string, reason: string) => `  · skipped ${file}: ${reason}\n`,
  andMore: (n: number) => `  · …and ${n} more\n`,
  warning: (file: string, reason: string) => `  · warning ${file}: ${reason}\n`,
  andMoreWarnings: (n: number) => `  · …and ${n} more warnings\n`,
  sourceGone: (source: string, file: string) => `  · source file gone — memory kept: ${source} (${file})\n`,
  andMoreOrphaned: (n: number) => `  · …and ${n} more orphaned\n`,
  nothingRemoved: `  nothing was removed — review and delete by hand if that's what you want.\n`,
  indexesThem: (folder: string) =>
    `  the running daemon indexes them automatically; delete the whole set anytime\n` +
    `  by removing the ${folder}/ folder.\n`,
  noClientNotes: "no client memory notes found — looked in ~/.claude/projects/*/memory and ~/.codex/memories\n",
  notMoved: (where: string, reason: string) => `! ${where} not moved: ${reason} — the import below writes beside it\n`,
  moved: (where: string, n: number, dryRun: boolean) =>
    `✓ ${where} — ${n} memory id(s) ${dryRun ? "would be renamed" : "renamed"}\n`,
  leftUntouched: (file: string, folder: string) =>
    `  · left untouched: ${file} — not written by this import; ` +
    `it stays in ${folder}; move it where it belongs, or leave it (a rerun does not touch it)\n`,
  moveFailed: (message: string) => `✗ moving an earlier import to its new label failed: ${message}\n`,
  wouldImport: (imported: number, scanned: number) => `${imported}/${scanned} file(s) would be imported`,
  originalsStay: "  the originals stay where they are; the running daemon indexes the imported copies.\n",
  cleared: (n: number) => `✓ mining queue cleared — ${n} pending conversation(s) discarded\n`,
  alreadyEmpty: "mining queue is already empty\n",
};
export type ImportWords = typeof en;

const de: ImportWords = {
  error: (message) => `Fehler: ${message}\n`,
  unknownSource: (source, sources) => `Fehler: unbekannte Quelle '${source}' — eine von: ${sources}\n`,
  tooLarge: (file, mb) => `Fehler: ${file} hat ${mb} MB — zu groß zum sicheren Einlesen (höchstens 256 MB)\n`,
  cannotRead: (file, message) => `Fehler: ${file} lässt sich nicht lesen: ${message}\n`,
  ownFile: (file) => `Fehler: ${file} schreibt bastra selbst — das ist nie eine Importquelle.\n`,
  noCandidates: "keine Kandidaten gefunden — ist das eine Memory-Liste (ein Fakt pro Zeile)?\n",
  staged: (staged, file, source, duplicates, open) =>
    `✓ ${staged} Kandidat(en) in ${file} vorgemerkt (Quelle: ${source})` +
    (duplicates > 0 ? ` · ${duplicates} Duplikat(e) übersprungen` : "") +
    `\n  ${open} insgesamt offen — deine nächste KI-Sitzung bietet an, sie mit dir aufzubereiten.\n` +
    `  Nichts landet ohne deine Zustimmung im Vault.\n`,
  unrecognizedJson:
    "Fehler: unbekannte JSON-Form — erwartet wird eine Memory-Liste (JSON-Array aus Strings) " +
    "oder ein conversations.json-Datenexport von ChatGPT/Claude\n",
  queued: (queued, messages, source, file, pending) =>
    `✓ ${queued} Unterhaltung(en) zum Auswerten eingereiht — ${messages} DEINER Nachrichten behalten, ` +
    `Antworten des Assistenten verworfen (Quelle: ${source})\n` +
    `  Warteschlange: ${file} (${pending} offen) — nur lokal, verlässt diesen\n` +
    `  Rechner nie, wird nach dem Auswerten gelöscht. Jederzeit verwerfen: bastra import clear\n` +
    `  Sag in deiner KI-Sitzung „werte den importierten Chatverlauf aus“ — sie arbeitet die Warteschlange\n` +
    `  stückweise über \`bastra import mine\` ab und merkt Kandidaten zur Prüfung vor.\n`,
  noRulesFiles:
    "keine Regeldateien gefunden — gesucht nach CLAUDE.md, AGENTS.md, .cursorrules und .cursor/rules/ " +
    "hier sowie ~/.claude/CLAUDE.md\n",
  candidates: (n) => `${n} Kandidat(en)`,
  noCandidatesBecause: (reason) => `0 Kandidaten: ${reason}`,
  unreadable: (message) => `0 Kandidaten: nicht lesbar (${message})`,
  nothingToStage: "nichts vorzumerken — siehe die Gründe je Datei oben\n",
  imported: (dryRun, imported, scanned, folder, scope) =>
    `✓ ${dryRun ? "würde importieren" : "importiert"}: ${imported}/${scanned} Datei(en) → ${folder}/ (Bereich: ${scope})\n`,
  written: (created, updated, unchanged) => `${created} neu · ${updated} geändert · ${unchanged} unverändert`,
  failed: (n) => ` · ${n} fehlgeschlagen`,
  adapters: (claudeCode, generic) => `  ${claudeCode} über den Claude-Code-Adapter · ${generic} allgemeines Markdown`,
  curatedIndex: (n) => ` · ${n} kuratierter Index`,
  skippedCount: (n) => ` · ${n} übersprungen`,
  orphanedCount: (n) => ` · ${n} verwaist`,
  skipped: (file, reason) => `  · übersprungen ${file}: ${reason}\n`,
  andMore: (n) => `  · …und ${n} weitere\n`,
  warning: (file, reason) => `  · Warnung ${file}: ${reason}\n`,
  andMoreWarnings: (n) => `  · …und ${n} weitere Warnungen\n`,
  sourceGone: (source, file) => `  · Quelldatei weg — Memory bleibt: ${source} (${file})\n`,
  andMoreOrphaned: (n) => `  · …und ${n} weitere verwaiste\n`,
  nothingRemoved: "  nichts wurde entfernt — prüfen und von Hand löschen, falls gewünscht.\n",
  indexesThem: (folder) =>
    `  der laufende Daemon indiziert sie automatisch; den ganzen Satz jederzeit löschen,\n` +
    `  indem du den Ordner ${folder}/ entfernst.\n`,
  noClientNotes:
    "keine Memory-Notizen der Clients gefunden — gesucht in ~/.claude/projects/*/memory und ~/.codex/memories\n",
  notMoved: (where, reason) => `! ${where} nicht verschoben: ${reason} — der Import unten schreibt daneben\n`,
  moved: (where, n, dryRun) => `✓ ${where} — ${n} Memory-ID(s) ${dryRun ? "würden umbenannt" : "umbenannt"}\n`,
  leftUntouched: (file, folder) =>
    `  · unangetastet: ${file} — nicht von diesem Import geschrieben; ` +
    `bleibt in ${folder}; dorthin verschieben, wo sie hingehört, oder liegen lassen (ein erneuter Lauf rührt sie nicht an)\n`,
  moveFailed: (message) => `✗ ein früherer Import ließ sich nicht unter die neue Bezeichnung verschieben: ${message}\n`,
  wouldImport: (imported, scanned) => `${imported}/${scanned} Datei(en) würden importiert`,
  originalsStay: "  die Originale bleiben, wo sie sind; der laufende Daemon indiziert die importierten Kopien.\n",
  cleared: (n) => `✓ Auswertungs-Warteschlange geleert — ${n} offene Unterhaltung(en) verworfen\n`,
  alreadyEmpty: "die Auswertungs-Warteschlange ist schon leer\n",
};

export const IMPORT_WORDS: Readonly<Record<string, ImportWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function importWordsIn(language: string | undefined): ImportWords {
  return IMPORT_WORDS[language ?? "en"] ?? en;
}
/** The words in language.primary, read once per command (English when unset or unreadable). */
export async function importWords(): Promise<ImportWords> {
  return importWordsIn(await taskCliLanguage().catch(() => "en"));
}
