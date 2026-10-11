# Aufgaben und Erinnerungen

Bastra merkt sich Aufgaben außerhalb einer Chatsitzung. Der Daemon prüft Fälligkeit automatisch; Karten erscheinen bei einem passenden nächsten Kontakt. Ein abwesender Client wird nicht automatisch geweckt. Quittieren bedeutet „gesehen“, Erledigen bedeutet „abgeschlossen“.

## Von null zur ersten Karte

Die Befehle gehören zum ausgelieferten `bastra`-CLI. Der Daemon muss laufen. Für einen Test verwende einen eigenen Vault, eigenen Aufgabenpfad und freien Port; die Demo-Anleitung verwendet ausschließlich Wegwerf-Daten.

1. Lege am eigenen Terminal einen Owner-Zugang an:

   ```sh
   mkdir -p ~/.bastra
   bastra tasks auth mint owner ich personal ~/.bastra/owner-task.token
   ```

   Die neue Datei hat private Rechte. Öffne sie in einem lokalen Editor und kopiere den Token. Gib ihn nur in die verborgene Terminal-Abfrage oder die Aufgaben-Seite ein, niemals in einen Chat. Die Datei gehört außerhalb des Zugriffs von Agenten. Der Owner-Zugang darf scharf schalten, quittieren und erledigen; er ist kein Signing-Schlüssel für Dateiänderungen.

Optional: `bastra tasks owner-login` speichert den Zugang privat für die interaktive CLI, damit du den Token nicht bei jedem Befehl eintippen musst. Dieses Verzeichnis muss außerhalb des Zugriffs von Agenten liegen. Die Ablage wird frisch gegen die Registry geprüft und niemals von Hooks/MCP geladen. Signing-Schlüssel und Passphrase bleiben getrennt; die Signier-CLI entsperrt sie weiterhin pro Wirkung.

2. Richte Karten für lokale Hooks/MCP ein:

   ```sh
   bastra tasks setup-hooks
   bastra tasks client-status
   ```

   Die Owner-Kennung wird verborgen abgefragt. Bastra speichert für die Clients eine separate Agent-Kennung mit den Owner-Domänen. Die Hooks brauchen keine manuelle Änderung der Shell-Umgebung. Ein explizites `BASTRA_TASK_TOKEN` hat Vorrang; eine widerrufene oder fehlende Kennung wird im Status benannt. Ein gültiger Zugang allein startet keinen Daemon und garantiert keinen Hintergrund-Wakeup.

3. Lege eine kurze, scharfe Erinnerung an:

   ```sh
   bastra tasks create --goal "Kurzen Test auswerten" --after 1m --timezone Europe/Madrid --domain personal --arm
   bastra tasks list
   ```

   Die Bestätigung nennt Wunsch, Zeitpunkt, Zeitzone, Zustand und scharf/unscharf. Ohne `--arm` bleibt sie unscharf. Wünsche eines Agenten bleiben immer unscharf. Owner-Prüfung schaltet scharf:

   ```sh
   bastra tasks review AUFGABEN_ID
   ```

4. Warte auf die Minute und den nächsten Kontakt oder zeige Fälliges ausdrücklich:

   ```sh
   bastra tasks due
   bastra tasks acknowledge AUFGABEN_ID --occurrence VORKOMMEN_ID
   bastra tasks resolve AUFGABEN_ID
   ```

   Die IDs stehen in der Karte. Eine quittierte Aufgabe bleibt offen und kann selten erneut erscheinen. Der Owner kann Fälliges ausdrücklich ansehen, auch wenn passive Zustellung stumm oder aus ist. `resolve` beendet die Aufgabe. `cancel` bricht sie ab; `rearm` legt sie **unscharf** wieder zur Prüfung vor und erneuert keine alten Freigaben.

## Zeit und Wiederholung

```sh
bastra tasks create --goal "Nach sieben Tagen auswerten" --after 7d --timezone Europe/Madrid
bastra tasks create --goal "Täglich prüfen" --when 2026-10-12T18:00 --timezone Europe/Madrid --every 1d --count 3
bastra tasks snooze AUFGABEN_ID --until 18:00
```

`--after 7d` meint sieben verstrichene Tage. `--when` ohne Offset meint Ortszeit in der angegebenen Zeitzone; ohne `--timezone` wird die Maschinenzeitzone sichtbar als Annahme genannt. Tages-/Wochenwiederholungen einer Ortszeit bleiben Kalenderwiederholungen. Jede Wiederholung braucht eine Anzahl oder `--end`.

Eine nicht existierende Sommerzeit-Uhrzeit wird abgewiesen. Eine mehrdeutige Herbst-Uhrzeit wählt den früheren Zeitpunkt, bleibt beim CLI-Anlegen unscharf und zeigt den Grund. Der Owner prüft diese Wahl ausdrücklich mit `review`. `snooze --until 18:00` meint die nächste entsprechende Ortszeit; ein vollständiges Datum ist ebenfalls möglich. Agent-Snooze bleibt im festen 24-Stunden-Fenster.

## Überblick und Steuerung

