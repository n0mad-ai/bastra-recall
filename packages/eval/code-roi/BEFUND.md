# Code-Awareness gegen den No-Graph-Kontrollarm — Messung 17.09.2026

Gemessen am Recall-Repo (822 Dateien im Graphen, graphifyy 0.9.63), gegen die
Primärmetrik aus der Preregistrierung: **Suchtokens bis zur richtigen Stelle**.

Reproduzieren: `node packages/eval/code-roi/measure.mjs` und
`measure-deps.mjs`. Rohdaten in `report.json` / `report-deps.json`.

## Ergebnis in einem Satz

**Gegen einen gezielten `grep` spart die Code-Karte in dieser Messung keinen
Kontext — sie kostet im typischen Fall mehr.**

## Szenario 1: "Wo ist Symbol X?" (40 Fälle)

| | Tokens (Median) |
|---|---|
| `find_code` | 105 |
| gezielter `grep` | 34 |
| naiver `grep` | 188 |

- Beide Arme fanden in **40 von 40** Fällen die richtige Stelle.
- Über die Summe spart der Graph 89 % — aber **in 39 von 40 Einzelfällen ist
  der gezielte grep billiger**. Die Ersparnis kommt aus wenigen Ausreißern, in
  denen grep explodiert.
- Genau davor schützt die preregistrierte Bedingung, dass die Differenz über
  Szenarien halten muss und nicht auf Ausreißern ruhen darf. **Sie hält nicht.**

## Szenario 2: "Was hängt von Datei Y ab?" (35 Fälle)

| | Tokens (Median) |
|---|---|
| Abhängigen-Block | 144 |
| `grep` auf Importe | 113 |

- **13 von 35** Fällen: Block billiger. **22 von 35**: grep billiger.
- Der grep findet im Median **100 %** dessen, was der Graph findet.

## Was diese Messung NICHT zeigt

Drei Einschränkungen, ohne die die Zahlen falsch gelesen werden:

1. **Der Kontrollarm ist optimal informiert.** Er kennt den exakten Symbol-
   beziehungsweise Dateinamen. Ein realer Agent tastet sich oft heran — erst
   ein zu weiter grep, dann ein engerer. Jede zusätzliche Runde verschiebt die
   Bilanz zugunsten des Graphen, und genau diese Runden misst das hier nicht.
2. **Gemessen wird ein Lookup, nicht eine Aufgabe.** Die Preregistrierung
   verlangt die Tokens über alle Runden *bis die richtige Stelle erreicht ist*.
   Das braucht echte Sessions, nicht einen Repo-Durchlauf.
3. **Der Block ist ungefragt.** Er kostet bei jedem Edit einer Datei mit
   Abhängigen — auch wenn der Agent die Frage nie gestellt hätte. Diesen
   Nachteil unterschätzt die Messung sogar, weil sie ihn nur dort verbucht, wo
   der Agent ohnehin gesucht hätte.

## Konsequenz

Der Mechanismus, über den die Karte gewinnen *könnte*, ist das Einsparen von
Such-RUNDEN. Ob sie das tut, ist offen und mit dieser Methode nicht
beantwortbar. Bis eine Messung über echte Sessions vorliegt, ist
"spart Kontext" eine **unbelegte Behauptung** und darf so nicht auftreten.

Belegbar sind dagegen: die Latenz (p90 7 ms der gesamten Lane gegen ein
200-ms-Ziel), die Korrektheit der Kanten, und dass die Karte Abhängige nennt,
die ein grep auf Importe nur findet, wenn man den richtigen Namen schon kennt.
