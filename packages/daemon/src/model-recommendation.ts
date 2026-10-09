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
 * What the release recommends for THIS machine, whatever model runs on it —
 * or null: no active recommendation, a machine below the 16 GB tier (it runs no
 * text model), or a recommendation that has nothing for this tier.
 *
 * This is what an answer is checked against. It deliberately does not look at
 * the model in effect: that depends on the environment of the process asking,
 * and the shell that answers is not the daemon that asked.
 */
export async function machineRecommendation(opts: OfferOptions = {}): Promise<ModelOffer | null> {
  const recommendation = opts.recommendation === undefined ? MODEL_RECOMMENDATION : opts.recommendation;
  if (!recommendation) return null;
  const { tier } = recommendTextModel(opts.ramGB ?? detectRamGB(), null);
  if (tier === "keyword-only") return null;
  const pick = recommendation.models[tier];
  if (!pick) return null;
  const current = await resolveGenerationModel(opts.settingsPath);
  // Same order as resolveGenerationModel, so the name is the variable that won.
  const envName = process.env.BASTRA_EXPAND_MODEL !== undefined ? "BASTRA_EXPAND_MODEL" : "BASTRA_RERANK_MODEL";
  const envOverride = (process.env[envName] ?? "").trim().length > 0 ? envName : null;
  return { id: recommendation.id, ...pick, current, envOverride };
}

/**
 * The recommendation as an offer: null as well when the recommended model is
 * already the one in effect here.
 *
 * A deliberately chosen model — stored or pinned by env — is offered the
 * recommendation like any other. Ignores the user's earlier answer: this is
 * what `bastra models` shows at any time.
 */
export async function currentModelOffer(opts: OfferOptions = {}): Promise<ModelOffer | null> {
  const offer = await machineRecommendation(opts);
  return offer && offer.current !== offer.model ? offer : null;
}

/**
 * The offer, if the user still has to be asked about it — what the surfaces
 * that speak up on their own use (SessionStart, the CLI hint, `bastra update`).
 *
 * Silent when update notices are off (`BASTRA_UPDATE_CHECK=off` or
 * `update.mode off`: this notice arrives with an update, and whoever turned
 * those off did not ask to hear about this one), when nothing on this install
 * uses a text model (see textModelInUse), and when the user has answered:
 * "switched" and "dismissed" for good, "later" for 7 days. An answer to an
 * older recommendation id does not count, and "asked" is not an answer.
 */
export async function pendingModelNotice(opts: OfferOptions = {}): Promise<ModelOffer | null> {
  if ((await effectiveUpdateMode(opts.settingsPath)) === "off") return null;
  const offer = await currentModelOffer(opts);
  if (!offer) return null;
  if (!(await textModelInUse(offer, opts.settingsPath))) return null;
  const note = (await readSettings(opts.settingsPath)).modelRecommendation;
  if (note?.id === offer.id && note.answer !== "asked") {
    if (note.answer !== "later") return null;
    // A timestamp that is unreadable or lies in the future (a clock that was
    // set back) must not silence the reminder for good: only a real, elapsed
    // wait of under 7 days does.
    const waited = (opts.now ?? Date.now()) - Date.parse(note.at);
    if (waited >= 0 && waited < REMIND_AFTER_MS) return null;
  }
  return offer;
}

/**
 * Does anything on this install run the text model?
 *
 * Inside the daemon all three jobs (trigger expansion, the draft check, the
 * search copilot) start only when Ollama is the embedding provider. Outside it,
 * `bastra bridges harvest` reranks with the same model whatever the embedding
 * provider is — but only for someone who set a text model up. So: Ollama
 * embeddings, or a text model the user chose (stored, or pinned by env). An
 * install with neither would be recommended a multi-GB download nothing calls.
 */
async function textModelInUse(offer: ModelOffer, settingsPath?: string): Promise<boolean> {
  if (offer.envOverride) return true;
  if ((await readSettings(settingsPath)).generation?.model !== undefined) return true;
  return (await resolveEmbeddingChoice({ path: settingsPath })).provider === "ollama";
}

/**
 * Remembers the user's answer to recommendation `id` — and, for a switch, the
 * new model in the SAME write. One transaction under the settings lock: a
 * crash or a full disk leaves both or neither, and two processes cannot end
 * with one's model next to the other's answer.
 *
 * Throws instead of writing when the settings file is there but unreadable or
 * not valid JSON (checked inside the lock): the write would replace it with
 * defaults plus this one field and lose every other setting, which is no way
 * to record a model decision. Throws as well when the cross-process lock
 * cannot be had (PathLockUnavailableError): writing without it could put this
 * answer over another process's, and the user can simply answer again.
 */
export async function recordModelAnswer(
  id: string,
  answer: Exclude<ModelRecommendationAnswer, "asked">,
  path: string = settingsFilePath(),
  now: number = Date.now(),
  model?: string,
): Promise<void> {
  await mutateSettings(
    path,
    (current) => ({
      ...current,
      ...(model ? { generation: { model } } : {}),
      modelRecommendation: { id, answer, at: new Date(now).toISOString() },
    }),
    { refuseCorrupt: true, requireLock: true },
  );
}

