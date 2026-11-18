# Aufgaben und Erinnerungen

## Standardmäßig an (seit 1.2.0)

Aufgaben sind bei Neuinstallation und Update **seit 1.2.0 standardmäßig an**. Bis 1.1.8 waren sie eine Opt-in-Vorschau. Eine ausdrücklich frühere Abschaltung (`tasks.enabled=false` oder `BASTRA_TASKS=0`) bleibt erhalten. Für den Standard ist keine Umgebungsvariable nötig. Die MCP-Fernzugangstür bietet keine `task_*`-Werkzeuge an und nimmt solche Aufrufe nicht an.

In den Einstellungen oder mit `bastra config set tasks.enabled false` ausschalten, alternativ `BASTRA_TASKS=0` im Daemon und in Clients/Hooks setzen. Nach einer Änderung diese Prozesse neu starten. Ein ausdrücklich gesetztes `BASTRA_TASKS` gewinnt: `1` schaltet ein, jeder andere Wert schaltet aus. Zum erneuten Einschalten die Einstellung aktivieren oder `BASTRA_TASKS=1` setzen und neu starten.

Bestehende Aufgabendaten und Zugänge bleiben unangetastet. Ausschalten bricht Aufgaben nicht ab: Beim erneuten Einschalten gilt das bisherige Verhalten einschließlich Nachholen fälliger Arbeit. Der Start-Schnappschuss der Einstellungen liest nur: Eine alte ausdrückliche Abschaltung wird ohne Import der Legacydatei berücksichtigt. Unzugängliche, gelöschte oder fehlerhafte Einstellungen halten Aufgaben ausgeschaltet, bis sie repariert oder ausdrücklich übersteuert werden.

Ausgeschaltet laufen weder Aufgaben-Laufzeit, Polling, Zustellung, Quellenprüfung noch automatische Agent-Einrichtung. Der Aufgabenbereich der Weboberfläche meldet nur, dass Aufgaben ausgeschaltet sind, und `task_*`-MCP-Werkzeuge sind verborgen; Aufgaben-HTTP-Routen einschließlich UI-Sitzungsrouten antworten mit 404 und `feature_disabled`. `bastra tasks …` erklärt nur das Einschalten. `BASTRA_CONVERSATIONAL_REMINDERS=0` ist ein separater, engerer Schalter innerhalb der eingeschalteten Aufgaben und aktiviert Aufgaben nicht.

## Aufgaben im Gespräch

Bitte den Agenten um eine Aufgabe oder Erinnerung: Beauftragte oder bestätigte Aufgaben werden auf jeder Stufe direkt scharf angelegt. Der Agent fragt nur bei fehlendem oder mehrdeutigem Ziel, Datum, Uhrzeit, Zeitzone oder Wiederholung nach; dazu gehört eine mehrdeutige Sommerzeit-Uhrzeit. Bemerkt er selbst eine Frist oder zugesagte Wiedervorlage, trägt er sie ohne Rückfrage ein und bestätigt das in einer Zeile in deiner Sprache, zum Beispiel `→ Erinnerung eingetragen: <was> – <wann>`.

Fällige Karten spricht er am Antwortanfang kurz an. „Erledigt“, „morgen nochmal“ oder „vergiss es“ bedient er für Aufgaben aller Stufen im Gespräch. Herkunft „auf Ansage“ / „vom Agenten bemerkt“, Client, Sitzung und geschwärzter Anlass bleiben sichtbar. Es gibt keine Tages- oder Offen-Obergrenze; gleiche Anlässe zur gleichen Zeit werden zusammengeführt. Technische Speicher-/Zustellbudgets bleiben. `BASTRA_CONVERSATIONAL_REMINDERS=0` schaltet den Gesprächsweg ab; dann wird nur unscharf gespeichert und dies mitgeteilt. Einmalige Arbeitsaufträge erzeugen keine Erinnerung.

Agenten verwalten Aufgaben aller Stufen. Deine Anweisung im Chat gibt auch die beauftragte Ausführung frei; Herkunft user-directed, Programm, Sitzung, Wortlaut und Zeit werden festgehalten. Fehlende oder nicht eingeschriebene Aufgabenbereiche werden dem eingeschriebenen Agentenbereich zugeordnet; Projekte stehen in scope.name. Vorbereiten zeigt die exakte Änderung, bevor der Adapter schreibt.

Bastra merkt sich Aufgaben außerhalb einer Chatsitzung. Der Daemon prüft Fälligkeit automatisch; Karten erscheinen bei einem passenden nächsten Kontakt. Optionale Mac-Mitteilungen melden Fälliges auch ohne Kontakt; ein Agent wird dadurch nicht gestartet. Zustellung ist nur ein Anzeigeversuch. Erst Quittieren bedeutet „gesehen“, Erledigen bedeutet „abgeschlossen“.

## Automatischer Agent-Zugang

Beim Start des lokalen Einzelnutzer-Daemons wird eine eigene private Agent-Kennung für Hooks/MCP angelegt. Bestandsnutzer brauchen nach dem Update keinen Befehl; vorhandene Client-Einstellungen und gültige Zugänge bleiben erhalten. Widerrufene, unsichere oder mehrdeutige Mehrbenutzer-Zugänge werden nicht still ersetzt. `bastra tasks client-status` zeigt den tatsächlichen Zugang. `BASTRA_CONVERSATIONAL_REMINDERS=0` verhindert die automatische Einrichtung und Agent-Scharfschaltung. Der manuelle Owner-Weg bleibt für separate Verwaltung verfügbar.

## CLI-Beispiele und separate Owner-Verwaltung

Gespräch und lokales Brett verwenden den automatischen Agent-Zugang. Die folgende separate Owner-Einrichtung dient der optionalen Verwaltung. Die Befehle gehören zum ausgelieferten `bastra`-CLI. Der Daemon muss laufen. Für einen Test verwende einen eigenen Vault, eigenen Aufgabenpfad und freien Port; die Demo-Anleitung verwendet ausschließlich Wegwerf-Daten.

1. Lege am eigenen Terminal einen Owner-Zugang an:

   ```sh
   mkdir -p ~/.bastra
   bastra tasks auth mint owner ich personal ~/.bastra/owner-task.token
   ```

   Die neue Datei hat private Rechte. Öffne sie in einem lokalen Editor und kopiere den Token. Gib ihn nur in die verborgene Terminal-Abfrage oder die Aufgaben-Seite ein, niemals in einen Chat. Die Datei gehört außerhalb des Zugriffs von Agenten. Der Owner-Zugang darf scharf schalten, quittieren und erledigen; er ist kein Signing-Schlüssel für Dateiänderungen.

Optional: `bastra tasks owner-login` speichert den Zugang privat für die interaktive CLI, damit du den Token nicht bei jedem Befehl eintippen musst. Dieses Verzeichnis muss außerhalb des Zugriffs von Agenten liegen. Die Ablage wird frisch gegen die Registry geprüft und niemals von Hooks/MCP geladen. Dieser Verwaltungszugang ist keine gesonderte Ausführungsfreigabe.

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

   Die Bestätigung nennt Wunsch, Zeitpunkt, Zeitzone, Zustand und scharf/unscharf. Ohne `--arm` bleibt sie unscharf. Agenten können mit `--agent --arm` jede Stufe scharf anlegen. Ein ausdrücklicher Prüfbefehl kann einen Entwurf aktivieren:

   ```sh
   bastra tasks review AUFGABEN_ID
   ```

