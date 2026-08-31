# Codex-Übergabe Nr. 5: Gegenreview 07ee4c0..HEAD

**Stand:** 28. August 2026
**Prüfumfang:** `07ee4c0..HEAD` (Stand beim Übergeben: ______, zuletzt gesehen `f43904a`)
**Vorherige Übergaben:** [Nr. 1](2026-08-28-handover-codex-1.md), [Nr. 2](2026-08-28-handover-codex-2.md), [Nr. 3](2026-08-28-handover-codex-3.md), [Nr. 4](2026-08-28-handover-codex-4.md) (`f780cae..07ee4c0`)
**Prüfregel:** P0 wird sofort gefixt, alles andere wird Issue

> Die kürzeste Übergabe der Strecke: ein Commit. Er ist trotzdem eigen, weil er
> etwas registriert, das es **nicht** gibt — ein Mindest-N. Der Prüfgegenstand
> ist deshalb nicht eine Zahl, sondern die Frage, ob eine dokumentierte Lücke
> so abgelegt ist, dass sie später nicht als Versäumnis durchgeht.
>
> Abschnitt 3 trägt den Goldset-Stand des Tages als **Kontext**, nicht als
> Prüfgegenstand: Das Goldset ist privat, seine Fälle sind nicht im Repository,
> und die genannten Zahlen sind hier, damit sie nicht neu ermittelt werden.

## 1. Prüfumfang

`git log --oneline 07ee4c0..HEAD`:

