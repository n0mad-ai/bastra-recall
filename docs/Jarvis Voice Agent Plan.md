# Jarvis – Sprachagent in der Recall-UI (Plan für v1.9.0)

Stand: 28.10.2026 · Status: **Entwurf, wartet auf Freigabe durch Daniel**
Grundlage: fünf Recherche-Berichte (Code-Bestand, Einstellungen, OpenAI Realtime, EU-Anbieter, Architektur). Preise sind von den Anbieterseiten vom 28.10.2026; Kosten pro Minute sind Schätzungen.

---

## 1. Ziel

Mit Recall in der Web-UI richtig sprechen können: Der Agent hört zu, antwortet mit Stimme, darf unterbrochen werden und kann alles abfragen und steuern, also Memories, Dokumente, Code-Index, Aufgaben, Telemetrie und Daemon-Status. Er meldet sich von selbst, wenn die UI offen ist und etwas passiert. Die Nutzer bringen ihren eigenen API-Key mit. Für Nutzer in der EU gibt es einen Weg, bei dem die Daten in der EU verarbeitet werden. Später kommt eine Handy-App über die vorhandene Remote-MCP-Tür dazu.

Ein Nicht-Ziel für v1.9.0 ist die Handy-App. Sie wird nur vorbereitet.

---

## 2. Grundentscheidung (Empfehlung)

**Hybrid aus „Sprech-Agent vorne, Recall dahinter“.**

- Vorne führt ein günstiges Realtime-Sprachmodell (Standard: `gpt-realtime-2.1-mini`) das Gespräch.
- Dieses Modell sieht nur **5–6 schlanke Meta-Werkzeuge** statt rund 50 Einzel-Tools. Das spart bei jeder Antwort Token, und das Modell greift seltener daneben.
- Die eigentliche Arbeit macht der **Daemon**. Er führt die Werkzeuge aus, kürzt die Ergebnisse auf das Wesentliche, prüft Rechte und Bestätigungen und gibt schwierige Aufgaben bei Bedarf an ein günstiges Textmodell weiter (`delegate`).
- Diese Aufteilung empfiehlt OpenAI selbst als „Chat-Supervisor“-Muster.

**Verbindung:**

| Anbieter | Weg | Begründung |
|---|---|---|
| OpenAI, Azure | Der Browser spricht per **WebRTC direkt** mit dem Anbieter; der Daemon stellt nur ein kurzlebiges Token aus | Geringste Latenz, Audio läuft nicht durch den Daemon, der Key bleibt im Daemon |
| AWS Nova Sonic | Browser ↔ Daemon (WebSocket) ↔ Bedrock | Bedrock hat keinen Token-Weg für den Browser |

**Werkzeuge laufen immer über einen Daemon-Endpunkt** (`POST /ui/voice/tool`), egal welcher Anbieter. Dort liegen Rechte, Kürzung, Bestätigung und Budget an genau einer Stelle.

**Bibliothek im Browser:** OpenAI Agents SDK JS (`@openai/agents/realtime`). Es übernimmt WebRTC, Unterbrechen, die Tool-Schleife und Freigabe-Ereignisse. Weil die UI keinen Build-Schritt hat, wird es als fertiges ESM-Paket unter `webui/vendor/` abgelegt, so wie `ctxmenu.js`.

LiveKit und Pipecat kommen nicht in Frage: Sie brauchen einen eigenen Python-Prozess und wären neben dem Node-Daemon zu schwer.

---

## 3. Anbieter und Kosten

### Preise (USD pro 1 Mio. Token, OpenAI, 28.10.2026)

| Modell | Audio rein | Audio rein (Cache) | Audio raus | Text rein | Text raus |
|---|---|---|---|---|---|
| gpt-realtime-2.1 | 32,00 | 0,40 | 64,00 | 4,00 | 24,00 |
| gpt-realtime-2.1-mini | 10,00 | 0,30 | 20,00 | 0,60 | 2,40 |

