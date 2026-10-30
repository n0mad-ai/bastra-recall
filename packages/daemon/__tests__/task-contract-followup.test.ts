/** #1306 R2: real lane follow-ups, recall cost, and the trivial budget path. */
import { after, before, it } from "node:test";
import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPromptLane } from "../src/prompt-lane.js";
import { loadSessionState } from "../src/session-state.js";
import { sessionBudget } from "../src/session-budget.js";
import { decideTask, taskSignals } from "../src/prompt-classify.js";

const convention = {
  id: "dm-convention", title: "Invented DM convention", type: "workflow", scope: "all-projects",
  summary: "Translate, review, then provide copy.", score: 150, matched_recall_when: true, recall_mode: "reflex",
};
let server: Server;
let base = "";
let root = "";
let recalls = 0;
let reflexes = 0;
let revisions = 0;
const saved = new Map<string, string | undefined>();
before(async () => {
  root = await mkdtemp(join(tmpdir(), "task-followup-"));
  for (const [key, value] of Object.entries({ BASTRA_HOOK_STATE_DIR: join(root, "state"), BASTRA_LOG_PATH: join(root, "logs"), BASTRA_TELEMETRY: "off", BASTRA_PROMPT_HOOK_MODE: "all" })) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => raw += chunk);
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/hook/recall") {
        recalls++;
        const query = String(body.query);
        const hits = query.includes("eingegangene Nachricht") ? [convention]
          : query.includes("Gartenzaun") ? [{ id: "garden", title: "Garden", summary: "Fence details", type: "project-fact", score: 150 }]
          : [];
        res.end(JSON.stringify({ hits, vault_size: 2, latency_ms: 1, score_kind: "rrf" }));
      } else if (req.url === "/hook/reflex") {
        reflexes++;
        const hits = String(body.context).includes("eingegangene Nachricht") ? [{ ...convention, matched_phrase: "eingegangene Nachricht" }] : [];
        res.end(JSON.stringify({ hits, recall_id: null }));
      } else res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});
async function prompt(sid: string, text: string): Promise<string> {
  const out = await runPromptLane({ hook_event_name: "UserPromptSubmit", session_id: sid, prompt: text, cwd: "/tmp" }, null, base, undefined, () => [convention.id], {
    revisionOf: async () => { revisions++; return "sha256:dm-1"; },
  });
  return out === "{}" ? "" : JSON.parse(out).hookSpecificOutput.additionalContext;
}

it("keeps the DM contract through translation, approval, copy and an unanchored edit", async () => {
  const sid = "r2-dm-followup";
  await prompt(sid, "ich arbeite jetzt eine eingegangene Nachricht ab\nBonjour, peux-tu venir demain ?");
  // The assistant's translation/review and copy are output turns, not new user tasks.
  assert.match(await prompt(sid, "ok"), /task="approved-copy"/);
  const before = recalls;
  const edit = await prompt(sid, "zweiten Satz kürzer");
  assert.equal(recalls - before, 1, "one recall, not a second search for task tracking");
  assert.match(edit, /task="approved-copy"/);
  assert.match(edit, /- dm-convention revision=sha256:dm-1/);
  assert.equal((await loadSessionState(sid)).activeConventions?.[0]?.scope, "task");
  assert.match(await prompt(sid, "make the second sentence shorter"), /task="approved-copy"/);
  const newTopic = await prompt(sid, "wie hoch war der Gartenzaun");
  assert.doesNotMatch(newTopic, /<active-conventions/);
  assert.equal((await loadSessionState(sid)).activeTask?.kind, "none");
  assert.equal((await loadSessionState(sid)).activeConventions, undefined, "a new subject with its own hit clears the task convention");
});

it("bare ok with a task skips searches and charges the exact emitted block", async () => {
  const sid = "r2-ok-budget";
  await prompt(sid, "ich arbeite jetzt eine eingegangene Nachricht ab");
  const searches = [recalls, reflexes];
  const before = sessionBudget.spent(sid);
  const out = await prompt(sid, "ok");
  assert.deepEqual([recalls, reflexes], searches);
  assert.match(out, /task="approved-copy"/);
  assert.equal(sessionBudget.spent(sid) - before, Math.ceil(out.length / 4));
});

it("short prompts without a task perform no search or revision read and emit nothing", async () => {
  const sid = "r2-no-task";
  const before = [recalls, reflexes, revisions];
  for (const text of ["ok", "danke", "👍"]) assert.equal(await prompt(sid, text), "");
  assert.deepEqual([recalls, reflexes, revisions], before);
  assert.equal(sessionBudget.spent(sid), 0);
  assert.equal((await loadSessionState(sid)).activeTask, undefined);
});

it("mail alone and ok embedded in an ordinary sentence do not start or approve a task", () => {
  for (const text of ["Die Mail liegt auf dem Server", "My mail client is broken", "Die Schrift ist ok für mich", "The font looks ok to me"]) {
    const signals = taskSignals(text);
    assert.equal(signals.announce, false, text);
    assert.equal(signals.approval, false, text);
    assert.deepEqual(decideTask(signals, { current: "draft-for-review", questionOpen: false, mode: "generic", hitActive: false }), { next: null, unclear: false });
  }
});
