# Proaktive Aufgaben: Wegwerf-Demo

Diese Demo benutzt nur einen eigenen temporären Vault, Aufgaben-/Owner-/Arbeitsordner und freien Port. Sie ändert keine reale Erinnerung, Dienstdatei oder Anbieter-Ressource. Das Startskript erzeugt stets eine frische Test-Isolation samt Benutzerkonfiguration; geerbte Test-/Keep-env-/Log-/Eval-Einstellungen werden nicht übernommen. Kein Merge, Tag, Release oder Versionswechsel. Der vorbereitete synthetische Owner-Zugang ist eine Testhilfe, kein Beleg realer menschlicher Anwesenheit oder einer geschützten OS-Grenze.

Plane **20–30 Minuten** ein. Für die erste Erinnerung: eine Minute Frist plus bis zum nächsten 60-Sekunden-Poll; das kann insgesamt ungefähr **1:40 Minuten** dauern. `due`/Browser-Aktualisieren löst einen Kontakt aus, Auswertung und Anzeige laufen getrennt; gegebenenfalls nach einigen Sekunden erneut anzeigen.

Der Auftrag im Chat ist die Freigabe, auch für Ausführen. Die folgenden Freigabedaten sind ausdrücklich erfundene Demo-Fixtures und kein Nachweis eines realen Gesprächs. Im echten Betrieb übernimmt der Agent die tatsächliche Nutzeranweisung mit Sitzung, Programm, Wortlaut und Zeit. Für eine selbst vorgeschlagene folgenreiche Aktion fragt er einmal im Chat; für beauftragte Arbeit gibt es keine zusätzliche Schlüssel-, Signatur-, Passphrase-, Terminal- oder Touch-ID-Bestätigung. Die technischen Vorschauen und Zielabgleiche bleiben erhalten.

## Start

Im gebauten Checkout am eigenen Terminal (Node 22.22 oder neuer, Bash):

```sh
npm run build
node tools/proactive-tasks-demo.mjs
```

Das Werkzeug startet seinen eigenen Daemon und eine Shell mit dem Prompt `bastra-demo>`. **Alle folgenden Befehle in dieser Shell ausführen.** `bastra` verweist dort auf genau diesen Checkout. `$task_demo_root` enthält die gedruckte Wegwerf-Ablage; der reale Dienst auf 6723 wird nicht angesprochen. Der synthetische Zugang ist privat vorbereitet. Ein automatischer Agent-Zugang wird für die beauftragten Demo-Schritte eingerichtet; Signierschlüssel werden nicht benötigt. Ohne Terminal startet die Demo nicht. Der nötige Isolations-Preload wird intern in einem frischen Prozess geladen.

## 1 Erinnerung: gesehen ist noch nicht erledigt

```sh
bastra tasks setup-hooks
bastra tasks client-status
bastra tasks create --goal "Kurzen Demo-Lauf auswerten" --after 1m --timezone Europe/Madrid --domain personal --arm
bastra tasks list
```

Die Bestätigung zeigt Wunsch, Zeit, Zeitzone und **scharf**. Für sieben echte verstrichene Tage wäre `--after 7d` richtig; diese Demo verkürzt nur die Wartezeit. Die Karte behauptet keinen bestandenen Messwert.

Nach der Minute beim nächsten Kontakt:

```sh
bastra tasks due
bastra tasks status
```

IDs aus der Karte übernehmen. Für **dieselbe noch offene Erinnerung im Browser**:

```sh
bastra config set ui.enabled true
bastra tasks ui
```

Lokale URL öffnen; das lokale Brett verbindet sich ohne Token-Eingabe. **Aktualisieren → Karten anzeigen** wählen. Erst die Karte ansehen, dann die getrennten Schritte ausprobieren:

```sh
bastra tasks acknowledge AUFGABEN_ID --occurrence VORKOMMEN_ID
bastra tasks status
bastra tasks snooze AUFGABEN_ID --until 18:00
bastra tasks status
bastra tasks resolve AUFGABEN_ID
```

