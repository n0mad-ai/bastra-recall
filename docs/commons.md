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

**Where the local pool lives (#648).** Bridges this machine mints — `bridges/`
and `last-mint.json` — are per-box state and live in `~/.bastra/bridges`
(override with `BASTRA_BRIDGES_PATH`), outside the Commons checkout, so a
`git pull` of the clone never collides with them. Before #648 they sat in the
Commons root. The first daemon start (or `bastra bridges …` command) after the
upgrade copies an existing `<commons>/bridges` and `last-mint.json` to the new
directory once; the originals stay where they were, so moving them aside or
deleting them is up to you. The copy runs only while `~/.bastra/bridges/bridges`
does not exist yet, so it never overwrites a pool minted there. Setting
`BASTRA_BRIDGES_PATH` to the Commons root keeps the old layout.

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
A bridge says: *"for a query phrased with `trigger_terms`, also
search for `expansion_terms`"* — widening the BM25 surface so a far-worded query
reaches the memory the contributor proved it resolves to. The in-code privacy
contract (`bridges.ts:7`): **a bridge carries only term lists and a language —
never a memory id, body, or any vault content.**

**The language is a folder, not a gate (#707).** Detection knows two languages
(`SUPPORTED_LANGUAGES = ["de", "en"]`, `learned-recall/language.ts`); a query
in any other language, or one detection abstains on, is filed under `und`
(BCP-47 "undetermined"). Without a configured override (`bastra bridges
language`) a query consults every folder — the trigger rule (two shared
trigger terms) decides, and trigger terms are words of the language they were
minted from. `distinctiveTerms` keeps every letter and combining mark
(`\p{L}\p{M}\p{N}`), so Cyrillic, Greek, Turkish or Devanagari queries mint
and fire like German and English ones. Remaining gap: scripts written without
spaces (Chinese, Japanese, Thai) have no word segmentation, so a sentence is one
long term and rarely makes a useful trigger — noted in #707.

Bridges are minted **locally and offline**, never on the recall hot path:
telemetry event log → `reconstructReaches` → `mintBridge` (query distinctive
terms = trigger; the resolved memory's distinctive terms not in the query =
expansion) → `writeBridges` into `~/.bastra/bridges` (#648). CLI: `bastra bridges mint [days]`
(in-band reaches) and `bastra bridges harvest [days]` (deep, local Ollama
reranker over the far slice). Both record each run as a `bridges_mint`
telemetry event (the harvest with `trigger: "cli-harvest"`), which the bridge
note in `bastra doctor` reads. A harvested bridge is scored by the same judge that
mints it, and it fires on *any* query sharing two of its trigger terms (all of them
for a one-term bridge; an unconfirmed bridge needs half its terms, never fewer than
two) — so one mint perturbs every query that shares them. That is why
`bastra bridges contribute` only offers bridges that pass the **held-out check
(#129, below)**.

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
(`CONFIRMED_BRIDGE_EVIDENCE = 2`) it is *unconfirmed*. `evidence` counts
**independent occasions** (#129), not reaches: the caller's session
(`dimensions.experiment_session`), else the UTC day of the reach. The same question
asked again in one session is one confirmation; a row with neither session nor
timestamp confirms nothing.

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
lean toward keeping a bridge. This is the local way down; the held-out check below
is the gate for contribution.

**Held-out check and contribution gate (#129).** `bastra bridges verify [days]`
measures, and `bastra bridges contribute [days]` measures and stages
(`learned-recall/verify.ts`):

- **Cases** come from the #121 candidate-pool log: every logged recall with a pool
  and an outcome (an acted-on episode, else a found load after it). The outcome is
  the gold memory. A case is **near** when the gold already ranks in the top 5
  (`SERVING_K`) without any bridge, else **far**; a far case is **in-pool** when the
  gold was in the logged candidate pool and **out-of-pool** when it was not.
- **Folds:** hash(query) → one of 5 folds (`VERIFY_FOLDS`), so a query and its
  repeats share a fold. For each fold the bridges are minted from the reaches of the
  other folds (the normal mint), then measured on this fold's cases only.
- **Lift:** for each held-out case a bridge fires on (the recall path's own
  `expansionsFor`, at the weight a contributed bridge would have), the change in
  reciprocal rank of the gold when its terms are added, on the vault's BM25 index.
  A near case pushed out of the top 5 is a regression.
- **Null arm:** the same trigger with another bridge's expansion terms. Lift that a
  foreign expansion also produces is query-length inflation, not direction.

A local bridge may be contributed only when every rule holds: not demoted;
confirmed (evidence from ≥ 2 independent occasions); it fired on at least one
held-out case; held-out lift ≥ 0 in **every** slice it fired on (an out-of-pool loss
cannot hide behind an in-pool gain); no near case pushed out of the top 5; lift not
below the null arm. `verify` prints the pool-level slices and a verdict per local
bridge with the reasons; `contribute` also writes the passing bridges, scrubbed and
signed with the pseudonymous `verifier`, to `~/.bastra/bridges/contribute/<lang>/`
for a reviewed PR to the Commons repo. Nothing is pushed automatically. Only
confirmed, undemoted local bridges are measured one by one (on a 924-case log the
check takes about a minute); the pool level always runs every fold's bridges.

Not covered: bridges from `bastra bridges harvest` (Teacher 2) are minted by the
reranker, which the k-fold does not rerun (an LLM pass per fold), so they stay
unmeasured and are not offered.

`bastra doctor` shows a **learned bridges** note while shared recall is on: it warns
when no mint ran in 30 days, when mint runs produced candidates but wrote none, or
when no acted-on recall reached the telemetry log, and adds a line when bridges were
demoted or archived in the last 30 days. Its last line says whether query expansion
is live or shadow.

**Query expansion is shadow by default (owner decision 2026-09-29).** With shared
recall on, a firing bridge does NOT widen the query unless `sharedRecall.live` is
`true` (`bastra bridges live on`, then restart the daemon). In shadow the fire is
still recorded — `bridge_expansion` on `recall`/`hook_recall` carries the terms it
would add with `applied: false` — and the ranking is exactly the one without
bridges; shadow fires do not count toward demotion. Why: on the maintainer's log
(28.09.) the pooled bridges pushed 100 of 495 near hits out of the top 5, and 0 of
47 local bridges pass `bastra bridges verify`. Switch live on once a bridge passes
verify.

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
bastra bridges language <tag|auto>   # query-language override (default: auto — every folder)
bastra bridges live <on|off>         # let bridges widen the query (default off: shadow, logged only)
bastra bridges mint [days] # mint bridges from in-band reaches
bastra bridges harvest [days]        # deep harvest via local reranker
bastra bridges verify [days]         # held-out check (#129), verdict per local bridge
bastra bridges contribute [days]     # same check, stages passing bridges for a PR
bastra bridges status      # enabled-state, query expansion live/shadow, pool size per language, repo path
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

**Wo der lokale Pool liegt (#648).** Bridges, die dieser Rechner erzeugt — `bridges/`
und `last-mint.json` —, sind rechnerbezogener Zustand und liegen in `~/.bastra/bridges`
(überschreibbar mit `BASTRA_BRIDGES_PATH`), außerhalb des Commons-Klons, damit ein
`git pull` des Klons nie mit ihnen kollidiert. Vor #648 lagen sie im Commons-Wurzelverzeichnis.
Der erste Daemon-Start (oder `bastra bridges …`-Befehl) nach dem Update kopiert ein
vorhandenes `<commons>/bridges` und `last-mint.json` einmalig in das neue Verzeichnis; die
Originale bleiben liegen, ob du sie wegräumst oder löschst, entscheidest du. Die Kopie
läuft nur, solange `~/.bastra/bridges/bridges` noch nicht existiert, überschreibt also nie
einen dort erzeugten Pool. Wer `BASTRA_BRIDGES_PATH` auf das Commons-Verzeichnis setzt,
behält das alte Layout.

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
Eine Bridge sagt: *„Bei einer Anfrage, die mit `trigger_terms` formuliert ist, suche auch
nach `expansion_terms`"* — das verbreitert die BM25-Suchfläche, sodass eine weit entfernt formulierte Anfrage
die Erinnerung erreicht, zu der sie laut Nachweis des Beitragenden führt. Der Datenschutzvertrag im Code
(`bridges.ts:7`): **Eine Bridge enthält nur Begriffslisten und eine Sprache —
niemals eine Erinnerungs-ID, einen Erinnerungstext oder sonstige Vault-Inhalte.**

**Die Sprache ist ein Ordner, keine Sperre (#707).** Die Erkennung kennt zwei Sprachen
(`SUPPORTED_LANGUAGES = ["de", "en"]`, `learned-recall/language.ts`); eine Anfrage in
jeder anderen Sprache, oder eine, bei der die Erkennung sich enthält, wird unter `und`
(BCP-47 „unbestimmt") abgelegt. Ohne eingestellte Vorgabe (`bastra bridges language`)
fragt eine Anfrage alle Ordner ab — es entscheidet die Trigger-Regel (zwei gemeinsame
Triggerbegriffe), und Triggerbegriffe sind Wörter der Sprache, aus der sie entstanden sind.
`distinctiveTerms` behält jeden Buchstaben und jedes kombinierende Zeichen
(`\p{L}\p{M}\p{N}`), sodass kyrillische, griechische, türkische oder Devanagari-Anfragen
Bridges erzeugen und auslösen wie deutsche und englische. Offene Lücke: Schriften ohne
Leerzeichen (Chinesisch, Japanisch, Thai) haben keine Wortzerlegung, ein Satz ist dort ein
einziger langer Begriff und selten ein brauchbarer Trigger — in #707 vermerkt.

Bridges werden **lokal und offline** erzeugt, nie im heißen Pfad von Recall:
Telemetrie-Ereignisprotokoll → `reconstructReaches` → `mintBridge` (markante Begriffe der Anfrage
= Trigger; markante Begriffe der gefundenen Erinnerung, die nicht in der Anfrage stehen =
Erweiterung) → `writeBridges` nach `~/.bastra/bridges` (#648). CLI: `bastra bridges mint [days]`
(In-Band-Treffer) und `bastra bridges harvest [days]` (gründlich, mit lokalem Ollama-Reranker
über den fernen Teil). Beide protokollieren jeden Lauf als Telemetrie-Ereignis
`bridges_mint` (die Ernte mit `trigger: "cli-harvest"`), das der Bridge-Hinweis in
`bastra doctor` liest. Eine geerntete Bridge wird von demselben Bewerter beurteilt,
der sie erzeugt, und sie greift bei *jeder* Anfrage, die zwei ihrer Triggerbegriffe
teilt (bei einer Bridge mit nur einem Begriff alle; eine unbestätigte Bridge braucht
die Hälfte ihrer Begriffe, nie weniger als zwei) — eine einzige erzeugte Bridge
verändert also jede Anfrage, die diese Begriffe enthält. Deshalb bietet
`bastra bridges contribute` nur Bridges an, die die **Prüfung auf zurückgehaltenen
Fällen (#129, unten)** bestehen.

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
bestätigt (`CONFIRMED_BRIDGE_EVIDENCE = 2`), gilt sie als *unbestätigt*. `evidence`
zählt **unabhängige Gelegenheiten** (#129), nicht Treffer: die Session des Aufrufers
(`dimensions.experiment_session`), sonst den UTC-Tag des Treffers. Dieselbe Frage in
derselben Session noch einmal ist eine Bestätigung; eine Zeile ohne Session und ohne
Zeitstempel bestätigt nichts.

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
aus. Das ist der lokale Weg nach unten; die Prüfung unten ist die Sperre für Beiträge.

**Prüfung auf zurückgehaltenen Fällen und Beitragssperre (#129).**
`bastra bridges verify [days]` misst, `bastra bridges contribute [days]` misst und legt
bereit (`learned-recall/verify.ts`):

- **Fälle** kommen aus dem Kandidaten-Pool-Protokoll (#121): jeder protokollierte
  Recall mit Pool und Ergebnis (eine genutzte Episode, sonst ein gefundenes Laden
  danach). Das Ergebnis ist die Ziel-Erinnerung. Ein Fall ist **nah**, wenn das Ziel
  ohne Bridge schon unter den ersten 5 steht (`SERVING_K`), sonst **fern**; ein ferner
  Fall ist **im Pool**, wenn das Ziel im protokollierten Kandidaten-Pool lag, und
  **außerhalb des Pools**, wenn nicht.
- **Folds:** hash(Anfrage) → einer von 5 Folds (`VERIFY_FOLDS`), eine Anfrage und ihre
  Wiederholungen liegen also im selben Fold. Pro Fold werden die Bridges aus den
  Treffern der anderen Folds erzeugt (das normale Erzeugen) und nur an den Fällen
  dieses Folds gemessen.
- **Verbesserung:** Für jeden zurückgehaltenen Fall, bei dem eine Bridge greift (das
  `expansionsFor` des Recall-Pfads, mit dem Gewicht einer beigetragenen Bridge), die
  Änderung des reziproken Rangs des Ziels, wenn ihre Begriffe dazukommen, auf dem
  BM25-Index des Vaults. Ein naher Fall, der aus den ersten 5 fällt, ist eine
  Regression.
- **Null-Vergleich:** derselbe Trigger mit den Erweiterungsbegriffen einer anderen
  Bridge. Eine Verbesserung, die auch fremde Begriffe bringen, ist ein Längeneffekt
  der Anfrage, keine Richtung.

Eine lokale Bridge darf nur beigetragen werden, wenn alle Regeln gelten: nicht
abgewertet; bestätigt (Belege aus ≥ 2 unabhängigen Gelegenheiten); sie hat bei
mindestens einem zurückgehaltenen Fall gegriffen; Verbesserung ≥ 0 in **jedem** Teil,
in dem sie gegriffen hat (ein Verlust außerhalb des Pools versteckt sich nicht hinter
einem Gewinn im Pool); kein naher Fall aus den ersten 5 verdrängt; Verbesserung nicht
unter dem Null-Vergleich. `verify` zeigt die Teile auf Pool-Ebene und pro lokaler
Bridge ein Urteil mit Gründen; `contribute` schreibt die bestehenden Bridges zusätzlich
bereinigt und mit dem pseudonymen `verifier` nach `~/.bastra/bridges/contribute/<lang>/`,
für einen geprüften PR ans Commons-Repo. Automatisch gepusht wird nichts. Einzeln
gemessen werden nur bestätigte, nicht abgewertete lokale Bridges (bei einem Protokoll
mit 924 Fällen dauert die Prüfung etwa eine Minute); die Pool-Ebene läuft immer mit
allen Bridges eines Folds.

Nicht abgedeckt: Bridges aus `bastra bridges harvest` (Teacher 2) erzeugt der Reranker,
den der k-Fold nicht erneut laufen lässt (ein LLM-Lauf pro Fold); sie bleiben ungemessen
und werden nicht angeboten.

`bastra doctor` zeigt bei eingeschaltetem Shared Recall einen Abschnitt **learned
bridges**: Er warnt, wenn 30 Tage lang kein Erzeugungslauf lief, wenn Läufe Kandidaten
erzeugt, aber keine geschrieben haben, oder wenn kein genutzter Recall im
Telemetrie-Protokoll ankam, und ergänzt eine Zeile, wenn in den letzten 30 Tagen
Bridges abgewertet oder archiviert wurden. Die letzte Zeile sagt, ob die
Query-Erweiterung live oder im Schatten läuft.

**Query-Erweiterung standardmäßig im Schatten (Owner-Entscheid 29.09.2026).** Bei
eingeschaltetem Shared Recall erweitert eine feuernde Bridge die Anfrage NICHT, solange
`sharedRecall.live` nicht `true` ist (`bastra bridges live on`, danach Daemon neu
starten). Im Schatten wird das Feuern weiter protokolliert — `bridge_expansion` an
`recall`/`hook_recall` trägt die Terme, die sie ergänzen würde, mit `applied: false` —
und das Ranking ist genau das ohne Bridges; Schatten-Feuer zählen nicht für die
Abwertung. Grund: Im Log des Maintainers (28.09.) verdrängten die gepoolten Bridges
100 von 495 nahen Treffern aus den Top 5, und 0 von 47 lokalen Bridges bestehen
`bastra bridges verify`. Live erst einschalten, wenn eine Bridge verify besteht.

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
bastra bridges language <tag|auto>   # query-language override (default: auto — every folder)
bastra bridges live <on|off>         # let bridges widen the query (default off: shadow, logged only)
bastra bridges mint [days] # mint bridges from in-band reaches
bastra bridges harvest [days]        # deep harvest via local reranker
bastra bridges verify [days]         # held-out check (#129), verdict per local bridge
bastra bridges contribute [days]     # same check, stages passing bridges for a PR
bastra bridges status      # enabled-state, query expansion live/shadow, pool size per language, repo path
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
