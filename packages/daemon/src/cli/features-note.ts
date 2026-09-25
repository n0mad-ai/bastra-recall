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
import { readSettings, resolveEmbeddingChoice, resolveGenerationModel, settingsFilePath, type CliSettings } from "../settings.js";
import { ollamaModelPulled } from "./ollama.js";
import { FRESH_VAULT_MAX, isOnboardingDone } from "../onboarding.js";
import { codeAwarenessDisabledByEnv, enabledRepos } from "../code-graph/enabled-repos.js";
import { getPromptImpactEnabled } from "../code-graph/prompt-impact-settings.js";
import { probeDaemon, resolveVault, type DaemonProbe } from "./helpers.js";
import type { ClientFeatures } from "./types.js";

export interface FeatureState {
  /** Clients whose MCP server is registered, with their hook/skill state. */
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
  codeAwareness: { repos: number; offByEnv: boolean };
  promptImpact: boolean;
  docsMode: string;
  commons: boolean;
  bridges: boolean;
  ui: boolean;
}

const ON = "✓";
const OFF = "○";
const INFO = "·";

function row(symbol: string, name: string, state: string, hint?: string): string {
  return `  ${symbol} ${name}: ${state}${hint ? ` → ${hint}` : ""}`;
}

/** Pure formatter (exported for tests). */
export function featureLines(s: FeatureState): string[] {
  const lines = ["→ features"];

  for (const { surface, features: f } of s.clients) {
    if (f.hooksDisabledBy) {
      lines.push(row(OFF, `${surface}: recall hooks`, `off (${f.hooksDisabledBy})`, "remove that setting"));
    } else {
      lines.push(f.recallHooks
        ? row(ON, `${surface}: recall hooks`, "on")
        : row(OFF, `${surface}: recall hooks`, "off", `bastra install ${surface}`));
    }
    lines.push(f.stopHook
      ? row(ON, `${surface}: auto-save suggestions (Stop hook)`, "on")
      : row(OFF, `${surface}: auto-save suggestions (Stop hook)`, "off", `bastra install ${surface}`));
    lines.push(f.skill
      ? row(ON, `${surface}: skill`, "on")
      : row(OFF, `${surface}: skill`, "off", `bastra install ${surface}`));
  }

  lines.push(s.primaryLanguage
    ? row(ON, "memory language", s.primaryLanguage)
    : row(OFF, "memory language", "not set, memories are written in English", "bastra config set language.primary <code>  (e.g. de)"));

  if (s.onboardingDone === true) {
    lines.push(row(ON, "onboarding", "done"));
  } else if (s.onboardingDone === false) {
    // The session hook only nudges a fresh vault; an established one without
    // the interview is worth knowing about, not a problem.
    const fresh = s.vaultSize !== undefined && s.vaultSize < FRESH_VAULT_MAX;
    lines.push(fresh
      ? row(OFF, "onboarding", "never done", "bastra onboard")
      : row(INFO, "onboarding", "never done (optional for a vault that already has memories)", "bastra onboard"));
  }

  lines.push(s.semanticRecall.state === "on"
    ? row(ON, "semantic recall", `on (${s.semanticRecall.detail})`)
    : row(OFF, "semantic recall", `${s.semanticRecall.state} (${s.semanticRecall.detail})`, "bastra embeddings on"));

  const para = "background paraphrasing (doc2query)";
  if (s.paraphrasing.state === "on" && s.paraphrasing.modelPulled === false) {
    lines.push(row(OFF, para, `on, but ${s.paraphrasing.model} is not pulled, so every paraphrase fails`,
      `ollama pull ${s.paraphrasing.model}  (or BASTRA_TRIGGER_EXPAND=0 in the daemon's environment)`));
  } else if (s.paraphrasing.state === "on") {
    lines.push(row(ON, para,
      `on (${s.paraphrasing.model} keeps rewriting memory triggers in the background; BASTRA_TRIGGER_EXPAND=0 stops it)`));
  } else if (s.paraphrasing.state === "off") {
    lines.push(row(INFO, para, "off"));
  }

  if (s.reflex.enabled) lines.push(row(ON, "reflex memories", "on"));
  else lines.push(row(OFF, "reflex memories", `off (${s.reflex.offBy})`, s.reflex.offBy?.startsWith("BASTRA_REFLEX")
    ? "unset BASTRA_REFLEX"
    : `remove "reflex.enabled" from ${settingsFilePath()}`));

  lines.push("  optional, off by default on purpose:");
  if (s.codeAwareness.offByEnv) {
    lines.push(row(INFO, "code awareness (experimental)", "off (BASTRA_CODE_AWARENESS=off)", "unset BASTRA_CODE_AWARENESS"));
  } else {
    lines.push(s.codeAwareness.repos > 0
      ? row(ON, "code awareness (experimental)", `on for ${s.codeAwareness.repos} ${s.codeAwareness.repos === 1 ? "repository" : "repositories"}`)
      : row(INFO, "code awareness (experimental)", "off", "bastra code enable  (inside a repository)"));
  }
  lines.push(s.promptImpact
    ? row(ON, "change impact in prompts (experimental)", "on")
    : row(INFO, "change impact in prompts (experimental)", "off, not shown to help yet",
        `opt in: "promptImpact": { "enabled": true } in ${settingsFilePath()}`));
  lines.push(s.docsMode !== "off"
    ? row(ON, "product docs", s.docsMode)
    : row(INFO, "product docs", "off", "bastra config set docs.mode suggest"));
  lines.push(s.commons
    ? row(ON, "Bastra Commons", "on")
    : row(INFO, "Bastra Commons", "off", "bastra commons enable"));
  lines.push(s.bridges
    ? row(ON, "shared recall bridges", "on")
    : row(INFO, "shared recall bridges", "off", "bastra bridges enable"));
  lines.push(s.ui
    ? row(ON, "vault map", "on")
    : row(INFO, "vault map", "off", "bastra config set ui.enabled true"));
  return lines;
}

