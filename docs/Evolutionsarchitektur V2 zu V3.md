# Bastra Recall – Evolutionsarchitektur V2 → V3

> **Status:** Planung. Nichts davon ist gebaut oder freigegeben.
> **Stand:** 17. September 2026.
> **Quelle:** der V3.0-Plan in [#401](https://github.com/n0mad-ai/bastra-recall/issues/401)
> mit den Schritten [#402](https://github.com/n0mad-ai/bastra-recall/issues/402)–[#410](https://github.com/n0mad-ai/bastra-recall/issues/410),
> dem Nachtrag [#450](https://github.com/n0mad-ai/bastra-recall/issues/450) und
> Milestone „V3.0 — Anticipatory, causal and shared memory“.
> Weichen Issue und Dokument voneinander ab, gilt das Issue; das Dokument wird
> dann nachgezogen.
>
> **Sprachfassungen.** Diese deutsche Fassung ist das Original.
> [`Evolution Architecture V2 to V3.md`](./Evolution%20Architecture%20V2%20to%20V3.md)
> ist die Übersetzung.
>
> **Vorgänger:** [`Evolutionsarchitektur V1 zu V2.md`](./Evolutionsarchitektur%20V1%20zu%20V2.md).
> V3 baut auf dessen Verträgen auf und ersetzt keinen davon.

## 1. Worum es geht

V2 beantwortet die Frage: **Welche Erinnerung ist jetzt relevant?**

V3 beantwortet: **Was muss wann wieder auftauchen, wer muss es wissen, was darf
als Nächstes passieren – und hat es tatsächlich geholfen?**

Das Ziel ist kein autonomes Handeln um seiner selbst willen. Ziel ist ein
Gedächtnis, das zukünftige Zusagen einhält, den Nutzen seiner Eingriffe belegt
und ausdrücklich geteiltes Wissen koordiniert, ohne dass jemand die Kontrolle
über das eigene Gedächtnis verliert.

Dafür kommen sieben Bausteine hinzu:

1. **Prospektives Gedächtnis** – Zusagen und Fristen („erinnere mich, wenn X“).
2. **Deterministische Event- und Trigger-Engine** – erkennt verlässlich, wann
   eine Bedingung eintritt.
3. **Berechtigungsgebundene Handlungen** – benachrichtigen, vorbereiten und nur
   mit ausdrücklicher Berechtigung ausführen.
4. **Kausales Outcome-Gedächtnis** – unterscheidet „kam zusammen vor“ von „hat
   nachweislich geholfen“.
5. **Geprüfte Workflow-Synthese** – aus wiederholt erfolgreichen Abläufen werden
   Vorschläge für wiederverwendbare Abläufe, nie ungeprüfte Automatik.
6. **Föderiertes Gedächtnis** – persönlich, Projekt und Team über mehrere Geräte
   und Personen.
7. **Multi-Agent-Koordination** – mehrere Assistenten teilen Gedächtnis, ohne
   sich gegenseitig zu verstärken oder doppelt zu arbeiten.

## 2. Nicht verhandelbar

- Die Verträge aus V2.0 zu Herkunft, Enthaltung (`no_answer`), Review und
  Rollback bleiben das Fundament.
- Vorhersagen und geplante Handlungen werden nicht dadurch zu Fakten, dass sie
  erzeugt wurden.
- Gelernte Workflows können sich keine Berechtigungen erteilen.
- Persönliches Gedächtnis wird nie still durch geteiltes Gedächtnis
  überschrieben.
- Externe Wirkungen (Side Effects) brauchen eine ausdrückliche Berechtigung und
  eine Bestätigung.
- Sync-Konflikte bleiben sichtbar und werden nie allein nach dem jüngsten
  Zeitstempel entschieden.
- V3.0 ist erst fertig, wenn Vorausschau, kausales Lernen, Föderation und
  Koordination ihre eigenen gemessenen Schwellen bestanden haben.

Es gibt **kein Zieldatum**. Über den Fortschritt entscheiden Langzeitbelege und
Sicherheitsschwellen, nicht der Kalender.

## 3. Sicherheitsgrenze

Recall **darf**:

- vorausschauende Bedingungen erkennen,
- Handlungen vorbereiten,
- kausale Strategien in kontrollierten Experimenten lernen,
- wiederverwendbare Workflows vorschlagen,
- ausdrücklich geteiltes Wissen synchronisieren.

Recall **darf nicht**:

- Vorhersagen zu Fakten machen,
- ohne Berechtigung nach außen wirken,
- einen gelernten Workflow seine Rechte erweitern lassen,
- Sync-Konflikte verstecken,
- Mehrheitsmeinung als Wahrheit behandeln,
- persönliches Gedächtnis mit Team-Konsens überschreiben.

## 4. Eintrittsbedingung

- Der V2.0-Plan ([#386](https://github.com/n0mad-ai/bastra-recall/issues/386))
  und sein Freigabe-Gate ([#400](https://github.com/n0mad-ai/bastra-recall/issues/400))
  sind die Voraussetzung.
- Live-Arbeit an V3 beginnt erst, wenn V2.0 über längere Zeit stabil läuft,
  Rollback zuverlässig funktioniert, die Herkunft jeder Erinnerung vollständig
  ist und brauchbare Outcome-Daten vorliegen.
- Reine Recherche, Schemaentwürfe, Simulationen und synthetische Fehlertests
  dürfen früher beginnen.
- Jede V3-Komponente bekommt eine eigene gemessene Schwelle, einen eigenen
  Schalter und V2 als Rückfallebene.

## 5. Globale Regeln

1. Fakten, Vorhersagen, Absichten, Zusagen und Handlungen bleiben getrennte
   Objekte.
2. Eine fällige Bedingung ist kein Beleg dafür, dass ihre Aussage stimmt.
3. Modelle dürfen Trigger-Bedingungen vorschlagen; ob ein Ereignis eingetreten
   ist, bestätigen deterministische Quellen.
4. Die Standardstufe jeder Handlung ist die Benachrichtigung.
5. Berechtigungen sind ausdrücklich, begrenzt, befristet und widerrufbar.
6. Gelernte Strategien und Workflows können keine Berechtigungen schaffen oder
   erweitern.
7. Kausale Aussagen verlangen saubere Methodik: bekannte Auswahlwahrscheinlichkeit,
   Kontrollgruppe und Umgang mit fehlenden Beobachtungen.
8. Persönliches Gedächtnis und ungelöste Konflikte überleben das Teilen.
9. Wiederholung durch Agenten ist kein unabhängiger Beleg.
10. Jede V3-Komponente ist erklärbar, prüfbar und auf lokales V2
    zurücksetzbar.
11. V3.0 ist erst abgeschlossen, wenn Schritt 09 durchgängig belegt ist – nicht
    schon, wenn er gebaut ist.

## 6. Der Plan in neun Schritten

```text
V2.0 (#386 / #400)
  └─ 01 Eintrittsgate
       ├─ 02 Prospektives Gedächtnis
       │    └─ 03 Event- und Trigger-Engine
       │         └─ 04 Berechtigte Handlungen
       │              └─ 05 Kausales Outcome-Gedächtnis
       │                   └─ 06 Workflow-Synthese
       └─ 07 Föderiertes Gedächtnis   (braucht zusätzlich V2-Herkunft und -Identität)
            └─ 08 Multi-Agent-Koordination
  alle Pflicht-Eigenschaften ─→ 09 Freigabe-Gate V3.0
```

Die Reihenfolge hat Gründe:

- Zusagen müssen existieren, bevor etwas sie auslöst; Auslöser müssen
  verlässlich sein, bevor irgendetwas ausgeführt wird.
- Kausales Lernen braucht beobachtbare Eingriffe; Workflows brauchen
  belegte Erfolge.
- Föderation braucht stabile Identität, Versionen, Scope und Herkunft;
  Koordination braucht die Föderation.
- Das V2-Langzeitniveau ist für jede V3-Komponente das Rollback-Ziel.

### Phase A – Fundament

#### Schritt 01 – Eintrittsgate ([#402](https://github.com/n0mad-ai/bastra-recall/issues/402))

V3 startet von einem über längere Zeit bewiesenen V2.0, nicht von einem
Eintagesvergleich. Bevor sich live etwas ändert, steht fest, wie Vorausschau,
kausale Eingriffe und Teilen bewertet werden.

- Beobachtungsfenster und Mindestmengen werden vorab festgelegt, getrennt nach
  Client, Projekt, Sprache und Trigger-Art.
- Eine Langzeit-Bewertung von V2 deckt Qualität, Fehlunterbrechungen,
  Zugänglichkeitsdrift, Drift gelernter Strategien, Rollback und den Erhalt der
  Herkunft ab.
- Testfälle für V3 umfassen fällige und bedingte Zusagen, verpasste und falsche
  Auslöser, verweigerte Berechtigungen, vorbereitete Handlungen, Sync-Konflikte
  und Echo-Schleifen zwischen Agenten.
- Für jede V3-Komponente gibt es festgelegte Abbruchkriterien und einen
  festen V2-Rückfallpunkt.
- Rohdaten von Personen und Teams bleiben lokal oder werden nur mit
  Einwilligung genutzt; öffentliche Berichte enthalten nur Aggregate.
- Kein V3-Feature geht live, das nur auf synthetischen Ergebnissen beruht.

### Phase B – Prospektives Gedächtnis und Vorausschau

#### Schritt 02 – Zusagen, Fristen und Lebenszyklus ([#403](https://github.com/n0mad-ai/bastra-recall/issues/403))

Recall kann festhalten, was künftig wieder auftauchen muss, ohne einen Plan,
eine Vorhersage oder eine Erinnerung mit einem Fakt zu verwechseln. Ausgangspunkt
ist [#250](https://github.com/n0mad-ai/bastra-recall/issues/250): „Erinnere mich,
wenn X“ ist heute nicht erfüllbar.

Eine Zusage enthält mindestens:

- stabile ID, Quelle und Eigentümer,
- Scope (persönlich, Projekt, Team),
- deterministische Auslösebedingung und Fälligkeitsfenster,
- Zeitzone und Wiederholungsregel,
- Status `pending | due | snoozed | resolved | cancelled | expired`,
- die erwartete Stufe (Benachrichtigung oder Handlung),
- den Beleg oder die Bedingung, die sie erledigt,
- einen Schlüssel gegen Doppelauslösung und den Beleg der letzten Auslösung,
- Gültigkeit, Sensitivität und nötige Berechtigungen.

Regeln:

- Zuerst ein nur lesender Prototyp, danach die Entscheidung über das Schema.
- „Fällig“ heißt nicht „wahr“, sondern „muss geprüft oder gezeigt werden“.
- Eine erledigte oder abgesagte Zusage wird nicht still wieder scharf.
- Wiederholungen sind ausdrücklich und begrenzt.
- Zeitzone und Sommerzeit sind gespeichert, versioniert und testbar.
- Die erste Oberfläche ist der Sitzungsstart. Dieser Schritt wirkt nie nach
  außen.
- Eine einmalige Zusage löst pro Fälligkeit höchstens einmal aus; Offline-Zeit
  und „erst in der nächsten Sitzung“ verlieren kein fälliges Ereignis.

#### Schritt 03 – Deterministische Event- und Trigger-Engine ([#404](https://github.com/n0mad-ai/bastra-recall/issues/404))

Recall erkennt über eine lokale, wiederholbare Event-Engine, wann eine Bedingung
wirklich fällig wird. Modelle dürfen Bedingungen vorschlagen, aber nicht
selbst entscheiden, dass ein Ereignis eingetreten ist.

Ereignisquellen, jede mit eigener Berechtigung und eigener
Zuverlässigkeitsschwelle, zuerst lokal:

- Uhrzeit (monoton und Wanduhr) und Nachholen in der nächsten Sitzung,
- Projekt, Worktree und Aufgabenphase,
- Git-Refs, Releases und Repository-Zustand,
- Änderungen an Dateien, Pfaden und Symbolen,
- Zustand von Entitäten, Dokumenten und Versionen,
- ausdrückliche Ereignisse von Nutzer oder Werkzeugen,
- optional externe Connectoren und Webhooks.

Regeln:

- Ereignisse haben ein versioniertes Format mit Quelle, Zeitachsen,
  Duplikatschlüssel und Sensitivität.
- Ein Journal erlaubt Wiederholung und Wiederaufnahme nach Absturz. Eine
  Auslösung passiert logisch genau einmal, auch wenn die Zustellung
  wiederholt wird.
- Zuerst gilt „in der nächsten Sitzung“; Aufwecken im Hintergrund braucht eine
  eigene Freigabe und bleibt ressourcenbegrenzt.
- Jede Auslösung ist erklärbar: welches Ereignis, welche Bedingung.
- Uhrumstellung, Neustart oder Wiederholung erzeugen keine doppelte Auslösung.
- Fällt eine Quelle aus, wird das sichtbar und nie als „Bedingung nicht
  erfüllt“ gewertet.
- Die Auswertung blockiert nie die normalen Recall-Hooks.

#### Schritt 04 – Berechtigte Handlungen: benachrichtigen, vorbereiten, ausführen ([#405](https://github.com/n0mad-ai/bastra-recall/issues/405))

Eine fällige Zusage kann benachrichtigen, eine Handlung vorbereiten oder – nur
mit ausdrücklicher Berechtigung – eine begrenzte Handlung ausführen. Gedächtnis
wird nie zu einer stillschweigenden Vollmacht.

Stufen:

1. `notify` – nur Kontext zeigen (Standard).
2. `prepare` – Probelauf, Entwurf, Diff oder vorgeschlagener Befehl.
3. `execute` – genau die freigegebene Operation innerhalb einer begrenzten
   Berechtigung.

Regeln:

- Eine Berechtigung ist gebunden an Handelnden, Ressource, Aktion, Scope,
  Ablauf und Widerruf.
- Die Freigabe hat keine vorausgewählte Ausführen-Option. Jede verändernde
  Aktion zeigt vorher einen Probelauf und einen lesbaren Diff.
- Eine Freigabe für eine Aktion oder ein Ziel lässt sich nicht für ein anderes
  wiederverwenden.
- Ein gelernter Workflow kann Berechtigungen weder schaffen, erweitern,
  weitergeben noch verlängern.
- Teilweises Scheitern wird nie als „erledigt“ gemeldet.
- Geheimnisse und Berechtigungsmaterial landen nie im Gedächtnis oder in
  öffentlicher Telemetrie.
- Die Kette Zusage → Auslösung → Vorschlag → Freigabe → Handlung → Ergebnis
  ist lückenlos nachvollziehbar.
- Ein Widerruf wirkt vor der nächsten Aktion und übersteht einen Neustart.
- Wird Schritt 04 abgeschaltet, bleibt das prospektive Gedächtnis als reine
  Benachrichtigung erhalten.

### Phase C – Kausales Lernen

#### Schritt 05 – Kausales Outcome-Gedächtnis ([#406](https://github.com/n0mad-ai/bastra-recall/issues/406))

Recall unterscheidet entlang der Kette
`Erinnerung → Entscheidung → Auslösung → Handlung → Ergebnis` zwischen
Zusammenhang und belegtem Nutzen. Es lernt nicht nur, welche Erinnerung genutzt
wurde, sondern ob ihr Auftauchen zu diesem Zeitpunkt das Ergebnis verbessert hat.

Regeln:

- Ergebnisse werden unterschieden: Erfolg, Fehlschlag, vermiedener Verstoß,
  Korrektur, wirkungslos, teilweise, unbekannt.
- Ohne bekannte Auswahlwahrscheinlichkeit, Kontrollgruppe und Umgang mit
  fehlenden Beobachtungen gibt es keine kausale Aussage.
- Eine erfolgreiche Aufgabe nach dem Zeigen beweist nicht, dass die Erinnerung
  den Erfolg verursacht hat.
- Nicht gezeigt und Schweigen zählen als „nicht beobachtet“, nicht als
  negativ.
- Experimente schließen zerstörerische, datenschutzkritische und riskante
  Handlungen aus.
- Beschreibende, zusammenhängende und kausale Berichte bleiben sichtbar
  getrennt.
- Das Ergebnis sind Vorschläge für Zeitpunkt, Unterbrechung, Routing und
  Handlungsstufe – nie eine Änderung an Fakten, nie mehr Rechte.
- Eine gelernte Strategie muss die feste Regel schlagen, bevor sie in eine
  Testphase geht. Ein Rollback entfernt die Strategie, nicht die gesammelten
  Episoden.

#### Schritt 06 – Geprüfte Workflow- und Strategie-Synthese ([#407](https://github.com/n0mad-ai/bastra-recall/issues/407))

Wiederholt erfolgreiche Abläufe können einen Vorschlag für einen
wiederverwendbaren Workflow ergeben – nie eine ungeprüfte autonome Routine.

Ein Vorschlag enthält Ziel und Anwendungsbedingungen, die Schritte mit
Verzweigungen, erwartete Zwischenergebnisse, bekannte Fehlerbilder und
Abbruchregeln, benötigte Ressourcen und Berechtigungen, die Quell-Episoden,
getestete Umgebungen, ein Prüfdatum und eine Version mit Rollback-Ziel.

Regeln:

- Häufigkeit ist kein Erfolg; nur belegte erfolgreiche Episoden zählen, und
  eine einzelne reicht nie.
- Ein Workflow übernimmt keine Rechte aus seinen Quell-Episoden.
- Er wird im Sandkasten gegen einfachere Strategien und gegen „nichts tun“
  verglichen und muss messbar besser sein.
- Ein Mensch nimmt an, ändert, lehnt ab oder zieht zurück.
- Fehlt eine Vorbedingung, enthält sich der Workflow, statt zu improvisieren.
- Erzeugter ausführbarer Inhalt gilt bis zur Prüfung als nicht
  vertrauenswürdig.
- Ändern sich Umgebung, Abhängigkeiten oder Belege, wird neu geprüft.
- Zurückziehen löscht weder Belege noch frühere Versionen.

### Phase D – Föderation und Koordination

#### Schritt 07 – Föderiertes persönliches, Projekt- und Team-Gedächtnis ([#408](https://github.com/n0mad-ai/bastra-recall/issues/408))

Mehrere Geräte und Personen können ausgewählte Erinnerungen teilen, ohne dass
der Vault zu „der letzte Schreiber gewinnt“ wird oder persönlicher Kontext
verloren geht.

Scopes: persönlich, Projekt/Workspace, Team und – nur wenn ausdrücklich
aktiviert – Organisation/öffentlich. Teilen ist ausdrücklich und ergänzend: Eine
persönliche und eine Team-Aussage dürfen nebeneinander stehen und sichtbar
widersprechen.

Regeln:

- Geteilte Inhalte haben eine inhaltsbasierte Identität und Version.
- Offline zuerst: Ein Journal und ein deterministisches Abgleichverfahren
  führen Änderungen zusammen. Kein Zusammenführen allein nach Zeitstempel.
- Geteilte Scopes sind unterwegs und gespeichert verschlüsselt, mit
  Schlüsselwechsel und Widerruf. Widerrufene Geräte erhalten nichts Neues.
- Konflikte werden zu eigenen Objekten mit geprüftem Zusammenführen.
- Löschungen verbreiten sich, ohne nötige Historie zu zerstören und ohne
  Daten wiederauferstehen zu lassen.
- Metadaten verraten nicht, dass eine geschützte Erinnerung existiert.
- Offline-Änderungen bleiben ihrem Gerät und ihrer Person zugeordnet.
- Team-Konsens überschreibt nie persönliches Gedächtnis.
- Ein Sync-Fehler ist sichtbar und wird nie als „aktuell“ gemeldet.
- Die Zusammenführungsregeln stehen fest, bevor Transport und Speicher gewählt
  werden; ein Wechsel des Backends ändert sie nicht.
- Die Föderation lässt sich abkoppeln und hinterlässt einen konsistenten
  lokalen Vault.

Bestehende Arbeit zu Import und Geräte-Sync
([#299](https://github.com/n0mad-ai/bastra-recall/issues/299),
[#339](https://github.com/n0mad-ai/bastra-recall/issues/339),
[#341](https://github.com/n0mad-ai/bastra-recall/issues/341)) bleibt in ihrem
eigenen Milestone; Schritt 07 nutzt ihre Ergebnisse, ohne sie zu doppeln.

#### Schritt 08 – Multi-Agent-Koordination ([#409](https://github.com/n0mad-ai/bastra-recall/issues/409))

Mehrere Assistenten können geteiltes Gedächtnis beobachten und nutzen, ohne
Echo-Verstärkung, doppelte Arbeit, versteckte Zuständigkeit oder Wahrheit per
Mehrheit.

Regeln:

- Jede Beobachtung, jeder Vorschlag und jede Handlung trägt die Identität des
  Agenten und ihre Herkunft.
- Ereignisse werden über Agenten und Geräte hinweg dedupliziert, Schleifen
  erkannt.
- Offene Zusagen und vorbereitete Handlungen haben eine Zuständigkeit auf Zeit
  (Lease). Sie regelt die Arbeit, versteckt die Zusage aber nicht vor anderen.
- Geteilte Wissenszustände: `asserted | confirmed | contested | superseded | unknown`.
- Zustimmung mehrerer Agenten mit derselben Quelle ist kein unabhängiger Beleg;
  wiederholtes Zitieren derselben Quelle zählt einmal.
- Mehrheit begründet keine Wahrheit.
- Ein Agent kann nicht die Berechtigung eines anderen verbrauchen.
- Echos erhöhen weder Vertrauen, Gewicht, Rang noch gelernten Nutzen.
- Ungelöste Konflikte bleiben für alle Berechtigten sichtbar.
- Übergaben erhalten Belege, Zustand, Berechtigungen und Rollback-Ziel.
- Vor jeder gemeinsamen Ausführung läuft die Koordination zuerst als nur
  lesende Simulation. Sie lässt sich abschalten, das geteilte Gedächtnis bleibt
  lesbar.

### Phase E – Freigabe

#### Schritt 09 – Freigabe-Gate, Sicherheit und Rollback-Nachweis ([#410](https://github.com/n0mad-ai/bastra-recall/issues/410))

V3.0 wird erst veröffentlicht, wenn Vorausschau, berechtigte Handlungen,
kausales Lernen, Workflow-Synthese, Föderation und Koordination als ein sicheres
Produkt zusammen funktionieren.

Nachweise:

- durchgängige Tests für lokal, nächste Sitzung, Hintergrund (freigegeben) und
  föderiert,
- Neuinstallation, Migration von V2, Offline-Update, Downgrade,
  Schlüsselwiderruf und vollständiger Rollback,
- Chaos-Tests für verlorene Weckrufe, doppelte Handlungen, verspätete
  Ergebnisse, Netztrennung, Zusammenführungskonflikte und Echo-Schleifen,
- Angriffstests auf Berechtigungen und eine Prüfung der Connector-Sandbox,
- Datenschutztests über Inhalte, Metadaten, Event-Journale, kausale Episoden
  und geteilte Berichte,
- Nutzertests zu Unterbrechungslast, Verständlichkeit von Freigaben,
  Konfliktprüfung und Wiederherstellung.

Checkliste für die Freigabe:

- V2.0 bleibt stabil und ist die getestete Rückfallebene.
- Fällige Zusagen gehen weder still verloren noch werden sie doppelt ausgelöst.
- Falsche und verpasste Auslösungen liegen innerhalb der festgelegten Schwellen.
- Vorhersagen, Absichten, Fakten und Handlungen bleiben getrennt.
- Externe Wirkungen verlangen und respektieren ausdrückliche Berechtigungen.
- Null Berechtigungsverstöße und null Lecks über Scope-Grenzen.
- Kausale Aussagen erfüllen die methodischen Anforderungen.
- Gelernte Workflows schlagen ihre Vergleichsstrategie und können keine Rechte
  erlangen.
- Sync verliert nichts still und hält Konflikte sichtbar.
- Geteilter Konsens kann persönliches Gedächtnis nicht überschreiben.
- Echos zwischen Agenten verstärken weder Belege noch Nutzen.
- Jede Handlung, jede Zusammenführung, jeder Workflow und jede gelernte
  Strategie ist erklärbar und zurücksetzbar.
- Ein globaler Notschalter führt ohne Datenverlust zurück auf lokales V2.

Optionale Komponenten, die ihre Schwelle nicht bestehen, bleiben aus. Eine
unbewiesene Pflicht-Eigenschaft hält V3.0 offen. Zeitdruck hebt keine Schwelle zu
Berechtigungen, Datenschutz, Kausalität, Sync-Integrität oder Rollback auf.

## 7. Offene Designfragen

Diese Punkte stammen aus einem externen, kritischen Review des Plans vom
28.08.2026 und hängen als Kommentare an den jeweiligen Issues. Sie sind noch
nicht entschieden.

- **Wessen Freigabe gilt bei mehreren Eigentümern?**
  ([#450](https://github.com/n0mad-ai/bastra-recall/issues/450)) Schritt 04
  geht von genau einer freigebenden Person aus. Betrifft eine Handlung
  persönliches Gedächtnis und Team-Gedächtnis zugleich, ist offen, ob jede
  betroffene Partei zustimmen muss, ob ein festgelegtes Quorum reicht und ob
  eine teilweise Ausführung erlaubt ist. Vorschlag: Die Freigabe wird zu einer
  Menge (eine je betroffenem Bereich), ausgeführt wird nur, wenn alle nötigen
  Freigaben oder ein ausdrücklich festgelegtes Quorum vorliegen. Das muss vor
  der Föderation entschieden werden.
- **Veraltete Freigaben** ([#405](https://github.com/n0mad-ai/bastra-recall/issues/405))
  Eine Berechtigung läuft nach Zeit ab oder wird widerrufen, aber nicht, wenn
  sich der freigegebene Inhalt bis zur Ausführung ändert. Vorschlag: Die
  Berechtigung bindet den Zustand, gegen den freigegeben wurde; bei der
  Ausführung wird erneut geprüft, und „veraltet“ wird ein eigenes Ergebnis
  neben „abgelaufen“ und „widerrufen“. Offen ist außerdem die Begründung, warum
  der Freigebende nicht der Vorschlagende sein darf.
- **Reihenfolge der kausalen Methoden**
  ([#406](https://github.com/n0mad-ai/bastra-recall/issues/406)) Vorschlag:
  zuerst die vorhandene Schwelle im Recall-Score als natürliches Experiment
  nutzen, danach eine zufällige Grauzone über den Canary-Mechanismus aus V2
  statt eigener Experimentiertechnik; die kleinste nachweisbare Wirkung vorab
  festlegen.

## 8. Übergreifende Kennzahlen

Jeder Schritt berichtet die zu ihm passenden Werte:

- Genauigkeit und Vollständigkeit hilfreicher Auslösungen, Anteil verpasster
  Auslösungen,
- Kosten von Unterbrechungen und Erledigungsquote von Zusagen,
- verweigerte oder verletzte Berechtigungen und doppelte Handlungen,
- Wirkung von Eingriffen mit Unsicherheit und fehlenden Beobachtungen,
- Übernahme, Erfolg, Enthaltung und Rollback von Workflows,
- Sync-Konflikte, stiller Verlust, Wiederherstellung und Konvergenz,
- Lecks über Scope- und Sensitivitätsgrenzen,
- Genauigkeit von Herkunft und Zuordnung,
- Echo-Verstärkung, doppelte Arbeit und Lease-Wiederherstellung bei mehreren
  Agenten,
- Latenz, Ressourcenverbrauch und Verhalten ohne Netz oder im
  eingeschränkten Betrieb.