### Geschätzte Monatskosten (Vielnutzer, 30 min am Tag ≈ 900 min im Monat)

| Variante | pro Minute | pro Monat |
|---|---|---|
| A: großes Realtime-Modell, alle Tools direkt | 0,05–0,10 $ | 45–90 $ (ohne Disziplin auch über 150 $) |
| **B: Hybrid, mini-Modell + gpt-5-mini als Helfer (Empfehlung)** | **0,02–0,035 $** | **18–32 $** |
| C: Kette Spracherkennung → Textmodell → Sprachausgabe | ~0,01 $ | 7–11 $ (träger, weniger natürlich) |
| D: AWS Nova Sonic | vermutlich ¼–⅓ von B | ca. 6–12 $ (unsicher) |

**Die größten Sparhebel**, alle im Plan enthalten:

1. Das mini-Modell als Standard.
2. Wenige Meta-Werkzeuge.
3. Ergebnisse im Daemon auf 300–800 Token kürzen. Details zeigt die UI daneben an.
4. Kurze Sitzungen: Push-to-Talk, automatisches Auflegen nach 60–120 s Stille, keine Dauersitzung.
5. Die Anweisungen bleiben stabil, damit der Cache greift.
6. Kontext kürzen (`truncation` mit `retention_ratio`).
7. Reasoning auf `low`.
8. Eine **Budgetgrenze im Daemon**: Bei Erreichen des Tages- oder Monatslimits gibt es keine neuen Sitzungen mehr.

### EU-Wege

| Weg | EU-Verarbeitung | Aufwand | Hinweis |
|---|---|---|---|
| OpenAI mit EU-Projekt (`eu.api.openai.com`) | Ja (EWR + Schweiz) | minimal, nur Umschalten der Adresse | Der Nutzer braucht bei OpenAI eine EU-/ZDR-Freigabe (Vertrieb). Ob Privatkunden die bekommen, ist unklar. 10 % Aufschlag |
| **Azure OpenAI „Data Zone EU“** (Sweden Central, France Central) | Ja, nur für gpt-realtime-2.1 und -1.5 (das mini-Modell nur „Global“, also **keine** EU-Garantie) | gering, fast gleiches Protokoll | Realistischster EU-Weg für eigene Keys |
| **AWS Bedrock Nova Sonic** (nur Stockholm) | Ja | mittel, Relay im Daemon | Deutsch offiziell (Stimmen tina und lennart), günstig. Nova 2 Sonic läuft frühestens am 02.12.2026 aus, Nachfolger 2.5 laut Zweitquellen, deshalb Modell-ID einstellbar |
| Google Gemini Live | unklar | – | In der EU laut Forenberichten noch wackelig, vorerst nicht |
| Komplett lokal (Parakeet + Ollama + Piper) | Gerät | hoch | Spätere Datenschutz- und Gratis-Option |

**Vorschlag: EU-Modus als Schalter.** Er lässt nur Anbieter und Modelle zu, bei denen die EU-Verarbeitung nachgewiesen ist, und blockiert „Global“-Deployments ausdrücklich.

---

## 4. Werkzeuge des Agenten

| Meta-Werkzeug | Macht | Rechte-Stufe |
|---|---|---|
| `ask_vault(frage)` | recall + find_document + load/read; der Daemon fasst in 2–3 Sätzen mit Belegen zusammen | lesen |
| `status(bereich)` | Telemetrie, Daemon-Gesundheit, Statusline, Code-Index, Updates, Kurator | lesen |
| `tasks(aktion, …)` | fällige Aufgaben zeigen, anlegen, quittieren, erledigen, zurückstellen | lesen / Aufgabe schreiben |
| `remember(…)` | Memory oder Entwurf speichern bzw. ändern | weich schreiben |
| `delegate(auftrag)` | Ein Textmodell löst mehrstufige Aufgaben mit dem vollen Werkzeugsatz, **mit den Rechten der aktuellen Stufe** | wie Aufrufer |
| `confirm(id)` | führt eine vorher angekündigte Schreibaktion aus | – |

