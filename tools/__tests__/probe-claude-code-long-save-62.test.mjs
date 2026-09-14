/**
 * #62 — the verdict of the real-Claude-Code probe must be able to fail.
 *
 * `tools/probes/claude-code-long-save/` is evidence, and evidence is only worth
 * anything if it could have come out the other way. The probe itself needs a
 * live `claude` binary, real tokens and about a minute per session, so it is
 * not part of this suite. Its VERDICT is, and that is what these cases pin
 * down: `verify.mjs` gets hand-written transcripts and a hand-written vault,
 * one pair per failure mode #62 describes, and has to call each one correctly.
 *
 * The trap this guards against is a probe that reports a pass no matter what.
 *
 * Runner: node --test tools/__tests__/probe-claude-code-long-save-62.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VERIFY = fileURLToPath(new URL("../probes/claude-code-long-save/verify.mjs", import.meta.url));
const run = promisify(execFile);

/** One `save_memory` tool call, in the shape `--output-format stream-json`
 *  emits it: the whole input, body included, is on the wire. */
const toolUse = (id, title, body) =>
  JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id, name: "mcp__bastra62__save_memory", input: { title, body } }],
    },
  });

const toolResult = (id, { isError = false, text = "saved" } = {}) =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "text", text }] }] },
  });

const resultLine = (subtype = "success") => JSON.stringify({ type: "result", subtype, result: "PROBE_DONE" });

const memoryFile = (title, body) => `---\ntitle: ${title}\ntype: lesson\n---\n${body}\n`;

/**
 * Builds a throwaway work directory shaped exactly like the one `prepare.mjs`
 * leaves behind, runs `verify.mjs` over it and returns the parsed report.
 */
async function verdictFor({ transcript, stored, progressLog = "" }) {
  const work = await mkdtemp(join(tmpdir(), "probe62-verify-"));
  const vault = join(work, "vault");
  await mkdir(join(vault, "memories"), { recursive: true });
  await mkdir(join(work, "transcripts"), { recursive: true });
  await writeFile(join(work, "state.json"), JSON.stringify({ vault, home: join(work, "home"), work, lines: [40] }), "utf8");
  await writeFile(join(work, "transcripts", "session-0.jsonl"), transcript.join("\n"), "utf8");
  await writeFile(join(work, "forwarder.log"), progressLog, "utf8");
  let i = 0;
  for (const [title, body] of stored) {
    await writeFile(join(vault, "memories", `m${i++}.md`), memoryFile(title, body), "utf8");
  }

  let stdout;
  let code = 0;
  try {
    ({ stdout } = await run(process.execPath, [VERIFY, work, "--keep"]));
  } catch (err) {
    stdout = err.stdout ?? "";
    code = err.code ?? 1;
  }
  await rm(work, { recursive: true, force: true });
  return { report: JSON.parse(stdout), exitCode: code };
}

const BODY = Array.from({ length: 40 }, (_, i) => `line ${i + 1} s0n40 ${"x".repeat(60)}`).join("\n");

test("#62 probe verdict: bytes that arrive intact are a pass", async () => {
  const { report, exitCode } = await verdictFor({
    transcript: [toolUse("t1", "Probe 62 s0 n40", BODY), toolResult("t1"), resultLine()],
    stored: [["Probe 62 s0 n40", BODY]],
    progressLog: "[bastra-progress-debug] tool=save_memory progressToken=present(3)\n",
  });
  assert.equal(report.saveCallsEmittedByClient, 1);
  assert.equal(report.bodiesByteIdenticalOnDisk, 1);
  assert.equal(report.deviations, 0);
  assert.equal(exitCode, 0);
});

test("#62 probe verdict: a save the client was told succeeded, with nothing on disk, fails", async () => {
  const { report, exitCode } = await verdictFor({
    transcript: [toolUse("t1", "Probe 62 s0 n40", BODY), toolResult("t1"), resultLine()],
    stored: [],
  });
  assert.equal(report.savesAcceptedButAbsentOnDisk, 1);
  assert.equal(report.bodiesByteIdenticalOnDisk, 0);
  assert.ok(report.deviations >= 1);
  assert.equal(exitCode, 1);
  assert.match(report.anomalies.join("\n"), /ACCEPTED BUT ABSENT/);
});