```sh
bastra tasks status
bastra tasks mute
bastra tasks unmute
bastra tasks off
bastra tasks on
bastra tasks stop
```

Status nennt An/Aus, Zustandszahlen, nächste Prüfung, letzte Zustellung, Fehler und Backoff. `mute` verschiebt passive Zustellung. `off` hält automatische Auswertung und Zustellung an. `stop` hält nur Ausführung an; Erinnern/Vorbereiten bleiben nutzbar. Nichts davon erledigt eine Aufgabe. Ausführung ist als sicherer Standard gestoppt. Nur ein Owner mit geschützter Konfiguration kann `execution-enable` bestätigen; dies erneuert weder abgelaufene Signaturen noch Leases.

`--json` gibt das Maschinenformat aus. Ohne diesen Schalter sind Ergebnisse und Fehler lesbare deutsche Meldungen. Erweiterte Quellen/Evidenz können weiterhin per `--input` übergeben werden.

## Browser und Entscheidung prüfen

```sh
bastra config set ui.enabled true
bastra tasks ui
```

Die Aufgaben-Seite fragt den Token ab und hält ihn nur in der geöffneten Seite. Sie zeigt Aufgaben, Karten, Quellen und Freigaben. Anlegen ist standardmäßig unscharf; Owner-Prüfung, Quittieren, Zurückstellen, Erledigen und Beenden bleiben getrennt. Daten werden als Text dargestellt. Für eine widerlegte tragende Annahme zeigt die Karte alte Entscheidung, geänderte Prämisse, Evidenz und Unsicherheit. Beibehalten, Ändern, Zurückstellen und Überwachung beenden sind eigene Owner-Wahlen. Beibehalten schaltet den historischen Watch ab; weitere Änderungen brauchen eine neue Owner-Bindung.

Vorbereiten zeigt einen exakten Datei-Vorschlag und schreibt das Ziel nicht. Die CLI entsperrt Signing-Schlüssel und signiert die ganze Bindung; die Browser-Kennung und automatische Klicks ersetzen diese Signatur nicht. Jede betroffene Domäne muss zustimmen. Für Execute sind zusätzlich ein aktivierter registrierter lokaler Adapter, eine lebende Lease und eine fällige scharfe Aufgabe erforderlich. Die geschützte Grenze ist eine ausdrückliche, technisch nicht geprüfte Owner-Zusicherung über fehlenden Agent-Zugriff auf Daten, Schlüssel und Laufzeit. Ohne diese Grenze bleibt Execute gesperrt. Der nächste Abschnitt richtet den Referenzadapter ein; die vollständige Wegwerf-Demo steht in `docs/design/proactive-tasks-demo.md`.

## Ein lokales Ziel registrieren

Unterstützt wird genau ein Referenzadapter: eine vorhandene, registrierte UTF-8-Datei exakt ersetzen. Kein Versand, keine Anbieter-Nachrichten, keine E-Mail-, Slack-, GitHub-, Cloud- oder Shell-Aktionen. Der Vorzustand muss rückrollbar sein: höchstens 16384 Zeichen, keine Tabs/CRLF/BOM/Steuerzeichen oder Inhalte, die sich nicht sicher unverändert darstellen lassen.

```sh
bastra tasks targets register demo --root /ABSOLUTER/DEMOORDNER --path artifact.txt --domain personal
bastra tasks targets list
bastra tasks keys enroll personal /OWNERORDNER/approval-key.json
bastra tasks boundary
# Alle Task-Prozesse neu starten, damit sie die neue Registry binden.
bastra tasks execution-enable
```

Zielregistrierung ersetzt keine vorhandene Kennung still. Sie stoppt Ausführung und setzt die Grenzerklärung zurück. Der Owner sieht vor Bestätigung den konkreten Pfad und die Domänen. Die Browser-Seite zeigt exakte Vorher/Nachher-Inhalte; alle Bindungsdetails bleiben zusätzlich aufklappbar. Signing-Schlüssel bleiben am Owner-Terminal, die ganze Bindung wird vor dem Signieren angezeigt. Jeder Write und jedes Rollback braucht neue konkrete Signaturen aller Pflichtdomänen, eine frische Lease und einen unveränderten Zielstand. `resume` fragt lesbar mit Nein als Standard; Nein ändert nichts.

## Budgets, Archiv und Reparatur

Status und Seite nennen pro Aufgabe Prüfintervall, Timeout und Quell-Bytegrenze sowie die globalen Grenzen: höchstens 10 Quellprüfungen und 5 s Quellbudget je Lauf, 60 s Poll, höchstens 1 s pro Quelllesung, 4 MiB aktive Momentaufnahme (Normalbetrieb bis 75 %). Unveränderte Fehlquellen gehen bis 1 h in Backoff. Neue angenommene Ereignisse umgehen diesen Backoff; sie werden geordnet beim Kontakt oder nächsten Poll geprüft. Fünf Sekunden sind für kleine gesunde Tests vorgesehen, keine harte Garantie bei blockiertem Dateisystem, Lock-Konkurrenz oder Prozesspause.

