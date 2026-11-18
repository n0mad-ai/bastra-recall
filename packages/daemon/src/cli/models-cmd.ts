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
  claimModelQuestion,
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
import { usageWordsIn } from "./usage-words.js";
import { taskCliLanguage } from "./task-cli-words.js";
import { modelsCmdWordsIn, type ModelsCmdWords } from "./models-cmd-words.js";

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
  /** language.primary as read at the command's entry, so a language the
   *  command itself saves applies from the next one (#1602). Read from
   *  `settingsPath` when not given. */
  language?: string;
}

export async function cmdModels(opts: {
  sub: string | null;
  positional?: string[];
  settingsPath?: string;
  deps?: ModelsDeps;
}): Promise<number> {
  const deps: ModelsDeps = { ...opts.deps, settingsPath: opts.settingsPath };
  // language.primary, read once for the whole command.
  const language = await taskCliLanguage(opts.settingsPath).catch(() => "en");
  const w = modelsCmdWordsIn(language);
  switch (opts.sub ?? "status") {
    case "status":
      return cmdStatus(deps, w);
    case "recommend":
      return cmdRecommend();
    case "set": {
      // positional = [command, surface, ...args] — the model tag is [2],
      // matching cmdBridges / cmdCommons.
      const model = opts.positional?.[2];
      if (!model) {
        process.stderr.write(usageWordsIn(language).modelsSet);
        return 2;
      }
      return cmdSet(model, w, language, opts.settingsPath);
    }
    case "switch":
    case "later":
    case "dismiss":
      return cmdAnswer(opts.sub as Choice, opts.positional?.[2], opts.positional?.[3], deps, w, language);
    case "ask":
      return cmdAsk(deps, w, language);
    default:
      process.stderr.write(usageWordsIn(language).models);
      return 2;
  }
}