**Bestätigung:** Jede Schreibaktion liefert zuerst einen Entwurf, den der Agent vorliest („Ich lege ‚X‘ für Freitag an – passt das?“). Erst `confirm(id)` führt sie aus. Der **Daemon** prüft das, nicht der Prompt.

**Rechte-Stufen:**

1. Lesen.
2. Weich schreiben: Sprach-Ja genügt.
3. Aufgaben schreiben: Sprach-Ja und Anzeige in der UI.
4. Ausführen, Löschen, Archivieren: **nur per Klick**.

**Schutz vor eingeschleusten Befehlen:** Memories und Dokumente können fremden Text enthalten, etwa aus OCR oder Webinhalten. Deshalb gilt: Ergebnisse sind als Daten markiert, eine Schreibaktion folgt nie automatisch auf ein Leseergebnis, und private Memories sind standardmäßig gesperrt. Das Muster dafür steht schon in `webui-chat.ts`.

---

## 5. Was im Code fehlt (aus der Bestandsaufnahme)

| Lücke | Heute | Nötig |
|---|---|---|
| Ereignisse an die UI | nur Abfragen in Abständen (`/ui/updates?since=`), kein Push zur UI | **Ereignisstrom `GET /ui/events` (SSE)**: fällige Aufgaben, neue Entwürfe, Warnungen, Vault-Änderungen |
| Generierungs-Anbieter | nur lokales Ollama | OpenAI-Text (für `delegate`), später Azure und Bedrock |
| Speicher für API-Keys | nur Umgebungsvariablen, `api.token` im Klartext in `cli-settings.json` | **macOS-Schlüsselbund** (Windows: Credential Manager); die UI sieht nur „gesetzt ja/nein“ |
| Statusline, Logs, Konfiguration per API | nur CLI bzw. Dateien | lesende Endpunkte für den Agenten |
| Aufgaben | Vorschau-Schalter `BASTRA_TASKS=1`, standardmäßig aus; Freigabe und Ausführung nur Owner per CLI mit Passphrase | siehe Entscheidung E1 |
| Remote-Tür `/api/v1/mcp` | ohne `task_*` | erst für die Handy-App relevant (E4) |

Die Web-UI hat **kein Framework und keinen Build**. Das Jarvis-Panel kommt als eigener Bereich hinzu: ein Mikrofon-Knopf in der Topbar und ein ausklappbares Gesprächs-Panel mit Transkript und Ergebniskarten. Es wird in den neuen UI-Entwurf eingepasst, an dem du gerade baust: Spalten und klare Ränder, keine Box-in-Box.

---

## 6. Umsetzungsplan v1.9.0

Jede Phase ist für sich nutzbar und testbar.

### Phase 0 – Fundament
- Schlüsselbund-Speicher für Anbieter-Keys inkl. CLI `bastra voice key set|clear`.
- Einstellungsblock `voice.*`: Anbieter, Modell, Stimme, Region oder Base-URL, EU-Modus, Budget pro Tag und Monat, Auflegen nach Stille, Rechte-Stufen.
- Budgetwächter mit Zähler aus den Nutzungsdaten der Anbieter (`response.done` → usage).
- Ereignisstrom `GET /ui/events` (SSE, nur lokal).

### Phase 1 – Jarvis MVP (nur lesen, OpenAI)
- `POST /ui/voice/session` stellt ein kurzlebiges Token aus. Der Daemon legt dabei Modell, Anweisungen und Werkzeuge fest. Der Endpunkt ist nur lokal erreichbar und mit Sitzung und CSRF-Schutz gesichert (Muster: `task-ui-session.ts`).
- `POST /ui/voice/tool` ist die Werkzeug-Weiche auf `dispatchApi` mit Ergebnis-Kürzung.
- Werkzeuge in dieser Phase: `ask_vault` und `status`.
- Bedienung über Push-to-Talk und Klick, Unterbrechen erlaubt, Transkript im Panel, Deutsch fest eingestellt.
- Abnahme: eine Frage stellen und eine gesprochene Antwort mit Beleg bekommen. Die Kosten pro Minute werden gemessen und im Panel angezeigt.

