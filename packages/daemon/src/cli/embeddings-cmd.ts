/**
 * `bastra embeddings <on|off|status>` — the discoverable switch for semantic
 * recall (#79). Recall stays BM25-by-default (the embedding layer is an
 * optional, configurable 2nd pass); this command makes turning it on a single
 * line instead of a hidden env/config dance.
 *
 *   on     persist embedding.provider=ollama, then provision (Homebrew install
 *          if missing, pull embeddinggemma ~620 MB, start login service).
 *          The setting survives a failed download — status/doctor then say
 *          "configured but model missing" instead of a silent none.
 *   off    persist embedding.provider=none (recall = BM25 keyword search only).
 *   status effective provider + WHERE it came from (env / cli-settings /
 *          default) + Ollama server & model presence, plus whether the
 *          effective provider keeps text on-device or sends it to OpenAI.
 *
 * Also home of the install-end prompt (installSemanticRecallStep) and the
 * doctor note (printEmbeddingDoctorNote) so every surface points at the same
 * one-liner. The words live in embeddings-words.ts, by language.primary (#1602).
 */
import {
  getEmbeddingProvider,
  getPrimaryLanguage,
  setEmbeddingProvider,
  resolveEmbeddingChoice,
  resolveGenerationModel,
  settingsFilePath,
  type EmbeddingChoice,
  type EmbeddingProviderName,
} from "../settings.js";
import { enableSemanticRecall, ensureOllama, ollamaModelPulled, probeOllama } from "./ollama.js";
import { probeDaemon } from "./helpers.js";
import { confirm, isInteractive } from "./prompt.js";
import { usageWords } from "./usage-words.js";
import { embeddingsWordsIn, type EmbeddingsWords } from "./embeddings-words.js";

/** The English words: the exported constants below keep their wording. */
const EN = embeddingsWordsIn("en");

/** The one OFF wording every surface shares (doctor, install hint, status).
 *
 *  #103 measured all three arms on a real 811-memory vault, 180 simulated-user
 *  queries: keyword-only found the right note in 61.1% of cases, with the
 *  vector leg on it was 80.0%. The split by user voice is the part worth
 *  carrying into a prompt — someone who names the concept exactly loses almost
 *  nothing (86.7% → 96.7%), someone who describes it in their own words loses
 *  most of their recall (26.7% → 66.7%). Stated as measured, not as a promise:
 *  it is one vault, and the wording says so. */
export const RECALL_OFF_NOTE = EN.recallOff;

// Benefit first, price second. The old wording asked for 620 MB and a Homebrew
// install without once saying what they buy, so the only informed answer was
// "no" (#103, install-prompt review 2026-08-14).
export const INSTALL_PROMPT_QUESTION = EN.installQuestion;

/**
 * #646: Ollama embeddings start the doc2query paraphraser on their own
 * (index.ts, `BASTRA_TRIGGER_EXPAND` default on), on a GENERATION model with a
 * different cost than the embedding model the user just agreed to. Turning on
 * one feature must not turn on another without saying so — so `embeddings on`
 * names it, its model, its cost and its off switch, and a model that is not
 * pulled before the first 404. `pulled` null = Ollama did not answer: unknown,
 * so no pull hint (same rule as doctor's row).
 */
export function paraphrasingNotice(model: string, pulled: boolean | null, w: EmbeddingsWords = EN): string[] {
  const lines = w.paraphrasing(model);
  if (pulled === false) lines.push(w.paraphraseModelMissing(model));
  return lines;
}

function write(line: string): void {
  process.stdout.write(line + "\n");
}

export async function cmdEmbeddings(opts: {
  sub: string | null;
  settingsPath?: string;
  /** Injectable for tests — the real probe hits the configured endpoint (#531). */
  probe?: typeof probeDaemon;
}): Promise<number> {
  const language = await getPrimaryLanguage(opts.settingsPath).catch(() => undefined);
  const w = embeddingsWordsIn(language);
  switch (opts.sub) {
    case "on":
      return cmdOn(w, language, opts.settingsPath);
    case "off":
      return cmdOff(w, opts.settingsPath);
    case "status":
      return cmdStatus(w, language, opts.settingsPath, opts.probe ?? probeDaemon);
    default:
      process.stderr.write((await usageWords()).embeddings);
      process.stderr.write(w.usageLines);
      return 2;
  }
}

