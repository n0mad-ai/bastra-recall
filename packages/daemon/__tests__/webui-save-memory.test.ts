/**
 * POST /ui/save-memory (#1445) — "Save as memory" under an answer in the v22
 * agent window. The route only feeds the normal save_memory path: exactly one
 * memory per confirmed preview, `write_origin: user-directed`, findable by
 * recall at once. Held or refused saves come back as a clear 409 naming the
 * existing memory, and nothing is written. Real temporary vault, no mocking.
 *
 * Runner: `node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/webui-save-memory.test.ts`
 */
import { createServer } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { handleUiSaveMemory, summaryFrom, UI_SAVE_TYPES } from "../src/webui-save-memory.js";
import { resetSaveFailures, saveMemoryHandler, type ToolDeps } from "../src/tool-handlers.js";
import { MAX_BODY_BYTES } from "../src/http-util.js";
import { Telemetry } from "../src/telemetry.js";

type Post = (body: string) => Promise<{ status: number; json: Record<string, any> }>;

async function seed(vaultPath: string, id: string, extra: string[] = []): Promise<void> {
  const dir = join(vaultPath, "memories", "projects", "seeded");
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString();
  await writeFile(
    join(dir, `${id}.md`),
    [
      "---",
      `id: ${id}`,
      `title: Title of ${id}`,
      "type: reference",
      `summary: Summary of ${id}`,
      "topic_path:",
      "  - seeded",
      "tags:",
      "  - seeded",
      "scope: seeded",
      "recall_when:",
      `  - ${id}`,
      ...extra,
      `created: ${ts}`,
      `updated: ${ts}`,
      "---",
      "",
      `Body of ${id}.`,
      "",
    ].join("\n")
  );
}

async function withRoute(
  run: (post: Post, ctx: { deps: ToolDeps; vaultPath: string }) => Promise<void>,
  opts: { uiEnabled?: boolean; seedPrivate?: boolean } = {}
): Promise<void> {
  const vaultPath = await mkdtemp(join(tmpdir(), "bastra-ui-save-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "bastra-ui-save-settings-"));
  const settingsPath = join(settingsDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ ui: { enabled: opts.uiEnabled ?? true } }));
  await seed(vaultPath, "open-source");
  await seed(vaultPath, "private-source", ["sensitivity: private"]);
  const vault = new Vault(vaultPath);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  resetSaveFailures();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath };
  const server = createServer((req, res) => void handleUiSaveMemory(req, res, deps, settingsPath, true));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    await run(
      async (body) => {
        const r = await fetch(`http://127.0.0.1:${port}/ui/save-memory`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        return { status: r.status, json: (await r.json()) as Record<string, any> };
      },
      { deps, vaultPath }
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    search.stop();
    await vault.stop?.();
    await rm(vaultPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(settingsDir, { recursive: true, force: true });
  }
}

async function memoryFiles(vaultPath: string): Promise<string[]> {
  const entries = await readdir(join(vaultPath, "memories"), { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);
}

const ANSWER = "## Weekly planning\n\nPlan the week on **Monday** morning:\n\n- review open tasks\n- block focus time";
const draft = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    title: "Weekly planning on Monday",
    type: "reference",
    scope: "planning",
    body: ANSWER,
    sources: ["open-source"],
    ...extra,
  });

test("save-memory: one confirmed preview writes exactly one user-directed memory, found by recall", async () => {
  await withRoute(async (post, { deps, vaultPath }) => {
    const before = await memoryFiles(vaultPath);
    const r = await post(draft());
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.title, "Weekly planning on Monday");
    assert.equal(r.json.type, "reference");
    assert.equal(r.json.scope, "planning");
    assert.equal(r.json.sensitivity, "team", "the normal save default");
    assert.equal(r.json.private_sources, 0);
    assert.equal(typeof r.json.id, "string");

    const after = await memoryFiles(vaultPath);
    assert.equal(after.length, before.length + 1, "exactly one new memory file");

    const m = deps.vault.get(r.json.id);
    assert.ok(m, "indexed at once");
    assert.equal(m.fm.write_origin, "user-directed");
    assert.equal(m.fm.title, "Weekly planning on Monday");
    assert.equal(m.fm.summary, "Weekly planning");
    assert.deepEqual(m.fm.recall_when, ["Weekly planning on Monday"]);
    assert.ok(m.body.includes("- block focus time"), "the full answer markdown is the body");
    const raw = await readFile(m.filePath, "utf8");
    assert.match(raw, /write_origin: user-directed/);

    const hits = deps.search.recall("weekly planning monday", { k: 5 });
    assert.ok(
      hits.some((h) => h.id === r.json.id),
      "recall finds the new memory"
    );
  });
});