### Phase 2 – Schreiben und Aufgaben
- `remember`, `tasks` und `confirm` mit Entwurf und Bestätigung, dazu die Rechte-Stufen.
- `delegate` mit OpenAI-Textmodell (`gpt-5-mini`). Dafür kommt ein Generierungs-Anbieter neben Ollama hinzu.
- Aufgaben: anlegen, quittieren, erledigen, zurückstellen (`notify`). Ausführen nach E1.

### Phase 3 – Proaktiv
- Die UI hört auf `/ui/events`. Bei einem Ereignis kommen zuerst ein lokaler Ton und ein Hinweis, das kostet nichts.
- Erst auf „Jarvis, erzähl“ oder einen Klick öffnet sich eine Sitzung, mit dem Ereignis als Startkontext.
- Mehrere Ereignisse werden zu einem Kurz-Briefing gebündelt. Ruhezeiten lassen sich einstellen.

### Phase 4 – EU-Anbieter
- OpenAI-EU über einen Schalter für die Base-URL (`eu.api.openai.com`).
- Azure-Adapter für Data Zone EU (fast gleiches Protokoll).
- AWS-Nova-Sonic-Adapter: ein Relay im Daemon über das AWS SDK und den bidirektionalen Stream, Zugangsdaten im Schlüsselbund, Modell-ID frei einstellbar.
- EU-Modus-Schalter.

### Phase 5 – Feinschliff
- Lesende Status-Endpunkte für Statusline, Logs und Konfiguration als Futter für `status`.
- Gesprächs-Transkripte optional als Memory-Entwürfe in den vorhandenen Entwurfs-Kreislauf.
- Doku (Nutzer-Doku `voice`, Datenschutz-Hinweis in `PRIVACY.md`).

### Später (nach 1.9.0 bzw. v2)
- Handy-App: holt das Token per OAuth über `recall.bastra.io` und spricht per WebRTC direkt mit OpenAI. Werkzeuge laufen über die Remote-Tür. Dasselbe Muster wie in der UI.
- Weckwort im Browser (lokales Modell), lokaler Kaskaden-Modus.

---

## 7. Zweiter Plan: Einstellungsseite (für dieselbe Version vorgeschlagen)

Jarvis braucht ohnehin eine Einstellungsoberfläche. Deshalb schlage ich vor, die allgemeine Einstellungsseite gleich mit aufzubauen.

1. **Einstellungs-Register:** eine Liste aller Schlüssel. Zu jedem gehören Typ, Standardwert, Bereich, ob er durch eine Umgebungsvariable überstimmt wird, ob ein Neustart nötig ist, und ein Prüfer. Daraus werden `KNOWN_KEYS` (CLI) und die UI erzeugt. Heute sind diese Listen doppelt gepflegt (`config-cmd.ts:57`, `settings.ts`).
2. **`GET/POST /ui/settings`:** nur lokal, mit Sitzung und CSRF. Baut auf `readSettings` und `mutateSettings` auf, Vorbild ist `/settings/docs`.
3. **UI-Seite** mit diesen Bereichen: Allgemein und Sprache, Suche und Embeddings, Hooks und Reflex, Code-Index, Archiv, Aufgaben, Zugang (Token, CORS, OAuth-Clients widerrufen), Updates und **Jarvis**.
4. **Regeln:** Secrets werden nur maskiert angezeigt und lassen sich nur über die Aktionen „neu erzeugen“ oder „löschen“ ändern. Ist eine Einstellung durch eine Umgebungsvariable überstimmt, steht das sichtbar daneben. Bei Bedarf gibt es einen Knopf für den Neustart.
5. Heute nur per Umgebungsvariable einstellbar sind zum Beispiel Telemetrie aus und Aufgaben an. Diese Schalter werden zu echten Einstellungen. Die Umgebungsvariable gewinnt weiterhin, wenn sie gesetzt ist.

