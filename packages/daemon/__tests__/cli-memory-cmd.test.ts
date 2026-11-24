/**
 * #1492 — `bastra recall "<question>"` and `bastra save` run through the
 * daemon's own /api/v1 recall and save_memory paths, and a save typed in the
 * terminal is recorded as the user's instruction (write_origin: user-directed).
 */
import { test, type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
// A credential the save path redacts (built in parts so no scanner flags this file).
const GITHUB_TOKEN = ["gh", "p_", "a1B2c3D4e5F6", "g7H8i9J0k1L2", "m3N4o5P6q7R8"].join("");

const noStdin = { stdin: async () => undefined };

/** Every vault file with its bytes, including audit, locks and any index files. */
async function vaultBytes(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    files.set(relative(root, file), await readFile(file));
  }
  return files;
}

function quiet(t: { mock: { method: (o: object, m: string, f: (...a: unknown[]) => void) => unknown } }) {
  const out: string[] = [];
  t.mock.method(console, "log", (line: unknown) => out.push(String(line)));
  t.mock.method(console, "error", (line: unknown) => out.push(String(line)));
  return out;
}

async function memoryDaemon(t: TestContext) {
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
    search.stop();
    await vault.stop?.();
    resetAuditLogCache();
    await rm(vaultRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { vault, vaultRoot };
}

test("#1492 bastra save writes a user-directed memory through the daemon, bastra recall finds it", async (t) => {
  const { vault, vaultRoot } = await memoryDaemon(t);
  const out = quiet(t);

  // Seed real audit/index state before comparing every existing file byte.
  assert.equal(
    await cmdSave(
      ["save", "--title", "Audit seed", "--type", "reference", "--scope", "household", "Check smoke alarms annually."],
      undefined,
      noStdin
    ),
    0
  );
  out.length = 0;
  const beforePreview = await vaultBytes(vaultRoot);
  // --dry-run: the daemon's preview of the same save; nothing lands in the vault (INV-VAULT-10).
  const preview = ["save", "--title", "Release token note", "--type", "lesson", "--scope", "household"];
  assert.equal(await cmdSave([...preview, "--dry-run", `Export ${GITHUB_TOKEN} first.`], undefined, noStdin), 0);
  const shown = out.join("\n");
  assert.match(shown, /^preview only: nothing was saved$/m);
  assert.match(shown, /id: +release-token-note$/m);
  assert.match(shown, /kind: +note only/m);
  assert.match(shown, /redacted: summary \(1\), body \(1\)$/m);
  assert.ok(!shown.includes(GITHUB_TOKEN), "the preview never echoes the credential");
  const previewFile = /file: +(.+)$/m.exec(shown)?.[1];
  assert.ok(previewFile, shown);
  await assert.rejects(access(previewFile), "the preview writes no file");
  assert.equal(vault.get("release-token-note"), undefined);
  out.length = 0;
  assert.equal(await cmdSave([...preview, "--dry-run", "--json", "Plain text."], undefined, noStdin), 0);
  const raw = JSON.parse(out[0]);
  assert.equal(raw.dry_run, true);
  assert.match(raw.content, /Plain text\./, "--json passes the daemon's preview through, file content included");
  assert.equal(vault.get("release-token-note"), undefined);
  assert.deepEqual(await vaultBytes(vaultRoot), beforePreview, "CLI previews preserve all existing vault bytes");
  out.length = 0;
  assert.equal(
    await cmdSave([...preview, "--dry-run", "--json", `Export ${GITHUB_TOKEN} first.`], undefined, noStdin),
    0
  );
  const redactedPreview = JSON.parse(out[0]);
  assert.deepEqual(await vaultBytes(vaultRoot), beforePreview);
  out.length = 0;
  assert.equal(await cmdSave([...preview, "--json", `Export ${GITHUB_TOKEN} first.`], undefined, noStdin), 0);
  const written = JSON.parse(out[0]);
  const planned = matter(redactedPreview.content);
  const actual = matter(await readFile(written.file_path, "utf8"));
  assert.equal(actual.content, planned.content, "preview and write have the same redacted body");
  // Independent requests carry independent attribution times; all other fields must match.
  delete actual.data.write_origin_evidence.at;
  delete planned.data.write_origin_evidence.at;
  assert.deepEqual(actual.data, planned.data, "preview and write have identical frontmatter");
  out.length = 0;

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
  const beforeRefusal = await vaultBytes(vaultRoot);
  assert.equal(
    await cmdSave(
      [
        "save",
        "--title",
        "Kettle descaling interval",
        "--type",
        "lesson",
        "--scope",
        "household",
        "--dry-run",
        "Again.",
      ],
      undefined,
      noStdin
    ),
    1
  );
  assert.match(out.join("\n"), /already exists/);
  assert.deepEqual(await vaultBytes(vaultRoot), beforeRefusal, "a refused CLI preview preserves every vault byte");
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

test("#1492 recall --load reads the complete Markdown through REST with the usual access checks", async (t) => {
  const { vault, vaultRoot } = await memoryDaemon(t);
  const out = quiet(t);
  const body = [
    "Den Wasserkocher entkalken.",
    "",
    "## Weitere Schritte",
    "- Mit klarem Wasser spülen 💧",
    "",
    "## Auto-Related <!-- bastra:auto-related:start -->",
    "- [[bike-tyre-pressure]]",
    "<!-- bastra:auto-related:end -->",
    "",
  ].join("\n");
  const fm = {
    id: "kettle-note",
    title: "Kettle descaling interval",
    type: "reference",
    scope: "household",
    summary: "Descale the kettle every six weeks.",
    created: "2026-06-01",
    updated: "2026-06-01",
  };
  const publicFile = join(vaultRoot, "kettle-note.md");
  await writeFile(publicFile, matter.stringify(body, fm));
  await vault.reindexFile(publicFile);
  const privateFile = join(vaultRoot, "private-note.md");
  await writeFile(
    privateFile,
    matter.stringify("Body visible only to trusted callers.\n", {
      ...fm,
      id: "private-note",
      title: "Private note",
      sensitivity: "private",
    })
  );
  await vault.reindexFile(privateFile);
  assert.equal(vault.get("private-note")?.fm.sensitivity, "private");
  const beforeLoad = await vaultBytes(vaultRoot);

  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", cli, "recall", "--load", fm.id]);
  assert.equal(stdout, body);
  assert.equal(await cmdRecall(["recall", `--load=${fm.id}`, "--json"]), 0, out.join("\n"));
  const loaded = JSON.parse(out[0]);
  assert.equal(loaded.id, fm.id);
  assert.equal(loaded.body, body);
  assert.equal(loaded.frontmatter.title, fm.title);

  for (const id of ["private-note", "absent-note"]) {
    out.length = 0;
    assert.equal(await cmdRecall(["recall", "--load", id, "--json"]), 1);
    assert.deepEqual(out, [`bastra recall: could not load "${id}" (memory not found)`]);
  }
  assert.deepEqual(await vaultBytes(vaultRoot), beforeLoad);
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
  assert.deepEqual(validateArgs(["recall", "--load", "note-id", "--json"]), []);
  assert.deepEqual(validateArgs(["recall", "--load=note-id"]), []);
  assert.deepEqual(validateArgs(["recall", "--load"]), ["option '--load' needs a value"]);
  assert.deepEqual(validateArgs(["recall", "--load="]), ["option '--load' needs a value"]);
  assert.deepEqual(validateArgs(["save", "--load", "note-id"]), ["option '--load' is not valid for 'bastra save'"]);
  assert.deepEqual(validateArgs(["recall", "q", "--title", "T"]), [
    "option '--title' is not valid for 'bastra recall'",
  ]);
  assert.deepEqual(validateArgs(["save", "--title"]), ["option '--title' needs a value"]);
  assert.deepEqual(validateArgs(["save", "--dry-run=false"]), [
    "option '--dry-run' takes no value — write '--dry-run'",
  ]);
  assert.deepEqual(validateArgs(["save", "--title", "T", "--type", "lesson", "--scope", "s", "--dry-run", "x"]), []);
  assert.deepEqual(validateArgs(["recall", "q", "--dry-run"]), ["option '--dry-run' is not valid for 'bastra recall'"]);
});

test("#1492 recall --load rejects mixed modes and duplicate or empty IDs before contacting the daemon", async (t) => {
  const out = quiet(t);
  const calls: string[] = [];
  const call = async (tool: string) => calls.push(tool);
  for (const args of [["query"], ["--limit", "3"], ["--scope", "home"], ["--type", "lesson"], ["--load=another-id"]]) {
    assert.equal(await cmdRecall(["recall", "--load", "note-id", ...args], call), 2);
  }
  assert.equal(await cmdRecall(["recall", "--load=  "], call), 2);
  assert.deepEqual(calls, []);
  assert.match(out.join("\n"), /bastra recall --load <id>/);
});

test("bastra save --dry-run sends dry_run: true and names a held save as not to be saved", async (t) => {
  const out = quiet(t);
  const inputs: unknown[] = [];
  const call = async (_tool: string, input: unknown) => {
    inputs.push(input);
    return { id: "x", dry_run: true, claim_gate: { claimed: [{ id: "older" }] } };
  };
  const argv = ["save", "--title", "T", "--type", "lesson", "--scope", "s", "--dry-run", "text"];
  assert.equal(await cmdSave(argv, call as never, noStdin), 1);
  assert.equal((inputs[0] as { dry_run?: boolean }).dry_run, true);
  assert.match(out.join("\n"), /would not be saved: another memory already covers this situation/);
});

test("dry-run payload preserves stdin and every optional field, adding only dry_run", async (t) => {
  quiet(t);
  const calls: Record<string, unknown>[] = [];
  const call = async (_tool: string, input: unknown) => {
    calls.push(input as Record<string, unknown>);
    return { id: "x", dry_run: true };
  };
  const argv = [
    "save",
    "--title",
    "T",
    "--type",
    "lesson",
    "--scope",
    "s",
    "--summary",
    "One line",
    "--recall-when",
    "first",
    "--recall-when",
    "second",
    "--tag",
    "tag",
    "--topic",
    "p/q",
    "--json",
  ];
  const io = { stdin: async () => "Piped\r\nbody" };
  assert.equal(await cmdSave(argv, call as never, io), 0);
  assert.equal(await cmdSave([...argv, "--dry-run"], call as never, io), 0);
  assert.deepEqual(calls[1], { ...calls[0], dry_run: true });
  assert.equal(Object.hasOwn(calls[0], "dry_run"), false);
});

for (const schema of ["missing-endpoint", "missing-field", "wrong-type", "invalid-json", "confirmed"] as const) {
  test(`dry-run checks daemon schema before a potentially writing POST: ${schema}`, async (t) => {
    const out = quiet(t);
    const requests: string[] = [];
    const legacyWrites: string[] = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && req.url === "/tools?surface=write") {
        res.statusCode = schema === "missing-endpoint" ? 404 : 200;
        const properties =
          schema === "missing-field" ? {} : { dry_run: { type: schema === "wrong-type" ? "string" : "boolean" } };
        res.end(
          schema === "invalid-json"
            ? "{"
            : JSON.stringify({ tools: [{ name: "save_memory", inputSchema: { properties } }] })
        );
        return;
      }
      let text = "";
      req.on("data", (chunk) => (text += chunk));
      req.on("end", () => {
        // Older handler ignores unknown fields; confirmed-but-malformed response is caught too.
        legacyWrites.push(text);
        res.end(JSON.stringify({ id: "legacy-save", created: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const oldUrl = process.env.BASTRA_DAEMON_URL;
    process.env.BASTRA_DAEMON_URL = `http://127.0.0.1:${address.port}`;
    t.after(async () => {
      if (oldUrl === undefined) delete process.env.BASTRA_DAEMON_URL;
      else process.env.BASTRA_DAEMON_URL = oldUrl;
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    });
    assert.equal(
      await cmdSave(
        ["save", "--title", "T", "--type", "lesson", "--scope", "s", "--dry-run", "text"],
        undefined,
        noStdin
      ),
      1
    );
    assert.equal(requests[0], "GET /tools?surface=write");
    assert.equal(
      legacyWrites.length,
      schema === "confirmed" ? 1 : 0,
      "unconfirmed schema must never dispatch save_memory"
    );
    if (schema === "confirmed") assert.match(out.join("\n"), /may have saved/);
    else assert.match(out.join("\n"), /nothing was sent to save_memory/);
    assert.doesNotMatch(out.join("\n"), /nothing was saved|^saved /m);
  });
}