async function cmdOn(w: EmbeddingsWords, language: string | undefined, settingsPath?: string): Promise<number> {
  const r = await enableSemanticRecall({ dryRun: false, language }, settingsPath);
  write(`✓ embedding.provider = ollama`);
  write(w.storedIn(settingsPath ?? settingsFilePath()));
  write(w.semanticResult(r.message));
  if (r.status === "already-active") {
    write(w.restartAlreadyActive);
  }
  // Only when Ollama embeddings are what the daemon will actually run: an env
  // override to another provider means the paraphraser cannot start.
  if ((await resolveEmbeddingChoice({ path: settingsPath })).provider === "ollama") {
    const model = await resolveGenerationModel(settingsPath);
    for (const line of paraphrasingNotice(model, await ollamaModelPulled(model), w)) write(line);
  }
  if (r.status === "error" || r.status === "unsupported") {
    write(w.onPending);
    return 1;
  }
  return 0;
}

async function cmdOff(w: EmbeddingsWords, settingsPath?: string): Promise<number> {
  await setEmbeddingProvider("none", settingsPath);
  write(`✓ embedding.provider = none`);
  write(w.storedIn(settingsPath ?? settingsFilePath()));
  write(w.offDone);
  const env = process.env.BASTRA_EMBEDDING_PROVIDER;
  if (env && env.toLowerCase() !== "none") {
    write(w.envOverridesOff(env));
  }
  write(w.restartOff);
  return 0;
}

async function cmdStatus(
  w: EmbeddingsWords,
  language: string | undefined,
  settingsPath?: string,
  probe: typeof probeDaemon = probeDaemon
): Promise<number> {
  const choice = await resolveEmbeddingChoice({ path: settingsPath });
  const fileProvider = await getEmbeddingProvider(settingsPath);
  const envRaw = process.env.BASTRA_EMBEDDING_PROVIDER;

  write(w.effectiveProvider(choice.provider));
  write(w.resolvedVia(sourceLabel(w, choice, fileProvider, envRaw, settingsPath)));

  // The RUNNING daemon can differ from this shell's view: a LaunchAgent/plist
  // env sets the provider without the CLI ever seeing it (host-test find,
  // 2026-07-03). Show both so 'none here, on there' stops reading as OFF.
  let daemonOn = false;
  try {
    const p = await probe();
    if (p.ok && p.semanticRecall) {
      daemonOn = p.semanticRecall === "on";
      // #531 — name the instance this came from; "the running daemon" used to
      // mean "whatever answered 6723", which need not be the configured one.
      write(
        w.runningDaemon(p.endpoint?.label ?? w.configuredEndpoint, p.semanticRecall) +
          (p.embeddingMode ? w.runningMode(p.embeddingMode, p.embeddingSource ?? "?") : "")
      );
      if (choice.provider === "none" && daemonOn) {
        write(w.daemonOwnEnv);
      }
    }
  } catch {
    /* no running daemon = nothing to add */
  }

  if (choice.source === "api-key") {
    write(`  ⚠ ${w.cloudConsent}`);
  } else if (choice.requested === "openai" && choice.provider === "none") {
    write(w.openaiNoKey);
  }
  if (choice.provider === "openai") {
    write(w.egress(w.cloudEgress));
  } else if (choice.provider === "ollama") {
    write(w.egressLocal);
  }
  if (choice.source === "env" && fileProvider && envRaw && envRaw.toLowerCase() !== fileProvider) {
    write(w.envOverridesFile(envRaw, fileProvider));
  }

  if (choice.provider === "ollama") {
    const o = await probeOllama(language);
    if (!o.ok) {
      write(w.ollamaDown(o.detail));
    } else {
      write(`  ollama: ${o.detail}`);
      write(w.modelLine(o.hasModel));
    }
  } else if (choice.provider === "none" && !daemonOn) {
    // Suppressed when the running daemon is semantic — an OFF hint right
    // after "running daemon: on" would contradict itself.
    write(`  ${w.recallOff}`);
  }
  return 0;
}

