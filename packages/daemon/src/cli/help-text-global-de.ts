/**
 * The German `bastra help` listing (#1602), shown when language.primary is
 * "de"; the English one is globalHelp() in help-text.ts. Text the product
 * writes — never matched against user text.
 */

export function globalHelpDe(version: string, supportedSurfaces: string): string {
  return `bastra ${version} — bastra-recall in KI-Clients einrichten

Aufruf:
  bastra                     Statusübersicht zeigen (Version, Update, Daemon, Vault)
  bastra <command> [surface] [options]
  bastra <command> --help    Was dieser eine Befehl tut, und seine Optionen

Befehle:
  install                    Geführte Einrichtung (interaktiv): Vault, Clients,
                             semantische Suche aus Auswahllisten wählen
  install <surface|all>      bastra-recall beim KI-Client eintragen
  install claude-desktop --extension
                             Stattdessen die .mcpb-Desktop-Erweiterung an Claude
                             Desktop übergeben (Logo + Vault-Auswahl; ein Klick
                             auf Installieren bleibt in Desktops Dialog)
  uninstall <surface|all>    Den Eintrag entfernen (der gemeinsame Skill wird
                             entfernt, sobald keine Oberfläche ihn mehr nutzt)
  update                     brew- oder npm-Upgrade (je nach Installation) +
                             neu eintragen + Daemon-Neustart. Aus einem Quell-Checkout:
                             nach Pull UND Build ausführen (es prüft den Build,
                             es baut nie selbst).
  address <status|setup [name]|remove>  Eigener Assistentenname als Browser-Adresse.
                             System-/Browser-Einrichtung nur mit Zustimmung.
  autostart <on|off|status>  Den Daemon dauerhaft laufen lassen (standardmäßig
                             aus — sonst startet er bei Bedarf und beendet sich
                             nach 30 min Leerlauf). 'on' installiert einen Dienst;
                             ein selbst geschriebener wird nie ohne --force ersetzt
  tasks <list|get|create|review|edit|snooze|acknowledge|resolve|cancel|rearm|delete>
                             Standardmäßig an; abschalten in den Einstellungen oder mit BASTRA_TASKS=0.
                             Abfrage des Owner-Tokens; JSON-Eingabedatei. agent vor
                             der Datei nutzt ausdrücklich BASTRA_TASK_TOKEN.
  codex [Codex options]      Einen Codex-CLI-Chat mit aktiver Aufgabenzustellung starten.
  suggestions <reject|reset>  Ausdrückliche Entscheidungen zu genauen Speichervorschlägen eines Projekts
  drafts <list|purge|undo|reject>  Lokale Sitzungsentwürfe ansehen oder leeren
  patches <list|add <file>|remove <id>|status>
                             Lokale Patches, die ein Update überstehen: eine
                             geordnete Reihe, auf die frische Installation neu
                             angewendet. Einer, den das Hauptprojekt übernommen
                             hat, wird ausgemustert; einer, der nicht mehr passt,
                             wird beiseitegelegt und gemeldet — nie erzwungen.
                             'status' prüft sie gegen das gerade Installierte.
  embeddings <on|off|status> Semantische Suche (mehrsprachige Vektorsuche):
                             'on' richtet Ollama + das Modell embeddinggemma ein
                             (~620 MB) und speichert die Wahl; 'off' kehrt zur
                             reinen BM25-Stichwortsuche zurück; 'status' zeigt den
                             wirksamen Anbieter und woher er kommt
  models [status|recommend|  Lokales Textmodell zum Umschreiben von Memories (doc2query +
    set <tag>]               Rerank). 'status' zeigt das aktive Modell + die
                             RAM-Stufen-Empfehlung dieses Rechners; 'set' lädt ein
                             Modell und speichert es (z. B. gemma4:12b ab 24 GB)
  models <switch|later|      Auf die Modellempfehlung eines Releases antworten:
    dismiss> <id> [model]    wechseln (vorher geladen + getestet), in 7 Tagen erneut
                             fragen oder für diese Empfehlung nicht mehr. Die
                             Meldung nennt den genauen Befehl
  config get <key>           Eine Einstellung lesen (z. B. update.mode)
  config set <key> <value>   Eine Einstellung schreiben (update.mode = notify|auto|off,
                             docs.mode = off|suggest|auto, docs.language = en|de|…)
  token [rotate|clear]       Das REST-API-Token ausgeben (beim ersten Mal erzeugt) für
                             Browser-/REST-Clients; 'rotate' stellt ein neues aus,
                             'clear' entfernt es (sperrt Browser-/REST-Clients aus)
    [--origin <url>]         Mit 'token': zusätzlich diesen Browser-Origin freigeben
                             (z. B. https://bastra.io), damit die Web-App den
                             Daemon erreicht — ohne plist-/Umgebungsänderung
  oauth [list|revoke <id|all>]
                             Über OAuth freigegebene entfernte MCP-Clients (ChatGPT,
                             claude.ai-Konnektoren); 'revoke' sperrt einen oder alle
  code <enable|disable|index|rebuild|status>
                             Code-Kenntnis je Repository (experimentell): zeigt
                             einem Agenten, was von einer Datei abhängt, bevor er
                             sie ändert, und ergänzt find_code. Aus, bis
                             eingeschaltet; Graphify baut eine lokale Code-Karte
                             und sendet nichts nach außen (macOS/Linux)
  commons <enable|update|disable|status|verify>
                             Bastra Commons: bewährte Rezepte der Gemeinschaft als
                             nur lesbarer zweiter Suchindex (per git abgeglichen);
                             'verify' reicht ein Funktioniert/Scheitert als PR ein
  bridges <enable|disable|status|language|live|mint|harvest>
                             Gemeinsames gelerntes Suchvokabular: freiwillige
                             Brücken, die die Suche erweitern (standardmäßig aus;
                             wenn an, läuft die Erweiterung im Schatten bis 'live on').
                             'mint' = Brücken aus Treffern, nach denen gehandelt wurde;
                             'harvest' = tiefer Durchgang mit dem lokalen Reranker (Teacher 2).
  map                        Die Vault-Karte im Browser öffnen — ein interaktiver
                             Graph deines Gedächtnisses (nur lokal; bietet an, sie
                             einzuschalten, wenn sie aus ist). Alias: ui
  import <file|-> [source]   Den Vault mit den Memories eines anderen KI-Werkzeugs
                             füllen (ChatGPT/Claude/Gemini-Liste oder freier Text):
                             merkt Kandidaten in import-review.md zur Prüfung vor —
                             deine nächste KI-Sitzung verdichtet die angenommenen mit
                             dir; nichts wird ohne deine Zustimmung gespeichert.
                             Ein conversations.json-Datenexport wird stattdessen
                             lokal vorgemerkt; die KI-Sitzung arbeitet ihn abschnittsweise ab
  import rules               Lokale Regeldateien vormerken (CLAUDE.md, AGENTS.md,
                             .cursorrules, .cursor/rules/, ~/.claude/CLAUDE.md)
  import vault <dir> [label] Einen ganzen Ordner mit Memory-Dateien (z. B. ein
                             Claude-Code-Memory-Ordner) in einen eigenen,
                             abgetrennten Bereich unter memories/imported/
                             importieren — deterministisch, keine Einzelprüfung,
                             nichts Vorhandenes wird angerührt
  import clients             Die eigenen Memory-Ordner von Claude Code und Codex
                             genauso importieren (ein Bereich je Ordner)
  import <mine|clear>        Den nächsten Abbau-Abschnitt für die KI-Sitzung ausgeben /
                             die lokale Abbau-Warteschlange verwerfen
  onboard                    5-Minuten-Interview, das einen frischen Vault füllt:
                             Fragen passend zur Rolle, jede Antwort wird ein
                             Profil-Memory ('onboard skip' stellt den Hinweis ab)
  skills <list|add|remove>   Verknüpfungsziele angeben, die auf einer anderen
                             Oberfläche liegen (z. B. Claude-Code-Skills): angegebene
                             IDs erscheinen im Skill-Ring der Karte statt als nicht
                             geschriebene Geister — kein Pfad, keine Suche, kein Abgleich
  feedback <bug|idea>        Ein vorausgefülltes GitHub-Issue-Formular im Browser öffnen.
                             'bug' enthält einen bereinigten Diagnoseblock
                             (Version, Betriebssystem, Embedding-Modus, Vault-Größe —
                             nie Vault-Inhalt); du prüfst und schickst es selbst ab
  archive <put|list|restore|reconcile>
                             Einen Pfad selbst nach ~/.bastra/archive verschieben,
                             sehen, was das rm des Agenten dorthin verschoben hat,
                             einen Pfad zurücklegen oder alte Einträge gehen lassen
  trash <list|restore ID>    Archivierte Memories (archive_memory, der
                             Vault-Papierkorb): listen oder eines dorthin
                             zurücklegen, wo es lag
  recall "<question>"        Den Vault im Terminal durchsuchen (dieselbe Suche wie
                             bei Agenten; braucht den laufenden Daemon)
  save --title T --type T --scope S [text]
                             Selbst ein Memory speichern (dieselben Prüfungen wie
                             beim Speichern eines Agenten, als deine eigene Anweisung festgehalten)
  reconcile [other-store]    Zwei Kopien desselben Vaults: welche je Memory weiter
                             ist (Probelauf; --yes kopiert mit Sicherung, Konflikte
                             werden nur gelistet); ohne Argument werden die
                             gefundenen Kopien gelistet
  doctor [surface|all]       Den Zustand einer oder jeder Oberfläche prüfen
  doctor [surface|all] --fix Zustand prüfen und fehlende/kaputte Teile reparieren
  doctor --replay [--days N] Die eigenen früheren Prompts im Schatten durch die Suche
                             schicken und berichten, welche Hinweise es gegeben hätte
  status                     Zustand von Daemon und Adaptern prüfen (unterstützt --json, -q)
  logs                       Lesbare Ansicht dessen, was die Hooks und der Daemon
                             aufgezeichnet haben — eine Zeile je Ereignis, das neueste
                             zuletzt (-f zum Mitlesen, --since 1h, --source hook|daemon)
  rules cursor [path]        Die Memory-Regeln von Cursor in ein Projekt schreiben
                             (.cursor/rules/bastra-recall.mdc). Cursor hält
                             Regeln je Repository — es gibt kein globales Gegenstück,
                             also einmal je Projekt ausführen. 'rules remove
                             cursor [path]' nimmt sie wieder heraus
  completion <shell>         Ein Skript für die Tab-Vervollständigung ausgeben (bash, zsh, fish)
  help                       Diese Hilfe zeigen
  version                    Die Version zeigen

Oberflächen:
  claude-desktop             Claude Desktop App
  claude-code                Claude Code
  codex                      Codex + ChatGPT Desktop
  cursor                     Cursor
  all                        Alle oben genannten

Optionen:
  --dry-run                  Zeigen, was sich ändern würde; nichts schreiben
  --vault <path>             Vault-Pfad (die Umgebungsvariable BASTRA_VAULT_PATH geht auch)
  --json                     Status als JSON ausgeben (nur Befehl status)
  -q, --quiet                Keine Ausgabe, nur Exit-Code (nur Befehl status)
  --yes, -y                  Rückfragen überspringen (eine fremde statusLine ersetzen)
  --ollama                   Ollama für die semantische Suche ohne Rückfrage einrichten (installiert über Homebrew, lädt ~620 MB)
  --no-ollama                Ollama-Einrichtung überspringen (die Suche nutzt BM25-Stichwortsuche)
  -f, --follow               Neue Einträge weiter ausgeben, sobald sie kommen (nur logs)
  --since <duration>         Wie weit zurück: 30s, 10min, 2h, 1d (nur logs, Standard 5min)
  --source <daemon|hook|all> Welche Log-Quelle gelesen wird (nur logs, Standard all)
  --lines <n>                Höchstzahl ausgegebener Zeilen (nur logs, Standard 200)
  --conventions              Belege für Konventionen je Sitzung (Standardzeitraum: 7d)
  --stats                    Je Auslöser-Lane zusammenfassen statt Zeilen auszugeben
                             (nur logs; --since ist dann standardmäßig 7d)
  --include-eval             Mit --stats: auch als Eval/synthetisch markierte Zeilen
                             zählen (standardmäßig ausgeschlossen, #619)
  --fix                      Mit doctor: nicht gesunde Oberflächen reparieren (bei 'all' werden nie installierte nicht eingerichtet)
  --replay                   Mit doctor: deine Claude-Code-Prompts der letzten
                             --days N Tage (Standard 14) durch die Live-Prompt-Lane
                             schicken, nichts wird geschrieben; --json für den Bericht als JSON,
                             --compare <report.json> zeigt die Unterschiede zu einem gespeicherten
  --with-bootstrap          Erzeugte Startanweisungen ergänzen (ausdrückliche Zustimmung)
  --no-bootstrap            Angebot der Startanweisungen überspringen
  --no-stop-hook             Den Stop-Hook zur Speicherprüfung weglassen (standardmäßig eingetragen)
  --stub                     Den kompilierten Hook-Client für Claude Code ohne Rückfrage laden (~70 MB)
  --no-stub                  Beim Node-Hook-Client bleiben — nie den kompilierten laden (gemerkt)
  --force                    Mit update: auch installieren, wenn lokal geänderte Dateien
                             gefunden wurden (sie werden so oder so nach
                             ~/.bastra/update-backups/<version>/ gesichert).
                             Gilt nie für das unbeaufsichtigte Auto-Update.
  --help, -h                 Diese Hilfe zeigen
  --version, -v              Die Version zeigen

Beispiele:
  bastra install claude-desktop
  bastra install codex
  bastra install all --dry-run
  bastra status --json
  bastra doctor
  bastra uninstall claude-desktop

Unterstützte Oberflächen (dieser Build): ${supportedSurfaces}
`;
}
