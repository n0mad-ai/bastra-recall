/**
 * The model-recommendation notice for existing users.
 *
 * A release can carry a recommendation for the local generation model
 * (cli/hardware.ts MODEL_RECOMMENDATION). New installs are simply offered it by
 * the installer. Existing users already run a model, and nothing may switch it
 * behind their back — so they are told, and they decide: switch now, later
 * (asked again after 7 days), or not for this recommendation.
 *
 * This file is the part every surface shares, so they cannot drift apart:
 *   - the decision "is there something to say on this machine?",
 *   - the ONE note of the user's answer (cli-settings.json modelRecommendation),
 *   - the texts.
 * `bastra update`, `bastra models`, the SessionStart block and the CLI hint all
 * read the same note, so an answer given in one place silences the others.
 *
 * No network access: the recommendation ships with the release. The embedding
 * model is NOT part of this — switching it means re-reading every note.
 */
import { MODEL_RECOMMENDATION, detectRamGB, recommendTextModel, type ModelRecommendation } from "./cli/hardware.js";
import {
  effectiveUpdateMode,
  mutateSettings,
  readSettings,
  resolveEmbeddingChoice,
  resolveGenerationModel,
  settingsFilePath,
} from "./settings.js";
import type { ModelRecommendationAnswer } from "./settings-file.js";

export const MODEL_COMPARISON_URL =
  "https://github.com/n0mad-ai/bastra-recall/blob/main/docs/local-model-comparison.md";
export const REMIND_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** What this machine is being offered. */
export interface ModelOffer {
  /** The recommendation's id — what an answer is remembered under. */
  id: string;
  model: string;
  /** Download size, GB. */
  sizeGB: number;
  improves: string;
  /** The model in effect right now (env > cli-settings > default). */
  current: string;
  /** Name of the env variable that pins `current`, or null. A stored choice
   *  cannot win against it, and every text says so. */
  envOverride: "BASTRA_EXPAND_MODEL" | "BASTRA_RERANK_MODEL" | null;
}

export interface OfferOptions {
  /** Tests inject a recommendation; the default is the shipped one. */
  recommendation?: ModelRecommendation | null;
  ramGB?: number;
  settingsPath?: string;
  now?: number;
}

/**
 * The recommendation as it applies to this machine, or null when there is
 * nothing to offer: no active recommendation, a machine below the 16 GB tier
 * (it runs no text model), or the recommended model is already in effect.
 *
 * A deliberately chosen model — stored or pinned by env — is offered the
 * recommendation like any other. Ignores the user's earlier answer: this is
 * what `bastra models` shows at any time.
 */
export async function currentModelOffer(opts: OfferOptions = {}): Promise<ModelOffer | null> {
  const recommendation = opts.recommendation === undefined ? MODEL_RECOMMENDATION : opts.recommendation;
  if (!recommendation) return null;
  const { tier } = recommendTextModel(opts.ramGB ?? detectRamGB(), null);
  if (tier === "keyword-only") return null;
  const pick = recommendation.models[tier];
  const current = await resolveGenerationModel(opts.settingsPath);
  if (current === pick.model) return null;
  // Same order as resolveGenerationModel, so the name is the variable that won.
  const envName = process.env.BASTRA_EXPAND_MODEL !== undefined ? "BASTRA_EXPAND_MODEL" : "BASTRA_RERANK_MODEL";
  const envOverride = (process.env[envName] ?? "").trim().length > 0 ? envName : null;
  return { id: recommendation.id, model: pick.model, sizeGB: pick.sizeGB, improves: recommendation.improves, current, envOverride };
}

/**
 * The offer, if the user still has to be asked about it — what the surfaces
 * that speak up on their own use (SessionStart, the CLI hint, `bastra update`).
 *
 * Silent when update notices are off (`BASTRA_UPDATE_CHECK=off` or
 * `update.mode off`: this notice arrives with an update, and whoever turned
 * those off did not ask to hear about this one), when the generation model
 * never runs here (it needs Ollama as the embedding provider — an 8 GB
 * download for a model nothing calls is not a recommendation), and when the
 * user has answered: "switched" and "dismissed" for good, "later" for 7 days.
 * An answer to an older recommendation id does not count.
 */