| Commit | Betreff |
|---|---|
| `f43904a` | Das Präsentationsexperiment registrieren — und seine Fallzahl (#267) |

Registrierung, Verdrahtung der Armzuweisung und die Arm-Spalte in `stats.ts` in
einem Commit. [#267](https://github.com/n0mad-ai/bastra-recall/issues/267) ist
geschlossen; die **Durchführung** ist
[#424](https://github.com/n0mad-ai/bastra-recall/issues/424) und ausdrücklich
nicht Prüfgegenstand.

## 2. Was gebaut wurde

§17.4 verlangt Arme, Zuweisungsfunktion und Konfiguration versioniert abgelegt,
das Mindest-N nach dem M0-Baseline-Lauf. Die Registrierung hält beides fest — die
Struktur, **und** dass es ein Mindest-N auf der heutigen Population nicht gibt.

Gemessen statt geschätzt: In 14 Tagen tragen 80 verschiedene Sessions
`hook_recall`-Ereignisse, 16 davon ein `loaded`. Versuchseinheit ist nach §17.4
die **Session**, nicht das Ereignis — bei zwei Armen also ~40 je Arm in zwei
Wochen, davon 8 mit überhaupt einem Ergebnis. 255 Sessions je Arm wären ~89 Tage.
Die Gegenrechnung über die ~800 Ausspielungen pro Tag käme auf 22 Tage und ist
**falsch**, weil die session-stabile Zuweisung clustert; auch das steht in der
Registrierung, damit es niemand neu herleitet.

Der Grund dahinter ist kein Geduldsproblem: §17.4 setzt eine Population voraus,
dieser Vault hat einen Nutzer.

### 2.1 Invarianten, die ein Reviewer angreifen sollte

- **`underpowered_fallback` ist Pflicht, sobald `min_n_per_arm` fehlt.** Der
  Validator prüft nicht nur, ob Zahlen plausibel sind, sondern ob dasteht,
  **warum es keine gibt** (`registrations.ts:360-380`): ohne `min_n_per_arm` sind
  `measured`, `conclusion`, ein `measured_from` (Quellfenster und Vault, sonst ist
  die Messung nicht nachprüfbar) und eine `reporting_rule` als String verlangt.
  Prüfen: Lässt sich die Pflicht mit einem leeren oder inhaltsleeren Objekt
  erfüllen? `typeof conclusion.reporting_rule !== "string"` prüft den Typ, nicht
  den Inhalt — ein leerer String bestünde. Das ist genau die Naht, an der aus
  einer dokumentierten Lücke wieder eine undokumentierte wird.
- **Ein Arm unter seinem Mindest-N wird als NICHT AUSWERTBAR berichtet, nie als
  Nullbefund** (§18.1). Die Regel steht in der **Registrierung**, nicht nur im
  Vertrag — das ist die eigentliche Zusage dieses Commits. Prüfen: Gibt es einen
  Auswertungspfad in `stats.ts` oder im Goldset-Runner, der einen unterbesetzten
  Arm doch als Nullbefund darstellt? Ein Nullbefund aus zu wenig Daten ist die
  Fehlerklasse, gegen die die ganze Registrierung gebaut ist.
- **Die Konfigurations-Verweis-Regel.** Der Daemon hängt **nicht** an
  `@bastra-recall/eval` und wird ohne die Registrierungen ausgeliefert. Die
  Konfiguration trägt deshalb ihren Verweis mit: `registration` und
  `registration_version` sind Pflichtfelder, und eine Konfiguration ohne diesen
  Verweis **oder mit weniger als zwei Armen wird beim Boot verworfen**
  (`settings.ts:98-109`) — dieselbe Regel wie im Registrierungs-Validator, nur an
  der anderen Seite der Workspace-Grenze. Prüfen: Greift das Verwerfen wirklich
  beim Boot und für beide Bedingungen? Und was passiert, wenn `registration_version`
  auf eine Fassung zeigt, die es in `packages/eval` nicht (mehr) gibt — der Daemon
  kann das nicht nachschlagen, also muss die Konsequenz an anderer Stelle sichtbar
  werden.
- **`unassigned` ist kein Arm.** Die Armzuweisung ist verdrahtet und bleibt
  `unassigned`; `stats.ts` schlüsselt nach Arm auf und sagt ausdrücklich, dass
  `unassigned` die **Abwesenheit eines Experiments** ist und nicht eine dritte
  Bedingung. Prüfen: Taucht `unassigned` irgendwo in einer Zeile auf, die sich als
  Armvergleich lesen lässt — eine Tabelle, ein Durchschnitt, ein Anteil? Das ist
  die Fortsetzung derselben Invariante aus Übergabe Nr. 3 (`649753d`), jetzt auf
  der Leseseite.

### 2.2 Wie verifiziert wurde

105 neue Zeilen in `registrations.test.ts`, die die Validator-Regeln abdecken.
Die Populationszahlen (80 Sessions, 16 mit `loaded`, ~40 je Arm) sind aus dem Log
gemessen und stehen mit ihrem Quellfenster in der Registrierung, statt im
Commit-Text zu bleiben — nachrechenbar ist damit auch die Aussage, dass 255
Sessions je Arm ~89 Tage bedeuten.

## 3. Kontext: der Goldset-Stand des Tages

**Kein Prüfgegenstand** — das Goldset ist privat und liegt nicht im Repository.
Die Zahlen stehen hier, damit sie nicht neu ermittelt werden.

**Authoring-Charge 1** (#418): 84 vault-blind verfasste Queries (51 associative /
17 C-036 / 16 en), §19-konform gestaged, von einem **anderen** Agenten gelabelt
(Autor ≠ Labeller) → **30 Labels** (21 mit Ziel, 9 `no_answer` inkl. 5
`non_application`), 54 verworfen. `--check` grün, nach `gold-authored-1.json`
gemerged. Sprachstempel de 24 / en 6, Sonden 0.

Der Kalibrierungsbefund, der die Chargen 2–3 umbaut: Die Auflösbarkeit der
assoziativen Achse spaltet sich scharf nach Autorenmodus. **Frei erfundene
situative Rätsel: 0 von 35** — ein vault-blinder Autor kann keinen auflösbaren
Referenten eines privaten Lebens treffen, das der Vault womöglich gar nicht
verzeichnet; jedes Label wäre geraten. **Projekt-abgeleitete Rätsel: 7 von 16
(43,8 %)**. Konsequenz: Der freie Modus entfällt; für die 150 associative
brauchte es ~350 projekt-abgeleitete Queries.

Zwei Nebenbefunde, beide bereits erfasst:

- **Index-Lücke bei den früheren fünf Labelling-Chargen.** Der
  Frontmatter-Index deckte nur `memories/` ab, `Vault.list()` trägt zusätzlich
  **37 doc- und 10 bookmark-Einträge** (Index 1035 → 1082). Mindestens eine
  frühere `no_answer`-Begründung hält so nicht mehr. Eine Nachprüfung der
  `no_answer`-Fälle aus blind + tel-1..4 gegen den vollen Index **läuft**; nur
  `no_answer`-Labels können daran kippen.
- Die 8 C-036-`no_answer` teilen eine Ursache: Die Regeln stehen in `CLAUDE.md`,
  nicht als Memories. Saubere `no_answer` — und ein Beleg für eine echte Lücke
  zwischen Regelbasis und dem, was Recall ausliefern kann.

## 4. Bekannte offene Punkte — nicht neu suchen

| Issue | Kurz |
|---|---|
| [#423](https://github.com/n0mad-ai/bastra-recall/issues/423) | `detectLang` verfehlt deutsche Queries ohne seine Marker-Funktionswörter — die Sprachbalance des Goldsets ist zu `neutral` verschoben. |
| [#424](https://github.com/n0mad-ai/bastra-recall/issues/424) | Durchführung des Präsentationsexperiments: Die Arme brauchen eine Population, eine zweite Formulierung und die Gate-Entscheidung. **Nicht Prüfgegenstand.** |
| [#418](https://github.com/n0mad-ai/bastra-recall/issues/418) | Autorenstufe, Stand siehe Abschnitt 3. |
| [#421](https://github.com/n0mad-ai/bastra-recall/issues/421) / [#422](https://github.com/n0mad-ai/bastra-recall/issues/422) / [#354](https://github.com/n0mad-ai/bastra-recall/issues/354) | Pipeline-Vereinheitlichung (V2), Gate-Aktivierung, Budget-Zahlen — alle in Übergabe Nr. 4 beschrieben. |
| [#416](https://github.com/n0mad-ai/bastra-recall/issues/416) | `packages/eval/src/goldset-harvest.ts` enthält rohe NUL-Bytes. **Weiterhin: `git diff --text`.** |
| [#413](https://github.com/n0mad-ai/bastra-recall/issues/413) / [#415](https://github.com/n0mad-ai/bastra-recall/issues/415) / [#417](https://github.com/n0mad-ai/bastra-recall/issues/417) / [#419](https://github.com/n0mad-ai/bastra-recall/issues/419) / [#420](https://github.com/n0mad-ai/bastra-recall/issues/420) | Unverändert, in den Übergaben Nr. 2–4 beschrieben. |

## 5. Prüfregeln

Unverändert gegenüber Übergabe Nr. 4 (P0 sofort · Referenz je Befund · Diff statt
Repository · `--text` bei `goldset-harvest.ts` · Messung schlägt Plausibilität ·
registrierte Zahlen als eigener Gegenstand · „kein Test angefasst" ist eine
Behauptung · Wirkungslosigkeit ist in Etappe D die Hauptzusage). Für **diese**
Übergabe zählt vor allem Regel 6, in ihrer Umkehrung: Hier ist die interessante
Frage nicht, ob eine registrierte Zahl aus einem Lauf folgt, sondern ob die
**Abwesenheit** einer Zahl so registriert ist, dass sie später nicht als
Versäumnis gelesen wird.