async function cmdStatus(deps: ModelsDeps, w: ModelsCmdWords): Promise<number> {
  const active = await resolveGenerationModel(deps.settingsPath);
  const hw = detectHardware();
  const rec = recommendTextModel(deps.ramGB ?? hw.ramGB, deps.recommendation);
  write(w.generationModel(active, active === GENERATION_MODEL_DEFAULT));
  write(w.machine(`${hw.ramGB}`, hw.chip ?? "", hw.platform));
  write(w.recommended(rec.model, rec.tier));
  if (rec.alt) write(w.optInAlternative(rec.alt.model, rec.alt.note));
  write(rec.note);
  const offer = await currentModelOffer(deps);
  if (offer) {
    write("");
    write(formatModelNotice(offer));
  } else if (rec.model && active !== rec.model && rec.tier !== "keyword-only") {
    // The command for the model named on the `recommended:` line. The heavier
    // alternative gets its own line, labelled as what it is.
    write(w.toSwitch(rec.model));
    if (rec.alt && active !== rec.alt.model) write(w.alternative(rec.alt.model));
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

async function cmdSet(model: string, w: ModelsCmdWords, language: string, settingsPath?: string): Promise<number> {
  write(w.setting(model));
  const r = await enableGenerationModel(model, { dryRun: false, language }, settingsPath);
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
async function cmdAnswer(
  choice: Choice,
  id: string | undefined,
  model: string | undefined,
  deps: ModelsDeps,
  w: ModelsCmdWords,
  language: string
): Promise<number> {
  const offer = await machineRecommendation(deps);
  const answered = id ? `${id}${model ? ` (${model})` : ""}` : null;
  if (!offer) {
    if (!answered) {
      write(w.nothingToDecide);
      return 0;
    }
    write(w.notOfThisVersion(answered));
    write(w.nothingChanged);
    return 1;
  }
  if (!id || (choice === "switch" && !model)) {
    process.stderr.write(w.sayWhich(decisionCommand(choice, offer)));
    return 2;
  }
  if (id !== offer.id || (choice === "switch" && model !== offer.model)) {
    write(w.notCurrent(`${answered}`, offer.model, offer.id, `${offer.sizeGB}`));
    write(w.nothingChangedSee);
    return 1;
  }
  return answer(choice, offer, deps, w, language);
}

/**
 * Carries out one of the three answers to `offer` — the offer the user was
 * shown, never one recomputed here. A failed switch records nothing — the
 * setting is unchanged, so the question is still open.
 */
async function answer(
  choice: Choice,
  offer: ModelOffer,
  deps: ModelsDeps,
  w: ModelsCmdWords,
  language: string
): Promise<number> {
  if (choice !== "switch") {
    try {
      await recordModelAnswer(offer.id, choice === "later" ? "later" : "dismissed", deps.settingsPath, deps.now);
    } catch (e) {
      write(`✗ ${(e as Error).message}`);
      write(w.nothingChanged);
      return 1;
    }
    if (choice === "later") {
      write(w.later(offer.current));
    } else {
      write(w.dismissed(offer.current, DISMISS_WARNING));
      write(w.stillOpen(DISMISS_STILL_OPEN));
    }
    return 0;
  }
  // What `bastra models set <previous>` has to name: the stored choice, not a
  // model an env variable currently pins over it.
  const previous = (await readSettings(deps.settingsPath)).generation?.model ?? GENERATION_MODEL_DEFAULT;
  write(w.switching(offer.model, `${offer.sizeGB}`));
  // The model and the answer "switched" are stored together, inside enable.
  const r = await (deps.enable ?? enableGenerationModel)(
    offer.model,
    { dryRun: false, verify: true, recommendationId: offer.id, language },
    deps.settingsPath
  );
  if (!r.activated) {
    write(`✗ ${r.message}`);
    write(w.switchFailed(offer.current));
    return 1;
  }
  write(`✓ ${r.message}`);
  if (previous !== offer.model) {
    write(w.previousKept(previous));
  }
  const env = envOverrideNote(offer);
  if (env) write(w.note(env));
  return 0;
}

/**
 * Puts the question to the user on a terminal and carries out the answer.
 * Enter or anything unclear is "later" — never a download. No answer at all
 * (Ctrl-C, EOF) records no answer.
 *
 * Callers claim the question first (claimModelQuestion): that it was asked is
 * noted before it is put, so the terminal asks about one recommendation once.
 * Without that note, a user who waves the question away would get it again
 * after every command.
 */
async function askQuestion(offer: ModelOffer, deps: ModelsDeps, w: ModelsCmdWords, language: string): Promise<number> {
  write("");
  for (const line of modelOfferFacts(offer)) write(line);
  const env = envOverrideNote(offer);
  if (env) write(w.note(env));
  write(w.aboutNever(DISMISS_WARNING, DISMISS_STILL_OPEN));
  const reply = await (deps.ask ?? ask)(w.question);
  if (reply === null) return 0;
  if (/^s(witch)?$/i.test(reply)) return answer("switch", offer, deps, w, language);
  if (/^n(o|ever)?$/i.test(reply)) return answer("dismiss", offer, deps, w, language);
  return answer("later", offer, deps, w, language);
}

/**
 * `bastra models ask` — what `bastra update` ends with, for whoever has not
 * answered yet. On a terminal it asks; anywhere else it only prints the notice
 * and never waits.
 */
async function cmdAsk(deps: ModelsDeps, w: ModelsCmdWords, language: string): Promise<number> {
  const offer = await pendingModelNotice(deps);
  if (!offer) return 0;
  if (!(deps.interactive ?? isInteractive())) {
    write("");
    write(formatModelNotice(offer));
    return 0;
  }
  // `bastra update` asks whenever the question is open, also a second time
  // (an unanswered "asked", a "later" that has come due). It only must not ask
  // over a decision that landed while this was starting: if a note for this id
  // already exists, look again before asking.
  let claimed: boolean;
  try {
    claimed = await claimModelQuestion(offer.id, deps.settingsPath, deps.now);
  } catch {
    return 0; // the settings file cannot take a note — asking would ask forever
  }
  if (!claimed && !(await pendingModelNotice(deps))) return 0;
  return askQuestion(offer, deps, w, language);
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
 * reminding. "No note yet" is decided by the claim itself, inside the settings
 * lock, so a decision that lands a moment earlier is never overwritten and two
 * commands finishing together ask once. Returns true if the question was put.
 */
export async function maybeAskModelCatchUp(deps: ModelsDeps = {}): Promise<boolean> {
  if (!(deps.interactive ?? isInteractive())) return false;
  const offer = await pendingModelNotice(deps);
  if (!offer) return false;
  try {
    if (!(await claimModelQuestion(offer.id, deps.settingsPath, deps.now))) return false;
  } catch {
    return false; // the settings file cannot take a note — asking would ask forever
  }
  const language = deps.language ?? (await taskCliLanguage(deps.settingsPath).catch(() => "en"));
  await askQuestion(offer, deps, modelsCmdWordsIn(language), language);
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
  deps: ModelsDeps = {}
): Promise<"asked" | "hinted" | "none"> {
  if (!args.command || NO_NOTICE_AFTER.has(args.command) || args.showHelp || args.showVersion) return "none";
  if (!args.json && args.command !== "uninstall" && (await maybeAskModelCatchUp(deps))) return "asked";
  return (await maybeEmitModelHint(deps)) ? "hinted" : "none";
}
