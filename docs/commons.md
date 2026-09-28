# Bastra Commons — shared recall (#119 / #120) / Bastra Commons — geteilter Recall (#119 / #120)

[English](#english) · [Deutsch](#deutsch)

<a id="english"></a>

## English

Bastra Commons is a **separate, opt-in, default-OFF, PR-gated public Git repo** of
community-proven engineering recipes — **never your private vault**. Reading it is
one-way and read-only; every contribution goes through a human-reviewed PR. There is
**no auto-egress**: nothing leaves your machine without an explicit, reviewed PR.

Default repo: `https://github.com/n0mad-ai/bastra-commons`. Default clone path:
`~/.bastra/commons` (override with `BASTRA_COMMONS_PATH`).

`BASTRA_COMMONS_REPO` points the clone and the contribution PR at a different
repo. It is **allowlisted** (#260): only `github.com/n0mad-ai/…` is accepted by
default, and anything else — a different host, a different owner, a local path,
an unparseable value — is refused before the clone and before the push, because
the contribution path opens a PR against exactly this target and would ship your
verification records there. To use another target on purpose, set
`BASTRA_ALLOW_REMOTE_COMMONS=1`; every clone and every submission then prints the
overridden target on one line, each time.

### How it plugs into recall

`bastra commons enable` git-clones (`--depth 1`) the repo and sets
`commons.enabled` in `~/.bastra/cli-settings.json`. On the next daemon boot the
clone is loaded **read-only** as a second BM25 index; its hits are fused into
`recall` under `scope: commons`, ranked **just below** your personal memories.

- Rank: `commonsRankFactor` = baseline `0.8`, raised by independent `works`
  (up to +0.15), lowered by `fails`, clamped to `[0.5, 0.95]`
  (`packages/daemon/src/cli/commons.ts:138`). A recipe can never outrank a
  personal hit, nor disappear entirely.
- On an **id collision**, the personal memory wins — the commons hit is dropped
  (`packages/daemon/src/tool-handlers.ts:244`).
- The daemon **NEVER writes** the clone. Opt-in, restart-to-apply, read-only.

Two shared layers live in the **same clone**, each with its own toggle:

| Layer | Path | Toggle | CLI |
|---|---|---|---|
| Recipes + verifications | `recipes/`, `verifications/` | `commons.enabled` | `bastra commons` |
| Bridges (shared learned-recall, #120) | `bridges/<lang>/*.json` | `sharedRecall.enabled` | `bastra bridges` |

Both default OFF; both require a daemon restart to take effect. `commons.enabled`
defaults to `false` (`settings.ts:235`); `sharedRecall.enabled` defaults to `false`
(`settings.ts:245`). Bridges live *inside* the Commons clone, so `bastra bridges
enable` only flips the toggle — you still need `bastra commons enable` to actually
clone the repo.

### What is shared

Three artifact kinds. **None carries private vault content** — no memory bodies,
and (for bridges) no memory ids.

#### 1. Recipe — `recipes/<domain>/<slug>.md`

A markdown file with bastra-memory-compatible frontmatter so `recall` indexes it
without conversion:

```yaml
id: …
title: …
type: lesson
scope: commons
status: candidate | solution   # free-form label; the daemon does NOT compute it
topic_path: […]
tags: […]
recall_when: […]               # highest-weighted search field
summary: …
context:
  verified_in: "project (framework + version)"
verifications: []
```

Body sections: `Problem` / `Context` / `Failed paths` / `Solution (verified)` /
`Verified in`. Authored deliberately as a public engineering solution — **not**
extracted from your vault. Contributed by PR: CI checks schema, duplicates and
spam — humans never gatekeep truth, records do.

#### 2. Verification record — `verifications/<recipe-id>/<verifierHash>.json`

The smallest evidence unit (`commons.ts:69`):

```json
{ "recipe_id": "…", "result": "works" | "fails",
  "environment": { "os": "…", "arch": "…", "node": "…", "note": null },
  "verifier": "…", "date": "YYYY-MM-DD" }
```

One record per verifier+recipe, overwritten on opinion change (history lives in
git log). Written by `bastra commons verify <recipe-id> works|fails ["env note"]`,
which best-effort auto-submits a Mini-PR (branch, commit, `push --force-with-lease`,
`gh pr create`); if git/gh fail, the record stays local and the path is printed for
a manual PR. What the daemon actually does with these records is **rank**, not
status: at boot it tallies `works`/`fails` per recipe (`loadVerificationCounts`)
and feeds them into `commonsRankFactor` (`commons.ts:138`) — more independent
`works` nudge a recipe up (max +0.15), `fails` nudge it down, always inside the
`[0.5, 0.95]` clamp so a recipe can never outrank a personal hit nor vanish. The
`status` field above is a Commons-repo-side label, not a daemon-computed tier;
nothing in the daemon reads it.

#### 3. Bridge — `bridges/<lang>/*.json`

A language-tagged **vocabulary-expansion rule, NOT a memory** (`bridges.ts:33`):

```json
{ "id": "…", "lang": "de",
  "trigger_terms": ["…"], "expansion_terms": ["…"],
  "evidence": 1, "verifier": "…", "date": "…" }
```

`id` is a deterministic dedup hash of `lang` + sorted trigger + sorted expansion.
A bridge says: *"for a query in language L phrased with `trigger_terms`, also
search for `expansion_terms`"* — widening the BM25 surface so a far-worded query
reaches the memory the contributor proved it resolves to. The in-code privacy
contract (`bridges.ts:7`): **a bridge carries only term lists and a language —
never a memory id, body, or any vault content.** Language-partitioned: a bridge
fires only for a query detected as its language.

**Scope: the bridge layer is latin-alphabet only, by design.** Detection knows
two languages (`SUPPORTED_LANGUAGES = ["de", "en"]`,
`learned-recall/language.ts:20`) and `distinctiveTerms` tokenizes on
`/[^a-zäöüß0-9]+/i` (`learned-recall/bridges.ts:66`), so a query in Cyrillic,
Greek, CJK or any other non-latin script yields no trigger and no expansion
terms — nothing to mint from, nothing to fire. A mixed-language vault gets
bridges for its latin-query half and none for the rest. This affects **only**
vocabulary expansion: BM25 and `recall_when` index and match those queries
normally, so recall itself works — it just doesn't get the widening. Extending
the set means a stopword list per new language plus a tokenizer that keeps its
alphabet (#231).

Bridges are minted **locally and offline**, never on the recall hot path:
telemetry event log → `reconstructReaches` → `mintBridge` (query distinctive
terms = trigger; the resolved memory's distinctive terms not in the query =
expansion) → `writeBridges` into the clone. CLI: `bastra bridges mint [days]`
(in-band reaches) and `bastra bridges harvest [days]` (deep, local Ollama
reranker over the far slice). `bastra bridges contribute` is intentionally **not
yet wired**, and the reason is a gate rather than missing plumbing: minting works,
but a harvested bridge is scored by the same judge that mints it, its only way
down is a local outcome check (below, not a held-out lift measurement), and fires on *any* query sharing one trigger term —
so one mint perturbs every query that shares it. Contribution waits on **#129**: a
verification contract with measured lift over a held-out set, a near-slice
regression guard, and a demotion driven by that measurement (the local outcome check below is a first step). (The older note here cited #121; that
issue closed 2026-06-16 and was never the real blocker.)

**What a bridge learns from (#704).** Only queries someone phrased as a question
count as reaches, for the in-band mint and the far harvest alike: prompts the
owner typed (prompt lane) and explicit MCP `recall` calls. Queries the tool lanes
build from tool input (write, bash, todo, session, stop) and harness turns that
reach the prompt lane as if typed (`<task-notification`, `<teammate-message`,
`<agent-message`, `<cross-session-message`, `[Subagent hand-back]`, `Another
Claude session sent a message`) do not. The origin is read from an explicit
`origin` field on the event when there is one, else from that text check, else
from the lane (`dimensions.hook_source`, on older rows `tool_name`); a row that
names no lane at all does not count. A small stoplist of machine vocabulary
(`toolu`, `task`, `notification`, `home`, `users`, `claude` — tool ids and home
paths, not a language list) never becomes a trigger term, and a query made mostly
of it mints nothing. A local bridge minted before this rule whose trigger is
mostly machine vocabulary is moved to `bridges/archive/<lang>/` on the next mint
pass, with a line in `bridges/archive/log.jsonl`; moving the file back restores it.

**Evidence and decay (#672).** A bridge is written on its **first** reach
(`MIN_BRIDGE_EVIDENCE = 1`); until a second, independent reach confirms it
(`CONFIRMED_BRIDGE_EVIDENCE = 2`) it is *unconfirmed*:

- It widens a query only at reduced weight: at least half of its trigger terms
  must appear in the query (never fewer than two), it adds at most 3 expansion
  terms, and confirmed bridges are consulted first.
- It carries a `first_seen` timestamp (the earliest reach behind it). If no second
  reach arrives within `UNCONFIRMED_BRIDGE_TTL_DAYS = 30`, the next mint pass
  (daemon boot + daily, or `bastra bridges mint`) deletes it.
- A confirmed bridge never expires by age, and a rewrite never lowers its `evidence`.
- Only bridges this machine minted can be unconfirmed and live: a contributed
  bridge (with `verifier`) and old evidence-1 files without `first_seen` still need
  confirmation and are never pruned.

**Demotion (#129).** A bridge, confirmed or not, that keeps firing without leading
anywhere loses its weight and then leaves the pool. Each mint pass counts, per local
bridge, its fires (recalls whose `bridge_expansion` it contributed to) and the
outcomes of those recalls (an acted-on `recall_episode`, or a `load_memory` whose
`follows_recall` / `from_hook_recall` names the recall):

- `DEMOTION_MIN_FIRES = 20` or more fires in `DEMOTION_WINDOW_DAYS = 30` and no
  outcome → the bridge gets a `demoted_at` stamp and widens a query only at the
  unconfirmed weight above. Its `evidence` stays as it was.
- An outcome after the stamp clears it.
- Still no outcome a full window after the stamp, and it fired again → the file moves
  to `bridges/archive/<lang>/` (not deleted; moving it back restores it), and the
  mint does not write it again from reaches still in the log. A demoted bridge
  that stopped firing stays demoted.
- Every step writes a line to `bridges/archive/log.jsonl`. Contributed bridges are
  never changed.

The log names the terms an expansion added, not the bridge, and it cannot tell
which hit a bridge brought in: a fire is attributed from the query and the added
terms, and any load after that recall counts as the bridge's outcome. Both errors
lean toward keeping a bridge. This is a local way down, not the held-out lift and
regression gate #129 asks for before contribution.

`bastra doctor` shows a **learned bridges** note while shared recall is on: it warns
when no mint ran in 30 days, when mint runs produced candidates but wrote none, or
when no acted-on recall reached the telemetry log, and adds a line when bridges were
demoted or archived in the last 30 days.

### What stays private

Your personal memories never leave the machine — the clone is read-only and the
daemon never writes the synced repo. Before any bridge *could* be contributed,
`scrubBridge` (`bridges.ts:142`) drops every term that looks sensitive
(`LOOKS_SENSITIVE`, `bridges.ts:124`):

- any digit (`\d`) → ids, versions, dates, ticket numbers
- any path/email/url separator (`[/\\.@:]`)
- snake_case identifiers (`_`)
- hex hashes (`^[a-f0-9]{8,}$`)
- terms longer than `MAX_SHARE_TERM_LEN` (24)

If fewer than 1 trigger or fewer than `MIN_SHARE_TERMS` (2) expansion terms
survive, the bridge is **not shared** (returns `null`). By construction a bridge
already holds only lowercase distinctive terms (≥4 chars, stopwords filtered) plus
a language and an evidence count. Defense-in-depth on the **read** side too
(`bridges.ts:182`): the loader caps term length on the foreign clone so a hostile
bridge can't inject an oversized token into your query.

The local bridge pool and the contribution path are independent — toggling
`sharedRecall` off means neither the pool nor any contribution runs. Even enabled,
with no cloned `bridges/` dir the pool is empty and the layer is a deliberate
no-op (`expandQuery` returns the query untouched).

**The scrub is explicitly best-effort — the real guarantee is the PR review gate**
(`bridges.ts:18`): a human sees every contributed recipe, verification, and bridge.

### Pseudonymity

The verifier id is `sha256(git user.email).slice(0, 12)` (`commons.ts:100`), used
as the verification filename and the bridge `verifier`. Your real name appears only
in the PR; the hash just makes filenames deterministic (one record per
user+solution).

### CLI quick reference

```bash
bastra commons enable      # clone read-only + flip commons.enabled (restart daemon)
bastra commons update      # git pull --ff-only the clone
bastra commons disable     # flip toggle off (clone kept)
bastra commons status      # enabled-state + clone presence
bastra commons verify <recipe-id> works|fails ["env note"]   # record + best-effort PR

bastra bridges enable      # flip sharedRecall.enabled (needs commons cloned first)
bastra bridges language <tag|auto>   # query-language override (default: auto-detect)
bastra bridges mint [days] # mint bridges from in-band reaches
bastra bridges harvest [days]        # deep harvest via local reranker
bastra bridges status      # enabled-state, pool size per language, repo path
```

### Licensing

Recipe **texts**: CC BY 4.0 (reuse freely, credit authors). Code **snippets**
inside recipes: CC0 1.0 (paste into any codebase, no attribution).

### Key files

- `packages/daemon/src/cli/commons.ts` — enable/update/verify, rank factor, verifier id
- `packages/daemon/src/cli/bridges.ts` — bridges CLI (enable/mint/harvest/contribute)
- `packages/daemon/src/learned-recall/bridges.ts` — Bridge type, mint, scrub, pool
- `packages/daemon/src/learned-recall/harvest.ts` — reach reconstruction + harvest
- `packages/daemon/src/settings.ts` — `getCommonsEnabled` / `getSharedRecallEnabled`
- `packages/daemon/src/tool-handlers.ts:244` — recall fusion + id-collision rule

<a id="deutsch"></a>

## Deutsch

Bastra Commons ist ein **separates, optionales, standardmäßig ausgeschaltetes, per PR abgesichertes öffentliches Git-Repo** mit von der Community erprobten Engineering-Rezepten — **niemals dein privater Vault**. Das Lesen läuft nur in eine Richtung und nur lesend; jeder Beitrag durchläuft einen von Menschen geprüften PR. Es gibt
**keinen automatischen Datenabfluss**: Nichts verlässt deinen Rechner ohne einen ausdrücklichen, geprüften PR.

Standard-Repo: `https://github.com/n0mad-ai/bastra-commons`. Standard-Klonpfad:
`~/.bastra/commons` (überschreibbar mit `BASTRA_COMMONS_PATH`).

`BASTRA_COMMONS_REPO` richtet den Klon und den Beitrags-PR auf ein anderes
Repo aus. Die Variable ist **per Allowlist beschränkt** (#260): Standardmäßig wird nur `github.com/n0mad-ai/…` akzeptiert; alles andere — ein anderer Host, ein anderer Owner, ein lokaler Pfad,
ein nicht auswertbarer Wert — wird vor dem Klonen und vor dem Push abgelehnt, weil
der Beitragsweg genau gegen dieses Ziel einen PR öffnet und deine
Verifikationsdatensätze dorthin schicken würde. Willst du bewusst ein anderes Ziel nutzen, setze
`BASTRA_ALLOW_REMOTE_COMMONS=1`; dann gibt jeder Klon und jede Einreichung das
überschriebene Ziel jedes Mal in einer Zeile aus.

### Wie es an Recall angebunden ist

`bastra commons enable` klont das Repo per Git (`--depth 1`) und setzt
`commons.enabled` in `~/.bastra/cli-settings.json`. Beim nächsten Daemon-Start wird der
Klon **nur lesend** als zweiter BM25-Index geladen; seine Treffer fließen unter `scope: commons` in
`recall` ein und stehen im Ranking **direkt unter** deinen persönlichen Erinnerungen.

- Rang: `commonsRankFactor` = Basiswert `0.8`, erhöht durch unabhängige `works`
  (bis zu +0.15), gesenkt durch `fails`, begrenzt auf `[0.5, 0.95]`
  (`packages/daemon/src/cli/commons.ts:138`). Ein Rezept kann nie über einem
  persönlichen Treffer landen und auch nie ganz verschwinden.
- Bei einer **ID-Kollision** gewinnt die persönliche Erinnerung — der Commons-Treffer wird verworfen
  (`packages/daemon/src/tool-handlers.ts:244`).
- Der Daemon **schreibt NIE** in den Klon. Optional, wirksam nach Neustart, nur lesend.

Zwei geteilte Ebenen liegen im **selben Klon**, jede mit eigenem Schalter:

| Ebene | Pfad | Schalter | CLI |
|---|---|---|---|
| Rezepte + Verifikationen | `recipes/`, `verifications/` | `commons.enabled` | `bastra commons` |
| Bridges (geteilter Learned-Recall, #120) | `bridges/<lang>/*.json` | `sharedRecall.enabled` | `bastra bridges` |

Beide sind standardmäßig AUS; beide werden erst nach einem Daemon-Neustart wirksam. `commons.enabled`
ist standardmäßig `false` (`settings.ts:235`); `sharedRecall.enabled` ist standardmäßig `false`
(`settings.ts:245`). Bridges liegen *innerhalb* des Commons-Klons, daher schaltet `bastra bridges
enable` nur den Schalter um — um das Repo tatsächlich zu klonen, brauchst du weiterhin `bastra commons enable`.

### Was geteilt wird

Drei Artefaktarten. **Keine davon enthält private Vault-Inhalte** — keine Erinnerungstexte
und (bei Bridges) keine Erinnerungs-IDs.

#### 1. Rezept — `recipes/<domain>/<slug>.md`

Eine Markdown-Datei mit bastra-memory-kompatiblem Frontmatter, sodass `recall` sie
ohne Umwandlung indiziert:

```yaml
id: …
title: …
type: lesson
scope: commons
status: candidate | solution   # free-form label; the daemon does NOT compute it
topic_path: […]
tags: […]
recall_when: […]               # highest-weighted search field
summary: …
context:
  verified_in: "project (framework + version)"
verifications: []
```

Abschnitte im Text: `Problem` / `Context` / `Failed paths` / `Solution (verified)` /
`Verified in`. Bewusst als öffentliche Engineering-Lösung verfasst — **nicht**
aus deinem Vault extrahiert. Beigetragen per PR: CI prüft Schema, Duplikate und
Spam — nicht Menschen entscheiden über die Wahrheit, sondern Datensätze.

#### 2. Verifikationsdatensatz — `verifications/<recipe-id>/<verifierHash>.json`

Die kleinste Nachweiseinheit (`commons.ts:69`):

```json
{ "recipe_id": "…", "result": "works" | "fails",
  "environment": { "os": "…", "arch": "…", "node": "…", "note": null },
  "verifier": "…", "date": "YYYY-MM-DD" }
```

Ein Datensatz pro Verifizierer und Rezept; bei geänderter Einschätzung wird er überschrieben (die Historie steht im
Git-Log). Geschrieben von `bastra commons verify <recipe-id> works|fails ["env note"]`,
das nach bestem Bemühen automatisch einen Mini-PR einreicht (Branch, Commit, `push --force-with-lease`,
`gh pr create`); schlagen git/gh fehl, bleibt der Datensatz lokal und der Pfad wird für
einen manuellen PR ausgegeben. Was der Daemon tatsächlich mit diesen Datensätzen macht, ist **Ranking**, nicht
Status: Beim Start zählt er `works`/`fails` pro Rezept (`loadVerificationCounts`)
und speist sie in `commonsRankFactor` (`commons.ts:138`) ein — mehr unabhängige
`works` schieben ein Rezept etwas nach oben (max. +0.15), `fails` schieben es nach unten, immer innerhalb der
Begrenzung `[0.5, 0.95]`, sodass ein Rezept nie über einem persönlichen Treffer landet und nie verschwindet. Das
obige Feld `status` ist ein Label auf Seite des Commons-Repos, keine vom Daemon berechnete Stufe;
nichts im Daemon liest es.

#### 3. Bridge — `bridges/<lang>/*.json`

Eine sprachmarkierte **Regel zur Vokabularerweiterung, KEINE Erinnerung** (`bridges.ts:33`):

```json
{ "id": "…", "lang": "de",
  "trigger_terms": ["…"], "expansion_terms": ["…"],
  "evidence": 1, "verifier": "…", "date": "…" }
```

`id` ist ein deterministischer Deduplizierungs-Hash aus `lang` + sortierten Trigger- + sortierten Erweiterungsbegriffen.
Eine Bridge sagt: *„Bei einer Anfrage in Sprache L, die mit `trigger_terms` formuliert ist, suche auch
nach `expansion_terms`"* — das verbreitert die BM25-Suchfläche, sodass eine weit entfernt formulierte Anfrage
die Erinnerung erreicht, zu der sie laut Nachweis des Beitragenden führt. Der Datenschutzvertrag im Code
(`bridges.ts:7`): **Eine Bridge enthält nur Begriffslisten und eine Sprache —
niemals eine Erinnerungs-ID, einen Erinnerungstext oder sonstige Vault-Inhalte.** Nach Sprache getrennt: Eine Bridge
greift nur bei einer Anfrage, die als ihre Sprache erkannt wurde.

**Umfang: Die Bridge-Ebene ist bewusst auf das lateinische Alphabet beschränkt.** Die Erkennung kennt
zwei Sprachen (`SUPPORTED_LANGUAGES = ["de", "en"]`,
`learned-recall/language.ts:20`), und `distinctiveTerms` zerlegt an
`/[^a-zäöüß0-9]+/i` (`learned-recall/bridges.ts:66`). Eine Anfrage in kyrillischer,
griechischer, CJK- oder einer anderen nicht-lateinischen Schrift liefert daher keine Trigger- und keine Erweiterungsbegriffe
— nichts, woraus eine Bridge entstehen oder was sie auslösen könnte. Ein gemischtsprachiger Vault bekommt
Bridges für seine Hälfte mit lateinischen Anfragen und für den Rest keine. Das betrifft **nur**
die Vokabularerweiterung: BM25 und `recall_when` indizieren und matchen diese Anfragen
normal, Recall selbst funktioniert also — es fehlt nur die Verbreiterung. Den Umfang zu erweitern
bedeutet eine Stoppwortliste pro neuer Sprache plus einen Tokenizer, der deren
Alphabet erhält (#231).

Bridges werden **lokal und offline** erzeugt, nie im heißen Pfad von Recall:
Telemetrie-Ereignisprotokoll → `reconstructReaches` → `mintBridge` (markante Begriffe der Anfrage
= Trigger; markante Begriffe der gefundenen Erinnerung, die nicht in der Anfrage stehen =
Erweiterung) → `writeBridges` in den Klon. CLI: `bastra bridges mint [days]`
(In-Band-Treffer) und `bastra bridges harvest [days]` (gründlich, mit lokalem Ollama-Reranker
über den fernen Teil). `bastra bridges contribute` ist absichtlich **noch
nicht angebunden**, und der Grund ist eine Sperre, keine fehlende Verkabelung: Das Erzeugen funktioniert,
aber eine geerntete Bridge wird von demselben Bewerter beurteilt, der sie erzeugt, ihr
einziger Weg nach unten ist eine lokale Ergebnisprüfung (unten, keine Messung auf einem
zurückgehaltenen Testset), und greift bei *jeder* Anfrage, die einen Triggerbegriff teilt —
eine einzige erzeugte Bridge verändert also jede Anfrage, die diesen Begriff enthält. Beiträge warten auf **#129**: einen
Verifikationsvertrag mit gemessener Verbesserung auf einem zurückgehaltenen Testset, einen Regressionsschutz für den nahen Teil
und eine Abwertung, die sich auf diese Messung stützt (die lokale Ergebnisprüfung unten ist ein erster Schritt). (Der ältere Hinweis an dieser Stelle nannte #121; dieses
Issue wurde am 2026-06-16 geschlossen und war nie der eigentliche Blocker.)

**Woraus eine Bridge lernt (#704).** Als Treffer zählen nur Anfragen, die jemand als
Frage formuliert hat, beim In-Band-Erzeugen wie bei der fernen Ernte: Prompts, die der
Besitzer getippt hat (Prompt-Lane), und ausdrückliche MCP-`recall`-Aufrufe. Anfragen,
die die Tool-Lanes aus Tool-Eingaben bauen (write, bash, todo, session, stop), und
Harness-Turns, die wie getippt in der Prompt-Lane ankommen (`<task-notification`,
`<teammate-message`, `<agent-message`, `<cross-session-message`, `[Subagent
hand-back]`, `Another Claude session sent a message`), zählen nicht. Der Ursprung
kommt aus einem ausdrücklichen Feld `origin` am Ereignis, falls vorhanden, sonst aus
dieser Textprüfung, sonst aus der Lane (`dimensions.hook_source`, bei älteren Zeilen
`tool_name`); eine Zeile ohne jede Lane-Angabe zählt nicht. Eine kleine Stoppliste für
Maschinenvokabular (`toolu`, `task`, `notification`, `home`, `users`, `claude` —
Tool-IDs und Home-Pfade, keine Sprachliste) wird nie zum Triggerbegriff, und eine
Anfrage, die überwiegend daraus besteht, erzeugt nichts. Eine lokale Bridge von vor
dieser Regel, deren Trigger überwiegend Maschinenvokabular ist, verschiebt der nächste
Erzeugungslauf nach `bridges/archive/<lang>/`, mit einer Zeile in
`bridges/archive/log.jsonl`; die Datei zurückzuschieben stellt sie wieder her.

**Belege und Verfall (#672).** Eine Bridge wird schon beim **ersten** Treffer
geschrieben (`MIN_BRIDGE_EVIDENCE = 1`); bis ein zweiter, unabhängiger Treffer sie
bestätigt (`CONFIRMED_BRIDGE_EVIDENCE = 2`), gilt sie als *unbestätigt*:

- Sie erweitert eine Anfrage nur mit geringerem Gewicht: Mindestens die Hälfte ihrer
  Triggerbegriffe muss in der Anfrage stehen (nie weniger als zwei), sie fügt höchstens
  3 Erweiterungsbegriffe hinzu, und bestätigte Bridges kommen zuerst an die Reihe.
- Sie trägt einen Zeitstempel `first_seen` (der früheste Treffer dahinter). Kommt
  innerhalb von `UNCONFIRMED_BRIDGE_TTL_DAYS = 30` Tagen kein zweiter Treffer, löscht
  der nächste Erzeugungslauf (Daemon-Start + täglich, oder `bastra bridges mint`) sie.
- Eine bestätigte Bridge verfällt nie durch Alter, und ein erneutes Schreiben senkt ihr `evidence` nie.
- Unbestätigt und trotzdem aktiv können nur Bridges sein, die dieser Rechner selbst
  erzeugt hat: Eine beigetragene Bridge (mit `verifier`) und alte Dateien mit
  `evidence` 1 ohne `first_seen` brauchen weiter eine Bestätigung und werden nie gelöscht.

**Abwertung (#129).** Eine Bridge, bestätigt oder nicht, die immer wieder greift, ohne
dass daraus etwas folgt, verliert ihr Gewicht und verlässt danach den Pool. Jeder
Erzeugungslauf zählt pro lokaler Bridge ihre Auslösungen (Recalls, zu deren
`bridge_expansion` sie beigetragen hat) und deren Ergebnisse (ein `recall_episode` mit
`acted_on` oder ein `load_memory`, dessen `follows_recall` / `from_hook_recall` diesen
Recall nennt):

- `DEMOTION_MIN_FIRES = 20` oder mehr Auslösungen in `DEMOTION_WINDOW_DAYS = 30` Tagen
  und kein Ergebnis → die Bridge bekommt einen Stempel `demoted_at` und erweitert eine
  Anfrage nur noch mit dem Gewicht einer unbestätigten Bridge (siehe oben). Ihr
  `evidence` bleibt, wie es war.
- Ein Ergebnis nach dem Stempel entfernt ihn wieder.
- Ein volles Fenster nach dem Stempel noch immer kein Ergebnis, und sie hat wieder
  gegriffen → die Datei wandert nach `bridges/archive/<lang>/` (nicht gelöscht;
  zurückschieben stellt sie wieder her), und das Erzeugen schreibt sie aus Treffern,
  die noch im Protokoll stehen, nicht neu. Eine abgewertete Bridge, die nicht mehr
  greift, bleibt abgewertet.
- Jeder Schritt schreibt eine Zeile nach `bridges/archive/log.jsonl`. Beigetragene
  Bridges werden nie verändert.

Das Protokoll nennt die Begriffe, die eine Erweiterung hinzugefügt hat, nicht die
Bridge, und es kann nicht sagen, welchen Treffer eine Bridge hereingebracht hat: Eine
Auslösung wird aus Anfrage und hinzugefügten Begriffen zugeordnet, und jedes Laden nach
diesem Recall zählt als Ergebnis der Bridge. Beide Fehler fallen zugunsten der Bridge
aus. Das ist ein lokaler Weg nach unten, nicht die Messung auf einem zurückgehaltenen
Testset mit Regressionsschutz, die #129 vor Beiträgen verlangt.

`bastra doctor` zeigt bei eingeschaltetem Shared Recall einen Abschnitt **learned
bridges**: Er warnt, wenn 30 Tage lang kein Erzeugungslauf lief, wenn Läufe Kandidaten
erzeugt, aber keine geschrieben haben, oder wenn kein genutzter Recall im
Telemetrie-Protokoll ankam, und ergänzt eine Zeile, wenn in den letzten 30 Tagen
Bridges abgewertet oder archiviert wurden.

### Was privat bleibt

Deine persönlichen Erinnerungen verlassen nie den Rechner — der Klon ist nur lesbar und der
Daemon schreibt nie in das synchronisierte Repo. Bevor überhaupt eine Bridge beigetragen werden *könnte*,
entfernt `scrubBridge` (`bridges.ts:142`) jeden Begriff, der sensibel aussieht
(`LOOKS_SENSITIVE`, `bridges.ts:124`):

- jede Ziffer (`\d`) → IDs, Versionen, Daten, Ticketnummern
- jedes Pfad-, E-Mail- oder URL-Trennzeichen (`[/\\.@:]`)
- snake_case-Bezeichner (`_`)
- Hex-Hashes (`^[a-f0-9]{8,}$`)
- Begriffe, die länger als `MAX_SHARE_TERM_LEN` (24) sind

Bleiben weniger als 1 Trigger oder weniger als `MIN_SHARE_TERMS` (2) Erweiterungsbegriffe
übrig, wird die Bridge **nicht geteilt** (Rückgabe `null`). Konstruktionsbedingt enthält eine Bridge
ohnehin nur kleingeschriebene markante Begriffe (≥4 Zeichen, Stoppwörter gefiltert) plus
eine Sprache und einen Nachweiszähler. Mehrschichtige Absicherung auch auf der **Lese**seite
(`bridges.ts:182`): Der Loader begrenzt die Begriffslänge im fremden Klon, damit eine böswillige
Bridge kein übergroßes Token in deine Anfrage einschleusen kann.

Der lokale Bridge-Pool und der Beitragsweg sind unabhängig voneinander — ist
`sharedRecall` ausgeschaltet, läuft weder der Pool noch irgendein Beitrag. Selbst wenn es eingeschaltet ist,
ist der Pool ohne geklontes `bridges/`-Verzeichnis leer und die Ebene bewusst
wirkungslos (`expandQuery` gibt die Anfrage unverändert zurück).

**Die Bereinigung erfolgt ausdrücklich nur nach bestem Bemühen — die eigentliche Garantie ist die PR-Prüfung**
(`bridges.ts:18`): Ein Mensch sieht jedes beigetragene Rezept, jede Verifikation und jede Bridge.

### Pseudonymität

Die Verifizierer-ID ist `sha256(git user.email).slice(0, 12)` (`commons.ts:100`) und dient
als Dateiname der Verifikation und als `verifier` der Bridge. Dein echter Name erscheint nur
im PR; der Hash macht lediglich die Dateinamen deterministisch (ein Datensatz pro
Nutzer und Lösung).

### CLI-Kurzreferenz

```bash
bastra commons enable      # clone read-only + flip commons.enabled (restart daemon)
bastra commons update      # git pull --ff-only the clone
bastra commons disable     # flip toggle off (clone kept)
bastra commons status      # enabled-state + clone presence
bastra commons verify <recipe-id> works|fails ["env note"]   # record + best-effort PR

bastra bridges enable      # flip sharedRecall.enabled (needs commons cloned first)
bastra bridges language <tag|auto>   # query-language override (default: auto-detect)
bastra bridges mint [days] # mint bridges from in-band reaches
bastra bridges harvest [days]        # deep harvest via local reranker
bastra bridges status      # enabled-state, pool size per language, repo path
```

### Lizenzierung

Rezept-**Texte**: CC BY 4.0 (frei wiederverwendbar, Autoren nennen). Code-**Snippets**
in Rezepten: CC0 1.0 (in jede Codebasis einfügbar, ohne Namensnennung).

### Wichtige Dateien

- `packages/daemon/src/cli/commons.ts` — enable/update/verify, Rangfaktor, Verifizierer-ID
- `packages/daemon/src/cli/bridges.ts` — Bridges-CLI (enable/mint/harvest/contribute)
- `packages/daemon/src/learned-recall/bridges.ts` — Bridge-Typ, Erzeugen, Bereinigen, Pool
- `packages/daemon/src/learned-recall/harvest.ts` — Rekonstruktion der Treffer + Ernte
- `packages/daemon/src/settings.ts` — `getCommonsEnabled` / `getSharedRecallEnabled`
- `packages/daemon/src/tool-handlers.ts:244` — Recall-Fusion + ID-Kollisionsregel
