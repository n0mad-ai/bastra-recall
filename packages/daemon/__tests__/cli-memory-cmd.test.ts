/**
 * #1492 — `bastra recall "<question>"` and `bastra save` run through the
 * daemon's own /api/v1 recall and save_memory paths, and a save typed in the
 * terminal is recorded as the user's instruction (write_origin: user-directed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import matter from "gray-matter";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { resetAuditLogCache } from "../src/audit-trail.js";
import { startHttpServer } from "../src/http.js";
import { cmdRecall, cmdSave } from "../src/cli/memory-cmd.js";
import { validateArgs } from "../src/cli/flag-spec.js";
import type { ToolDeps } from "../src/tool-deps.js";
import { DAEMON_VERSION } from "../src/version.js";

process.env.BASTRA_API_TOKEN = "test-token-1492-abcdef0123456789";

const noStdin = { stdin: async () => undefined };

function quiet(t: { mock: { method: (o: object, m: string, f: (...a: unknown[]) => void) => unknown } }) {
  const out: string[] = [];
  t.mock.method(console, "log", (line: unknown) => out.push(String(line)));
  t.mock.method(console, "error", (line: unknown) => out.push(String(line)));
  return out;
}

test("#1492 bastra save writes a user-directed memory through the daemon, bastra recall finds it", async (t) => {
  resetAuditLogCache();
  const vaultRoot = await mkdtemp(join(tmpdir(), "bastra-1492-"));
  const vault = new Vault(vaultRoot);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: vaultRoot };
  const handle = await startHttpServer({
    port: 0,
    vault,
    search: deps.search,
    telemetry: deps.telemetry,
    version: "test-version",
    toolDeps: deps,
    documentWriteEnabled: false,
    onActivity: () => {},
    embedding: { on: false, providerId: null, source: "none" },
    origin: { startedBy: "direct", envOrigin: "own", configFingerprint: "0123456789ab" },
  });
  const previousUrl = process.env.BASTRA_DAEMON_URL;
  process.env.BASTRA_DAEMON_URL = `http://127.0.0.1:${handle.port}`;
  t.after(async () => {
    if (previousUrl === undefined) delete process.env.BASTRA_DAEMON_URL;
    else process.env.BASTRA_DAEMON_URL = previousUrl;
    await handle.close();
    await vault.stop?.();
    resetAuditLogCache();
    await rm(vaultRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const out = quiet(t);

  const code = await cmdSave(
    [
      "save",
      "--title",
      "Kettle descaling interval",
      "--type",
      "lesson",
      "--scope",
      "household",
      "Descale",
      "the",
      "kettle",
      "every",
      "six",
      "weeks.",
    ],
    undefined,
    noStdin
  );
  assert.equal(code, 0, out.join("\n"));
  const saved = vault.get("kettle-descaling-interval");
  assert.ok(saved, out.join("\n"));
  const fm = matter(await readFile(saved.filePath, "utf8")).data;
  assert.equal(fm.write_origin, "user-directed");
  assert.equal(fm.summary, "Descale the kettle every six weeks.");
  assert.deepEqual(fm.recall_when, ["Kettle descaling interval"]);
  assert.ok(
    out.some((l) => l.startsWith("saved kettle-descaling-interval")),
    out.join("\n")
  );

  // Neighbours give the BM25 terms weight: in a one-memory vault every hit
  // scores below recall's default floor.
  for (const title of ["Bike tyre pressure", "Passport renewal office", "Garden watering days"])
    assert.equal(
      await cmdSave(
        ["save", "--title", title, "--type", "reference", "--scope", "household", title],
        undefined,
        noStdin
      ),
      0
    );
  out.length = 0;
  assert.equal(await cmdRecall(["recall", "kettle", "descaling"]), 0, out.join("\n"));
  assert.ok(
    out.some((l) => l.startsWith("kettle-descaling-interval")),
    out.join("\n")
  );
  assert.ok(
    out.some((l) => l.includes("Descale the kettle every six weeks.")),
    out.join("\n")
  );

  out.length = 0;
  assert.equal(
    await cmdSave(
      ["save", "--title", "Kettle descaling interval", "--type", "lesson", "--scope", "household", "Again."],
      undefined,
      noStdin
    ),
    1,
    "an existing memory with the same title is not overwritten"
  );
  assert.match(out.join("\n"), /already exists/);

  // A pipe can split a multibyte character between stream chunks. Assert
  // that the normal stdin path preserves the character in the stored file.
  const text = "A note about 🐈.";
  const bytes = Buffer.from(text);
  const split = bytes.indexOf(Buffer.from("🐈")) + 2;
  const stdin = Readable.from(
    (async function* () {
      yield bytes.subarray(0, split);
      await setImmediate();
      yield bytes.subarray(split);
    })(),
    { objectMode: false }
  );
  t.mock.getter(process, "stdin", () => stdin);
  out.length = 0;
  assert.equal(
    await cmdSave(["save", "--title", "Cat note", "--type", "reference", "--scope", "household", "--json"]),
    0
  );
  const piped = vault.get("cat-note");
  assert.ok(piped);
  const stored = matter(await readFile(piped.filePath, "utf8"));
  assert.equal(stored.content.trim(), text);
  const evidence = JSON.parse(out[0]).write_origin_evidence;
  assert.deepEqual(stored.data.write_origin_evidence, evidence);
  assert.equal(evidence.transport, "http");
  assert.equal(evidence.client, `bastra-cli/${DAEMON_VERSION}`);
  assert.equal(evidence.session, null);
  assert.ok(Number.isFinite(Date.parse(evidence.at)));
});

test("#1492 bastra save: piped text and the optional fields reach save_memory as given", async (t) => {
  quiet(t);
  const calls: [string, unknown][] = [];
  const call = async (tool: string, input: unknown) => {
    calls.push([tool, input]);
    return { id: "x", file_path: "/v/x.md", created: true };
  };
  const code = await cmdSave(
    [
      "save",
      "--title=T",
      "--type",
      "decision",
      "--scope",
      "s",
      "--summary",
      "One line.",
      "--recall-when",
      "first",
      "--recall-when",
      "second",
      "--tag",
      "a",
      "--topic",
      "p/q",
      "--json",
    ],
    call as never,
    { stdin: async () => "piped\r\ntext\n" }
  );
  assert.equal(code, 0);
  assert.deepEqual(calls, [
    [
      "save_memory",
      {
        title: "T",
        type: "decision",
        scope: "s",
        body: "piped\ntext",
        summary: "One line.",
        topic_path: ["p", "q"],
        tags: ["a"],
        recall_when: ["first", "second"],
        write_origin: "user-directed",
      },
    ],
  ]);
});

test("#1492 bastra save: a save held at the claim gate is reported and exits 1", async (t) => {
  const out = quiet(t);
  const call = async () => ({
    id: "x",
    created: false,
    claim_gate: { claimed: [{ id: "older", title: "Older one" }] },
  });
  assert.equal(
    await cmdSave(["save", "--title", "T", "--type", "lesson", "--scope", "s", "text"], call as never, noStdin),
    1
  );
  assert.ok(
    out.some((l) => l.includes("older") && l.includes("Older one")),
    out.join("\n")
  );
});

test("#1492 usage errors exit 2 and never call the daemon", async (t) => {
  quiet(t);
  const call = async () => assert.fail("must not call the daemon");
  assert.equal(await cmdSave(["save", "--type", "lesson", "--scope", "s", "text"], call as never, noStdin), 2);
  assert.equal(
    await cmdSave(["save", "--title", "T", "--type", "doc", "--scope", "s", "text"], call as never, noStdin),
    2
  );
  assert.equal(await cmdSave(["save", "--title", "T", "--type", "lesson", "--scope", "s"], call as never, noStdin), 2);
  assert.equal(
    await cmdSave(
      ["save", "--title", "A", "--title", "B", "--type", "lesson", "--scope", "s", "x"],
      call as never,
      noStdin
    ),
    2
  );
  assert.equal(await cmdRecall(["recall"], call as never), 2);
  assert.equal(await cmdRecall(["recall", "q", "--limit", "0"], call as never), 2);
});

test("#1492 the options are validated per command before dispatch", () => {
  assert.deepEqual(
    validateArgs(["save", "--title", "T", "--type", "lesson", "--scope", "s", "--recall-when", "w", "x"]),
    []
  );
  assert.deepEqual(validateArgs(["recall", "q", "--limit", "3", "--json"]), []);
  assert.deepEqual(validateArgs(["recall", "q", "--title", "T"]), [
    "option '--title' is not valid for 'bastra recall'",
  ]);
  assert.deepEqual(validateArgs(["save", "--title"]), ["option '--title' needs a value"]);
});
