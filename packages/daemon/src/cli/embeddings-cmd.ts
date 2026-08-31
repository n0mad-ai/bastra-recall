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
 *          API-key / default) + Ollama server & model presence.
 *
 * Also home of the install-end prompt (installSemanticRecallStep) and the
 * doctor note (printEmbeddingDoctorNote) so every surface points at the same
 * one-liner.
 */
import {
  getEmbeddingProvider,
  setEmbeddingProvider,
  resolveEmbeddingChoice,
  settingsFilePath,
  type EmbeddingChoice,
  type EmbeddingProviderName,
} from "../settings.js";
import { enableSemanticRecall, ensureOllama, probeOllama } from "./ollama.js";
import { probeDaemon } from "./helpers.js";
import { confirm, isInteractive } from "./prompt.js";

const ENABLE_HINT = "bastra embeddings on";

/** What the user gives up by leaving it off, in one clause.
 *
 *  #103 measured all three arms on a real 811-memory vault, 180 simulated-user
 *  queries: keyword-only found the right note in 61.1% of cases, with the
 *  vector leg on it was 80.0%. The split by user voice is the part worth
 *  carrying into a prompt — someone who names the concept exactly loses almost
 *  nothing (86.7% → 96.7%), someone who describes it in their own words loses
 *  most of their recall (26.7% → 66.7%). Stated as measured, not as a promise:
 *  it is one vault, and the wording says so. */
const OFF_COST = "keyword-only finds 61% of notes where semantic recall finds 80% (#103)";

/** The one OFF wording every surface shares (doctor, install hint, status). */
export const RECALL_OFF_NOTE = `Semantic recall is OFF — recall is keyword-only (BM25). Measured on a real vault: ${OFF_COST}, and the gap is widest when your wording differs from the note's. Enable: ${ENABLE_HINT}`;
/** Same message behind the install step's "→ semantic recall:" prefix. */
const INSTALL_OFF_HINT = `→ semantic recall: OFF — recall is keyword-only (BM25). Measured: ${OFF_COST}. Enable: ${ENABLE_HINT}`;

// Benefit first, price second. The old wording asked for 620 MB and a Homebrew
// install without once saying what they buy, so the only informed answer was
// "no" (#103, install-prompt review 2026-08-14).
export const INSTALL_PROMPT_QUESTION =
  "Enable semantic recall (multilingual vector search)? It finds notes when your wording has drifted from theirs — " +
  "on a real vault 80% of notes found, against 61% keyword-only (#103). " +
  "Downloads the embeddinggemma model (~620 MB) via Ollama (installed with Homebrew if missing).";

function write(line: string): void {
  process.stdout.write(line + "\n");
}

export async function cmdEmbeddings(opts: {
  sub: string | null;
  settingsPath?: string;
  /** Injectable for tests — the real probe hits the live daemon on 6723. */
  probe?: typeof probeDaemon;
}): Promise<number> {
  switch (opts.sub) {
    case "on":
      return cmdOn(opts.settingsPath);
    case "off":
      return cmdOff(opts.settingsPath);
    case "status":
      return cmdStatus(opts.settingsPath, opts.probe ?? probeDaemon);
    default:
      process.stderr.write("usage: bastra embeddings <on|off|status>\n");
      process.stderr.write(`  on      enable semantic recall (persists the setting + sets up Ollama/embeddinggemma)\n`);
      process.stderr.write(`  off     disable semantic recall (recall = BM25 keyword search only)\n`);
      process.stderr.write(`  status  show the effective provider, how it was resolved, and model presence\n`);
      return 2;
  }
}

async function cmdOn(settingsPath?: string): Promise<number> {
  const r = await enableSemanticRecall({ dryRun: false }, settingsPath);
  write(`✓ embedding.provider = ollama`);
  write(`  stored in ${settingsPath ?? settingsFilePath()}`);
  write(`→ semantic recall: ${r.message}`);
  if (r.status === "already-active") {
    write("  restart the daemon to apply (restart your AI client, or it applies on the next boot).");
  }
  if (r.status === "error" || r.status === "unsupported") {
    write("  setting saved — semantic recall turns ON once Ollama + the embeddinggemma model are ready;");
    write(`  recall stays keyword-only (BM25) until then. Finish setup, then re-run: ${ENABLE_HINT}`);
    return 1;
  }
  return 0;
}

async function cmdOff(settingsPath?: string): Promise<number> {
  await setEmbeddingProvider("none", settingsPath);
  write(`✓ embedding.provider = none`);
  write(`  stored in ${settingsPath ?? settingsFilePath()}`);
  write(`  semantic recall OFF — recall is keyword-only (BM25). Re-enable: ${ENABLE_HINT}`);
  const env = process.env.BASTRA_EMBEDDING_PROVIDER;
  if (env && env.toLowerCase() !== "none") {
    write(`  ⚠ BASTRA_EMBEDDING_PROVIDER=${env} (env) overrides this — unset it for the setting to take effect.`);
  }
  write("  restart the daemon to apply (activates on next boot).");
  return 0;
}

