/**
 * `bastra logs` — one readable stream out of what the daemon actually records.
 *
 * The event log is JSONL, one object per line, written by the hooks and the
 * daemon into `~/.bastra/logs/events-<day>.jsonl`. Reading it raw means either
 * `tail | jq` gymnastics or scrolling through 3 MB of nested objects, and the
 * first question anyone asks — "did the hook fire, and what did recall return?"
 * — is two fields wide. This renders exactly those fields.
 *
 * On the second source: a daemon started by the MCP forwarder runs with
 * `stdio: "ignore"` (mcp-forwarder.ts), so it has no stdout log at all. Only
 * LaunchAgent- or app-started daemons write `/tmp/bastra-daemon.{out,err}`.
 * That file is therefore included when present and silently skipped when not —
 * rather than being presented as a log the user is missing.
 */

import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  statSync,
  watch,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultLogDir } from "../learned-recall/harvest.js";
import { taskCliLanguage } from "./task-cli-words.js";

const DAEMON_STDOUT = ["/tmp/bastra-daemon.out", "/tmp/bastra-daemon.err"];
const EVENT_FILE = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** The words `bastra logs` prints around the log lines, by language.primary
 *  (#1602), English when unset or unlisted. The log lines themselves stay as
 *  they were recorded. */
export const LOGS_WORDS = {
  en: {
    noEntries: (since: string) => `(no log entries in the last ${since} — try --since 1d)`,
    noLogDir: (dir: string) => `  note: ${dir} does not exist yet; nothing has been logged.`,
    hidden: (n: number) => `… ${n} earlier line(s) hidden — raise with --lines`,
    following: "— following (ctrl-c to stop) —",
    badSince: (value: string) => `error: cannot read --since '${value}' — try 30s, 10min, 2h, 1d\n`,
    badSource: (value: string) => `error: --source must be daemon, hook or all (got '${value}')\n`,
    badLines: (value: string) => `error: --lines must be a positive number (got '${value}')\n`,
  },
  de: {
    noEntries: (since: string) => `(keine Log-Einträge in den letzten ${since} — versuch --since 1d)`,
    noLogDir: (dir: string) => `  Hinweis: ${dir} gibt es noch nicht; bisher wurde nichts geloggt.`,
    hidden: (n: number) => `… ${n} frühere Zeile(n) ausgeblendet — mehr mit --lines`,
    following: "— folge dem Log (Strg-C beendet) —",
    badSince: (value: string) => `Fehler: --since '${value}' ist nicht lesbar — versuch 30s, 10min, 2h, 1d\n`,
    badSource: (value: string) => `Fehler: --source muss daemon, hook oder all sein (war '${value}')\n`,
    badLines: (value: string) => `Fehler: --lines muss eine positive Zahl sein (war '${value}')\n`,
  },
};
export const logsWordsIn = (language: string | undefined) =>
  LOGS_WORDS[(language ?? "en") as keyof typeof LOGS_WORDS] ?? LOGS_WORDS.en;

export interface LogsOpts {
  follow: boolean;
  sinceMs: number;
  source: "daemon" | "hook" | "all";
  lines: number;
}

interface Line {
  ts: number;
  source: "daemon" | "hook";
  text: string;
}

/** `10min`, `2h`, `1d`, `90s` → milliseconds. Bare numbers are minutes. */
export function parseSince(input: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|day)?s?$/i.exec(input.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (m[2] ?? "min").toLowerCase();
  const factor = unit.startsWith("s")
    ? 1_000
    : unit.startsWith("h")
      ? 3_600_000
      : unit.startsWith("d")
        ? 86_400_000
        : 60_000;
  return n * factor;
}

/**
 * One event → one line. Keeps the fields that answer "what happened", drops
 * the measurement payload (stage timings, hit vectors) that makes the raw file
 * unreadable. Unknown kinds still render — a new event type must not vanish
 * from the log just because this formatter has not heard of it yet.
 */
export function formatEvent(e: Record<string, unknown>): string {
  const kind = String(e.kind ?? "event");
  const s = (k: string): string | null => {
    const v = e[k];
    return v === undefined || v === null ? null : String(v);
  };
  const parts: string[] = [];

  switch (kind) {
    case "recall":
    case "hook_recall": {
      const q = s("query");
      if (q) parts.push(`query=${JSON.stringify(q.length > 60 ? `${q.slice(0, 57)}…` : q)}`);
      if (e.k !== undefined) parts.push(`k=${String(e.k)}`);
      if (e.hit_count !== undefined) parts.push(`hits=${String(e.hit_count)}`);
      if (e.top_score !== undefined) parts.push(`top=${Number(e.top_score).toFixed(1)}`);
      break;
    }
    case "save_memory": {
      const id = s("id") ?? s("memory_id");
      if (id) parts.push(`id=${id}`);
      const t = s("type");
      if (t) parts.push(`type=${t}`);
      break;
    }
    case "load_memory": {
      const id = s("id") ?? s("memory_id");
      if (id) parts.push(`id=${id}`);
      break;
    }
    case "recall_episode": {
      const id = s("memory_id") ?? s("id");
      if (id) parts.push(`acted_on=${id}`);
      break;
    }
    default: {
      // Generic rendering: a couple of short, obviously-useful scalars.
      for (const key of ["id", "memory_id", "surface", "tool", "status", "reason", "state"]) {
        const v = s(key);
        if (v && v.length < 60) parts.push(`${key}=${v}`);
      }
    }
  }

  const latency = e.latency_ms;
  if (typeof latency === "number") parts.push(`${Math.round(latency)}ms`);

  return parts.length > 0 ? `${kind} ${parts.join(" ")}` : kind;
}

/** "45s", "10min", "2h", "3d" — the same vocabulary --since accepts. */
export function humanizeMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function stamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function render(l: Line): string {
  return `[${l.source === "daemon" ? "daemon" : "hook  "} ${stamp(l.ts)}] ${l.text}`;
}

/** Event-log lines newer than `cutoff`, oldest first. */
async function readHookLines(logDir: string, cutoff: number): Promise<Line[]> {
  let files: string[];
  try {
    files = (await readdir(logDir)).filter((f) => EVENT_FILE.test(f)).sort();
  } catch {
    return [];
  }
  // Only days that can still contain events inside the window.
  const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
  const relevant = files.filter((f) => (EVENT_FILE.exec(f)?.[1] ?? "") >= cutoffDay);

  const out: Line[] = [];
  for (const f of relevant) {
    let raw: string;
    try {
      raw = await readFile(join(logDir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        const ts = Date.parse(String(e.ts));
        if (Number.isNaN(ts) || ts < cutoff) continue;
        out.push({ ts, source: "hook", text: formatEvent(e) });
      } catch {
        /* skip malformed line */
      }
    }
  }
  return out;
}

/**
 * Daemon stdout, when a daemon writes any. These lines carry no timestamp of
 * their own, so they are stamped with the file's mtime — good enough to place
 * them in the stream, and honest about being an approximation.
 */
function readDaemonLines(cutoff: number): Line[] {
  const out: Line[] = [];
  for (const path of DAEMON_STDOUT) {
    // Open once, then stat and read through that one handle. Resolving the
    // path twice would leave a window in which the file is rotated or removed
    // — by log retention, a restart, or /tmp cleanup — and the two halves
    // would then describe different files.
    //
    // These two paths are fixed names in a world-writable directory, so the
    // file we open is not necessarily ours: on a shared machine anyone can
    // create /tmp/bastra-daemon.err first, or point a symlink at something
    // else, and we would print whatever they wrote as if the daemon had said
    // it. O_NOFOLLOW refuses the symlink; the uid check refuses the plant.
    // Both are cheap next to showing a user forged log lines.
    let mtime: number;
    let raw: string;
    let fd: number | null = null;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = fstatSync(fd);
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) continue;
      mtime = st.mtimeMs;
      if (mtime < cutoff) continue;
      raw = readFileSync(fd, "utf8");
    } catch {
      continue;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* already gone */
        }
      }
    }
    for (const line of raw.split("\n")) {
      if (line.trim()) out.push({ ts: mtime, source: "daemon", text: line.trimEnd() });
    }
  }
  return out;
}