test("#62 probe verdict: a body truncated in flight fails, and names where", async () => {
  const { report, exitCode } = await verdictFor({
    transcript: [toolUse("t1", "Probe 62 s0 n40", BODY), toolResult("t1"), resultLine()],
    stored: [["Probe 62 s0 n40", BODY.slice(0, 1_000)]],
  });
  assert.equal(report.bodiesDifferingOnDisk, 1);
  assert.equal(exitCode, 1);
  assert.match(report.anomalies.join("\n"), /BODY DIFFERS .* first difference at index 1000/);
});

test("#62 probe verdict: a refused save with nothing on disk is correct, not a loss", async () => {
  const { report, exitCode } = await verdictFor({
    transcript: [
      toolUse("t1", "Probe 62 s0 n40", BODY),
      toolResult("t1", { isError: true, text: "claim already held" }),
      resultLine(),
    ],
    stored: [],
  });
  assert.equal(report.savesRefusedAndAbsentOnDisk, 1);
  assert.equal(report.savesAcceptedButAbsentOnDisk, 0);
  assert.equal(report.deviations, 0);
  assert.equal(exitCode, 0);
});

test("#62 probe verdict: the same memory written twice is a deviation", async () => {
  const { report } = await verdictFor({
    transcript: [toolUse("t1", "Probe 62 s0 n40", BODY), toolResult("t1"), resultLine()],
    stored: [
      ["Probe 62 s0 n40", BODY],
      ["Probe 62 s0 n40", BODY],
    ],
  });
  assert.deepEqual(report.duplicateTitles, ["Probe 62 s0 n40 ×2"]);
  assert.ok(report.deviations >= 1);
});

test("#62 probe verdict: a lazy model is reported, but is not counted as data loss", async () => {
  const short = "line 1 s0n40 xxx";
  const { report, exitCode } = await verdictFor({
    transcript: [toolUse("t1", "Probe 62 s0 n40", short), toolResult("t1"), resultLine()],
    stored: [["Probe 62 s0 n40", short]],
  });
  assert.equal(report.modelWroteSomethingElse, 1);
  assert.equal(report.modelWroteExactlyWhatWasAsked, 0);
  assert.equal(report.bodiesByteIdenticalOnDisk, 1);
  assert.equal(report.deviations, 0, "what the model chose to write is not a transport defect");
  assert.equal(exitCode, 0);
});

test("#62 probe verdict: a session that never called the tool is never a pass", async () => {
  const { report, exitCode } = await verdictFor({ transcript: [resultLine()], stored: [] });
  assert.equal(report.saveCallsEmittedByClient, 0);
  assert.equal(report.deviations, 0, "nothing went wrong — but nothing was measured either");
  assert.equal(exitCode, 1, "no saves emitted must still exit non-zero");
});

test("#62 probe verdict: a client-visible transport error fails the run", async () => {
  const { report, exitCode } = await verdictFor({
    transcript: [
      toolUse("t1", "Probe 62 s0 n40", BODY),
      toolResult("t1", { isError: true, text: "daemon unreachable" }),
      resultLine("error_during_execution"),
    ],
    stored: [],
  });
  assert.ok(report.transportErrorsSeenByClient.length >= 1);
  assert.deepEqual(report.sessionsThatDidNotSucceed, ["session 0: error_during_execution"]);
  assert.equal(exitCode, 1);
});

test("#62 probe verdict: it reports whether the client opened the progress channel at all", async () => {
  const { report } = await verdictFor({
    transcript: [toolUse("t1", "Probe 62 s0 n40", BODY), toolResult("t1"), resultLine()],
    stored: [["Probe 62 s0 n40", BODY]],
    progressLog: [
      "[bastra-progress-debug] tool=recall progressToken=present(2)",
      "[bastra-progress-debug] tool=save_memory progressToken=present(3)",
      "[bastra-progress-debug] tool=recall progressToken=ABSENT",
      "",
    ].join("\n"),
  });
  assert.deepEqual(report.progressTokensAttachedByClient, {
    present: 2,
    absent: 1,
    byTool: { recall: { present: 1, absent: 1 }, save_memory: { present: 1, absent: 0 } },
  });
});
