/**
 * `bastra models` — inspect / set the local generation (doc2query + rerank) text
 * model. Mirrors `bastra embeddings`: the choice persists to cli-settings.json
 * (cross-platform, so Windows/Linux carry it too) and the Ollama pull is
 * delegated to enableGenerationModel.
 *
 *   bastra models            show the active model + this machine's recommendation
 *   bastra models recommend  print the hardware-tiered recommendation only
 *   bastra models set <tag>  pull <tag> + persist it as the generation model
 *
 * And the answers to a release's model recommendation (model-recommendation.ts),
 * as plain subcommands so an agent can run them once the user has decided:
 *
 *   bastra models switch     pull the recommended model, test it, then switch
 *   bastra models later      ask again in 7 days
 *   bastra models dismiss    do not ask again for this recommendation
 *   bastra models ask        the question itself — what `bastra update` ends with
 */
import { detectHardware, recommendTextModel } from "./hardware.js";
import { resolveGenerationModel, readSettings, GENERATION_MODEL_DEFAULT } from "../settings.js";
import { enableGenerationModel } from "./ollama.js";
import { ask, isInteractive } from "./prompt.js";
import {
  currentModelOffer,
  envOverrideNote,
  formatModelNotice,
  modelOfferFacts,
  pendingModelNotice,
  recordModelAnswer,
  type ModelOffer,
  type OfferOptions,
} from "../model-recommendation.js";

function write(line: string): void {
  process.stdout.write(line + "\n");
}

/** Injected by tests only: a recommendation, the machine, the pull and the prompt. */
export interface ModelsDeps extends OfferOptions {
  enable?: typeof enableGenerationModel;
  interactive?: boolean;
  ask?: typeof ask;
}

export async function cmdModels(opts: {
  sub: string | null;
  positional?: string[];
  settingsPath?: string;
  deps?: ModelsDeps;
}): Promise<number> {
  const deps: ModelsDeps = { ...opts.deps, settingsPath: opts.settingsPath };
  switch (opts.sub ?? "status") {
    case "status":
      return cmdStatus(deps);
    case "recommend":
      return cmdRecommend();
    case "set": {
      // positional = [command, surface, ...args] — the model tag is [2],
      // matching cmdBridges / cmdCommons.
      const model = opts.positional?.[2];
      if (!model) {
        process.stderr.write("usage: bastra models set <ollama-model-tag>   (e.g. gemma4:12b)\n");
        return 2;
      }
      return cmdSet(model, opts.settingsPath);
    }
    case "switch":
    case "later":
    case "dismiss": {
      // Open at any time, whatever was answered before: a "dismiss" must not
      // lock the user out of switching later.
      const offer = await currentModelOffer(deps);
      if (!offer) {
        write("Nothing to decide: there is no model recommendation open for this machine.");
        return 0;
      }
      return answer(opts.sub as "switch" | "later" | "dismiss", offer, deps);
    }
    case "ask":
      return cmdAsk(deps);
    default:
      process.stderr.write("usage: bastra models [status | recommend | set <tag> | switch | later | dismiss]\n");
      return 2;
  }
}

async function cmdStatus(deps: ModelsDeps): Promise<number> {
  const active = await resolveGenerationModel(deps.settingsPath);
  const hw = detectHardware();
  const rec = recommendTextModel(deps.ramGB ?? hw.ramGB, deps.recommendation);
  write(`generation model: ${active}${active === GENERATION_MODEL_DEFAULT ? " (default)" : ""}`);
  write(`machine: ${hw.ramGB} GB${hw.chip ? `, ${hw.chip}` : ""} (${hw.platform})`);
  write(`recommended: ${rec.model ?? "— none —"}  [${rec.tier}]`);
  if (rec.alt) write(`  opt-in alternative: ${rec.alt.model} — ${rec.alt.note}`);
  write(rec.note);
  const offer = await currentModelOffer(deps);
  if (offer) {
    write("");
    write(formatModelNotice(offer));
  } else if (rec.model && active !== rec.model && rec.tier !== "keyword-only") {
    write(`\nto switch: bastra models set ${rec.alt?.model ?? rec.model}`);
  }
  return 0;
}

async function cmdRecommend(): Promise<number> {
  const hw = detectHardware();
  const rec = recommendTextModel(hw.ramGB);
  write(rec.model ?? "none");
  write(`# ${hw.ramGB} GB [${rec.tier}] — ${rec.note}`);
  if (rec.alt) write(`# opt-in: ${rec.alt.model}`);
  return 0;
}

async function cmdSet(model: string, settingsPath?: string): Promise<number> {
  write(`Setting the generation model to ${model} …`);
  const r = await enableGenerationModel(model, { dryRun: false }, settingsPath);
  write((r.activated ? "✓ " : "✗ ") + r.message);
  return r.activated ? 0 : 1;
}

/**
 * Carries out one of the three answers. A failed switch records nothing — the
 * setting is unchanged, so the question is still open.
 */
async function answer(choice: "switch" | "later" | "dismiss", offer: ModelOffer, deps: ModelsDeps): Promise<number> {
  if (choice === "later") {
    await recordModelAnswer(offer.id, "later", deps.settingsPath, deps.now);
    write(`OK — the generation model stays ${offer.current}. You will be asked again in 7 days; 'bastra models switch' works any time.`);
    return 0;
  }
  if (choice === "dismiss") {
    await recordModelAnswer(offer.id, "dismissed", deps.settingsPath, deps.now);
    write(`OK — the generation model stays ${offer.current} and this recommendation will not come up again. 'bastra models' still shows it.`);
    return 0;
  }
  // What `bastra models set <previous>` has to name: the stored choice, not a
  // model an env variable currently pins over it.
  const previous = (await readSettings(deps.settingsPath)).generation?.model ?? GENERATION_MODEL_DEFAULT;
  write(`Switching the generation model to ${offer.model} (about ${offer.sizeGB} GB download if it is not present yet) …`);
  const r = await (deps.enable ?? enableGenerationModel)(offer.model, { dryRun: false, verify: true }, deps.settingsPath);
  if (!r.activated) {
    write(`✗ ${r.message}`);
    write(`Nothing was changed — the generation model stays ${offer.current}.`);
    return 1;
  }
  await recordModelAnswer(offer.id, "switched", deps.settingsPath, deps.now);
  write(`✓ ${r.message}`);
  write(`The previous model ${previous} is still installed. Switch back any time: bastra models set ${previous}`);
  const env = envOverrideNote(offer);
  if (env) write(`Note: ${env}`);
  return 0;
}

/**
 * The question, for whoever has not answered yet. On a terminal it waits for
 * one of three answers; anywhere else it only prints the notice, and no answer
 * (Ctrl-C, EOF) records nothing — silence is never consent to a download.
 */
async function cmdAsk(deps: ModelsDeps): Promise<number> {
  const offer = await pendingModelNotice(deps);
  if (!offer) return 0;
  write("");
  if (!(deps.interactive ?? isInteractive())) {
    write(formatModelNotice(offer));
    return 0;
  }
  for (const line of modelOfferFacts(offer)) write(line);
  const env = envOverrideNote(offer);
  if (env) write(`Note: ${env}`);
  const reply = await (deps.ask ?? ask)(
    "[s] switch now   [l] later (ask again in 7 days)   [n] not for this recommendation — your choice [s/l/n]: ",
  );
  if (reply === null) return 0;
  if (/^s(witch)?$/i.test(reply)) return answer("switch", offer, deps);
  if (/^n(o|ever)?$/i.test(reply)) return answer("dismiss", offer, deps);
  return answer("later", offer, deps);
}
