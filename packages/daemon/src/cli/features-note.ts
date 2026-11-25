import { tasksEnabled } from "../tasks-enabled.js";
import { taskAgentAccessStatus } from "../task-auto-setup.js";
/**
 * The doctor's "features" block: which Recall features are switched on for
 * this user, which are off, and the command that turns each one on.
 *
 * Why it exists: every other doctor check asks whether a registration is
 * BROKEN. A user who installed before onboarding existed, or who switched a
 * piece off once, has a healthy installation with half the features dark — no
 * primary language (memories come out in English), no Stop hook, no semantic
 * recall — and doctor said "ok" to all of it. This block says it out loud.
 *
 * A NOTE like the other global blocks: it never flips doctor's exit code, and
 * `--fix` never turns a feature on. Switching a feature on is the user's
 * decision; the block only names the command.
 *
 * Two groups, because they mean different things:
 *   - core features, on by default or set up by install/onboarding — "off"
 *     here is worth acting on;
 *   - optional features, off by default ON PURPOSE (opt-in or experimental) —
 *     listed so they can be found, marked as intentional, never as a warning.
 */
import { readSettings, resolveEmbeddingChoice, resolveGenerationModel, type CliSettings } from "../settings.js";
import { SETTINGS_REGISTRY } from "../settings-registry.js";
import { ollamaModelPulled } from "./ollama.js";
import { FRESH_VAULT_MAX, isOnboardingDone } from "../onboarding.js";
import { codeAwarenessDisabledByEnv, enabledRepos } from "../code-graph/enabled-repos.js";
import { getPromptImpactEnabled } from "../code-graph/prompt-impact-settings.js";
import { getCoverageMapEnabled } from "../code-graph/coverage-map-settings.js";
import { probeDaemon, resolveVault, type DaemonProbe } from "./helpers.js";
import type { ClientFeatures } from "./types.js";
import { archiveMode, type ArchiveMode } from "../bash-pre-patterns.js";
import { batterySaverEnabled } from "../power-source.js";
import { archiveCap, archiveMaxItem, archiveRootProblem, formatSize } from "../rm-archive.js";
import { isOffValue, isOnValue } from "../env.js";
import { CODEX_GATE_VERIFIED_VERSIONS } from "../codex-gate-capability.js";
import { featuresWordsIn, type FeaturesWords } from "./features-words.js";

export interface FeatureState {
  /** Clients whose MCP server is registered, with their hook/skill state. */
  proactive?: { clientConfigured: boolean; accessHint?: string };
  clients: Array<{ surface: string; features: ClientFeatures }>;
  primaryLanguage: string | undefined;
  /** null = no vault configured, so the question does not apply. */
  onboardingDone: boolean | null;
  /** Memories in the vault per the running daemon; undefined when it is not running. */
  vaultSize?: number;
  semanticRecall: { state: "on" | "off" | "degraded"; detail: string };
  /**
   * The doc2query paraphraser. Nobody switches it on by name: Ollama
   * embeddings start it, and it keeps a local generation model busy over the
   * whole vault. "n/a" = no Ollama embeddings, so it cannot run.
   */
  paraphrasing: { state: "on" | "off" | "n/a"; model?: string; modelPulled?: boolean };
  /** Reflex memories; `offBy` names the switch when off. */
  reflex: { enabled: boolean; offBy?: string };
  /** Credential redaction in user content (`redaction.enabled`, default on). */
  redaction: boolean;
  codeAwareness: { repos: number; offByEnv: boolean };
  promptImpact: boolean;
  coverageMap: boolean;
  docsMode: string;
  commons: boolean;
  bridges: boolean;
  ui: boolean;
  /** #650: bastra's archiving rm + git snapshots (bash-pre-patterns.ts archiveMode). */
  archive: ArchiveMode;
  /** #934: the archive's effective total cap and per-target limit, in bytes (null = no limit). */
  archiveLimits: { cap: number; maxItem: number | null };
  /** Why the archive directory is refused (another account's), when the archive is on. */
  archiveProblem?: string | null;
  /** #1474: Recall Pulse document writing (BASTRA_DOCUMENT_WRITE), as this shell sees it. */
  documentWrite: boolean;
  /** #632: battery mode. `live` = what the running daemon reports, absent when
   *  it is not running or predates the field. */
  battery: { saver: boolean; live?: { source: string; saving: boolean } };
}

const ON = "✓";
const OFF = "○";
const INFO = "·";

function row(symbol: string, name: string, state: string, hint?: string): string {
  return `  ${symbol} ${name}: ${state}${hint ? ` → ${hint}` : ""}`;
}

