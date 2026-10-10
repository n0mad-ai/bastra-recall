/**
 * hardware.ts — hardware detection + local-model recommendation for the installer.
 *
 * The installer already sets up the embedding model (embeddinggemma, ~0.6 GB) on
 * every machine that can run Ollama. The generation model (doc2query + rerank) is
 * heavier and its viable size depends on the machine's RAM, so we recommend a tier
 * instead of hardcoding one default.
 *
 * Baseline is 16 GB (the M4 Mac mini / a modern Windows dev box). We deliberately
 * do NOT optimize for 8 GB machines: below the baseline we recommend keyword/embed
 * only and skip the generation model rather than thrash a too-small machine.
 *
 * RAM is the single load-bearing signal, so detection stays cross-platform on
 * `os.totalmem()`; the Mac chip string is informational only.
 */
import { totalmem } from "node:os";
import { execFileSync } from "node:child_process";

export interface HardwareInfo {
  platform: NodeJS.Platform;
  ramGB: number;
  /** Apple Silicon chip string on macOS (e.g. "Apple M4 Pro"), else null. Info only. */
  chip: string | null;
}

export interface TextModelRec {
  /** Ollama model tag to pull, or null when the machine is below the baseline. */
  model: string | null;
  /** Approximate on-disk / RAM footprint of `model`, GB. 0 when model is null. */
  sizeGB: number;
  /** Coarse tier label for the UI. */
  tier: "keyword-only" | "baseline" | "enhanced" | "high";
  /** One-line, user-facing rationale. */
  note: string;
  /** A heavier opt-in alternative the machine can also run, if any. */
  alt?: { model: string; sizeGB: number; note: string };
}

/** Installed RAM in whole GB — the one signal the model ladder reads. */
export function detectRamGB(): number {
  return Math.round(totalmem() / 1024 ** 3);
}

/** Detect the running machine. Pure read; never throws (chip probe is best-effort). */
export function detectHardware(): HardwareInfo {
  const ramGB = detectRamGB();
  let chip: string | null = null;
  if (process.platform === "darwin") {
    try {
      chip = execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], {
        encoding: "utf8",
        timeout: 2000,
      }).trim() || null;
    } catch {
      /* best-effort; RAM is what drives the recommendation */
    }
  }
  return { platform: process.platform, ramGB, chip };
}

// The generation-model ladder. Kept as data so `bastra models` and the wizard
// share one source of truth, and so the tiers are unit-testable.
const BASELINE_GB = 16;
const ENHANCED_GB = 24;
const HIGH_GB = 32;

/**
 * A model recommendation that ships with a release: "we now think this model is
 * the better pick for your tier". Existing users are told about it and decide
 * themselves (model-recommendation.ts) — nothing ever switches on its own.
 */
export interface ModelRecommendation {
  /** Stable identifier. "Don't ask again" is remembered per id, and the answer
   *  commands name it — so a NEW recommendation needs a NEW id, and an unchanged
   *  one must keep its id. */
  id: string;
  /**
   * The recommended model per hardware tier. A tier without an entry gets no
   * recommendation (and below the 16 GB baseline there is none to give: those
   * machines run no text model). `sizeGB` is the download size; `improves` is
   * one honest, user-facing sentence on what gets better with THIS model — per
   * tier, because a 12B is not better in the same way a 4B is.
   */
  models: Partial<
    Record<Exclude<TextModelRec["tier"], "keyword-only">, { model: string; sizeGB: number; improves: string }>
  >;
}

/**
 * THE active recommendation of this release, or null for "none".
 *
 * Active since 1.1.0: existing installs on a 16 GB+ machine that run another
 * text model are told about it (model-recommendation.ts) and decide
 * themselves. This is the only place that holds it.
 *
 * - To change it — another model, size or sentence for any tier — edit the
 *   block and give it a NEW id: answers are remembered per id, so under the
 *   old id everyone who answered "dismiss" or "switch" would never hear of the
 *   change. An unchanged recommendation keeps its id across releases.
 * - To switch it off, set the constant to `null`: no notice anywhere, and new
 *   installs are offered the ladder's pick below.
 *
 * The `improves` sentences are covered by docs/local-model-comparison.md
 * (measured against gemma3:4b on one 24 GB machine); keep them in step with
 * that page.
 *
 * GENERATION_MODEL_DEFAULT (settings-file.ts) deliberately stays as it is
 * while a recommendation is active: it is the fallback of every user who never
 * stored a choice, so changing it would switch their model without asking.
 */
