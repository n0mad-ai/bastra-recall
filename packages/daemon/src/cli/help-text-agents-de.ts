/**
 * German `--help` sections for the agent-work commands (#1602): the same keys
 * as AGENT_COMMAND_HELP in help-text-agents.ts, shown when language.primary
 * is "de". Text the product writes — never matched against user text.
 */

export const AGENT_COMMAND_HELP_DE: Record<string, string> = {
  codex: `bastra codex — Codex-CLI-Chat mit aktiver Aufgabenzustellung starten

Aufruf:
  bastra codex [Codex-Optionen und Prompt]
  bastra codex resume <thread-id>
  bastra codex -- -m <model>

Nutzt einen eigenen privaten lokalen App Server und eine authentifizierte
Terminalverbindung. Es werden keine Codex-Einstellungen geändert. Bestehende
Codex-, Desktop- und IDE-Chats werden nicht angebunden. Der zuletzt wirklich von
einem Menschen genutzte Chat gewinnt global gegenüber Claude Code innerhalb von
tasks.chatActiveMinutes (Standard 30). Aufgaben bleiben Daten, nie eine
Ausführungsfreigabe. macOS-Mitteilung und Board bleiben verfügbar. Benötigt
Codex CLI 0.167.0 mit App-Server-Unix-Transport und --remote auf macOS/Linux.
Codex-Optionen werden unverändert durchgereicht; ein anderes --remote wird abgelehnt.
Mehr: https://github.com/n0mad-ai/bastra-recall/wiki/Active-Chat-Notifications`,

  tasks: `Ab v1.2.0 standardmäßig an. Abschalten: tasks.enabled=false oder BASTRA_TASKS=0; Daemon und Clients/Hooks neu starten.

bastra tasks — Aufgaben und Erinnerungen (bei nächstem Kontakt)
Aufruf: bastra tasks <create|list|due|status|setup-hooks|client-status|ui> [Optionen]
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
Die Owner-Kennung wird verborgen am Terminal abgefragt; --agent verwendet die
zugewiesene Client-Kennung. Beauftragte Aufgaben werden mit --agent direkt scharf
angelegt; --agent --arm ist für alle Aufgabenstufen ohne weitere Owner-Freigabe
erlaubt. Ohne Agent-Auftrag bleibt eine neue Aufgabe standardmäßig unscharf.
Auch bei execute gilt die Nutzeranweisung im Chat als Freigabe.
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

  code: `bastra code — Code-Kenntnis für ein Repository (experimentell)

Aufruf:
  bastra code                        Was aktiv ist, welches Graphify, wie aktuell,
                                     und ob die automatische Aktualisierung des
                                     Daemons pausiert oder gestoppt ist (und bis wann)
  bastra code enable [<dir>]         Hier einschalten und den Graphen einmal bauen
  bastra code disable [<dir>]        Ausschalten; die Graph-Dateien bleiben
  bastra code index [<dir>]          Graphen aktualisieren (inkrementell, ~2 s) und
                                     eine pausierte oder gestoppte Aktualisierung
                                     des Daemons fortsetzen
  bastra code rebuild [<dir>] [--yes]
                                     Reparatur: mit --force neu bauen; das hebt
                                     Graphifys Weigerung auf, einen größeren Graphen
                                     durch einen kleineren zu ersetzen

Recall liest den Graphen, den Graphify schreibt, und zeigt einem Agenten, was von
einer Datei abhängt, bevor er sie ändert. Nichts wird indexiert, bevor du ein
Repository einschaltest; der Graph verlässt nie deinen Rechner, und kein Code
geht an ein LLM.

Experimentell. Es kann einem Agenten helfen, sich in einem fremden oder großen
Repository zurechtzufinden. Bei „was bricht, wenn ich das ändere“ war es in
unseren Messungen an Repositories wie unserem nicht besser als einfache Suche,
und es kostet Kontext (der Abhängigkeitsblock vor Änderungen) und
Hintergrund-CPU (Graph-Aktualisierungen).

Der Graph liegt in <dir>/graphify-out/ und ist lokal von git ausgenommen.
Vorerst macOS und Linux.`,

  archive: `bastra archive — das Archiv hinter dem rm des Agenten

Aufruf:
  bastra archive put <path>...        Pfade ins Archiv verschieben (löscht nie)
  bastra archive list                 was archiviert, gelöscht oder abgelehnt wurde (30 Tage)
  bastra archive restore <path|ref>   zurücklegen (ein Pfad oder eine git-Snapshot-Ref / SHA)
  bastra archive reconcile [--yes]    zeigen (mit --yes: entfernen), was weg kann

Freiwillig, standardmäßig aus: bastra config set archive.enabled on (oder
BASTRA_RM_ARCHIVES=1 in der Umgebung des Daemons, das gewinnt). Nur für
Hook-Aufrufe, die als Claude Code markiert sind (dafür einmal bastra install
erneut ausführen).

Ist es an, läuft ein Claude-Code-Bash-Befehl, der nur aus rm besteht, durch das
archivierende rm von bastra, ohne die übliche Rechteabfrage:
Ziele wandern nach ~/.bastra/archive/<date>/<time-pid>/<full path>, Temp-Ordner
werden wirklich entfernt, /, ~ und Systemordner werden abgelehnt. Alte Einträge
gehen nach Klasse, stündlich nach Bash-Aufrufen geprüft: Build-Reste nach 1 Tag,
saubere git-verfolgte Dateien nach 2, der Rest nach 2; die Größengrenze rührt
deine eigenen Dateien nie an, solange sie jünger als ihre Aufbewahrung sind.
Ändern (Tage, Bruchteile erlaubt; die Umgebungsvariable BASTRA_ARCHIVE_RETAIN gewinnt):
  bastra config set archive.retain junk=1,in-git=2,user=2
Grenzen (Größen wie 5GB oder 500MB; BASTRA_ARCHIVE_CAP und
BASTRA_ARCHIVE_MAX_ITEM gewinnen):
  bastra config set archive.cap 10GB       das ganze Archiv (Standard 10 GB)
  bastra config set archive.max-item 2GB   größtes Ziel, das es aufnimmt (Standard:
                                           keins; off entfernt die Grenze). Ein
                                           größeres wird abgelehnt, nicht archiviert,
                                           nicht gelöscht.
Anderer Archivordner: BASTRA_ARCHIVE_DIR. Er muss dir gehören; ist er für andere
offen, wird er nur für dich geschlossen. Einer eines anderen Kontos oder einer,
der direkt einen Link oder den Eintrag eines anderen Kontos enthält, wird nicht
genutzt, und nichts wird archiviert oder entfernt.
Nur den rm-Teil abschalten: BASTRA_RM_SHIM=0.

bastra archive put <path>... macht den Schritt des archivierenden rm von Hand,
freiwillig oder nicht: dasselbe Archiv, dasselbe Zurücklegen, und Temp-Ordner
werden ebenfalls archiviert, nie gelöscht. Wer in Claude Code Bash(rm:*)
verbietet, kann Bash(bastra archive put:*) eigens erlauben; der Hook schreibt rm
nie darauf um.

git-Befehle, die Arbeit verlieren (clean -f, reset --hard, checkout [<tree>] -- <paths>,
restore, branch -D, stash drop|clear), werden vorher gesichert: die Dateien von
clean und jede nicht verfolgte Datei, die der Befehl überschreiben würde, gehen
ins Archiv, der Rest wird unter refs/bastra-archive/ festgehalten und hier
ebenfalls gelistet; \`bastra archive restore <ref>\` legt es zurück. Die
Festhaltungen erscheinen in \`git log --all\`, bis sie ablaufen. Nur den
git-Teil abschalten: BASTRA_GIT_SHIM=0.
`,
};
