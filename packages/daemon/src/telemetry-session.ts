/**
 * #436 — the session id of a Claude Code or Codex conversation never lands in
 * the usage log (telemetry) as it was sent. Every writer stores a stable code
 * instead: an HMAC of the id under a key that stays on this machine, next to
 * the data directory and never inside the log directory. The same
 * conversation always gets the same code, so every grouping and join over the
 * log (`session_id` of the hook rows against `caller_session` of the daemon
 * rows, `bastra logs --stats`, the reports, the harvester) works as before.
 * Without the key the code leads back to nothing and cannot even confirm a
 * guessed id. Rows written before stay as they are.
 *
 * Not coded: the daemon run id (a random id of this process, the audit's
 * `session_id`, #206) and the synthetic UUID a lane writes when the hook sent
 * no session. A replay's id keeps its `replay-` prefix, which routes the row
 * to the replay file (telemetry-sink.ts `eventLogFile`).
 */
import { createHmac, randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bastraDataDir } from "./platform-paths.js";

const KEY_FILE = "telemetry-session.key";
const PREFIX = "s1_";
const REPLAY = "replay-";

let cached: { dir: string; key: Buffer } | null = null;

function readKey(path: string): Buffer | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    return /^[a-f0-9]{64}$/.test(raw) ? Buffer.from(raw, "hex") : null;
  } catch {
    return null;
  }
}

/** The key of this machine, made once. Two processes creating it at the same
 *  time agree: the file appears complete (link) or not at all, and the loser
 *  reads the winner's. A key that cannot be read or made gives this process a
 *  key of its own: codes then hold within the process, and still no raw id. */
function sessionKey(): Buffer {
  const dir = bastraDataDir();
  if (cached?.dir === dir) return cached.key;
  const path = join(dir, KEY_FILE);
  let key = readKey(path);
  if (!key) {
    const fresh = randomBytes(32);
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;
      writeFileSync(tmp, fresh.toString("hex"), { mode: 0o600, flag: "wx" });
      try {
        linkSync(tmp, path);
      } catch {
        /* another process made it first, or the directory refuses links */
      } finally {
        unlinkSync(tmp);
      }
    } catch {
      /* unwritable data directory: the fallback below */
    }
    key = readKey(path) ?? fresh;
  }
  cached = { dir, key };
  return key;
}

/** The log's code for a conversation's session id; empty and absent values stay as they are. */
export function telemetrySession(value: string): string;
export function telemetrySession<T extends null | undefined>(value: string | T): string | T;
export function telemetrySession(value: string | null | undefined): string | null | undefined {
  if (typeof value !== "string" || value === "") return value;
  const code = PREFIX + createHmac("sha256", sessionKey()).update(value).digest("hex").slice(0, 32);
  return value.startsWith(REPLAY) ? REPLAY + code : code;
}