/**
 * Claims the terminal question for recommendation `id`: notes "asked" — but
 * only if there is no note for this id yet, decided inside the settings lock.
 * Returns whether the claim was made.
 *
 * Check and write are one step on purpose. Checked outside and written
 * afterwards, a decision that lands in between ("dismissed", from the chat)
 * would be turned back into "asked" and the user asked again; and two commands
 * finishing at the same moment would both ask. "asked" never replaces
 * anything: it is not an answer and must not take one back.
 *
 * A claim made without the lock is no claim — every process that gave up
 * waiting would hold it. So this throws (PathLockUnavailableError) rather than
 * fall back to path-lock's fail-open; the caller then does not ask, and the
 * question comes back with the next command.
 */
export async function claimModelQuestion(id: string, path: string = settingsFilePath(), now: number = Date.now()): Promise<boolean> {
  let claimed = false;
  await mutateSettings(
    path,
    (current) => {
      if (current.modelRecommendation?.id === id) return null;
      claimed = true;
      return { ...current, modelRecommendation: { id, answer: "asked", at: new Date(now).toISOString() } };
    },
    { refuseCorrupt: true, requireLock: true },
  );
  return claimed;
}

/** Why a switch alone does not take effect while the variable is set. */
export function envOverrideNote(offer: ModelOffer): string | null {
  if (!offer.envOverride) return null;
  // Without the value when it is not a plain model tag (see blockSafe).
  const assignment = isModelTag(offer.current) ? `${offer.envOverride}=${offer.current}` : offer.envOverride;
  return (
    `${assignment} is set in the environment and overrides the saved choice: ` +
    `the switch only takes effect once that variable is removed and the daemon restarted.`
  );
}

/** What an Ollama model tag looks like: letters, digits and . _ - : / */
function isModelTag(value: string): boolean {
  return /^[A-Za-z0-9._:/-]{1,128}$/.test(value);
}

/**
 * The offer as the SessionStart block may show it. The model in effect comes
 * from the settings file or an environment variable — free text that would
 * otherwise go verbatim into instructions an agent reads. Anything that is not
 * a plain model tag is replaced by a neutral placeholder; the recommendation
 * itself (id, model) ships with the release and is checked the same way, so a
 * block is never built around a value that could close its own tag.
 */
function blockSafe(offer: ModelOffer): ModelOffer & { currentIsTag: boolean } {
  const currentIsTag = isModelTag(offer.current);
  return { ...offer, current: currentIsTag ? offer.current : "a custom model", currentIsTag };
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
export const DISMISS_STILL_OPEN = "'bastra models' keeps showing the recommendation and you can still switch later";

/**
 * The command for one of the three answers. It names the recommendation — and
 * for a switch the model — so the answer can only be carried out on what the
 * user was shown: a CLI that meanwhile ships a different recommendation than
 * the daemon that printed this refuses it instead of pulling something else.
 */
export function decisionCommand(choice: "switch" | "later" | "dismiss", offer: ModelOffer): string {
  return choice === "switch"
    ? `bastra models switch ${offer.id} ${offer.model}`
    : `bastra models ${choice} ${offer.id}`;
}

/** The plain notice for a terminal: the CLI hint and `bastra update` without a TTY. */
export function formatModelNotice(offer: ModelOffer): string {
  const env = envOverrideNote(offer);
  return [
    ...modelOfferFacts(offer),
    ...(env ? [`Note: ${env}`] : []),
    "Decide with:",
    `  ${decisionCommand("switch", offer)}   switch now`,
    `  ${decisionCommand("later", offer)}   keep the current model, ask again in 7 days`,
    `  ${decisionCommand("dismiss", offer)}   stop asking — ${DISMISS_WARNING}; ${DISMISS_STILL_OPEN}`,
  ].join("\n");
}

/**
 * The SessionStart block. The agent may run the switch, but only after the
 * user said yes — the block is written so that it cannot be read as an order
 * to switch. It is sent at every session start until the user has answered —
 * deliberately without a day throttle — so the one way to end it for good,
 * `dismiss`, comes with the warning the agent has to pass on first.
 */
export function formatModelSessionBlock(shown: ModelOffer): string {
  // A recommendation whose own id or model is not a plain tag is not announced
  // in a block at all (it cannot happen with shipped data; this is the guard).
  if (!isModelTag(shown.id) || !isModelTag(shown.model)) return "";
  const env = envOverrideNote(shown);
  const offer = blockSafe(shown);
  return (
    `\n<bastra-model-recommendation>\n` +
    modelOfferFacts(offer).join("\n") +
    `\n` +
    `Tell the user about this recommendation, including the download size, and ASK whether they want to switch. ` +
    `Never switch on your own: run none of the commands below before the user has answered explicitly, ` +
    `and run them exactly as written — they name this recommendation, and bastra refuses them if it has changed.\n` +
    `- The user says yes → run \`${decisionCommand("switch", offer)}\`. It downloads ${offer.model}, checks it with a short test call ` +
    `and only then changes the setting; if anything fails, nothing changes. The old model stays installed ` +
    (offer.currentIsTag
      ? `(switch back: \`bastra models set ${offer.current}\`).\n`
      : `(switch back with \`bastra models set\` and the old model's tag, which the switch prints).\n`) +
    `- The user says later → run \`${decisionCommand("later", offer)}\` (asks again in 7 days).\n` +
    `- The user says no / stop asking → FIRST tell them what that means: ${DISMISS_WARNING}; ${DISMISS_STILL_OPEN}. ` +
    `Only when they confirm after hearing that, run \`${decisionCommand("dismiss", offer)}\` (a future, new recommendation asks again).\n` +
    (env ? `Also tell the user: ${env}\n` : "") +
    `</bastra-model-recommendation>`
  );
}
