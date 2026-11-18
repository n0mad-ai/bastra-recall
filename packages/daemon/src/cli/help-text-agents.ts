/**
 * `--help` sections for the commands around agent work in a project: the task
 * board and the attached Codex chat, code awareness, and the archive behind the
 * agent's rm. Part of the COMMAND_HELP catalog assembled in help-text.ts.
 */

export const AGENT_COMMAND_HELP: Record<string, string> = {
  codex: `bastra codex — Start an attached Codex CLI chat with active task delivery

Usage:
  bastra codex [Codex options and prompt]
  bastra codex resume <thread-id>
  bastra codex -- -m <model>

Uses its own private local App Server and authenticated terminal connection.
No Codex settings are changed. Existing Codex, desktop and IDE chats are not
attached. The last real human-used chat wins globally with Claude Code within
tasks.chatActiveMinutes (default 30). Tasks remain data, never execution approval.
macOS notification and the board remain available. Requires Codex CLI 0.167.0
with App Server Unix transport and --remote support on macOS/Linux.
Codex options pass through unchanged; an alternative --remote is refused.
More: https://github.com/n0mad-ai/bastra-recall/wiki/Active-Chat-Notifications`,

  tasks: `Ab v1.2.0 standardmäßig an. Abschalten: tasks.enabled=false oder BASTRA_TASKS=0; Daemon und Clients/Hooks neu starten.

bastra tasks — Aufgaben und Erinnerungen (bei nächstem Kontakt)
Usage: bastra tasks <create|list|due|status|setup-hooks|client-status|ui> [options]
Erster Zugang: tasks auth mint owner ich personal ~/.bastra/owner-task.token.
Token im lokalen Editor kopieren, nur verborgen im Terminal/Browser eingeben.
Optional tasks owner-login: private Ablage nur für interaktive Owner-CLI, nie Hooks/MCP.
Dann tasks setup-hooks, tasks client-status, tasks create --goal "Test" --after 1m --arm.
Nach Fälligkeit: tasks due, tasks acknowledge ID --occurrence VORKOMMEN, tasks resolve ID.
Scharf schalten = review; rearm stellt ausdrücklich UNSCHARF zur neuen Prüfung.
  bastra tasks create --goal "Nach sieben Tagen auswerten" --after 7d --domain personal --timezone Europe/Madrid --arm
  bastra tasks create --goal "Täglich prüfen" --when 2026-10-12T18:00 --timezone Europe/Madrid --every 1d --count 3
  bastra tasks create --goal "Termin prüfen" --when 2026-10-12T18:00 --timezone Europe/Madrid --expires 2026-10-13T18:00
  bastra tasks edit ID --expires none   (Gültigkeitsende entfernen)
  bastra tasks list | due | status [--json] [--agent]
  bastra tasks mute|unmute|off|on|stop|resume  Globale Owner-Steuerung
  bastra tasks get|review|resolve|cancel|rearm|delete <id>
  bastra tasks pause|resume|end-series <id>  Pausieren, fortsetzen oder Serie beenden
  Wiederholung: --every 1d auch ohne --count/--end; resolve erledigt nur einen Termin.
  bastra tasks acknowledge <id> --occurrence <occurrence-id>
  bastra tasks snooze <id> --until 2026-10-13T18:00
  bastra tasks targets register demo --root DIRECTORY --path artifact.txt --domain personal
  bastra tasks targets update ID --root DIR --path FILE --domain DOMAIN
  bastra tasks targets remove ID --agent  Beauftragtes Ziel entfernen, Ausführung stoppen
  bastra tasks targets list       Vorhandene lokale reversible Ziele, kein Anbieter
  bastra tasks archive ID         Nur abgeschlossene Arbeit; vorher tasks stop
  bastra tasks archive-restore ARCHIV_ID  Verlauf/Rollback aufnehmen, unscharf
  bastra tasks recover [--lock]   Owner offline: Prozesse stoppen, Backup/Original sichern
  bastra tasks setup-hooks        Owner richtet lokale Hook-Karten mit eigener Agent-Kennung ein
  bastra tasks client-status      Zeigt fehlende/revokte Client-Kennung ehrlich
  bastra tasks <operation> --input input.json  Erweiterte/Maschinen-Eingabe
Owner-Kennung wird verborgen am Terminal abgefragt; --agent verwendet zugewiesene
Client-Kennung. Beauftragte Aufgaben werden mit --agent direkt scharf angelegt;
--agent --arm ist für alle Aufgabenstufen ohne weitere Owner-Freigabe erlaubt. Ohne Agent-Auftrag bleibt
Anlegen ohne Auftrag standardmäßig unscharf. Auch bei execute gilt die Nutzeranweisung im Chat als Freigabe.
--after 7d ist eine verstrichene Dauer; --when ohne Offset nutzt die genannte Zeitzone.
Quittiert heißt gesehen, nicht erledigt. Kleine Hook-Karten: bastra tasks due.
  bastra tasks auth mint|rotate owner|agent actor domain[,domain] new-token-file [old-id]
  bastra tasks auth revoke credential-id
  bastra tasks execution-enable --agent  Beauftragt lokalen Adapter aktivieren, Stopp aufheben
  bastra tasks release LEASE_ID   Eigene Reservierung freigeben; keine Freigabe erneuern
  bastra tasks prepare --agent --input input.json
Maschineneingabe: authorization {write_origin:"user-directed", session_id, program,
user_request, at}. Der Agent übergibt die Nutzeranweisung, Recall wertet den Wortlaut
nicht aus. Für eigene folgenreiche Vorschläge einmal im Chat fragen und das Ja
genauso erfassen. Keine Schlüssel, Passphrase oder zweite Bestätigung.
Historische Signaturbefehle sind nur für Altbestände erhalten. Kein Hintergrund-Wakeup;
BASTRA_TASK_TOKEN überschreibt die private lokale Hook-Konfiguration.`,

  code: `bastra code — code awareness for a repository (experimental)

Usage:
  bastra code                        What is enabled, which Graphify, how fresh,
                                     and whether the daemon's automatic refresh
                                     is paused or stopped (and until when)
  bastra code enable [<dir>]         Turn it on here and build the graph once
  bastra code disable [<dir>]        Turn it off; the graph files stay
  bastra code index [<dir>]          Refresh the graph (incremental, ~2s) and
                                     resume a paused or stopped daemon refresh
  bastra code rebuild [<dir>] [--yes]
                                     Repair: rebuild with --force, which
                                     overrides Graphify's refusal to replace a
                                     larger graph with a smaller one

Recall reads the graph Graphify writes and shows an agent what depends on a
file before it edits one. Nothing is indexed until you enable a repository,
the graph never leaves your machine, and no code is sent to an LLM.

Experimental. It can help an agent find its way into an unfamiliar or large
repository. For "what breaks if I change this" it did not beat plain search
in our measurements on repositories like ours, and it costs context (the
dependents block before edits) and background CPU (graph refreshes).

The graph lives in <dir>/graphify-out/ and is excluded from git locally.
macOS and Linux for now.`,

  archive: `bastra archive — the archive behind the agent's rm

Usage:
  bastra archive put <path>...        move paths into the archive (never deletes)
  bastra archive list                 what was archived, deleted or refused (30 days)
  bastra archive restore <path|ref>   put it back (a path, or a git snapshot ref / sha)
  bastra archive reconcile [--yes]    show (with --yes: remove) what can go

Opt-in, off by default: bastra config set archive.enabled on (or
BASTRA_RM_ARCHIVES=1 in the daemon's environment, which wins). Only for hook
calls marked as Claude Code (re-run bastra install once to add the marker).

With it on, a Claude Code Bash command made only of rm runs through bastra's
archiving rm, without the usual permission prompt:
targets move to ~/.bastra/archive/<date>/<time-pid>/<full path>, temp dirs
are really removed, /, ~ and system dirs are refused. Old entries go by class,
checked hourly after Bash calls: build junk after 1 day, clean git-tracked
after 2, the rest after 2; the size cap never touches your own files younger
than their retention. Change it (days, fractions allowed; env
BASTRA_ARCHIVE_RETAIN wins):
  bastra config set archive.retain junk=1,in-git=2,user=2
Limits (sizes like 5GB or 500MB; env BASTRA_ARCHIVE_CAP and
BASTRA_ARCHIVE_MAX_ITEM win):
  bastra config set archive.cap 10GB       the whole archive (default 10 GB)
  bastra config set archive.max-item 2GB   largest target it takes (default:
                                           none; off removes it). A larger one
                                           is refused, not archived, not deleted.
Another archive directory: BASTRA_ARCHIVE_DIR. It must be your own; if it is
open to others, it is closed to you alone. One of another account, or one that
directly holds a link or another account's entry, is not used, and nothing is
archived or removed.
Only the rm part off: BASTRA_RM_SHIM=0.

bastra archive put <path>... makes the archiving rm's move by hand, opt-in
or not: same archive, same restore, and temp dirs are archived too, never
deleted. A user who denies Bash(rm:*) in Claude Code can allow
Bash(bastra archive put:*) on its own; the hook never rewrites rm into it.

git acts that lose work (clean -f, reset --hard, checkout [<tree>] -- <paths>,
restore, branch -D, stash drop|clear) are snapshotted first: clean's files
and any untracked file the act would overwrite go to the archive, the rest
is pinned under refs/bastra-archive/ and listed here too;
\`bastra archive restore <ref>\` puts it back. The pins show up in
\`git log --all\` until they expire. Only the git part off: BASTRA_GIT_SHIM=0.
`,
};
