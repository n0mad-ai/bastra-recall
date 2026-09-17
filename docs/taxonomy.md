# Self-learning taxonomy (#64) / Selbstlernende Taxonomie (#64)

[English](#english) · [Deutsch](#deutsch)

<a id="english"></a>

## English

bastra-recall's category system has two kinds of axes:

- **Hard axis — `type`**: a closed enum (`lesson`, `decision`, …). Stable
  behavioural vocabulary, manually curated, never mutated at runtime.
- **Free axes — `scope`, `topic_path`, `tags`, `recall_when`, `folder`**: open
  strings. This is where the vault can *learn* new categories.

The learning loop closes in three steps: **notice** (drift detector) →
**record** (convention memory) → **apply** (hook injection + `folder` routing).
Everything lives per-vault: one user's vault can grow a `people/` taxonomy
while another never does. The shared `type` schema is untouched.

### 1. Convention memories — the contract (#65)

A *convention* is a regular memory that fixes how a recurring cluster is
stored. Reserved home:

| field | value |
|---|---|
| `scope` | `taxonomy` (reserved — routes to `memories/taxonomy/`) |
| `type` | `workflow` |
| `tags` | must include `convention`, plus the cluster key (e.g. `person`) |
| `recall_when` | concrete save-moments, e.g. "about to save a memory about a person" |

The **body** states the rule, machine-followable:

```markdown
## Cluster
What belongs to this cluster (and what does not).

## Rule
- folder: memories/people
- topic_path: [people, <handle>]
- tags: [person, <role…>]
- id/title shape: <handle> — <real name>
- body shape: handle, name, role/relationship, first-seen, signals,
  interaction log as [[wikilinks]], sensitivity.

## Example
One worked example entry (frontmatter + body sketch).
```

A convention is updated with `overwrite=true` (refresh, don't fork
`convention-v2`). Retire one by setting it `obsolete` — covered clusters go
silent in the drift detector either way.

### 2. Applying conventions (#66)

- The **session hook** fetches `GET /hook/taxonomy` (all non-obsolete
  memories in scope `taxonomy`, newest first, cap 12) and injects a
  `<vault-taxonomy>` block at session start. Conventions are **binding**: a
  save into a covered cluster follows the convention's folder/topic_path/tags
  instead of inventing variants.
- `save_memory` accepts a **`folder`** argument (relative to the vault root,
  path-safe, containment-checked) so conventions can place members in real
  structure — e.g. `memories/people/`. The vault scans recursively; any folder
  indexes.
- **Re-filing**: `overwrite=true` with a changed folder *moves* the memory —
  the new file is written, the old file goes to the vault trash
  (`.bastra/trash/`, recoverable), and the index is updated immediately. This
  is how existing memories migrate under a new convention.

### 3. Noticing drift (#67)

The daemon's drift detector (`GET /hook/drift`, implemented in
`packages/daemon/src/taxonomy.ts`) looks at memories updated in the last
`BASTRA_DRIFT_WINDOW_DAYS` (default 14) and flags clusters of at least
`BASTRA_DRIFT_MIN_CLUSTER` (default 8) distinct memories sharing a tag or a
sub-project `topic_path` segment — **unless** a convention already covers that
key (mentioned in a convention's tags, topic_path or title). Scope names and
memory types never count (structural, not drift).

The **stop hook** surfaces at most two clusters as a `<taxonomy-drift>`
suggestion. Suggestion only: the agent weighs it next turn, asks the user if
unsure, and never bulk-moves silently.

### Worked example — `person` (#68)

The pilot convention that established `memories/people/`:

```yaml
id: konvention-person
scope: taxonomy
type: workflow
tags: [convention, person, people]
recall_when:
  - "about to save a memory about a person"
  - "contributor, peer or contact shows up in conversation"
```

Rule: people live in `folder: memories/people`, `topic_path: [people,
<handle>]`, tag `person`, one memory per person (no collection memos), body
shape: handle, name, role/relationship, first-seen, signals/trust, interaction
log as `[[wikilinks]]`, sensitivity. Project memories link people by
`[[<handle>]]` instead of restating their story.

<a id="deutsch"></a>

## Deutsch

Das Kategoriensystem von bastra-recall hat zwei Arten von Achsen:

- **Feste Achse — `type`**: ein geschlossenes Enum (`lesson`, `decision`, …). Stabiles
  Verhaltensvokabular, manuell gepflegt, zur Laufzeit nie verändert.
- **Freie Achsen — `scope`, `topic_path`, `tags`, `recall_when`, `folder`**: offene
  Zeichenketten. Hier kann der Vault neue Kategorien *lernen*.

Die Lernschleife schließt sich in drei Schritten: **bemerken** (Drift-Detektor) →
**festhalten** (Konventions-Erinnerung) → **anwenden** (Hook-Injektion + `folder`-Routing).
Alles gilt pro Vault: Der Vault einer Person kann eine `people/`-Taxonomie entwickeln,
während ein anderer das nie tut. Das gemeinsame `type`-Schema bleibt unberührt.

### 1. Konventions-Erinnerungen — der Vertrag (#65)

Eine *Konvention* ist eine normale Erinnerung, die festlegt, wie ein wiederkehrender
Cluster gespeichert wird. Reservierter Ort:

| Feld | Wert |
|---|---|
| `scope` | `taxonomy` (reserviert — leitet nach `memories/taxonomy/`) |
| `type` | `workflow` |
| `tags` | muss `convention` enthalten, dazu den Cluster-Schlüssel (z. B. `person`) |
| `recall_when` | konkrete Speichermomente, z. B. "about to save a memory about a person" |

Der **Body** formuliert die Regel so, dass eine Maschine ihr folgen kann:

```markdown
## Cluster
What belongs to this cluster (and what does not).

## Rule
- folder: memories/people
- topic_path: [people, <handle>]
- tags: [person, <role…>]
- id/title shape: <handle> — <real name>
- body shape: handle, name, role/relationship, first-seen, signals,
  interaction log as [[wikilinks]], sensitivity.

## Example
One worked example entry (frontmatter + body sketch).
```

Eine Konvention wird mit `overwrite=true` aktualisiert (auffrischen, nicht als
`convention-v2` abzweigen). Zum Ausmustern setzt du sie auf `obsolete` — abgedeckte
Cluster bleiben im Drift-Detektor so oder so still.

### 2. Konventionen anwenden (#66)

- Der **Session-Hook** holt `GET /hook/taxonomy` (alle nicht obsoleten
  Erinnerungen im Scope `taxonomy`, neueste zuerst, höchstens 12) und fügt beim
  Sitzungsstart einen `<vault-taxonomy>`-Block ein. Konventionen sind **verbindlich**:
  Ein Speichervorgang in einen abgedeckten Cluster folgt folder/topic_path/tags der
  Konvention, statt Varianten zu erfinden.
- `save_memory` akzeptiert ein **`folder`**-Argument (relativ zum Vault-Root,
  pfadsicher, mit Containment-Prüfung), damit Konventionen Einträge in eine echte
  Struktur legen können — z. B. `memories/people/`. Der Vault wird rekursiv gescannt;
  jeder Ordner wird indiziert.
- **Umlegen**: `overwrite=true` mit geändertem Ordner *verschiebt* die Erinnerung —
  die neue Datei wird geschrieben, die alte wandert in den Vault-Trash
  (`.bastra/trash/`, wiederherstellbar), und der Index wird sofort aktualisiert. So
  wandern bestehende Erinnerungen unter eine neue Konvention.

### 3. Drift bemerken (#67)

Der Drift-Detektor des Daemons (`GET /hook/drift`, implementiert in
`packages/daemon/src/taxonomy.ts`) betrachtet Erinnerungen, die in den letzten
`BASTRA_DRIFT_WINDOW_DAYS` (Standard 14) Tagen aktualisiert wurden, und markiert Cluster
aus mindestens `BASTRA_DRIFT_MIN_CLUSTER` (Standard 8) verschiedenen Erinnerungen, die ein
Tag oder ein Unterprojekt-Segment in `topic_path` teilen — **es sei denn**, eine
Konvention deckt diesen Schlüssel bereits ab (erwähnt in Tags, topic_path oder Titel
einer Konvention). Scope-Namen und Erinnerungstypen zählen nie (strukturell, keine Drift).

Der **Stop-Hook** zeigt höchstens zwei Cluster als `<taxonomy-drift>`-Vorschlag an.
Nur ein Vorschlag: Der Agent wägt ihn im nächsten Zug ab, fragt im Zweifel nach und
verschiebt nie still in großem Stil.

### Durchgerechnetes Beispiel — `person` (#68)

Die Pilotkonvention, die `memories/people/` eingeführt hat:

```yaml
id: konvention-person
scope: taxonomy
type: workflow
tags: [convention, person, people]
recall_when:
  - "about to save a memory about a person"
  - "contributor, peer or contact shows up in conversation"
```

Regel: Personen liegen in `folder: memories/people`, `topic_path: [people,
<handle>]`, Tag `person`, eine Erinnerung pro Person (keine Sammelnotizen),
Body-Aufbau: Handle, Name, Rolle/Beziehung, erstmals gesehen, Signale/Vertrauen,
Interaktionsprotokoll als `[[wikilinks]]`, Sensitivität. Projekt-Erinnerungen verlinken
Personen über `[[<handle>]]`, statt ihre Geschichte zu wiederholen.