4. Warte auf die Minute und den nächsten Kontakt oder zeige Fälliges ausdrücklich:

   ```sh
   bastra tasks due
   bastra tasks acknowledge AUFGABEN_ID --occurrence VORKOMMEN_ID
   bastra tasks resolve AUFGABEN_ID
   ```

   Die IDs stehen in der Karte. Eine quittierte Aufgabe bleibt offen und kann selten erneut erscheinen. Der Owner kann Fälliges ausdrücklich ansehen, auch wenn passive Zustellung stumm oder aus ist. `resolve` erledigt eine einmalige Aufgabe oder den ausgewählten/letzten fälligen Termin einer Serie. `end_series` beendet die ganze Serie. `cancel` bricht sie ab; `rearm` legt sie **unscharf** wieder zur Prüfung vor und erneuert keine alten Freigaben.

## Zeit und Wiederholung

```sh
bastra tasks create --goal "Nach sieben Tagen auswerten" --after 7d --timezone Europe/Madrid
bastra tasks create --goal "Täglich prüfen" --when 2026-10-12T18:00 --timezone Europe/Madrid --every 1d --count 3
bastra tasks snooze AUFGABEN_ID --until 18:00
```

`--after 7d` meint sieben verstrichene Tage. `--when` ohne Offset meint Ortszeit in der angegebenen Zeitzone; ohne `--timezone` wird die Maschinenzeitzone sichtbar als Annahme genannt. Tages-/Wochenwiederholungen einer Ortszeit bleiben Kalenderwiederholungen. Wiederholungen dürfen ohne Anzahl und `--end` laufen; beide Angaben begrenzen die Serie auf Wunsch. `catch_up: latest` fasst verpasste Termine zum jüngsten Nachholtermin zusammen. `tasks pause ID` pausiert dauerhaft, `tasks resume ID` setzt fort, `tasks end_series ID` beendet die Serie ausdrücklich. Erledigung gilt für einen Termin; nach dem letzten Termin einer begrenzten Serie wird sie abgeschlossen.

Eine nicht existierende Sommerzeit-Uhrzeit wird abgewiesen. Eine mehrdeutige Herbst-Uhrzeit wählt den früheren Zeitpunkt, bleibt beim CLI-Anlegen unscharf und zeigt den Grund. Der Owner prüft diese Wahl ausdrücklich mit `review`. `snooze --until 18:00` meint die nächste entsprechende Ortszeit; ein vollständiges Datum ist ebenfalls möglich. Agenten dürfen alle Stufen ohne künstliche 24-Stunden-Grenze verschieben. Eine Pause stoppt Quellenprüfung, Zustellung sowie Vorbereitung/Ausführung; alte Ausführungsfreigaben werden dadurch nicht erneuert.

## Überblick und Steuerung

```sh
bastra tasks status
bastra tasks mute
bastra tasks unmute
bastra tasks off
bastra tasks on
bastra tasks stop
```

Status nennt An/Aus, Zustandszahlen, nächste Prüfung, letzte Zustellung, Fehler und Backoff. `mute` verschiebt passive Zustellung. `off` hält automatische Auswertung und Zustellung an. `stop` hält nur Ausführung an; Erinnern/Vorbereiten bleiben nutzbar. Nichts davon erledigt eine Aufgabe. Ausführung ist als sicherer Standard gestoppt. Auf Nutzeranweisung aktiviert der verbundene Agent den registrierten Adapter mit `bastra tasks execution-enable --agent` ohne zweite Bestätigung; dabei werden weder alte Freigaben noch Leases erneuert.

Lebende Reservierungen stehen in `status`. Wenn „bereits reserviert“ erscheint: zuerst Wirkungsstatus/Quittungen prüfen. Nur deine eigene Reservierung kannst du mit `bastra tasks release ID` freigeben; andernfalls ihren Ablauf nach höchstens 30 Sekunden abwarten. Dies macht keine Wirkung rückgängig und erneuert keine Freigabe. Der Browser verhindert Doppelklicks und gibt nach einem fehlgeschlagenen Versuch seine eigene Reservierung frei. Den Vorschlag erneut öffnen und prüfen; keine automatische Wiederholung bei unklarem Ausgang.

`--json` gibt das Maschinenformat aus. Ohne diesen Schalter sind Fragen, Ergebnisse und Fehler lesbare Meldungen in einer Sprache: Deutsch, wenn `language.primary` auf `de` steht, sonst und ohne Einstellung Englisch. Erweiterte Quellen/Evidenz können weiterhin per `--input` übergeben werden.

## Browser und Entscheidung prüfen

```sh
bastra config set ui.enabled true
bastra tasks ui
```

