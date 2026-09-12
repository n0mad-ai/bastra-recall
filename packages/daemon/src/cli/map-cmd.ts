/**
 * `bastra map` (alias: `bastra ui`) — the discovery path to the vault map
 * (#207). Brings the daemon up if it is down, then prints the local URL and
 * opens it in the default browser; when the map is still disabled it offers to
 * enable it right there (the daemon reads ui.enabled per request, so no restart
 * is needed).
 */
import { spawn } from "node:child_process";
import { getUiEnabled, setUiEnabled } from "../settings.js";
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
  if (!(await getUiEnabled(io.settingsPath))) {
    if (!isInteractive()) {
      process.stderr.write(`vault map is disabled — enable it: bastra config set ui.enabled true\n`);
      return 1;
    }
    const yes = await confirm("The vault map is disabled. Enable it now? (local only, no restart needed)", {
      defaultYes: true,
    });
    if (!yes) {
      process.stdout.write("Kept off — enable later: bastra config set ui.enabled true\n");
      return 0;
    }
    await setUiEnabled(true, io.settingsPath);
    process.stdout.write("✓ ui.enabled = true\n");
  }
  // The map IS the daemon — /ui is one of its routes. Handing out the URL while
  // nothing listens on 6723 is what the browser reported as "cannot connect"
  // (#322), so the daemon comes up first and a page only opens once it answers.
  const daemon = await ensureDaemon({
    onStarting: () => process.stdout.write("· starting the daemon — first run can take a moment…\n"),
  });
  if (!daemon.ok) {
    process.stderr.write(`✗ ${daemon.detail}\n`);
    process.stderr.write(`  not opening ${url} — the daemon serves the map, so the page would not load\n`);
    return 1;
  }
  process.stdout.write(`vault map: ${url}\n`);
  open(url);
  return 0;
}