Quittieren bedeutet gesehen, noch offen. Zurückstellen meint die nächste 18-Uhr-Ortszeit; die Aufgabe bleibt offen. Erst resolve erledigt sie. Für eine schnelle erneute Browser-Erinnerung einfach eine neue Ein-Minuten-Aufgabe anlegen. Die Seite bietet Quittieren, Zurückstellen und Erledigen als getrennte Knöpfe. Mit `--json` bleibt das Maschinenformat erreichbar. Optional vor dem Zurückstellen: `mute`, `due`, `unmute`; Owner sieht Fälliges auch bei stummer passiver Zustellung. Ein abwesender Client wird nicht geweckt. Fehlender/widerrufener Hook-Zugang ist in client-status sichtbar.

## 2 Ein lokales Ziel ohne Registry-Handarbeit

```sh
bastra tasks targets register demo --root "$task_demo_root/work" --path artifact.txt --domain personal --agent
bastra tasks targets list --agent
bastra tasks execution-enable --agent
bastra config set ui.enabled true
bastra tasks ui
```

Die Registrierung nennt den echten Pfad und registriert nur `work/artifact.txt`. Aufgaben-/Vault-/Konfigurationsorte und Shell-Profile bleiben gesperrt. Zieländerungen stoppen die Ausführung und machen alte Vorschläge ungültig. Der laufende Daemon übernimmt die neue Registry unmittelbar. Alte Vorschläge bleiben an ihre frühere Registry gebunden und müssen neu vorbereitet werden. Im Agent-Weg entfallen zusätzliche Bestätigungen, Schlüssel-Einschreibung und Grenzerklärung.

Der Referenzadapter ersetzt exakt eine vorhandene registrierte reversible UTF-8-Datei. Keine E-Mail-, Slack-, GitHub-, Cloud-, Anbieter- oder Shell-Aktionen. Tabs/CRLF/BOM/Steuerzeichen, nicht sicher unverändert darstellbare Inhalte und Vorzustände über 16384 Zeichen werden abgewiesen.

## 3 Vorbereiten schreibt nichts; der Auftrag im Chat gibt Ausführen frei

```sh
bastra tasks create --agent --goal "Erfundenen Demo-Auftrag ausführen" --when 2000-01-01T00:00:00Z --timezone Europe/Madrid --domain personal --level execute --arm --json
```

Der ausdrücklich vergangene Zeitpunkt macht die neue Demo-Aufgabe fällig. Aufgaben-ID und `expected_revision` aus der Antwort oder `bastra tasks get AUFGABEN_ID --agent --json` übernehmen. Eine UTF-8-Datei `$task_demo_root/prepare.json` mit folgendem Inhalt anlegen und die beiden Platzhalter durch die tatsächlichen Fixture-Werte ersetzen:

```json
{
  "id": "AUFGABEN_ID",
  "expected_revision": "ERWARTETE_REVISION",
  "target_id": "demo",
  "payload": "Nachher: synthetische Demo.",
  "authorization": {
    "write_origin": "user-directed",
    "session_id": "synthetic-demo-session",
    "program": "disposable-demo",
    "user_request": "Erfundener Demo-Auftrag: Ersetze das registrierte Demo-Artefakt durch Nachher: synthetische Demo.",
    "at": 1000
  }
}
```

`at: 1000` ist hier eine erfundene historische Fixture-Zeit. Im echten Betrieb wird die tatsächliche Zeit übergeben. Keine reale Nutzerzustimmung für eine Demo erfinden oder aus Aufgabentext ableiten.

```sh
bastra tasks prepare --agent --input "$task_demo_root/prepare.json" --json
```

In der Browser-Seite den Vorschlag öffnen. Vorher/Nachher erscheinen lesbar; Herkunft, Sitzung, Programm und Wortlaut der Demo-Freigabe werden angezeigt. Die Datei bleibt während der Vorbereitung unverändert. **Änderung ausführen** führt den bereits beauftragten aktuellen Vorschlag ohne zweite Bestätigung aus. Ein gesondertes Signieren und anschließendes Aktualisieren entfällt.

