#!/usr/bin/env node
/** Agent-to-agent cmux sender (#1105). stdin is always agent prose, never owner evidence. */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function agentEnvelope(text, from) {
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(from ?? ""))
    throw new Error("--from requires an agent name (letters, digits, dot, underscore, hyphen)");
  if (!text.trim() || Buffer.byteLength(text) > 64 * 1024)
    throw new Error("stdin requires 1–65536 bytes of agent text");
  if (/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(text))
    throw new Error("stdin must not contain terminal control or directional characters; use LF newlines");
  // Keep the marker first, including when the input already has a wrapper.
  // The receiver excludes the WHOLE agent turn even if the body quotes tags.
  // One physical line remains one marked turn even without bracketed paste.
  // JSON retains multiline payloads without terminal Enter/Tab escapes.
  return `<agent-message from="${from}" transport="cmux" id="${randomUUID()}">${JSON.stringify(text)}</agent-message>`;
}

/**
 * #1155: an idle Codex pane took an Enter that arrived right behind the pasted
 * text as part of the paste and left the message unsubmitted; two separate CLI
 * calls, with their natural gap, always submitted. So Return waits this long.
 */
export const ENTER_PAUSE_MS = 300;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * #1636: text and Return are two calls, so a second sender to the same pane
 * could paste its envelope inside the first one's pause and both would leave
 * in one submission. One lock directory per target (workspace + surface) spans
 * text, pause and Return. A held lock is waited for in LOCK_POLL_MS steps; one
 * older than LOCK_STALE_MS outlived both 5 s calls plus the pause, so its
 * holder died and the lock is taken over. After LOCK_WAIT_MS nothing is sent.
 */
export const LOCK_POLL_MS = 50;
const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 20_000;

function acquireTargetLock(targets, pause, lockRoot = join(tmpdir(), "bastra-cmux-agent-send")) {
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(`${targets.workspace_id}\n${targets.surface_id}`.toLowerCase()).digest("hex");
  const lock = join(lockRoot, key.slice(0, 32));
  const started = Date.now();
  let quickRetry = true;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      return lock;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    // #1645: the deadline holds on every retry, whatever is at the lock path.
    if (Date.now() - started > LOCK_WAIT_MS)
      throw new Error("cmux target busy with another agent message; nothing was sent");
    let age;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      // Released between mkdir and stat: try again at once. A path that keeps
      // failing (#1648: a broken symlink) waits like a held lock instead.
      if (quickRetry) {
        quickRetry = false;
        continue;
      }
    }
    if (age > LOCK_STALE_MS) {
      try {
        rmdirSync(lock);
        continue;
      } catch {
        // Another waiter took it over first, or the path holds foreign contents
        // (a file, a nonempty directory) that are never deleted: wait instead.
      }
    }
    pause(LOCK_POLL_MS);
  }
}

export function sendAgentMessage(
  { text, from, surface, workspace, print = false, lockRoot },
  run = spawnSync,
  pause = sleepSync
) {
  const envelope = agentEnvelope(text, from);
  if (print) return envelope + "\n";
  const target = /^(?:[a-z]+:\d+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
  if (!target.test(surface ?? "") || !target.test(workspace ?? ""))
    throw new Error("explicit --surface and --workspace refs/UUIDs are required");
  const options = { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 };
  // The installed CLI's `send` decodes literal \n/\t. Raw JSON RPC avoids
  // that transform and also works on versions without the newer paste command.
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  let targets = { workspace_id: workspace, surface_id: surface };
  if (!uuid.test(workspace) || !uuid.test(surface)) {
    const resolved = run(
      "cmux",
      ["--id-format", "uuids", "identify", "--workspace", workspace, "--surface", surface, "--json"],
      options
    );
    if (resolved.error || resolved.status !== 0) throw new Error("cmux target resolution failed; no Enter was sent");
    let caller;
    try {
      caller = JSON.parse(resolved.stdout).caller;
    } catch {
      throw new Error("cmux target response invalid; no Enter was sent");
    }
    if (
      !uuid.test(caller?.workspace_id ?? "") ||
      !uuid.test(caller?.surface_id ?? "") ||
      caller.surface_type !== "terminal"
    )
      throw new Error("cmux explicit terminal target unresolved; no Enter was sent");
    targets = { workspace_id: caller.workspace_id, surface_id: caller.surface_id };
  }
  const lock = acquireTargetLock(targets, pause, lockRoot);
  try {
    sendThenSubmit(run, pause, targets, envelope, options);
  } finally {
    rmdirSync(lock);
  }
  return "";
}

/** The text, a pause, then Return on the same target — never Return after a failed send. */
function sendThenSubmit(run, pause, targets, envelope, options) {
  const sent = run("cmux", ["rpc", "surface.send_text", JSON.stringify({ ...targets, text: envelope })], options);
  if (sent.error || sent.status !== 0) throw new Error("cmux send failed; no Enter was sent");
  pause(ENTER_PAUSE_MS);
  const submitted = run("cmux", ["rpc", "surface.send_key", JSON.stringify({ ...targets, key: "enter" })], options);
  if (submitted.error || submitted.status !== 0)
    throw new Error("cmux Enter failed; marked text may remain in the target input; inspect before retrying");
}

async function main() {
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--print") {
      options.print = true;
      continue;
    }
    const key = { "--from": "from", "--surface": "surface", "--workspace": "workspace" }[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith("--") || options[key] !== undefined)
      throw new Error(
        "usage: cmux-agent-send.mjs --from <agent> [--print | --workspace <ref> --surface <ref>] < message.txt"
      );
    options[key] = args[++i];
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error("stdin exceeds 65536 bytes");
    chunks.push(chunk);
  }
  process.stdout.write(sendAgentMessage({ ...options, text: Buffer.concat(chunks).toString("utf8") }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
