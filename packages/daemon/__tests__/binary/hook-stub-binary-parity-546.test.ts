/**
 * #546 — the guard runs the COMPILED stub, not the sources.
 *
 * Every other parity test in this package runs `stub/bastra-hook.ts` through
 * tsx. What Claude Code executes on every hook call is the `deno compile`
 * binary `stub/bastra-hook`, and nothing looked at it. Measured on `7e9f6c4`:
 * compile a stub with `ea95691` re-introduced (`session_id` replaced by a
 * fresh UUID) and `2b7d285` on top (every lane POSTing to `/hook/write`), drop
 * it at `packages/daemon/stub/bastra-hook`, and `npm test` reports 2807 tests,
 * 0 failures. The binary that runs on every hook call was outside the suite.
 *
 * That is not hypothetical. The binary installed on the dev host was from
 * 29.08. and had run for two weeks against sources that had moved on through
 * #305, #543 and #545 — a build nobody rebuilt, behaving like a fortnight-old
 * checkout, invisible to every test.
 *
 * Two questions, both only answerable against a binary:
 *
 *  1. **Parity.** For each of the seven client lanes, does a binary built from
 *     today's sources write the same row as the node thin client when the
 *     daemon is unreachable — same `kind`, the payload's `session_id`, a
 *     client `hook_version`, and the same lane fields down to the last key?
 *     All four faults this lane class has had are exactly this shape.
 *  2. **Staleness.** Does an INSTALLED binary still match the sources it must
 *     have been built from? A compiled binary has no sources beside it, so it
 *     has to carry the answer — `bastra-hook version` (#546, stub/build-info.ts).
 *
 * **Runner: `npm run test:stub`**, not `npm test`. This file needs deno, which
 * the test suite otherwise does not, and it builds a binary — cheap (~1s) but
 * not something every contributor without deno should trip over. CI runs it as
 * its own step with `setup-deno` (.github/workflows/ci.yml). When deno is
 * missing the file SKIPS locally and FAILS on CI: a guard that silently checks
 * nothing on the runner is worse than no guard.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { GATE_LANE_BY_KIND } from "../../src/cli/log-stats.js";
import { CLIENT_ROW_BASE, type ClientLane } from "../../src/hook-client-telemetry.js";
// The digest rule lives with the build script that stamps it, so the guard and
// the build can never disagree about what "the stub's sources" means.
import { stubSourceDigest, stubSourceFiles, stubSourcesDirty } from "../../scripts/stub-source-digest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..");
const SRC = join(PACKAGE_ROOT, "src");
/** The binary a developer's hooks actually run. Read here, never written. */
const INSTALLED_BINARY = join(PACKAGE_ROOT, "stub", "bastra-hook");

/** Every client lane, its node counterpart, and the event kind both must write. */
const LANES: Array<{ lane: ClientLane; kind: string; nodeClient: string }> = [
  { lane: "prompt", kind: "prompt_hook_call", nodeClient: "prompt-hook.ts" },
  { lane: "write", kind: "hook_call", nodeClient: "hook.ts" },
  { lane: "todo", kind: "todo_hook_call", nodeClient: "todo-hook.ts" },
  { lane: "session", kind: "session_hook_call", nodeClient: "session-hook.ts" },
  { lane: "bash-pre", kind: "bash_hook_call", nodeClient: "bash-pre-hook.ts" },
  { lane: "bash-fail", kind: "bash_fail_hook_call", nodeClient: "bash-fail-hook.ts" },
  { lane: "stop", kind: "save_eval_call", nodeClient: "stop-hook.ts" },
];

/** The stdin each lane expects — nothing here may be filtered out client-side,
 *  or the call never reaches the transport whose failure is under test. */
const PAYLOAD: Record<ClientLane, Record<string, unknown>> = {
  prompt: { hook_event_name: "UserPromptSubmit", prompt: "und was war da nochmal" },
  write: {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/bastra-546/app.ts", content: "export const a = 1;\n" },
  },
  "bash-pre": {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /tmp/nothing" },
  },
  "bash-fail": {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls /nope" },
    tool_response: { exit_code: 2 },
  },
  stop: { hook_event_name: "Stop", transcript_path: "/tmp/bastra-546/missing.jsonl" },
  session: { hook_event_name: "SessionStart", source: "startup" },
  todo: {
    hook_event_name: "PostToolUse",
    tool_name: "TodoWrite",
    tool_input: { todos: [{ content: "measure the lane", status: "pending" }] },
  },
};