/** Pure formatter (exported for tests); English unless language.primary says otherwise (#1602). */
export function featureLines(s: FeatureState, language?: string): string[] {
  const w = featuresWordsIn(language);
  const lines = [w.header];

  for (const { surface, features: f } of s.clients) lines.push(...clientLines(surface, f, w));

  lines.push(
    s.primaryLanguage
      ? row(ON, w.memoryLanguage, s.primaryLanguage)
      : row(OFF, w.memoryLanguage, w.languageUnset, w.languageHint)
  );

  if (s.onboardingDone === true) {
    lines.push(row(ON, w.onboarding, w.done));
  } else if (s.onboardingDone === false) {
    // The session hook only nudges a fresh vault; an established one without
    // the interview is worth knowing about, not a problem.
    const fresh = s.vaultSize !== undefined && s.vaultSize < FRESH_VAULT_MAX;
    lines.push(
      fresh
        ? row(OFF, w.onboarding, w.neverDone, "bastra onboard")
        : row(INFO, w.onboarding, w.neverDoneOptional, "bastra onboard")
    );
  }

  lines.push(
    s.semanticRecall.state === "on"
      ? row(ON, w.semanticRecall, w.semanticOn(s.semanticRecall.detail))
      : row(
          OFF,
          w.semanticRecall,
          w.semanticNotOn(s.semanticRecall.state, s.semanticRecall.detail),
          "bastra embeddings on"
        )
  );

  const para = w.paraphrasing;
  if (s.paraphrasing.state === "on" && s.paraphrasing.modelPulled === false) {
    lines.push(row(OFF, para, w.paraphraseNotPulled(s.paraphrasing.model), w.paraphrasePullHint(s.paraphrasing.model)));
  } else if (s.paraphrasing.state === "on") {
    lines.push(row(ON, para, w.paraphraseOn(s.paraphrasing.model)));
  } else if (s.paraphrasing.state === "off") {
    lines.push(row(INFO, para, w.off));
  }

  if (s.reflex.enabled) lines.push(row(ON, w.reflex, w.on));
  else
    lines.push(
      row(
        OFF,
        w.reflex,
        w.offBecause(String(s.reflex.offBy)),
        s.reflex.offBy?.startsWith("BASTRA_REFLEX") ? w.unsetReflex : "bastra config set reflex.enabled true"
      )
    );

  lines.push(redactionLine(s.redaction, w));

  lines.push(w.optionalHeading, ...optionalLines(s, w));
  return lines;
}

/** One client's rows; out of featureLines to keep that one's complexity. */
function clientLines(surface: string, f: ClientFeatures, w: FeaturesWords): string[] {
  const lines: string[] = [];
  const install = `bastra install ${surface}`;
  if (f.hooksDisabledBy) {
    lines.push(row(OFF, w.recallHooks(surface), w.offBecause(f.hooksDisabledBy), w.removeSetting));
  } else {
    lines.push(
      f.recallHooks ? row(ON, w.recallHooks(surface), w.on) : row(OFF, w.recallHooks(surface), w.off, install)
    );
  }
  lines.push(f.stopHook ? row(ON, w.autoSave(surface), w.on) : row(OFF, w.autoSave(surface), w.off, install));
  lines.push(f.skill ? row(ON, w.skill(surface), w.on) : row(OFF, w.skill(surface), w.off, install));
  if (f.toolSurface === "search") {
    lines.push(row(OFF, w.savingFromAgent(surface), w.searchSurfaceOff, w.searchSurfaceHint(f.mcpConfig)));
  }
  lines.push(...rulebookGateLines(surface, f.rulebookGate, w));
  if (f.sessionContextOff) {
    lines.push(
      row(
        OFF,
        w.sessionContext(surface),
        w.offBecause("BASTRA_MCP_SESSION_CONTEXT=0"),
        w.sessionContextHint(f.mcpConfig)
      )
    );
  }
  return lines;
}

/** The rows under "optional, off by default on purpose". */
function optionalLines(s: FeatureState, w: FeaturesWords): string[] {
  const lines: string[] = [];
  if (s.proactive)
    lines.push(
      row(
        s.proactive.clientConfigured ? ON : INFO,
        w.proactive,
        s.proactive.clientConfigured ? w.proactiveOn : (s.proactive.accessHint ?? w.proactiveOff),
        "bastra tasks setup-hooks"
      )
    );
  if (s.codeAwareness.offByEnv) {
    lines.push(row(INFO, w.codeAwareness, w.offBecause("BASTRA_CODE_AWARENESS=off"), w.unsetCodeAwareness));
  } else {
    lines.push(
      s.codeAwareness.repos > 0
        ? row(ON, w.codeAwareness, w.codeAwarenessOn(s.codeAwareness.repos))
        : row(INFO, w.codeAwareness, w.off, w.codeEnableHint)
    );
  }
  lines.push(
    s.promptImpact
      ? row(ON, w.promptImpact, w.on)
      : row(INFO, w.promptImpact, w.promptImpactOff, "bastra config set promptImpact.enabled true")
  );
  lines.push(
    s.coverageMap
      ? row(ON, w.coverageMap, w.coverageMapOn)
      : row(INFO, w.coverageMap, w.off, "bastra config set coverageMap.enabled true")
  );
  lines.push(
    s.docsMode !== "off"
      ? row(ON, w.productDocs, s.docsMode)
      : row(INFO, w.productDocs, w.off, "bastra config set docs.mode suggest")
  );
  lines.push(s.commons ? row(ON, "Bastra Commons", w.on) : row(INFO, "Bastra Commons", w.off, "bastra commons enable"));
  lines.push(s.bridges ? row(ON, w.bridges, w.on) : row(INFO, w.bridges, w.off, "bastra bridges enable"));
  lines.push(s.ui ? row(ON, w.vaultMap, w.on) : row(INFO, w.vaultMap, w.off, "bastra config set ui.enabled true"));
  lines.push(archiveLine(s, w));
  lines.push(documentWriteLine(s.documentWrite, w));
  lines.push(batteryLine(s.battery, w));
  return lines;
}

