/**
 * Doctor's "daemon origin" note (#684): who started the running daemon and
 * where its behaviour env came from.
 *
 * A daemon the MCP forwarder auto-spawned runs with the spawning client's env
 * (minus client-only keys) plus the `daemon.env` pins from cli-settings.json —
 * not with what a service unit or LaunchAgent would have set. /health looked
 * normal either way, so this is the only place the difference shows. A NOTE:
 * never changes doctor's exit code.
 *
 * #719: who started it does not say whether its config differs. /health
 * carries a fingerprint of the daemon's behaviour settings; the same
 * fingerprint over the configured state is compared here, and a daemon that
 * differs is flagged.
 */
import { configFingerprint } from "../daemon-spawn-env.js";
import type { DaemonProbe } from "./helpers.js";

/** #719: what the running daemon's fingerprint is held against. */
export interface ConfiguredState {
  fingerprint: string;
  sources: string[];
}

/**
 * The configured state: the managed LaunchAgent's env (macOS; null when there
 * is none) with the `daemon.env` pins from cli-settings.json on top. Null when
 * neither exists — a systemd unit's env cannot be read from here, so with
 * nothing configured there is nothing to hold the daemon against.
 */
export function configuredState(
  pins: Record<string, string> | undefined,
  launchAgentEnv: Record<string, string> | null,
  platform: NodeJS.Platform = process.platform,
): ConfiguredState | null {
  const sources: string[] = [];
  if (launchAgentEnv) sources.push(platform === "win32" ? "the bastra Task Scheduler env" : "the bastra LaunchAgent env");
  if (pins && Object.keys(pins).length > 0) sources.push(platform === "win32" ? "daemon.env in %LOCALAPPDATA%\\Bastra\\cli-settings.json" : "daemon.env in ~/.bastra/cli-settings.json");
  if (sources.length === 0) return null;
  return { fingerprint: configFingerprint({ ...launchAgentEnv, ...pins }), sources };
}

/** Pure formatter (exported for tests). `configured` is null when there is
 *  nothing to compare with, undefined when the comparison does not apply (a
 *  daemon on another host). */
export function daemonOriginLines(probe: DaemonProbe, configured?: ConfiguredState | null, platform: NodeJS.Platform = process.platform): string[] {
  if (!probe.ok || !probe.startedBy) return [];
  const lines = ["→ daemon origin"];
  if (probe.startedBy === "forwarder") {
    const settingsPath = platform === "win32" ? "%LOCALAPPDATA%\\Bastra\\cli-settings.json" : "~/.bastra/cli-settings.json";
    const env = probe.envOrigin === "client+settings"
      ? `the spawning client's env plus daemon.env from ${settingsPath}`
      : `the spawning client's env (no daemon.env pins in ${settingsPath})`;
    lines.push(`  · started by an MCP client's forwarder (auto-spawn); env: ${env}`);
    if (configured?.sources.some(source => source === "the bastra LaunchAgent env" || source === "the bastra Task Scheduler env")) {
      lines.push("    a managed service is installed, but a client daemon holds the port; the service can take over after that daemon exits (normally after 30 minutes idle)");
    }
    lines.push(
      "    settings a service (systemd unit, LaunchAgent, Task Scheduler) sets only in its own env do not apply here — " +
        "pin them under daemon.env in cli-settings.json, or set BASTRA_FORWARDER_SPAWN=0 in the client entry (docs/architecture.md, MCP Forwarder)",
    );
  } else {
    const who = probe.startedBy === "launchagent"
      ? "the bastra LaunchAgent"
      : probe.startedBy === "scheduled-task" ? "the bastra Task Scheduler task"
      : probe.startedBy === "systemd" ? "systemd (INVOCATION_ID set)" : "a shell or service, directly";
    lines.push(`  · started by ${who}; env: its own`);
  }
  const running = probe.configFingerprint;
  if (running && configured === null) {
    lines.push(`  · config fingerprint: ${running} (no daemon.env pins and no managed ${platform === "win32" ? "Task Scheduler task" : "LaunchAgent"} to compare with)`);
  } else if (running && configured && running === configured.fingerprint) {
    lines.push(`  · config fingerprint: ${running} — matches ${configured.sources.join(" + ")}`);
  } else if (running && configured) {
    lines.push(
      `  ⚠ config fingerprint: running ${running}, configured ${configured.fingerprint} — ` +
        `this daemon's behaviour settings differ from ${configured.sources.join(" + ")}`,
    );
    lines.push(
      "    a service runs with its own env, a forwarder spawn with the client's env plus daemon.env — " +
        "set the same BASTRA_* behaviour settings for both, then restart the daemon (docs/architecture.md, MCP Forwarder)",
    );
  }
  return lines;
}