/**
 * Tail one growing file, emitting whole lines as they land.
 *
 * Everything here asks the filesystem and handles the failure, rather than
 * checking first and acting second: a followed log can be rotated at midnight,
 * pruned by retention, or cleared out of /tmp while the tail is running. The
 * window between a check and the act is exactly when that happens, and a
 * crashing `bastra logs -f` is a worse answer than a skipped poll.
 */
function followFile(path: string, onLine: (text: string) => void): () => void {
  const sizeOf = (): number | null => {
    try {
      return statSync(path).size;
    } catch {
      return null; // not there (yet) — the next poll will pick it up
    }
  };

  let offset = sizeOf() ?? 0;
  let reading = false;
  let pending = "";

  const pump = (): void => {
    if (reading) return;
    const size = sizeOf();
    if (size === null) return;
    if (size < offset) offset = 0; // truncated or rotated out from under us
    if (size === offset) return;
    reading = true;
    const stream = createReadStream(path, { start: offset, encoding: "utf8" });
    stream.on("data", (chunk: string | Buffer) => {
      pending += chunk.toString();
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const p of parts) if (p.trim()) onLine(p);
    });
    stream.on("end", () => {
      offset = size;
      reading = false;
    });
    stream.on("error", () => {
      reading = false;
    });
  };

  const timer = setInterval(pump, 400);
  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(path, pump);
  } catch {
    /* fs.watch is unavailable on some mounts — the interval covers it */
  }
  return () => {
    clearInterval(timer);
    watcher?.close();
  };
}

