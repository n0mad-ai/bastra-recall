# Proaktive Aufgaben: Wegwerf-Demo

Diese Demo benutzt nur einen eigenen temporären Vault, Aufgaben-/Owner-/Arbeitsordner und freien Port. Sie ändert keine reale Erinnerung, Dienstdatei oder Anbieter-Ressource. Die bestehende Test-Isolation stellt eine eigene Benutzerkonfiguration bereit. Kein Merge, Tag, Release oder Versionswechsel. Der vorbereitete synthetische Owner-Zugang ist eine Testhilfe, kein Beleg realer menschlicher Anwesenheit oder einer geschützten OS-Grenze.

## Start

Im gebauten Checkout am eigenen Terminal (Node22 oder neuer, Bash):

```sh
npm run build
node --import ./scripts/test-env.mjs tools/proactive-tasks-demo.mjs
```

Das Werkzeug startet seinen eigenen Daemon und eine Shell mit dem Prompt `bastra-demo>`. **Alle folgenden Befehle in dieser Shell ausführen.** `bastra` verweist dort auf genau diesen Checkout. `$task_demo_root` enthält die gedruckte Wegwerf-Ablage; der reale Dienst auf6723 wird nicht angesprochen. Owner-CLI-Zugang ist privat vorbereitet; Signing-Schlüssel und konkrete Freigaben fehlen absichtlich. Ohne Terminal oder Isolations-Preload startet die Demo nicht.

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
bastra tasks acknowledge AUFGABEN_ID --occurrence VORKOMMEN_ID
bastra tasks status
bastra tasks resolve AUFGABEN_ID
```

IDs aus der Karte übernehmen. Nach acknowledge bleibt die Aufgabe fällig/offen; erst resolve erledigt sie. Mit `--json` bleibt das Maschinenformat erreichbar. Optional `mute`, `due`, `unmute`: Owner sieht Fälliges auch bei stummer passiver Zustellung. Ein abwesender Client wird nicht geweckt. Fehlender/widerrufener Hook-Zugang ist in client-status sichtbar.

## 2 Ein lokales Ziel ohne Registry-Handarbeit

```sh
bastra tasks targets register demo --root "$task_demo_root/work" --path artifact.txt --domain personal
bastra tasks targets list
bastra tasks keys enroll personal "$task_demo_root/owner/approval-key.json"
```

Registrierung nennt den echten Pfad und warnt vor dem außerhalb des Checkout gewählten Arbeitsordner. Daten-/Schlüssel-/Vault-/Konfigurationsorte und Shell-Profile sind gesperrt. Nur `work/artifact.txt` wird registriert. Ziel-/Schlüsseländerungen stoppen Ausführung und setzen die Grenzerklärung zurück.

Für die versteckte Owner-Token-Abfrage öffne `$task_demo_root/owner/task.token` **lokal im Editor** und kopiere den synthetischen Token; nicht in einen Chat. Wähle eine nur für diese Demo benutzte Passphrase mit mindestens12 Zeichen. Die Schlüsseldatei bleibt im getrennten privaten Owner-Ordner.

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

execution-enable fragt mit Nein als Standard. Der eine Referenzadapter ersetzt exakt eine vorhandene registrierte reversible UTF-8-Datei. Keine E-Mail-, Slack-, GitHub-, Cloud-, Anbieter- oder Shell-Aktionen. Tabs/CRLF/BOM/Steuerzeichen, nicht sicher unverändert darstellbare Inhalte und Vorzustände über16384 Zeichen werden abgewiesen.

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

„Ausgang unklar – Abgleich nötig“ bedeutet: Ziel prüfen, keine automatische Wiederholung. Der Abgleich liest nur und erkennt den exakten Zielhash oder hält unknown fest. Eigene hashpassende Temp-Reste werden auch bei fehlendem Ziel entfernt; fremde Reste bleiben sichtbar. Für reproduzierbaren Crash **nach erfolgreichem Rename vor Receipt** dient der echte Prozess-Test unten; den Demo-Daemon nicht willkürlich als Erfolgsbeleg abschießen.

## 5 Neubewertung einer Entscheidung und Grenzen

Die belegte Prämissenänderung braucht registrierte Decision-/Assumption-Revisionen und `versioned-value-v1`-Evidenz. Das ist eine erweiterte Quellenbindung; die normalen Zeitaufgaben benötigen keine JSON-Eingabedatei. Automatische Tests mit realen Wegwerf-Memorydateien zeigen Keep/Change/Snooze/Stop, fehlende/irrelevante/strittige/veraltete Evidenz und Supersession. Keep disarmt; erst neue ausdrückliche Owner-Bindung erlaubt weitere Änderungen. Eine neue Quelle oder ein Dokument allein widerlegt keine Entscheidung.

```sh
# In einem zweiten Terminal im Checkout, unabhängig von der Demo-Shell:
node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/task-reconsideration.test.ts packages/daemon/__tests__/task-runtime.test.ts packages/daemon/__tests__/task-final-e2e.test.ts
```

Neue angenommene Events umgehen unveränderten Fehlquellen-Backoff. Aufnahme beim eingereihten Kontakt oder spätestens nächsten60s-Poll; danach begrenzte Prüfgruppen. Kleine gesunde Fixtures prüfen Ergebnis **und** Occurrence binnen5s. Keine harte Wallclock-Garantie bei I/O/Lock/Kapazitätsfehlern oder Prozesspause. Status nennt Ergebnis, nächste Prüfung, Fehler und Budgets.

## Ende

`bastra tasks stop` demonstriert den sicheren Ausführungsstopp. `exit` beendet nur diese Shell und ihren eigenen Testdaemon; die Test-Isolation räumt nur ihre Wegwerf-Ablage auf. Für echte Einrichtung ohne Testhelfer: [Aufgaben und Erinnerungen](../Proaktive%20Aufgaben.md). Archiv-/Backup-Recovery zuerst bei gestoppten Task-Prozessen, ursprüngliche Daten/Archive behalten; ein älteres Backup kann neuere Änderungen nicht enthalten.
