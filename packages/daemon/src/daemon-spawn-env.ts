/**
 * #684: the environment an auto-spawned daemon starts with.
 *
 * The forwarder used to spawn the daemon with `env: process.env` — the env of
 * the MCP client that happened to start it. Two things went wrong with that:
 *
 *   - Keys that belong to the client leaked into the shared daemon. The daemon
 *     runs the hook lanes, and every lane reads `BASTRA_HOOK_TIMEOUT_MS` at
 *     load, so the timeout written into one client's MCP entry became the lane
 *     budget for every client.
 *   - Behaviour a service manager sets in its own env (systemd unit, LaunchAgent)
 *     was missing, silently: the daemon that won the port ran a different
 *     config, and nothing said so.
 *
 * The fix here is the smallest one that makes every start path configurable
 * the same way: client-only keys are dropped, and the documented daemon keys
 * below can be pinned in `~/.bastra/cli-settings.json` under `daemon.env`,
 * which wins over the client's value. A service keeps its own env as before
 * (this file only shapes the forwarder's spawn). The spawned daemon learns
 * who started it and where its env came from, and /health + doctor say so.
 */
import { createHash } from "node:crypto";
import { isOnValue } from "./env.js";

/** Keys only a client (forwarder, hook process) reads. Never a daemon setting. */
export const CLIENT_ONLY_ENV_KEYS = [
  "BASTRA_TOOL_SURFACE",
  "BASTRA_MCP_SESSION_CONTEXT",
  "BASTRA_HOOK_TIMEOUT_MS",
  "NEXUS_HOOK_TIMEOUT_MS",
  "BASTRA_FORWARDER_SPAWN",
  "BASTRA_HOOK_CLIENT",
] as const;

/** Daemon behaviour keys that exist only as env, settable in `daemon.env` (#684). */
export const DAEMON_ENV_KEYS = [
  "BASTRA_TRIGGER_EXPAND",
  "BASTRA_PROMPT_HOOK_MODE",
  "BASTRA_DOCUMENT_WRITE",
  "BASTRA_RM_ARCHIVES",
  "BASTRA_OLLAMA_URL",
] as const;

export type DaemonEnvKey = (typeof DAEMON_ENV_KEYS)[number];

export function isDaemonEnvKey(k: string): k is DaemonEnvKey {
  return (DAEMON_ENV_KEYS as readonly string[]).includes(k);
}

/** Who started this daemon — from the markers its starter leaves in its env. */
export type DaemonStartedBy = "forwarder" | "launchagent" | "systemd" | "direct";

/** Where the daemon's behaviour env came from:
 *  - `own`: its own process env (service unit, LaunchAgent, a shell) — not reshaped;
 *  - `client`: a forwarder's spawn, the client's env minus client-only keys;
 *  - `client+settings`: the same, with `daemon.env` from cli-settings.json on top. */
export type DaemonEnvOrigin = "own" | "client" | "client+settings";

export const STARTED_BY_ENV = "BASTRA_DAEMON_STARTED_BY";
export const ENV_ORIGIN_ENV = "BASTRA_DAEMON_ENV_ORIGIN";

export function daemonSpawnEnv(
  clientEnv: NodeJS.ProcessEnv,
  settingsEnv: Partial<Record<DaemonEnvKey, string>> | undefined,
): { env: NodeJS.ProcessEnv; origin: DaemonEnvOrigin; pinned: DaemonEnvKey[] } {
  const env: NodeJS.ProcessEnv = { ...clientEnv };
  for (const k of CLIENT_ONLY_ENV_KEYS) delete env[k];
  const pinned: DaemonEnvKey[] = [];
  for (const k of DAEMON_ENV_KEYS) {
    const v = settingsEnv?.[k];
    if (typeof v === "string") {
      env[k] = v;
      pinned.push(k);
    }
  }
  const origin: DaemonEnvOrigin = pinned.length > 0 ? "client+settings" : "client";
  env[STARTED_BY_ENV] = "forwarder";
  env[ENV_ORIGIN_ENV] = origin;
  return { env, origin, pinned };
}

/** Read back by the daemon for /health. */
export function daemonOrigin(env: NodeJS.ProcessEnv = process.env): { startedBy: DaemonStartedBy; envOrigin: DaemonEnvOrigin } {
  if (env[STARTED_BY_ENV] === "forwarder") {
    const o = env[ENV_ORIGIN_ENV];
    return { startedBy: "forwarder", envOrigin: o === "client+settings" ? "client+settings" : "client" };
  }
  if (isOnValue(env.BASTRA_AUTOSTART_MANAGED)) return { startedBy: "launchagent", envOrigin: "own" };
  // systemd sets INVOCATION_ID for every unit it starts.
  if (typeof env.INVOCATION_ID === "string" && env.INVOCATION_ID !== "") return { startedBy: "systemd", envOrigin: "own" };
  return { startedBy: "direct", envOrigin: "own" };
}

/**
 * #719: a short fingerprint of the behaviour config a daemon runs with.
 * /health reports the running daemon's; doctor computes the same over the
 * configured state (daemon.env pins, the managed LaunchAgent env) and flags a
 * daemon whose fingerprint differs.
 *
 * It covers every BASTRA_* / NEXUS_* key in the env that is a daemon setting,
 * i.e. not one of the client-only keys the spawn drops, except:
 *   - how and where the process runs, not what it does: BASTRA_DAEMON_* (the
 *     start markers, the endpoint, the idle shutdown a LaunchAgent switches
 *     off by design), BASTRA_AUTOSTART_MANAGED, the HTTP port and URL;
 *   - locations (*_PATH, *_DIR, *_BIN, *_ROOTS, BASTRA_NODE): a plist and a
 *     client entry spell the same vault differently, and a path differs per
 *     machine without saying anything about behaviour;
 *   - secrets (*_KEY, *_TOKEN, *_SECRET) and the userinfo of a URL value —
 *     nothing secret goes into a value /health hands out without a token.
 * Unset and empty count as the same; key order does not matter.
 */
const NOT_BEHAVIOUR =
  /^(?:BASTRA|NEXUS)_(?:DAEMON_.*|AUTOSTART_MANAGED|HTTP_PORT|HTTP_URL|NODE|.*_(?:PATH|DIR|BIN|ROOTS|KEY|TOKEN|SECRET))$/;

export function configFingerprint(env: Record<string, string | undefined>): string {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(env)) {
    if (!/^(?:BASTRA|NEXUS)_/.test(k) || NOT_BEHAVIOUR.test(k)) continue;
    if ((CLIENT_ONLY_ENV_KEYS as readonly string[]).includes(k)) continue;
    const value = (v ?? "").trim().replace(/\/\/[^/@\s]*@/, "//");
    if (value !== "") pairs.push([k, value]);
  }
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(pairs)).digest("hex").slice(0, 12);
}
