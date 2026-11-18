/**
 * `bastra map` (alias: `bastra ui`) — the discovery path to the vault map
 * (#207). Brings the daemon up if it is down, then prints the local URL and
 * opens it in the default browser; when the map is still disabled it offers to
 * enable it right there (the daemon reads ui.enabled per request, so no restart
 * is needed).
 */
import { spawn } from "node:child_process";
import { getPrimaryLanguage, getUiEnabled, setUiEnabled } from "../settings.js";
import { mapCmdWordsIn } from "./map-cmd-words.js";
import { ensureDaemonRunning, type DaemonStartOutcome } from "./daemon-start.js";
import { confirm, isInteractive } from "./prompt.js";
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";

/** The map's URL on this machine — THE endpoint, resolved once (#531). */
export function mapUrl(): string {
  return resolveDaemonEndpoint().mapUrl;
}

export function openInBrowser(url: string): void {
  const [cmd, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

/** Injectable for tests only — the real ones start a daemon, open a browser,
 *  and read the user's own settings file. */
export interface CmdMapIO {
  ensureDaemon(opts: { onStarting?: () => void }): Promise<DaemonStartOutcome>;
  open(url: string): void;
  settingsPath: string | undefined;
}

export async function cmdMap(io: Partial<CmdMapIO> = {}): Promise<number> {
  const url = mapUrl();
  const ensureDaemon = io.ensureDaemon ?? ensureDaemonRunning;
  const open = io.open ?? openInBrowser;
  const w = mapCmdWordsIn(await getPrimaryLanguage(io.settingsPath).catch(() => undefined));
  if (!(await getUiEnabled(io.settingsPath))) {
    if (!isInteractive()) {
      process.stderr.write(w.disabled);
      return 1;
    }
    const yes = await confirm(w.enableNow, { defaultYes: true });
    if (!yes) {
      process.stdout.write(w.keptOff);
      return 0;
    }
    await setUiEnabled(true, io.settingsPath);
    process.stdout.write(w.enabled);
  }
  // The map IS the daemon — /ui is one of its routes. Handing out the URL while
  // nothing listens on 6723 is what the browser reported as "cannot connect"
  // (#322), so the daemon comes up first and a page only opens once it answers.
  const daemon = await ensureDaemon({
    onStarting: () => process.stdout.write(w.starting),
  });
  if (!daemon.ok) {
    process.stderr.write(`✗ ${daemon.detail}\n`);
    process.stderr.write(w.notOpening(url));
    return 1;
  }
  process.stdout.write(w.url(url));
  open(url);
  return 0;
}
