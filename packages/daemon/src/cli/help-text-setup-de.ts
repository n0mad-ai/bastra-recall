/**
 * German `--help` sections for installing and running bastra-recall (#1602):
 * the same keys as SETUP_COMMAND_HELP in help-text-setup.ts, shown when
 * language.primary is "de". Text the product writes — never matched against user text.
 */

const SURFACE_ARG = `Oberflächen:
  claude-desktop  Claude Desktop App
  claude-code     Claude Code
  codex           Codex + ChatGPT Desktop
  cursor          Cursor
  all             Alle oben genannten
`;

export const SETUP_COMMAND_HELP_DE: Record<string, string> = {
  address: `bastra address — lokale Assistenten-Adresse
Aufruf:
  bastra config set assistant.name Jarvis
  bastra address status [--json]
  bastra address setup [name] [--yes] [--dry-run]
  bastra address remove [--yes] [--dry-run]
Auf macOS: einmalige Admin-Freigabe für eigenen Loopback-Port-80-Helfer und hosts.
Node läuft als normaler Nutzer. Eigene Firefox-Pref für den Namen; Firefox vorher schließen und danach neu starten.
Nach Einrichtung wird http://<name>/ einmal im Standardbrowser geöffnet.
Pur <name> ist Such-/Verlaufsheuristik: <name>/ oder <name>.localhost ist eindeutig.
Windows/Linux: Port-80-/hosts-Einrichtung durch Administrator; keine automatische Elevation.
`,

  install: `bastra install — bastra-recall bei einem KI-Client eintragen

Aufruf:
  bastra install                     Geführte Einrichtung: Vault, Clients und
                                     semantische Suche aus Auswahllisten wählen
  bastra install <surface|all>       Eine Oberfläche eintragen (oder alle)
  bastra install claude-desktop --extension
                                     Stattdessen die .mcpb-Desktop-Erweiterung an
                                     Claude Desktop übergeben — der letzte Klick
                                     auf Installieren bleibt in Desktops eigenem Dialog

Trägt den MCP-Server, den gemeinsamen Skill und die Hooks ein. Auf einem Rechner
ohne Vault bietet es zuerst an, einen anzulegen.

${SURFACE_ARG}
Optionen:
  --dry-run        Zeigen, was sich ändern würde; nichts schreiben
  --vault <path>   Vault-Pfad (die Umgebungsvariable BASTRA_VAULT_PATH geht auch)
  --yes, -y        Rückfragen überspringen (z. B. eine fremde statusLine ersetzen)
  --ollama         Ollama für die semantische Suche ohne Rückfrage einrichten (~620 MB)
  --no-ollama      Ollama-Einrichtung überspringen — die Suche bleibt reine BM25-Stichwortsuche
  --with-bootstrap          Erzeugte Startanweisungen ergänzen (ausdrückliche Zustimmung)
  --no-bootstrap            Angebot der Startanweisungen überspringen
  --no-stop-hook   Den Stop-Hook zur Speicherprüfung weglassen (standardmäßig eingetragen)
  --stub           Den kompilierten Hook-Client ohne Rückfrage laden (~70 MB; schnellerer Hook-Start)
  --no-stub        Beim Node-Hook-Client bleiben — kein Download, für Updates gemerkt
  --extension      nur claude-desktop: über die .mcpb-Erweiterung installieren
`,

  uninstall: `bastra uninstall — den Eintrag aus einem KI-Client entfernen

Aufruf:
  bastra uninstall <surface|all>

Entfernt den MCP-Server-Eintrag, die Hooks und den Statuszeilen-Teil. Der
gemeinsame Skill wird entfernt, sobald keine Oberfläche ihn mehr nutzt. Dein
Vault wird nie angerührt — das Austragen eines Clients löscht kein einziges Memory.

${SURFACE_ARG}
Optionen:
  --dry-run   Zeigen, was entfernt würde; nichts schreiben
`,

  doctor: `bastra doctor — prüfen, ob jedes Teil eingetragen und gesund ist

Aufruf:
  bastra doctor [surface|all]
  bastra doctor [surface|all] --fix
  bastra doctor --replay [--days N] [--json] [--compare <report.json>]

Prüft den Daemon, den Pfad des MCP-Forwarders, die Hook-Befehle, den Skill und
die Statuszeile für eine Oberfläche oder alle. Ein Hook, dessen Befehl auf eine
ersetzte oder fehlende Laufzeit zeigt, macht die Oberfläche ungesund, statt als
eingetragen zu gelten (#321).

Ein abschließender Abschnitt „features“ listet, welche Recall-Funktionen an
oder aus sind (Memory-Sprache, Onboarding, semantische Suche, Hooks und Skill je
Client, freiwillige Extras), mit dem Befehl, der jede einschaltet. Ausgeschaltete
Funktionen ändern nie den Exit-Code, und --fix schaltet keine ein.

--replay (#702) beantwortet eine andere Frage: Wie verhält sich die Suche in
DEINEM Vault mit DEINEN Prompts? Es liest deine Claude-Code-Verläufe der letzten
N Tage (Standard 14), schickt jede Nutzereingabe im Schatten durch die
Prompt-Lane des laufenden Daemons — Sitzungs-IDs 'replay-…', keine
Vault-Schreibzugriffe, Telemetrie in einer eigenen 'replay-YYYY-MM-DD.jsonl',
die keine Live-Auswertung zählt — und gibt aus: den Anteil der Prompts mit
Hinweis, die Plätze der zehn häufigsten Notizen, den Anteil der System-Runden
(Aufgabenmitteilungen, Agenten-Post), die Plätze auf Notizen, die der Agent
tatsächlich geladen hat, Brücken-Treffer je Brücke und die p50/p95-Latenz. Ohne
Verläufe meldet es „nicht auswertbar“. Ohne Vektorteil ergeben dieselben
Verläufe und Einstellungen denselben Bericht bis auf Latenz und Zeitüberschreitungen;
mit einem Embedding-Anbieter hängen Treffer auch von der Vektor-Frist und der
Rechnerlast ab, und die nutzungsbasierte Unterdrückung liest die Live-Nutzungsdatei.
Um zwei Einstellungsprofile zu vergleichen, den Daemon mit der Kandidaten-Umgebung
auf einem anderen Port starten, das Replay mit BASTRA_DAEMON_URL darauf richten
und jeden --json-Bericht speichern; --compare zeigt die Unterschiede.

${SURFACE_ARG}
Optionen:
  --fix       Fehlende oder kaputte Teile reparieren. Bei 'all' wird keine
              Oberfläche eingerichtet, die nie installiert war
  --vault <path>  Gegen diesen Vault statt des eingerichteten prüfen
  --replay    Eigene Prompts im Schatten durch die Suche schicken (siehe oben)
  --days <n>  Mit --replay: wie viele Tage Verläufe gelesen werden (Standard 14)
  --json      Mit --replay: den Bericht als JSON ausgeben
  --compare <report.json>  Mit --replay: zusätzlich die Unterschiede zu einem gespeicherten Bericht
`,

  status: `bastra status — läuft der Daemon, und was liefert er

Aufruf:
  bastra status [--json] [-q]

Zeigt die Erreichbarkeit des Daemons, die Vault-Größe, den wirksamen
Embedding-Anbieter und woher er kommt. Liest nur — nichts wird eingetragen,
neu gestartet oder geschrieben.

Optionen:
  --json      Maschinenlesbare Ausgabe
  -q, --quiet Nichts ausgeben; der Exit-Code trägt die Antwort (0 = ok)
`,

  logs: `bastra logs — was die Hooks und der Daemon tatsächlich aufgezeichnet haben

Aufruf:
  bastra logs [-f] [--since <duration>] [--source <src>] [--lines <n>]
  bastra logs --stats [--since <duration>]
  bastra logs --conventions [--since <duration>]

Eine Zeile je Ereignis, das neueste zuletzt. --stats fasst stattdessen je
Auslöser-Lane zusammen (Median/p90/max-Latenz, Zeitüberschreitungen) — an dieser
Ansicht wird das Hook-Budget gemessen.

Optionen:
  -f, --follow           Neue Einträge weiter ausgeben, sobald sie kommen
  --since <duration>     Wie weit zurück: 30s, 10min, 2h, 1d (Standard 5min;
                         mit --stats ist der Standard 7d)
  --source <daemon|hook|all>
                         Welche Log-Quelle gelesen wird (Standard all)
  --lines <n>            Höchstzahl ausgegebener Zeilen (Standard 200)
  --conventions          Belege je Sitzung: gezeigt/geladen/Gate/Quittung
  --stats                Je Lane zusammenfassen statt Zeilen auszugeben
  --include-eval         Mit --stats: auch als Eval/synthetisch markierte Zeilen zählen
                         (standardmäßig ausgeschlossen, #619)
`,

  autostart: `bastra autostart — den Daemon dauerhaft laufen lassen oder bei Bedarf starten

Aufruf:
  bastra autostart status     Zeigen, was installiert ist und worauf es zeigt
  bastra autostart on         Den verwalteten Dienst installieren und starten
  bastra autostart off        Ihn entladen und entfernen
  bastra autostart on --force Einen Dienst ersetzen, den bastra nicht geschrieben hat

Standardmäßig aus. Ohne Autostart startet der Daemon, wenn ein KI-Client ihn
zuerst aufruft, und beendet sich nach 30 Minuten Leerlauf wieder — das reicht
für Claude Code, Claude Desktop und Cursor. Schalte ihn ein, wenn du die
REST-API nutzt, das Embedding-Modell warm halten willst oder einfach sofort
Antworten möchtest.

'on' schaltet das Beenden bei Leerlauf ab, der Daemon bleibt also an, bis du ihn
ausschaltest.

Einen Dienst, den bastra nicht geschrieben hat, lässt es in Ruhe: Er zeigt
meist absichtlich woandershin (ein Quell-Checkout, eine eigene Modell-Einrichtung),
und ihn zu ersetzen würde das zerstören. --force ersetzt ihn trotzdem.

macOS nutzt einen LaunchAgent; Windows eine Anmelde-Aufgabe der
Aufgabenplanung je Nutzer mit Neustart bei Fehlern. doctor meldet eine gestoppte
Aufgabe. Die Abnahme auf einem echten Windows-Rechner steht noch aus. Unter Linux
den Start bei Bedarf oder eine systemd-Nutzereinheit verwenden.`,

  update: `bastra update — aktualisieren, neu eintragen, neu starten

Aufruf:
  bastra update [options]

Aktualisiert das installierte Paket (brew upgrade bei Installation über brew;
bei einer globalen npm-Installation das Paket, das du installiert hast:
'npm install -g bastra-recall@latest' oder '@bastra-recall/daemon@latest', wenn
du jenes installiert hast; nichts bei einem Quell-Checkout), trägt jede
Oberfläche neu ein und startet den Daemon neu.

Einen Quell-Checkout holt, installiert oder baut dieser Befehl nie: Er prüft nur,
dass der Build des Checkouts nicht älter als seine Quellen ist, und hört ohne
Neueintragen oder Neustart auf, wenn doch. Dort also zuerst selbst
'git pull && npm ci && npm run build' ausführen, dann 'bastra update'.

Bevor eine vorhandene Installation ersetzt wird, läuft eine Vorprüfung: lokal
geänderte Dateien werden nach ~/.bastra/update-backups/<version>/ gesichert und
gemeldet. Eine eingetragene Patch-Reihe (siehe 'bastra patches') wird danach
wieder angewendet.

Optionen:
  --dry-run   Jeden Schritt beschreiben, nichts ändern
  --staged    Nur die Dateien tauschen, kein Neustart des Daemons — der Weg des
              unbeaufsichtigten Auto-Updates; ein blockiertes Update wird
              festgehalten statt erzwungen
  --force     Auch installieren, wenn lokal geänderte Dateien gefunden wurden. Sie
              werden so oder so gesichert. Gilt nie für das unbeaufsichtigte Auto-Update
  --yes, -y   Rückfragen beim Neueintragen überspringen
`,

  config: `bastra config — Einstellungen lesen und schreiben

Aufruf:
  bastra config get <key>
  bastra config set <key> <value>

Schlüssel:
  update.mode      notify | auto | off
  docs.mode        off | suggest | auto   (Erfassung von Produktdokumentation)
  docs.language    en | de | …            (Sprache, in der Doku geschrieben wird)
  reflex.enabled   true | false           (Reflex-Memories; Standard true)
  promptImpact.enabled
                   true | false           (Änderungsfolgen in Prompts, experimentell; Standard false)
  battery.saver    true | false           (im Akkubetrieb Ollama-Hintergrundarbeit aufschieben, macOS; Standard false)

Einstellungen liegen neben dem Vault; 'bastra config get' ohne Wert zeigt den
wirksamen Wert und woher er kommt.
`,

  embeddings: `bastra embeddings — semantische Suche an oder aus

Aufruf:
  bastra embeddings <on|off|status>

'on' richtet Ollama mit dem Modell embeddinggemma (~620 MB) ein und speichert die
Wahl, sodass die Suche den hybriden Weg nimmt (BM25 + Vektoren, mehrsprachig).
'off' kehrt zur reinen BM25-Stichwortsuche zurück. 'status' zeigt den wirksamen
Anbieter und woher er kommt (Umgebung, Einstellung oder Erkennung).

'bastra embeddings' hat keine eigenen Optionen. Um die Ollama-Installation ohne
Rückfrage zu entscheiden, --ollama / --no-ollama an 'bastra install' oder
'bastra update' übergeben; bei diesem Befehl werden sie als Aufruffehler
abgelehnt (#536).
`,

  models: `bastra models — das lokale Textmodell zum Umschreiben von Memories

Aufruf:
  bastra models [status]
  bastra models recommend
  bastra models set <tag>
  bastra models switch <recommendation> <model>
  bastra models later <recommendation>
  bastra models dismiss <recommendation>

Das Modell hinter der doc2query-Auslöser-Erweiterung und dem lokalen Reranker —
nicht das Embedding-Modell (das gehört zu 'bastra embeddings').

  status      Aktives Modell und die RAM-Stufen-Empfehlung für diesen Rechner
  recommend   Was dieser Rechner tragen kann, ohne etwas zu ändern
  set <tag>   Ein Modell laden und speichern (z. B. gemma4:12b ab 24 GB)

Neuen Installationen wird ab 16 GB RAM tev1:4b angeboten (gemma4:12b als
Alternative ab 24 GB und als Vorschlag ab 32 GB). Eine Installation, die nie eine
Wahl gespeichert hat, nutzt weiter den eingebauten Rückfall gemma3:4b.

Ein Release kann ein anderes Modell empfehlen. bastra wechselt nie von selbst:
'bastra update', der erste Befehl im Terminal nach einem Update, der
Sitzungsstart und eine Zeile nach CLI-Befehlen sagen es dir, bis du geantwortet
hast. Der Sitzungsstart zeigt es normalerweise einmal je UTC-Tag über Claude
Code und Codex hinweg, mit eigener Markierung unabhängig von der CLI-Zeile.
Gleichzeitige Sitzungsstarts, die eine verwaiste Sperre übernehmen, können es
selten zweimal am selben Tag zeigen. 'status' zeigt die Empfehlung jederzeit.
Jede Meldung nennt die genauen Befehle; sie nennen die Empfehlung, auf die sie
antworten, und bastra lehnt eine Antwort auf eine andere ab.

  switch      Das empfohlene Modell laden, mit einem kurzen Testaufruf prüfen und
              erst dann zusammen mit deiner Antwort speichern. Schlägt etwas fehl,
              ändert sich nichts. Das alte Modell bleibt installiert; 'set <old tag>'
              wechselt zurück.
  later       Beim aktuellen Modell bleiben und in 7 Tagen erneut fragen
  dismiss     Beim aktuellen Modell bleiben und für diese Empfehlung nicht mehr
              fragen (eine spätere, neue Empfehlung fragt wieder). Die Meldung
              kommt dann nicht wieder, und du verzichtest womöglich auf bessere
              Suchqualität; 'status' zeigt die Empfehlung weiter, und du kannst
              später noch wechseln.

BASTRA_UPDATE_CHECK=off (oder update.mode off) schaltet die Meldung ebenfalls stumm.
`,

  token: `bastra token — das REST-API-Token für Browser- und REST-Clients

Aufruf:
  bastra token [--origin <url>]
  bastra token rotate
  bastra token clear

Gibt das Token aus und erzeugt beim ersten Aufruf eines. Browser-Clients
brauchen außerdem einen freigegebenen Origin — '--origin https://bastra.io'
erledigt das im selben Schritt, ohne plist- oder Umgebungsänderung.

  rotate   Ein neues Token ausstellen; das alte gilt sofort nicht mehr
  clear    Es entfernen — sperrt jeden Browser-/REST-Client aus, bis ein neues
           erzeugt wird

Optionen:
  --origin <url>  Zusätzlich diesen Browser-Origin freigeben
  --json          Maschinenlesbare Ausgabe
`,

  oauth: `bastra oauth — entfernte MCP-Clients, die über die OAuth-Anmeldung freigegeben wurden

Aufruf:
  bastra oauth [list] [--json]
  bastra oauth revoke <client_id>
  bastra oauth revoke all

Eigene Konnektoren von ChatGPT und claude.ai erreichen /api/v1/mcp über OAuth.
Jeder trägt sich selbst ein, und du gibst ihn einmal frei, indem du dein
API-Token ('bastra token') auf der Anmeldeseite des Daemons eingibst. Ihre
Tokens öffnen nur die MCP-Tür, nie die anderen /api/v1-Routen.

  list     Jeder eingetragene Client: Name, Weiterleitungs-Host, Rechte, letztes Token
  revoke   Einen Client mit all seinen Tokens entfernen; wirkt ab der nächsten Anfrage

Optionen:
  --json   Maschinenlesbare Ausgabe
`,

  patches: `bastra patches — lokale Änderungen, die ein Update überstehen

Aufruf:
  bastra patches [list]
  bastra patches add <file.patch>
  bastra patches remove <id>
  bastra patches status

Eine geordnete Reihe, die nach jedem Update auf die frische Installation
angewendet wird. Ein Patch, den das Hauptprojekt übernommen hat, wird
ausgemustert; einer, der nicht mehr passt, wird beiseitegelegt und gemeldet —
nie erzwungen.

  status   Die Reihe gegen das prüfen, was gerade installiert ist
`,

  feedback: `bastra feedback — ein vorausgefülltes GitHub-Issue-Formular öffnen

Aufruf:
  bastra feedback bug
  bastra feedback idea

'bug' hängt einen bereinigten Diagnoseblock an: Version, Betriebssystem, Node,
Embedding-Modus, Vault-Größe, Daemon-Status. Nie ein Dateipfad, nie
Vault-Inhalt. Der Browser öffnet sich mit ausgefülltem Formular — du liest es und
schickst es selbst ab.
`,

  completion: `bastra completion — Tab-Vervollständigung für deine Shell

Aufruf:
  bastra completion <bash|zsh|fish>

Gibt das Vervollständigungsskript auf stdout aus; das Skript trägt seine eigene
Installationsanleitung in einem Kommentar am Anfang.
`,

  help: `bastra help — die Befehlsübersicht zeigen

Aufruf:
  bastra help
  bastra --help
  bastra <command> --help

Die letzte Form ist die nützliche: Sie zeigt, was genau dieser eine Befehl tut
und welche Optionen für ihn gelten.
`,

  version: `bastra version — die Version dieser CLI ausgeben

Aufruf:
  bastra version
  bastra --version

Das ist die eigene Version der CLI. 'bastra status' meldet, was der LAUFENDE
Daemon liefert; das weicht ab, wenn sein Code unter ihm ersetzt wurde (#329).
`,
};
