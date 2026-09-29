/**
 * /hook/recall — assembling the wire payload (split out of
 * http-hook-routes.ts, #680, the cut named in #504): lean projection,
 * reflex-hit merge from the candidate pool, and the per-call token budget.
 */
import type { RecallHit, Vault } from "@bastra-recall/core";
import { missingVaultReason } from "./vault-presence.js";
import { vaultKnowsProject } from "./scope-filter.js";
import { toLeanHit } from "./tool-handlers.js";
import { armsOf, SCORE_VERSION } from "./score-space.js";
import { collectPoolReflexHits } from "./recall-pipeline.js";
import { fitRecallWithReflexToBudget } from "./recall-budget.js";

export interface HookRecallPayloadInput {
  hits: RecallHit[];
  candidatePool: { id: string; score: number }[];
  vault: Vault;
  maxTokens: number;
  totalLatencyMs: number;
  recallId: string;
  weakResult: boolean;
  noHome: boolean;
  hookProject: string | null;
  hybridActiveAtRecall: boolean;
  degradedReason: string | undefined;
}

/** Builds the budgeted response payload; `.payload` is what goes on the wire. */
export function assembleHookRecallPayload(input: HookRecallPayloadInput) {
  const {
    hits, candidatePool, vault, maxTokens, totalLatencyMs, recallId, weakResult, noHome,
    hookProject, hybridActiveAtRecall, degradedReason,
  } = input;
  // Lean projection (#50): the hook CLI only consumes lean fields, so we
  // never need to send matched_terms/mode/hop/topic_path over the wire.
  // Telemetry above already logged the full hits. #148: the hook scope
  // filter needs the one extra bit `matched_recall_when` (kept here only,
  // not in the shared toLeanHit — MCP recall stays the documented lean shape).
  // #249: the honesty flag has to reach THIS path above all. /hook/recall
  // writes <recall-hints> into the agent's context on every Bash and Edit,
  // and without the flag the formatters label pure noise as "Strong
  // matches" — the daemon computed the contradicting signal and simply did
  // not send it. Same computation as the MCP path, from the same module.
  // 20.08.: reflex-wired memories (recall_mode "reflex") from the deeper
  // candidate pool that the top-k cut left out. The prompt lane's semantic
  // reflex filter only ever saw `hits`; on 20.08. the wired convention sat
  // at pool rank 6 behind a k of 5 and never reached the agent. The pool is
  // the user's explicit wiring — two memories — so scanning it is cheap,
  // and the lane keeps every floor and dedup it already applies.
  // #421: derselbe Schritt, den der MCP-`recallHandler` fährt
  // (`recall-pipeline.ts`). Floor 0: Die Lanes wenden ihren eigenen an.
  const reflexHits = collectPoolReflexHits(candidatePool, new Set(hits.map((h) => h.id)), vault);
  // recall_mode rides along only when the user wired the memory as
  // reflex: the prompt lane's mode-"none" semantic filter keys on it
  // (19.08. incident — see prompt-lane.ts).
  const leanHits = hits.map((h) => ({
    ...toLeanHit(h),
    matched_recall_when: h.matched_recall_when ?? false,
    // P0: Der Cross-Scope-Bypass in den Lanes braucht mehr als das Flag —
    // ein einzelnes häufiges Wort in einer fremden Triggerphrase ist
    // keine Absicht. Nur gesetzt, wenn überhaupt ein Trigger-Term traf.
    ...(h.anchor_strength ? { anchor_strength: h.anchor_strength } : {}),
    ...(vault.get(h.id)?.fm.recall_mode === "reflex" ? { recall_mode: "reflex" as const } : {}),
  }));
  // #487: Das Kontextbudget des AUFRUFS. Gestrichen wird von hinten, und
  // die Streichliste ist [reflex …, gerankt …]: zuerst fallen die
  // gerankten Treffer (der schwächste zuerst), und erst wenn keiner mehr
  // da ist, die `reflex_hits` (der schwächste zuerst). Sie behalten damit
  // den Vorrang, der ihnen als ausdrückliche Verdrahtung des Nutzers
  // zusteht — aber sie sind nicht mehr vom Budget ausgenommen. Waren sie
  // es (bis P1/#487), stand bei `max_tokens: 1` und 32 reflex-Memories ein
  // Payload von 2352 Token auf der Leitung: ein Budget mit unbegrenzter
  // Ausnahme ist kein Budget. Gemessen wird wie überall das ganze Payload.
  // Ohne `max_tokens` (0) baut die Funktion einmal und die Antwort ist
  // byte-gleich zu der vor #487.
  const vaultMissing = missingVaultReason(vault.root);
  const budgeted = fitRecallWithReflexToBudget(leanHits, reflexHits, maxTokens, (emittedHits, emittedReflex, droppedByBudget) => ({
    hits: emittedHits,
    ...(emittedReflex.length > 0 ? { reflex_hits: emittedReflex } : {}),
    vault_size: vault.size(),
    // The MCP forwarder's recall path is this stream, not recallHandler.
    ...(vaultMissing ? { vault_missing: vaultMissing } : {}),
    latency_ms: totalLatencyMs,
    recall_id: recallId,
    ...(weakResult ? { weak_result: true } : {}),
    // #230: the stricter half travels the same wire. A strict subset of
    // weak_result, so a consumer that only knows weak_result is unaffected.
    ...(noHome ? { no_home: true } : {}),
    // #302: whether RRF ran at all. Without a vector arm there is no
    // fusion and no ceiling — raw BM25 is unbounded (top hits into six
    // digits on a real vault), so the 30/100 cuts describe nothing there.
    // The formatter has to say so rather than band an unbounded scale.
    // Same shape as the flags above: present only when it has something
    // to say, computed once from the value the honesty flags already use.
    // P0: derselbe explizite Score-Raum wie auf dem MCP-Pfad. `unfused`
    // sagt es indirekt, aber ein Konsument soll das Feld lesen können,
    // statt aus einer Abwesenheit zu schließen.
    // Codex-Gegenreview zum Confidence-Gate: Kennt der Vault den
    // Projektnamen überhaupt? `detectProject()` liefert für
    // `/workspace/packages/core` das Projekt "packages" — mit voller
    // Zuversicht, denn ein Pfadsegment hieß "workspace". Ein scharfer
    // Scope-Filter würde damit das ganze eigene Gedächtnis entfernen.
    // Die Frage ist nur HIER beantwortbar, wo der Vault liegt; die Lanes
    // sehen ihn nicht. Früher Abbruch beim ersten Treffer: der Normalfall
    // (eigenes Projekt) kostet nichts, nur der seltene Fehlerfall läuft
    // einmal durch.
    ...(hookProject !== null ? { project_known: vaultKnowsProject(vault, hookProject) } : {}),
    score_kind: hybridActiveAtRecall ? ("rrf" as const) : ("bm25" as const),
    // Dieselbe Angabe wie auf dem MCP-Pfad: `score_kind` allein macht zwei
    // Zahlen nicht vergleichbar, die Armmenge tut es. Der Hook-Pfad kennt
    // keine Commons — hier sind es immer die persönlichen Arme, und genau
    // das muss auf der Leitung stehen, statt vom Konsumenten geraten zu
    // werden.
    score_arms: armsOf({ hybridActive: hybridActiveAtRecall, commonsFused: false }),
    // Keine Formelversion auf einer rohen Skala — siehe recall-handler.ts.
    ...(hybridActiveAtRecall ? { score_version: SCORE_VERSION } : { unfused: true }),
    // #342: name the reason on the wire too. `unfused` says the bands do
    // not apply; this says why, so a slow machine degrading on every call
    // is distinguishable from embeddings being off — from the response
    // alone, without correlating against the telemetry log.
    ...(degradedReason ? { degraded: degradedReason } : {}),
    // #487: nur gesetzt, wenn das Budget wirklich gestrichen hat.
    ...(droppedByBudget > 0
      ? { truncated_by_budget: true, dropped_by_budget: droppedByBudget }
      : {}),
  }));
  return budgeted;
}
