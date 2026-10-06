/**
 * The save notice: after save_memory / edit_memory (and the two document
 * tools) Recall prints ONE line that says what was written. Claude Code shows
 * the call itself collapsed to "Called bastra-recall", so without the line the
 * user never learns what was saved.
 *
 * Pinned here:
 *   - only the write tools get a line, under the plain and the plugin-scoped
 *     server name; the reading tools never do;
 *   - a refused call gets none, and the two results that succeed as calls but
 *     wrote no new memory (claim gate, conflict mark) do not say "saved";
 *   - the line is one line in the user's language whatever the title holds;
 *   - the registration reuses the post-tool client, and the daemon route tells
 *     a Recall write tool from Bash.
 *
 * The payload shapes are the ones Claude Code 2.1.291 sent in a live run:
 * `tool_response` is the MCP content-block array with the result as JSON
 * text; a refused call arrives as PostToolUseFailure with `error` instead.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/save-notice-lane.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SAVE_NOTICE_MATCHER,
  readToolResult,
  recallWriteTool,
  runSaveNoticeLane,
  type EntryLookup,
  type SaveNoticePayload,
} from "../src/save-notice-lane.js";
import { formatSaveNotice } from "../src/save-notice.js";
import { hookDefinitions } from "../src/cli/adapters/claude-code.js";
import { dispatchLocalRoutes, type LocalRouteCtx } from "../src/http-local-routes.js";

const SERVER = "mcp__bastra-recall__";
const ID = "staging-deploy-braucht-vpn";

/** What the user reads: the line without its colour sequences. */
const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

/** `tool_response` as Claude Code hands an MCP result to a hook. */
const blocks = (result: unknown): unknown => [{ type: "text", text: JSON.stringify(result, null, 2) }];

const VAULT: EntryLookup = (id) =>
  ({
    [ID]: { title: "Staging-Deploy braucht VPN", type: "lesson" },
    "older-vpn-rule": { title: "VPN vor jedem Deploy", type: "preference" },
  })[id];

