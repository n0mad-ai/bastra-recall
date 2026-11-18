/**
 * The multi-line usage blocks of CLI commands by language.primary (#1602):
 * English is the default and the fallback (byte-identical to before), German
 * complete. Text the product writes — never matched against user text.
 */
import { taskCliLanguage } from "./task-cli-words.js";

const en = {
  archive:
    "usage: bastra archive put <path>...        move paths into the archive (never deletes, temp dirs too)\n" +
    "       bastra archive list                 what the agent's rm archived (last 30 days)\n" +
    "       bastra archive restore <path|ref>   put it back (a path, or a git snapshot ref / sha)\n" +
    "       bastra archive reconcile [--yes]    show (or, with --yes, remove) what the archive can let go\n" +
    "retention: bastra config set archive.retain junk=1,in-git=2,user=2  (days; env BASTRA_ARCHIVE_RETAIN wins)\n" +
    "limits:    bastra config set archive.cap 10GB       (the whole archive; env BASTRA_ARCHIVE_CAP wins)\n" +
    "           bastra config set archive.max-item 2GB   (largest target it takes, off = none; env BASTRA_ARCHIVE_MAX_ITEM wins)",
  trash:
    "usage: bastra trash list              archived memories that can be restored (newest first)\n" +
    "       bastra trash restore <id>      put an archived memory back where it lived",
  skills:
    "usage: bastra skills list\n" +
    "       bastra skills add <id> [label…]     declare a skill (id = the ghost node it should adopt)\n" +
    "       bastra skills remove <id>           back to ordinary ghost behavior\n",
  reconcile:
    "usage: bastra reconcile [--vault <this-store>]                  list the copies of this vault\n" +
    "       bastra reconcile <other-store> [--vault <this-store>]   show which copy is ahead (dry run)\n" +
    "       bastra reconcile <other-store> --yes                     copy the unambiguous ones, with backup",
  rules: [
    "usage: bastra rules proposals            show pending proposals with full text and revision",
    "       bastra rules confirm|reject <id> <revision> user-directed",
    "       bastra rules cursor [path]        install the rules file into a project",
    "       bastra rules cursor [path] --dry-run",
    "       bastra rules remove cursor [path] remove it again",
    "",
    "  path defaults to the current directory.",
    "",
    "Cursor keeps project rules in the repo (.cursor/rules/*.mdc) and has no",
    "global rules file, so this runs once per project you want memory in.",
    "",
  ].join("\n"),
  patches:
    "usage: bastra patches [list|add <file>|remove <id>|status]\n" +
    "  list            the series, in apply order (default)\n" +
    "  add <file>      register a git-format patch\n" +
    "  remove <id>     drop a patch from the series\n" +
    "  status          probe every patch against the current installation\n\n" +
    "Registered patches are reapplied automatically after 'bastra update'.\n" +
    "A patch upstream has absorbed is retired; one that no longer applies is\n" +
    "set aside and reported, never forced.\n",
  onboard:
    "usage: bastra onboard                   run the interview (interactive)\n" +
    "       bastra onboard --answers <file>  save answers from a JSON/YAML file (no TTY needed)\n" +
    "       bastra onboard skip             stop the onboarding nudge without answering\n",
  import:
    "usage: bastra import <file|-> [chatgpt|claude|gemini|text]\n" +
    "       bastra import rules    scan local rules files (CLAUDE.md, AGENTS.md,\n" +
    "                              .cursorrules, .cursor/rules/, ~/.claude/CLAUDE.md)\n" +
    "       bastra import clients  Claude Code's and Codex's own memory folders\n" +
    "       bastra import mine     next chunk of a queued conversations.json export\n" +
    "       bastra import clear    discard the mining queue\n" +
    "  <file>  an exported memory list (one fact per line, or a JSON array of strings) —\n" +
    "          or a ChatGPT/Claude conversations.json data export (queued for mining)\n" +
    "  -       read the list from stdin (paste + Ctrl-D)\n\n" +
    "Where to get the list:\n" +
    "  ChatGPT  Settings → Personalization → Manage memories → copy\n" +
    "  Claude   Settings → memory text → copy\n" +
    "  Gemini   Settings → Saved Info → copy\n",
  importVault:
    "usage: bastra import vault <dir> [label] [--dry-run] [--exclude <dir>]…\n" +
    "  imports a folder of memory files (e.g. a Claude Code memory dir) into\n" +
    "  memories/imported/<label>/ — deterministic, no per-item review.\n" +
    "  label      namespace for this batch (default: the folder's name)\n" +
    "  --exclude  skip a directory name anywhere in the tree (repeatable);\n" +
    "             dotdirs, _archive/ and archive/ are always skipped\n",
  feedback: (repo: string): string =>
    "usage: bastra feedback <bug|idea>\n" +
    "  bug   open a prefilled bug report (includes the diagnostics below — nothing else)\n" +
    "  idea  open a feature-request form\n\n" +
    `Other channels: ${repo}/discussions (questions) · ${repo}/issues (all reports)\n`,
};
export type UsageBlockWords = typeof en;

