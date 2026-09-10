/**
 * §20.5 an den Lanes, die den geratenen Projektnamen bis hierher als Tatsache
 * behandelt haben.
 *
 * Befund: Eine Agenten-Session läuft mit cwd `~/.buzz`. Dort liegt kein `.git`
 * und kein Container-Segment (`Projekte/`, `src/`, …), also fiel
 * `detectProject()` auf das letzte Pfadsegment zurück und lieferte ".buzz" —
 * ununterscheidbar von einer echten Erkennung. Die SessionStart-Lane fragte
 * daraufhin Kandidaten für ein Projekt ".buzz" ab und schrieb `project=".buzz"`
 * in den ausgelieferten Kontextblock; die Prompt-Lane schickte denselben Namen
 * als `project` an `/hook/recall`. Die Write-Lane hatte diese Regel über
 * `projectForFilter()` schon (`write-lane-project-confidence.test.ts`) — aber
 * nur für den FILTER: ihre Query und ihr Hint-Block trugen den geratenen Namen
 * weiter. Die anderen drei hatten die Regel nirgends.
 *
 * Jetzt entscheidet `projectForLane()`: `git-root`/`root-match` bleiben, was
 * sie waren, `fallback` ist kein Projekt.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/lane-project-confidence.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Vault } from "@bastra-recall/core";
import type { ToolDeps } from "../src/tool-handlers.js";
import { runSessionLane } from "../src/session-lane.js";
import { runPromptLane } from "../src/prompt-lane.js";
import { runWriteLane } from "../src/write-lane.js";
import { runTodoLane } from "../src/todo-lane.js";
import { handleSessionContextPost } from "../src/session-context.js";

/** Ein cwd ohne `.git` und ohne Container-Segment — der Fall aus dem Befund.
 *  Der Pfad existiert absichtlich nicht: die Erkennung ist reine Pfadarbeit
 *  plus `existsSync`, und ein nicht existierender Pfad hat garantiert kein
 *  `.git` über sich, egal auf welcher Maschine der Test läuft. */
const GUESSED_CWD = "/Users/x/.buzz";
/** Derselbe Baum mit Container-Segment: `root-match`, muss unverändert
 *  bleiben. */
const DETECTED_CWD = "/Users/x/Projekte/bastra-recall";

const SESSION_CONTEXT_BODY = JSON.stringify({
  budget: {},
  aborted: [],
  data: {
    recalls: [
      {
        scope: "user-preference",
        resp: {
          hits: [
            {
              id: "m1",
              title: "Ein Fakt",
              type: "reference",
              scope: "user-preference",
              summary: "Damit der Block überhaupt gerendert wird.",
              score: 150,
            },
          ],
          vault_size: 1,
          latency_ms: 1,
          recall_id: "r1",
          score_kind: "rrf",
        },
      },
    ],
    floors: [],
    conventions: [],
    care: { open: 0, queued: 0 },
    imports: { open: 0, queued: 0 },
    onboarding: false,
  },
});

const RECALL_BODY = JSON.stringify({
  hits: [
    {
      id: "m1",
      title: "Ein Fakt",
      type: "reference",
      scope: "user-preference",
      summary: "Damit der Block überhaupt gerendert wird.",
      score: 150,
    },
  ],
  vault_size: 1,
  latency_ms: 1,
  recall_id: "r1",
  score_kind: "rrf",
});

interface Captured {
  path: string;
  body: Record<string, unknown>;
}

async function withDaemon(
  bodies: Record<string, string>,
  fn: (baseUrl: string, seen: Captured[]) => Promise<void>,
): Promise<void> {
  const seen: Captured[] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      if (raw) {
        try {
          seen.push({ path, body: JSON.parse(raw) as Record<string, unknown> });
        } catch {
          /* nicht-JSON interessiert diesen Test nicht */
        }
      }
      const body = bodies[path];
      res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
      res.end(body ?? "{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, seen);
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

const SESSION_BODIES = {
  "/hook/session-context": SESSION_CONTEXT_BODY,
  "/health": JSON.stringify({ ok: true }),
  "/hook/hinted": "{}",
};

const WRITE_BODIES = {
  "/hook/recall": RECALL_BODY,
  "/hook/hinted": "{}",
};

const PROMPT_BODIES = {
  "/hook/recall": RECALL_BODY,
  "/hook/reflex": JSON.stringify({ hits: [] }),
  "/hook/hinted": "{}",
};

function context(stdout: string): string {
  const out = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } };
  return out.hookSpecificOutput?.additionalContext ?? "";
}