---

## 8. Entscheidungen (Daniel, 28.10.2026)

- **E1:** Aufgaben werden **per Sprache freigegeben**, ein zusätzlicher Klick ist nicht vorgesehen. Beispiel: Auf „Trag mir morgen einen Termin ein“ trägt Jarvis den Termin direkt ein. Vorher wird geprüft, ob die Freigabe per Sprache zuverlässig und sicher funktioniert. Das ist ein eigenes Prüf-Issue.
- **E2:** Die Aufgabenfunktion ist ab 1.9.0 **standardmäßig an**.
- **E3:** Standard ist das **kleine Modell** (`gpt-realtime-2.1-mini`). Auf das große lässt sich umschalten.
- **E4:** Aufgaben über die Remote-Tür **bleiben zu**. Sie werden erst freigegeben, wenn es die App gibt und das beschlossen ist.
- **E5:** Die **Einstellungsseite kommt in 1.9.0**.

Ursprüngliche Fragen:

- **E1 – Aufgaben per Sprache ausführen:** Heute geben Owner Aufgaben nur in der CLI frei, mit Passphrase und Signatur.
  - (a) So lassen: Jarvis legt an und erinnert, ausführen geht nur per CLI.
  - (b) **Empfehlung:** Freigabe per Klick in der UI mit Passkey/Touch ID. Ein Sprach-Ja allein reicht nie.
- **E2 – Aufgaben standardmäßig an?** Jarvis braucht `BASTRA_TASKS=1`. Soll das ab 1.9.0 Standard sein oder ein Schalter in den Einstellungen bleiben?
- **E3 – Standardmodell:** `gpt-realtime-2.1-mini` (günstig, minimal schwächer bei Werkzeugen) oder das große Modell. **Empfehlung:** mini, mit Umschalter.
- **E4 – Aufgaben über die Remote-Tür** (Handy, ChatGPT): erst bei der App entscheiden. **Empfehlung:** bis dahin geschlossen.
- **E5 – Einstellungsseite in 1.9.0 mit aufnehmen?** **Empfehlung:** ja, mindestens Register, Endpunkt und Jarvis-Bereich.

---

## 9. Offene Punkte zum Prüfen vor dem Bau

- Gültigkeitsdauer der kurzlebigen OpenAI-Tokens.
- Deutsch-Qualität des mini-Modells: im Prototyp testen.
- Bekommen Nutzer mit eigenem Key die OpenAI-EU-Freigabe?
- Nova 2.5 Sonic: Modell-ID und Regionen sind nur durch Zweitquellen belegt.
- Azure-Aufschlag für Data Zone ist nicht verifiziert.
- Verträgt das Agents SDK ein Bundling als einzelne ESM-Datei ohne Build-Kette?

## Quellen (Auswahl)

- OpenAI Preise: https://developers.openai.com/api/docs/pricing
- OpenAI Kosten und Latenz: https://developers.openai.com/api/docs/guides/voice-latency-cost?api=realtime
- WebRTC: https://developers.openai.com/api/docs/guides/voice-webrtc?api=realtime
- Realtime + MCP: https://developers.openai.com/api/docs/guides/realtime-mcp
- EU-Datenresidenz: https://developers.openai.com/api/docs/guides/your-data
- Agents SDK Voice: https://openai.github.io/openai-agents-js/guides/voice-agents/build/
- Chat-Supervisor-Muster: https://github.com/openai/openai-realtime-agents
- Azure Regionen: https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure-region-availability?pivots=standard
- Azure WebRTC: https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-webrtc
- Nova 2 Sonic: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-sonic.html
- Nova Bidirectional Stream: https://docs.aws.amazon.com/nova/latest/userguide/speech-bidirection.html
- Deepgram EU: https://developers.deepgram.com/reference/regional-endpoints
