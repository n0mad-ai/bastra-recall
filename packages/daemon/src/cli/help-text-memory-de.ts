/**
 * German `--help` sections for the commands that read, seed or curate the
 * vault (#1602): the same keys as MEMORY_COMMAND_HELP in help-text-memory.ts,
 * shown when language.primary is "de". Text the product writes — never matched
 * against user text.
 */

export const MEMORY_COMMAND_HELP_DE: Record<string, string> = {
  suggestions: `bastra suggestions — Entscheidungen zu genauen Speichervorschlägen

Aufruf:
  bastra suggestions reject <proposal_id> user-directed "explicit user rejection"
  bastra suggestions reset <proposal_id> user-directed

Nur die ausdrückliche Ablehnung eines angezeigten Vorschlags durch den Nutzer
melden. Schweigen, Nicht-Speichern und die Einschätzung eines Agenten zählen
nicht. Eine Ablehnung unterdrückt nur diesen Vorschlag in diesem Projekt; reset
stellt ihn wieder her. Andere Vorschläge, die Stärke der Auslöser und bindende
Regeln bleiben unverändert. --dry-run zeigt die Anfrage. Der Agent bezeugt die
Nutzeranweisung, wie bei Entscheidungen über Regelvorschläge.
`,

  drafts: `bastra drafts — lokale Sitzungsentwürfe

Aufruf:
  bastra drafts [list] [--json]   Nicht abgelaufene Entwürfe zeigen, ohne sie aufzufrischen
  bastra drafts purge [--json]    Alle Entwürfe und aufbewahrten Grabsteine entfernen
  bastra drafts undo <id> [--json] [--vault <path>] [--force]
                                Eine unveränderte übernommene Notiz entfernen; 180 Tage Grabstein behalten
                                --force erlaubt das Entfernen einer geprüften, bearbeiteten Notiz
  bastra drafts reject <id>... [--json]
                                Offene Entwürfe schließen; 180 Tage Grabstein gegen erneute Erfassung

Entwürfe bleiben auf diesem Gerät, außerhalb des Vaults. Geheimnisse werden vor
dem Speichern geschwärzt. Nie gezeigte Entwürfe mit einem Beleg laufen nach
7 Tagen ab (nicht gemessen); andere offene Entwürfe nach 30 Tagen ohne Beleg oder
Anzeige; übernommene und abgelehnte Einträge bleiben 180 Tage erhalten.
BASTRA_DRAFTS_PATH ersetzt den Standardort ~/.bastra/drafts.json.
Getippte Nachrichten, die den strukturellen Rauschfilter passieren, erfasst die
lokale Sitzungsernte automatisch, mit ihrer geschwärzten Situation. Die Suche
zeigt unbestätigte Zitate getrennt; BASTRA_DRAFT_HINTS=0 schaltet dieses Band ab.
BASTRA_PENDING_RELAY=0 stoppt alle Relay-Schreibzugriffe und die Zustellung;
vorhandene Dateien bleiben. purge leert auch das wartende Relay (auch wenn es
abgeschaltet ist); unlesbare Relay-Dateien bleiben erhalten.
`,

  commons: `bastra commons — Rezepte der Gemeinschaft als zweiter, nur lesbarer Index

Aufruf:
  bastra commons <enable|update|disable|status>
  bastra commons verify <recipe-id> <works|fails> ["environment note"]

Bastra Commons ist eine per git abgeglichene Sammlung von Rezepten, die sich in
der Gemeinschaft bewährt haben, durchsucht als zweiter Index neben deinem
eigenen Vault. Nur lesbar: Aus Commons wird nie etwas in deine Memories
geschrieben, und dein Vault wird nirgendwohin geschickt. Nur 'verify' sendet
etwas nach außen (siehe unten).

  enable    Klonen und den Index eintragen
  update    Den neuesten Stand holen
  disable   Austragen (der Klon bleibt auf der Platte)
  status    Stand, Größe und wann zuletzt geholt
  verify    Festhalten, dass ein Rezept bei dir funktioniert oder nicht, und
            einen Pull Request mit diesem Eintrag öffnen. Der PR ist öffentlich:
            Er enthält die Rezept-ID, das Ergebnis, deine Notiz, eine
            Prüfer-Kennung sowie Betriebssystem, CPU-Architektur und
            Node-Version. Fehlt git oder gh oder wird das Ziel abgelehnt, bleibt
            der Eintrag auf der Platte, um ihn von Hand einzureichen.
`,

  bridges: `bastra bridges — gemeinsames gelerntes Suchvokabular (freiwillig)

Aufruf:
  bastra bridges <enable|disable|status|language|live|mint|harvest>

Vokabelbrücken erweitern die Suche, indem sie die Wörter, mit denen du suchst,
mit den Wörtern deiner Memories verbinden. Standardmäßig aus. Ohne
Spracheinstellung wird jeder Ordner durchsucht; eine Vorgabe beschränkt die
Erweiterung der Suchanfrage auf einen Ordner. Neue Brücken werden nach der
erkannten Sprache ihrer Ausgangsanfrage abgelegt.

  enable / disable   Den gemeinsamen Index an- oder ausschalten
  status             Was aktiv ist und wie viele Brücken vorhanden sind
  language           Die Vorgabe für die Anfragesprache zeigen oder setzen
  live <on|off>      Brücken die Anfrage erweitern lassen (Standard off: Schatten —
                     Treffer werden protokolliert, die Rangfolge bleibt gleich).
                     Nur für Brücken einschalten, die 'bastra bridges verify' bestehen
  mint               Brücken aus Treffern ableiten, nach denen du gehandelt hast
  harvest            Tiefer Durchgang über ferne Bereiche mit dem lokalen Reranker (Teacher 2)
`,

  map: `bastra map — der Vault als interaktiver Graph

Aufruf:
  bastra map

Öffnet die lokale Karte im Browser: Memories, ihre Verknüpfungen und die
Gruppen, die sie bilden. Nur lokal — die Seite liefert der Daemon auf 127.0.0.1,
und nichts verlässt den Rechner. Ist die Karte aus, bietet der Befehl an, sie
einzuschalten, und startet den Daemon, der sie liefert.

Alias: bastra ui
`,

  ui: `bastra ui — Alias für 'bastra map'

Aufruf:
  bastra ui

Öffnet die Vault-Karte im Browser. Siehe 'bastra map --help'.
`,

  import: `bastra import — den Vault mit dem füllen, was du anderswo schon geschrieben hast

Aufruf:
  bastra import <file|-> [source]     Kandidaten aus einer Liste oder freiem Text vormerken
  bastra import rules                 Lokale Regeldateien vormerken
  bastra import vault <dir> [label]   Einen ganzen Ordner mit Memory-Dateien importieren
  bastra import clients               Die eigenen Memory-Ordner der Clients importieren
  bastra import <mine|clear>          Abbau-Warteschlange für einen Datenexport
  bastra import status                Wie viele Kandidaten warten

Vormerken ist nicht Speichern: Kandidaten landen in import-review.md, und deine
nächste KI-Sitzung verdichtet die angenommenen mit dir. Nichts wird ohne deine
Zustimmung zu einem Memory.

  rules            CLAUDE.md, AGENTS.md, .cursorrules, .cursor/rules/,
                   ~/.claude/CLAUDE.md
  vault <dir>      Deterministischer Ordnerimport in einen eigenen, abgetrennten
                   Bereich unter memories/imported/ — keine Einzelprüfung, nichts
                   Vorhandenes wird angerührt
  clients          Jeder Ordner ~/.claude/projects/*/memory und ~/.codex/memories
                   mit Notizen, jeweils wie 'vault' unter eigener Bezeichnung
                   importiert; ein erneuter Lauf schreibt nur, was sich geändert hat
  mine             Den nächsten Abschnitt eines vorgemerkten conversations.json-Exports ausgeben
  clear            Die lokale Abbau-Warteschlange verwerfen

Optionen:
  --dry-run          Zeigen, was vorgemerkt würde; nichts schreiben
  --exclude <glob>   Mit 'vault': passende Dateien überspringen (wiederholbar)
  --vault <path>     In diesen Vault statt des eingerichteten importieren
`,

  onboard: `bastra onboard — das 5-Minuten-Interview, das einen frischen Vault füllt

Aufruf:
  bastra onboard
  bastra onboard --answers <file>
  bastra onboard skip
  bastra onboard done

Fragen passend zur Rolle; jede Antwort wird ein Profil-Memory, damit die Suche
vom ersten Tag an etwas hat statt eines leeren Vaults.

  skip              Den Hinweis abstellen — 'bastra onboard' jederzeit selbst starten
  done              Onboarding als erledigt markieren, ohne das Interview
  --answers <file>  Die Antworten aus einer Datei speichern statt zu fragen (kein
                    Terminal nötig): JSON (.json) oder YAML, z. B.
                      persona: developer        # developer|business|personal|mixed
                      answers:
                        identity: Alex · Deutsch, Du-Form
                        stack: TypeScript + Node
                    Antwort-IDs sind die Fragen-IDs des Interviews (identity,
                    rules, stack, projects, workflow, conventions_size, ...).
                    Eine unbekannte ID wird gemeldet und übersprungen. Die Datei
                    scheitert (Exit 2, Onboarding bleibt offen), wenn nichts darin
                    brauchbar ist und ein Eintrag übersprungen wurde: eine
                    unbekannte ID oder ein Wert, der kein Text ist. Nur die
                    Rolle allein ist eine gültige Datei.
  --vault <path>    Diesen Vault statt des eingerichteten einrichten
`,

  skills: `bastra skills — Verknüpfungsziele angeben, die auf einer anderen Oberfläche liegen

Aufruf:
  bastra skills [list]
  bastra skills add <id> [label]
  bastra skills remove <id>

Ein Memory kann auf einen Claude-Code-Skill verweisen, der keine Datei in deinem
Vault ist. Angegebene IDs erscheinen im Skill-Ring der Karte statt als nicht
geschriebene Geister. Nur Angabe: kein Pfad, keine Suche, kein Abgleich.
`,

  rules: `bastra rules — die Memory-Regeln eines Clients in ein Projekt schreiben

Aufruf:
  bastra rules cursor [path]
  bastra rules remove cursor [path]
  bastra rules proposals
  bastra rules confirm|reject <id> <revision> user-directed

proposals zeigt den vollständigen Regeltext und die aktuelle Revision. Nur auf
die ausdrückliche Entscheidung des Nutzers im Chat bestätigen oder ablehnen.
user-directed bezeugt diese Anweisung; es weist keinen Menschen nach. Veraltete
Revisionen werden abgelehnt.

Schreibt .cursor/rules/bastra-recall.mdc in das Projekt (Standard: der aktuelle
Ordner). Cursor hält Regeln je Repository — es gibt kein globales Gegenstück,
deshalb läuft das einmal je Projekt.

Claude Code und Claude Desktop brauchen das nicht: Sie nutzen den gemeinsamen
Skill, den 'bastra install' einrichtet.
`,

  trash: `bastra trash — archivierte Memories, zurück aus dem Vault-Papierkorb

Aufruf:
  bastra trash list              archivierte Memories, die sich zurückholen lassen (neueste zuerst)
  bastra trash restore <id>      ein archiviertes Memory dorthin zurücklegen, wo es lag

archive_memory (und Archivieren im Memory-Browser) verschiebt ein Memory in den
Vault-Papierkorb, <vault>/.bastra/trash/ — nie endgültig gelöscht. Dieser Befehl
bittet den laufenden Daemon (restore_memory), sie zu listen oder
zurückzulegen; das Zurücklegen wird ins Prüfprotokoll des Vaults geschrieben. Ein
Memory mit derselben ID, das wieder aktiv ist, wird nicht überschrieben: Das
Zurücklegen wird abgelehnt. Private Memories werden hier weder gelistet noch
zurückgelegt; das geht im Memory-Browser. --json gibt die Liste als JSON aus.
`,

  recall: `bastra recall — den Vault im Terminal durchsuchen

Aufruf:
  bastra recall "<question>" [--limit N] [--scope S] [--type T] [--json]

Fragt den laufenden Daemon mit derselben Suche, die Agenten nutzen (MCP recall /
REST /api/v1/recall), und zeigt die passenden Memories: ID, Typ und Bereich,
Titel, Zusammenfassung. --limit begrenzt die Treffer (1–20, Standard 5); --scope
und --type grenzen auf einen Bereich oder Memory-Typ ein. --json gibt die Antwort
des Daemons unverändert aus, für Skripte. Private Memories erscheinen hier
nicht, genau wie über REST.
`,

  save: `bastra save — selbst ein Memory speichern

Aufruf:
  bastra save --title T --type T --scope S [options] [text]
  echo "text" | bastra save --title T --type T --scope S

Optionen:
  --summary S          eine Zeile für die Trefferliste (Standard: die erste Textzeile)
  --recall-when W      wann es auftauchen soll; wiederholbar (Standard: der Titel)
  --tag X              wiederholbar (Standard: der Bereich)
  --topic a/b          Themenpfad (Standard: der Bereich)
  --dry-run            zeigen, was gespeichert würde (Datei, Regel oder Notiz); schreibt nichts
  --json               die Antwort des Daemons unverändert ausgeben

Der Text sind die Wörter nach den Optionen oder das, was hineingeleitet wird.
--type ist einer von reference, project-fact, decision, lesson, workflow,
preference, user-preference, meta-working. Das Speichern läuft über den
save_memory-Weg des laufenden Daemons mit jeder Prüfung, die auch das Speichern
eines Agenten bekommt (Anspruchsprüfung, Schwärzung von Zugangsdaten,
Protokoll, Indexierung), und wird als deine eigene Anweisung festgehalten
(write_origin: user-directed). Was ein anderes Memory schon abdeckt, wird
zurückgehalten, nicht geschrieben: Der Befehl nennt dieses Memory und endet mit
Exit 1. Ein vorhandenes Memory mit demselben Titel wird nicht überschrieben.
`,

  reconcile: `bastra reconcile — zwei Ablagen desselben Vaults: welche Kopie ist weiter

Aufruf:
  bastra reconcile [--vault <this-store>]                  die Kopien dieses Vaults listen
  bastra reconcile <other-store> [--vault <this-store>]   der Plan (Probelauf, Standard)
  bastra reconcile <other-store> --yes                     die Kopien ausführen
  bastra reconcile <other-store> --json                    der Plan als JSON

Ohne <other-store> sucht es nach Kopien: Vault-Pfade in den Client-Einträgen
(Claude Code, auch je Projekt; Claude Desktop, Cursor, Codex) und
BASTRA_VAULT_PATH — wohin ein vom Forwarder gestarteter Daemon schreibt, wenn
der eingerichtete nicht erreichbar ist —, symbolische Links auf eine Ablage und
Ordner mit einem bastra-Prüfprotokoll in Sync-Ordnern (iCloud Drive,
~/Library/CloudStorage, Dropbox, OneDrive, Google Drive, Nextcloud, pCloud,
~/Sync). Ein Treffer in einem Sync-Ordner zählt als Kopie, wenn sein
Prüfprotokoll ein Memory mit dem dieses Vaults teilt. Bei genau einer anderen
Kopie zeigt es den Probelauf dagegen; --yes nimmt die Ablage immer als Argument.

Vergleicht Memory für Memory, verbunden über die ID im Frontmatter. mtime, Hash
und Größe sagen hier nichts: Der Daemon schreibt Dateien von sich aus neu
(erzeugte Felder, der Auto-Related-Block). Zwei Kopien gelten als gleich, wenn
ihr verfasster Inhalt übereinstimmt — Text ohne den erzeugten Block,
Zeilenumbrüche zusammengefasst, Wikilinks in einer Schreibweise, Frontmatter
ohne erzeugte Felder.

Welche Seite weiter ist, folgt aus dem Prüfprotokoll jeder Ablage
(.bastra/audit-log.ndjson): die Seite mit Schreibvorgängen, die der anderen
fehlen. Schreibvorgänge auf beiden Seiten, eine Änderung, die keines der
Protokolle kennt (eine Bearbeitung in einem anderen Editor), ein Löschen auf
einer Seite oder eine doppelte ID ist ein Konflikt: gelistet, nie aufgelöst.

--yes kopiert nur die eindeutigen Fälle. Eine überschriebene Datei wird vorher
nach <store>/.bastra/reconcile-backup/<time>/ kopiert; eine Datei, die sich seit
dem Plan geändert hat, wird übersprungen. Die Protokolleinträge des kopierten
Memorys gehen mit, sodass der nächste Lauf die Reihenfolge noch kennt. Nichts
wird gelöscht. Exit-Code 1, wenn eine Kopie übersprungen wurde.

Nicht der regelmäßige Vault-Neuindex des Daemons (BASTRA_VAULT_RECONCILE_MS).
`,
};
