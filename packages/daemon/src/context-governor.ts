/**
 * Der globale Context Governor (#266, §16.3, §25 Punkt 4, §26.1).
 *
 * DAS PROBLEM. Kontextbudget gibt es heute nur als verstreute Stückgrenzen:
 * `TOTAL_HINTS_CAP = 7` in der SessionStart-Lane, `k = 3` je Query, 220 Zeichen
 * Summary-Kürzung, `MAX_HINTS = 3` im Assembler. `hint_tokens_est` misst zwar
 * mit, erzwingt aber nichts — der 30-Tage-Schnitt aus #266 nennt ~519k
 * injizierte Hint-Token für 82 acted-on Loads. Niemand entscheidet über das
 * GANZE, weil niemand das Ganze sieht.
 *
 * §16.3 verlangt genau einen Entscheider für fünf Fragen:
 *
 *   1. wie viele Memories ausgespielt werden;
 *   2. wie viele Token verbraucht werden;
 *   3. ob nur Titel/Summary oder voller Load nötig ist;
 *   4. ob ein bereits geladenes Memory erneut erwähnt werden darf;
 *   5. welche Zonen automatisch ausgeschlossen sind.
 *
 * WAS DIESES MODUL DAVON ENTSCHEIDET: 1, 2 und 4. Frage 3 hat heute keinen
 * Freiheitsgrad — Hints tragen immer eine gekürzte Summary, der volle Load ist
 * ein eigenes Werkzeug (`load_memory`), das der Agent aufruft und nicht der
 * Governor. Der `detail`-Wert wird deshalb durchgereicht und mitbilanziert,
 * nicht erfunden. Frage 5 bleibt draußen: Zonenausschluss wirkt nach §21.3/§25
 * erst nach bestandenem M3 live, bis dahin ist Accessibility eine read-only
 * Projektion. Ein Zonenfeld hier wäre Vorratscode für ein Gate, das nicht
 * bestanden ist.
 *
 * WAS DER GOVERNOR NIE TUT.
 *
 * - Er startet nichts. Kein Deep Recall (weder Stufe 1 noch 2) aus einem Hook,
 *   kein Cross-Encoder, kein Reranker (C-031/C-052, §9.4). Er bekommt fertige
 *   Kandidaten und entscheidet, was davon ins Budget passt — er beschafft
 *   nichts nach.
 * - Er sortiert nicht semantisch um. Die Reihenfolge kommt vom Aufrufer; der
 *   Governor streicht nur. Damit kann er keine Evidenz gegen Cue-Text tauschen
 *   (C-030) und keine Trefferauswahl verändern, die anderswo begründet wurde.
 * - Er kennt keine Hop-Herkunft. Trimmen darf die eine `related_via`-Sicht des
 *   Hook-Pfades nicht als Klasse wegräumen (C-046) — deshalb gibt es hier
 *   keine Regel, die `hop` liest. Ein Nachbar fällt wie jeder andere Kandidat
 *   nur über Priorität und Budget, und dass er fiel, steht im Bericht.
 * - Er lernt nichts. Die Wiedererwähnung entscheidet deterministischer
 *   Sitzungszustand (§17.5, C-037): Wurde es in dieser Sitzung schon gezeigt,
 *   ja oder nein. `surfaced-not-loaded` und die übrigen Nutzungssignale bleiben
 *   telemetrieseitig ohne Live-Wirkung vor M6.
 */

/** Die Token-Schätzung des Repos: vier Zeichen je Token — dieselbe Grobheit
 *  wie `hint_tokens_est` in den Bash-Lanes und wie im Session-Assembler. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface GovernorBudget {
  /** Obergrenze des injizierten Kontexts in geschätzten Token. `0` = keine. */
  tokens?: number;
  /** Höchstzahl ausgespielter Memories. `0` = keine. */
  items?: number;
}