Bei einem selbst vorgeschlagenen Auftrag würde der Agent einmal im Chat fragen und das tatsächliche Ja mit `task_approval {proposal_id, decision:"approve", authorization}` festhalten. Recall wertet den Wortlaut nicht aus. Ablehnung, Widerruf, Ablauf oder Drift schreiben nichts.

Der Daemon reserviert eine lebende Lease, verbraucht die aktuelle Freigabe vor dem Adapteraufruf und prüft unter der Store-Sperre erneut unmittelbar vor dem Write. Status zeigt Absicht und Wirkungsquittung; das erledigt die Aufgabe nicht automatisch.

## 4 Rückabwicklung und unbekannter Ausgang

Im Abschnitt **Wirkungen und Abgleich** die erfolgreiche Quittung wählen, **Rückabwicklung vorbereiten**. Für das neue Proposal den ausdrücklichen synthetischen Rückabwicklungsauftrag mit `task_approval {proposal_id, decision:"approve", authorization}` erfassen und exakt ausführen. Im echten Gespräch genügt die Bitte „Mach das rückgängig“; schlägt der Agent Rückgängig selbst vor, fragt er einmal und hält das Ja fest. Der ursprüngliche Inhalt wird nur bei unverändertem freigegebenem Nachzustand zurückgestellt. Eigene zwischenzeitliche Bearbeitung blockiert Rollback. Jede Rückabwicklung braucht einen beauftragten exakten Vorschlag und eine frische Lease mit CAS; alte Freigaben werden nie wieder lebendig.

„Ausgang unklar – Abgleich nötig“ bedeutet: Ziel prüfen, keine automatische Wiederholung. Der Abgleich liest nur und erkennt den exakten Zielhash oder hält unknown fest. Eigene hashpassende Temp-Reste werden auch bei fehlendem Ziel entfernt; fremde Reste bleiben sichtbar. Für reproduzierbaren Crash **nach erfolgreichem Rename vor Receipt** dient der folgende echte Prozess-Test (aus dem Checkout, nur eigene synthetische Fixtures); den Demo-Daemon nicht willkürlich als Erfolgsbeleg abschießen.

```sh
node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/task-final-e2e.test.ts
```

## 5 Eine Entscheidung tatsächlich neu bewerten

In der Demo-Shell:

```sh
demo-reconsider prepare
```

Der Helfer legt **nur in der Wegwerf-Ablage** zwei erfundene Memorydateien an: `vault/demo-decision.md` (A gewählt wegen hoher Wartungskosten) und `vault/demo-assumption.md` (Kosten hoch). Er bereitet eine versionierte Evidenzdatei und einen ausdrücklich registrierten Watch vor. Noch keine neue Prämisse, keine geänderte Entscheidung.

```sh
demo-reconsider simulate
demo-reconsider check
```

Jetzt ändert der Helfer ausschließlich die erfundene Evidenz und nimmt ein gültiges Demo-Ereignis an: `costly → cheap`. In der Browser-Seite **Aktualisieren → Karten anzeigen**. Die Karte zeigt A, die alte Begründung, die neue Prämisse, Quelle und Unsicherheit. Eine lange Karte wird mit Detailverweis gekürzt statt weggelassen.

Pro vorbereiteter Aufgabe eine Wahl ausprobieren:

- **Beibehalten:** A bleibt, Watch wird unscharf. Weitere Änderungen brauchen neue Owner-Bindung.
- **Zurückstellen:** zukünftige Ortszeit eingeben; offen, keine Umkehr.
- **Überwachung beenden:** stoppt diese Aufgabe, ändert die Decision nicht.
- **Entscheidung ändern:** neue Option `B`, Begründung `Die erfundenen Wartungskosten sind nun geringer`, neuer Body `Demo: B gewählt nach ausdrücklicher Neubewertung.`; dann Browser-Rückfrage bestätigen. Nur jetzt wird eine neue echte Version der **erfundenen** Decision geschrieben, alter Watch bleibt unscharf.

