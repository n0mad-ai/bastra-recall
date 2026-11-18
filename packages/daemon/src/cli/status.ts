import { probeDaemon, type DaemonProbe } from "./helpers.js";
import { ADAPTERS } from "./registry.js";
import { probeOllama } from "./ollama.js";
import { getEmbeddingProvider, getApiToken, getUiEnabled, type EmbeddingProviderName } from "../settings.js";
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";
import { listDaemonProcesses, formatExtraDaemons } from "./daemon-processes.js";
import { patchesSummaryLine } from "./patches-cmd.js";
import { installWordsIn } from "./install-words.js";
import { statusWordsIn, type StatusWords } from "./status-words.js";
import { taskCliLanguage } from "./task-cli-words.js";

interface StatusOptions {
  json?: boolean;
  quiet?: boolean;
}

interface StatusResult {
  /**
   * #531 — the endpoint EVERY line below was measured against, named once.
   * `status --json` used to print the vault size of the daemon on the default
   * port next to the map URL of the configured one and call that map
   * reachable: two instances merged into one report. Now the health, the map
   * URL and this field all come from a single resolution, so a reader can see
   * which machine was measured.
   */
  endpoint: { url: string; source: string };
  daemon: { status: string; message: string };
  semanticRecall: { configured: string; active: string; detail: string };
  apiToken: { set: boolean };
  /** `reachable` is enabled AND a daemon answering — the URL only serves while
   *  the daemon runs, so "enabled" alone never meant "you can open this". */
  vaultMap: { enabled: boolean; url: string; reachable: boolean };
  surfaces: Record<string, { status: string; message: string }>;
  /** #269 — only present when a patch series is registered. */
  localPatches?: string;
}

function printLine(message: string) {
  process.stdout.write(message + "\n");
}

/**
 * The vault-map line — pure, exported for tests. "Enabled" never meant
 * "openable": /ui is a daemon route, so with the daemon down the URL is a link
 * that cannot load (#322). status is a read-only diagnostic and starts nothing;
 * it names `bastra map`, which does.
 */
export function formatVaultMapLine(uiOn: boolean, daemonOk: boolean, url: string, language?: string): string {
  const w = statusWordsIn(language);
  if (!uiOn) return w.mapOff;
  return daemonOk ? `✓ ${url}` : w.mapDown(url);
}

export async function cmdStatus(options: StatusOptions): Promise<number> {
  let hasError = false;
  // language.primary, read once for the whole run (English when unset or unreadable).
  const language = await taskCliLanguage().catch(() => "en");
  const w = statusWordsIn(language);
  const label = (name: keyof StatusWords["label"]) => w.label[name].padEnd(15);
  const status = installWordsIn(language).status;

  // Resolved ONCE and handed to everything below — the probe, the map URL and
  // process discovery all describe this one instance (#531).
  const endpoint = resolveDaemonEndpoint();

  const statusResult: StatusResult = {
    endpoint: { url: endpoint.baseUrl, source: endpoint.source },
    daemon: { status: "unknown", message: "" },
    semanticRecall: { configured: "unset", active: "unknown", detail: "" },
    apiToken: { set: false },
    vaultMap: { enabled: false, url: endpoint.mapUrl, reachable: false },
    surfaces: {},
  };

  const daemonInfo = await probeDaemon(endpoint);
  if (daemonInfo.ok) {
    statusResult.daemon = { status: "ok", message: daemonInfo.detail };
    if (!options.quiet && !options.json) {
      printLine(`${label("daemon")} ${status("ok")}: ${daemonInfo.detail}`);
    }
  } else {
    hasError = true;
    statusResult.daemon = { status: "error", message: daemonInfo.detail };
    if (!options.quiet && !options.json) {
      printLine(`${label("daemon")} ${status("error")}: ${daemonInfo.detail}`);
    }
  }

  // A daemon on another port is invisible to /health — it answers on an
  // address nobody probes. Only reported, never stopped: a second one is
  // sometimes deliberate (a measurement harness, a second vault).
  const extra = formatExtraDaemons(await listDaemonProcesses(endpoint.port), language);
  if (extra !== null && !options.quiet && !options.json) {
    printLine(`${label("daemons")} ${status("warn")}: ${extra}`);
  }

  // Semantic recall — daemon-level + global, so one line (not per adapter).
  // It NEVER flips the exit code: BM25-only is degraded, not broken.
  // The JSON detail stays English; the screen line is in language.primary.
  const configured = await getEmbeddingProvider();
  const semantic = await semanticRecallTexts(configured, daemonInfo, language);
  statusResult.semanticRecall = {
    configured: configured ?? "unset",
    active: daemonInfo.semanticRecall ?? "unknown",
    detail: semantic.detail,
  };
  if (!options.quiet && !options.json) {
    printLine(`${label("semanticRecall")} ${semantic.shown}`);
  }

  // REST API token — local setting, never shows the token itself. "not set" is
  // the secure default (loopback-only); a set token enables browser/REST clients.
  // Never flips the exit code.
  const tokenSet = (await getApiToken()) !== undefined;
  statusResult.apiToken = { set: tokenSet };
  if (!options.quiet && !options.json) {
    printLine(`${label("apiToken")} ${tokenSet ? w.tokenSet : w.tokenUnset}`);
  }

  // Local patch series (#269). Only reported when there is one — a user without
  // patches should not learn the feature exists from a permanent "0" line. Never
  // flips the exit code: a registered patch is a normal state, not a fault.
  const patchLine = patchesSummaryLine();
  if (patchLine) {
    statusResult.localPatches = patchLine;
    if (!options.quiet && !options.json) {
      printLine(`${label("localPatches")} · ${patchLine}`);
    }
  }

  // Vault map (#207) — the discovery line: where the map lives, or how to
  // get it. Local-only feature, never flips the exit code.
  //
  // The URL only works while the daemon serves it, so an enabled map with the
  // daemon down is a link that cannot load (#322). status is a read-only
  // diagnostic — it reports that instead of starting anything; `bastra map` is
  // the command that starts a daemon, and the line points at it. daemonInfo is
  // the probe from the top of this function, so this costs nothing extra.
  const uiOn = await getUiEnabled();
  // The URL and the reachability verdict come from the SAME endpoint object
  // the probe used, so "reachable" can no longer mean "some other daemon
  // answered" (#531).
  statusResult.vaultMap = { enabled: uiOn, url: endpoint.mapUrl, reachable: uiOn && daemonInfo.ok };
  if (!options.quiet && !options.json) {
    printLine(`${label("vaultMap")} ${formatVaultMapLine(uiOn, daemonInfo.ok, endpoint.mapUrl, language)}`);
  }

  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    try {
      const r = await adapter.doctor();

      statusResult.surfaces[name] = { status: r.status, message: r.message };

      if (!options.quiet && !options.json) {
        printLine(`${name.padEnd(15)} ${status(r.status)}: ${r.message}`);
      }

      if (r.status === "broken") {
        hasError = true;
      }
    } catch (err) {
      hasError = true;
      const errMsg = (err as Error).message;
      statusResult.surfaces[name] = { status: "error", message: errMsg };
      if (!options.quiet && !options.json) {
        printLine(`${name.padEnd(15)} ${status("error")}: ${w.failedToCheck(errMsg)}`);
      }
    }
  }

  // --json wins over --quiet so "machine-readable, no human noise" (-q --json)
  // still emits the JSON payload, not just an exit code.
  if (options.json) {
    printLine(JSON.stringify(statusResult, null, 2));
  }

  return hasError ? 1 : 0;
}