/** Owner decision 25.11.2026: the off state of credential redaction is named, with the command back. */
function redactionLine(on: boolean, w: FeaturesWords): string {
  return on
    ? row(ON, w.redaction, w.on)
    : row(OFF, w.redaction, w.redactionOff, "bastra config set redaction.enabled true");
}

function batteryLine(battery: FeatureState["battery"], w: FeaturesWords): string {
  if (!battery.saver) return row(INFO, w.battery, w.off, "bastra config set battery.saver on");
  if (battery.live?.saving) return row(ON, w.battery, w.batterySaving);
  return row(ON, w.battery, battery.live ? w.batteryLive(battery.live.source) : w.on);
}

/**
 * #1474: the rulebook gate is verified per exact Codex version. Every other
 * version, newer ones included, gets hints only; an update switches the
 * blocking check off without a word, so the row says which case applies.
 */
function rulebookGateLines(surface: string, gate: ClientFeatures["rulebookGate"], w: FeaturesWords): string[] {
  if (!gate) return [];
  const name = w.rulebookGate(surface);
  if (gate.verified) return [row(ON, name, w.gateBlocking(gate.version))];
  return [row(OFF, name, w.gateAdvisory(gate.version, CODEX_GATE_VERIFIED_VERSIONS.join(", ")), w.gateHint)];
}

/** #1474: Recall Pulse document writing, as this shell's environment sets it. */
function documentWriteLine(on: boolean, w: FeaturesWords): string {
  return on ? row(ON, w.documentWrite, w.documentWriteOn) : row(INFO, w.documentWrite, w.off, w.documentWriteHint);
}

/** Same switch and legacy alias as documentWriteEnabledFromEnv, but from the
 *  injected env, so a test never sees the developer's shell. */
function documentWriteFrom(env: NodeJS.ProcessEnv): boolean {
  return isOnValue(env.BASTRA_DOCUMENT_WRITE || env.NEXUS_DOCUMENT_WRITE);
}

/** The archive's row; out of featureLines to keep that one's complexity. */
function archiveLine(s: FeatureState, w: FeaturesWords): string {
  if (s.archive === "bastra" && s.archiveProblem) return row(OFF, w.archive, w.archiveUnusable(s.archiveProblem));
  return s.archive === "bastra"
    ? row(
        ON,
        w.archive,
        w.archiveOn(
          formatSize(s.archiveLimits.cap),
          s.archiveLimits.maxItem === null ? null : formatSize(s.archiveLimits.maxItem)
        )
      )
    : s.archive === "host"
      ? row(ON, w.archive, w.archiveHost)
      : row(INFO, w.archive, w.off, "bastra config set archive.enabled on  (docs/hooks.md)");
}

/** The archive mode, and why its directory is refused when it is on (doctor). */
function archiveFeature(
  enabled: boolean | undefined,
  env: NodeJS.ProcessEnv
): Pick<FeatureState, "archive" | "archiveProblem"> {
  const archive = archiveMode(enabled ?? false);
  return { archive, archiveProblem: archive === "bastra" ? archiveRootProblem(env) : null };
}

/** Only a stored `false` turns redaction off (user-text-redaction.ts reads it the same way). */
function redactionOn(settings: CliSettings): boolean {
  return settings.redaction?.enabled !== false;
}

function reflexState(settings: CliSettings, env: NodeJS.ProcessEnv): FeatureState["reflex"] {
  // Same precedence as reflexConfig() in the daemon: env wins over the file.
  const raw = env.BASTRA_REFLEX;
  if (raw !== undefined && raw !== "") {
    return isOffValue(raw) ? { enabled: false, offBy: `BASTRA_REFLEX=${raw}` } : { enabled: true };
  }
  return settings.reflex?.enabled === false ? { enabled: false, offBy: "reflex.enabled = false" } : { enabled: true };
}

