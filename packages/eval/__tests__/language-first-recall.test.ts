/**
 * #231 — der Abnahmetest für Language-first Recall.
 *
 * DER BEFUND, um den es geht (zzallirog, 2026-07-19): Der Hook baute seine
 * Query aus englischen Füllwörtern (`editing … involving …`). Auf einem
 * russischen Vault belegte damit ein englischer DOM-Schnappschuss bei 14 von 30
 * unverwandten Fragen den ersten Platz — nicht weil er passte, sondern weil er
 * das grösste englische Dokument war und die Query aus denselben englischen
 * Wörtern bestand. Dieselben Fragen auf Russisch: 1 von 15.
 *
 * Die Punkte 1, 2, 3 und 5 der Richtung sind ausgeliefert; was fehlte, war
 * dieser Test. Die Zusage stand damit im Code und in der Doku, aber nichts
 * hielt sie fest.
 *
 * DER VAULT dazu liegt in `fixtures/eval-vault-de`: vier Memories mit
 * deutschen Triggern (zwei davon mit englischen Fachankern, dem Mischstil, der
 * auf dem deutschen Vault messbar funktioniert) und ein importiertes englisches
 * Dokument, das genau die Füllwörter des alten Templates trägt. Es ist der
 * Störtreffer aus dem Feldbericht, nachgebaut im Kleinen.
 *
 * WAS DIESER TEST NICHT PRÜFT: Punkt 4 der Richtung (Dämpfung des
 * lexikalischen Arms bei Sprachdivergenz) existiert nicht und ist bewusst
 * zurückgestellt — siehe den Abschlusskommentar am Issue.
 *
 * Runner: node --import tsx --test packages/eval/__tests__/language-first-recall.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Vault, SearchIndex, detectTopics } from "@bastra-recall/core";
import type { RecallHit } from "@bastra-recall/core";

const HIER = dirname(fileURLToPath(import.meta.url));
const VAULT_DE = join(HIER, "..", "fixtures", "eval-vault-de");

/** Die Datei, auf die eine Hook-Query in diesem Fixture zeigt. */
const EDIT_PFAD = "packages/daemon/src/index.ts";

async function index(t: { after: (fn: () => unknown) => void }): Promise<SearchIndex> {
  const vault = new Vault(VAULT_DE);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  t.after(async () => {
    search.stop();
    await vault.stop?.();
  });
  return search;
}

/** Die Query, die der Hook für einen Edit an dieser Datei baut. `variante`
 *  schaltet auf das alte englische Template zurück (Kill-Switch aus #231). */
function hookQuery(variante: "neutral" | "english"): string {
  const vorher = process.env.BASTRA_HOOK_QUERY;
  if (variante === "english") process.env.BASTRA_HOOK_QUERY = "english";
  else delete process.env.BASTRA_HOOK_QUERY;
  try {
    return detectTopics({ tool_name: "Edit", file_path: EDIT_PFAD, content_excerpt: "" }).query;
  } finally {
    if (vorher === undefined) delete process.env.BASTRA_HOOK_QUERY;
    else process.env.BASTRA_HOOK_QUERY = vorher;
  }
}

const platz = (hits: RecallHit[], id: string): number => hits.findIndex((h) => h.id === id);

test("#231: deutsche Fragen treffen deutsche Trigger, und der Anker feuert", async (t) => {
  const search = await index(t);

  // Die Kernzusage: Auf einem nicht-englischen Vault trägt der lexikalische Arm
  // — und zwar über `recall_when`, das höchstgewichtete Feld. Genau das konnte
  // im Feldbericht strukturell nie passieren.
  const faelle: Array<[string, string]> = [
    ["bevor wir das Deployment starten", "deployment-rollback-fenster"],
    ["welche Zeitzone gehört in die Datenbank", "zeitangaben-immer-in-utc"],
    ["bevor ich das Schema ändere", "migration-vorher-sichern"],
  ];
  for (const [frage, erwartet] of faelle) {
    const hits = search.recall(frage, { k: 3 });
    assert.equal(hits[0]?.id, erwartet, `„${frage}" muss ${erwartet} zuerst finden`);
    assert.equal(
      hits[0]?.matched_recall_when,
      true,
      `„${frage}" muss den deutschen Trigger als Anker erkennen`,
    );
  }
});

