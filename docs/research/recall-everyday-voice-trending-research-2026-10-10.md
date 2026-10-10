# Experimentelle Recall Funktionen für den Alltag

Stand 10. Oktober 2026. Für Menschen ohne Programmierkenntnisse könnte Recall vor
allem durch eine einfache Eingabe, Antworten mit Originalbelegen und konkrete
Alltagsmodi nützlich werden. Besonders interessant sind eine kostengesteuerte
Sprachoberfläche, ein persönliches Wiki, Audio-/Video-Rückblicke und Begleitung bei
kreativen oder praktischen Vorhaben. Die folgenden Funktionen sind experimentelle
Vorschläge, keine Erweiterung der beschlossenen Roadmap.

Diese Recherche ergänzt die [gesicherten Geldideen](./recall-experimental-money-ideas-2026-10-10.md).
Die dort vorgeschlagenen Käufer und Geldmodelle bleiben unbestätigte Hypothesen.

## Was Dots bereits in Richtung Jarvis bietet

Dots unterstützt Sprachanrufe in ChatGPT auf Mobilgeräten, Desktop und Desktopbrowser.
Man kann eine Aufgabe besprechen, Entscheidungen klären und Fortschritt erfragen.
Nach dem Ende eines Anrufs kann zugewiesene Arbeit weiterlaufen. Von Dots selbst
initiierte Anrufe beschreibt die Dokumentation als geplant.
[Offizielle Dokumentation zu Dots Voice](https://learn.chatgpt.com/docs/dots/channels#chatgpt-and-voice).

Das ist ein möglicher Gesprächs- und Ausführungspartner für Recall. Eine funktionierende
Recall-Anbindung ist damit noch nicht belegt. Unterstützte Plugins, lokale Zugänge und
die tatsächlich zugestellten Erinnerungen müssten zusammen geprüft werden. Bei
Cloud-Orchestrierung werden die bisherigen lokalen Hooks nicht automatisch übernommen.
[Computer und Apps](https://learn.chatgpt.com/docs/dots/computers-and-apps),
[Kompatibilität lokaler Zugänge](https://learn.chatgpt.com/docs/enterprise/cloud-local-access).

Am Recherchetag nennt OpenAI für persönliche Pro-Pläne Nutzer über 18 außerhalb von
EWR, UK und Schweiz. Business Premium und Enterprise werden weltweit ausgerollt;
Enterprise benötigt eine Admin-Freigabe. Auch ein berechtigter Account erhält Dots
nicht zwingend sofort. Gespräch und delegierte Arbeit haben unterschiedliche
Nutzungsregeln. Die Quellen belegen keinen dauerhaft mithörenden, beliebig
kostengünstigen Jarvis und keine für eigene Apps verfügbare Dots-Sprachschnittstelle.
[Verfügbarkeit und Nutzung](https://learn.chatgpt.com/docs/dots#access).

## Der Sprachassistent hat mehrere mögliche Kostenmodelle

Ein Echtzeitgespräch, Spracherkennung und das Vorlesen eines Texts sind unterschiedliche
Aufgaben. Für einen Versuch lassen sich daher mehrere Wege gegenüberstellen:

| Weg | Ablauf | Was zu prüfen wäre |
|---|---|---|
| Lokaler Sprachzugang | Sprache lokal erkennen, Recall durchsuchen, Antwort lokal sprechen | Verständlichkeit, Antwortbeginn, Gerätelast und nutzbare Zielgeräte |
| Lokale Sprache mit Cloud-Denken | Erkennung und Ausgabe lokal; ausgewählte schwierige Aufgaben an ein Textmodell | Qualität, laufende Modellkosten und Übergang zwischen lokal und Cloud |
| Getrennte Cloud-Bausteine | Transkription, Textantwort und Sprachausgabe getrennt | Gesamtkosten und Gesprächsverzögerung unter realem Nutzungsverhalten |
| Echtzeitmodell für bestimmte Gespräche | Direktes Audio-Gespräch ausdrücklich für einen begrenzten Modus | Natürlichkeit, Unterbrechen, Werkzeugaufrufe und Kosten pro erfolgreicher Aufgabe |
| Dots als Gesprächspartner | Nutzer ruft Dot auf; Dot erhält passenden Recall-Kontext über geprüften Anschluss | Verfügbarkeit, Zustellung des Kontexts, Planregeln und Integrationsgrenzen |

Lokale Verarbeitung verursacht keine providerseitige Audio-Minutenabrechnung,
benötigt aber Gerätezeit, Energie, Speicher und eine funktionierende Integration.
Sie ist deshalb ein Kostenversuch, keine Zusage eines kostenlosen oder gleichwertigen
Echtzeitgesprächs.

FluidAudio bietet lokale Audio-Komponenten für Apple-Geräte. Das README unterscheidet
mehrsprachige Batch-Erkennung von einer englischen Streaming-Erkennung. PocketTTS
führt unter anderem deutsche Sprachpakete auf. Ein deutscher Gesprächsprototyp
müsste deshalb konkrete Modellpfade wählen und messen; nicht jede Demonstration lässt
sich auf Deutsch übertragen.
[FluidAudio](https://github.com/FluidInference/FluidAudio),
[PocketTTS Sprachpakete](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/TTS/PocketTTS.md).

Sherpa-onnx bietet offline Audiofunktionen und verschiedene Plattformbindungen.
Home Assistant demonstriert eine lokale Sprachkette und trennt begrenzte schnelle
Hausbefehle von offener Spracherkennung. Das motiviert einen lokalen schnellen Weg für
„merken“, „finden“ oder einen bestätigten Hausbefehl; freies Gespräch benötigt eine
andere Qualitätsprüfung.
[Sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx),
[Home Assistant](https://www.home-assistant.io/voice_control/voice_remote_local_assistant/).

**Kostenbeispiel, kein Gesamttarif:** Die aktuelle OpenAI-Tabelle nennt für
`gpt-transcribe` 0,0045 US-Dollar je Minute Transkription. Bei angenommenen 300
Eingabeminuten wären das rechnerisch 1,35 US-Dollar nur für diese Komponente.
Textantworten, Ausgabe-Audio, Werkzeugkosten, Infrastruktur und weitere Gebühren sind
nicht enthalten. Realtime-Audio wird nach Tokens abgerechnet; Gesprächsminuten ergeben
ohne Nutzungsprofil keinen belastbaren Gesamtpreis. Die alten Transkriptionsmodelle
sind bereits zur Abschaltung angekündigt und wären kein sinnvoller unveränderter
Langzeitanker für eine neue Integration.
[Preise](https://developers.openai.com/api/docs/pricing),
[Abkündigungen](https://developers.openai.com/api/docs/deprecations).

Moshi und PersonaPlex sind zusätzliche Forschungs-/Experimentkandidaten für
Full-Duplex-Gespräche. Hardwarebedarf, konkrete Sprachqualität und zuverlässige
Werkzeugnutzung sind gesondert zu prüfen. „Open Source“ allein macht sie nicht zum
fertigen mobilen Alltagsassistenten.
[Moshi](https://github.com/kyutai-labs/moshi),
[PersonaPlex](https://github.com/NVIDIA/personaplex).

Die frühere Mobile-Entscheidung priorisiert ein schnelles Echtzeit-Cloud-Gespräch mit
lokalem Gedächtnis. Die Alternativen hier dienen der aktuellen Kostenfrage; sie ändern
diese Entscheidung nicht automatisch. Als erster Versuch bietet sich eine bewusst
begrenzte Sprachoberfläche mit „merken“, „finden“ und kurzen Rückfragen an.

## GitHub Trending als konkrete Inspirationsquelle

Die Tages-, Wochen- und Monatsseiten wurden direkt abgerufen. Die beobachteten
Repositorynamen und URLs stehen im [Trending-Snapshot](./github-trending-snapshot-2026-10-10.json).
Die Zuordnung in der folgenden Tabelle gilt für diesen Abruf; Trending ist dynamisch
und keine Qualitäts- oder Nachfragebestätigung.

| Tatsächlich im Snapshot | Beobachteter Zeitraum | Beschriebener Mechanismus und mögliche Inspiration |
|---|---|---|
| [VoiceStudio](https://github.com/debpalash/VoiceStudio) | Monat | Lokale Sprachproduktion, Transkription und Hörbuchfunktionen; Ideen für gesprochenen Rückblick und ein persönliches Audioarchiv |
| [HyperFrames](https://github.com/heygen-com/hyperframes) | Woche und Monat | Video aus HTML-Kompositionen; Idee für Familienfilme, Reiseberichte und visuelle Rückblicke |
| [WeKnora](https://github.com/Tencent/WeKnora) | Monat | Dokumente, Suche und ein Wiki mit Quellen und Rollback; Idee für ein automatisch vorgeschlagenes persönliches Wiki |
| [ArtCraft](https://github.com/storytold/artcraft) | Tag | Interaktive Bild-/Video-Gestaltung; Idee für einen Partner, der Stil und kreative Entscheidungen über Projekte hinweg kennt |
| [Text-to-CAD](https://github.com/earthtojake/text-to-cad) | Woche | Agentenwerkzeuge für CAD; Idee für Alltagsskizzen und prüfbare 3D-Prototypen aus einer Beschreibung |
| [OpenGym](https://github.com/DuarteSantos8/openGym) | Woche | Selbst gehostetes Trainingsprotokoll; Idee für ein persönliches Aktivitätstagebuch mit Erinnerung an eigene Vorhaben |
| [Knowledge Work Plugins](https://github.com/anthropics/knowledge-work-plugins) | Tag und Monat | Fachliche Fähigkeiten als installierbare Pakete; Idee für verständlich benannte Alltagsmodi statt selbst geschriebener Prompts |
| [OpenRig](https://github.com/mvschwarz/openrig) | Woche | Persistente Agententeams mit Rollen und Zuständigkeit; Idee für koordinierte Helfer bei einem größeren persönlichen Vorhaben |
| [Colibri](https://github.com/JustVugg/colibri) | Monat | Lokale Modellinferenz mit teilweise vom Datenträger geladenen Experten; Kandidat für einen sparsamen lokalen Textpfad, keine Sprachpipeline |
| [PPT Master](https://github.com/hugohe3/ppt-master) | Tag | Dokumente zu bearbeitbaren Präsentationen; Idee für Familienchroniken, Projektvorstellungen oder Lernmaterial |

Die Projekte wurden als Quellen gelesen, nicht installiert oder benchmarked.
Beispielsweise verspricht VoiceStudio CPU-Betrieb mit geringerer Geschwindigkeit;
das ist keine Messung auf unseren Zielgeräten. Bei einer Übernahme ist die Lizenz
von Code, Modellen und Medien getrennt zu prüfen: etwa VoiceStudio AGPL und Piper GPL,
während andere Kandidaten permissivere Codelizenzen ausweisen. Die Tabelle ist eine
Ideensammlung, keine Empfehlung zur ungeprüften Einbettung in eine private App.
[VoiceStudio README](https://github.com/debpalash/VoiceStudio),
[Piper](https://github.com/OHF-Voice/piper1-gpl).

## Fünfzehn experimentelle Funktionen für Menschen ohne Programmierkenntnisse

Die folgenden Abläufe sind eigene Weiterentwicklungen der Quellen. Sie sind keine
Behauptung, dass die genannten Projekte diese Recall-Funktionen bereits besitzen.

| Funktion | So könnte sie sich im Alltag anfühlen | Anschluss oder Inspiration |
|---|---|---|
| Merken per Knopfdruck | Kurz sprechen: „Die Ersatzschlüssel liegen im blauen Kasten.“ Später mit Originalbeleg wiederfinden. | Sprachzugang und vorhandener Capture-/Recall-Pfad |
| Teile es mit Recall | Foto, Nachricht, PDF oder Link über das Teilen-Menü übergeben; Recall bietet eine verständliche Ablage und nächste Schritte an. | Dokument-Intake und einfache App-Oberfläche |
| Ein persönliches Wiki | Ausgewählte Unterlagen werden zu vorgeschlagenen Seiten über Zuhause, Reisen, Hobbys und Vorhaben; jeder Fakt bleibt auf seine Quelle zurückführbar. | WeKnora und vorhandene Herkunfts-/Reviewmechanismen |
| Ein Wochenpodcast über das eigene Leben | Freigegebene Notizen und Fotos ergeben einen kurzen gesprochenen Rückblick, den man korrigieren kann. | VoiceStudio und zeitliche Episoden |
| Ein Film aus eigenen Erlebnissen | „Mach aus diesen ausgewählten Fotos und Geschichten einen Reisebericht.“ Texte, Bilder und Belege bleiben editierbar. | HyperFrames |
| Dinge bekommen eine Geschichte | Gegenstand fotografieren; Kaufbeleg, Aufbewahrungsort, Reparatur und Notiz miteinander verbinden. | Dokumente, Entities und Timeline |
| Ein Assistent im Raum | Am Küchentisch Rezeptschritte oder beim Hobby gespeicherte Anleitungen erfragen. Der Gesprächsmodus ist ausdrücklich aktiv. | Home Assistant und lokaler Sprachpfad |
| Kostengesteuerte Gespräche | Ein schneller lokaler Modus für kurze Aufgaben und ein bewusst gewählter intensiver Gesprächsmodus für komplexere Fragen. | Lokale Audio-Komponenten und begrenztes Realtime |
| Eigene Alltagsmodi | „Reise vorbereiten“, „Pflanzen pflegen“, „Familiengeschichten sammeln“ als verständliche auswählbare Funktionen. | Fachpaket-Prinzip der Knowledge Work Plugins |
| Ein Partner für kreative Kontinuität | Der Assistent erinnert sich an die gewählten Figuren, Bildstile und verworfenen Varianten eines Projekts. | ArtCraft und Entscheidungsannahmen |
| Beschreiben und einen Prototyp sehen | Eine Aufbewahrungsidee in Worten schildern und einen maßhaltig zu prüfenden 3D-Entwurf erhalten. | Text-to-CAD; neues eigenes CAD-Fachgebiet |
| Ein privates Vorhabensjournal | Eigene Routinen und Fortschritte festhalten, passende frühere Erfahrungen abrufen und Ziele überprüfen. | OpenGym als Protokoll-Inspiration; keine medizinische Wirkung behauptet |
| Mehrere Helfer für eine Sache | Bei einem Umzug helfen getrennte Rollen für Unterlagen, Aufgaben und Recherche; man sieht Zuständigkeit und offene Fragen. | OpenRig und bestehende Koordination |
| Ein Kontextpaket zum Mitnehmen | Für Reise, neues Projekt oder Familienbesuch einen kleinen, ausdrücklich ausgewählten Wissensbestand offline bereithalten. | Lokale Speicherung, Budget und freigegebene Inhalte |
| Lernmaterial aus eigenen Unterlagen | Ein ausgewählter Text wird Erklärung, Übungsfall oder Präsentation; Fortschritt bleibt mit dem Thema verbunden. | PPT Master, Gedächtnis und Lernmodus |

Die entscheidende Produktanforderung ist ein unmittelbarer Zugang: installieren,
ausgewählte Inhalte hinzufügen, sprechen oder fragen und Quellen sehen. Nutzer
sollten dafür keine MCP-Konfiguration, Terminalbefehle oder Promptdateien bearbeiten
müssen. Das Produkt muss die Einrichtung und den Betrieb der Komponenten übernehmen.
Ein sichtbarer Aufnahmestatus, verständliche Korrektur und Wahl der Cloud-Nutzung
helfen dem Nutzer dabei, die Funktion bewusst einzusetzen.

## Welche kleinen Versuche den größten Erkenntnisgewinn hätten

1. **Sprache und Recall:** kurze Erfassung, gezieltes Wiederfinden und Rückfragen auf
   einem konkreten Zielgerät prüfen. Vergleiche lokale und hybride Wege anhand
   Antwortbeginn, Verständlichkeit, richtigen Belegen, Kosten und Energiebedarf.
2. **Persönliches Wiki:** aus einem kleinen ausdrücklich ausgewählten Bestand
   vorgeschlagene Seiten erzeugen. Prüfen, ob Nutzer etwas schneller finden und
   falsche Zusammenfassungen leicht korrigieren können.
3. **Wochenpodcast:** nur freigegebene Ereignisse verwenden und die Nützlichkeit mit
   einem normalen Text-Rückblick vergleichen. Stimme und Medienproduktion sind
   Aufwand, der einen eigenen Vorteil liefern sollte.
4. **Dots und Recall:** bei tatsächlicher Verfügbarkeit einen kontrollierten Anschluss
   testen: Gespräch → passende Erinnerung → nachvollziehbare Aufgabe → Ergebnis.
   Bestehende lokale Hook-Zustellung und Dots-Kontext nicht als gleichwertig annehmen.

Für mich ist die attraktivste erste Kombination **Merken per Knopfdruck, Finden per
Sprache und ein persönliches Wiki**. Sie macht den Nutzen ohne Programmierwissen
sichtbar und lässt den Sprachassistenten in begrenzten Aufgaben prüfen. Podcast,
Video, Kreativmodus und Raumassistent könnten daraus eigene Erlebnis- oder
Komfortprodukte werden. Zahlungsbereitschaft bleibt gesondert zu testen.

## Quellen und Grenzen

Die maßgeblichen Quellen sind die verlinkten offiziellen OpenAI-Dokumentationen,
GitHub-READMEs und die Home-Assistant-Anleitung. Trending-Zugehörigkeit ist im Snapshot
festgehalten; FluidAudio, Sherpa-onnx, Home Assistant, Moshi und PersonaPlex wurden
zusätzlich recherchiert und werden nicht als beobachtete Trending-Funde ausgegeben.
Keine Qualitäts-, Geschwindigkeits- oder Betriebskostenmessung der Kandidaten wurde
auf unseren Geräten durchgeführt. Aus der Beschreibung eines Backends folgt keine
fertige Integration und keine bestätigte kommerzielle Eignung.