export async function pendingModelNotice(opts: OfferOptions = {}): Promise<ModelOffer | null> {
  if ((await effectiveUpdateMode(opts.settingsPath)) === "off") return null;
  const offer = await currentModelOffer(opts);
  if (!offer) return null;
  if ((await resolveEmbeddingChoice({ path: opts.settingsPath })).provider !== "ollama") return null;
  const note = (await readSettings(opts.settingsPath)).modelRecommendation;
  if (note?.id === offer.id) {
    if (note.answer !== "later") return null;
    if ((opts.now ?? Date.now()) - Date.parse(note.at) < REMIND_AFTER_MS) return null;
  }
  return offer;
}

/** Remembers the user's answer to recommendation `id`. */
export async function recordModelAnswer(
  id: string,
  answer: ModelRecommendationAnswer,
  path: string = settingsFilePath(),
  now: number = Date.now(),
): Promise<void> {
  await mutateSettings(path, (current) => ({
    ...current,
    modelRecommendation: { id, answer, at: new Date(now).toISOString() },
  }));
}

/** Why a switch alone does not take effect while the variable is set. */
export function envOverrideNote(offer: ModelOffer): string | null {
  if (!offer.envOverride) return null;
  return (
    `${offer.envOverride}=${offer.current} is set in the environment and overrides the saved choice: ` +
    `the switch only takes effect once that variable is removed and the daemon restarted.`
  );
}

/** The facts, shared by every text: what, how big, what for, where to read more. */
export function modelOfferFacts(offer: ModelOffer): string[] {
  return [
    `bastra-recall recommends a different local text model for this machine: ${offer.model} (you run ${offer.current}).`,
    `What gets better: ${offer.improves}`,
    `Download: about ${offer.sizeGB} GB. Comparison: ${MODEL_COMPARISON_URL}`,
  ];
}

/**
 * What "don't ask again" costs. The notice is repeated on purpose until the
 * user answers, so turning it off has to be an informed choice: this sentence
 * stands wherever `dismiss` is offered and wherever it is confirmed.
 */
export const DISMISS_WARNING =
  "this notice will not come back for this recommendation, and you may be giving up better recall quality";
/** …and what stays possible afterwards. Always said together with the warning. */
export const DISMISS_STILL_OPEN = "'bastra models' keeps showing the recommendation and 'bastra models switch' works any time";

/** The three answers as commands, one per line. */
export const MODEL_DECISION_COMMANDS = [
  "bastra models switch    switch now",
  "bastra models later     keep the current model, ask again in 7 days",
  `bastra models dismiss   stop asking — ${DISMISS_WARNING}; ${DISMISS_STILL_OPEN}`,
];

/** The plain notice for a terminal: the CLI hint and `bastra update` without a TTY. */
export function formatModelNotice(offer: ModelOffer): string {
  const env = envOverrideNote(offer);
  return [
    ...modelOfferFacts(offer),
    ...(env ? [`Note: ${env}`] : []),
    "Decide with:",
    ...MODEL_DECISION_COMMANDS.map((c) => `  ${c}`),
  ].join("\n");
}

/**
 * The SessionStart block. The agent may run the switch, but only after the
 * user said yes — the block is written so that it cannot be read as an order
 * to switch. It is sent at every session start until the user has answered —
 * deliberately without a day throttle — so the one way to end it for good,
 * `dismiss`, comes with the warning the agent has to pass on first.
 */
export function formatModelSessionBlock(offer: ModelOffer): string {
  const env = envOverrideNote(offer);
  return (
    `\n<bastra-model-recommendation>\n` +
    modelOfferFacts(offer).join("\n") +
    `\n` +
    `Tell the user about this recommendation, including the download size, and ASK whether they want to switch. ` +
    `Never switch on your own: run none of the commands below before the user has answered explicitly.\n` +
    `- The user says yes → run \`bastra models switch\`. It downloads ${offer.model}, checks it with a short test call ` +
    `and only then changes the setting; if anything fails, nothing changes. The old model stays installed ` +
    `(switch back: \`bastra models set ${offer.current}\`).\n` +
    `- The user says later → run \`bastra models later\` (asks again in 7 days).\n` +
    `- The user says no / stop asking → FIRST tell them what that means: ${DISMISS_WARNING}; ${DISMISS_STILL_OPEN}. ` +
    `Only when they confirm after hearing that, run \`bastra models dismiss\` (a future, new recommendation asks again).\n` +
    (env ? `Also tell the user: ${env}\n` : "") +
    `</bastra-model-recommendation>`
  );
}