function sourceLabel(
  w: EmbeddingsWords,
  choice: EmbeddingChoice,
  fileProvider: EmbeddingProviderName | undefined,
  envRaw: string | undefined,
  settingsPath?: string
): string {
  switch (choice.source) {
    case "env":
      return w.sourceEnv(`${envRaw}`);
    case "cli-settings":
      return `embedding.provider=${fileProvider} (${settingsPath ?? settingsFilePath()})`;
    case "api-key":
      return w.sourceApiKey;
    case "none":
      return w.sourceNone;
  }
}

// ─── install-end prompt (#79) ────────────────────────────────────────────────

export type InstallRecallAction = "skip" | "provision" | "silent" | "prompt" | "hint";

/**
 * Pure decision for the end-of-install semantic-recall step — exported so the
 * TTY/--yes guards are unit-testable without a terminal:
 *   --ollama               → provision without asking (explicit flag = consent)
 *   provider already effective (env or setting) → silent — also under
 *                            --no-ollama (the flag skips provisioning, it
 *                            never disables anything, so there is nothing to
 *                            report; keeps `bastra update`'s hard-skip quiet)
 *   --no-ollama            → skip (one skip line)
 *   dry-run / --yes / non-TTY → hint line, NEVER a prompt (never hangs)
 *   otherwise              → ask once ([Y/n])
 */
export function decideInstallRecallAction(i: {
  ollamaFlag: "auto" | "skip" | null;
  effectiveProvider: EmbeddingProviderName;
  interactive: boolean;
  yes: boolean;
  dryRun: boolean;
  /** The RUNNING daemon reports semantic recall active (e.g. its LaunchAgent
   *  env sets the provider). The CLI shell can't see that env — without this
   *  signal the prompt would ask although recall is already semantic. */
  daemonSemanticOn?: boolean;
}): InstallRecallAction {
  if (i.ollamaFlag === "auto") return "provision";
  if (i.effectiveProvider !== "none" || i.daemonSemanticOn === true) return "silent";
  if (i.ollamaFlag === "skip") return "skip";
  if (i.dryRun || i.yes || !i.interactive) return "hint";
  return "prompt";
}

/** Runs at the END of a successful `bastra install` (never on a failed one). */
export async function installSemanticRecallStep(args: {
  dryRun: boolean;
  yes: boolean;
  ollama: "auto" | "skip" | null;
  /** language.primary, read once by the install command; English when absent. */
  language?: string;
}): Promise<void> {
  const w = embeddingsWordsIn(args.language);
  const choice = await resolveEmbeddingChoice();
  // Best-effort probe of the RUNNING daemon: a LaunchAgent/plist env can turn
  // semantic recall on without the CLI shell ever seeing it (host-test find,
  // 2026-07-03) — never prompt when recall is already semantic.
  let daemonSemanticOn = false;
  if (choice.provider === "none") {
    try {
      const probe = await probeDaemon();
      daemonSemanticOn = probe.ok && probe.semanticRecall === "on";
    } catch {
      /* unreachable daemon = no signal */
    }
  }
  const action = decideInstallRecallAction({
    ollamaFlag: args.ollama,
    effectiveProvider: choice.provider,
    interactive: isInteractive(),
    yes: args.yes,
    dryRun: args.dryRun,
    daemonSemanticOn,
  });

  if (action === "silent") return;
  if (action === "skip") {
    const r = await ensureOllama({ dryRun: args.dryRun, mode: "skip", language: args.language });
    write(w.semanticResult(r.message));
    return;
  }
  if (action === "hint") {
    write(w.installOffHint);
    return;
  }
  if (action === "prompt") {
    const accepted = await confirm(w.installQuestion, { defaultYes: true });
    if (!accepted) {
      write(w.installOffHint);
      return;
    }
  }
  // "provision", or the prompt was accepted — same path as `bastra embeddings on`.
  const r = await enableSemanticRecall({ dryRun: args.dryRun, language: args.language });
  write(w.semanticResult(r.message));
  if (r.persisted && (await resolveEmbeddingChoice()).provider === "ollama") {
    const model = await resolveGenerationModel();
    for (const line of paraphrasingNotice(model, await ollamaModelPulled(model), w)) write(line);
  }
  if (r.persisted && (r.status === "error" || r.status === "unsupported")) {
    write(w.installSaved);
  }
}

