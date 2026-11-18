/**
 * The words of doctor's "daemon origin" note (#684, #719), by language.primary
 * (#1602): English is the default and the fallback (byte-identical to before),
 * German complete. Text the product writes — never matched against user text.
 * The configured sources stay English values in `ConfiguredState`; only their
 * display is translated here.
 */
const en = {
  heading: "→ daemon origin",
  envWithPins: (settingsPath: string) => `the spawning client's env plus daemon.env from ${settingsPath}`,
  envWithoutPins: (settingsPath: string) => `the spawning client's env (no daemon.env pins in ${settingsPath})`,
  byForwarder: (env: string) => `  · started by an MCP client's forwarder (auto-spawn); env: ${env}`,
  serviceWaits:
    "    a managed service is installed, but a client daemon holds the port; the service can take over after that daemon exits (normally after 30 minutes idle)",
  serviceEnvIgnored:
    "    settings a service (systemd unit, LaunchAgent, Task Scheduler) sets only in its own env do not apply here — " +
    "pin them under daemon.env in cli-settings.json, or set BASTRA_FORWARDER_SPAWN=0 in the client entry (docs/architecture.md, MCP Forwarder)",
  starter: (startedBy: string): string =>
    startedBy === "launchagent"
      ? "the bastra LaunchAgent"
      : startedBy === "scheduled-task"
        ? "the bastra Task Scheduler task"
        : startedBy === "systemd"
          ? "systemd (INVOCATION_ID set)"
          : "a shell or service, directly",
  startedBy: (who: string) => `  · started by ${who}; env: its own`,
  nothingToCompare: (running: string, windows: boolean) =>
    `  · config fingerprint: ${running} (no daemon.env pins and no managed ${windows ? "Task Scheduler task" : "LaunchAgent"} to compare with)`,
  matches: (running: string, sources: string) => `  · config fingerprint: ${running} — matches ${sources}`,
  differs: (running: string, configured: string, sources: string) =>
    `  ⚠ config fingerprint: running ${running}, configured ${configured} — ` +
    `this daemon's behaviour settings differ from ${sources}`,
  differsAdvice:
    "    a service runs with its own env, a forwarder spawn with the client's env plus daemon.env — " +
    "set the same BASTRA_* behaviour settings for both, then restart the daemon (docs/architecture.md, MCP Forwarder)",
  /** A configured source as shown; English shows the stored value itself. */
  source: (source: string): string => source,
};
export type DaemonOriginWords = typeof en;

const de: DaemonOriginWords = {
  heading: "→ Herkunft des Daemons",
  envWithPins: (settingsPath) => `die Umgebung des startenden Clients plus daemon.env aus ${settingsPath}`,
  envWithoutPins: (settingsPath) =>
    `die Umgebung des startenden Clients (keine daemon.env-Festlegungen in ${settingsPath})`,
  byForwarder: (env) => `  · gestartet vom Forwarder eines MCP-Clients (automatischer Start); Umgebung: ${env}`,
  serviceWaits:
    "    ein verwalteter Dienst ist installiert, aber ein Client-Daemon belegt den Port; der Dienst kann übernehmen, sobald dieser Daemon endet (normalerweise nach 30 Minuten ohne Nutzung)",
  serviceEnvIgnored:
    "    Einstellungen, die ein Dienst (systemd-Unit, LaunchAgent, Aufgabenplanung) nur in seiner eigenen Umgebung setzt, gelten hier nicht — " +
    "lege sie unter daemon.env in cli-settings.json fest oder setze BASTRA_FORWARDER_SPAWN=0 im Client-Eintrag (docs/architecture.md, MCP Forwarder)",
  starter: (startedBy) =>
    startedBy === "launchagent"
      ? "den bastra-LaunchAgent"
      : startedBy === "scheduled-task"
        ? "die bastra-Aufgabe in der Aufgabenplanung"
        : startedBy === "systemd"
          ? "systemd (INVOCATION_ID gesetzt)"
          : "eine Shell oder einen Dienst, direkt",
  startedBy: (who) => `  · gestartet durch ${who}; Umgebung: die eigene`,
  nothingToCompare: (running, windows) =>
    `  · Konfigurations-Fingerabdruck: ${running} (weder daemon.env-Festlegungen noch ${windows ? "eine verwaltete Aufgabe in der Aufgabenplanung" : "ein verwalteter LaunchAgent"} zum Vergleich)`,
  matches: (running, sources) => `  · Konfigurations-Fingerabdruck: ${running} — stimmt überein mit ${sources}`,
  differs: (running, configured, sources) =>
    `  ⚠ Konfigurations-Fingerabdruck: läuft ${running}, eingestellt ${configured} — ` +
    `die Verhaltenseinstellungen dieses Daemons weichen ab von ${sources}`,
  differsAdvice:
    "    ein Dienst läuft mit seiner eigenen Umgebung, ein Forwarder-Start mit der Umgebung des Clients plus daemon.env — " +
    "setze für beide dieselben BASTRA_*-Verhaltenseinstellungen und starte dann den Daemon neu (docs/architecture.md, MCP Forwarder)",
  // The two service sources `configuredState` names; a daemon.env path reads the same in German.
  source: (source) =>
    source === "the bastra LaunchAgent env"
      ? "der Umgebung des bastra-LaunchAgents"
      : source === "the bastra Task Scheduler env"
        ? "der Umgebung der bastra-Aufgabe in der Aufgabenplanung"
        : source,
};

export const DAEMON_ORIGIN_WORDS: Readonly<Record<string, DaemonOriginWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function daemonOriginWordsIn(language: string | undefined): DaemonOriginWords {
  return DAEMON_ORIGIN_WORDS[language ?? "en"] ?? en;
}