export async function cmdLogs(opts: LogsOpts): Promise<number> {
  const logDir = defaultLogDir();
  const cutoff = Date.now() - opts.sinceMs;
  const write = (s: string): void => void process.stdout.write(`${s}\n`);
  const w = logsWordsIn(await taskCliLanguage().catch(() => "en"));

  const lines: Line[] = [];
  if (opts.source !== "daemon") lines.push(...(await readHookLines(logDir, cutoff)));
  if (opts.source !== "hook") lines.push(...readDaemonLines(cutoff));

  lines.sort((a, b) => a.ts - b.ts);
  const shown = lines.slice(-opts.lines);

  if (shown.length === 0) {
    write(w.noEntries(humanizeMs(opts.sinceMs)));
    if (!existsSync(logDir)) write(w.noLogDir(logDir));
  } else {
    if (lines.length > shown.length) {
      write(w.hidden(lines.length - shown.length));
    }
    for (const l of shown) write(render(l));
  }

  if (!opts.follow) return 0;

  // Follow mode: today's event file, plus daemon stdout when one exists.
  write(w.following);
  const stops: (() => void)[] = [];

  if (opts.source !== "daemon") {
    const emitEvent = (text: string): void => {
      try {
        const e = JSON.parse(text) as Record<string, unknown>;
        const ts = Date.parse(String(e.ts));
        write(render({ ts: Number.isNaN(ts) ? Date.now() : ts, source: "hook", text: formatEvent(e) }));
      } catch {
        /* skip malformed line */
      }
    };
    const today = (): string => join(logDir, `events-${new Date().toISOString().slice(0, 10)}.jsonl`);
    let current = today();
    stops.push(followFile(current, emitEvent));
    // Midnight rollover: the day's file changes name, so re-point the tail.
    const roll = setInterval(() => {
      const next = today();
      if (next === current) return;
      current = next;
      stops.push(followFile(current, emitEvent));
    }, 60_000);
    stops.push(() => clearInterval(roll));
  }

  if (opts.source !== "hook") {
    for (const path of DAEMON_STDOUT) {
      if (!existsSync(path)) continue;
      stops.push(followFile(path, (text) => write(render({ ts: Date.now(), source: "daemon", text }))));
    }
  }

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      for (const s of stops) s();
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}
