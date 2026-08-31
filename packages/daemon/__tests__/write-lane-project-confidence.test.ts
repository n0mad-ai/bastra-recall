/**
 * §20.5 an der einzigen Lane, deren Scope-Filter schon scharf ist.
 *
 * Bis hierher fütterte die Write-Lane den Hard-Filter mit `detectProject()`.
 * Der gibt für JEDEN nichtleeren Pfad einen Namen zurück — in einem Worktree
 * unter `/tmp/worktree/packages/core` also "core" —, und der Filter warf dann
 * jeden Treffer weg, dessen Scope nicht "core" hieß: das ganze eigene
 * Projektgedächtnis, lautlos. Jetzt entscheidet `projectForFilter()`, ob der
 * Name gut genug zum Wegwerfen ist.
 *
 * Runner: `tsx --test __tests__/write-lane-project-confidence.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { runWriteLane } from "../src/write-lane.js";

function startMockDaemon(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  return new Promise<{ port: number; close: () => Promise<void> }>((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      ok({
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** Ein Treffer aus dem Projekt "bastra-recall" — im Worktree-Fall der eigene. */
function startDaemonWithOwnHit() {
  return startMockDaemon((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          hits: [
            {
              id: "eigener-projekt-fakt",
              title: "Eigen",
              type: "project-fact",
              scope: "bastra-recall",
              summary: "Ein Fakt aus dem eigenen Projekt.",
              score: 140,
            },
          ],
          vault_size: 100,
          latency_ms: 5,
          recall_id: "test",
        }),
      );
    });
  });
}

async function runLane(cwd: string, port: number): Promise<string> {
  const before = process.env.BASTRA_TELEMETRY;
  process.env.BASTRA_TELEMETRY = "off";
  try {
    const stdout = await runWriteLane(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        session_id: `conf-${cwd}-${Date.now()}`,
        cwd,
        tool_input: {
          file_path: `${cwd}/src/recall.ts`,
          old_string: "const recall = 1;",
          new_string: "const recall = 2;",
        },
      },
      `http://127.0.0.1:${port}`,
    );
    return (
      (JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } })
        .hookSpecificOutput?.additionalContext ?? ""
    );
  } finally {
    if (before === undefined) delete process.env.BASTRA_TELEMETRY;
    else process.env.BASTRA_TELEMETRY = before;
  }
}

test("erkanntes Projekt: der eigene Treffer passiert wie bisher", async () => {
  const daemon = await startDaemonWithOwnHit();
  try {
    const ctx = await runLane("/Users/x/Projekte/bastra-recall", daemon.port);
    assert.match(ctx, /eigener-projekt-fakt/);
  } finally {
    await daemon.close();
  }
});

test("geratenes Projekt (Worktree): der Filter wirft nichts mehr weg", async () => {
  const daemon = await startDaemonWithOwnHit();
  try {
    // detectProject() macht daraus "core" — vorher fiel der bastra-recall-Hit
    // hier komplett aus, ohne dass irgendwo ein Fehler entstand.
    const ctx = await runLane("/tmp/worktree/packages/core", daemon.port);
    assert.match(ctx, /eigener-projekt-fakt/);
  } finally {
    await daemon.close();
  }
});
