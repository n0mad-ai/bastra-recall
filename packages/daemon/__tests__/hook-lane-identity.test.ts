/**
 * Die Telemetrie-Identität JEDER Hook-Lane (#445, #263).
 *
 * `/hook/recall` liest `client`, `hook_source` und `session_id` aus dem
 * REQUEST-BODY und hängt sie an `hook_recall` wie an `evidence_decision`. Eine
 * Lane, die eines der Felder wegläßt, erzeugt deshalb kein falsches Ergebnis,
 * sondern ein unbeschriftetes — und das fällt nirgends auf, weil der Sink
 * `unknown` einsetzt und die Antwort dieselbe bleibt. Gemessen war das der
 * Normalfall: 81 von 83 Entscheidungen im Live-Schattenstrom trugen
 * `unknown/unknown`.
 *
 * Deshalb prüft dieser Test an der Grenze, an der es zählt — dem Body, der
 * tatsächlich über die Leitung geht — und für alle Lanes in einer Datei: Die
 * Lücke entstand dadurch, dass jede Lane ihren eigenen Request-Typ mitbringt
 * und beim Kopieren jeweils andere Felder verlorengingen. Ein Test je Lane in
 * je eigener Datei hätte genau das wieder eingeladen.
 *
 * Der Testserver ist der Empfänger: Er beantwortet den Loopback-Self-Call der
 * Lane und hält den Body fest. Kein Vault, kein Suchindex, kein Daemon-Boot.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/hook-lane-identity.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { HOOK_SOURCES, TELEMETRY_CLIENTS } from "../src/telemetry-dimensions.js";
import { runPromptLane } from "../src/prompt-lane.js";
import { runWriteLane } from "../src/write-lane.js";
import { runTodoLane } from "../src/todo-lane.js";
import { runBashFailLane, throttleFile } from "../src/bash-fail-lane.js";

const SESSION = "s-445";

interface Captured {
  path: string;
  body: Record<string, unknown>;
}

/**
 * Ein Server, der jeden Hook-Endpunkt annimmt und die Bodies mitschreibt.
 *
 * Die Antwort ist bewusst leer (`hits: []`): Was die Lane aus den Treffern
 * MACHT, prüfen ihre eigenen Tests. Hier zählt allein, was sie schickt.
 */
async function withRecallSink(
  fn: (baseUrl: string, seen: Captured[]) => Promise<void>,
): Promise<void> {
  const seen: Captured[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw || "{}") as Record<string, unknown>;
      } catch {
        // Ein unlesbarer Body ist selbst ein Befund — als leeres Objekt
        // aufgezeichnet, damit die Zusicherung unten ihn benennt.
      }
      seen.push({ path: req.url ?? "", body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hits: [] }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`, seen);
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
}

/** Der Recall-Aufruf einer Lane — die anderen Hops (act, hinted, usage) sind
 *  hier nicht die Frage. */
const recallOf = (seen: Captured[]): Record<string, unknown> | undefined =>
  seen.find((c) => c.path === "/hook/recall")?.body;

/**
 * Die eine Zusicherung, viermal.
 *
 * `client` und `hook_source` müssen auf der Allowlist stehen, sonst normalisiert
 * `telemetry-dimensions.ts` sie still auf `unknown` — die Lane hätte die Felder
 * dann zwar gesendet, und die Auswertung sähe trotzdem nichts.
 */
function assertIdentity(
  body: Record<string, unknown> | undefined,
  lane: string,
  expectedSource: string,
): void {
  assert.ok(body, `${lane}: kein /hook/recall-Aufruf angekommen`);
  assert.equal(body.client, "claude-code", `${lane}: client fehlt oder ist falsch`);
  assert.equal(body.hook_source, expectedSource, `${lane}: hook_source fehlt oder ist falsch`);
  assert.equal(body.session_id, SESSION, `${lane}: session_id fehlt oder ist falsch`);
  assert.ok(
    (TELEMETRY_CLIENTS as readonly string[]).includes(body.client as string),
    `${lane}: client steht nicht auf der Allowlist`,
  );
  assert.ok(
    (HOOK_SOURCES as readonly string[]).includes(body.hook_source as string),
    `${lane}: hook_source steht nicht auf der Allowlist`,
  );
}

test("die Prompt-Lane weist sich aus", async () => {
  await withRecallSink(async (baseUrl, seen) => {
    await runPromptLane(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: SESSION,
        // Lang genug, um am Trivial-Gate vorbeizukommen.
        prompt: "wie war noch die Entscheidung zur Deployment-Strategie im Projekt",
      } as never,
      null,
      baseUrl,
    );
    assertIdentity(recallOf(seen), "prompt-lane", "prompt");
  });
});

test("die Write-Lane weist sich aus", async () => {
  await withRecallSink(async (baseUrl, seen) => {
    await runWriteLane(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        session_id: SESSION,
        tool_input: {
          file_path: "/tmp/beispiel/service.ts",
          content: "export function deploy(): void {}\n".repeat(20),
        },
      } as never,
      baseUrl,
    );
    assertIdentity(recallOf(seen), "write-lane", "pre-tool");
  });
});

test("die Todo-Lane weist sich aus", async () => {
  await withRecallSink(async (baseUrl, seen) => {
    await runTodoLane(
      {
        hook_event_name: "PreToolUse",
        tool_name: "TodoWrite",
        session_id: SESSION,
        tool_input: {
          todos: [
            { content: "Deployment-Pipeline auf den neuen Runner umstellen", status: "pending" },
            { content: "Telemetrie-Dimensionen der Hook-Lanes prüfen", status: "pending" },
            { content: "Migrationsskript für die Vault-Indizes schreiben", status: "pending" },
          ],
        },
      } as never,
      baseUrl,
    );
    assertIdentity(recallOf(seen), "todo-lane", "todo");
  });
});

test("die Bash-Fail-Lane weist sich aus", async (t) => {
  // Die Lane drosselt pro Session über eine Datei; ein Rest aus einem früheren
  // Lauf würde den Recall überspringen und den Test grün lügen.
  const { unlink } = await import("node:fs/promises");
  const clear = async (): Promise<void> => {
    try {
      await unlink(throttleFile(SESSION));
    } catch {
      // gab es nicht — genau der gewünschte Zustand
    }
  };
  await clear();
  t.after(clear);

  await withRecallSink(async (baseUrl, seen) => {
    await runBashFailLane(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        session_id: SESSION,
        tool_input: { command: "npm run build" },
        tool_response: { exit_code: 1, stderr: "Error: ENOENT missing module tsconfig" },
      },
      baseUrl,
    );
    assertIdentity(recallOf(seen), "bash-fail-lane", "bash-fail");
  });
});
