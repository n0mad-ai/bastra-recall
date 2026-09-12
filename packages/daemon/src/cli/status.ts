import { probeDaemon, formatStatus, type DaemonProbe } from "./helpers.js";
import { ADAPTERS } from "./registry.js";
import { probeOllama } from "./ollama.js";
import { getEmbeddingProvider, getApiToken, getUiEnabled, type EmbeddingProviderName } from "../settings.js";
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";
import { listDaemonProcesses, formatExtraDaemons } from "./daemon-processes.js";
import { patchesSummaryLine } from "./patches-cmd.js";

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
export function formatVaultMapLine(uiOn: boolean, daemonOk: boolean, url: string): string {
  if (!uiOn) return "· off (open + enable: bastra map)";
  return daemonOk ? `✓ ${url}` : `· ${url} (daemon down — open it with: bastra map)`;
}

export async function cmdStatus(options: StatusOptions): Promise<number> {
  let hasError = false;

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
      printLine(`${"daemon".padEnd(15)} ${formatStatus("ok")}: ${daemonInfo.detail}`);
    }
  } else {
    hasError = true;
    statusResult.daemon = { status: "error", message: daemonInfo.detail };
    if (!options.quiet && !options.json) {
      printLine(`${"daemon".padEnd(15)} ${formatStatus("error")}: ${daemonInfo.detail}`);
    }
  }

  // A daemon on another port is invisible to /health — it answers on an
  // address nobody probes. Only reported, never stopped: a second one is
  // sometimes deliberate (a measurement harness, a second vault).
  const extra = formatExtraDaemons(await listDaemonProcesses(endpoint.port));
  if (extra !== null && !options.quiet && !options.json) {
    printLine(`${"daemons".padEnd(15)} ${formatStatus("warn")}: ${extra}`);
  }

  // Semantic recall — daemon-level + global, so one line (not per adapter).
  // It NEVER flips the exit code: BM25-only is degraded, not broken.
  const configured = await getEmbeddingProvider();
  const srDetail = await formatSemanticRecall(configured, daemonInfo);
  statusResult.semanticRecall = {
    configured: configured ?? "unset",
    active: daemonInfo.semanticRecall ?? "unknown",
    detail: srDetail,
  };
  if (!options.quiet && !options.json) {
    printLine(`${"semantic recall".padEnd(15)} ${srDetail}`);
  }

  // REST API token — local setting, never shows the token itself. "not set" is
  // the secure default (loopback-only); a set token enables browser/REST clients.
  // Never flips the exit code.
  const tokenSet = (await getApiToken()) !== undefined;
  statusResult.apiToken = { set: tokenSet };
  if (!options.quiet && !options.json) {
    printLine(
      `${"api token".padEnd(15)} ${tokenSet ? "✓ set (browser/REST enabled)" : "· not set (loopback only)"}`,
    );
  }

  // Local patch series (#269). Only reported when there is one — a user without
  // patches should not learn the feature exists from a permanent "0" line. Never
  // flips the exit code: a registered patch is a normal state, not a fault.
  const patchLine = patchesSummaryLine();
  if (patchLine) {
    statusResult.localPatches = patchLine;
    if (!options.quiet && !options.json) {
      printLine(`${"local patches".padEnd(15)} · ${patchLine}`);
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
    printLine(`${"vault map".padEnd(15)} ${formatVaultMapLine(uiOn, daemonInfo.ok, endpoint.mapUrl)}`);
  }

  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    try {
      const r = await adapter.doctor();

      statusResult.surfaces[name] = { status: r.status, message: r.message };

      if (!options.quiet && !options.json) {
        printLine(`${name.padEnd(15)} ${formatStatus(r.status)}: ${r.message}`);
      }

      if (r.status === "broken") {
        hasError = true;
      }
    } catch (err) {
      hasError = true;
      const errMsg = (err as Error).message;
      statusResult.surfaces[name] = { status: "error", message: errMsg };
      if (!options.quiet && !options.json) {
        printLine(`${name.padEnd(15)} ${formatStatus("error")}: failed to check: ${errMsg}`);
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

/**
 * Reconciles the *configured* provider (cli-settings) with the *active* one
 * (live /health). Distinguishes the drift classes so a just-installed user
 * isn't alarmed by a scary ✗, and so the env-override footgun is diagnosable.
 */
async function formatSemanticRecall(configured: EmbeddingProviderName | undefined, d: DaemonProbe): Promise<string> {
  if (!d.ok) {
    // Daemon down → can't read the active mode. If ollama is configured, probe
    // it directly so "installed but daemon down" vs "model missing" is visible.
    if (configured === "ollama") {
      const o = await probeOllama();
      const detail = o.ok ? (o.hasModel ? "ollama ready" : "model embeddinggemma MISSING — fix: bastra embeddings on") : o.detail;
      return `· daemon not reachable; configured=ollama (${detail})`;
    }
    return `· daemon not reachable; configured=${configured ?? "unset"}`;
  }
  const active = d.semanticRecall;
  if (active === undefined) return "· (daemon predates this field — restart it to report)";
  if (active === "on") {
    // /health reports "on" from the configured provider — but verify Ollama is
    // actually reachable + the model pulled, else recall silently degrades to
    // BM25 at runtime and "✓ on" would be a lie.
    if ((d.embeddingMode ?? "").startsWith("ollama")) {
      const o = await probeOllama();
      if (o.ok && !o.hasModel) {
        return `⚠ on (${d.embeddingMode}) but the embeddinggemma model is MISSING — recall falls back to BM25. Fix: bastra embeddings on`;
      }
      if (!o.ok) {
        return `⚠ on (${d.embeddingMode}) but Ollama is unreachable (${o.detail}) — recall falls back to BM25`;
      }
    }
    return `✓ on (${d.embeddingMode ?? "?"}${d.embeddingSource ? `, source: ${d.embeddingSource}` : ""})`;
  }
  if (active === "degraded") {
    // Daemon-side runtime health (#92): the last provider call failed after
    // boot (model deleted / server died) — recall is silently BM25-only.
    const why = d.embeddingError ? ` — last error: ${d.embeddingError}` : "";
    return `⚠ degraded (${d.embeddingMode ?? "?"})${why} — recall falls back to BM25. Check: ollama list / ollama serve`;
  }
  // active is off
  if (configured === "ollama") {
    if (d.embeddingSource === "env") {
      return "· off — BASTRA_EMBEDDING_PROVIDER (env) overrides your config=ollama; unset it";
    }
    return "· off — configured=ollama, daemon hasn't picked it up yet; restart pending (restart your AI client, or auto after idle)";
  }
  return "· off — BM25 keyword search only. Enable: bastra embeddings on";
}
