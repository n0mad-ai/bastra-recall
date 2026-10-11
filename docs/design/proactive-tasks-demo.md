# Proaktive Aufgaben: Wegwerf-Demo

Diese Demo benutzt nur einen eigenen temporären Vault, Aufgaben-/Owner-/Arbeitsordner und freien Port. Sie ändert keine reale Erinnerung, Dienstdatei oder Anbieter-Ressource. Das Startskript erzeugt stets eine frische Test-Isolation samt Benutzerkonfiguration; geerbte Test-/Keep-env-/Log-/Eval-Einstellungen werden nicht übernommen. Kein Merge, Tag, Release oder Versionswechsel. Der vorbereitete synthetische Owner-Zugang ist eine Testhilfe, kein Beleg realer menschlicher Anwesenheit oder einer geschützten OS-Grenze.

Plane **20–30 Minuten** ein. Für die erste Erinnerung: eine Minute Frist plus bis zum nächsten 60-Sekunden-Poll; das kann insgesamt ungefähr **1:40 Minuten** dauern. `due`/Browser-Aktualisieren löst einen Kontakt aus, Auswertung und Anzeige laufen getrennt; gegebenenfalls nach einigen Sekunden erneut anzeigen.

Abfragen: Jede `[y/N]`-Frage hat **Nein** als Standard. Für Zustimmung `yes` tippen. setup-hooks nutzt den vorbereiteten privaten Owner-Zugang. Schlüssel-Einschreibung fragt Zustimmung, den **verborgenen Owner-Aufgaben-Token**, die **neue verborgene Passphrase** und deren Wiederholung. boundary fragt erneut den verborgenen Token und Zustimmung. execution-enable fragt Zustimmung. approve zeigt die ganze Bindung, fragt Zustimmung und die verborgene Schlüssel-Passphrase. Browser-Execute und Entscheidung ändern fragen nochmals nach. Der Token liegt nur in der privaten Demo-Datei; im lokalen Editor kopieren, nicht im Chat.

## Start

Im gebauten Checkout am eigenen Terminal (Node 22 oder neuer, Bash):

```sh
npm run build
node tools/proactive-tasks-demo.mjs
```

Das Werkzeug startet seinen eigenen Daemon und eine Shell mit dem Prompt `bastra-demo>`. **Alle folgenden Befehle in dieser Shell ausführen.** `bastra` verweist dort auf genau diesen Checkout. `$task_demo_root` enthält die gedruckte Wegwerf-Ablage; der reale Dienst auf 6723 wird nicht angesprochen. Owner-CLI-Zugang ist privat vorbereitet; Signing-Schlüssel und konkrete Freigaben fehlen absichtlich. Ohne Terminal startet die Demo nicht. Der nötige Isolations-Preload wird intern in einem frischen Prozess geladen.

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

Lokale URL öffnen, synthetischen Token aus der privaten Demo-Datei einsetzen, **Aktualisieren → Karten anzeigen**. Erst die Karte ansehen, dann die getrennten Schritte ausprobieren:

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
bastra tasks targets register demo --root "$task_demo_root/work" --path artifact.txt --domain personal
bastra tasks targets list
bastra tasks keys enroll personal "$task_demo_root/owner/approval-key.json"
```

Registrierung nennt den echten Pfad und warnt vor dem außerhalb des Checkout gewählten Arbeitsordner. Daten-/Schlüssel-/Vault-/Konfigurationsorte und Shell-Profile sind gesperrt. Nur `work/artifact.txt` wird registriert. Ziel-/Schlüsseländerungen stoppen Ausführung und setzen die Grenzerklärung zurück.

Für die versteckte Owner-Token-Abfrage öffne `$task_demo_root/owner/task.token` **lokal im Editor** und kopiere den synthetischen Token; nicht in einen Chat. Wähle eine nur für diese Demo benutzte Passphrase mit mindestens 12 Zeichen. Die Schlüsseldatei bleibt im getrennten privaten Owner-Ordner.

```sh
bastra tasks boundary
demo-restart
```

Die Grenzerklärung ist technisch nicht prüfbar. Diese Testsession hat dieselbe OS-Berechtigung wie ihre Fixture; ihre Erklärung ist deshalb **synthetisch**, keine Produktionsfreigabe. Für reale Nutzung müssen Agenten tatsächlich keinen Schreib-/Lesezugriff auf Owner-Daten, Schlüssel und Daemon-Laufzeit haben. Warte auf **„Demo-Daemon wieder bereit“**, dann:

```sh
bastra tasks execution-enable
bastra config set ui.enabled true
bastra tasks ui
```

execution-enable fragt mit Nein als Standard. Der eine Referenzadapter ersetzt exakt eine vorhandene registrierte reversible UTF-8-Datei. Keine E-Mail-, Slack-, GitHub-, Cloud-, Anbieter- oder Shell-Aktionen. Tabs/CRLF/BOM/Steuerzeichen, nicht sicher unverändert darstellbare Inhalte und Vorzustände über 16384 Zeichen werden abgewiesen.

## 3 Vorbereiten schreibt nichts; Ausführen braucht jede konkrete Signatur

```sh
bastra tasks create --goal "Demo-Artefakt nach Owner-Prüfung ersetzen" --when 2000-01-01T00:00:00Z --timezone Europe/Madrid --domain personal --level execute --arm
```

Der ausdrücklich vergangene Zeitpunkt macht die **neue** Demo-Aufgabe fällig; kein alter Event wird wiederverwendet. Öffne die von `tasks ui` genannte lokale Seite und melde dich mit dem synthetischen Owner-Token an. Bei der fälligen Aufgabe **Vorbereiten**, Ziel-ID `demo`, neuer Inhalt zum Beispiel `Nachher: synthetische Demo.`. Vorher/Nachher erscheinen lesbar; die ganze Bindung ist aufklappbar. Die Datei bleibt zunächst unverändert.

Übernimm die Vorschlags-ID aus dem Dialog:

```sh
bastra tasks approve VORSCHLAGS_ID personal "$task_demo_root/owner/approval-key.json"
```

Prüfe Aufgabe, konkreten Zielpfad, Revisionen, Domänen, Ablauf, Payload-Hash und alle Bytes vor dem Signieren. Passphrase wird verborgen abgefragt. Nein/Widerruf/Ablauf/Drift schreiben nichts. Bei mehreren Pflichtdomänen braucht jede Domäne eine eigene gültige Signatur.

In der Seite **Aktualisieren**, denselben Vorschlag erneut öffnen. **Exakt freigegeben ausführen** wird nur bei aktueller vollständiger Freigabe verfügbar. Der Daemon reserviert eine lebende Lease, verbraucht die Freigabe vor dem Adapteraufruf und prüft unter der Store-Sperre erneut unmittelbar vor dem Write. Status zeigt Absicht und Wirkungsquittung; das erledigt die Aufgabe nicht automatisch.

## 4 Rückabwicklung und unbekannter Ausgang

Im Abschnitt **Wirkungen und Abgleich** die erfolgreiche Quittung wählen, **Rückabwicklung vorbereiten**. Neue Vorschlags-ID mit approve signieren, aktualisieren und exakt ausführen. Der ursprüngliche Inhalt wird nur bei unverändertem freigegebenem Nachzustand zurückgestellt. Eigene zwischenzeitliche Bearbeitung blockiert Rollback. Jede Rückabwicklung braucht neue konkrete Signaturen/Lease/CAS; alte Freigaben werden nie wieder lebendig.

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
