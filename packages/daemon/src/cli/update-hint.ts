/**
 * CLI-side update-hint (#39).
 *
 * After any `bastra <subcommand>` returns, optionally emits a dim 2-line
 * hint to stderr if a new release is available. Cheap: probes /health on
 * the configured daemon endpoint with a tight timeout (700 ms). Throttled to once per day
 * via ~/.bastra/update-hint-shown.txt (one ISO date per line, plain).
 *
 * Opt-out via env BASTRA_UPDATE_CHECK=off.
 *
 * Never throws — every failure path is silently swallowed.
 */
import { request as httpRequest } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { isOptedOut } from "../update-check.js";
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";
import { formatModelNotice, pendingModelNotice, type OfferOptions } from "../model-recommendation.js";
import { tryWithPathLock } from "../path-lock.js";

const PROBE_TIMEOUT_MS = 700;

interface HealthUpdate {
  current: string;
  latest: string;
  html_url: string;
  published_at: string;
}

interface HealthResponse {
  ok: boolean;
  update_available: HealthUpdate | null;
}

function shownFilePath(): string {
  return join(homedir(), ".bastra", "update-hint-shown.txt");
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function alreadyShownToday(path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.split("\n").some((line) => line.trim() === todayISO());
  } catch {
    return false;
  }
}

async function markShownToday(path: string): Promise<boolean> {
  try {
    await mkdir(dirname(path), { recursive: true });
    let existing = "";
    try {
      existing = await readFile(path, "utf8");
    } catch { /* file may not exist */ }
    const lines = existing
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (!lines.includes(todayISO())) lines.push(todayISO());
    // Keep last 30 entries — bounded growth.
    const trimmed = lines.slice(-30);
    await writeFile(path, trimmed.join("\n") + "\n", "utf8");
    return true;
  } catch {
    return false; // Never fail a command over the day marker.
  }
}

function probeHealth(): Promise<HealthResponse | null> {
  return new Promise((resolve_) => {
    // #531 — THE configured endpoint, not a literal 6723.
    const req = httpRequest(resolveDaemonEndpoint().healthUrl, { method: "GET", timeout: PROBE_TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HealthResponse;
          if (res.statusCode === 200 && data && data.ok) {
            resolve_(data);
            return;
          }
        } catch { /* fallthrough */ }
        resolve_(null);
      });
    });
    req.on("timeout", () => { req.destroy(); resolve_(null); });
    req.on("error", () => resolve_(null));
    req.end();
  });
}

/**
 * Emits an update hint to stderr if a daemon-reported update is available and
 * the throttle hasn't fired today. Returns true if a hint was printed.
 */
export async function maybeEmitUpdateHint(): Promise<boolean> {
  if (isOptedOut()) return false;
  if (await alreadyShownToday(shownFilePath())) return false;

  const health = await probeHealth();
  if (!health || !health.update_available) return false;

  const u = health.update_available;
  // Dim hint, written to stderr so it doesn't pollute pipeable subcommand output.
  // ANSI 2 = dim — many shells honor it; if not, plain text is still readable.
  process.stderr.write(
    `\n\x1b[2mℹ A new bastra-recall is available: ${u.latest} (you have ${u.current})\n` +
      `  → run: bastra update\x1b[0m\n`,
  );

  await markShownToday(shownFilePath());
  return true;
}

/**
 * The same kind of line for a model recommendation the user has not answered
 * yet (model-recommendation.ts): dim, on stderr, at most once per day — its own
 * day marker, so it neither hides the update hint nor is hidden by it. Needs no
 * daemon: the recommendation ships with this release. Returns true if printed.
 *
 * `opts` is for tests (a recommendation, the settings file, the marker file).
 */
export async function maybeEmitModelHint(opts: OfferOptions & { shownPath?: string } = {}): Promise<boolean> {
  const shownPath = opts.shownPath ?? join(homedir(), ".bastra", "model-hint-shown.txt");
  if (await alreadyShownToday(shownPath) || !(await pendingModelNotice(opts))) return false;
  try {
    await mkdir(dirname(shownPath), { recursive: true });
    return (await tryWithPathLock(shownPath, async () => {
      if (await alreadyShownToday(shownPath)) return false;
      const offer = await pendingModelNotice(opts);
      if (!offer) return false;
      if (!(await markShownToday(shownPath))) return false;
      const lines = formatModelNotice(offer).split("\n");
      process.stderr.write(`\n\x1b[2mℹ ${lines.join("\n  ")}\x1b[0m\n`);
      return true;
    }, { crossProcess: true, noQueue: true })) ?? false;
  } catch {
    return false; // A hint must neither interrupt the command nor bypass its day claim.
  }
}
