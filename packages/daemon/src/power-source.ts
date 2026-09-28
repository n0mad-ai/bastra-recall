/**
 * Battery mode (#632): is this Mac running on battery right now?
 *
 * Opt-in (`battery.saver`, default off; env `BASTRA_BATTERY_SAVER` wins). When
 * it is on and the Mac runs on battery, the daemon keeps its background Ollama
 * work off the battery:
 *   - the doc2query paraphraser (and its catch-up round) waits for AC,
 *   - boot / turn / session warm-ups of the embedding model are skipped,
 *   - the idle unload fires after 60 s instead of the configured window, so a
 *     model a recall loaded leaves memory again soon after.
 * An explicit recall still embeds — it only pays a cold load more often.
 *
 * Detection is `pmset -g batt` (~8 ms), polled once a minute from the daemon's
 * timer; a plug change takes effect within 60 s. Not macOS, a failed call or
 * output it cannot read → "unknown", which behaves exactly like AC.
 */
import { execFile } from "node:child_process";

export type PowerSource = "ac" | "battery" | "unknown";

/** Poll cadence; also how long a plug change can go unnoticed. */
export const POWER_POLL_MS = 60_000;
/** The idle-unload window while saving battery (instead of 10 min). */
export const BATTERY_UNLOAD_MS = 60_000;

/** `pmset -g batt` → power source. First line: "Now drawing from 'AC Power'"
 *  or "… 'Battery Power'" (a UPS reports "'UPS Power'", treated as battery). */
export function parsePmsetBatt(out: string): PowerSource {
  const m = /drawing from '([^']+)'/.exec(out);
  if (!m) return "unknown";
  const src = m[1]!.toLowerCase();
  if (src.startsWith("ac")) return "ac";
  if (src.includes("battery") || src.includes("ups")) return "battery";
  return "unknown";
}

export type ExecText = (cmd: string, args: string[]) => Promise<string>;

const execText: ExecText = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 2_000, encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/** One reading. Never throws. */
export async function readPowerSource(
  exec: ExecText = execText,
  platform: NodeJS.Platform = process.platform,
): Promise<PowerSource> {
  if (platform !== "darwin") return "unknown";
  try {
    return parsePmsetBatt(await exec("/usr/bin/pmset", ["-g", "batt"]));
  } catch {
    return "unknown";
  }
}

/** The switch: env wins over the settings file, same words as the other boolean switches. */
export function batterySaverEnabled(fileValue: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.BASTRA_BATTERY_SAVER?.trim().toLowerCase();
  if (raw && ["1", "true", "on", "yes"].includes(raw)) return true;
  if (raw && ["0", "false", "off", "no"].includes(raw)) return false;
  return fileValue ?? false;
}

export interface PowerMonitor {
  /** Last reading; "unknown" before the first one and while the saver is off. */
  source(): PowerSource;
  /** True when background model work should wait: saver on AND on battery. */
  saving(): boolean;
  /** Resolves once {@link saving} is false (immediately when it already is). */
  waitUntilNotSaving(): Promise<void>;
  /** Take a reading now. */
  poll(): Promise<PowerSource>;
  /** Start the minute poll (unref'd). No-op while the saver is off. */
  start(): void;
  /** For /health. */
  snapshot(): { battery_saver: boolean; source: PowerSource; saving: boolean };
}

export function createPowerMonitor(opts: {
  enabled: boolean;
  read?: () => Promise<PowerSource>;
  onChange?: (source: PowerSource) => void;
}): PowerMonitor {
  const read = opts.read ?? (() => readPowerSource());
  let current: PowerSource = "unknown";
  let waiters: Array<() => void> = [];
  const saving = (): boolean => opts.enabled && current === "battery";
  const poll = async (): Promise<PowerSource> => {
    if (!opts.enabled) return current;
    const next = await read();
    if (next !== current) {
      current = next;
      opts.onChange?.(next);
    }
    if (!saving() && waiters.length > 0) {
      const ready = waiters;
      waiters = [];
      for (const w of ready) w();
    }
    return current;
  };
  return {
    source: () => current,
    saving,
    waitUntilNotSaving: () => (saving() ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve()),
    poll,
    start: () => {
      if (!opts.enabled) return;
      void poll();
      setInterval(() => void poll(), POWER_POLL_MS).unref();
    },
    snapshot: () => ({ battery_saver: opts.enabled, source: current, saving: saving() }),
  };
}
