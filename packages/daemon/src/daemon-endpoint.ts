/**
 * THE daemon endpoint — resolved in one place (#531).
 *
 * WHY THIS EXISTS. The endpoint used to be re-derived wherever it was needed,
 * and the derivations disagreed. `status`, the adapter `doctor` checks, the
 * autostart report, the embeddings diagnostics and the update hint all probed
 * the literal `http://127.0.0.1:6723/health`, while `mapUrl()` and process
 * discovery read `BASTRA_HTTP_PORT`. With a daemon on the default port and a
 * second one on a configured port, `bastra status --json` therefore printed
 * the vault size of the DEFAULT-port instance next to the map URL of the
 * CONFIGURED one, and called that map reachable — two machines merged into one
 * report. Whoever debugs with that output measures the wrong daemon.
 *
 * So there is exactly one resolver, and every surface that names, probes,
 * starts, registers or persists the daemon goes through it. A number and the
 * address it was read from can then never come from different instances.
 *
 * Precedence, once: `BASTRA_DAEMON_URL` (the full endpoint the MCP forwarder
 * already honours) → `BASTRA_HTTP_URL` (what the thin hook clients honour) →
 * `BASTRA_HTTP_PORT` (loopback on that port) → loopback on {@link
 * DEFAULT_DAEMON_PORT}. Legacy `NEXUS_*` names are accepted alongside each.
 *
 * `configured` is the second half of the contract: it says whether this
 * process was TOLD where the daemon is. Only a configured endpoint is written
 * into client registrations and into the managed LaunchAgent — and when it is
 * not configured, an endpoint already persisted there is kept rather than
 * silently reset to the default (`endpointToPersist`). That is what makes a
 * chosen port survive a reinstall, an update and an autostart refresh.
 */

export const DEFAULT_DAEMON_PORT = 6723;

export type EndpointSource =
  | "BASTRA_DAEMON_URL"
  | "BASTRA_HTTP_URL"
  | "BASTRA_HTTP_PORT"
  | "default";

export interface DaemonEndpoint {
  /** Origin without a trailing slash, e.g. `http://127.0.0.1:26723`. */
  baseUrl: string;
  host: string;
  port: number;
  /** `127.0.0.1:26723` — the short form diagnostics name in keys and lines. */
  label: string;
  healthUrl: string;
  /** The vault map lives on the same daemon; `/ui` is one of its routes. */
  mapUrl: string;
  /** Which variable decided it — `"default"` when nothing did. */
  source: EndpointSource;
  /** True unless the endpoint is the built-in default. */
  configured: boolean;
}

type Env = Record<string, string | undefined>;

function first(env: Env, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/** A full endpoint string → origin + port, or null when it is not usable. */
function parseUrl(raw: string): { baseUrl: string; host: string; port: number } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { baseUrl: url.origin, host: url.hostname, port };
}

function build(
  parts: { baseUrl: string; host: string; port: number },
  source: EndpointSource,
): DaemonEndpoint {
  return {
    baseUrl: parts.baseUrl,
    host: parts.host,
    port: parts.port,
    label: `${parts.host}:${parts.port}`,
    healthUrl: `${parts.baseUrl}/health`,
    mapUrl: `${parts.baseUrl}/ui`,
    source,
    configured: source !== "default",
  };
}

function loopback(port: number): { baseUrl: string; host: string; port: number } {
  return { baseUrl: `http://127.0.0.1:${port}`, host: "127.0.0.1", port };
}

/**
 * Resolved fresh on every call — deliberately not a module constant. A CLI
 * process can change the environment before it probes (the tests do, and so
 * does `bastra update` when it re-execs), and a constant captured at import
 * time is exactly the stale answer this module exists to remove.
 */
export function resolveDaemonEndpoint(env: Env = process.env): DaemonEndpoint {
  const daemonUrl = first(env, "BASTRA_DAEMON_URL", "NEXUS_DAEMON_URL");
  if (daemonUrl !== undefined) {
    const parts = parseUrl(daemonUrl);
    if (parts) return build(parts, "BASTRA_DAEMON_URL");
  }
  const httpUrl = first(env, "BASTRA_HTTP_URL", "NEXUS_HTTP_URL");
  if (httpUrl !== undefined) {
    const parts = parseUrl(httpUrl);
    if (parts) return build(parts, "BASTRA_HTTP_URL");
  }
  const rawPort = first(env, "BASTRA_HTTP_PORT", "NEXUS_HTTP_PORT");
  if (rawPort !== undefined) {
    const port = Number(rawPort);
    // An unusable value falls through to the default rather than throwing:
    // a typo must not take the CLI down, and the default is what the daemon
    // would have bound anyway.
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      return build(loopback(port), "BASTRA_HTTP_PORT");
    }
  }
  return build(loopback(DEFAULT_DAEMON_PORT), "default");
}

/**
 * What to write into a client registration or the managed LaunchAgent.
 *
 * `existing` is what that file already says. A configured endpoint wins — the
 * user just said where the daemon is. Otherwise the persisted one is kept:
 * `bastra update` and `refreshManagedAutostart` run in a shell that usually
 * carries no export, and resetting the file to the default there is precisely
 * how the chosen port used to get lost.
 */
export function endpointToPersist(
  existing: string | null | undefined,
  endpoint: DaemonEndpoint = resolveDaemonEndpoint(),
): string | null {
  if (endpoint.configured) return endpoint.baseUrl;
  const kept = typeof existing === "string" ? existing.trim() : "";
  if (kept === "" || parseUrl(kept) === null) return null;
  return parseUrl(kept)!.baseUrl;
}

/** The port a persisted endpoint names, or null when there is none. */
export function portOfEndpoint(raw: string | null | undefined): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return parseUrl(raw.trim())?.port ?? null;
}