const de: UsageBlockWords = {
  archive:
    "Aufruf: bastra archive put <pfad>...        Pfade ins Archiv verschieben (löscht nie, auch Temp-Ordner)\n" +
    "        bastra archive list                 was das rm des Agenten archiviert hat (letzte 30 Tage)\n" +
    "        bastra archive restore <pfad|ref>   zurücklegen (ein Pfad oder eine git-Snapshot-Ref / sha)\n" +
    "        bastra archive reconcile [--yes]    zeigen (mit --yes entfernen), was das Archiv freigeben kann\n" +
    "Aufbewahrung: bastra config set archive.retain junk=1,in-git=2,user=2  (Tage; env BASTRA_ARCHIVE_RETAIN hat Vorrang)\n" +
    "Grenzen:      bastra config set archive.cap 10GB       (das ganze Archiv; env BASTRA_ARCHIVE_CAP hat Vorrang)\n" +
    "              bastra config set archive.max-item 2GB   (größtes Ziel, das es annimmt, off = keine; env BASTRA_ARCHIVE_MAX_ITEM hat Vorrang)",
  trash:
    "Aufruf: bastra trash list              archivierte Memories, die sich wiederherstellen lassen (neueste zuerst)\n" +
    "        bastra trash restore <id>      ein archiviertes Memory an seinen alten Ort zurücklegen",
  skills:
    "Aufruf: bastra skills list\n" +
    "        bastra skills add <id> [bezeichnung…]  einen Skill deklarieren (id = der Geisterknoten, den er übernehmen soll)\n" +
    "        bastra skills remove <id>              zurück zum gewöhnlichen Geisterknoten\n",
  reconcile:
    "Aufruf: bastra reconcile [--vault <dieser-speicher>]                    die Kopien dieses Vaults auflisten\n" +
    "        bastra reconcile <anderer-speicher> [--vault <dieser-speicher>] zeigen, welche Kopie vorn liegt (Probelauf)\n" +
    "        bastra reconcile <anderer-speicher> --yes                       die eindeutigen Fälle kopieren, mit Sicherung",
  rules: [
    "Aufruf: bastra rules proposals            offene Vorschläge mit vollem Text und Revision zeigen",
    "        bastra rules confirm|reject <id> <revision> user-directed",
    "        bastra rules cursor [pfad]        die Regeldatei in ein Projekt installieren",
    "        bastra rules cursor [pfad] --dry-run",
    "        bastra rules remove cursor [pfad] sie wieder entfernen",
    "",
    "  pfad ist ohne Angabe der aktuelle Ordner.",
    "",
    "Cursor hält Projektregeln im Repo (.cursor/rules/*.mdc) und hat keine",
    "globale Regeldatei; das läuft also einmal je Projekt, das Memory bekommen soll.",
    "",
  ].join("\n"),
  patches:
    "Aufruf: bastra patches [list|add <datei>|remove <id>|status]\n" +
    "  list            die Serie in Anwendungsreihenfolge (Standard)\n" +
    "  add <datei>     einen Patch im git-Format registrieren\n" +
    "  remove <id>     einen Patch aus der Serie nehmen\n" +
    "  status          jeden Patch gegen die aktuelle Installation prüfen\n\n" +
    "Registrierte Patches werden nach 'bastra update' automatisch wieder angewendet.\n" +
    "Ein Patch, den upstream übernommen hat, wird stillgelegt; einer, der nicht mehr\n" +
    "passt, wird beiseitegelegt und gemeldet, nie erzwungen.\n",
  onboard:
    "Aufruf: bastra onboard                   das Interview führen (interaktiv)\n" +
    "        bastra onboard --answers <datei> Antworten aus einer JSON-/YAML-Datei speichern (ohne TTY)\n" +
    "        bastra onboard skip              den Onboarding-Hinweis ohne Antworten beenden\n",
  import:
    "Aufruf: bastra import <datei|-> [chatgpt|claude|gemini|text]\n" +
    "        bastra import rules    lokale Regeldateien durchsuchen (CLAUDE.md, AGENTS.md,\n" +
    "                               .cursorrules, .cursor/rules/, ~/.claude/CLAUDE.md)\n" +
    "        bastra import clients  die eigenen Memory-Ordner von Claude Code und Codex\n" +
    "        bastra import mine     nächster Abschnitt eines vorgemerkten conversations.json-Exports\n" +
    "        bastra import clear    die Abbau-Warteschlange verwerfen\n" +
    "  <datei> eine exportierte Memory-Liste (ein Fakt je Zeile oder ein JSON-Array aus Strings) —\n" +
    "          oder ein ChatGPT-/Claude-Datenexport conversations.json (zum Abbau vorgemerkt)\n" +
    "  -       die Liste von stdin lesen (einfügen + Ctrl-D)\n\n" +
    "Woher die Liste kommt:\n" +
    "  ChatGPT  Einstellungen → Personalisierung → Erinnerungen verwalten → kopieren\n" +
    "  Claude   Einstellungen → Memory-Text → kopieren\n" +
    "  Gemini   Einstellungen → Gespeicherte Infos → kopieren\n",
  importVault:
    "Aufruf: bastra import vault <ordner> [bezeichnung] [--dry-run] [--exclude <ordner>]…\n" +
    "  importiert einen Ordner mit Memory-Dateien (z. B. einen Claude-Code-Memory-Ordner) nach\n" +
    "  memories/imported/<bezeichnung>/ — deterministisch, ohne Prüfung je Eintrag.\n" +
    "  bezeichnung  Namensraum für diesen Stapel (Standard: der Name des Ordners)\n" +
    "  --exclude    einen Ordnernamen überall im Baum überspringen (wiederholbar);\n" +
    "               Punktordner, _archive/ und archive/ werden immer übersprungen\n",
  feedback: (repo: string): string =>
    "Aufruf: bastra feedback <bug|idea>\n" +
    "  bug   einen vorausgefüllten Fehlerbericht öffnen (mit der Diagnose unten — sonst nichts)\n" +
    "  idea  ein Formular für einen Funktionswunsch öffnen\n\n" +
    `Weitere Wege: ${repo}/discussions (Fragen) · ${repo}/issues (alle Meldungen)\n`,
};

export const USAGE_BLOCK_WORDS: Readonly<Record<string, UsageBlockWords>> = { en, de };
/** The usage blocks in `language`; English for an unset or unlisted one. */
export function usageBlocksIn(language: string | undefined): UsageBlockWords {
  return USAGE_BLOCK_WORDS[language ?? "en"] ?? en;
}
/** The usage blocks in language.primary (English when unset or unreadable). */
export async function usageBlocks(): Promise<UsageBlockWords> {
  return usageBlocksIn(await taskCliLanguage().catch(() => "en"));
}
