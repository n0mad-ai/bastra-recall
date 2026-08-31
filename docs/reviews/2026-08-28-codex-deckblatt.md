# Prüfauftrag an Codex — Gegenreview bastra-recall, Tagesstand 28.08.2026

Bitte prüfe den Stand `ad86155..HEAD` gegen — das ist alles, was seit deinem
letzten Review dazugekommen ist. Der Umfang ist in fünf Übergaben aufgeteilt,
damit du inkrementell vorgehen kannst statt alles auf einmal zu lesen.

## Leseliste, in dieser Reihenfolge

1. `docs/reviews/2026-08-28-handover-codex-1.md` — Write-Path-Incidents,
   Test-Runner-Härtung, Eval-Fundament.
2. `docs/reviews/2026-08-28-handover-codex-2.md` — M1-Abschluss auf
   `weak_result`, deterministischer Split, Cue-Schicht.
3. `docs/reviews/2026-08-28-handover-codex-3.md` — Telemetrie-Dimensionen,
   Session-Assembler.
4. `docs/reviews/2026-08-28-handover-codex-4.md` — Evidenzentscheid,
   Context Governor.
5. `docs/reviews/2026-08-28-handover-codex-5.md` — Registrierung des
   Präsentationsexperiments.

Jede Übergabe nennt ihren eigenen Commit-Bereich, die Invarianten, die sie
angreifbar hält, und wie sie verifiziert wurde. Die Invarianten stehen dort und
werden hier nicht wiederholt — dieses Deckblatt verweist nur.

## Prüfregeln

- **P0 wird sofort gemeldet und gefixt.** Alles andere wird ein Issue — kein
  Sammel-Review-Dokument, keine Drive-by-Fixes an Nicht-P0-Befunden.
- **Jeder Befund mit Referenz:** Commit-SHA und `datei.ts:zeile`.
- **`packages/eval/src/goldset-harvest.ts` nur mit `git diff --text` ansehen.**
  Die Datei enthält rohe NUL-Bytes, git behandelt sie als binär und `grep -rn`
  überspringt sie stillschweigend (#416).
- **„Kein Test musste angefasst werden" ist eine Behauptung, keine
  Verifikation.** Der Satz trägt in mehreren Refactorings die Verhaltensgleichheit.
  Wo er den Beleg trägt, gehört die Frage dazu, ob überhaupt ein Test das
  fragliche Verhalten abdeckt.
- **In Etappe D (Übergabe Nr. 4) ist Wirkungslosigkeit die Hauptzusage.**
  Evidenzentscheid und Context Governor sind absichtlich folgenlos ausgeliefert.
  Ein Befund, der zeigt, dass heute doch etwas wirkt, ist P0 und nicht Issue.

## Betriebszustand

- Die Shadow-Acceptance-Uhr für den Evidenzentscheid **läuft** (seit dem
  Daemon-Neustart um 15:01).
- Das Evidence-Gate ist **aus** (Default; `BASTRA_EVIDENCE_GATE` überstimmt
  Richtung aus).
- Die Cue-Schicht ist **aus** — ohne geladene Projektion wird das Indexfeld
  nicht einmal angemeldet.
- Der Context Governor läuft **ohne Budget**; der Hebel steht effektiv auf null.

## Nicht Prüfgegenstand

- **Das Goldset selbst.** Es ist privat und liegt nicht im Repository; die
  relevanten Zahlen stehen als Kontext in den Übergaben.
- **Die Aktivierungs-Checkliste des Evidence-Gates** (#422) — Betrieb und
  Entscheidung, nicht Code.
- **Die Budget-Zahlen für den Context Governor** (#354) — sie brauchen eine
  eigene Konfigurationsentscheidung mit gemessenen Werten.

Bekannte offene Punkte, die du nicht neu finden musst, stehen am Ende jeder
Übergabe mit Issue-Nummer. Eine **Korrektur** an einer dortigen Analyse ist
dagegen ausdrücklich willkommen.