function reflexState(settings: CliSettings, env: NodeJS.ProcessEnv): FeatureState["reflex"] {
  // Same precedence as reflexConfig() in the daemon: env wins over the file.
  const raw = env.BASTRA_REFLEX;
  if (raw !== undefined && raw !== "") {
    return raw.toLowerCase() === "off" ? { enabled: false, offBy: `BASTRA_REFLEX=${raw}` } : { enabled: true };
  }
  return settings.reflex?.enabled === false ? { enabled: false, offBy: "reflex.enabled = false" } : { enabled: true };
}

async function semanticState(live: DaemonProbe | null): Promise<FeatureState["semanticRecall"]> {
  // The running daemon is the stronger witness: a LaunchAgent can carry its
  // own embedding environment that this shell does not see (#79).
  if (live?.ok && live.semanticRecall) {
    return { state: live.semanticRecall, detail: live.embeddingMode ?? "running daemon" };
  }
  const choice = await resolveEmbeddingChoice();
  return choice.provider === "none"
    ? { state: "off", detail: "keyword search only" }
    : { state: "on", detail: `${choice.provider}, from ${choice.source}` };
}

export async function paraphrasingState(
  live: DaemonProbe | null,
  semantic: FeatureState["semanticRecall"],
  env: NodeJS.ProcessEnv,
): Promise<FeatureState["paraphrasing"]> {
  if (semantic.state === "off") return { state: "n/a" };
  // doc2query only runs on Ollama embeddings. The running daemon names its
  // provider ("ollama-<model>"); a cloud provider means no row, not "off".
  const ollamaEmbeddings = live?.ok && live.embeddingMode
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
  if (raw && ["0", "false", "off", "no"].includes(raw.toLowerCase())) return { state: "off" };
  const model = await resolveGenerationModel();
  return { state: "on", model, modelPulled: await pulled(model) };
}

/** Gathers the state from settings, the vault and the running daemon. */
export async function collectFeatureState(
  clients: FeatureState["clients"],
  cliVault: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FeatureState> {
  const settings = await readSettings();
  const vault = await resolveVault({ dryRun: true, vaultPath: cliVault });
  const live = await probeDaemon().catch(() => null);
  const semanticRecall = await semanticState(live);
  return {
    clients,
    primaryLanguage: settings.language?.primary,
    onboardingDone: "error" in vault ? null : await isOnboardingDone(vault.path),
    vaultSize: live?.ok ? live.vaultSize : undefined,
    semanticRecall,
    paraphrasing: await paraphrasingState(live, semanticRecall, env),
    reflex: reflexState(settings, env),
    codeAwareness: { repos: (await enabledRepos(undefined, env)).length, offByEnv: codeAwarenessDisabledByEnv(env) },
    promptImpact: await getPromptImpactEnabled(undefined, env),
    docsMode: settings.docs?.mode ?? "off",
    commons: settings.commons?.enabled ?? false,
    bridges: settings.sharedRecall?.enabled ?? false,
    ui: settings.ui?.enabled ?? false,
  };
}

/** Doctor's printer: never throws, never changes the exit code. */
export async function printFeaturesNote(clients: FeatureState["clients"], cliVault: string | null): Promise<void> {
  try {
    const lines = featureLines(await collectFeatureState(clients, cliVault));
    process.stdout.write(`${lines.join("\n")}\n\n`);
  } catch {
    /* a diagnostics NOTE must never break doctor */
  }
}