export interface GovernedItem {
  id: string;
  /**
   * Kleiner ist wichtiger. Die Reihenfolge der LISTE bleibt davon unberührt —
   * Priorität entscheidet, WER fällt, nicht wer oben steht. (Dieselbe Trennung
   * wie im Session-Assembler: Reihenfolge ist Darstellung, Priorität ist
   * Budget.)
   */
  priority: number;
  /** Der Text, der Budget kostet — so, wie er injiziert würde. */
  text: string;
  /**
   * §16.3 Frage 4: In dieser Sitzung bereits gezeigt. Deterministischer
   * Sitzungszustand, kein gelerntes Signal.
   */
  alreadyShown?: boolean;
  /** §16.3 Frage 3, durchgereicht: `summary` ist heute der einzige Wert, den
   *  die Hook-Pfade erzeugen. Der Governor bilanziert ihn, er wählt ihn nicht. */
  detail?: "summary" | "full";
}

export type DropReason =
  /** Das Token-Budget war erschöpft. */
  | "token_budget"
  /** Die Höchstzahl war erreicht. */
  | "item_budget"
  /** In dieser Sitzung schon gezeigt (§16.3 Frage 4). */
  | "already_shown";

export interface GovernorDecision {
  /** Was ausgespielt wird — in der Reihenfolge, in der es hereinkam. */
  kept: GovernedItem[];
  /** Was nicht, mit Grund. Ein stillschweigend gestrichener Kandidat wäre genau
   *  die Unsichtbarkeit, die #266 beheben soll. */
  dropped: Array<{ id: string; reason: DropReason }>;
  /** Geschätzte Token der behaltenen Einträge. */
  tokens_spent: number;
  /** Die Obergrenzen, gegen die entschieden wurde — damit ein Bericht die Zahl
   *  einordnen kann, ohne die Konfiguration zu kennen. */
  budget: { tokens: number; items: number };
}

export interface GovernorOptions {
  /**
   * Darf ein in dieser Sitzung bereits gezeigtes Memory erneut erwähnt werden?
   *
   * Default `false` — das ist die Frage aus §16.3, und die teure Antwort ist
   * „ja". Der Aufrufer, der es besser weiß (ein Sessionstart nach `clear`
   * beginnt eine neue Sitzung), setzt es.
   */
  allowRemention?: boolean;
}

/**
 * Der Entscheid.
 *
 * Zwei Durchgänge, und die Reihenfolge ist Absicht. Zuerst fällt, was in dieser
 * Sitzung schon gezeigt wurde — eine Wiederholung kostet Budget und trägt
 * nichts bei. Danach wird nach PRIORITÄT gefüllt, bis eine der beiden Grenzen
 * greift; die Ausgabe steht aber in der Reihenfolge, in der die Kandidaten
 * hereinkamen. Wer nur die Liste kürzt, verliert sonst genau den wichtigen
 * Eintrag, der zufällig unten stand.
 *
 * Ein Eintrag, der für sich allein das Token-Budget sprengt, fällt — er wird
 * NICHT gekürzt. Kürzen hieße, eine Evidenz halb auszugeben, und ein halber
 * Beleg ist keiner.
 */
export function governContext(
  items: GovernedItem[],
  budget: GovernorBudget = {},
  opts: GovernorOptions = {},
): GovernorDecision {
  const tokenBudget = budget.tokens ?? 0;
  const itemBudget = budget.items ?? 0;
  const dropped: Array<{ id: string; reason: DropReason }> = [];

  const eligible = items.filter((it) => {
    if (it.alreadyShown && opts.allowRemention !== true) {
      dropped.push({ id: it.id, reason: "already_shown" });
      return false;
    }
    return true;
  });

  // Nach Priorität aufnehmen, bei Gleichstand in Eingabereihenfolge — sonst
  // hinge das Ergebnis an der Sortierstabilität der Laufzeit.
  const order = eligible
    .map((it, i) => ({ it, i }))
    .sort((a, b) => a.it.priority - b.it.priority || a.i - b.i);

  const keep = new Set<string>();
  let spent = 0;
  for (const { it } of order) {
    if (itemBudget > 0 && keep.size >= itemBudget) {
      dropped.push({ id: it.id, reason: "item_budget" });
      continue;
    }
    const cost = estimateTokens(it.text);
    if (tokenBudget > 0 && spent + cost > tokenBudget) {
      dropped.push({ id: it.id, reason: "token_budget" });
      continue;
    }
    spent += cost;
    keep.add(it.id);
  }

  return {
    kept: eligible.filter((it) => keep.has(it.id)),
    dropped,
    tokens_spent: spent,
    budget: { tokens: tokenBudget, items: itemBudget },
  };
}
