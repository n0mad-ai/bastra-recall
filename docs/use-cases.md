# What you can use Recall for

[English](#english) · [Deutsch](#deutsch)

<a id="english"></a>

## English

Once Recall is connected, ask your assistant to keep useful context and retrieve
it in later conversations. These prompts are examples you can adapt.

1. **Messages and conversation threads.** Store drafting rules and ask the assistant to maintain a short conversation log with agreements and open questions.
   “Remember my drafting preferences, and keep this thread's agreements and open questions together.”

2. **Conventions, rules and lessons.** Put reusable knowledge in the vault, scoped to one project or all projects, so connected assistants can retrieve it without expanding `CLAUDE.md` or `AGENTS.md`.
   “Save this fix as a lesson for all projects, including why it works.”

3. **Explicit saves.** Say “save this” after a rule, correction or decision, and include when it should be useful again.
   “Save this decision with its reason, and recall it when we revisit deployment.”

4. **Session handovers.** Finish a session by asking for a short note with decisions, remaining work and the next step.
   “Save a handover so the next session can continue from here.”

5. **Tasks, roadmaps and planned posts.** Ask the assistant to keep open tasks in their own area and maintain a roadmap and planned contributions for each project.
   “Keep these open tasks together and update this project's roadmap and planned posts.”

6. **Several assistants, one vault.** Connect Claude Code and Codex to the same vault and use saved handovers when switching between them.
   “Read the latest handover from the shared vault before continuing.”

7. **Home servers and personal matters.** Save useful locations, routines and decisions for everyday life as well as code.
   “Remember where the home-server backup script lives and when I should check it.”

8. **Scans and PDFs.** Once documents are indexed, with text extraction or OCR where needed, ask about their contents instead of remembering filenames.
   “Which document contains the warranty terms, and when does the warranty end?”

9. **Learned filing conventions.** Establish a convention for a recurring subject and ask the assistant to apply it when saving related notes.
   “Learn this filing convention for conversation notes and use it for future saves.”

10. **Several computers and memory care.** Use a locally available cloud-synced vault on each computer, and flag notes in `bastra map` for a later care session.
    “Work through the notes I marked for editing or deletion in the memory map.”

The sync service moves the files; simultaneous edits can conflict. Map flags
record requests for your assistant to review with you, rather than immediately
editing or deleting notes. See [vault care](USAGE.md#vault-care--flag-it-now-groom-it-later)
and [privacy and file sync](PRIVACY.md).

### What happens automatically

The automatic parts depend on the client's installed skill and enabled hooks:

- **Save suggestions after a turn:** optional end-of-turn checks identify potentially useful notes for the assistant to assess. Claude Code can handle them in the same turn; Codex relays them to the next session. A suggestion is not a promise that anything was saved.
- **A line after a write:** Claude Code and Codex receive a short notice after confirmed saves or edits. Reads stay silent; a held save or conflict is labelled accordingly. Codex defaults to a plain prefix, with interactive appearance and colour not visually verified; [compatibility and setup](codex-save-notice.md).
- **Hints before relevant tool calls:** supported hooks retrieve context before actions such as a patch, plan or shell command. The assistant still has to apply it; relevant context is not guaranteed for every action.

You can always ask what was saved and correct it. [Setup](INSTALL.md),
[usage](USAGE.md) and [the hook guide](hooks.md) explain the available controls.

---

<a id="deutsch"></a>

## Deutsch

Wenn Recall verbunden ist, kannst du deinen Assistenten bitten, nützlichen
Kontext festzuhalten und später wieder abzurufen. Die Beispiele kannst du anpassen.

1. **Nachrichten und Gesprächsverläufe.** Hinterlege Regeln für Entwürfe und lass den Assistenten Absprachen und offene Fragen eines Gesprächs kurz mitschreiben.
   „Merke dir meine Regeln für Nachrichtenentwürfe und halte Absprachen und offene Fragen dieses Gesprächs zusammen.“

2. **Konventionen, Regeln und Lektionen.** Lege wiederverwendbares Wissen im Vault für ein Projekt oder alle Projekte ab, damit verbundene Assistenten es abrufen können, ohne `CLAUDE.md` oder `AGENTS.md` zu vergrößern.
   „Speichere diese Lösung als Lektion für alle Projekte, mit dem Grund, warum sie funktioniert.“

3. **Ausdrücklich speichern.** Sage nach einer Regel, Korrektur oder Entscheidung „speichere das“ und ergänze, wann es wieder nützlich sein soll.
   „Speichere diese Entscheidung mit ihrer Begründung und rufe sie ab, wenn wir das Deployment wieder anfassen.“

4. **Arbeitsstand am Sitzungsende.** Lass eine kurze Übergabe mit Entscheidungen, offener Arbeit und dem nächsten Schritt ablegen.
   „Speichere eine Übergabe, damit die nächste Sitzung hier anknüpfen kann.“

5. **Aufgaben, Roadmaps und geplante Beiträge.** Lass offene Aufgaben in einem eigenen Bereich sammeln und je Projekt eine Roadmap und geplante Beiträge pflegen.
   „Halte diese offenen Aufgaben zusammen und aktualisiere die Roadmap und geplanten Beiträge dieses Projekts.“

6. **Mehrere Assistenten, ein Vault.** Verbinde Claude Code und Codex mit demselben Vault und nutze gespeicherte Übergaben beim Wechsel.
   „Lies die letzte Übergabe aus dem gemeinsamen Vault, bevor du weitermachst.“

7. **Heimserver und Privates.** Speichere nützliche Orte, Abläufe und Entscheidungen für den Alltag ebenso wie für Code.
   „Merke dir, wo das Backup-Skript des Heimservers liegt und wann ich es prüfen sollte.“

8. **Scans und PDFs.** Sind Dokumente mit Textextraktion oder nötiger OCR indexiert, kannst du nach ihrem Inhalt fragen, statt Dateinamen zu kennen.
   „Welches Dokument enthält die Garantiebedingungen, und wann endet die Garantie?“

9. **Gelernte Ablage-Konventionen.** Lege für ein wiederkehrendes Thema eine Konvention fest und lass sie bei späteren Notizen anwenden.
   „Lerne diese Ablage-Konvention für Gesprächsnotizen und nutze sie beim nächsten Speichern.“

10. **Mehrere Rechner und Vault-Pflege.** Nutze auf jedem Rechner einen lokal verfügbaren, per Cloud synchronisierten Vault und markiere Notizen in `bastra map` für eine spätere Pflegerunde.
    „Arbeite mit mir die Notizen ab, die ich in der Map zum Ändern oder Löschen markiert habe.“

Der Sync-Dienst überträgt die Dateien; gleichzeitige Änderungen können Konflikte
erzeugen. Map-Markierungen halten Aufträge fest, die der Assistent mit dir
durchgeht, und ändern oder löschen nicht sofort Notizen. Siehe
[Vault-Pflege](USAGE.md#vault-pflege--jetzt-markieren-später-aufräumen) und
[Datenschutz und Datei-Sync](PRIVACY.md#deutsch).

### Was von allein passiert

Die automatischen Teile hängen vom installierten Skill und den aktivierten Hooks ab:

- **Speichervorschläge nach einem Zug:** optionale Prüfungen am Zugende zeigen dem Assistenten möglicherweise nützliche Notizen zur Bewertung. Claude Code kann sie im selben Zug abarbeiten; Codex reicht sie an die nächste Sitzung weiter. Ein Vorschlag bedeutet noch nicht, dass etwas gespeichert wurde.
- **Eine Zeile nach dem Schreiben:** Claude Code und Codex bekommen nach bestätigtem Speichern oder Ändern eine kurze Meldung. Suchen und Laden bleiben still; eine zurückgehaltene Notiz oder ein Widerspruch wird entsprechend benannt. Codex nutzt standardmäßig ein farbloses Präfix; interaktive Darstellung und Farbe sind nicht visuell geprüft. [Kompatibilität und Einrichtung](codex-save-notice.md#deutsch).
- **Hinweise vor passenden Werkzeugaufrufen:** unterstützte Hooks rufen vor einem Patch, Plan oder Shell-Befehl Kontext ab. Der Assistent muss ihn noch anwenden; nicht zu jeder Aktion wird passender Kontext gefunden.

Du kannst jederzeit nachfragen, was gespeichert wurde, und es korrigieren.
[Einrichtung](INSTALL.md), [Nutzung](USAGE.md#deutsch) und
[Hook-Anleitung](hooks.md#deutsch) erklären die verfügbaren Einstellungen.
