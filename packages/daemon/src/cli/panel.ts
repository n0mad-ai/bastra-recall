/**
 * `bastra` (no args) — compact status panel.
 *
 * Shows the CLI/daemon version pair + update status, the configured update
 * mode, daemon health, vault size and — only when it is actionable — the
 * semantic-recall offer. Read-only, single shot, no TUI: this is the OSS
 * "control surface" — flags and status. Browsing/editing memories lives in the
 * Pro Mac app.
 */
import { getJson } from "../prompt-loopback.js";
import { VERSION, VERSION_DRIFT_HINT } from "./helpers.js";
import type { CodeStale } from "../code-staleness.js";
import { probeOllama } from "./ollama.js";
import {
  getUpdateMode,
  getDocsMode,
  getDocsLanguage,
  getApiToken,
  resolveEmbeddingChoice,
  type EmbeddingProviderName,
} from "../settings.js";
import type { ParsedArgs } from "./types.js";
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";
import { panelWords, panelWordsIn, type PanelWords } from "./panel-words.js";

interface HealthUpdate {
  current: string;
  latest: string;
  html_url: string;
}

interface HealthResponse {
  ok: boolean;
  version?: string;
  vault_size?: number;
  vault_availability?: { warning: string | null };
  semantic_recall?: "on" | "off" | "degraded";
  update_available?: HealthUpdate | null;
  code_stale?: CodeStale | null;
}

/** A rendered box row: label column, value column. */
export type PanelRow = [label: string, value: string];

function probeHealth(baseUrl: string): Promise<HealthResponse | null> {
  return getJson<HealthResponse>(baseUrl, "/health", 1200).then((d) => (d && d.ok ? d : null));
}

/**
 * Fresh memory count: hits /vault/count, which reconciles the daemon's index
 * against disk first (the watcher misses external writes on cloud mounts, so
 * /health's vault_size can be stale). Bigger timeout — reconcile walks the
 * tree. Null on any failure; the panel then falls back to /health's size.
 */
function probeCount(baseUrl: string): Promise<number | null> {
  return getJson<{ count: number }>(baseUrl, "/vault/count", 4000).then((d) =>
    d && typeof d.count === "number" ? d.count : null
  );
}

/**
 * The version block (#225). The previous single row was `health?.version ??
 * VERSION` — a construction that can never be right for a drifted pair: it
 * printed the daemon's build under a bare "version" label, so an outdated CLI
 * looked current (and the update hint went on to claim "you have <that>").
 *
 * Matching pair → one compact row. Drifted → two rows, both builds named, plus
 * the drift marker and how to end it. Deliberately NOT modelled: a reachable
 * daemon too old to report `version` at all — /health has carried the field
 * since before the update check that consumes it, so it collapses into the
 * "no daemon version to compare" branch instead of earning its own state.
 */
export function formatVersionRows(
  i: {
    cliVersion: string;
    /** The running daemon's build, or null when there is nothing to compare. */
    daemonVersion: string | null;
    /** Newer release the daemon knows about, or null. */
    updateLatest: string | null;
    /** Set when the daemon's code was replaced under it (#329). */
    codeStale?: CodeStale | null;
  },
  w: PanelWords = panelWordsIn("en")
): PanelRow[] {
  if (i.daemonVersion === null) {
    return [[w.version, w.offline(i.cliVersion)]];
  }
  const status = i.updateLatest ? w.available(i.updateLatest) : w.upToDate;
  // #329 — a daemon whose code was swapped out reports the version it booted
  // with. Printing that as the version, next to "✓ up to date", is exactly the
  // sentence the user must not be given: the answer itself is out of date, and
  // the update status was computed from it.
  if (i.codeStale) {
    const s = i.codeStale;
    // Same version on both sides means the build moved, not the release — and
    // then naming the version twice says nothing. The build time does.
    const detail =
      s.running === s.on_disk
        ? w.buildNewer(s.running, s.built_at.slice(0, 16).replace("T", " "))
        : w.processAndDisk(s.running, s.on_disk);
    return [
      [w.version, w.replaced(i.cliVersion)],
      ["", detail],
    ];
  }
  if (i.daemonVersion === i.cliVersion) {
    return [[w.version, `${i.cliVersion}  ${status}`]];
  }
  return [
    [w.version, w.drift(i.cliVersion, VERSION_DRIFT_HINT)],
    ["", w.daemonStatus(i.daemonVersion, status)],
  ];
}