async function runSession(cwd: string, base: string): Promise<string> {
  return withEnv({ BASTRA_TELEMETRY: "off" }, () =>
    runSessionLane(
      {
        hook_event_name: "SessionStart",
        source: "startup",
        cwd,
        session_id: `proj-conf-${cwd}-${Date.now()}`,
      },
      base,
    ),
  );
}

async function runPrompt(cwd: string, base: string): Promise<string> {
  return withEnv({ BASTRA_TELEMETRY: "off", BASTRA_HOOK_MODE: "all" }, () =>
    runPromptLane(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "wo ist der Mietvertrag?",
        cwd,
        session_id: `proj-conf-prompt-${cwd}-${Date.now()}`,
      },
      null,
      base,
    ),
  );
}

test("SessionStart mit geratenem Projekt: kein project-Attribut, keine Projekt-Query", async () => {
  await withDaemon(SESSION_BODIES, async (base, seen) => {
    const ctx = context(await runSession(GUESSED_CWD, base));

    assert.ok(ctx.includes("<session-context"), "der Block wird überhaupt gerendert");
    assert.doesNotMatch(ctx, /project="/, "kein Projekt-Attribut auf einem geratenen Namen");
    assert.doesNotMatch(ctx, /\.buzz/, "der geratene Name taucht nirgends im Block auf");

    const posted = seen.filter((s) => s.path === "/hook/session-context");
    assert.equal(posted.length, 1, "die Lane fragt den Assembler genau einmal");
    assert.equal(posted[0].body.project, null, "kein Projekt an den Assembler — also keine Projekt-Query");
  });
});

test("SessionStart mit erkanntem Projekt (root-match): unverändert", async () => {
  await withDaemon(SESSION_BODIES, async (base, seen) => {
    const ctx = context(await runSession(DETECTED_CWD, base));

    assert.match(ctx, /project="bastra-recall"/, "die echte Erkennung trägt weiter ihr Attribut");
    const posted = seen.filter((s) => s.path === "/hook/session-context");
    assert.equal(posted[0].body.project, "bastra-recall");
  });
});

test("Prompt-Lane mit geratenem Projekt: kein project-Attribut, kein Projekt im Recall", async () => {
  await withDaemon(PROMPT_BODIES, async (base, seen) => {
    const ctx = context(await runPrompt(GUESSED_CWD, base));

    assert.ok(ctx.includes("<recall-hints"), "der Block wird überhaupt gerendert");
    assert.doesNotMatch(ctx, /project="/, "kein Projekt-Attribut auf einem geratenen Namen");
    assert.doesNotMatch(ctx, /\.buzz/, "der geratene Name taucht nirgends im Block auf");

    for (const s of seen) {
      assert.equal(s.body.project ?? null, null, `${s.path} darf kein geratenes Projekt tragen`);
    }
  });
});

test("Prompt-Lane mit erkanntem Projekt (root-match): unverändert", async () => {
  await withDaemon(PROMPT_BODIES, async (base, seen) => {
    const ctx = context(await runPrompt(DETECTED_CWD, base));

    assert.match(ctx, /project="bastra-recall"/, "die echte Erkennung trägt weiter ihr Attribut");
    const recall = seen.find((s) => s.path === "/hook/recall");
    assert.ok(recall, "die Lane fragt /hook/recall");
    assert.equal(recall.body.project, "bastra-recall");
  });
});

async function runWrite(cwd: string, base: string): Promise<string> {
  return withEnv({ BASTRA_TELEMETRY: "off" }, () =>
    runWriteLane(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        session_id: `proj-conf-write-${cwd}-${Date.now()}`,
        cwd,
        tool_input: {
          file_path: `${cwd}/src/recall.ts`,
          old_string: "const recall = 1;",
          new_string: "const recall = 2;",
        },
      },
      base,
    ),
  );
}

test("Write-Lane mit geratenem Projekt: kein project-Attribut, kein Projekt im Recall", async () => {
  await withDaemon(WRITE_BODIES, async (base, seen) => {
    const ctx = context(await runWrite(GUESSED_CWD, base));

    assert.ok(ctx.includes("<recall-hints"), "der Block wird überhaupt gerendert");
    assert.doesNotMatch(ctx, /project="/, "kein Projekt-Attribut auf einem geratenen Namen");
    assert.doesNotMatch(ctx, /\.buzz/, "der geratene Name taucht nirgends im Block auf");

    const recall = seen.find((s) => s.path === "/hook/recall");
    assert.ok(recall, "die Lane fragt /hook/recall");
    assert.equal(recall.body.project ?? null, null, "kein geratenes Projekt im Recall-Body");
  });
});

test("Write-Lane mit erkanntem Projekt (root-match): unverändert", async () => {
  await withDaemon(WRITE_BODIES, async (base, seen) => {
    const ctx = context(await runWrite(DETECTED_CWD, base));

    assert.match(ctx, /project="bastra-recall"/, "die echte Erkennung trägt weiter ihr Attribut");
    const recall = seen.find((s) => s.path === "/hook/recall");
    assert.ok(recall);
    assert.equal(recall.body.project, "bastra-recall");
  });
});

/** Drei zusammenhängende Todos — die Todo-Lane verwirft alles darunter als
 *  `low-confidence`, bevor sie das Projekt überhaupt anfasst. */
const TODOS = {
  todos: [
    { content: "Migrate the auth middleware to the new session store", status: "pending" },
    { content: "Write regression tests for the session store migration", status: "pending" },
    { content: "Update the deployment notes for the session store", status: "pending" },
  ],
};

async function runTodo(cwd: string, base: string): Promise<string> {
  return withEnv({ BASTRA_TELEMETRY: "off" }, () =>
    runTodoLane(
      {
        hook_event_name: "PreToolUse",
        tool_name: "TodoWrite",
        session_id: `proj-conf-todo-${cwd}-${Date.now()}`,
        cwd,
        tool_input: TODOS,
      },
      base,
    ),
  );
}

test("Todo-Lane mit geratenem Projekt: kein project-Attribut, kein Projekt im Recall", async () => {
  await withDaemon(WRITE_BODIES, async (base, seen) => {
    const ctx = context(await runTodo(GUESSED_CWD, base));

    assert.ok(ctx.includes("<recall-hints"), "der Block wird überhaupt gerendert");
    assert.doesNotMatch(ctx, /project="/, "kein Projekt-Attribut auf einem geratenen Namen");
    assert.doesNotMatch(ctx, /\.buzz/, "der geratene Name taucht nirgends im Block auf");

    const recall = seen.find((s) => s.path === "/hook/recall");
    assert.ok(recall, "die Lane fragt /hook/recall");
    assert.equal(recall.body.project ?? null, null, "kein geratenes Projekt im Recall-Body");
  });
});

test("Todo-Lane mit erkanntem Projekt (root-match): unverändert", async () => {
  await withDaemon(WRITE_BODIES, async (base, seen) => {
    const ctx = context(await runTodo(DETECTED_CWD, base));

    assert.match(ctx, /project="bastra-recall"/, "die echte Erkennung trägt weiter ihr Attribut");
    const recall = seen.find((s) => s.path === "/hook/recall");
    assert.ok(recall);
    assert.equal(recall.body.project, "bastra-recall");
  });
});

/**
 * Die HTTP-Route `POST /hook/session-context` löst das Projekt selbst auf,
 * wenn der Aufrufer nur ein `cwd` schickt (hooklose Clients, MCP-Forwarder).
 * Sie antwortet mit dem aufgelösten Namen im Feld `project` — genau darauf
 * prüft dieser Test, weil der gerenderte Block bei einem Fake-Vault ohnehin
 * leer bliebe und ein geratenes Projekt dort nicht sichtbar würde.
 */
async function postSessionContextRoute(
  body: Record<string, unknown>,
): Promise<{ project: unknown; context: string }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-proj-conf-"));
  const vault = { size: () => 0, get: () => undefined, list: () => [] } as unknown as Vault;
  const server: Server = createServer((req, res) => {
    void handleSessionContextPost(req, res, { vaultPath: dir } as unknown as ToolDeps, vault);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/hook/session-context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await resp.json()) as { project: unknown; context: string };
    return json;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
}

test("POST /hook/session-context mit geratenem cwd: project null, kein .buzz im Block", async () => {
  const { project, context: ctx } = await postSessionContextRoute({ cwd: GUESSED_CWD });
  assert.equal(project, null, "die Route übernimmt den geratenen Namen nicht");
  assert.doesNotMatch(ctx, /\.buzz/);
});

test("POST /hook/session-context mit erkanntem cwd (root-match): unverändert", async () => {
  const { project } = await postSessionContextRoute({ cwd: DETECTED_CWD });
  assert.equal(project, "bastra-recall");
});

test("POST /hook/session-context: ein ausdrücklich mitgeschicktes Projekt gewinnt weiter", async () => {
  const { project } = await postSessionContextRoute({ cwd: GUESSED_CWD, project: "bastra-recall" });
  assert.equal(project, "bastra-recall", "der explizite Wert wird nicht von der cwd-Auflösung überschrieben");
});