async function withSandbox<T>(
  settings: Record<string, unknown>,
  extraEnv: Record<string, string>,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-save-notice-"));
  await mkdir(join(dir, ".bastra"), { recursive: true });
  await writeFile(join(dir, ".bastra", "cli-settings.json"), JSON.stringify(settings));
  const env: Record<string, string> = {
    BASTRA_TELEMETRY: "on",
    BASTRA_LOG_PATH: join(dir, "logs"),
    // The lane reads language.primary from ~/.bastra/cli-settings.json — keep
    // the developer's own settings out.
    HOME: dir,
    USERPROFILE: dir,
    ...extraEnv,
  };
  const before = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn(dir);
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

const german = <T>(fn: (dir: string) => Promise<T>, env: Record<string, string> = {}): Promise<T> =>
  withSandbox({ language: { primary: "de" } }, env, fn);

async function notice(payload: Partial<SaveNoticePayload>): Promise<string | undefined> {
  const out = await runSaveNoticeLane(
    { hook_event_name: "PostToolUse", bastra_client: "claude-code", session_id: "save-notice-test", ...payload },
    VAULT,
  );
  const line = (JSON.parse(out) as { systemMessage?: string }).systemMessage;
  return line === undefined ? undefined : plain(line);
}

const SAVE_INPUT = {
  title: "Staging-Deploy braucht VPN",
  type: "lesson",
  recall_when: ["Staging-Deploy bricht mit Timeout ab", "Push hängt"],
};

test("only Recall's write tools are announced — under the plain and the plugin-scoped server name", () => {
  for (const tool of ["save_memory", "edit_memory", "save_document", "save_product_doc"]) {
    assert.equal(recallWriteTool(`${SERVER}${tool}`), tool);
    assert.equal(recallWriteTool(`mcp__plugin_bastra-recall_bastra-recall__${tool}`), tool);
  }
  for (const name of [
    `${SERVER}recall`,
    `${SERVER}load_memory`,
    `${SERVER}find_document`,
    `${SERVER}find_code`,
    `${SERVER}find_affected_files`,
    `${SERVER}read_document`,
    "mcp__memory__save_memory",
    `${SERVER}save_memory_extra`,
    "Bash",
    undefined,
  ]) {
    assert.equal(recallWriteTool(name), null, String(name));
  }
});

test("the registration: PostToolUse only, the lane's own pattern, on the post-tool client", () => {
  const defs = hookDefinitions().filter((d) => d.matcher === SAVE_NOTICE_MATCHER);
  assert.deepEqual(defs.map((d) => d.event), ["PostToolUse"]);
  assert.equal(defs[0].stubSubcommand, "bash-fail");
  // Claude Code reads a matcher as a regular expression only when it holds a
  // character outside this set; otherwise it would be compared as a literal
  // tool name and never fire.
  assert.match(SAVE_NOTICE_MATCHER, /[^A-Za-z0-9_\-, |]/);
});

test("a new memory: action, title, type and the first cue — in the user's language", async () => {
  await german(async () => {
    const line = await notice({
      tool_name: `${SERVER}save_memory`,
      tool_input: SAVE_INPUT,
      tool_response: blocks({ id: ID, file_path: "/v/x.md", created: true, save_quality: { score: 92 } }),
    });
    assert.equal(
      line,
      " bastra-recall  gespeichert: „Staging-Deploy braucht VPN“ (lesson) · Abruf bei: Staging-Deploy bricht mit Timeout ab",
    );
  });
});

test("an overwrite says updated, not saved", async () => {
  await german(async () => {
    const line = await notice({
      tool_name: `${SERVER}save_memory`,
      tool_input: { ...SAVE_INPUT, overwrite: true },
      tool_response: blocks({ id: ID, created: false }),
    });
    assert.match(line ?? "", /^ bastra-recall  aktualisiert: „Staging-Deploy braucht VPN“ \(lesson\)/);
  });
});

test("an edit carries no title — it comes from the vault, with what the edit changed", async () => {
  await german(async () => {
    const line = await notice({
      tool_name: `${SERVER}edit_memory`,
      tool_input: { id: ID, str_replace: { old: "a", new: "b" }, append: "more", frontmatter: { tags: ["x"], recall_when: ["y"] } },
      tool_response: blocks({ id: ID, created: false, operations: ["str_replace", "append", "frontmatter"] }),
    });
    assert.equal(
      line,
      " bastra-recall  bearbeitet: „Staging-Deploy braucht VPN“ (lesson) · Passage ersetzt, Text angehängt, Felder: tags, recall_when",
    );
  });
});

test("the document tools ride the same path", async () => {
  await german(async () => {
    const doc = await notice({
      tool_name: `${SERVER}save_document`,
      tool_input: { title: "Mietvertrag 2026", category: "vertrag" },
      tool_response: blocks({ id: "mietvertrag-2026", sidecar_path: "/v/m.md", reindexed: true }),
    });
    assert.equal(doc, " bastra-recall  gespeichert: „Mietvertrag 2026“");
    const productDoc = await notice({
      tool_name: `${SERVER}save_product_doc`,
      tool_input: { project: "recall", area: "hooks", title: "Hooks" },
      tool_response: blocks({ id: "doku-recall-hooks", created: false, updated: true }),
    });
    assert.equal(productDoc, " bastra-recall  aktualisiert: „Hooks“");
  });
});

test("a refused call gets no line", async () => {
  await german(async () => {
    const refused: Array<Partial<SaveNoticePayload> & Record<string, unknown>> = [
      // What Claude Code sends for an `isError` result: its own event, no response.
      { hook_event_name: "PostToolUseFailure", error: `memory already exists: ${ID}` },
      // The same refusal, should a client deliver it as a result after all.
      { tool_response: [{ type: "text", text: `memory already exists: ${ID}` }] },
      { tool_response: { isError: true, content: blocks({ id: ID, created: true }) } },
      { tool_response: undefined },
      { tool_response: "null" },
    ];
    for (const payload of refused) {
      const out = await runSaveNoticeLane(
        { hook_event_name: "PostToolUse", bastra_client: "claude-code", tool_name: `${SERVER}save_memory`, tool_input: SAVE_INPUT, ...payload },
        VAULT,
      );
      assert.equal(out, "{}", JSON.stringify(payload));
    }
  });
});

test("a call that succeeded without writing a new memory does not say saved", async () => {
  await german(async () => {
    // #360: the claim gate answers with a normal result — nothing was written.
    const held = await notice({
      tool_name: `${SERVER}save_memory`,
      tool_input: { ...SAVE_INPUT, title: "VPN beim Deploy" },
      tool_response: blocks({ id: "vpn-beim-deploy", created: false, claim_gate: { claimed: [{ id: "older-vpn-rule" }] }, note: "NOTHING WAS SAVED." }),
    });
    assert.equal(held, " bastra-recall  nicht gespeichert, schon abgedeckt: „VPN beim Deploy“ (lesson) · siehe: VPN vor jedem Deploy");
    // #205: the result's id names the EXISTING memory the conflict was marked on.
    const conflict = await notice({
      tool_name: `${SERVER}save_memory`,
      tool_input: { ...SAVE_INPUT, title: "Deploy geht auch ohne VPN", conflict_with: "older-vpn-rule" },
      tool_response: blocks({ id: "older-vpn-rule", created: false, conflict_marked: true }),
    });
    assert.equal(conflict, " bastra-recall  Widerspruch vermerkt an: „VPN vor jedem Deploy“ (preference)");
  });
});

test("Codex and the off switch stay silent", async () => {
  const payload = {
    tool_name: `${SERVER}save_memory`,
    tool_input: SAVE_INPUT,
    tool_response: blocks({ id: ID, created: true }),
  };
  await german(async () => assert.equal(await notice({ ...payload, bastra_client: "codex" }), undefined));
  for (const off of ["0", "off", "false", "no"]) {
    await german(async () => assert.equal(await notice(payload), undefined, off), { BASTRA_SAVE_NOTICE: off });
  }
});

test("wording follows language.primary; an unlisted or unset language gets English", async () => {
  const saved = { action: "created", title: "T", type: "lesson" } as const;
  assert.equal(plain(formatSaveNotice(saved, "ru")), " bastra-recall  сохранено: «T» (lesson)");
  assert.equal(plain(formatSaveNotice(saved, "en")), " bastra-recall  saved: “T” (lesson)");
  assert.equal(plain(formatSaveNotice(saved, "pt")), plain(formatSaveNotice(saved, "en")));
  assert.equal(plain(formatSaveNotice(saved, undefined)), plain(formatSaveNotice(saved, "en")));
});

test("always one line: long titles are clipped, an oversized detail is dropped, control characters go", () => {
  const long = formatSaveNotice({ action: "created", title: "Wort ".repeat(40), type: "lesson", detail: "x".repeat(200) }, "de");
  assert.ok([...plain(long)].length <= 130, `${[...plain(long)].length} chars`);
  assert.match(plain(long), /…“ \(lesson\)/);

  const tight = formatSaveNotice({ action: "held", title: "T".repeat(60), type: "project-fact", detail: "d".repeat(60) }, "de");
  assert.doesNotMatch(plain(tight), /·/, "the detail goes before the line grows past its width");

  const hostile = formatSaveNotice({ action: "created", title: "a\nb\x1b[31mc\u2028d\u202Ee" }, "en");
  assert.doesNotMatch(plain(hostile), /[\n\r\x1b\u2028\u202E]/);
  // The only escape sequences in the line are its own badge.
  assert.equal(hostile.match(/\x1b\[[0-9;]*m/g)?.length, 4);
  assert.match(hostile, /^\x1b\[48;2;124;58;237m\x1b\[38;2;255;255;255m\x1b\[1m bastra-recall \x1b\[0m /);
});

test("readToolResult takes the result out of every shape a client may hand over", () => {
  const result = { id: ID, created: true };
  assert.deepEqual(readToolResult(blocks(result)), result);
  assert.deepEqual(readToolResult(JSON.stringify(result)), result);
  assert.deepEqual(readToolResult(result), result);
  assert.deepEqual(readToolResult({ content: blocks(result) }), result);
  // A session-context item rides behind the result in the same array.
  assert.deepEqual(readToolResult([...(blocks(result) as unknown[]), { type: "text", text: "<session-context>…" }]), result);
  assert.equal(readToolResult([{ type: "text", text: "not json" }]), null);
  assert.equal(readToolResult({ created: true }), null);
});

test("telemetry: one save_notice_call row per write-tool call, without the title", async () => {
  await german(async (dir) => {
    await notice({
      tool_name: `${SERVER}save_memory`,
      tool_input: SAVE_INPUT,
      tool_response: blocks({ id: ID, created: true }),
    });
    await runSaveNoticeLane(
      { hook_event_name: "PostToolUse", bastra_client: "claude-code", tool_name: `${SERVER}edit_memory`, tool_response: "boom" },
      VAULT,
    );
    const logDir = join(dir, "logs");
    const rows: Array<Record<string, unknown>> = [];
    for (const f of await readdir(logDir)) {
      for (const l of (await readFile(join(logDir, f), "utf8")).split("\n")) if (l.trim()) rows.push(JSON.parse(l));
    }
    const calls = rows.filter((r) => r.kind === "save_notice_call");
    assert.deepEqual(
      calls.map((r) => [r.tool, r.action, r.shown]),
      [["save_memory", "created", true], ["edit_memory", null, false]],
    );
    assert.equal(calls[0].session_id, "save-notice-test");
    assert.deepEqual(
      [(calls[0].dimensions as Record<string, unknown>).client, (calls[0].dimensions as Record<string, unknown>).hook_source],
      ["claude-code", "save-notice"],
    );
    assert.doesNotMatch(JSON.stringify(calls), /VPN/);
  });
});

test("the post-tool route hands a Recall write tool to this lane, title looked up in the vault", async () => {
  await german(async () => {
    const ctx = {
      vault: { get: (id: string) => (VAULT(id) ? { fm: VAULT(id) } : undefined) },
      toolDeps: {},
    } as unknown as LocalRouteCtx;
    const server: Server = createServer((req, res) => {
      if (dispatchLocalRoutes(req, res, req.method ?? "GET", req.url ?? "", Date.now(), ctx)) return;
      res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const body = await new Promise<string>((ok, ko) => {
        const req = request(
          { method: "POST", hostname: "127.0.0.1", port, path: "/hook/bash-fail", headers: { "Content-Type": "application/json" } },
          (res) => {
            let data = "";
            res.on("data", (c: Buffer) => (data += c.toString()));
            res.on("end", () => ok(data));
          },
        );
        req.on("error", ko);
        req.end(
          JSON.stringify({
            payload: {
              hook_event_name: "PostToolUse",
              bastra_client: "claude-code",
              tool_name: `${SERVER}edit_memory`,
              tool_input: { id: ID, append: "x" },
              tool_response: blocks({ id: ID, created: false }),
            },
          }),
        );
      });
      assert.equal(
        plain((JSON.parse(body) as { systemMessage: string }).systemMessage),
        " bastra-recall  bearbeitet: „Staging-Deploy braucht VPN“ (lesson) · Text angehängt",
      );
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });
});