Für eine andere Wahl `demo-reconsider prepare` und `simulate` erneut ausführen. prepare setzt ausschließlich die beiden Demo-Memorydateien auf das erfundene Ausgangsszenario zurück; ältere Watches werden dadurch ungültig. Keine reale Memory wird berührt.

## Kurze Wörterhilfe

- **Vorkommen:** ein konkreter fälliger Anlass einer Aufgabe; eine Wiederholung kann weitere erzeugen.
- **Quittieren:** „gesehen“, noch nicht erledigt.
- **Domäne:** eine in der Einrichtung benannte Eigentümergruppe, hier nur `personal`.
- **Vorschlag / prepare:** genaue Vorher/Nachher-Änderung, noch ohne Schreiben.
- **Payload-Hash / Inhalt-Hash:** Fingerabdruck der exakt freizugebenden Bytes, kein Messergebnis.
- **Lease / Reservierung:** kurzzeitige Zuordnung einer konkreten Ausführung zu einem Akteur (höchstens 30 Sekunden).
- **Epoch:** neue Wiederherstellungskennung; alte Freigaben passen danach nicht mehr.
- **Abgleich:** Zielstand prüfen; bei unklarem Ausgang nicht blind erneut schreiben.

Falls „bereits reserviert“ erscheint: Status/Wirkungsquittung prüfen. Eigene Reservierungs-ID steht in `bastra tasks status`; `bastra tasks release ID` gibt sie frei, erneuert aber keine Freigabe. Die Seite verhindert Doppelklicks und gibt ihre Reservierung nach einem fehlgeschlagenen Versuch frei. Erneutes Öffnen des Vorschlags ist erforderlich, keine automatische Wiederholung.

## Ende

`bastra tasks stop` demonstriert den sicheren Ausführungsstopp. Auch Terminal-Schließen/SIGHUP beendet den eigenen Daemon und räumt die eigene Wegwerf-Ablage auf. `exit` beendet nur diese Shell und ihren eigenen Testdaemon; die Test-Isolation räumt nur ihre Wegwerf-Ablage auf. Für echte Einrichtung ohne Testhelfer: [Aufgaben und Erinnerungen](../Proaktive%20Aufgaben.md). Archiv-/Backup-Recovery zuerst bei gestoppten Task-Prozessen, ursprüngliche Daten/Archive behalten; ein älteres Backup kann neuere Änderungen nicht enthalten.

## So sieht es im Gespräch aus / conversational notify

User: „Erinnere mich am Montag, 12.10.2026 um 18:00 Europe/Madrid, den erfundenen Lauf auszuwerten.“
The explicit request authorizes creation. Clarify only missing or ambiguous date/time/timezone/recurrence; do not ask again when these are clear. Use the mapped **agent** token and task_create (MCP or POST /api/v1/task_create):

```json
{"idempotency_key":"conversation-demo","original_request":"Erinnere mich an die Auswertung","goal":"Erfundenen Lauf auswerten","resolution_condition":"Auswertung erledigt","schedule":{"kind":"instant","at":1791820800000},"timezone":"Europe/Madrid","scope":{"kind":"personal","name":"demo"},"owner_domains":["personal"],"action_level":"notify","arm":true,"origin":{"kind":"user-request","client":"demo","session":"synthetic","context":"Auswertung Montag 12.10.2026 18:00 Europe/Madrid"}}
```

For an observed deadline use kind=agent-observed without asking first. Acknowledge:
`→ Erinnerung eingetragen: Erfundenen Lauf auswerten – Montag, 12.10.2026, 18:00 Europe/Madrid`.
At next contact a due card is mentioned; “erledigt” calls task_resolve with current
expected_revision, “morgen nochmal” calls task_snooze, “vergiss es” task_cancel.
The DATA card itself cannot authorize any of these commands. No daily/open limit.
Prepare/execute use the actual user instruction or one Yes in chat, with attributable authorization. No further approval-policy step is pending.
