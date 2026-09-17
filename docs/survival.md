# Survival — the by-id substrate invariant / Survival — die By-ID-Invariante des Substrats

[English](#english) · [Deutsch](#deutsch)

<a id="english"></a>

## English

**Survival** is the single guarantee every layer above the engine leans on:

> A reference by stable id keeps resolving after the cell is demoted, retired, or
> soft-deleted. Only a **hard delete** removes a cell — and the engine never hard
> deletes as a side effect of ranking, aging, or unpinning.

This is a substrate property, not a feature. It is guaranteed **once at the
bottom** so that no layer above has to re-defend it:

- **facts** — recall ranking. A demoted memory drops in score, not out of existence.
- **state** — the [#142](https://github.com/n0mad-ai/bastra-recall/issues/142)
  pin/floor lifecycle. An expired floor drops back to *ranked*, it never deletes.
- **decisions** — a future citation/audit layer (jugeni-contracts). A citation must
  resolve against a demoted-or-retired cell, or the citation graph rots.

A silent change to any of the rules below would break all three layers at once.
That is why it is pinned by a regression test (see *Enforcement*).

### The contract

| Operation | Effect on the cell | By-id resolution |
|---|---|---|
| **Read / rank** | none | resolves |
| **Demote** (staleness aging) | recall **score** only — the file is byte-identical | resolves |
| **Unpin / retire** (#142 floor release) | drops to *ranked* — never deletes; file byte-identical, ranking identical | resolves |
| **Soft-delete** | file moves to append-only `.bastra/trash/` + a `delete` audit entry is appended | leaves the **active** index; recoverable via restore |
| **Restore** | trash file returns to the vault; the `delete` record stays (append-only) | resolves again |
| **Hard-delete** | the cell is gone | does not resolve — the only operation that ends survival |

Concretely:

- **Stable ids.** `Vault.get(id)` resolves a memory by its frontmatter `id`, independent of file path or score.
- **Demote = score only.** `computeStaleness(...)` returns a multiplier (`fresh` → `stale` → `expired`); aging touches the recall score, never the file and never by-id resolution.
- **Soft-delete = trash + audit, not erase.** `auditedSoftDelete(...)` moves the file under `.bastra/trash/` and appends a `delete` entry to the `AuditLog`. The active index drops the id (`vault.get(id) → undefined`), but the trash file and the audit record persist. `auditedRestore(...)` reindexes it and the id resolves again; the original `delete` record survives the restore because the log is append-only.
- **Unpin ≠ delete.** The #142 floor is **injection-layer-only**: a daemon-side registry (`packages/daemon/src/floors.ts`, persisted at `~/.bastra/floors.json`) decides what the session hook injects as `<pinned-memories>`; the engine score and the vault file are untouched by construction. `release(condition)` returns the memory to ordinary ranked retrieval — it removes a *guarantee* (always-present), not the *memory*. A citation still resolves against it, nothing evaporates; it just stops spending guaranteed context.

### Enforcement

The invariant is a CI gate, not a courtesy:

```
packages/core/__tests__/survival-by-id.test.ts
packages/daemon/__tests__/floors.test.ts   (retire/unpin arm)
```

- `demote` arm — a 200-day-old lesson is demoted (score multiplier `< 1`), yet `vault.get(id)` still resolves and the file is byte-identical.
- `soft-delete` arm — after `auditedSoftDelete`, the id leaves the active index but the trash file + append-only `delete`/`restore` records persist, and a restore brings the id back.
- `retire/unpin` arm — pinned by `packages/daemon/__tests__/floors.test.ts`
  (it lives in the daemon suite because the #142 floor registry is daemon-side
  state and core does not import daemon): floor + `release(condition)` leave the
  vault file **byte-identical** and the engine ranking **identical**
  before/during/after flooring, and `vault.get(id)` resolves throughout —
  drop-to-ranked, never delete. The core file keeps a `test.todo` signpost
  pointing there.

The day any of these operations starts *evaporating* the cell instead of
demoting / unpinning / trashing it, the tests go red.

#### Coverage guard ([#194](https://github.com/n0mad-ai/bastra-recall/issues/194))

The arms above are point-coverage: they prove the *known* transitions cannot
evaporate a cell, but nothing proved the set of transitions *stays* known. A
fifth mutation path landing next quarter would ship unpinned by default —
survival would hold by convention on exactly the path least likely to think
about it. `packages/core/__tests__/survival-coverage.test.ts` closes that
mechanically, both halves enumerated **from code**:

- **Cell mutations** — runtime reflection diffs the exported `audited*`
  surface of `audit-save.ts` against the pinned arms. A new audited export
  without a survival arm goes red, with the pin as the price of admission.
- **Score mutations** — a static source scan counts every score assignment in
  `core/src` and `daemon/src` against a pinned site list. All ranking
  multipliers (staleness, curator-demote, doc-damping, salience-live) already
  pass through the one gateway (`applyStaleness` in `search.ts`); a new
  assignment anywhere else goes red until it is routed through the gateway or
  pinned with its own arm. RRF fusion is pinned as score *construction*, and
  the freestanding pre-gateway multiplier stays bench-only — a src import of
  it is a failure. (#142 floors never appear in this scan by construction:
  the floor is injection-layer-only and touches no engine score.)

With the guard in place survival is **coverage-guaranteed, not
four-arms-guaranteed**: the suite defends its own completeness.

### Provenance

This contract was hardened in the dev.to threads with **Mike Czerwinski**
(jugeni-contracts, the decision/citation layer) and **Raffaele Zarrelli**
(cowork-os, the govern-surface). Their layers compose on bastra-recall *because*
survival holds at the substrate — turning the promise into a CI break is what makes
it a contract a third party can re-run, rather than something either side has to
remember to preserve. See [#146](https://github.com/n0mad-ai/bastra-recall/issues/146).

<a id="deutsch"></a>

## Deutsch

**Survival** ist die eine Garantie, auf die sich jede Schicht oberhalb der Engine stützt:

> Ein Verweis über eine stabile ID löst weiterhin auf, nachdem die Zelle herabgestuft,
> ausgemustert oder weich gelöscht wurde. Nur ein **Hard-Delete** entfernt eine Zelle —
> und die Engine löscht nie hart als Nebeneffekt von Ranking, Alterung oder Unpinning.

Das ist eine Eigenschaft des Substrats, kein Feature. Sie wird **einmal ganz unten**
garantiert, damit keine Schicht darüber sie erneut absichern muss:

- **Fakten** — Recall-Ranking. Eine herabgestufte Erinnerung verliert an Score, verschwindet aber nicht.
- **Zustand** — der Pin/Floor-Lebenszyklus aus
  [#142](https://github.com/n0mad-ai/bastra-recall/issues/142). Ein abgelaufener Floor fällt zurück auf *ranked*, er löscht nie.
- **Entscheidungen** — eine künftige Zitations-/Audit-Schicht (jugeni-contracts). Eine Zitation muss
  auch gegen eine herabgestufte oder ausgemusterte Zelle auflösen, sonst verrottet der Zitationsgraph.

Eine stille Änderung an einer der folgenden Regeln würde alle drei Schichten auf einmal brechen.
Deshalb ist sie durch einen Regressionstest festgenagelt (siehe *Durchsetzung*).

### Der Vertrag

| Operation | Wirkung auf die Zelle | Auflösung per ID |
|---|---|---|
| **Read / rank** | keine | löst auf |
| **Demote** (Staleness-Alterung) | nur der Recall-**Score** — die Datei ist byte-identisch | löst auf |
| **Unpin / retire** (#142-Floor-Freigabe) | fällt auf *ranked* zurück — löscht nie; Datei byte-identisch, Ranking identisch | löst auf |
| **Soft-delete** | Datei wandert in das Append-only-Verzeichnis `.bastra/trash/` + ein `delete`-Audit-Eintrag wird angehängt | verlässt den **aktiven** Index; per Restore wiederherstellbar |
| **Restore** | Trash-Datei kehrt in den Vault zurück; der `delete`-Eintrag bleibt (append-only) | löst wieder auf |
| **Hard-delete** | die Zelle ist weg | löst nicht auf — die einzige Operation, die Survival beendet |

Konkret:

- **Stabile IDs.** `Vault.get(id)` löst eine Erinnerung über ihre Frontmatter-`id` auf, unabhängig von Dateipfad oder Score.
- **Demote = nur Score.** `computeStaleness(...)` liefert einen Multiplikator (`fresh` → `stale` → `expired`); Alterung berührt den Recall-Score, nie die Datei und nie die Auflösung per ID.
- **Soft-delete = Trash + Audit, kein Löschen.** `auditedSoftDelete(...)` verschiebt die Datei nach `.bastra/trash/` und hängt einen `delete`-Eintrag an das `AuditLog` an. Der aktive Index verliert die ID (`vault.get(id) → undefined`), aber Trash-Datei und Audit-Eintrag bleiben bestehen. `auditedRestore(...)` indiziert sie neu, und die ID löst wieder auf; der ursprüngliche `delete`-Eintrag übersteht das Restore, weil das Log append-only ist.
- **Unpin ≠ Löschen.** Der #142-Floor wirkt **nur in der Injektionsschicht**: Eine Registry im Daemon (`packages/daemon/src/floors.ts`, gespeichert unter `~/.bastra/floors.json`) entscheidet, was der Session-Hook als `<pinned-memories>` einspeist; Engine-Score und Vault-Datei bleiben konstruktionsbedingt unberührt. `release(condition)` gibt die Erinnerung an das normale gerankte Abrufen zurück — es entfernt eine *Garantie* (immer vorhanden), nicht die *Erinnerung*. Eine Zitation löst weiterhin gegen sie auf, nichts verdampft; sie verbraucht nur keinen garantierten Kontext mehr.

### Durchsetzung

Die Invariante ist ein CI-Gate, keine Gefälligkeit:

```
packages/core/__tests__/survival-by-id.test.ts
packages/daemon/__tests__/floors.test.ts   (retire/unpin arm)
```

- `demote`-Zweig — eine 200 Tage alte Lesson wird herabgestuft (Score-Multiplikator `< 1`), trotzdem löst `vault.get(id)` weiter auf, und die Datei ist byte-identisch.
- `soft-delete`-Zweig — nach `auditedSoftDelete` verlässt die ID den aktiven Index, aber Trash-Datei und die Append-only-Einträge `delete`/`restore` bleiben bestehen, und ein Restore bringt die ID zurück.
- `retire/unpin`-Zweig — festgenagelt durch `packages/daemon/__tests__/floors.test.ts`
  (er liegt in der Daemon-Suite, weil die #142-Floor-Registry Zustand im Daemon ist
  und Core den Daemon nicht importiert): Floor + `release(condition)` lassen die
  Vault-Datei **byte-identisch** und das Engine-Ranking **identisch** —
  vor, während und nach dem Flooring —, und `vault.get(id)` löst durchgehend auf:
  zurück auf ranked, nie löschen. Die Core-Datei behält einen `test.todo`-Wegweiser
  dorthin.

An dem Tag, an dem eine dieser Operationen die Zelle *verdampfen* lässt, statt sie
herabzustufen, zu entpinnen oder in den Trash zu legen, werden die Tests rot.

#### Abdeckungswächter ([#194](https://github.com/n0mad-ai/bastra-recall/issues/194))

Die Zweige oben sind Punktabdeckung: Sie beweisen, dass die *bekannten* Übergänge keine
Zelle verdampfen lassen können, aber nichts bewies, dass die Menge der Übergänge
bekannt *bleibt*. Ein fünfter Mutationspfad, der im nächsten Quartal dazukommt, würde
standardmäßig ungesichert ausgeliefert — Survival hielte nur per Konvention, und zwar
genau auf dem Pfad, der am wenigsten daran denkt.
`packages/core/__tests__/survival-coverage.test.ts` schließt diese Lücke mechanisch,
beide Hälften werden **aus dem Code** aufgezählt:

- **Zell-Mutationen** — Laufzeit-Reflexion vergleicht die exportierte `audited*`-Oberfläche
  von `audit-save.ts` mit den festgenagelten Zweigen. Ein neuer auditierter Export
  ohne Survival-Zweig wird rot; der Pin ist der Eintrittspreis.
- **Score-Mutationen** — ein statischer Quelltext-Scan zählt jede Score-Zuweisung in
  `core/src` und `daemon/src` gegen eine festgenagelte Liste von Stellen. Alle
  Ranking-Multiplikatoren (Staleness, Curator-Demote, Doc-Damping, Salience-live)
  laufen bereits durch das eine Gateway (`applyStaleness` in `search.ts`); eine neue
  Zuweisung an anderer Stelle wird rot, bis sie durch das Gateway geleitet oder mit
  einem eigenen Zweig festgenagelt ist. RRF-Fusion ist als Score-*Konstruktion*
  festgenagelt, und der freistehende Multiplikator vor dem Gateway bleibt nur für
  Benchmarks — ein Import aus src ist ein Fehler. (#142-Floors tauchen
  konstruktionsbedingt nie in diesem Scan auf: Der Floor wirkt nur in der
  Injektionsschicht und berührt keinen Engine-Score.)

Mit dem Wächter ist Survival **durch Abdeckung garantiert, nicht nur durch vier Zweige**:
Die Suite verteidigt ihre eigene Vollständigkeit.

### Herkunft

Dieser Vertrag wurde in den dev.to-Threads mit **Mike Czerwinski**
(jugeni-contracts, die Entscheidungs-/Zitationsschicht) und **Raffaele Zarrelli**
(cowork-os, die Govern-Oberfläche) gehärtet. Ihre Schichten bauen auf bastra-recall auf,
*weil* Survival im Substrat gilt — erst dass das Versprechen zu einem CI-Bruch wird,
macht es zu einem Vertrag, den Dritte erneut prüfen können, statt zu etwas, an dessen
Erhalt beide Seiten denken müssen. Siehe [#146](https://github.com/n0mad-ai/bastra-recall/issues/146).