```sh
bastra tasks stop
bastra tasks archive ERLEDIGTE_AUFGABEN_ID
bastra tasks archive-restore ARCHIV_ID
```

Archivierung exportiert validierte private History samt Wirkungsbelegen, bevor sie abgeschlossene Datensätze aus dem aktiven Speicher nimmt. Offene Vorkommen, offene/unklare Wirkungen und aktive Leases werden nicht archiviert. Verbrauchte Freigaben, Fencing-Zähler, Journal und Idempotenz bleiben erhalten. Wiederholungen liefern ursprüngliche IDs/Belege; ein fehlendes/verändertes Archiv wird als Fehler behandelt und erlaubt keine Wiederverwendung. `status` nennt die Archive. Wiederaufnahme lädt den Verlauf für Prüfung oder separat freigegebenes Rollback; sie schaltet nichts scharf und hält Ausführung gestoppt. Archive und Backups behalten sensible Inhalte: privat sichern, nicht an Agenten freigeben. Unaufgelöster Rückstau, verbrauchte Freigaben und der Archivindex haben feste Grenzen; Sättigung meldet `capacity`, nichts wird still gelöscht.

Bei beschädigtem Speicher: erst alle Task-Prozesse stoppen, dann `bastra tasks recover`. Der Owner bestätigt, die private letzte Backup-Version wird geprüft und das beschädigte Original gesichert. Aufgaben werden unscharf, Ausführung gestoppt, alte Revisions-/Freigabebindungen ungültig. Der letzte Backup-Stand kann jüngste Änderungen nicht enthalten; das Original bleibt zur Prüfung erhalten. `recover --lock` bietet zusätzlich eine ausdrückliche Offline-Sicherung einer unbekannten liegengebliebenen Sperre; bekannte lebende lokale Besitzer werden nie entfernt. Danach Daemon neu starten und jede Aufgabe neu prüfen. Keine automatische leere Ersatzablage bei Korruption.

Unklare Wirkungen bleiben als „Abgleich nötig“ sichtbar; kein automatischer zweiter Write. Ein unsicher bereinigbarer Temp-Rest wird ausdrücklich genannt. `intent-reconcile --input ...` oder der Abgleichknopf liest den Zielstand und versucht nur eigene hashgebundene Restdateien zu entfernen, auch wenn das Ziel fehlt. Fremde/abweichende Reste werden nicht gelöscht. Die Wegwerf-Demo steht in `docs/design/proactive-tasks-demo.md`.

Zielschutz: `--root` ist ein ausdrücklich gewählter enger Arbeitsordner. Die Rückfrage nennt seinen realen, symlink-aufgelösten Pfad; außerhalb des aktuellen Projektordners erscheint eine Warnung. Aufgaben-/Schlüsselordner, `~/.bastra`, Vault, Agent-/Hook-/Client-/Dienst-Konfiguration und Shell-Profile sind fest gesperrt, ebenso Wurzeln, die solche Orte umfassen. Für vorhandene Ziele: `targets update ID --root DIR --path FILE --domain DOMAIN` oder `targets remove ID`. Beide verlangen Owner-Bestätigung, stoppen Ausführung und setzen die Grenzerklärung zurück; neu starten und erneut prüfen. Bei Schlüssel-Einschreibung registriert Bastra den privaten Schlüsselordner als gesperrten Ort; Schlüssel gehören in einen separaten Owner-Ordner.

Recovery meldet stets, dass Änderungen nach dem älteren Backup fehlen können. Private gültige kalte Exporte werden mit dem Backup-Index abgeglichen; ihre History/Idempotenz und verbrauchten Freigaben bleiben erreichbar. Eine vor dem Backup archivierte Aufgabe kann als abgeschlossener aktiver Verlauf zurückkommen und zugleich im Archiv stehen. Das ist keine neue Aufgabe oder Freigabe. Original und Archiv prüfen; nichts wird still gelöscht. Bei lesbarem Original werden Archivindex, verbrauchte Freigaben und Fencing-Maximum zusätzlich vereinigt. Nicht validierbare Archivdateien blockieren die Reparatur und bleiben zur Owner-Prüfung erhalten.

Git-Steuerung (`.git` einschließlich Hooks/config/HEAD/refs), `.husky`, `.github/workflows`, `.envrc` und `.npmrc` sind ebenfalls gesperrt. `package.json` ist als ausdrücklich gewählte Arbeitsdatei zulässig, aber die Rückfrage warnt immer vor später ausführbaren Install-/Test-/Start-Skripten; jede konkrete Änderung braucht weiter exakte Owner-Freigabe.

Recovery-Grenze: Ist das Original unlesbar und das Backup älter als eine jüngste unarchivierte Wirkung, können deren Verbrauchs-ID und Quittung fehlen. Bekannte archivierte/lesbare Verbrauchs-IDs werden vereinigt; neue Epoch und unscharfer/gestoppter Zustand blockieren trotzdem die alte Freigabe. Das ist Replay-Schutz, keine vollständige Rekonstruktion des jüngsten Verlaufs. Original und Ziel prüfen.
