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
 * as plain subcommands so an agent can run them once the user has decided. Each
 * names the recommendation it answers — the notice prints the full command:
 *
 *   bastra models switch <id> <model>   pull the recommended model, test it, then switch
 *   bastra models later <id>            ask again in 7 days
 *   bastra models dismiss <id>          do not ask again for this recommendation
 *   bastra models ask                   the question itself — what `bastra update` ends with
 */
import { detectHardware, recommendTextModel } from "./hardware.js";
import { resolveGenerationModel, readSettings, GENERATION_MODEL_DEFAULT } from "../settings.js";
import { enableGenerationModel } from "./ollama.js";
import { ask, isInteractive } from "./prompt.js";
import { maybeEmitModelHint } from "./update-hint.js";
import type { ParsedArgs } from "./types.js";
import {
  DISMISS_STILL_OPEN,
  DISMISS_WARNING,
  currentModelOffer,
  decisionCommand,
  envOverrideNote,
  formatModelNotice,
  machineRecommendation,
  modelOfferFacts,
  pendingModelNotice,
  recordModelAnswer,
  type ModelOffer,
  type OfferOptions,
} from "../model-recommendation.js";

function write(line: string): void {
  process.stdout.write(line + "\n");
}

type Choice = "switch" | "later" | "dismiss";

