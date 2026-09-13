/**
 * #62 — step 3 of the real-Claude-Code long-save probe: the verdict.
 *
 * Reads the `stream-json` transcripts the real client produced and the vault
 * the throwaway daemon wrote, and compares them.
 *
 * The comparison that matters is NOT "did a memory appear". It is: for every
 * `save_memory` the CLIENT emitted — the exact `body` string is in the
 * transcript, because `--output-format stream-json` puts the whole `tool_use`
 * block on the wire — are those same bytes on disk?
 *
 *   · bodiesByteIdenticalOnDisk   — sent bytes == stored bytes
 *   · bodiesDifferingOnDisk       — stored, but not what was sent (the #62 shape)
 *   · savesAcceptedButAbsent      — client saw success, disk has nothing (ditto)
 *   · savesRefusedAndAbsent       — refused AND absent: correct, not a loss
 *
 * Whether the MODEL wrote as many lines as it was asked for is reported too,
 * but separately and without effect on the verdict: a lazy model is not data
 * loss, and must never be able to look like it — or to hide it.
 *
 * Usage: node tools/probes/claude-code-long-save/verify.mjs <work-dir> [--keep]
 */
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expectedBody, tagFor } from "./shared.mjs";

const work = process.argv[2];
const keep = process.argv.includes("--keep");
if (!work) {
  console.error("usage: node verify.mjs <work-dir> [--keep]");
  process.exit(2);
}
const state = JSON.parse(await readFile(join(work, "state.json"), "utf8"));
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// ── What the client actually sent ───────────────────────────────────────────
const transcriptDir = join(work, "transcripts");
const sessions = [];
for (const name of (await readdir(transcriptDir)).sort()) {
  if (!name.endsWith(".jsonl")) continue;
  const session = Number(/(\d+)/.exec(name)?.[1] ?? 0);
  const raw = await readFile(join(transcriptDir, name), "utf8");
  const sent = [];
  const resultsById = new Map();
  let finalText = "";
  let subtype = "";
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "result") {
      finalText = String(ev.result ?? "").slice(0, 120);
      subtype = String(ev.subtype ?? "");
    }
    const content = ev?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use" && String(block.name ?? "").endsWith("__save_memory")) {
        sent.push({
          id: block.id,
          title: String(block.input?.title ?? ""),
          body: typeof block.input?.body === "string" ? block.input.body : null,
        });
      }
      if (block?.type === "tool_result") {
        const text = Array.isArray(block.content)
          ? block.content.map((c) => c?.text ?? "").join("\n")
          : String(block.content ?? "");
        resultsById.set(block.tool_use_id, { isError: Boolean(block.is_error), text });
      }
    }
  }
  for (const s of sent) s.result = resultsById.get(s.id) ?? null;
  const transport = [
    ...raw.matchAll(/(daemon unreachable|not reachable|connection closed|transport closed|ECONNRESET|socket hang up)/gi),
  ]
    .map((m) => m[0])
    .slice(0, 10);
  sessions.push({ session, sent, finalText, subtype, transport });
}

// ── Did the client open the progress channel at all? ────────────────────────
// The forwarder logs one line per tool call saying whether a `progressToken`
// came with it. No token → no `notifications/progress` → the client-side
// progress handling #62 blames cannot be exercised on that call, and saying so
// is a result, not a gap.
const forwarderLog = await readFile(join(work, "forwarder.log"), "utf8").catch(() => "");
const progressTokens = { present: 0, absent: 0, byTool: {} };
for (const m of forwarderLog.matchAll(/\[bastra-progress-debug\] tool=(\S+) progressToken=(\S+)/g)) {
  const [, tool, token] = m;
  const state = token.startsWith("present") ? "present" : "absent";
  progressTokens[state]++;
  progressTokens.byTool[tool] ??= { present: 0, absent: 0 };
  progressTokens.byTool[tool][state]++;
}

// ── What landed on disk ─────────────────────────────────────────────────────
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await walk(p);
    else if (entry.name.endsWith(".md")) files.push(p);
  }
}
await walk(join(state.vault, "memories")).catch(() => undefined);

