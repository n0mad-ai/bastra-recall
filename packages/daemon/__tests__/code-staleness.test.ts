/**
 * The daemon notices when its own code was replaced (#329).
 *
 * Observed 02.08. on a source checkout: process started 15:34, `dist/index.js`
 * rebuilt 18:45, `bastra --version` (fresh process) said 0.9.0 — and /health
 * said 0.8.9 for another sixteen hours. Node does not reload modules; that part
 * is expected. That nobody noticed is not: /health is where the update check,
 * the panel, doctor and the MCP handshake get their version from, so one stale
 * process told all of them the same stale truth about itself.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/code-staleness.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createStalenessMonitor,
  decideStale,
  describeStale,
  type StalenessIo,
} from "../src/code-staleness.js";
import { buildHealthPayload } from "../src/http-health.js";
import { formatVersionRows } from "../src/cli/panel.js";

const BOOT = Date.UTC(2026, 7, 2, 13, 34) ;
const REBUILT = Date.UTC(2026, 7, 2, 16, 45);

test("a rebuild under the running process is reported", () => {
  const s = decideStale({
    running: "0.8.9",
    diskVersion: "0.9.0",
    bootMtimeMs: BOOT,
    currentMtimeMs: REBUILT,
  });
  assert.ok(s, "the observed case must produce a finding");
  assert.equal(s.reason, "rebuilt");
  assert.equal(s.running, "0.8.9");
  assert.equal(s.on_disk, "0.9.0");
  assert.equal(s.built_at, new Date(REBUILT).toISOString());
});

test("a rebuild without a version bump still counts — the build is what runs", () => {
  const s = decideStale({
    running: "0.9.0",
    diskVersion: "0.9.0",
    bootMtimeMs: BOOT,
    currentMtimeMs: REBUILT,
  });
  assert.ok(s, "equal versions do not mean equal code");
  assert.equal(s.reason, "rebuilt");
});

test("pulled but not built is a different finding, not the same one", () => {
  // package.json moved, dist did not. Restarting would change nothing — the
  // build has to happen first, and saying "restart" here would be wrong.
  const s = decideStale({
    running: "0.8.9",
    diskVersion: "0.9.0",
    bootMtimeMs: BOOT,
    currentMtimeMs: BOOT,
  });
  assert.ok(s);
  assert.equal(s.reason, "not-built");
  assert.match(describeStale(s), /npm run build/);
  assert.doesNotMatch(describeStale(s), /^code on disk was replaced/);
});

test("an untouched installation reports nothing", () => {
  assert.equal(
    decideStale({ running: "0.9.0", diskVersion: "0.9.0", bootMtimeMs: BOOT, currentMtimeMs: BOOT }),
    null,
    "no rebuild, no drift — there must be no false alarm",
  );
});

test("no readable build is no finding (running from source via tsx)", () => {
  assert.equal(
    decideStale({ running: "0.9.0", diskVersion: "0.9.0", bootMtimeMs: null, currentMtimeMs: null }),
    null,
  );
});

// ─── monitor: throttle and log-once ──────────────────────────────────────────

function harness(initial: { version: string; mtime: number | null }) {
  const state = { ...initial, now: 1_000_000 };
  const logs: string[] = [];
  const io: StalenessIo = {
    diskVersion: () => state.version,
    buildMtimeMs: () => state.mtime,
    now: () => state.now,
    log: (l) => logs.push(l),
  };
  return { state, logs, io };
}

test("the disk is re-read at most once per throttle window", () => {
  const h = harness({ version: "0.8.9", mtime: BOOT });
  let stats = 0;
  const io: StalenessIo = { ...h.io, buildMtimeMs: () => (stats++, h.state.mtime) };
  const m = createStalenessMonitor("0.8.9", io, 30_000);
  const afterBoot = stats; // the constructor takes one reading
  for (let n = 0; n < 50; n++) m.check();
  assert.equal(stats - afterBoot, 1, "the statusline polls /health about once a second");

  h.state.now += 30_001;
  m.check();
  assert.equal(stats - afterBoot, 2, "past the window it probes again");
});

test("a rebuild becomes visible within one window, and is logged exactly once", () => {
  const h = harness({ version: "0.8.9", mtime: BOOT });
  const m = createStalenessMonitor("0.8.9", h.io, 30_000);
  assert.equal(m.check(), null);
  assert.deepEqual(h.logs, [], "nothing to say about a healthy process");

  // The rebuild happens.
  h.state.mtime = REBUILT;
  h.state.version = "0.9.0";
  h.state.now += 30_001;

  const found = m.check();
  assert.ok(found, "the rebuild must surface on the next probe");
  assert.equal(found.reason, "rebuilt");
  assert.equal(h.logs.length, 1, "exactly one line");
  assert.match(h.logs[0], /restart the daemon/);

  // Every later interval sees the same state — and says nothing more.
  for (let n = 0; n < 5; n++) {
    h.state.now += 30_001;
    m.check();
  }
  assert.equal(h.logs.length, 1, "a repeated finding must not become log noise");
});

test("a second, different change earns its own line", () => {
  const h = harness({ version: "0.8.9", mtime: BOOT });
  const m = createStalenessMonitor("0.8.9", h.io, 30_000);
  m.check();
  h.state.mtime = REBUILT;
  h.state.now += 30_001;
  m.check();
  h.state.mtime = REBUILT + 60_000; // built again
  h.state.now += 30_001;
  m.check();
  assert.equal(h.logs.length, 2);
});

test("the monitor never restarts anything — it only answers", () => {
  // Guard by construction: the module's public surface is a verdict and a
  // description. If a restart ever gets added here, this import list changes.
  const m = createStalenessMonitor("0.9.0", harness({ version: "0.9.0", mtime: BOOT }).io);
  assert.deepEqual(Object.keys(m), ["check"]);
});

// ─── the surfaces that consume it ────────────────────────────────────────────

test("/health carries code_stale, and null when there is nothing to report", () => {
  const base = {
    vaultSize: () => 691,
    version: "0.8.9",
    embedding: { on: false, providerId: null, source: "none" as const },
    updateState: () => null,
  };
  const clean = buildHealthPayload(base);
  assert.equal(clean.code_stale, null, "a healthy daemon must say so explicitly, not omit the field");

  const stale = buildHealthPayload({
    ...base,
    codeStale: () => ({
      running: "0.8.9",
      on_disk: "0.9.0",
      built_at: new Date(REBUILT).toISOString(),
      reason: "rebuilt" as const,
    }),
  });
  assert.deepEqual(stale.code_stale, {
    running: "0.8.9",
    on_disk: "0.9.0",
    built_at: new Date(REBUILT).toISOString(),
    reason: "rebuilt",
  });
  assert.equal(stale.version, "0.8.9", "version keeps meaning 'what this process runs'");
});

test("the panel stops calling a replaced daemon up to date", () => {
  const rows = formatVersionRows({
    cliVersion: "0.9.0",
    daemonVersion: "0.8.9",
    updateLatest: null,
    codeStale: {
      running: "0.8.9",
      on_disk: "0.9.0",
      built_at: new Date(REBUILT).toISOString(),
      reason: "rebuilt",
    },
  });
  const rendered = rows.map((r) => r.join(" ")).join("\n");
  assert.match(rendered, /replaced code/);
  assert.match(rendered, /restart/);
  assert.doesNotMatch(rendered, /up to date/, "the update status was computed from a stale version");
});

test("a rebuild at the same version names the build, not the version twice", () => {
  const rows = formatVersionRows({
    cliVersion: "0.9.0",
    daemonVersion: "0.9.0",
    updateLatest: null,
    codeStale: {
      running: "0.9.0",
      on_disk: "0.9.0",
      built_at: new Date(REBUILT).toISOString(),
      reason: "rebuilt",
    },
  });
  const detail = rows[1].join(" ");
  assert.match(detail, /build on disk is newer/);
  assert.doesNotMatch(detail, /0\.9\.0.*0\.9\.0/, "naming the same version twice explains nothing");
});

test("without the finding the panel is exactly as it was", () => {
  assert.deepEqual(
    formatVersionRows({ cliVersion: "0.9.0", daemonVersion: "0.9.0", updateLatest: null }),
    [["version", "0.9.0  ✓ up to date"]],
  );
  assert.deepEqual(
    formatVersionRows({ cliVersion: "0.9.0", daemonVersion: "0.9.0", updateLatest: null, codeStale: null }),
    [["version", "0.9.0  ✓ up to date"]],
  );
});