/** Ollama is probed only where the semantic-recall line names it. */
function needsOllamaProbe(configured: EmbeddingProviderName | undefined, d: DaemonProbe): boolean {
  if (!d.ok) return configured === "ollama";
  return d.semanticRecall === "on" && (d.embeddingMode ?? "").startsWith("ollama");
}

/** The semantic-recall detail: English for `--json`, and the screen line in
 *  `language` (#1602; Ollama's own detail comes in that language too). */
async function semanticRecallTexts(
  configured: EmbeddingProviderName | undefined,
  d: DaemonProbe,
  language: string
): Promise<{ detail: string; shown: string }> {
  if (!needsOllamaProbe(configured, d)) {
    return {
      detail: formatSemanticRecall(configured, d, undefined),
      shown: formatSemanticRecall(configured, d, undefined, language),
    };
  }
  const ollama = await probeOllama();
  const shownOllama = language === "en" ? ollama : await probeOllama(language);
  return {
    detail: formatSemanticRecall(configured, d, ollama),
    shown: formatSemanticRecall(configured, d, shownOllama, language),
  };
}

/**
 * Reconciles the *configured* provider (cli-settings) with the *active* one
 * (live /health). Distinguishes the drift classes so a just-installed user
 * isn't alarmed by a scary ✗, and so the env-override footgun is diagnosable.
 * Pure (exported for tests): `ollama` is the probe `needsOllamaProbe` asked for.
 */
export function formatSemanticRecall(
  configured: EmbeddingProviderName | undefined,
  d: DaemonProbe,
  ollama: { ok: boolean; detail: string; hasModel: boolean } | undefined,
  language?: string
): string {
  const w = statusWordsIn(language);
  if (!d.ok) {
    // Daemon down → can't read the active mode. If ollama is configured, it
    // was probed directly so "installed but daemon down" vs "model missing" is visible.
    if (ollama) {
      const detail = ollama.ok ? (ollama.hasModel ? w.ollamaReady : w.modelMissing) : ollama.detail;
      return w.downWithOllama(detail);
    }
    return w.down(configured ?? "unset");
  }
  const active = d.semanticRecall;
  if (active === undefined) return w.predates;
  if (active === "on") {
    // /health reports "on" from the configured provider — but verify Ollama is
    // actually reachable + the model pulled, else recall silently degrades to
    // BM25 at runtime and "✓ on" would be a lie.
    if (ollama && !ollama.ok) return w.onOllamaDown(d.embeddingMode ?? "?", ollama.detail);
    if (ollama && !ollama.hasModel) return w.onModelMissing(d.embeddingMode ?? "?");
    return w.on(d.embeddingMode ?? "?", d.embeddingSource);
  }
  if (active === "degraded") {
    // Daemon-side runtime health (#92): the last provider call failed after
    // boot (model deleted / server died) — recall is silently BM25-only.
    return w.degraded(d.embeddingMode ?? "?", d.embeddingError);
  }
  // active is off
  if (configured === "ollama") {
    return d.embeddingSource === "env" ? w.offEnvOverride : w.offPending;
  }
  return w.off;
}