const byTitle = new Map();
for (const file of files) {
  const raw = await readFile(file, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) continue;
  const title = (/^title:\s*(.*)$/m.exec(m[1])?.[1] ?? "").replace(/^["']|["']$/g, "").trim();
  const seen = byTitle.get(title);
  if (seen) seen.count++;
  else byTitle.set(title, { file, body: m[2], count: 1 });
}

let identical = 0;
let differing = 0;
let acceptedButAbsent = 0;
let refusedAndAbsent = 0;
let noBodyField = 0;
let asSpecified = 0;
let modelWroteSomethingElse = 0;
let savesEmitted = 0;
const charsSent = [];
const anomalies = [];

for (const s of sessions) {
  for (const call of s.sent) {
    savesEmitted++;
    if (call.body === null) {
      noBodyField++;
      anomalies.push(`session ${s.session}: save_memory call carried no body string (${call.title})`);
      continue;
    }
    charsSent.push(call.body.length);
    const stored = byTitle.get(call.title);
    if (!stored) {
      if (call.result?.isError) {
        refusedAndAbsent++;
        anomalies.push(
          `session ${s.session}: refused and absent (correct) — ${call.title}: ${(call.result.text ?? "").slice(0, 140)}`,
        );
      } else {
        acceptedButAbsent++;
        anomalies.push(`session ${s.session}: ACCEPTED BUT ABSENT — ${call.title}, ${call.body.length} chars sent`);
      }
      continue;
    }
    const sentBody = call.body.trim();
    const got = stored.body.trim();
    if (got === sentBody) {
      identical++;
    } else {
      differing++;
      let i = 0;
      while (i < Math.min(sentBody.length, got.length) && sentBody[i] === got[i]) i++;
      anomalies.push(
        `session ${s.session}: BODY DIFFERS ${call.title}: client sent ${sentBody.length} chars ` +
          `(${sha(sentBody).slice(0, 12)}), stored ${got.length} chars (${sha(got).slice(0, 12)}), ` +
          `first difference at index ${i}`,
      );
    }
    const lines = Number(/n(\d+)$/.exec(call.title)?.[1] ?? 0);
    const sessionNo = Number(/s(\d+) /.exec(call.title)?.[1] ?? 0);
    if (!lines) continue;
    if (sentBody === expectedBody(tagFor(sessionNo, lines), lines)) asSpecified++;
    else modelWroteSomethingElse++;
  }
}

const duplicateTitles = [...byTitle.entries()].filter(([, v]) => v.count > 1).map(([t, v]) => `${t} ×${v.count}`);
const transportErrors = sessions.flatMap((s) => s.transport.map((t) => `session ${s.session}: ${t}`));
const failedSessions = sessions.filter((s) => s.subtype && s.subtype !== "success").map((s) => `session ${s.session}: ${s.subtype}`);

const report = {
  client: "Claude Code, real, headless `claude -p`",
  sessionsRun: sessions.length,
  bodySizesInLines: state.lines,
  saveCallsEmittedByClient: savesEmitted,
  charsSentPerSave: charsSent,
  bodiesByteIdenticalOnDisk: identical,
  bodiesDifferingOnDisk: differing,
  savesAcceptedButAbsentOnDisk: acceptedButAbsent,
  savesRefusedAndAbsentOnDisk: refusedAndAbsent,
  callsWithNoBodyField: noBodyField,
  duplicateTitles,
  transportErrorsSeenByClient: transportErrors,
  progressTokensAttachedByClient: progressTokens,
  sessionsThatDidNotSucceed: failedSessions,
  // Informational only: the model's own fidelity, not the transport's.
  modelWroteExactlyWhatWasAsked: asSpecified,
  modelWroteSomethingElse,
  deviations:
    differing + acceptedButAbsent + noBodyField + duplicateTitles.length + transportErrors.length + failedSessions.length,
  anomalies: anomalies.slice(0, 20),
};

console.log(JSON.stringify(report, null, 2));

if (state.daemonPid) {
  try {
    process.kill(state.daemonPid, "SIGTERM");
  } catch {
    /* already gone */
  }
}
if (!keep) {
  await rm(state.vault, { recursive: true, force: true });
  await rm(state.home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
}
process.exit(report.deviations === 0 && savesEmitted > 0 ? 0 : 1);