Unter macOS ist die Weboberfläche seit 1.2.0 standardmäßig an; unter Linux und anderen Systemen bleibt sie aus, bis du sie einschaltest (`bastra map` bietet das an, oder der erste Befehl oben). Siehe [Einstellungen](./Settings.md#deutsch). `bastra tasks ui` gibt die Adresse der Weboberfläche aus. Der Aufgabenbereich verbindet sich ohne Token-Eingabe und zeigt Aufgaben, Karten, Quellen und Freigaben. Im Formular **Neue Aufgabe +** ist **Direkt aktivieren** standardmäßig aus; sonst wartet die Aufgabe auf deine Freigabe. Freigeben, Gesehen, Zurückstellen, Erledigen und Abbrechen bleiben getrennte Aktionen. Daten werden als Text dargestellt. Für eine widerlegte tragende Annahme zeigt die Karte alte Entscheidung, geänderte Prämisse, Evidenz und Unsicherheit. Beibehalten, Ändern, Zurückstellen und Überwachung beenden sind eigene Owner-Wahlen. Beibehalten schaltet den historischen Watch ab; weitere Änderungen brauchen eine neue Owner-Bindung.

Vorbereiten zeigt den exakten Vorschlag, schreibt das Ziel aber nicht. Deine Anweisung im Chat ist auch für Ausführen die Freigabe. Vorschau, frischer Zielabgleich, Lease, Absicht und Quittung bleiben erhalten. Das Speichern einer Entscheidung allein schaltet keine Überwachung scharf. Unbekannte, strittige, veraltete oder nicht erreichbare Evidenz widerlegt keine Prämisse. Ändern braucht eine ausdrückliche Nutzerwahl und eine echte CAS-Memoryrevision.

## Ein lokales Ziel registrieren

Der Adapter `local-artifact-v1` ersetzt ausschließlich eine bestehende registrierte, rückgängig machbare UTF-8-Datei mit exakt beauftragten Bytes. Es gibt keine Provider-, Mail-, Slack-, GitHub-, Cloud- oder Shell-Adapter.

```sh
bastra tasks targets register demo --root /ARBEIT/ARTEFAKTE --path artifact.txt --domain personal --agent
bastra tasks targets list --agent
bastra tasks execution-enable --agent
```

Die Zielregistrierung begrenzt den Adapter auf die gewählte vorhandene Datei. Der enge, tatsächlich aufgelöste Arbeitsordner wird angezeigt. Aufgaben-/Vault-/Steuerungs-/Profilpfade, sämtliche .git-Zustände, .husky, .github/workflows, .envrc und .npmrc bleiben gesperrt. Schlüsseleinschreibung und Grenzerklärung sind für die im Chat beauftragte Ausführung nicht erforderlich.

```sh
bastra tasks targets update demo --root /ARBEIT/ARTEFAKTE --path other.txt --domain personal --agent
bastra tasks targets remove demo --agent
```

Eine Registry-Änderung macht alte Zielbindungen ungültig. Vor dem Ausführen gegen den aktuellen Stand vorbereiten. Tabs/CRLF/BOM/Steuerzeichen, unsichere Vorschau-Umwandlungen und Vorzustände mit mehr als 16384 Zeichen werden vor der Ausführung abgewiesen.

## 6 Freigabe im Chat, Ausführen, Rückgängig und unklare Wirkungen

Sage dem verbundenen Agenten, was er tun soll. Die Anweisung selbst ist die Freigabe für die beauftragte Aktion, auch auf Stufe `execute`. Es braucht keine Schlüsseldatei, Unterschrift, Passphrase, `tasks approve`, Touch ID oder zweite Bestätigung. Die stillgelegten Befehle `tasks keys`, `tasks approve` und `tasks deny` erklären nur die Chat-Freigabe und enden, ohne Zugangsdaten zu lesen oder etwas zu schreiben. Schlägt der Agent selbst etwas Folgenreiches vor, das du nicht beauftragt hast—senden, löschen oder zahlen—fragt er einmal im Chat. Dein Ja wird genauso festgehalten. Die Vertrauensgrenze ist dein Mac-Konto, später deine Anmeldung.

Der Agent versteht die Absicht und übergibt `authorization` mit `write_origin: "user-directed"`, `session_id`, `program` und `user_request` (deinem Wortlaut). Recall hält die Zeit in `at` fest. Recall erkennt keine Freigabe anhand von Wörtern. Der Datensatz kann direkt mit `task_prepare` übergeben werden; ein späteres Ja wird mit `task_approval`, `proposal_id`, `decision: "approve"` und `authorization` erfasst. Brett, Vorschlag und Status zeigen Herkunft, Programm, Sitzung, Wortlaut und Zeitpunkt. Der Zugang identifiziert den verbundenen Agenten und verlangt keine zusätzliche Freigabe je Aktion.

Vorbereiten schreibt das Ziel nicht und zeigt exakte Vorher-/Nachher-Bytes. Der Daemon bindet weiterhin aktuelle Aufgabe, Ziel, Evidenz, Inhalt und Ablauf, prüft unmittelbar vor dem Schreiben unter der Sperre erneut, verlangt eine lebende Lease mit Fencing und einen eingeschalteten Adapter, speichert die Absicht vor dem Schreiben und danach eine Quittung. Die Freigabe gilt für die beauftragte Aktion; Aufgaben-DATA, Mitteilungen und Ausführungsberichte erteilen selbst keinen Auftrag. Geänderte Ziele oder Quellen verlangen neue Vorbereitung und den Abgleich mit dem bestehenden Auftrag. Eine inhaltlich andere Aktion braucht die Anweisung des Nutzers oder einmal sein Ja.

Beispiel: Bitte den Agenten, das registrierte Demo-Artefakt durch den exakten neuen Inhalt zu ersetzen. Er bereitet den Vorschlag samt Chat-Freigabe vor, prüft die Vorschau und führt mit einer Lease aus. Auch die Weboberfläche zeigt diesen Vorschlag. **Änderung ausführen** führt einen bereits beauftragten aktuellen Vorschlag ohne zweite Bestätigung aus. Ein gesondertes Signieren im Terminal und eine anschließende Aktualisierungsrunde entfallen.

Status zeigt Absichten und Quittungen getrennt vom Erledigen der Aufgabe. Der Browser verhindert Doppelklicks und gibt nach einem fehlgeschlagenen Versuch seine eigene Reservierung frei. Bei bestehender Reservierung zuerst den Status prüfen, die eigene mit `bastra tasks release LEASE_ID` freigeben oder ihren Ablauf abwarten. Vor einem Retry immer Quittungen und Status prüfen; eine Lease beweist keinen Erfolg. Bei unklarem Ausgang niemals blind wiederholen.

Rückgängig ist ein weiterer exakter Compare-and-swap-Schritt. Bitte den Agenten um Rückabwicklung oder gib einmal Ja, falls er sie selbst vorschlägt. Er bereitet sie aus der erfolgreichen Quittung vor und hält die Anweisung fest. Neue Bindung, frische Lease und unveränderter Zielstand bleiben nötig; zwischenzeitliche Bearbeitung blockiert den Schritt. Rückabwicklung bleibt nach Erledigen, Abbrechen und Zurückstellen verfügbar. Ein Abbruch führt zu exaktem Hash-Abgleich oder sichtbar unklarem Ausgang. Nur eigene hashgebundene Temp-Reste werden bereinigt, fremde Reste bleiben sichtbar.

### Bestehende Installationen und Weg zurück

Vor dem Upgrade den lokalen App-Zustand (`~/.bastra`) unter Erhalt seiner privaten Rechte sichern. Aufgaben-IDs, Verlauf, verbrauchte Wirkungskennungen und Quittungen bleiben erhalten. Die alte Registry `task-approval-keys.json` wird zunächst exakt und privat als `task-approval-keys.json.pre-chat-approval.bak` gesichert, dann in `task-approval-keys.json.legacy` umbenannt. Die neue `task-action-registry.json` übernimmt registrierte Ziele und geschützte Schlüsselordner; alte Schlüsseleinschreibungen und Grenzerklärungen sperren die Ausführung nicht mehr. Aufgaben-Datenbanken und Schlüsseldateien bleiben unverändert; historische Signaturen werden nicht zu neuen Chat-Aufträgen. Offene Arbeit mit der tatsächlichen Nutzeranweisung neu vorbereiten. Sicherung und umbenannte Originale zur Prüfung behalten.

Für den Weg zurück Daemon und Aufgaben-Clients stoppen und den aktualisierten Stand vollständig zusätzlich aufbewahren. Den früheren Code wieder installieren und die gesamte Sicherung vor dem Upgrade einschließlich Aufgaben-Datenbank und Registry zurückspielen. Nur die Registry umzubenennen reicht nicht: Ältere Decoder kennen neu gespeicherte Chat-Freigabefelder nicht. Die `.legacy`- und `.bak`-Originale im zusätzlich aufbewahrten neuen Stand behalten; Chat-Freigaben sind keine alten Signaturen. Nach Neustart Aufgaben-IDs, offene/unklare Wirkungen und Zielinhalte prüfen, bevor erneut ausgeführt wird. Einen älteren Quittungsstand nie zurückspielen und anschließend blind wiederholen: Wirkungen nach dem Sicherungszeitpunkt können bereits eingetreten sein.

Die [Untersuchung zur Schlüsselisolation](Owner%20Approval%20Key%20Isolation.md#deutsch) ist historisch. Der Schlüssel-/OS-Helfer-Ansatz ist durch die Chat-Freigabe überholt und keine Einrichtungsvoraussetzung.

## Budgets, Archiv und Reparatur

Status und Seite nennen pro Aufgabe Prüfintervall, Timeout und Quell-Bytegrenze sowie die globalen Grenzen: höchstens 10 Quellprüfungen und 5 s Quellbudget je Lauf, 60 s Poll, höchstens 1 s pro Quelllesung, 4 MiB aktive Momentaufnahme (Normalbetrieb bis 75 %). Diese Aufgabe-Grenzen gelten sowohl für **Aufnahme der registrierten Quelle** als auch für **Evidenzprüfung**. Die globale Obergrenze pro Quelllesung ist 1 MiB; eine kleinere Aufgaben-Bytegrenze oder ein kleinerer Timeout gilt zusätzlich. Für gemeinsam genutzte Quellen richtet sich die Aufnahme nach dem größten aktuell zugelassenen Verbraucher. Jede Aufgabe prüft danach die tatsächlich gespeicherten Bytes und Laufzeit gegen ihre eigene Grenze: Eine kleine Aufgabe kann nicht von der größeren Erlaubnis einer anderen profitieren.

Bei Memory umfasst die begrenzte Aufnahme auch die eindeutige Suche nach der Datei: Die Bytegrenze gilt für die Summe der dabei gelesenen Markdown-Dateien. Zu kleines Bytebudget meldet `source_budget` / „Quell-Bytegrenze überschritten“, überschrittene Zeit `source_timeout`; die Quelle feuert dann nicht. Das begrenzt die Annahme verspäteter Ergebnisse und verspricht keine atomare Unterbrechbarkeit beliebiger Betriebssystem-I/O.

Unveränderte Fehlquellen gehen bis 1 h in Backoff. Neue angenommene Ereignisse umgehen diesen Backoff; sie werden geordnet beim Kontakt oder nächsten Poll geprüft. Fünf Sekunden sind für kleine gesunde Tests vorgesehen, keine harte Garantie bei blockiertem Dateisystem, Lock-Konkurrenz oder Prozesspause.

```sh
bastra tasks stop
bastra tasks archive ERLEDIGTE_AUFGABEN_ID
bastra tasks archive-restore ARCHIV_ID
```

Archivierung exportiert validierte private History samt Wirkungsbelegen, bevor sie abgeschlossene Datensätze aus dem aktiven Speicher nimmt. Offene Vorkommen, offene/unklare Wirkungen und aktive Leases werden nicht archiviert. Verbrauchte Freigaben, Fencing-Zähler, Journal und Idempotenz bleiben erhalten. Wiederholungen liefern ursprüngliche IDs/Belege; ein fehlendes/verändertes Archiv wird als Fehler behandelt und erlaubt keine Wiederverwendung. `status` nennt die Archive. Wiederaufnahme lädt den Verlauf für Prüfung oder separat freigegebenes Rollback; sie schaltet nichts scharf und hält Ausführung gestoppt. Archive und Backups behalten sensible Inhalte: privat sichern, nicht an Agenten freigeben. Unaufgelöster Rückstau, verbrauchte Freigaben und der Archivindex haben feste Grenzen; Sättigung meldet `capacity`, nichts wird still gelöscht.

Bei beschädigtem Speicher: erst alle Task-Prozesse stoppen, dann `bastra tasks recover`. Der Owner bestätigt, die private letzte Backup-Version wird geprüft und das beschädigte Original gesichert. Aufgaben werden unscharf, Ausführung gestoppt, alte Revisions-/Freigabebindungen ungültig. Der letzte Backup-Stand kann jüngste Änderungen nicht enthalten; das Original bleibt zur Prüfung erhalten. `recover --lock` bietet zusätzlich eine ausdrückliche Offline-Sicherung einer unbekannten liegengebliebenen Sperre; bekannte lebende lokale Besitzer werden nie entfernt. Danach Daemon neu starten und jede Aufgabe neu prüfen. Keine automatische leere Ersatzablage bei Korruption.

Unklare Wirkungen bleiben als „Abgleich nötig“ sichtbar; kein automatischer zweiter Write. Ein unsicher bereinigbarer Temp-Rest wird ausdrücklich genannt. `intent-reconcile --input ...` oder der Abgleichknopf liest den Zielstand und versucht nur eigene hashgebundene Restdateien zu entfernen, auch wenn das Ziel fehlt. Fremde/abweichende Reste werden nicht gelöscht. Die Wegwerf-Demo steht in `docs/design/proactive-tasks-demo.md`.

Zielschutz: `--root` ist ein ausdrücklich gewählter enger Arbeitsordner. Die Rückfrage nennt seinen realen, symlink-aufgelösten Pfad; außerhalb des aktuellen Projektordners erscheint eine Warnung. Aufgaben-/Schlüsselordner, `~/.bastra`, Vault, Agent-/Hook-/Client-/Dienst-Konfiguration und Shell-Profile sind fest gesperrt, ebenso Wurzeln, die solche Orte umfassen. Für vorhandene Ziele: `targets update ID --root DIR --path FILE --domain DOMAIN` oder `targets remove ID`. Beide verlangen Owner-Bestätigung, stoppen Ausführung und machen alte Zielbindungen ungültig; neu vorbereiten und prüfen. Historische Schlüsselordner bleiben als geschützte Orte erhalten.

Recovery meldet stets, dass Änderungen nach dem älteren Backup fehlen können. Private gültige kalte Exporte werden mit dem Backup-Index abgeglichen; ihre History/Idempotenz und verbrauchten Freigaben bleiben erreichbar. Eine nach dem Backup archivierte Aufgabe kann als abgeschlossener aktiver Verlauf zurückkommen und zugleich im Archiv stehen. Das ist keine neue Aufgabe oder Freigabe. Original und Archiv prüfen; nichts wird still gelöscht. Bei lesbarem Original werden Archivindex, verbrauchte Freigaben und Fencing-Maximum zusätzlich vereinigt. Nicht validierbare Archivdateien blockieren die Reparatur und bleiben zur Owner-Prüfung erhalten.

Git-Steuerung (`.git` einschließlich Hooks/config/HEAD/refs), `.husky`, `.github/workflows`, `.envrc` und `.npmrc` sind ebenfalls gesperrt. `package.json` ist als ausdrücklich gewählte Arbeitsdatei zulässig, aber die Rückfrage warnt immer vor später ausführbaren Install-/Test-/Start-Skripten; jede konkrete Änderung braucht weiter exakte Owner-Freigabe.

Recovery-Grenze: Ist das Original unlesbar und das Backup älter als eine jüngste unarchivierte Wirkung, können deren Verbrauchs-ID und Quittung fehlen. Bekannte archivierte/lesbare Verbrauchs-IDs werden vereinigt; neue Epoch und unscharfer/gestoppter Zustand blockieren trotzdem die alte Freigabe. Das ist Replay-Schutz, keine vollständige Rekonstruktion des jüngsten Verlaufs. Original und Ziel prüfen.

## Wegwerf-Demo

Die [20–30-minütige Demo](design/proactive-tasks-demo.md) startet einen eigenen Daemon/Port/Benutzerbereich mit erfundenen Daten. Sie zeigt CLI/Browser-Erinnerung, Zurückstellen, Vorbereiten/Ausführen/Rollback und vorbereitete Entscheidungsdateien. Geerbte Test-/Output-Einstellungen werden neutralisiert; Terminal-Schließen beendet nur den eigenen Daemon und räumt die eigene Ablage auf. Keine echte Mensch-/OS-Grenze oder Langzeitwirkung wird daraus abgeleitet.

Siehe [14-Fälle-Matrix](design/proactive-tasks-matrix.md) und [englische Anleitung](Proactive%20Tasks.md). Menschliches Verständnis, Unterbrechungskosten und Langzeitnutzen bleiben gesondert zu prüfen.

## Aufgabenbereich und Browser-Zugang

Seit 1.2.0 hat die Weboberfläche (UI v2) einen Bereich **Aufgaben**:

- **Kopfzeile:** Statuskacheln (Funktion, Automatik, Fällig, Freigabe offen, Ausführung), **Berichte**, **Fällig** und **Neue Aufgabe +**.
- **Kalender:** Die Ansicht **Ledger** zeigt eine Woche oder einen Monat. Eine Aufgabe ziehen verschiebt sie, ein Doppelklick legt eine an. Aufgaben ohne Termin liegen in einer eigenen Ablage **Ohne Termin**. Eine zuschaltbare Agenda-Leiste listet die Tage neben dem Kalender.
- **Fällig** öffnet die fälligen Karten. **Als gesehen markieren** heißt gesehen, noch offen; **Details →** öffnet die Aufgabe.
- **Neue Aufgabe +** öffnet ein Formular: Ziel, Auslöser (Zeitspanne oder Ortszeit), Zeitzone, Bereich, Stufe, Wiederholung und Anzahl, optionale Gültigkeit, worauf sie wartet, wer zuständig ist (du oder Recall), Herkunft und eine Agent-Notiz. Du kannst es auch einfach deinem Agenten sagen.
- **Rechte Spalte mit drei Reitern.** **Details** zeigt die gewählte Aufgabe: Status, Herkunft, Fälligkeit und nächste Prüfung, Freigabe (wer es wann in welchem Programm und welcher Sitzung verlangt hat), Stufe, Wiederholung, Gültigkeit, letzte Zustellung und Fehlergrund. Ihre Knöpfe geben frei oder schicken zurück zur Prüfung, pausieren oder setzen fort, beenden eine Serie, stellen zurück, erledigen, brechen ab, bearbeiten, ändern die Gültigkeit, übernehmen oder geben an Recall, bereiten vor, löschen, gleichen ab (nur lesen) und bereiten eine Rückabwicklung vor. **Ansicht** wählt den Kalenderstil: Ledger ist der Standard; Flow, Stream und Relay gehören zu Recall Pulse und zeigen nur den Hinweis „bald verfügbar“. **Steuerung** zeigt und schaltet Funktion, hörbare Zustellung und Ausführung und listet Budgets und Speicher, abzugleichende Wirkungen, Quellen, Adapter und Freigaben sowie das Archiv.
- **Berichte** schaltet die Hauptfläche auf die Aufgabenberichte um (siehe [Aufgabenberichte](#aufgabenberichte)).

Ein unklarer Ausführungsausgang heißt: Der Zielstand muss abgeglichen werden. Nicht erreichbare Quellen werden als derzeit nicht erreichbar bezeichnet, solange eine erneute Prüfung vorgesehen ist; dies ist keine Behauptung eines endgültigen Ausfalls. Unter **Steuerung › Archiv** lässt sich ein kaltes Archiv lesend laden; seine Aufgaben sind als nicht mehr überwacht gekennzeichnet.

Bei der lokalen Einzelnutzer-Installation öffnet der Aufgabenbereich eine Browser-Session mit **Agent-Rechten** ohne Token-Eingabe (private SameSite/HttpOnly-Session-Cookie und CSRF-Prüfung). Die Session gilt für die Laufzeit des Daemons und wird beim Neuladen wiederverwendet. Host, Origin und aktivierte UI bleiben Pflicht. Unter macOS muss der Aufrufer außerdem ein Programm des macOS-Kontos sein, dem der Vault gehört (#1419). Keine Owner-Kennung wird ausgegeben; Widerruf wird bei jedem Aufruf geprüft. Die Weboberfläche hat keine Token-Eingabe, keinen Owner-Zugang und keinen Abmelden-Knopf; getrennte Owner-Verwaltung bleibt in der CLI (`bastra tasks owner-login`). Die Nutzeranweisung oder das Ja im Chat gibt die beauftragte Ausführung frei. Die normale REST-API verlangt weiter ihre gemappte Kennung und akzeptiert diese Cookie nicht. Ein Daemon-Neustart verwirft Browser-Sessions; die Seite verbindet sich erneut, ohne Schreibaktionen zu wiederholen. Braucht ein neuer Browser an der Grenze von 100 Sitzungen einen Platz, weicht die am längsten ungenutzte Sitzung, aber nur, wenn sie seit mindestens 10 Minuten ungenutzt ist. Das ist eine Bereinigung bei Platzbedarf, kein automatischer Ablauf: Ein offener Aufgabenbereich hält seine Sitzung in Benutzung; ohne Platzbedarf funktioniert auch ein altes Cookie weiter. Wurden alle Plätze innerhalb dieser 10 Minuten genutzt, erhält ein neuer Browser `capacity`, statt diese Sitzungen zu verdrängen. Fehlgeschlagene Host-, Origin-, CSRF- oder Zugangsprüfungen halten eine Sitzung nicht am Leben.

Die Browser-Agentensitzung verwaltet Aufgaben aller Stufen einschließlich Aktivieren und Erledigen. Die Anweisung oder das Ja des Nutzers im Chat ist die Freigabe für die beauftragte Ausführung; exakte Vorschau, Zielabgleich und Quittung bleiben erhalten.
Hinweis zum lokalen Zugang: Jedes Programm unter derselben OS-Benutzerkennung kann den privaten Agent-Zugang lesen und benutzen. Eine einzelne Owner-Identität gibt dem automatischen Agenten ihre zugewiesenen Domänen, wie beim bisherigen setup-hooks, damit vorhandene Projekterinnerungen erreichbar bleiben. Dadurch entsteht keine erfundene Nutzeranweisung. Mehrere Owner brauchen ausdrückliche Einrichtung. Beschädigte, zu offene oder widerrufene Dateien werden sichtbar in normalem Status, Doctor und einmal beim Daemon-Start gemeldet; Karten bleiben bis zur Owner-Reparatur stumm. Fehlt eine automatisch erzeugte Datei, werden beim Ersatz die alten automatisch verwalteten Kennungen widerrufen.

Ein beschädigter, zu offener oder widerrufener beim Start erkannter Erinnerungszugang wird zusätzlich einmal pro Sitzung in Hook/MCP benannt. Dieser Hinweis enthält keine privaten Aufgaben und quittiert nichts.

**Grenze der tokenlosen Browser-Sitzung:** Unter macOS erhalten nur Programme des macOS-Kontos, dem der Vault gehört, eine Agent-Sitzung (#1419). Jedes Programm dieses Kontos kann das, auch ein lokaler Proxy/Tunnel, der Host/Origin auf localhost umschreibt oder entfernt. Auf anderen Systemen kann bei aktivierter UI jeder lokale Prozess eine Agent-Sitzung erhalten, auch unter einer anderen Benutzerkennung desselben Rechners und ohne Zugriff auf die Zugangsdatei; Loopback beweist dort keine OS-Benutzeridentität. Auf Mehrbenutzer-Rechnern ohne diese Kontoprüfung `ui.enabled` ausschalten. Weitere Arbeit an dieser Grenze steht in [Issue #1198](https://github.com/n0mad-ai/bastra-recall/issues/1198). Dies ist eine bekannte Grenze des lokalen Zugangs; die Chat-Freigabe wird dem verbundenen Agenten zugeschrieben und ist kein kryptografischer Nachweis der menschlichen Identität.
Gleiche tatsächliche Anfrage zur gleichen Zeit wird auch nach notwendiger Schwärzung als Dublette erkannt. Unterschiedliche Inhalte bleiben getrennt. Interne Kontext-Zusammenstellungen zählen keine Karten-Zustellung; die SessionStart-Ausgabe zeigt die fällige Karte und zählt ihren Anzeigeversuch am Ausgang.
Der Dublettenvergleich ist jetzt an einen privaten lokalen Schlüssel dieses Aufgabenspeichers gebunden. Weder Schlüssel noch Vergleichswert erscheinen in Karten, API/Status oder Aufgaben-Exporten. Alte ungesalzene Vergleichswerte werden aus gültigen Task-Dateien, Backups und verwalteten Archiven entfernt. Bereits geschwärzte Geheimnisse werden nicht zurückgewonnen. Nicht mehr prüfbare alte Anfrage-Retries werden abgewiesen; verwende die vorhandene Aufgaben-ID. Der Schlüssel bleibt lokal; bei Verlust wird er nicht still ersetzt. Voller Dateizugriff unter derselben Benutzerkennung bleibt eine bekannte Grenze. Auch Ereignis-Baselines, Ereignis-/Claimwerte und Material-/Retry-Vergleiche verwenden diesen Schlüssel. Ein Rohwert oder sein kleingeschriebener SHA-256 als expected ergibt denselben privaten Vergleich; der gelieferte Digest bleibt nicht als Anzeigetext gespeichert, auch bei content-version an einer allgemeinen Ereignisquelle. Nur registrierte Datei-/Git-/Memory-Quellen zeigen tatsächliche Versionskennungen. Die Migration bindet vorhandene Inhaltsdigests an den Schlüssel, ohne geschwärzte Geheimnisse zurückzugewinnen. API-Antworten, Karten und kalte Exporte enthalten keine Vergleichsfelder. Git-OIDs, Datei-/Memory-Versionen und exakte Ausführungs-Byte-Digests bleiben Versions-/Integritätsdaten. Proposals vor dem Upgrade werden vorsorglich stale/veraltet und brauchen neue Vorbereitung sowie neue Freigaben nach den bestehenden Regeln. Ihre alten Aufgaben-/Challenge-/Approval-Bindungen und Signaturen werden aus Hauptdatei, Backup und verwalteten Archiven entfernt; Status zeigt stale. IDs, Verbrauch und Receipts bleiben erhalten, einschließlich exakter Ausführungs-Retries und neu freigegebenem Rollback. Freigaberechte ändern sich nicht. Bereits kopierte Antworten, Signaturen oder Exporte lassen sich nicht zurückrufen. Ursprüngliche Proposal-IDs bleiben zur Audit-/Retry-Zuordnung erhalten; mit genügend ursprünglichen Signiermetadaten können sie historische Vermutungen weiter prüfen. Stale-Antworten und kalte Exporte liefern den alten Signierkörper nicht mehr. Zurückgeholte terminale Archive enthalten keinen Vergleichsnachweis und brauchen vor einer Wiederverwendung eine neue ausdrücklich geprüfte Baseline.

## Aufgabenberichte

Agenten legen ihren Abschlussbericht nach größerer oder autonomer Arbeit in Recall ab, statt ihn als langen Text in den Chat zu schreiben: `task_report_save` mit einzeiligem `title`, `body` in Markdown (beliebig lang bis zur Anfragegrenze, nie gekürzt), optional `project` und `origin` `{client, session}`. Vor dem Speichern bereinigt Recall den Text: Vollständige eingeschleuste Kontextblöcke (Hook- und Harness-Blöcke) werden entfernt, Geheimnisse durch Schwärzungsplatzhalter ersetzt und Steuer- sowie unsichtbare Formatzeichen außer Zeilenumbruch und Tabulator entfernt – das CR in CRLF-Zeilenenden und die Nullbreiten-Verbinder in zusammengesetzten Emojis verschwinden. Titel, Projekt und Herkunft werden genauso bereinigt. Akteur, Domänen und Zeitpunkt setzt der Server; ein Bericht hängt an keiner Aufgabe und gibt keine Ausführungsrechte. In der Recall-Oberfläche haben Berichte einen eigenen Eintrag **Berichte** in der linken Leiste (und die Adresse `#reports`); die Berichtsansicht nennt ungelesene und Gesamtzahl. Berichte stehen für sich: Die Ansicht zeigt nur ihren eigenen Kopf (Titel, Projektauswahl, Suche, Zahlen), ohne Titel, Statuskacheln, **Fällig** und **Neue Aufgabe** der Aufgaben, und die Brotkrume oben heißt **Berichte**. Sie ist wie der Memory-Browser aufgebaut: links die Liste (ungelesene oben), rechts der gewählte Bericht über die ganze Breite. Beim Öffnen ist der erste ungelesene Bericht gewählt, sonst der neueste. Die Ansicht ist ein eigener Bereich: Es gibt keinen ESC-Knopf, und die Esc-Taste schließt dort nur, was offen ist (ein Anmerkungsfeld, die Projektauswahl, eine Suche im Suchfeld); in andere Bereiche führt die linke Leiste. Der Kopf des Berichts hat einen Schalter für die Schriftgröße in drei Stufen (klein ist die bisherige Größe, mittel der Standard, groß); er wirkt nur auf den Berichtstext, und der Browser merkt sich die Wahl. Hat der Bericht Fragen, nennt die Metazeile im Kopf, wie viele beantwortet sind. Die rechte Seitenleiste – offen oder geschlossen, wie du sie in irgendeinem Bereich eingestellt hast – zeigt in der Berichtsansicht die Sprungliste des Berichts: seine Überschriften, darunter den Block **Fragen** mit dem Stand jeder Frage (leeres Quadrat, solange offen; Amber, sobald beantwortet) und dem Zähler; ein Klick springt zur Stelle, und die Stelle, an der du gerade liest, ist markiert. Das Öffnen ändert den Gelesen-Zustand nicht: **Gelesen** markiert einen Bericht als gelesen, **Ungelesen** stellt ihn wieder zurück, **Löschen** entfernt ihn. Direkt nach **Löschen** bietet ein Hinweis über dem nächsten Bericht **Rückgängig** an, solange dieser Bericht zu sehen ist. Darüber hinaus bleibt der gelöschte Bericht für die ganze Rückgängig-Frist in der Liste, auch wenn du andere Berichte öffnest: durchgestrichen, mit herunterzählender Restzeit und **Wiederherstellen**. Die Frist ist die Einstellung `tasks.reportUndo` (Standard 10 Minuten; Minuten, Stunden oder Tage bis 30 Tage, oder `off`: dann ist ein gelöschter Bericht sofort weg). **Rückgängig** und **Wiederherstellen** holen den Bericht mit Text, Gelesen-Zustand und Anmerkungen zurück. Die Kopfzeile der Ansicht trägt wie im Memory-Browser eine Projektauswahl (alle Projekte oder eines) und ein Suchfeld; beide grenzen die Liste gemeinsam ein. Die Suche filtert beim Tippen nach Titel und Projekt und, sobald Recall antwortet, auch nach dem Berichtstext; jedes Wort muss vorkommen, Groß- und Kleinschreibung und Unicode-Form spielen keine Rolle. Ein Bericht mit offenen Anmerkungen von dir steht in der Liste als **In Bearbeitung** statt **Neu**, und seine Zeile nimmt das Amber der Anmerkungen an. Ist die Berichtsablage voll, sagen Markieren, Anmerkungen und Übergabe das und dass das Löschen alter Berichte Platz schafft. Die linke Leiste hat direkt unter **Aufgaben** einen eigenen Eintrag **Berichte**, gebaut wie jeder andere Eintrag: Er öffnet die Berichtsansicht und leuchtet, solange sie offen ist (beim Kalender leuchtet **Aufgaben**), seine türkise Plakette zählt die ungelesenen Berichte, und sein Tooltip nennt ungelesene Berichte und Berichte mit noch nicht übergebenen Anmerkungen. Der Kopfleisten-Ticker führt ungelesene Berichte vor den fälligen Aufgaben auf, und das Dashboard-Widget **Berichte** listet die neuesten; ein Klick öffnet jeweils die Berichtsansicht mit diesem Bericht. Sichtbar ist ein Bericht nach denselben Domänenregeln wie Aufgaben. Höchstens 200 Berichte werden gehalten; darüber wird ein neuer Bericht abgewiesen (`capacity`), nichts wird still verworfen. `task_report_list` (optional `query`, höchstens 200 Zeichen: nur Berichte, deren Titel, Projekt oder Text jedes Wort enthält), `task_report_read`, `task_report_mark` (`{id, read}`, idempotent), `task_report_delete` und `task_report_restore` ergänzen das Werkzeug; `task_report_read` liest nur und markiert nichts, auch nicht, wenn ein Agent den Bericht liest. `task_report_delete` antwortet mit `restorable_until` (fehlt, wenn Rückgängig abgeschaltet ist); bis dahin holt `task_report_restore` (`{id}`) den Bericht unverändert zurück, mit denselben Domänenregeln und innerhalb der Grenze von 200 Berichten (sonst `capacity`). Danach, oder sobald 20 neuere Löschungen folgten, ist der Bericht endgültig weg, und ein Wiederherstellen antwortet `not_found`. Eine geänderte `tasks.reportUndo` gilt auch für frühere Löschungen. Für die eigene Sitzung der Oberfläche liefert `task_report_list` ohne `query` zusätzlich die noch rückgängig machbaren Löschungen als `deleted` (Listenzeilen mit `deleted_at` und `restorable_until`, nie der Text); die Liste eines Agenten bleibt unverändert.

Ist im Papierkorb kein Platz für einen weiteren Bericht, meldet das Löschen `capacity` und der Bericht bleibt in der Liste. Bestehende Rückgängig-Einträge bleiben erhalten. Du kannst es erneut versuchen, sobald ein älteres Rückgängig-Fenster abläuft.

### Anmerkungen in einem Bericht

Beim Lesen kann der Nutzer an einer einzelnen Stelle eines Berichts eine Anmerkung hinterlegen: an einer Überschrift, einem Absatz, einem Listenpunkt oder einer Tabellenzeile. Beim Überfahren oder Fokussieren hebt sich die Stelle ab (nur farblich, kein Text verschiebt sich), und der Knopf **Anmerken** erscheint in Amber; er öffnet ein Feld mit **Anmerkung speichern**, **Abbrechen** und **Text verbessern** (dieselbe Überarbeitung durch das lokale Modell wie im Vault-Pflege-Feld des Memory-Browsers, mit **Rückgängig**; ohne lokales Modell erscheint dieselbe Meldung und der Text bleibt). Gespeicherte Anmerkungen stehen direkt unter ihrer Stelle in einer Amber-Karte und bieten **Bearbeiten** und **Löschen**. Eine neue Anmerkung ist ein **Entwurf**: Sie bleibt bei dir, kein Agent sieht sie. **An Agenten übergeben** im Kopf des Berichts – sichtbar, solange der Bericht Entwürfe hat, mit ihrer Zahl, als Hauptaktion des Kopfs – übergibt alle Entwürfe dieses Berichts auf einmal; eine kurze Meldung bestätigt das, weiter wird nichts gefragt. Jede Anmerkung zeigt ihren Zustand: **Entwurf** (gedämpft, gestrichelter Rahmen), **Übergeben · offen** (Amber) oder **Erledigt** (Grün, mit der Antwort des Agenten darunter); eine Stelle, deren Anmerkungen alle erledigt sind, wird grün. Berichtsliste und Berichtskopf zeigen Entwürfe, die noch bei dir liegen (✎), und übergebene offene Anmerkungen (➜) getrennt; in der Liste sind beide Zahlen amber. Anlegen, Bearbeiten oder Löschen einer Anmerkung ändert den Gelesen-Zustand des Berichts nie. Eine Anmerkung, deren Stelle im gerenderten Bericht nicht mehr gefunden wird, steht am Ende des Berichts und geht nicht verloren.

Jede Anmerkung speichert ihren Anker – die Art des Blocks (`heading`, `paragraph`, `item`, `row`), seine laufende Nummer (ab 1) unter den anmerkbaren Blöcken des gerenderten Berichts und einen kurzen Textauszug, damit ein Agent die Stelle ohne Oberfläche findet –, den Text des Nutzers (höchstens 4.000 Zeichen, bereinigt wie der Berichtstext), den Zeitpunkt und den Zustand `open` oder `done`, den Zeitpunkt der Übergabe (`handed_at`; ohne ihn ist die Anmerkung ein Entwurf, auch Anmerkungen von vor der Übergabe gelten als Entwurf) sowie die optionale Antwort des Agenten (höchstens 1.000 Zeichen). Anmerkungen gehören zum Datensatz ihres Berichts: Sie folgen seinen Domänenregeln und verschwinden mit ihm, wenn der Bericht gelöscht wird. `task_report_read` liefert sie als `notes`, `task_report_list` zählt offene als `notes_open`. Für einen Agenten enthalten beide nur übergebene und erledigte Anmerkungen – ein Entwurf erscheint weder im Text noch in einer Zahl, und `task_report_note_done` auf einen Entwurf wird abgelehnt (`not_found`). Die Oberfläche sieht jede Anmerkung und bekommt die Entwürfe zusätzlich als `notes_draft` gezählt. Die Oberfläche nutzt `task_report_note_add` (`{id, anchor, text}`), `task_report_note_edit` (`{id, note_id, text}`; eine bearbeitete Anmerkung ist wieder offen, wieder ein Entwurf und verliert eine frühere Antwort), `task_report_note_delete` (`{id, note_id}`) und `task_report_notes_hand` (`{id}`; übergibt alle Entwürfe des Berichts und nennt ihre Zahl als `handed`). Diese vier laufen nur über die eigene Sitzung der Oberfläche (`/ui/tasks/api/…`, nur lokal, mit Cookie und CSRF-Token): Sie sind kein Agenten-Werkzeug, und ein MCP-Aufruf sowie `/api/v1/…` lehnen sie mit `forbidden` (HTTP 403) ab, auch mit demselben Zugang. Der Text einer Anmerkung stammt damit immer vom Nutzer; kein Agent – und kein Text, den ein Agent irgendwo gelesen hat – kann eine Anweisung in seinem Namen hinterlegen. Ein Agent schließt eine Anmerkung mit `task_report_note_done` (`{id, note_id, reply?}`).

### Fragen mit Antwortvorgaben

Ein Agent kann dem Nutzer in einem Bericht eine Frage stellen und Antworten vorgeben. Die Frage ist ein Listenpunkt oder ein Absatz, der mit den Vorgaben in fester Schreibweise endet: `[?`, die Vorgaben durch `|` getrennt, dann `]`.

```markdown
- Den Kompatibilitätshinweis für alte Befehle behalten? Er kostet nichts und hilft alten Skripten; ich empfehle A. [? A – Behalten | B – Entfernen]
- 1.3.0 heute veröffentlichen? [? Ja | Nein]
```

Zuerst steht der Bericht selbst, danach, abgesetzt unter einer eigenen Überschrift, die Fragen an den Nutzer. Jede Frage ist für sich verständlich: worum es geht und wie es heute ist, in einfachen Worten, und die Empfehlung im Text. Ohne Oberfläche bleibt die Zeile so lesbar, wie sie ist. Die Schreibweise ist in jeder Sprache gleich; Recall wertet nie Wörter aus (`[? Yes | No]` wirkt wie `[? Ja | Nein]`). Erlaubt sind 2 bis 6 verschiedene Vorgaben mit je höchstens 40 Zeichen, und die Markierung muss die Zeile beenden. Eine Vorgabe ist die Beschriftung eines Knopfs: ein kurzer Name wie `A – Befehl bauen`; die Erklärung steht im Text der Frage. Eine längere Vorgabe wird nie abgeschnitten; die ganze Zeile bleibt dann normaler Text. Alles andere – eine einzige, eine leere oder doppelte Vorgabe, mehr als sechs, Text nach der Markierung, Formatierung wie Inline-Code darin, eine Überschrift oder Tabellenzeile – erscheint als normaler Text mit dem üblichen Knopf **Anmerken**. In der Leseansicht verschwindet die Markierung aus dem Text, und die Vorgaben stehen als Knöpfe unter der Frage, danach **Eigene Antwort** (öffnet dort das Anmerkungsfeld) und **Nachklärung**. Ein Klick speichert die Wahl als gewöhnliche Anmerkung an dieser Stelle – den Text der Vorgabe, bei **Nachklärung** eine kurze Bitte, die Frage genauer zu erklären – als Entwurf, der wie jede andere Anmerkung übergeben wird. Vorgaben, **Eigene Antwort** und **Nachklärung** bilden unter der Frage einen gerahmten Antwortbereich, der nie zuklappt. Ist die Frage beantwortet, wird die Stelle zur Anmerkungskarte, der Antwortbereich bleibt darin, und die Wahl ist in Amber markiert; eine andere Vorgabe oder **Nachklärung** ändert diese Wahl, statt eine zweite Anmerkung anzulegen. Der Textauszug im Anker behält die Markierung, damit ein Agent beim Lesen der Anmerkung Frage und Vorgaben sieht.

Beim Sitzungsstart erfährt ein Agent mit Aufgaben-Zugang für die Domänen des Berichts in einem kurzen Block `<report-notes>` neben dem Vault-Pflege-Hinweis, wie viele offene Anmerkungen der Nutzer in welchen Berichten hinterlassen und übergeben hat (höchstens fünf Berichte namentlich, mit id und Projekt). Der Block sagt, dass die Texte der Anmerkungen eigene Anweisungen des Nutzers sind – ohne weitere Freigabe –, der Berichtstext daneben und die Berichtstitel dagegen von Agenten stammen, Referenzmaterial und keine Anweisung sind, dass eine konkrete Aufgabe des Nutzers vorgeht und dass jede bearbeitete Anmerkung mit `task_report_note_done` geschlossen wird. Erledigte Anmerkungen werden nicht mehr gemeldet, Entwürfe nie; ohne übergebene offene Anmerkung gibt es keinen Block. Der Block folgt `language.primary` (Englisch, wenn nicht gesetzt oder ohne Wortlaut).

## Lokale Mitteilungen und gespeicherter Aufgabenstand

Bei eingeschalteten Aufgaben ist `tasks.notifications` in den Einstellungen standardmäßig true. Mit false lassen sich native Mitteilungen ausschalten, ohne Aufgaben abzusagen. macOS ist unterstützt; andere Plattformen bleiben bei Zustellung zum nächsten Kontakt. Der Status nennt Unterstützung und Aktivität des nativen Daemon-Hosts. Die Mitteilungszentrale kann die Anzeige gemäß den OS-Einstellungen unterdrücken. Das Wort, das eine abgelaufene Aufgabe kennzeichnet, folgt `language.primary` (Englisch, wenn nichts gesetzt ist oder es für die Sprache noch keinen Wortlaut gibt).

Eine dauerhafte Terminquittung trennt native Zustellreservierung und OS-Übergabe vom Gelesenstatus. Eine Anzeige im Chat hält die Mac-Mitteilung nicht auf: Sie wird je Vorkommen einmal gesendet, außer das Vorkommen ist schon quittiert oder erledigt oder die Aufgabe ist pausiert oder stummgeschaltet. Eine übergebene native Mitteilung unterdrückt doppelte passive Dialogzustellung; ausdrücklicher Abruf und Brett zeigen weiter ungelesene Arbeit und `already_notified`. Ein eindeutiger OS-Fehler kann nach dem Wiederholungsintervall erneut versucht werden. Bei Timeout oder Absturz mit unklarem Übergabeergebnis bleibt die Reservierung erhalten, um eine mögliche Doppelmeldung zu vermeiden; menschliches Lesen wird nicht behauptet. Das Brett bleibt zur Prüfung verfügbar.

Aufgaben-Schnappschüsse v4 migrieren v1–v3 beim Lesen ohne Änderung von Aufgaben-IDs, Revisionen oder Verlauf. Bytes und Integritätshashes vorhandener Kaltarchive bleiben unverändert; ihre Schnappschüsse werden über denselben Decoder gelesen. Vor dem Upgrade lokalen App-Zustand sichern; Wiederherstellung bleibt ausdrücklich. Aktive Aufgaben lassen sich mit `bastra tasks delete ID --agent` oder `task_delete` mit `expected_revision` löschen; laufende oder unklare Ausführung muss vorher abgeglichen werden. Kalt archivierte Aufgaben verwenden denselben Aufruf mit ausdrücklicher `archive_id` und der Revision aus `task_list {archive_id}`; CLI: `bastra tasks delete ID --archive ARCHIV_ID --agent`. Das Löschen ist logisch: Der ursprüngliche hashgeprüfte private Export bleibt als Sicherung erhalten. Die gewählte Aufgabe verschwindet aus der Archivansicht und lässt sich weder wiederherstellen noch mit dem alten Idempotenzschlüssel neu anlegen. Andere Aufgaben im Bündel, verbrauchte Freigaben und Ausführungszähler bleiben erhalten. Derselbe Löschaufruf kann sicher wiederholt werden. Eine bereits wiederhergestellte aktive Kopie muss vor ihren Archivkopien gelöscht werden.

## Optionaler Ablauf und Erledigung durch Evidenz

`expires_at` ist ein optionales Gültigkeitsende als UTC-Epochenmillisekunden, getrennt von Fälligkeit und Wiederholungsende `until`. Dann wird eine offene Aufgabe `expired`, auch während Pause oder Zurückstellung. Sie wird unscharf und erhält eine dauerhafte Ablaufmeldung; das ist keine behauptete Erledigung. Ohne `expires_at` bleibt Fälliges offen, bis es ausdrücklich erledigt wird oder eine ausdrücklich eingerichtete Evidenzregel den Abschluss prüft.

Beim Anlegen `--expires` verwenden, mit `bastra tasks edit ID --expires 2026-12-01T18:00:00Z` ändern oder mit `--expires none` entfernen. Das Brett bietet dasselbe optionale Gültigkeitsfeld. MCP-/HTTP-Änderungen entfernen es mit `patch: {"expires_at": null}`. Eine abgelaufene Aufgabe braucht nach Änderung der Gültigkeit ausdrückliches rearm und review; Bearbeiten allein belebt beendete Aufgaben nie wieder. Vor dem Archivieren einer abgelaufenen Aufgabe deren Ablaufmeldung quittieren.

Für eine einmalige Aufgabe mit nichtleerer registrierter `evidence` lässt sich `auto_resolve: {"verifier_id":"bound-evidence-v1"}` ausdrücklich aktivieren. Der vorhandene begrenzte Verifier muss die exakten registrierten Revisionen/Hashes, zurechenbare Evidenz und erlaubtes Zustandsalter frisch prüfen. Nur `verified` erledigt die Aufgabe; veraltete, fehlende, geänderte, zukünftige oder strittige Evidenz genügt nicht. `resolution_condition` bleibt Beschreibung und wird nie als Code oder Textbefehl ausgewertet. Serien dürfen diese Regel nicht wiederverwenden, weil Evidenz je Termin neu gebunden werden müsste. `auto_resolve: null` entfernt die Regel beim Bearbeiten.

## Lokale App-Anbindung

Die [lokale Aufgaben-App-Schnittstelle](Local%20Task%20App%20API.md#deutsch) beschreibt SSE-Strom, ausdrückliche Lesebestätigung, Abruf von Ausführungsergebnissen und zugeordnete Ausführerberichte. Der erzeugte [OpenAPI-Vertrag](openapi.yaml) legt lokale Routen fest. Jede erneute Verbindung gleicht aktuellen dauerhaften Zustand ab; der Strom ist kein historisches Replay-Journal. Fernzugriff, Gerätekopplung, Handy-Push, Provider-Aktionen und Agentenstarter sind nicht enthalten. Allgemeine Frische außerhalb der Aufgaben bleibt außerhalb dieses Aufgabenvertrags.


Lokale Zustandsquellen für Projekte, Worktrees, Aufgabenphasen, Symbole und Metadaten beschreibt [Lokale Aufgaben-Zustandsadapter](Local%20Task%20State%20Adapters.md#deutsch).
