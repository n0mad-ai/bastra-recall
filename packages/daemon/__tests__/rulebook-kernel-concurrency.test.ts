import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGateLane } from "../src/gate-lane.js";
import { mutateSessionState, loadSessionState } from "../src/session-state.js";
import { countAndExpireDelivery, KERNEL_DELIVERY } from "../src/gate-lane-claims.js";
import { kernelWorker } from "../src/rule-kernel-seen.js";
import { createServer } from "node:http";
import { once } from "node:events";
import { dispatchLaneRoutes } from "../src/http-lane-routes.js";
let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "kernel-concurrency-"));
  process.env.BASTRA_HOOK_STATE_DIR = join(root, "state");
  process.env.BASTRA_TELEMETRY = "off";
});
after(() => rm(root, { recursive: true, force: true }));
const catalog = {
  entries: [
    {
      id: "fixture-rule",
      title: "Fixture",
      group: "explicit",
      revision: "r",
      updated: null,
      stale_status: "unknown",
      body: "",
      rulebook: "on-demand",
      applies_when: "Fixture",
    },
  ],
  omitted: 0,
} as any;
const p = (session_id: string) => ({
  session_id,
  bastra_client: "claude-code",
  hook_event_name: "PreToolUse",
  tool_name: "Read",
  tool_input: {},
});
test("fix5: one periodic delivery claim leaves the other parallel calls counted", async () => {
  const sid = "parallel-kernel";
  await mutateSessionState(sid, (s) => {
    s.toolCalls = 24;
  });
  const out = await Promise.all(
    Array.from({ length: 4 }, () => runGateLane(p(sid), { reflexPool: () => [], kernel: async () => catalog }))
  );
  assert.equal(out.filter((o) => o.includes("<rule-kernel")).length, 1);
  assert.equal((await loadSessionState(sid)).toolCalls, 3);
});

test("#1623: an expired worker reservation returns calls to its owner", async () => {
  const owner = kernelWorker({ agent_id: "expired-owner" })!;
  const other = kernelWorker({ agent_id: "other-worker" })!;
  const state = {
    shown: {},
    toolCalls: 7,
    agentToolCalls: { [owner]: 2, [other]: 3 },
    constants: { [KERNEL_DELIVERY]: JSON.stringify({ agent: owner, calls: 25, deadline: 0 }) },
  };
  assert.equal(countAndExpireDelivery(state, true, { agent_id: "other-worker" }).inFlight, null);
  assert.equal(state.agentToolCalls[owner], 27);
  assert.equal(state.agentToolCalls[other], 4);
  assert.equal(state.toolCalls, 7);
});

test("#1623: HTTP repeats the full kernel for a worker after each cadence", async (t) => {
  const payload = { ...p("http-worker-full-kernel"), agent_id: "http-worker" };
  const worker = kernelWorker(payload)!;
  const server = createServer((req, res) => {
    dispatchLaneRoutes(
      req,
      res,
      "POST",
      "/hook/gate",
      undefined,
      undefined,
      undefined,
      () => [],
      async () => catalog
    );
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  for (let i = 0; i < 2; i++) {
    await mutateSessionState(payload.session_id, (state) => {
      state.agentToolCalls = { [worker]: 24 };
    });
    const response = await fetch(`http://127.0.0.1:${address.port}/hook/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload }),
    });
    const body = await response.text();
    assert.match(body, /Rule index/);
    assert.doesNotMatch(body, /unchanged=/);
    await mutateSessionState(payload.session_id, () => {});
  }
});

test("#1623: a failed worker delivery restores its count, then retries in full", async (t) => {
  const sid = "worker-kernel-failure";
  const payload = { ...p(sid), agent_id: "failed-worker" };
  const worker = kernelWorker(payload)!;
  await mutateSessionState(sid, (s) => {
    s.toolCalls = 7;
    s.agentToolCalls = { [worker]: 24 };
  });
  assert.equal(
    await runGateLane(payload, {
      reflexPool: () => [],
      kernel: async () => {
        throw Error("fixture outage");
      },
    }),
    "{}"
  );
  const state = await loadSessionState(sid);
  assert.equal(state.agentToolCalls?.[worker], 25);
  assert.equal(state.toolCalls, 7);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 5100);
  assert.match(await runGateLane(payload, { reflexPool: () => [], kernel: async () => catalog }), /Rule index/);
});

test("#1623: a shared reservation keeps another due worker counted until its full delivery", async () => {
  const sid = "worker-kernel-parallel";
  const owner = { ...p(sid), agent_id: "owner" };
  const other = { ...p(sid), agent_id: "waiting" };
  const ownerKey = kernelWorker(owner)!;
  const otherKey = kernelWorker(other)!;
  await mutateSessionState(sid, (s) => {
    s.agentToolCalls = { [ownerKey]: 24, [otherKey]: 24 };
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = runGateLane(owner, {
    reflexPool: () => [],
    kernel: async () => {
      entered();
      await ready;
      return catalog;
    },
  });
  await started;
  try {
    assert.equal(await runGateLane(other, { reflexPool: () => [], kernel: async () => catalog }), "{}");
    assert.equal((await loadSessionState(sid)).agentToolCalls?.[otherKey], 25);
  } finally {
    release();
  }
  assert.match(await first, /Rule index/);
  assert.match(await runGateLane(other, { reflexPool: () => [], kernel: async () => catalog }), /Rule index/);
  assert.equal((await loadSessionState(sid)).agentToolCalls?.[otherKey], 0);
});
test("fix5: failed periodic catalog backs off rather than delaying every read", async (t) => {
  const sid = "kernel-backoff";
  await mutateSessionState(sid, (s) => {
    s.toolCalls = 24;
  });
  let scans = 0;
  const deps = {
    reflexPool: () => [],
    kernel: async () => {
      scans++;
      throw Error("fixture outage");
    },
  };
  for (let i = 0; i < 4; i++) assert.equal(await runGateLane(p(sid), deps), "{}");
  assert.equal(scans, 1);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 5100);
  assert.match(await runGateLane(p(sid), { ...deps, kernel: async () => catalog }), /rule-kernel/);
});

test("fix5: asynchronous C rollback after a legacy overrun is observed by polling", async (t) => {
  const sid = "overrun-async",
    { rulebookBoundary } = await import("../src/rulebook-check.js");
  // Advance the deadline in the callback rather than burning CPU for 560 ms.
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const write = { ...p(sid), tool_name: "Write" };
  for (let i = 0; i < 3; i++) {
    assert.equal(
      await runGateLane(write, {
        reflexPool: () => [],
        kernel: async () => catalog,
        actionMustLoad: {
          key: "fixture-overrun",
          ids: ["fixture-hint"],
          onClaim: () => {
            now += 560;
          },
        },
      }),
      "{}"
    );
    let restored = false;
    for (let n = 0; n < 80; n++) {
      const s = await loadSessionState(sid),
        a = JSON.parse(s.rulebookCheck ?? "{}").actors?.find((a: any) => a.key === "main");
      if (a?.denies === 0) {
        restored = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(restored, true);
  }
  assert.match((await rulebookBoundary(write, catalog, "action")) ?? "", /deny/);
});