export const MODEL_RECOMMENDATION: ModelRecommendation | null = {
  id: "2026-10-tev1",
  models: {
    baseline: {
      model: "tev1:4b",
      sizeGB: 4.5,
      improves:
        "Compared with gemma3:4b: fewer wrong verdicts in the draft check, much harder to steer with injected text, and a more accurate reranker — at a similar answer time.",
    },
    enhanced: {
      model: "tev1:4b",
      sizeGB: 4.5,
      improves:
        "Compared with gemma3:4b: fewer wrong verdicts in the draft check, much harder to steer with injected text, and a more accurate reranker — at a similar answer time.",
    },
    high: {
      model: "gemma4:12b",
      sizeGB: 8.1,
      improves:
        "Compared with gemma3:4b: fewer wrong verdicts in the draft check, harder to steer with injected text, and a clearly more accurate reranker — at about three times the answer time.",
    },
  },
};

/**
 * Recommend a generation (doc2query + rerank) model for `ramGB`.
 *
 * Below the 16 GB baseline: no generation model — embedding + BM25 recall still
 * work and don't need it. At/above baseline: tev1:4b, a small text model. From
 * 24 GB a 12B is offered as the more accurate, slower alternative, and from
 * 32 GB it is the pick.
 *
 * This is what a NEW install is offered. It is deliberately not
 * GENERATION_MODEL_DEFAULT (settings-file.ts, still gemma3:4b): that constant
 * is what a daemon runs when no choice was ever stored, so moving it would
 * point existing installs at a model they have not pulled.
 *
 * The picks follow docs/local-model-comparison.md, measured on one 24 GB
 * machine. That a 4.5 GB model fits a 16 GB machine next to the embedding
 * model is derived from its size, not measured — the notes say so.
 *
 * An active release recommendation replaces the ladder's pick for its tier, so
 * the installer and `bastra models` offer new installs the recommended model
 * directly. Where it names the ladder's own model, the ladder's note stays: it
 * carries what was and was not measured. `recommendation` is a parameter for
 * tests only.
 */
export function recommendTextModel(
  ramGB: number,
  recommendation: ModelRecommendation | null = MODEL_RECOMMENDATION,
): TextModelRec {
  const ladder = ladderTextModel(ramGB);
  if (!recommendation || ladder.tier === "keyword-only") return ladder;
  const pick = recommendation.models[ladder.tier];
  if (!pick) return ladder;
  return {
    model: pick.model,
    sizeGB: pick.sizeGB,
    tier: ladder.tier,
    note:
      pick.model === ladder.model
        ? ladder.note
        : `${ramGB} GB — ${pick.model} is the current bastra-recall recommendation for this machine.`,
    ...(ladder.alt && ladder.alt.model !== pick.model ? { alt: ladder.alt } : {}),
  };
}

function ladderTextModel(ramGB: number): TextModelRec {
  if (ramGB < BASELINE_GB) {
    return {
      model: null,
      sizeGB: 0,
      tier: "keyword-only",
      note: `${ramGB} GB is below the 16 GB baseline — keyword + semantic recall run fine without a generation model.`,
    };
  }
  if (ramGB < ENHANCED_GB) {
    return {
      model: "tev1:4b",
      sizeGB: 4.5,
      tier: "baseline",
      note: `${ramGB} GB — tev1:4b (a small text model) is the suggestion for this tier. That it fits next to the embedding model follows from its size (4.5 GB); it was not measured on a 16 GB machine.`,
    };
  }
  if (ramGB < HIGH_GB) {
    return {
      model: "tev1:4b",
      sizeGB: 4.5,
      tier: "enhanced",
      note: `${ramGB} GB — tev1:4b is the suggestion; gemma4:12b was more accurate in our comparison at about three times the answer time. Both ran on a 24 GB machine there.`,
      alt: { model: "gemma4:12b", sizeGB: 8.1, note: "12B, more accurate in our comparison, about three times the answer time" },
    };
  }
  return {
    model: "gemma4:12b",
    sizeGB: 8.1,
    tier: "high",
    note: `${ramGB} GB — gemma4:12b (a 12B text model), the most accurate model in our comparison.`,
  };
}
