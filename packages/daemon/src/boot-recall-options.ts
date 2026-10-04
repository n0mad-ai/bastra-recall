/**
 * Start-up phase 2 (#1039): the recall switches resolved once at boot — the
 * evidence gate and the shared learned-recall bridge pool (with its one-time
 * #648 copy out of the Commons root).
 *
 * Moved verbatim out of `main()` in `index.ts`.
 */
import { getEvidenceGateEnabled, getSharedRecallEnabled, getSharedRecallLanguage, getSharedRecallLive } from "./settings.js";
import { commonsPath } from "./cli/commons.js";
import { bridgesPath, migrateBridgesPool } from "./cli/bridges.js";
import { BridgePool } from "./learned-recall/bridges.js";
import { isSupportedLanguage, type SupportedLanguage } from "./learned-recall/language.js";

export async function resolveRecallOptions(): Promise<{
  evidenceGateOn: boolean;
  learnedBridges: BridgePool | null;
  sharedRecallLang: SupportedLanguage | null;
}> {
  // Shared learned-recall bridges (#120): read-only pool
  // that widens recall queries. Same discipline as Commons — never written, only
  // loaded when opted in. Off = pool stays null and nothing is constructed or
  // contacted (local-first). The optional language override skips per-query detection.
  // #264: einmal gelesen, nicht je Recall — der Hook-Pfad ist der
  // frequentierteste und verträgt keinen Datei-Zugriff pro Aufruf. Ein
  // Umschalten wirkt nach einem Daemon-Neustart; der Rückfall bei einem DEFEKT
  // ist davon unabhängig und sofort (fail-open in runHookRecall).
  const evidenceGateOn = await getEvidenceGateEnabled();
  if (evidenceGateOn) {
    console.error(
      "[bastra-recall] evidence gate: ACTIVE — no_answer suppresses hits (#264/#422); BASTRA_EVIDENCE_GATE=0 is the instant off-switch",
    );
  } else {
    // #422: seit dem Default `true` ist AUS die Abweichung, die man sehen muss.
    console.error("[bastra-recall] evidence gate: OFF (settings or BASTRA_EVIDENCE_GATE) — legacy bands serve every hit");
  }

  // #648: a pool minted before the split still sits in the Commons root; copy
  // it to its own directory once, before the first load or mint reads it.
  try {
    const copied = migrateBridgesPool();
    if (copied.length > 0) {
      console.error(`[bastra-recall] bridges: copied ${copied.join(" + ")} from ${commonsPath()} to ${bridgesPath()} (#648; originals kept)`);
    }
  } catch (err) {
    console.error(`[bastra-recall] bridges: could not copy the pool from ${commonsPath()} to ${bridgesPath()} (${(err as Error).message}) — minting starts a new pool`);
  }

  let learnedBridges: BridgePool | null = null;
  let sharedRecallLang: SupportedLanguage | null = null;
  if (await getSharedRecallEnabled()) {
    try {
      learnedBridges = BridgePool.load(bridgesPath(), undefined, { live: await getSharedRecallLive() });
      const lang = await getSharedRecallLanguage();
      sharedRecallLang = isSupportedLanguage(lang) ? lang : null;
      console.error(
        `[bastra-recall] shared learned-recall: enabled (${learnedBridges.size()} bridges across ${learnedBridges.languages().join(", ") || "no"} languages, query-language ${sharedRecallLang ?? "auto — every folder"}, query expansion ${learnedBridges.live ? "live" : "shadow"})`,
      );
    } catch (err) {
      console.error(`[bastra-recall] shared learned-recall: failed to load (${(err as Error).message}) — continuing without`);
      learnedBridges = null;
    }
  }

  return { evidenceGateOn, learnedBridges, sharedRecallLang };
}