test("#231: eine Umschreibung findet den Trigger auch ohne wörtliche Übereinstimmung", async (t) => {
  const search = await index(t);

  // „zurückrollen" steht so in keinem Trigger — der Treffer kommt über das
  // Wortfeld des deutschen Textes, nicht über einen kopierten Satz.
  const hits = search.recall("wie lange können wir zurückrollen", { k: 3 });
  assert.equal(hits[0]?.id, "deployment-rollback-fenster");
  assert.equal(hits[0]?.matched_recall_when, true);
});

test("#231: der Mischstil trägt — englische Fachanker in deutschen Triggern", async (t) => {
  const search = await index(t);

  // Die Gegenprobe aus dem Issue: Englische Fachbegriffe INNERHALB
  // nicht-englischer Trigger müssen weiter funktionieren. Die Hook-Query ist
  // reine Fachsprache (`ts typescript daemon`), und sie muss das Memory finden,
  // dessen deutscher Trigger diese Anker trägt.
  const query = hookQuery("neutral");
  assert.equal(query, "ts typescript daemon", "die Hook-Query ist sprachneutral gebaut");

  const hits = search.recall(query, { k: 3 });
  assert.equal(hits[0]?.id, "daemon-neustart-nach-aenderung");
  assert.equal(hits[0]?.matched_recall_when, true, "der Anker greift auch im Mischstil");
});

test("#231: das alte englische Template zieht den Störtreffer nach oben — die heutige Query nicht", async (t) => {
  const search = await index(t);

  // Das ist der Feldbericht im Kleinen, und die Schranke gegen ein Zurückdrehen.
  const neutral = search.recall(hookQuery("neutral"), { k: 5 });
  const englisch = search.recall(hookQuery("english"), { k: 5 });

  // Heute: Das fachlich richtige Memory führt, der englische Import ist weit weg.
  assert.equal(neutral[0]?.id, "daemon-neustart-nach-aenderung");
  const stoererNeutral = platz(neutral, "imported-english-style-guide");
  assert.ok(
    stoererNeutral === -1 || stoererNeutral > 0,
    "mit der sprachneutralen Query darf der englische Import nicht führen",
  );

  // Mit dem alten Template: Der Import übernimmt den ersten Platz, allein wegen
  // `editing` und `involving`. Bricht diese Zusicherung, hat jemand die
  // Query-Komposition zurückgedreht — und der Befund aus #231 ist zurück.
  assert.equal(
    englisch[0]?.id,
    "imported-english-style-guide",
    "das alte Template muss den Störtreffer nach oben ziehen — sonst prüft dieser Test nichts mehr",
  );

  // Und die Größenordnung, weil sie die Aussage trägt: Der Störtreffer steht
  // mit dem alten Template um ein Vielfaches über seinem heutigen Wert.
  const heute = neutral.find((h) => h.id === "imported-english-style-guide")?.score ?? 0;
  const damals = englisch[0]?.score ?? 0;
  assert.ok(
    damals > heute * 10,
    `der Sprung muss deutlich sein: heute ${heute}, mit altem Template ${damals}`,
  );
});

test("#231: der Störtreffer bleibt auch bei deutschen Fragen unten", async (t) => {
  const search = await index(t);

  // Die andere Hälfte des Feldberichts: Das grösste englische Dokument darf
  // nicht bei jeder unverwandten Frage oben stehen. Auf Deutsch gefragt, taucht
  // es gar nicht erst auf.
  for (const frage of ["bevor wir das Deployment starten", "bevor ich das Schema ändere"]) {
    const hits = search.recall(frage, { k: 5 });
    assert.notEqual(
      hits[0]?.id,
      "imported-english-style-guide",
      `„${frage}" darf nicht beim englischen Import landen`,
    );
  }
});