async function semanticState(live: DaemonProbe | null, w: FeaturesWords): Promise<FeatureState["semanticRecall"]> {
  // The running daemon is the stronger witness: a LaunchAgent can carry its
  // own embedding environment that this shell does not see (#79).
  if (live?.ok && live.semanticRecall) {
    return { state: live.semanticRecall, detail: live.embeddingMode ?? w.runningDaemon };
  }
  const choice = await resolveEmbeddingChoice();
  return choice.provider === "none"
    ? { state: "off", detail: w.keywordOnly }
    : { state: "on", detail: w.providerFrom(choice.provider, choice.source) };
}

export async function paraphrasingState(
  live: DaemonProbe | null,
  semantic: FeatureState["semanticRecall"],
  env: NodeJS.ProcessEnv
): Promise<FeatureState["paraphrasing"]> {
  if (semantic.state === "off") return { state: "n/a" };
  // doc2query only runs on Ollama embeddings. The running daemon names its
  // provider ("ollama-<model>"); a cloud provider means no row, not "off".
  const ollamaEmbeddings =
    live?.ok && live.embeddingMode
      ? live.embeddingMode.startsWith("ollama-")
      : (await resolveEmbeddingChoice()).provider === "ollama";
  if (!ollamaEmbeddings) return { state: "n/a" };
  // Unreachable Ollama proves nothing about the model: no pull hint then.
  const pulled = async (model: string) => (await ollamaModelPulled(model)) ?? undefined;
  // The running daemon is the witness here too: the switch and the model are
  // usually set in its service environment, which this shell does not see.
  if (live?.ok && live.triggerExpandModel !== undefined) {
    const model = live.triggerExpandModel;
    return model === null ? { state: "off" } : { state: "on", model, modelPulled: await pulled(model) };
  }
  const raw = env.BASTRA_TRIGGER_EXPAND;
  if (isOffValue(raw)) return { state: "off" };
  const model = await resolveGenerationModel();
  return { state: "on", model, modelPulled: await pulled(model) };
}

/** Gathers the state from settings, the vault and the running daemon. */
export async function collectFeatureState(
  clients: FeatureState["clients"],
  cliVault: string | null,
  env: NodeJS.ProcessEnv = process.env,
  language?: string
): Promise<FeatureState> {
  const settings = await readSettings();
  const vault = await resolveVault({ dryRun: true, vaultPath: cliVault });
  const live = await probeDaemon().catch(() => null);
  const semanticRecall = await semanticState(live, featuresWordsIn(language));
  return {
    proactive: tasksEnabled(env)
      ? await taskAgentAccessStatus().then((s) => ({ clientConfigured: s.authorized, accessHint: s.hint }))
      : undefined,
    clients,
    primaryLanguage: settings.language?.primary,
    onboardingDone: "error" in vault ? null : await isOnboardingDone(vault.path),
    vaultSize: live?.ok ? live.vaultSize : undefined,
    semanticRecall,
    paraphrasing: await paraphrasingState(live, semanticRecall, env),
    reflex: reflexState(settings, env),
    redaction: redactionOn(settings),
    codeAwareness: { repos: (await enabledRepos(undefined, env)).length, offByEnv: codeAwarenessDisabledByEnv(env) },
    promptImpact: await getPromptImpactEnabled(undefined, env),
    coverageMap: await getCoverageMapEnabled(undefined, env),
    docsMode: settings.docs?.mode ?? "off",
    commons: settings.commons?.enabled ?? false,
    bridges: settings.sharedRecall?.enabled ?? false,
    ui: settings.ui?.enabled ?? SETTINGS_REGISTRY.ui.enabled.default,
    // This shell's env; the daemon reads its own (a LaunchAgent may differ).
    ...archiveFeature(settings.archive?.enabled, env),
    documentWrite: documentWriteFrom(env),
    archiveLimits: {
      cap: archiveCap(env, settings.archive?.cap),
      maxItem: archiveMaxItem(env, settings.archive?.maxItem),
    },
    // The running daemon is the witness when it reports the field; else this
    // shell's env over the file.
    battery:
      live?.ok && live.power
        ? { saver: live.power.batterySaver, live: { source: live.power.source, saving: live.power.saving } }
        : { saver: batterySaverEnabled(settings.battery?.saver, env) },
  };
}

/** Doctor's printer: never throws, never changes the exit code. */
export async function printFeaturesNote(
  clients: FeatureState["clients"],
  cliVault: string | null,
  language = "en"
): Promise<void> {
  try {
    const lines = featureLines(await collectFeatureState(clients, cliVault, process.env, language), language);
    process.stdout.write(`${lines.join("\n")}\n\n`);
  } catch {
    /* a diagnostics NOTE must never break doctor */
  }
}
