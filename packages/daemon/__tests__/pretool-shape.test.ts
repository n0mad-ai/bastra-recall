/**
 * #621 — PreToolUse as a compact first-touch hint: one candidate, id + title +
 * one rule line under a character ceiling, only on the first delivered hint of
 * a task area per session, with one named exception (binding-anchored) and a
 * rollback to the previous presentation.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/pretool-shape.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PRETOOL_HINT_CHAR_CEILING,
  formatCompactHint,
  isBindingAnchored,
  pretoolAreaKey,
} from "../src/pretool-shape.js";
import { runWriteLane } from "../src/write-lane.js";

test("area key: files in the same area share it, case and depth are folded", () => {
  const root = "/Repo";
  const a = pretoolAreaKey(root, "/Repo/packages/daemon/src/a.ts");
  assert.equal(a, pretoolAreaKey(root, "/Repo/packages/daemon/__tests__/deep/er/b.ts"), "only two segments count");
  assert.equal(a, pretoolAreaKey(root, "/Repo/Packages/Daemon/c.ts"), "case aliases do not open a new area");
  assert.notEqual(a, pretoolAreaKey(root, "/Repo/packages/core/src/a.ts"));
  assert.equal(pretoolAreaKey(root, "/Repo/README.md"), "area:/repo:", "the repo root is one area");
  assert.equal(pretoolAreaKey(root, "/elsewhere/x/y.md"), "area:/elsewhere/x", "outside the repo: the parent directory");
});

test("compact hint: one line, id + title + first sentence, under the ceiling", () => {
  const block = formatCompactHint(
    { id: "m1", title: "Never edit generated files", type: "lesson", summary: "Edit the source and rebuild. More detail follows here.", score: 150 },
    "proj",
    "claude-code",
    "first-touch",
  );
  assert.match(block, /<recall-hints surface="claude-code" trigger="first-touch" project="proj">/);
  assert.match(block, /- m1 \(lesson\): Never edit generated files — Edit the source and rebuild\.\n/);
  assert.doesNotMatch(block, /More detail/);
  assert.equal(block.split("\n").filter((l) => l.startsWith("- ")).length, 1);

  const huge = formatCompactHint(
    { id: "m2", title: "T".repeat(400), type: "lesson", summary: "S".repeat(2000), score: 150 },
    null,
    "claude-code",
    "binding-anchored",
  );
  assert.ok(huge.length <= PRETOOL_HINT_CHAR_CEILING, `ceiling holds (${huge.length})`);
  assert.match(huge, /trigger="binding-anchored"/);
});

test("binding-anchored needs the fused scale, the REQUIRED band and a strong recall_when anchor", () => {
  const h = { id: "x", title: "t", type: "lesson", summary: "s", score: 150, matched_recall_when: true, anchor_strength: "strong" as const };
  assert.equal(isBindingAnchored(h, 100, false), true);
  assert.equal(isBindingAnchored(h, 100, true), false);
  assert.equal(isBindingAnchored({ ...h, score: 80 }, 100, false), false);
  assert.equal(isBindingAnchored({ ...h, anchor_strength: "weak" }, 100, false), false);
  assert.equal(isBindingAnchored({ ...h, matched_recall_when: false }, 100, false), false);
});

// ── integration through the lane ───────────────────────────────────────────

type Hit = Record<string, unknown>;
const hit = (id: string, extra: Hit = {}): Hit => ({
  id, title: `Title ${id}`, type: "lesson", scope: "user-preference", summary: `Rule of ${id}. Detail.`, score: 150, ...extra,
});

async function withDaemon(hitsFor: (n: number) => Hit[], fn: (base: string) => Promise<void>): Promise<void> {
  let n = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if ((req.url ?? "").startsWith("/hook/recall")) {
        res.end(JSON.stringify({ hits: hitsFor(n++), vault_size: 10, latency_ms: 1, recall_id: "r" }));
      } else res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function edit(base: string, sid: string, cwd: string, rel: string): Promise<string> {
  const out = await runWriteLane(
    { hook_event_name: "PreToolUse", tool_name: "Edit", session_id: sid, cwd, tool_input: { file_path: join(cwd, rel), old_string: "a", new_string: "b" } },
    base,
  );
  return (JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "";
}

async function events(logDir: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const f of (await readdir(logDir)).filter((n) => n.endsWith(".jsonl"))) {
    for (const l of (await readFile(join(logDir, f), "utf8")).split("\n")) if (l.trim()) out.push(JSON.parse(l));
  }
  return out.filter((e) => e.kind === "hook_call");
}

test("#621: first touch shows one candidate, repeat edits in the area stay silent, a new area is a new first touch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bastra-pretool-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-pretool-log-"));
  const sid = `pretool-${Date.now()}`;
  try {
    await withEnv({ BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: logDir, BASTRA_HOOK_STATE_DIR: cwd }, async () => {
      await withDaemon(
        (n) => (n === 0 ? [hit("a1"), hit("a2"), hit("a3")] : n === 1 ? [hit("b1"), hit("b2")] : n === 2 ? [hit("c1")] : [hit("d1", { matched_recall_when: true, anchor_strength: "strong" })]),
        async (base) => {
          const first = await edit(base, sid, cwd, "src/lane/one.ts");
          assert.match(first, /trigger="first-touch"/);
          assert.match(first, /- a1 \(lesson\): Title a1 — Rule of a1\./);
          assert.doesNotMatch(first, /a2|a3/, "at most one candidate");

          const repeat = await edit(base, sid, cwd, "src/lane/two.ts");
          assert.equal(repeat, "", "same area, new candidates — still silent");

          const other = await edit(base, sid, cwd, "docs/x.md");
          assert.match(other, /- c1 /, "another area is a first touch of its own");

          const binding = await edit(base, sid, cwd, "src/lane/three.ts");
          assert.match(binding, /trigger="binding-anchored"/, "the named exception rides through a repeat");
          assert.match(binding, /- d1 /);
        },
      );
    });
    const rows = await events(logDir);
    assert.deepEqual(rows.map((r) => r.hint_reason), ["first-touch", "repeat-area", "first-touch", "binding-anchored"]);
    assert.ok(rows.every((r) => r.pretool_shape === "compact"));
    assert.equal(rows[1]!.hint_tokens_est, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  }
});

test("#621: a candidate SessionStart or an earlier edit already delivered is not repeated", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bastra-pretool-dedup-"));
  const sid = `pretool-dedup-${Date.now()}`;
  try {
    await withEnv({ BASTRA_TELEMETRY: "off", BASTRA_HOOK_STATE_DIR: cwd }, async () => {
      await withDaemon(() => [hit("same")], async (base) => {
        assert.match(await edit(base, sid, cwd, "a/x.ts"), /- same /);
        assert.equal(await edit(base, sid, cwd, "b/y.ts"), "", "already delivered in this session — not again, even in a new area");
      });
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("#621 rollback: BASTRA_PRETOOL_SHAPE=legacy restores the full list on every edit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bastra-pretool-legacy-"));
  const sid = `pretool-legacy-${Date.now()}`;
  try {
    await withEnv({ BASTRA_TELEMETRY: "off", BASTRA_HOOK_STATE_DIR: cwd, BASTRA_PRETOOL_SHAPE: "legacy" }, async () => {
      await withDaemon((n) => (n === 0 ? [hit("a1"), hit("a2")] : [hit("b1")]), async (base) => {
        const first = await edit(base, sid, cwd, "src/one.ts");
        assert.match(first, /a1/);
        assert.match(first, /a2/);
        assert.doesNotMatch(first, /trigger="first-touch"/);
        assert.match(await edit(base, sid, cwd, "src/two.ts"), /b1/, "legacy does not gate by area");
      });
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
