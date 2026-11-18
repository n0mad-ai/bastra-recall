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
import { daemonOriginWordsIn } from "./daemon-origin-words.js";

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
  platform: NodeJS.Platform = process.platform
): ConfiguredState | null {
  const sources: string[] = [];
  if (launchAgentEnv)
    sources.push(platform === "win32" ? "the bastra Task Scheduler env" : "the bastra LaunchAgent env");
  if (pins && Object.keys(pins).length > 0)
    sources.push(
      platform === "win32"
        ? "daemon.env in %LOCALAPPDATA%\\Bastra\\cli-settings.json"
        : "daemon.env in ~/.bastra/cli-settings.json"
    );
  if (sources.length === 0) return null;
  return { fingerprint: configFingerprint({ ...launchAgentEnv, ...pins }), sources };
}

/** Pure formatter (exported for tests). `configured` is null when there is
 *  nothing to compare with, undefined when the comparison does not apply (a
 *  daemon on another host). `language` is doctor's language.primary (#1602). */
export function daemonOriginLines(
  probe: DaemonProbe,
  configured?: ConfiguredState | null,
  platform: NodeJS.Platform = process.platform,
  language?: string
): string[] {
  if (!probe.ok || !probe.startedBy) return [];
  const w = daemonOriginWordsIn(language);
  const lines = [w.heading];
  if (probe.startedBy === "forwarder") {
    const settingsPath =
      platform === "win32" ? "%LOCALAPPDATA%\\Bastra\\cli-settings.json" : "~/.bastra/cli-settings.json";
    const env = probe.envOrigin === "client+settings" ? w.envWithPins(settingsPath) : w.envWithoutPins(settingsPath);
    lines.push(w.byForwarder(env));
    if (
      configured?.sources.some(
        (source) => source === "the bastra LaunchAgent env" || source === "the bastra Task Scheduler env"
      )
    ) {
      lines.push(w.serviceWaits);
    }
    lines.push(w.serviceEnvIgnored);
  } else {
    lines.push(w.startedBy(w.starter(probe.startedBy)));
  }
  const running = probe.configFingerprint;
  const sources = configured?.sources.map(w.source).join(" + ") ?? "";
  if (running && configured === null) {
    lines.push(w.nothingToCompare(running, platform === "win32"));
  } else if (running && configured && running === configured.fingerprint) {
    lines.push(w.matches(running, sources));
  } else if (running && configured) {
    lines.push(w.differs(running, configured.fingerprint, sources));
    lines.push(w.differsAdvice);
  }
  return lines;
}