test("save-memory: input is validated strictly and nothing invalid is written", async () => {
  await withRoute(async (post, { vaultPath }) => {
    const before = await memoryFiles(vaultPath);
    const bad: Array<[string, number]> = [
      ["{", 400],
      [JSON.stringify([]), 400],
      [draft({ title: "" }), 400],
      [draft({ title: "   " }), 400],
      [draft({ title: 42 }), 400],
      [draft({ title: "x".repeat(201) }), 400],
      [draft({ type: "doc" }), 400],
      [draft({ type: "bookmark" }), 400],
      [draft({ type: "rule" }), 400],
      [draft({ scope: "" }), 400],
      [draft({ scope: "../outside" }), 400],
      [draft({ scope: "a/b" }), 400],
      [draft({ scope: ".hidden" }), 400],
      [draft({ body: " \n " }), 400],
      [draft({ body: null }), 400],
      [draft({ sources: "open-source" }), 400],
      [draft({ sources: [1] }), 400],
      [draft({ sources: Array.from({ length: 21 }, (_, i) => `s${i}`) }), 400],
      [draft({ body: "x".repeat(MAX_BODY_BYTES + 10) }), 413],
    ];
    for (const [body, status] of bad) {
      const r = await post(body);
      assert.equal(r.status, status, `${body.slice(0, 80)} → ${JSON.stringify(r.json)}`);
      assert.equal(typeof r.json.error, "string");
    }
    assert.deepEqual(await memoryFiles(vaultPath), before, "no invalid request wrote anything");
  });
});

test("save-memory: every authored type is accepted, line endings and the title are normalised", async () => {
  await withRoute(async (post, { deps }) => {
    for (const type of UI_SAVE_TYPES) {
      const r = await post(draft({ type, title: `Note of type ${type}`, body: "line one\r\nline two\r\n" }));
      assert.equal(r.status, 200, `${type}: ${JSON.stringify(r.json)}`);
      assert.equal(deps.vault.get(r.json.id)?.fm.type, type);
      assert.equal(deps.vault.get(r.json.id)?.body.includes("\r"), false);
    }
    const spaced = await post(draft({ title: "  A   title\nwith a break  " }));
    assert.equal(spaced.status, 200);
    assert.equal(spaced.json.title, "A title with a break");
  });
});

test("save-memory: an answer from a private source is saved private, never less protected", async () => {
  await withRoute(async (post, { deps }) => {
    const r = await post(draft({ title: "From a private note", sources: ["open-source", "private-source"] }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.sensitivity, "private");
    assert.equal(r.json.private_sources, 1);
    assert.equal(deps.vault.get(r.json.id)?.fm.sensitivity, "private");

    const open = await post(draft({ title: "From open notes only", sources: ["open-source", "no-such-id"] }));
    assert.equal(open.status, 200);
    assert.equal(open.json.sensitivity, "team", "unknown ids are ignored, open sources keep the default");
    assert.equal(open.json.private_sources, 0);

    const none = await post(draft({ title: "Without sources", sources: undefined }));
    assert.equal(none.status, 200);
    assert.equal(none.json.sensitivity, "team");
  });
});

test("save-memory: saving the same answer twice is refused with the existing memory named", async () => {
  await withRoute(async (post, { vaultPath }) => {
    const first = await post(draft());
    assert.equal(first.status, 200);
    const before = await memoryFiles(vaultPath);
    const again = await post(draft());
    assert.equal(again.status, 409, JSON.stringify(again.json));
    assert.equal(again.json.code, "exists");
    assert.deepEqual(again.json.existing, [{ id: first.json.id, title: "Weekly planning on Monday" }]);
    assert.deepEqual(await memoryFiles(vaultPath), before, "no duplicate was written");
  });
});

test("save-memory: a save held by the claim gate names the memory that owns the situation", async () => {
  await withRoute(async (post, { deps, vaultPath }) => {
    await saveMemoryHandler(deps, {
      title: "Release checklist",
      // the gate compares triggers within the same scope and type
      type: "reference",
      summary: "How a release is prepared",
      body: "Run the checks, tag, publish.",
      topic_path: ["release"],
      tags: ["release"],
      scope: "planning",
      recall_when: ["prepare the staging deployment release checklist"],
    });
    const owner = deps.vault.get("release-checklist");
    assert.ok(owner);
    const before = await memoryFiles(vaultPath);
    const r = await post(draft({ title: "Staging deployment", body: "Deploy to staging first." }));
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.code, "held");
    assert.deepEqual(r.json.existing, [{ id: "release-checklist", title: "Release checklist" }]);
    assert.deepEqual(await memoryFiles(vaultPath), before, "nothing was written");
  });
});

test("save-memory: closed while the UI is disabled", async () => {
  await withRoute(
    async (post, { vaultPath }) => {
      const before = await memoryFiles(vaultPath);
      assert.equal((await post(draft())).status, 404);
      assert.deepEqual(await memoryFiles(vaultPath), before);
    },
    { uiEnabled: false }
  );
});

test("summaryFrom: the first line of the answer as plain text, the title as fallback", () => {
  assert.equal(summaryFrom("## Heading\n\nmore", "T"), "Heading");
  assert.equal(summaryFrom("\n\n- **bold** item\n", "T"), "bold item");
  assert.equal(summaryFrom("> quoted   text", "T"), "quoted text");
  assert.equal(summaryFrom("```\n", "Title"), "Title");
  assert.equal(summaryFrom("1. first step", "T"), "first step");
});
