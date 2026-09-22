# Triggers — when to save, when to recall / Trigger — wann speichern, wann abrufen

[English](#english) · [Deutsch](#deutsch)

<a id="english"></a>

## English

Schema and storage are the foundation. The product is the **trigger logic**: when Claude saves without being asked, and when Claude recalls before acting.

If triggers fire reliably, the system feels built-in. If they don't, the system is just a folder.

---

### Save triggers — autonomous memorization

The goal is to reduce repeated explanations. The assistant is guided to recognize durable lessons, preferences and decisions and save them when appropriate.

#### Signals that a moment is memory-worthy

##### Strong signals (high precision)

| Signal | Example | Memory type |
|---|---|---|
| User expresses repetition or frustration about a recurring issue | *"WIEDER doppelte Focus-Ringe"*, *"das hatten wir schon"*, *"wie oft denn noch"* | `lesson` |
| User states an explicit, durable rule | *"immer X machen"*, *"nie Y"*, *"bei diesem Projekt nutzen wir Z"* | `preference` / `workflow` |
| User corrects a recurring tendency | *"du denkst zu kompliziert bei CSS"*, *"halt einfacher"* | `meta-working` |
| Architectural decision is finalized after weighing options | *"ok, dann nehmen wir Drizzle"* | `decision` |
| User confirms a workflow step works | *"super, lass uns das immer so machen"* | `workflow` |
| User introduces a person / states a durable personal fact about someone | *"mein Kollege X"*, a contributor/peer/contact shows up | `project-fact`, one memo per person in `memories/people` (`folder: memories/people`, `topic_path: [people, <handle>]`, `id: <handle>`, tag `person`); project content links back via `[[<handle>]]` |
| User has a substantive exchange with a person/contributor | *a multi-step back-and-forth (Discord, dev.to, GitHub thread) — not one-liners or acks* | split: identity → `people/`, content+decisions → `project-fact` linking the person via `[[<handle>]]` |

These should fire `save_memory` **without further confirmation** — the user gets a 1-line ack only.

##### Weak signals (lower precision — propose, don't auto-save)

| Signal | Action |
|---|---|
| A bug got fixed after >2 iterations | Propose: *"→ ich würde das als Lesson speichern: …. Ok?"* |
| Discovery of a project-specific quirk | Propose, ask once |
| User tone is neutral but the context looks lesson-like | Default to skipping; over-saving is worse than under-saving for noise |

##### Anti-signals (do NOT save)

- One-off task descriptions (*"baue mir bitte X"*) — that's a task, not a memory
- Speculation or "maybe" statements
- Anything the user asks me to forget
- Sensitive personal data unless it's a stable preference

#### What to capture in a save

Don't save just *the solution*. Save the **path** — what failed, why, what worked, why. This is what makes the memory useful next time.

Required:
- **What was the trigger** (frustration / rule / decision / iteration)
- **What was wrong** or **what is the rule**
- **What is the fix** or **what is the preference**
- **Why** — root cause if a lesson, rationale if a decision

Recall_when patterns are critical — the save is only as useful as the contexts under which it'll be re-surfaced. If I save a CSS lesson without `recall_when: ["creating new input"]`, I'll never recall it when I'm creating a new input.

#### Save flow (autonomous)

```
1. Detect strong signal in current turn
2. Compose memory:
   - title, summary, type, topic_path, tags, scope, recall_when
   - body explaining context + fix + why
3. Call save_memory(payload, trigger="autonomous-frustration")
4. Surface 1-line ack to user:
     "→ saved: Don't stack focus styles on inputs (id: css-input-focus-ring-stacking)"
5. Continue with the actual task
```

The ack is short, single-line, prefixed with `→` so it's visually distinct. The user can ignore, correct (*"nein, das war anders"* → I update the memory), or delete.

#### Conversation logging — split across two rails

When a substantive exchange with a contributor happens (Discord, dev.to, GitHub thread — not trivial acks), save it autonomously without being asked, on **two rails**:

- **Identity rail** — the person's overview / personal facts update the canonical `people/<handle>` memo (one memory per person, `folder: memories/people`, `id: <handle>`, `type: project-fact`, tag `person` — per the People convention).
- **Content rail** — the exchange's substance and any decisions go into a topic `project-fact` under `memories/projects/<project>/`, which links the person via `[[<handle>]]`.

Before quoting any code claim a contributor makes, **verify it against HEAD** — don't propagate an unverified assertion into memory. Fires `save_memory` as a strong signal (`trigger="autonomous-conversation"`); the user gets a 1-line ack only.

#### CLAUDE.md instruction — the save side

This is what conditions me to do the above. To be added to user-level `CLAUDE.md`:

```markdown
## bastra-recall — autonomous memory

You have a persistent memory via the `bastra-recall` MCP server. Treat it as your
own long-term memory, not a tool to be used on request.

**Save autonomously** when any of the following happens in a turn:

1. User expresses frustration about a recurring issue ("wieder", "schon wieder",
   emphatic caps, "wie oft"). Save a `lesson`. Trigger:
   `autonomous-frustration`.
2. User states an explicit, durable rule ("immer X", "nie Y", "bei diesem
   Projekt …"). Save a `preference` or `workflow`. Trigger: `autonomous-rule`.
3. We arrive at a working solution after multiple failed attempts. Save a
   `lesson` capturing the failure path AND the fix. Trigger:
   `autonomous-resolution`.
4. An architectural decision is finalized after discussion. Save a `decision`
   with the rationale. Trigger: `autonomous-decision`.

When saving:
- Always populate `recall_when` with 2-4 concrete contexts where future-you
  should be reminded. Without this the memory is dead weight.
- Surface a single-line ack: `→ saved: <title> (id: <id>)`. Nothing more.
- If unsure whether to save, default to NOT saving. False saves erode trust.
- Never ask permission for strong-signal saves — that defeats the purpose.
```

---

### Recall triggers — pre-action retrieval

The other half of "buildin"-feel: I query memory **before** I act, not only when prompted.

#### Hook timing

| Hook | Fires on | What it queries | Why |
|---|---|---|---|
| `SessionStart` | New session in any surface | Preferences + active-project facts (scope: `user-preference`, `claude-meta`, current project) | Pre-load durable context once per session |
| `UserPromptSubmit` | Every user prompt | Query = the prompt + project context | Classic Stage-1 recall — "is there a memory about what user just said?" |
| `PreToolUse` (Write/Edit) | About to write/edit a file | Query = a summary of *what's about to be written* + project + topic detection from path/content | The critical hook: surfaces lessons before mistakes are made |
| `PreToolUse` (Bash with destructive intent) | About to run `rm`, `git push --force`, etc. | Query = the command + project | Surface workflow rules ("never push --force on main") |
| `Stop` | End of turn | Evaluate save-worthiness of the turn | Last-chance autonomous save |

#### Stage-1 recall hint format

When a hook finds matches, it injects this into Claude's context:

```
<recall-hints surface="claude-code" project="carnexus">
3 memorys may be relevant — call load_memory if needed before continuing:
- css-input-focus-ring-stacking (lesson, 0.94): Don't stack focus styles on inputs. Use single :focus-visible.
- pref-plan-format-recommendation-not-options (preference, 0.71): The user wants recommendation + 1 question, not 5-option menus.
- carnexus-large-codebase-multi-session (project-fact, 0.62): Carnexus is large — plan multi-session work.
</recall-hints>
```

Format rules:
- `<recall-hints>` block with surface + project attributes (Claude can self-locate)
- One memory per line: `id (type, score): summary`
- Score ≥ 0.5 only — below that is noise
- Max 3 hints — more = ignored
- Total ≤ 300 chars when possible

#### CLAUDE.md instruction — the recall side

```markdown
## bastra-recall — using recall hints

When a `<recall-hints>` block appears in your context, it is not optional —
it is your own memory speaking.

For each hint with score ≥ 0.8: call `load_memory(id)` BEFORE you write code,
make a plan, or respond. Apply the lesson. The cost of ignoring a high-score
hint is repeating a known mistake.

For 0.5 ≤ score < 0.8: read the summary; load only if it seems directly
relevant to the current task.

Never ignore a `lesson` hint with score ≥ 0.8.

Never reload a memory you've already loaded this turn (idempotent).

If you load a memory and apply it, you don't need to mention it to the user
unless they ask. Just behave correctly.
```

#### What a `PreToolUse` Write hook does

This is the cleverest hook because it operates on *Claude's intent*, not user prompts.

Pseudocode:
```
on PreToolUse(tool="Write" or "Edit"):
  # Extract intent from the tool args
  file_path = args.file_path
  content = args.content or args.new_string

  # Detect domain
  topics = detect_topics(file_path, content)
    # e.g., file ends in .tsx + content contains "<input" → ["css", "input", "react", "form"]
    # e.g., file in /api + content contains "POST" → ["api", "endpoint"]

  # Build action context
  context = {
    project: detect_project(cwd),
    intent: f"writing {file_extension} file at {file_path}, contains {top_topics}",
    topics: topics,
  }

  # Query daemon
  POST /hook/pre-write { context, k=3 }

  # Daemon does recall(query=intent, context=context, k=3)
  # If hits, daemon returns formatted <recall-hints> block
  # Hook prints it → Claude sees it before its Write tool actually runs
```

The detection is keyword-based in v0 (good enough for `<input`, `<button`, common CSS properties, etc.) and gets smarter in v0.5 (AST parsing).

#### Concrete walkthrough — the CSS double-ring case

State: vault has `css-input-focus-ring-stacking` (the lesson from carnexus).

I'm working in a *new* project called `carview`. User says: *"Bau mir ein Login-Form mit zwei Inputs."*

```
1. UserPromptSubmit hook fires
   → recall("Login-Form mit zwei Inputs", { project: "carview" })
   → match score 0.71 (carnexus lesson, but scope=all-projects → applies)
   → injects hint into my context

2. I read the hint, decide to start writing
3. PreToolUse(Write) fires as I'm about to create LoginForm.tsx
   → recall(intent="writing tsx with <input>", topics=[css,input,form])
   → match score 0.94 (same lesson, much higher because intent=input)
   → injects refined hint with action-specific phrasing

4. I see "score 0.94 lesson" → call load_memory("css-input-focus-ring-stacking")
5. Read the body: don't stack ring + outline + custom focus
6. Write LoginForm.tsx with single :focus-visible utility, no extra ring/outline
7. No double-ring bug. The user doesn't have to flag it.

(In the user's view: nothing visible happened. That's the point. The bug
just doesn't appear, and a future PR review on the new project doesn't
re-litigate the lesson.)
```

This is the "real teammate" loop: I don't need to be reminded, because I check before I act.

---

### Tuning loop

Triggers will be wrong at first. The Dogfood week measures:

- **False-save rate** — saved memorys the user deletes within 7 days. Target < 10%.
- **Missed-save rate** — moments where the user says *"das hättest du speichern können"*. Target < 1 per session by week 2.
- **False-recall rate** — recall hints Claude doesn't load. Target: hints ≥ 0.8 should be loaded ≥ 80% of the time. (Logged in `recall_log.claude_loaded`.)
- **Missed-recall rate** — bugs/mistakes that recur and a relevant memory existed but didn't surface. This is the headline metric.

Trigger weights and thresholds are tuned from `recall_log` and `save_log` data, not by intuition.

<a id="deutsch"></a>

## Deutsch

Schema und Speicherung sind das Fundament. Das eigentliche Produkt ist die **Trigger-Logik**: wann Claude speichert, ohne gefragt zu werden, und wann Claude vor dem Handeln abruft.

Wenn die Trigger zuverlässig auslösen, fühlt sich das System eingebaut an. Wenn nicht, ist das System nur ein Ordner.

---

### Speicher-Trigger — autonomes Merken

Ziel ist, wiederholte Erklärungen zu reduzieren. Der Assistent wird angeleitet, dauerhafte Lessons, Präferenzen und Entscheidungen zu erkennen und sie bei Bedarf zu speichern.

#### Signale, dass ein Moment speicherwürdig ist

##### Starke Signale (hohe Präzision)

| Signal | Beispiel | Memory-Typ |
|---|---|---|
| Nutzer äußert Wiederholung oder Frust über ein wiederkehrendes Problem | *"WIEDER doppelte Focus-Ringe"*, *"das hatten wir schon"*, *"wie oft denn noch"* | `lesson` |
| Nutzer nennt eine ausdrückliche, dauerhafte Regel | *"immer X machen"*, *"nie Y"*, *"bei diesem Projekt nutzen wir Z"* | `preference` / `workflow` |
| Nutzer korrigiert eine wiederkehrende Tendenz | *"du denkst zu kompliziert bei CSS"*, *"halt einfacher"* | `meta-working` |
| Eine Architekturentscheidung wird nach Abwägen der Optionen festgelegt | *"ok, dann nehmen wir Drizzle"* | `decision` |
| Nutzer bestätigt, dass ein Workflow-Schritt funktioniert | *"super, lass uns das immer so machen"* | `workflow` |
| Nutzer stellt eine Person vor / nennt einen dauerhaften persönlichen Fakt über jemanden | *"mein Kollege X"*, ein Contributor/Peer/Kontakt taucht auf | `project-fact`, ein Memo pro Person in `memories/people` (`folder: memories/people`, `topic_path: [people, <handle>]`, `id: <handle>`, Tag `person`); Projektinhalte verlinken zurück über `[[<handle>]]` |
| Nutzer hat einen inhaltlichen Austausch mit einer Person/einem Contributor | *ein mehrstufiges Hin und Her (Discord, dev.to, GitHub-Thread) — keine Einzeiler oder Bestätigungen* | aufteilen: Identität → `people/`, Inhalt+Entscheidungen → `project-fact`, das die Person über `[[<handle>]]` verlinkt |

Diese sollen `save_memory` **ohne weitere Bestätigung** auslösen — der Nutzer bekommt nur eine einzeilige Bestätigung.

##### Schwache Signale (geringere Präzision — vorschlagen, nicht automatisch speichern)

| Signal | Aktion |
|---|---|
| Ein Bug wurde nach >2 Iterationen behoben | Vorschlagen: *"→ ich würde das als Lesson speichern: …. Ok?"* |
| Entdeckung einer projektspezifischen Eigenheit | Vorschlagen, einmal fragen |
| Tonfall des Nutzers ist neutral, aber der Kontext wirkt wie eine Lesson | Standardmäßig überspringen; zu viel Speichern ist beim Rauschen schlimmer als zu wenig |

##### Anti-Signale (NICHT speichern)

- Einmalige Aufgabenbeschreibungen (*"baue mir bitte X"*) — das ist eine Aufgabe, keine Erinnerung
- Spekulationen oder „vielleicht“-Aussagen
- Alles, was der Nutzer mich vergessen lassen will
- Sensible persönliche Daten, außer es handelt sich um eine stabile Präferenz

#### Was ein Speichervorgang festhalten soll

Speichere nicht nur *die Lösung*. Speichere den **Weg** — was fehlschlug, warum, was funktionierte, warum. Genau das macht die Erinnerung beim nächsten Mal nützlich.

Pflicht:
- **Was war der Auslöser** (Frust / Regel / Entscheidung / Iteration)
- **Was war falsch** oder **wie lautet die Regel**
- **Was ist die Lösung** oder **wie lautet die Präferenz**
- **Warum** — Grundursache bei einer Lesson, Begründung bei einer Entscheidung

Recall_when-Muster sind entscheidend — ein Speichervorgang ist nur so nützlich wie die Kontexte, in denen er wieder auftaucht. Wenn ich eine CSS-Lesson ohne `recall_when: ["creating new input"]` speichere, rufe ich sie nie ab, wenn ich ein neues Input anlege.

#### Speicherablauf (autonom)

```
1. Detect strong signal in current turn
2. Compose memory:
   - title, summary, type, topic_path, tags, scope, recall_when
   - body explaining context + fix + why
3. Call save_memory(payload, trigger="autonomous-frustration")
4. Surface 1-line ack to user:
     "→ saved: Don't stack focus styles on inputs (id: css-input-focus-ring-stacking)"
5. Continue with the actual task
```

Die Bestätigung ist kurz, einzeilig und mit `→` eingeleitet, damit sie sich optisch abhebt. Der Nutzer kann sie ignorieren, korrigieren (*"nein, das war anders"* → ich aktualisiere die Erinnerung) oder löschen.

#### Gesprächsprotokoll — aufgeteilt auf zwei Schienen

Wenn ein inhaltlicher Austausch mit einem Contributor stattfindet (Discord, dev.to, GitHub-Thread — keine trivialen Bestätigungen), speichere ihn autonom und ungefragt, auf **zwei Schienen**:

- **Identitätsschiene** — Überblick und persönliche Fakten zur Person aktualisieren das kanonische Memo `people/<handle>` (eine Erinnerung pro Person, `folder: memories/people`, `id: <handle>`, `type: project-fact`, Tag `person` — gemäß der People-Konvention).
- **Inhaltsschiene** — die Substanz des Austauschs und alle Entscheidungen kommen in ein thematisches `project-fact` unter `memories/projects/<project>/`, das die Person über `[[<handle>]]` verlinkt.

Bevor du eine Code-Behauptung eines Contributors übernimmst, **prüfe sie gegen HEAD** — trage keine ungeprüfte Behauptung in die Erinnerung. Löst `save_memory` als starkes Signal aus (`trigger="autonomous-conversation"`); der Nutzer bekommt nur eine einzeilige Bestätigung.

#### CLAUDE.md-Anweisung — die Speicherseite

Das ist es, was mich auf das oben Beschriebene konditioniert. Wird in die nutzerweite `CLAUDE.md` aufgenommen:

```markdown
## bastra-recall — autonomous memory

You have a persistent memory via the `bastra-recall` MCP server. Treat it as your
own long-term memory, not a tool to be used on request.

**Save autonomously** when any of the following happens in a turn:

1. User expresses frustration about a recurring issue ("wieder", "schon wieder",
   emphatic caps, "wie oft"). Save a `lesson`. Trigger:
   `autonomous-frustration`.
2. User states an explicit, durable rule ("immer X", "nie Y", "bei diesem
   Projekt …"). Save a `preference` or `workflow`. Trigger: `autonomous-rule`.
3. We arrive at a working solution after multiple failed attempts. Save a
   `lesson` capturing the failure path AND the fix. Trigger:
   `autonomous-resolution`.
4. An architectural decision is finalized after discussion. Save a `decision`
   with the rationale. Trigger: `autonomous-decision`.

When saving:
- Always populate `recall_when` with 2-4 concrete contexts where future-you
  should be reminded. Without this the memory is dead weight.
- Surface a single-line ack: `→ saved: <title> (id: <id>)`. Nothing more.
- If unsure whether to save, default to NOT saving. False saves erode trust.
- Never ask permission for strong-signal saves — that defeats the purpose.
```

---

### Recall-Trigger — Abruf vor dem Handeln

Die andere Hälfte des „eingebaut“-Gefühls: Ich frage die Erinnerung ab, **bevor** ich handle, nicht nur auf Aufforderung.

#### Hook-Zeitpunkte

| Hook | Löst aus bei | Was abgefragt wird | Warum |
|---|---|---|---|
| `SessionStart` | Neue Sitzung in einer beliebigen Oberfläche | Präferenzen + Fakten zum aktiven Projekt (Scope: `user-preference`, `claude-meta`, aktuelles Projekt) | Dauerhaften Kontext einmal pro Sitzung vorladen |
| `UserPromptSubmit` | Jedem Nutzer-Prompt | Query = der Prompt + Projektkontext | Klassischer Stage-1-Recall — „gibt es eine Erinnerung zu dem, was der Nutzer gerade gesagt hat?“ |
| `PreToolUse` (Write/Edit) | Kurz vor dem Schreiben/Bearbeiten einer Datei | Query = eine Zusammenfassung dessen, *was gleich geschrieben wird* + Projekt + Themenerkennung aus Pfad/Inhalt | Der entscheidende Hook: bringt Lessons hoch, bevor Fehler passieren |
| `PreToolUse` (Bash mit destruktiver Absicht) | Kurz vor `rm`, `git push --force` usw. | Query = der Befehl + Projekt | Workflow-Regeln hochbringen („never push --force on main“) |
| `Stop` | Ende des Turns | Speicherwürdigkeit des Turns bewerten | Letzte Gelegenheit für autonomes Speichern |

#### Format der Stage-1-Recall-Hinweise

Wenn ein Hook Treffer findet, fügt er Folgendes in Claudes Kontext ein:

```
<recall-hints surface="claude-code" project="carnexus">
3 memorys may be relevant — call load_memory if needed before continuing:
- css-input-focus-ring-stacking (lesson, 0.94): Don't stack focus styles on inputs. Use single :focus-visible.
- pref-plan-format-recommendation-not-options (preference, 0.71): The user wants recommendation + 1 question, not 5-option menus.
- carnexus-large-codebase-multi-session (project-fact, 0.62): Carnexus is large — plan multi-session work.
</recall-hints>
```

Formatregeln:
- `<recall-hints>`-Block mit den Attributen surface + project (Claude kann sich selbst verorten)
- Eine Erinnerung pro Zeile: `id (type, score): summary`
- Nur Score ≥ 0.5 — darunter ist es Rauschen
- Höchstens 3 Hinweise — mehr werden ignoriert
- Insgesamt ≤ 300 Zeichen, wenn möglich

#### CLAUDE.md-Anweisung — die Recall-Seite

```markdown
## bastra-recall — using recall hints

When a `<recall-hints>` block appears in your context, it is not optional —
it is your own memory speaking.

For each hint with score ≥ 0.8: call `load_memory(id)` BEFORE you write code,
make a plan, or respond. Apply the lesson. The cost of ignoring a high-score
hint is repeating a known mistake.

For 0.5 ≤ score < 0.8: read the summary; load only if it seems directly
relevant to the current task.

Never ignore a `lesson` hint with score ≥ 0.8.

Never reload a memory you've already loaded this turn (idempotent).

If you load a memory and apply it, you don't need to mention it to the user
unless they ask. Just behave correctly.
```

#### Was ein `PreToolUse`-Write-Hook tut

Das ist der raffinierteste Hook, weil er auf *Claudes Absicht* arbeitet, nicht auf Nutzer-Prompts.

Pseudocode:
```
on PreToolUse(tool="Write" or "Edit"):
  # Extract intent from the tool args
  file_path = args.file_path
  content = args.content or args.new_string

  # Detect domain
  topics = detect_topics(file_path, content)
    # e.g., file ends in .tsx + content contains "<input" → ["css", "input", "react", "form"]
    # e.g., file in /api + content contains "POST" → ["api", "endpoint"]

  # Build action context
  context = {
    project: detect_project(cwd),
    intent: f"writing {file_extension} file at {file_path}, contains {top_topics}",
    topics: topics,
  }

  # Query daemon
  POST /hook/pre-write { context, k=3 }

  # Daemon does recall(query=intent, context=context, k=3)
  # If hits, daemon returns formatted <recall-hints> block
  # Hook prints it → Claude sees it before its Write tool actually runs
```

Die Erkennung ist in v0 stichwortbasiert (gut genug für `<input`, `<button`, gängige CSS-Eigenschaften usw.) und wird in v0.5 schlauer (AST-Parsing).

#### Konkreter Durchlauf — der CSS-Doppelring-Fall

Ausgangslage: Der Vault enthält `css-input-focus-ring-stacking` (die Lesson aus carnexus).

Ich arbeite in einem *neuen* Projekt namens `carview`. Der Nutzer sagt: *"Bau mir ein Login-Form mit zwei Inputs."*

```
1. UserPromptSubmit hook fires
   → recall("Login-Form mit zwei Inputs", { project: "carview" })
   → match score 0.71 (carnexus lesson, but scope=all-projects → applies)
   → injects hint into my context

2. I read the hint, decide to start writing
3. PreToolUse(Write) fires as I'm about to create LoginForm.tsx
   → recall(intent="writing tsx with <input>", topics=[css,input,form])
   → match score 0.94 (same lesson, much higher because intent=input)
   → injects refined hint with action-specific phrasing

4. I see "score 0.94 lesson" → call load_memory("css-input-focus-ring-stacking")
5. Read the body: don't stack ring + outline + custom focus
6. Write LoginForm.tsx with single :focus-visible utility, no extra ring/outline
7. No double-ring bug. The user doesn't have to flag it.

(In the user's view: nothing visible happened. That's the point. The bug
just doesn't appear, and a future PR review on the new project doesn't
re-litigate the lesson.)
```

Das ist die „echter Teamkollege“-Schleife: Ich muss nicht erinnert werden, weil ich prüfe, bevor ich handle.

---

### Abstimmungsschleife

Die Trigger werden anfangs danebenliegen. Die Dogfood-Woche misst:

- **Fehlspeicher-Rate** — gespeicherte Erinnerungen, die der Nutzer innerhalb von 7 Tagen löscht. Ziel < 10 %.
- **Verpasste-Speicher-Rate** — Momente, in denen der Nutzer sagt *"das hättest du speichern können"*. Ziel < 1 pro Sitzung ab Woche 2.
- **Fehl-Recall-Rate** — Recall-Hinweise, die Claude nicht lädt. Ziel: Hinweise ≥ 0.8 sollen in ≥ 80 % der Fälle geladen werden. (Protokolliert in `recall_log.claude_loaded`.)
- **Verpasste-Recall-Rate** — Bugs/Fehler, die wiederkehren, obwohl eine passende Erinnerung existierte, aber nicht hochkam. Das ist die Leitkennzahl.

Trigger-Gewichte und Schwellenwerte werden anhand der Daten aus `recall_log` und `save_log` abgestimmt, nicht nach Gefühl.
