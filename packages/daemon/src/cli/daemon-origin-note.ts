/**
 * Doctor's "daemon origin" note (#684): who started the running daemon and
 * where its behaviour env came from.
 *
 * A daemon the MCP forwarder auto-spawned runs with the spawning client's env
 * (minus client-only keys) plus the `daemon.env` pins from cli-settings.json —
 * not with what a service unit or LaunchAgent would have set. /health looked
 * normal either way, so this is the only place the difference shows. A NOTE:
 * never changes doctor's exit code.
 */
import type { DaemonProbe } from "./helpers.js";

/** Pure formatter (exported for tests). */
export function daemonOriginLines(probe: DaemonProbe): string[] {
  if (!probe.ok || !probe.startedBy) return [];
  const lines = ["→ daemon origin"];
  if (probe.startedBy === "forwarder") {
    const env = probe.envOrigin === "client+settings"
      ? "the spawning client's env plus daemon.env from ~/.bastra/cli-settings.json"
      : "the spawning client's env (no daemon.env pins in ~/.bastra/cli-settings.json)";
    lines.push(`  · started by an MCP client's forwarder (auto-spawn); env: ${env}`);
    lines.push(
      "    settings a service (systemd unit, LaunchAgent) sets only in its own env do not apply here — " +
        "pin them under daemon.env in cli-settings.json, or set BASTRA_FORWARDER_SPAWN=0 in the client entry (docs/architecture.md, MCP Forwarder)",
    );
  } else {
    const who = probe.startedBy === "launchagent"
      ? "the bastra LaunchAgent"
      : probe.startedBy === "systemd" ? "systemd (INVOCATION_ID set)" : "a shell or service, directly";
    lines.push(`  · started by ${who}; env: its own`);
  }
  return lines;
}