/** Injected by tests only: a recommendation, the machine, the pull and the prompt. */
export interface ModelsDeps extends OfferOptions {
  enable?: typeof enableGenerationModel;
  interactive?: boolean;
  ask?: typeof ask;
  /** The CLI hint's day marker (update-hint.ts). */
  shownPath?: string;
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
    case "dismiss":
      return cmdAnswer(opts.sub as Choice, opts.positional?.[2], opts.positional?.[3], deps);
    case "ask":
      return cmdAsk(deps);
    default:
      process.stderr.write(
        "usage: bastra models [status | recommend | set <tag> | switch <id> <model> | later <id> | dismiss <id>]\n",
      );
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
    // The command for the model named on the `recommended:` line. The heavier
    // alternative gets its own line, labelled as what it is.
    write(`\nto switch: bastra models set ${rec.model}`);
    if (rec.alt && active !== rec.alt.model) write(`alternative: bastra models set ${rec.alt.model}`);
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
 * `bastra models switch | later | dismiss`, typed by the user or run by an
 * agent on the user's say-so.
 *
 * The answer is checked against what THIS release recommends for this machine
 * — not against the model in effect in this shell. The daemon that showed the
 * notice may run with a different environment (a model pinned here is not
 * pinned there) or still be the previous version with a different
 * recommendation. So the command has to name what it answers, and an answer to
 * anything else is refused without changing a thing: a yes to model A must
 * never download model B.
 *
 * Open at any time, whatever was answered before: a "dismiss" must not lock
 * the user out of switching later.
 */
async function cmdAnswer(choice: Choice, id: string | undefined, model: string | undefined, deps: ModelsDeps): Promise<number> {
  const offer = await machineRecommendation(deps);
  const answered = id ? `${id}${model ? ` (${model})` : ""}` : null;
  if (!offer) {
    if (!answered) {
      write("Nothing to decide: there is no model recommendation open for this machine.");
      return 0;
    }
    write(`✗ ${answered} is not a recommendation of this bastra version for this machine.`);
    write("Nothing was changed.");
    return 1;
  }
  if (!id || (choice === "switch" && !model)) {
    process.stderr.write(
      `Say which recommendation you are answering — the full command is:\n  ${decisionCommand(choice, offer)}\nNothing was changed.\n`,
    );
    return 2;
  }
  if (id !== offer.id || (choice === "switch" && model !== offer.model)) {
    write(`✗ ${answered} is not the current recommendation. This bastra version recommends ${offer.model} (${offer.id}, about ${offer.sizeGB} GB download).`);
    write("Nothing was changed. 'bastra models' shows the current recommendation and its commands.");
    return 1;
  }
  return answer(choice, offer, deps);
}

/**
 * Carries out one of the three answers to `offer` — the offer the user was
 * shown, never one recomputed here. A failed switch records nothing — the
 * setting is unchanged, so the question is still open.
 */
async function answer(choice: Choice, offer: ModelOffer, deps: ModelsDeps): Promise<number> {
  if (choice !== "switch") {
    try {
      await recordModelAnswer(offer.id, choice === "later" ? "later" : "dismissed", deps.settingsPath, deps.now);
    } catch (e) {
      write(`✗ ${(e as Error).message}`);
      write("Nothing was changed.");
      return 1;
    }
    if (choice === "later") {
      write(`OK — the generation model stays ${offer.current}. You will be asked again in 7 days; until then 'bastra models' shows the recommendation.`);
    } else {
      write(`OK — the generation model stays ${offer.current}. From now on ${DISMISS_WARNING}.`);
      write(`Still open to you: ${DISMISS_STILL_OPEN}.`);
    }
    return 0;
  }
  // What `bastra models set <previous>` has to name: the stored choice, not a
  // model an env variable currently pins over it.
  const previous = (await readSettings(deps.settingsPath)).generation?.model ?? GENERATION_MODEL_DEFAULT;
  write(`Switching the generation model to ${offer.model} (about ${offer.sizeGB} GB download if it is not present yet) …`);
  // The model and the answer "switched" are stored together, inside enable.
  const r = await (deps.enable ?? enableGenerationModel)(
    offer.model,
    { dryRun: false, verify: true, recommendationId: offer.id },
    deps.settingsPath,
  );
  if (!r.activated) {
    write(`✗ ${r.message}`);
    write(`Nothing was changed — the generation model stays ${offer.current}.`);
    return 1;
  }
  write(`✓ ${r.message}`);
  if (previous !== offer.model) {
    write(`The previous model ${previous} is still installed. Switch back any time: bastra models set ${previous}`);
  }
  const env = envOverrideNote(offer);
  if (env) write(`Note: ${env}`);
  return 0;
}

/**
 * Puts the question to the user on a terminal and carries out the answer.
 * Enter or anything unclear is "later" — never a download. No answer at all
 * (Ctrl-C, EOF) records no answer.
 *
 * What IS recorded, before the question, is that it was asked: the terminal
 * asks about one recommendation once. Without that note, a user who waves the
 * question away would get it again after every command.
 */
async function askQuestion(offer: ModelOffer, deps: ModelsDeps): Promise<number> {
  try {
    await recordModelAnswer(offer.id, "asked", deps.settingsPath, deps.now);
  } catch {
    // The settings file cannot take a note (it is corrupt, and says so on every
    // run). Asking without being able to remember it would ask forever.
    return 0;
  }
  write("");
  for (const line of modelOfferFacts(offer)) write(line);
  const env = envOverrideNote(offer);
  if (env) write(`Note: ${env}`);
  write(`About [n]: ${DISMISS_WARNING}; ${DISMISS_STILL_OPEN}.`);
  const reply = await (deps.ask ?? ask)(
    "[s] switch now   [l] later (ask again in 7 days)   [n] never ask again for this recommendation — your choice [s/l/n]: ",
  );
  if (reply === null) return 0;
  if (/^s(witch)?$/i.test(reply)) return answer("switch", offer, deps);
  if (/^n(o|ever)?$/i.test(reply)) return answer("dismiss", offer, deps);
  return answer("later", offer, deps);
}

/**
 * `bastra models ask` — what `bastra update` ends with, for whoever has not
 * answered yet. On a terminal it asks; anywhere else it only prints the notice
 * and never waits.
 */
async function cmdAsk(deps: ModelsDeps): Promise<number> {
  const offer = await pendingModelNotice(deps);
  if (!offer) return 0;
  if (deps.interactive ?? isInteractive()) return askQuestion(offer, deps);
  write("");
  write(formatModelNotice(offer));
  return 0;
}

/**
 * The catch-up question: the first interactive command after an update asks,
 * once per recommendation.
 *
 * It exists because an update is run by the updater that was installed BEFORE
 * it — and no updater shipped so far runs anything from the new installation
 * on the user's terminal (only `brew upgrade` / `npm install -g` with stdin
 * closed, and a detached daemon). So the release that first carries a
 * recommendation cannot ask at the end of its own update.
 *
 * Only for a recommendation that has no note at all yet: asked before (here or
 * by `bastra update`), or answered anywhere — chat, CLI, a "later" that has
 * come due — means the terminal stays quiet and the dim hint does the
 * reminding. Returns true if the question was put.
 */
export async function maybeAskModelCatchUp(deps: ModelsDeps = {}): Promise<boolean> {
  if (!(deps.interactive ?? isInteractive())) return false;
  const offer = await pendingModelNotice(deps);
  if (!offer) return false;
  if ((await readSettings(deps.settingsPath)).modelRecommendation?.id === offer.id) return false;
  await askQuestion(offer, deps);
  return true;
}

/** Commands that never get a model notice of any kind after them: they carry
 *  it themselves (update, models), or their output is not a place for it. */
const NO_NOTICE_AFTER = new Set(["update", "models", "config", "token", "help", "version", "completion"]);

/**
 * The model notice after a `bastra` command has finished and printed: the
 * catch-up question where a question is possible, else the dim hint.
 *
 * A question needs a real terminal on both ends (maybeAskModelCatchUp checks
 * that, which also rules out pipes, hooks and detached runs) and a command a
 * person is reading: not `--json`, not `--help` / `--version`, not a command
 * whose output is a script, not `uninstall`. It runs after the command, and
 * its outcome is deliberately not returned as an exit code — the command's
 * own result stands.
 */
export async function modelNoticeAfterCommand(
  args: Pick<ParsedArgs, "command" | "json" | "showHelp" | "showVersion">,
  deps: ModelsDeps = {},
): Promise<"asked" | "hinted" | "none"> {
  if (!args.command || NO_NOTICE_AFTER.has(args.command) || args.showHelp || args.showVersion) return "none";
  if (!args.json && args.command !== "uninstall" && (await maybeAskModelCatchUp(deps))) return "asked";
  return (await maybeEmitModelHint(deps)) ? "hinted" : "none";
}