async function cmdStatus(settingsPath?: string, probe: typeof probeDaemon = probeDaemon): Promise<number> {
  const choice = await resolveEmbeddingChoice({ path: settingsPath });
  const fileProvider = await getEmbeddingProvider(settingsPath);
  const envRaw = process.env.BASTRA_EMBEDDING_PROVIDER;

  write(`effective provider: ${choice.provider}`);
  write(`  resolved via: ${sourceLabel(choice, fileProvider, envRaw, settingsPath)}`);

  // The RUNNING daemon can differ from this shell's view: a LaunchAgent/plist
  // env sets the provider without the CLI ever seeing it (host-test find,
  // 2026-07-03). Show both so 'none here, on there' stops reading as OFF.
  let daemonOn = false;
  try {
    const p = await probe();
    if (p.ok && p.semanticRecall) {
      daemonOn = p.semanticRecall === "on";
      write(`  running daemon: semantic recall ${p.semanticRecall}` +
        (p.embeddingMode ? ` (${p.embeddingMode}, source: ${p.embeddingSource ?? "?"})` : ""));
      if (choice.provider === "none" && daemonOn) {
        write("  note: the daemon runs with its own environment (e.g. LaunchAgent plist) — this shell's view only governs newly spawned daemons.");
      }
    }
  } catch {
    /* no running daemon = nothing to add */
  }

  if (choice.requested === "openai" && choice.provider === "none") {
    write("  ⚠ openai is requested but no API key is set (OPENAI_API_KEY / BASTRA_EMBEDDING_KEY) — falling back to none");
  }
  if (choice.source === "env" && fileProvider && envRaw && envRaw.toLowerCase() !== fileProvider) {
    write(`  note: BASTRA_EMBEDDING_PROVIDER=${envRaw} (env) overrides embedding.provider=${fileProvider} (cli-settings)`);
  }

  if (choice.provider === "ollama") {
    const o = await probeOllama();
    if (!o.ok) {
      write(`  ⚠ ${o.detail} — recall falls back to BM25. Fix: ${ENABLE_HINT}`);
    } else {
      write(`  ollama: ${o.detail}`);
      write(`  model embeddinggemma: ${o.hasModel ? "present" : `MISSING — recall falls back to BM25. Fix: ${ENABLE_HINT}`}`);
    }
  } else if (choice.provider === "none" && !daemonOn) {
    // Suppressed when the running daemon is semantic — an OFF hint right
    // after "running daemon: on" would contradict itself.
    write(`  ${RECALL_OFF_NOTE}`);
  }
  return 0;
}

function sourceLabel(
  choice: EmbeddingChoice,
  fileProvider: EmbeddingProviderName | undefined,
  envRaw: string | undefined,
  settingsPath?: string,
): string {
  switch (choice.source) {
    case "env":
      return `BASTRA_EMBEDDING_PROVIDER=${envRaw} (env — wins over cli-settings)`;
    case "cli-settings":
      return `embedding.provider=${fileProvider} (${settingsPath ?? settingsFilePath()})`;
    case "api-key":
      return "OPENAI_API_KEY present, no explicit provider (backwards-compat)";
    case "none":
      return "default (nothing configured)";
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
}): Promise<void> {
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
    const r = await ensureOllama({ dryRun: args.dryRun, mode: "skip" });
    write(`→ semantic recall: ${r.message}`);
    return;
  }
  if (action === "hint") {
    write(INSTALL_OFF_HINT);
    return;
  }
  if (action === "prompt") {
    const accepted = await confirm(INSTALL_PROMPT_QUESTION, { defaultYes: true });
    if (!accepted) {
      write(INSTALL_OFF_HINT);
      return;
    }
  }
  // "provision", or the prompt was accepted — same path as `bastra embeddings on`.
  const r = await enableSemanticRecall({ dryRun: args.dryRun });
  write(`→ semantic recall: ${r.message}`);
  if (r.persisted && (r.status === "error" || r.status === "unsupported")) {
    write(`  setting saved — finish setup, then re-run: ${ENABLE_HINT}`);
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
}): string[] {
  const lines: string[] = ["→ semantic recall"];
  const { choice } = i;

  if (choice.provider === "none") {
    if (i.daemon?.semanticRecall === "on") {
      lines.push(
        `  ✓ ok: running daemon uses ${i.daemon.embeddingMode ?? "semantic recall"}` +
        ` (source: ${i.daemon.embeddingSource ?? "daemon environment"})`,
      );
    } else {
      lines.push(`  note: ${RECALL_OFF_NOTE}`);
    }
    if (choice.requested === "openai") {
      lines.push(`  note: openai is requested (source: ${choice.source}) but no API key is set (OPENAI_API_KEY / BASTRA_EMBEDDING_KEY)`);
    }
  } else if (choice.provider === "ollama") {
    if (i.probe && !i.probe.ok) {
      lines.push(`  ⚠ configured (ollama, source: ${choice.source}) but ${i.probe.detail} — recall falls back to BM25. Fix: ${ENABLE_HINT}`);
    } else if (i.probe && !i.probe.hasModel) {
      lines.push(`  ⚠ configured (ollama, source: ${choice.source}) but the embeddinggemma model is missing — recall falls back to BM25. Fix: ${ENABLE_HINT}`);
    } else {
      lines.push(`  ✓ ok: ollama ${i.probe?.detail ?? "configured"}, model embeddinggemma present (source: ${choice.source})`);
    }
  } else {
    lines.push(`  ✓ ok: openai (source: ${choice.source})`);
  }

  if (
    i.envValue &&
    i.fileProvider &&
    i.envValue.toLowerCase() !== i.fileProvider
  ) {
    lines.push(`  note: BASTRA_EMBEDDING_PROVIDER=${i.envValue} (env) overrides embedding.provider=${i.fileProvider} (cli-settings)`);
  }
  return lines;
}

/** Doctor's semantic-recall block: gathers state, prints, never throws. */
export async function printEmbeddingDoctorNote(): Promise<void> {
  try {
    const choice = await resolveEmbeddingChoice();
    const fileProvider = await getEmbeddingProvider();
    const probe = choice.provider === "ollama" ? await probeOllama() : null;
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
    });
    for (const line of lines) write(line);
    write("");
  } catch {
    /* a diagnostics NOTE must never break doctor */
  }
}