/**
 * Fields that legitimately differ between two processes and say nothing about
 * the contract: a wall clock, a measured duration, and the version string that
 * exists precisely to tell the two client shapes apart. Everything else must
 * be identical, or the two rows are not one series.
 */
const VOLATILE = new Set(["ts", "latency_ms_total", "hook_version"]);

const denoAvailable = (() => {
  const r = spawnSync("deno", ["--version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
})();

/** A port nothing listens on, so the POST fails the way a down daemon makes it
 *  fail. Taken by binding and releasing, not guessed. */
async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      ok(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
  await new Promise<void>((ok) => server.close(() => ok()));
  return port;
}

/** Run one client against a dead daemon and return the rows it wrote. */
async function runClient(
  command: string,
  argv: string[],
  lane: ClientLane,
  sessionId: string,
  port: number,
): Promise<Array<Record<string, unknown>>> {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-546-"));
  await new Promise<void>((ok, ko) => {
    const child = spawn(command, argv, {
      env: {
        ...process.env,
        BASTRA_LOG_PATH: logDir,
        BASTRA_DAEMON_URL: `http://127.0.0.1:${port}`,
        BASTRA_TELEMETRY: "on",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.on("error", ko);
    child.on("close", () => ok());
    child.stdin.write(JSON.stringify({ session_id: sessionId, ...PAYLOAD[lane] }));
    child.stdin.end();
  });
  const rows: Array<Record<string, unknown>> = [];
  for (const file of (await readdir(logDir)).filter((f) => f.startsWith("events-"))) {
    for (const line of (await readFile(join(logDir, file), "utf8")).split("\n")) {
      if (line.trim()) rows.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return rows;
}

/** The commit this checkout is on — what a stamp's `revision` must name. */
function headRevision(): string {
  const r = spawnSync("git", ["-C", PACKAGE_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" });
  assert.equal(r.status, 0, "this test needs a git checkout");
  return r.stdout.trim();
}

/** Ask a compiled binary which sources it was built from. */
function binaryBuildInfo(binary: string): Record<string, unknown> {
  const r = spawnSync(binary, ["version"], { encoding: "utf8" });
  assert.ok(
    !r.error && r.status === 0,
    `\`${binary} version\` failed (${r.error?.message ?? `exit ${r.status}`}) — a binary that cannot say which sources it came from cannot be checked for staleness`,
  );
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

/** The binary built for this run, from today's sources, into a temp dir — the
 *  developer's installed binary is never touched. */
let builtBinary = "";

before(async () => {
  if (!denoAvailable) {
    // On CI this must be loud. A skipped guard on the runner is the state #546
    // is about: something that looks checked and is not.
    assert.ok(
      !process.env.CI,
      "deno is missing on this runner — the compiled stub cannot be built, so nothing here is being checked. Add denoland/setup-deno to the workflow step that runs `npm run test:stub`.",
    );
    return;
  }
  builtBinary = await buildStub();
});

/** Build a stub into a fresh temp dir and return its path. Never the installed
 *  one: `--output` exists so a test run cannot replace a live binary. */
async function buildStub(): Promise<string> {
  const output = join(await mkdtemp(join(tmpdir(), "bastra-546-bin-")), "bastra-hook");
  const r = spawnSync("node", [join(PACKAGE_ROOT, "scripts", "build-stub.mjs"), "--output", output], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  assert.ok(!r.error && r.status === 0, `building the stub failed: ${r.error?.message ?? r.stderr}`);
  return output;
}

test("#546: the built binary writes the same row as the node client, lane for lane", { skip: !denoAvailable && !process.env.CI ? "deno not installed" : false }, async () => {
  // Drift guard: a lane the release gate reads but this table does not cover
  // would go unmeasured on the binary the way all seven did before #546.
  const covered = new Set(LANES.map((l) => l.kind));
  for (const kind of Object.keys(GATE_LANE_BY_KIND)) {
    assert.ok(covered.has(kind), `gate lane \`${GATE_LANE_BY_KIND[kind]}\` (${kind}) is not checked against the binary`);
  }
  assert.equal(LANES.length, Object.keys(CLIENT_ROW_BASE).length, "every client lane must be checked against the binary");

  for (const { lane, kind, nodeClient } of LANES) {
    const session = `s546-${lane}`;
    // One dead port for both, so `daemon_url` is comparable: the two rows must
    // agree about which endpoint did not answer, not merely about its shape.
    const port = await closedPort();
    const [binRows, nodeRows] = await Promise.all([
      runClient(builtBinary, [lane], lane, session, port),
      runClient("npx", ["tsx", join(SRC, nodeClient)], lane, session, port),
    ]);

    assert.equal(binRows.length, 1, `binary/${lane}: expected exactly one client row, got ${binRows.length}`);
    assert.equal(nodeRows.length, 1, `node/${lane}: expected exactly one client row, got ${nodeRows.length}`);
    const bin = binRows[0]!;
    const node = nodeRows[0]!;

    for (const [shape, row] of [["binary", bin], ["node", node]] as const) {
      // The lane: a row filed under a foreign kind counts against a lane the
      // failure did not happen in (`2b7d285`).
      assert.equal(row.kind, kind, `${shape}/${lane}: wrong event kind — this row would land in another lane`);
      // The session: the only thing that ties this row to the daemon row for
      // the same call. A fresh UUID makes it unfoldable (`ea95691`).
      assert.equal(row.session_id, session, `${shape}/${lane}: the payload's session must be stamped, not a fresh UUID`);
      assert.match(
        String(row.hook_version),
        /-(stub|thin)$/,
        `${shape}/${lane}: the row must declare itself a client row, or it cannot be folded`,
      );
      assert.equal(row.daemon_reachable, false, `${shape}/${lane}: the POST went out and got no answer`);
      assert.ok(
        ["daemon-unreachable", "timeout", "error"].includes(String(row.status)),
        `${shape}/${lane}: a dead daemon must be recorded as a failure, got ${String(row.status)}`,
      );
    }

    // Full field parity. Written as one comparison rather than a list of named
    // fields on purpose: `detected_mode` (#545) is only one of the fields that
    // can drift, and a list only ever contains the ones that already have.
    const compare = (row: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(row).filter(([k]) => !VOLATILE.has(k)));
    assert.deepEqual(
      compare(bin),
      compare(node),
      `${lane}: the compiled binary and the node client write different rows — the two halves of this lane's series would disagree`,
    );
  }
});

test("#546: a compiled binary says which sources it was built from", { skip: !denoAvailable && !process.env.CI ? "deno not installed" : false }, () => {
  const info = binaryBuildInfo(builtBinary);
  assert.equal(
    info.source_digest,
    stubSourceDigest(),
    "the binary just built does not carry the digest of the sources it was built from — the staleness check below would be blind",
  );
  assert.equal(typeof info.built_at, "string", "the binary must record when it was built");
  assert.match(String(info.stub_version), /-stub$/);

  // Running from source is not a build, and must say so rather than claim a
  // digest it cannot have (same distinction `ownBuildStamp()` makes for dist).
  const fromSource = spawnSync("npx", ["tsx", join(PACKAGE_ROOT, "stub", "bastra-hook.ts"), "version"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  assert.equal(fromSource.status, 0, fromSource.stderr);
  assert.equal(
    (JSON.parse(fromSource.stdout) as { source_digest: string }).source_digest,
    "",
    "run from source there is no build, so there is no built revision to report",
  );
});

test("#546: the digest covers the files a stub binary is made of, and reacts to any of them", () => {
  const files = stubSourceFiles().map((f: string) => relative(PACKAGE_ROOT, f).split(sep).join("/"));
  // The closure must reach past the entry file: every fault this guard exists
  // for lived in a module the stub imports, not in the stub itself.
  for (const expected of [
    "stub/bastra-hook.ts",
    "src/hook-client-telemetry.ts", // ea95691 / 2b7d285 / e1cab8a live here
    "src/hook-surface.ts",
    "src/hook-write-input.ts",
    "src/hook-skip.ts",
    "src/daemon-endpoint.ts",
    "src/hook-budgets.ts",
    "src/env.ts",
  ]) {
    assert.ok(files.includes(expected), `${expected} is compiled into the stub but not covered by its digest — a change there would leave an old binary looking current. Covered: ${files.join(", ")}`);
  }
  assert.ok(
    !files.includes("stub/build-info.ts"),
    "the stamp cannot be part of the digest it carries",
  );

  // Deterministic, and sensitive to every file in the closure: flip one byte of
  // any one of them and the digest must move, or a stale binary passes.
  const baseline = stubSourceDigest();
  assert.equal(stubSourceDigest(), baseline, "the digest must not depend on traversal or filesystem order");
  for (const file of stubSourceFiles() as string[]) {
    const moved = stubSourceDigest({
      read: (path: string) => (path === file ? Buffer.from("// drifted\n") : undefined),
    });
    assert.notEqual(moved, baseline, `a change to ${file} does not move the digest`);
  }
});

test("#546: the installed binary is the one today's sources describe", { skip: !existsSync(INSTALLED_BINARY) ? "no stub binary installed in this checkout" : false }, () => {
  const info = binaryBuildInfo(INSTALLED_BINARY);
  assert.equal(
    info.source_digest,
    stubSourceDigest(),
    `${INSTALLED_BINARY} was built from different sources than the ones in this checkout` +
      ` (built ${String(info.built_at ?? "unknown")} from ${String(info.revision ?? "unknown")}).` +
      " This is the #546 finding itself: the binary every hook call runs is not the code that is here." +
      " Rebuild it with `npm run build:stub -w @bastra-recall/daemon`.",
  );
});

test(
  "#546: `dirty` is about the stub's own sources, not about whatever else lies in the checkout",
  {
    skip: !denoAvailable && !process.env.CI
      ? "deno not installed"
      : stubSourcesDirty()
        ? "the stub's sources are edited right now — this test needs a clean closure to prove that a clean build reports clean"
        : false,
  },
  async () => {
    // The fault this replaces: `dirty` was taken from the porcelain status of
    // the WHOLE repo. On the dev host a binary built from a clean, pushed
    // checkout reported `dirty: true`, because two untracked notes
    // (`.codex-handover*.md`) were lying next to it. A markdown file cannot
    // reach a compiled hook stub, and a flag that reads `true` for every
    // developer who leaves a scratch file behind can never show anyone a build
    // that really was made from uncommitted code — a field in the evidence
    // chain that always says the same thing.
    const unrelated = join(PACKAGE_ROOT, "..", "..", ".bastra-546-unrelated-scratch.md");
    try {
      await writeFile(unrelated, "a note nobody compiles\n", "utf8");
      const info = binaryBuildInfo(await buildStub());
      assert.equal(
        info.dirty,
        false,
        "an untracked file elsewhere in the checkout made the stub call its own build dirty",
      );
      // ...and the revision is the commit, not something the build's own output
      // moved: everything the stamp says is read before the stamp is written.
      assert.equal(info.revision, headRevision(), "the stamp must name the commit that is checked out");
      assert.equal(info.source_digest, stubSourceDigest(), "an unrelated file must not move the digest either");
    } finally {
      await rm(unrelated, { force: true });
    }

    // The other half: a real uncommitted change to a file that IS compiled into
    // the binary must still be reported, or the flag is merely quiet instead of
    // wrong. Restored in `finally` — this file runs alone under
    // `npm run test:stub`, so nothing else reads the stub sources meanwhile.
    const entry = join(PACKAGE_ROOT, "stub", "bastra-hook.ts");
    const original = await readFile(entry, "utf8");
    try {
      await writeFile(entry, original + "\n// uncommitted, and compiled in\n", "utf8");
      const info = binaryBuildInfo(await buildStub());
      assert.equal(
        info.dirty,
        true,
        "a binary built from an uncommitted change to its own sources must say so",
      );
      assert.equal(info.revision, headRevision(), "an uncommitted change does not move HEAD");
    } finally {
      await writeFile(entry, original, "utf8");
    }
    assert.equal(await readFile(entry, "utf8"), original, "the stub entry must be left exactly as it was found");
    assert.equal(stubSourcesDirty(), false, "the checkout must be left clean");
  },
);
