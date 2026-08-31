/**
 * Tests für POST /hook/act (#144) — der leichte Act-Signal-Endpoint.
 * Kein Recall, keine Injektion: matcht den Excerpt gegen offene
 * loadedMemories-Episoden, damit shell-getriebene Memory-Anwendungen
 * acted_on schließen können.
 *
 * Runner: tsx --test packages/daemon/__tests__/hook-act.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";

function memoryMarkdown(id: string, title: string): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: lesson",
    `summary: ${title}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: act-test",
    "recall_when:",
    `  - ${title}`,
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    `Body for ${title}.`,
    "",
  ].join("\n");
}

function httpPost(port: number, path: string, payload: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function makeServer(): Promise<{ port: number; telemetry: Telemetry; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-act-test-"));
  await writeFile(join(dir, "m1.md"), memoryMarkdown("m1", "deploy staging lesson"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  // Telemetry resolves its log dir in the constructor. Without a redirect, the two
  // acted-on episodes these tests produce land in the developer's real
  // ~/.bastra/logs as fixture rows ("m1"), where `bastra bridges mint` would later
  // mine them into contributable bridges. Only fill in a dir when the caller has
  // not chosen one — the session-id test below sets BASTRA_LOG_PATH itself and
  // then reads the events back out of it.
  const ownLogDir = process.env.BASTRA_LOG_PATH ? null : await mkdtemp(join(tmpdir(), "bastra-act-logs-"));
  if (ownLogDir) process.env.BASTRA_LOG_PATH = ownLogDir;
  const telemetry = new Telemetry();
  if (ownLogDir) delete process.env.BASTRA_LOG_PATH;
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
  });
  return {
    port: handle.port!,
    telemetry,
    close: async () => {
      search.stop();
      await vault.stop?.();
      await handle.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      if (ownLogDir) await rm(ownLogDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

test("/hook/act without excerpt is a 400", async () => {
  const srv = await makeServer();
  try {
    const res = await httpPost(srv.port, "/hook/act", { tool_name: "Bash", exit_code: 0 });
    assert.equal(res.status, 400);
  } finally {
    await srv.close();
  }
});

test("/hook/act closes an open loaded-memory episode on token overlap", async () => {
  const srv = await makeServer();
  try {
    srv.telemetry.recordLoadedMemory({
      memory_id: "m1",
      distinctive_tokens: ["deploystaging", "portflag"],
      hook_hint: null,
    });
    const res = await httpPost(srv.port, "/hook/act", {
      tool_name: "Bash",
      tool_input_excerpt: "npm run deploystaging -- with portflag enabled",
      exit_code: 0,
    });
    assert.equal(res.status, 200);
    assert.equal((JSON.parse(res.body) as { matched: number }).matched, 1);
  } finally {
    await srv.close();
  }
});

test("/hook/act miss leaves the episode OPEN — a later matching act still closes it", async () => {
  // The act-signal fires on every Bash command; an unrelated `git status`
  // must not kill an open episode with acted_on=false (closeOnMiss=false).
  const srv = await makeServer();
  try {
    srv.telemetry.recordLoadedMemory({
      memory_id: "m1",
      distinctive_tokens: ["deploystaging", "portflag"],
      hook_hint: null,
    });
    const miss = await httpPost(srv.port, "/hook/act", {
      tool_name: "Bash",
      tool_input_excerpt: "ls -la && git status",
      exit_code: 0,
    });
    assert.equal(miss.status, 200);
    assert.equal((JSON.parse(miss.body) as { matched: number }).matched, 0);

    // The episode survived the miss: the real application still scores.
    const hit = await httpPost(srv.port, "/hook/act", {
      tool_name: "Bash",
      tool_input_excerpt: "npm run deploystaging -- portflag",
      exit_code: 0,
    });
    assert.equal((JSON.parse(hit.body) as { matched: number }).matched, 1);
  } finally {
    await srv.close();
  }
});

test("/hook/act logs the CLAUDE session id on the hook_act event, not the daemon boot uuid", async () => {
  // Audit 2026-07-10: handleHookAct nutzte die session_id fürs Episode-
  // Matching, loggte sie aber nicht — der Sink stempelte seine Boot-UUID und
  // machte den per-Session-Join gegen Transcripts strukturell unmöglich.
  const logDir = await mkdtemp(join(tmpdir(), "bastra-act-log-"));
  const prevLogPath = process.env.BASTRA_LOG_PATH;
  process.env.BASTRA_LOG_PATH = logDir;
  try {
    const srv = await makeServer();
    try {
      const res = await httpPost(srv.port, "/hook/act", {
        tool_name: "Bash",
        tool_input_excerpt: "echo cross-check",
        exit_code: null,
        session_id: "claude-session-cross-check",
        client: "claude-code",
        hook_source: "bash-fail",
      });
      assert.equal(res.status, 200);
      // write() ist fire-and-forget — kurz auf die Event-Zeile pollen.
      const day = new Date().toISOString().slice(0, 10);
      const eventsPath = join(logDir, `events-${day}.jsonl`);
      let line = "";
      for (let i = 0; i < 20 && !line; i++) {
        await new Promise((r) => setTimeout(r, 50));
        try {
          const raw = await readFile(eventsPath, "utf8");
          line = raw.split("\n").filter((l) => l.includes('"hook_act"')).pop() ?? "";
        } catch {
          // Datei existiert noch nicht — weiter pollen
        }
      }
      assert.ok(line, "hook_act event was not written");
      const event = JSON.parse(line) as {
        session_id: string;
        exit_code: number | null;
        dimensions: { client: string; hook_source: string; experiment_session: string | null };
      };
      assert.equal(event.session_id, "claude-session-cross-check");
      assert.equal(event.exit_code, null); // act ohne Exit-Code zählt trotzdem
      assert.equal(event.dimensions.client, "claude-code");
      assert.equal(event.dimensions.hook_source, "bash-fail");
      assert.match(event.dimensions.experiment_session ?? "", /^[a-f0-9]{16}$/);
    } finally {
      await srv.close();
    }
  } finally {
    if (prevLogPath === undefined) delete process.env.BASTRA_LOG_PATH;
    else process.env.BASTRA_LOG_PATH = prevLogPath;
    await rm(logDir, { recursive: true, force: true });
  }
});