/**
 * The semantic-recall discovery line (#224). probeOllama() only ever ran once
 * Ollama was ALREADY configured, so a user with a running local Ollama and
 * provider=none had no way to learn that semantic recall was one command away.
 *
 * One row, and only when acting on it is actually possible — an unreachable
 * Ollama produces no row rather than a nag. Suppressed while the running daemon
 * reports semantic recall on/degraded: its environment (LaunchAgent plist) can
 * carry a provider this shell never sees, and "off" next to a semantic daemon
 * would contradict itself.
 *
 * Reduced scope by design: the map banner and the one-time prompt are not part
 * of this.
 */
export function semanticRecallRow(
  i: {
    effectiveProvider: EmbeddingProviderName;
    daemonSemanticRecall: "on" | "off" | "degraded" | undefined;
    ollamaReachable: boolean;
  },
  w: PanelWords = panelWordsIn("en")
): PanelRow | null {
  if (i.effectiveProvider !== "none") return null;
  if (i.daemonSemanticRecall === "on" || i.daemonSemanticRecall === "degraded") return null;
  if (!i.ollamaReachable) return null;
  return [w.semantic, w.semanticOffer];
}

function renderBox(title: string, rows: Array<[string, string]>): string {
  const labelWidth = Math.max(...rows.map(([l]) => l.length));
  const lines = rows.map(([l, v]) => `  ${l.padEnd(labelWidth)}  ${v}`);
  const innerWidth = Math.max(title.length + 3, ...lines.map((l) => l.length));
  const top = `┌ ${title} ${"─".repeat(Math.max(0, innerWidth - title.length - 2))}┐`;
  const bottom = `└${"─".repeat(innerWidth)}┘`;
  return [top, ...lines, bottom].join("\n");
}

export async function cmdPanel(_args: ParsedArgs): Promise<number> {
  // #531 — one endpoint for both probes; the panel used to derive its own.
  const endpoint = resolveDaemonEndpoint();
  const w = await panelWords();
  // Fresh count (reconciles index vs. disk) + health + modes, in parallel.
  // The Ollama probe rides along unconditionally instead of waiting for the
  // provider lookup: sequencing the two would add its latency to the panel,
  // while here it stays inside the 4 s /vault/count probe it runs beside. With
  // no ollama binary on PATH it returns without touching the network at all.
  const [health, freshCount, mode, docsMode, docsLanguage, apiToken, embedding, ollama] = await Promise.all([
    probeHealth(endpoint.baseUrl),
    probeCount(endpoint.baseUrl),
    getUpdateMode(),
    getDocsMode(),
    getDocsLanguage(),
    getApiToken(),
    resolveEmbeddingChoice(),
    probeOllama(),
  ]);

  const versionRows = formatVersionRows(
    {
      cliVersion: VERSION,
      daemonVersion: health?.version ?? null,
      updateLatest: health?.update_available?.latest ?? null,
      codeStale: health?.code_stale ?? null,
    },
    w
  );
  const recallRow = semanticRecallRow(
    {
      effectiveProvider: embedding.provider,
      daemonSemanticRecall: health?.semantic_recall,
      ollamaReachable: ollama.ok,
    },
    w
  );

  const daemonRow = health ? w.running(endpoint.label) : w.notRunning;
  // Prefer the reconciled count; fall back to /health's (possibly stale) size.
  const count = freshCount ?? health?.vault_size ?? null;
  const vaultRow = count != null ? w.memories(count) : "—";

  const box = renderBox("bastra-recall", [
    ...versionRows,
    [w.update, w.mode(mode)],
    [w.daemon, daemonRow],
    [w.vault, vaultRow],
    ...(health?.vault_availability?.warning ? [[w.vaultWarning, health.vault_availability.warning] as PanelRow] : []),
    ...(recallRow ? [recallRow] : []),
    [w.docs, docsMode === "off" ? w.off : `${docsMode} (${docsLanguage})`],
    [w.apiToken, apiToken ? w.tokenSet : w.tokenUnset],
  ]);

  process.stdout.write(box + "\n");
  process.stdout.write(w.help);
  process.stdout.write("  bastra config set update.mode …   notify | auto | off\n");
  process.stdout.write(w.docsMode);
  if (health?.update_available) {
    process.stdout.write(w.updateNow(health.update_available.latest));
  }
  return 0;
}