// ─── doctor note (#79) ───────────────────────────────────────────────────────

export interface OllamaProbeResult {
  ok: boolean;
  detail: string;
  hasModel: boolean;
}

/**
 * Pure formatter for the doctor's semantic-recall block (exported for tests).
 * A NOTE, never a failure — BM25-only is degraded, not broken, so doctor's
 * exit code is untouched.
 */
export function formatEmbeddingDoctorLines(i: {
  platform?: NodeJS.Platform;
  choice: EmbeddingChoice;
  fileProvider: EmbeddingProviderName | undefined;
  envValue: string | undefined;
  /** probeOllama() result when the effective provider is ollama, else null. */
  probe: OllamaProbeResult | null;
  /** Live daemon state can differ from the invoking shell when a LaunchAgent
   * supplies its own embedding environment (#15/#79). */
  daemon?: {
    semanticRecall?: string;
    embeddingMode?: string;
    embeddingSource?: string;
  } | null;
  /** The words to print in; English when not given. */
  words?: EmbeddingsWords;
}): string[] {
  const w = i.words ?? EN;
  const lines: string[] = [w.doctorHeader];
  const { choice } = i;

  if (choice.provider === "none") {
    if (i.daemon?.semanticRecall === "on") {
      lines.push(w.doctorDaemonOn(i.daemon.embeddingMode, i.daemon.embeddingSource));
    } else {
      lines.push(w.note(w.recallOff));
    }
    if (choice.source === "api-key") {
      lines.push(w.note(w.cloudConsent));
    } else if (choice.requested === "openai") {
      lines.push(w.doctorOpenaiNoKey(choice.source));
    }
  } else if (choice.provider === "ollama") {
    if (i.probe && !i.probe.ok) {
      lines.push(w.doctorOllamaDown(choice.source, i.probe.detail));
    } else if (i.probe && !i.probe.hasModel) {
      lines.push(w.doctorModelMissing(choice.source));
    } else {
      lines.push(w.doctorOllamaOk(i.probe?.detail, choice.source));
    }
  } else {
    lines.push(w.doctorOpenaiOk(choice.source, w.cloudEgress));
  }

  if ((i.platform ?? process.platform) === "win32") {
    lines.push(w.doctorWindows);
  }

  if (i.envValue && i.fileProvider && i.envValue.toLowerCase() !== i.fileProvider) {
    lines.push(w.envOverridesFile(i.envValue, i.fileProvider));
  }
  return lines;
}

/** Doctor's semantic-recall block in `language` (English when absent): gathers state, prints, never throws. */
export async function printEmbeddingDoctorNote(language?: string): Promise<void> {
  try {
    const choice = await resolveEmbeddingChoice();
    const fileProvider = await getEmbeddingProvider();
    const probe = choice.provider === "ollama" ? await probeOllama(language) : null;
    let daemon: {
      semanticRecall?: string;
      embeddingMode?: string;
      embeddingSource?: string;
    } | null = null;
    if (choice.provider === "none") {
      try {
        const live = await probeDaemon();
        if (live.ok) {
          daemon = {
            semanticRecall: live.semanticRecall,
            embeddingMode: live.embeddingMode,
            embeddingSource: live.embeddingSource,
          };
        }
      } catch {
        /* unreachable daemon = no stronger signal than the shell view */
      }
    }
    const lines = formatEmbeddingDoctorLines({
      choice,
      fileProvider,
      envValue: process.env.BASTRA_EMBEDDING_PROVIDER,
      probe,
      daemon,
      words: embeddingsWordsIn(language),
    });
    for (const line of lines) write(line);
    write("");
  } catch {
    /* a diagnostics NOTE must never break doctor */
  }
}
