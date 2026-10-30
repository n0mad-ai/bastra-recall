/** #1311 R3: invented DM through real prompt, validation, receipt and Stop lanes.
 * Only retrieval responses are fixtures; metadata comes from a real vault file.
 * P2: a later edited artifact still accepts the prior task/generation receipt;
 * Stop intentionally does not compare a transcript-derived artifact hash.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, saveMemory } from "@bastra-recall/core";
import { vaultConventionOf } from "../src/convention-source.js";
import { callerSessionStore } from "../src/caller-session.js";
import { runPromptLane } from "../src/prompt-lane.js";
import { runStopLane } from "../src/stop-lane.js";
import { loadSessionState } from "../src/session-state.js";
import {rulebookCheckHandler} from "../src/rulebook-check.js";
import { validateArtifactHandler } from "../src/validate-artifact-handler.js";

const ANNOUNCE = "ich arbeite jetzt eine eingegangene Nachricht ab\nBonjour, pourrais-tu confirmer la visite fictive demain ?";
const MESSAGE = "Hallo Sam, morgen kommt das erfundene Paket. Bitte bestätige die Adresse.";
const CONVENTION = {
  id: "invented-dm-convention", title: "Invented DM convention", type: "workflow", scope: "all-projects",
  summary: "Translate, draft, then validate the approved DM before copy.", score: 150,
  matched_recall_when: true, recall_mode: "reflex",
  validator: { tool: "validate_artifact", channel: "discord-dm", limit: 2000, unit: "utf16" } as const,
};
let root = "";
let base = "";
let server: Server;
let vault: Vault;
const saved = new Map<string, string | undefined>();

before(async () => {
  root = await mkdtemp(join(tmpdir(), "bastra-repair-workflow-"));
  for (const [key, value] of Object.entries({
    HOME: root, USERPROFILE: root, BASTRA_HOOK_STATE_DIR: join(root, "state"),
    BASTRA_LOG_PATH: join(root, "logs"), BASTRA_PENDING_SUGGESTIONS_PATH: join(root, "pending.json"),
    BASTRA_TELEMETRY: "on", BASTRA_PROMPT_HOOK_MODE: "all", BASTRA_STOP_SAME_TURN: "1",
  })) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  const vaultRoot = join(root, "vault");
  await mkdir(vaultRoot);
  await saveMemory(vaultRoot, { id: CONVENTION.id, title: CONVENTION.title, type: "workflow",
    summary: CONVENTION.summary, body: "Translate, draft, validate approved copy.",
    scope: "all-projects", topic_path: ["fixture"], tags: ["fixture"], recall_when: ["eingegangene Nachricht"],
    write_origin: "user-directed", validator: CONVENTION.validator });
  vault = new Vault(vaultRoot);
  await vault.init();
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => raw += chunk);
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      const message = /eingegangene Nachricht/.test(String(body.query ?? body.context ?? ""));
      if (req.url === "/hook/recall") {
        res.end(JSON.stringify({ hits: message ? [CONVENTION] : [], vault_size: 1, latency_ms: 1, score_kind: "rrf" }));
      } else if (req.url === "/hook/reflex") {
        res.end(JSON.stringify({ hits: message ? [{ ...CONVENTION, matched_phrase: "eingegangene Nachricht" }] : [], recall_id: null }));
      } else res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await vault.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

async function prompt(sid: string, text: string): Promise<string> {
  return runPromptLane({ hook_event_name: "UserPromptSubmit", session_id: sid, prompt: text, cwd: root }, null, base, undefined, () => [CONVENTION.id], {
    conventionOf: vaultConventionOf(vault),
  });
}

async function approved(sid: string): Promise<void> {
  await prompt(sid, ANNOUNCE);
  const deps={vault} as import("../src/tool-deps.js").ToolDeps;
  assert.equal((await rulebookCheckHandler(deps,{applicable:[CONVENTION.id],task:"draft-for-review"},{sessionId:sid})).ok,true);
  assert.equal((await loadSessionState(sid)).activeTask?.kind, "draft-for-review");
  assert.deepEqual((await loadSessionState(sid)).activeConventions?.find((c) => c.id === CONVENTION.id)?.validator, CONVENTION.validator);
  await prompt(sid, "ok");
  assert.equal((await rulebookCheckHandler(deps,{applicable:[CONVENTION.id],task:"approved-copy"},{sessionId:sid})).ok,true);
  assert.equal((await loadSessionState(sid)).activeTask?.kind, "approved-copy");
}

async function stop(sid: string, text = MESSAGE, repeated = true): Promise<string> {
  return runStopLane({
    hook_event_name: "Stop", session_id: sid, cwd: root, stop_hook_active: repeated,
    transcript: [{ role: "user", content: "ok" }, { role: "assistant", content: text }],
  }, base);
}

async function exhaustion(sid: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (const name of await readdir(join(root, "logs")).catch(() => [] as string[])) {
    if (!name.startsWith("events-")) continue;
    for (const line of (await readFile(join(root, "logs", name), "utf8")).split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.kind === "non_conformance" && row.reason === "repair_exhausted" && row.session_id === sid) rows.push(row);
    }
  }
  return rows;
}

test("DM announcement → draft → ok → validation receipt → Stop without repair; edit preserves receipt (P2 hash limit)", async () => {
  const sid = "workflow-validated-dm";
  await approved(sid);
  const validation = await callerSessionStore.run(sid, () => validateArtifactHandler({ text: MESSAGE, channel: "discord-dm", normalize: "none" }));
  assert.equal(validation.session_known, true);
  assert.equal(validation.receipt_stored, true);
  const before = await loadSessionState(sid);
  assert.equal(before.receipts?.length, 1);
  assert.equal(before.receipts?.[0]?.receipt, validation.receipt);
  assert.equal(before.receipts?.[0]?.taskId, before.activeTask?.id);
  assert.equal(before.receipts?.[0]?.generation, before.activeTask?.generation);
  assert.equal(await stop(sid), "{}");
  assert.equal((await loadSessionState(sid)).repairAttempts, undefined);

  assert.match(await prompt(sid, "zweiten Satz kürzer"), /approved-copy/);
  const edited = await loadSessionState(sid);
  assert.deepEqual(edited.activeTask, before.activeTask);
  assert.deepEqual(edited.receipts, before.receipts);
  assert.equal(await stop(sid), "{}");
  // Known P2: modified output without revalidation still matches task+generation.
  assert.equal(await stop(sid, "Hallo Sam, morgen kommt das Paket. Adresse bitte."), "{}");
  assert.equal((await loadSessionState(sid)).repairAttempts, undefined);
  assert.deepEqual(await exhaustion(sid), []);
});

test("same invented DM without validation gets repair 1, repair 2, exactly one exhaustion event", async () => {
  const sid = "workflow-unvalidated-dm";
  await approved(sid);
  for (const attempt of [1, 2]) {
    const out = JSON.parse(await stop(sid, MESSAGE, attempt === 2));
    assert.equal(out.decision, undefined);
    assert.equal(out.hookSpecificOutput?.hookEventName, "Stop");
    assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`attempt="${attempt}/2"`));
    assert.match(out.hookSpecificOutput.additionalContext, /validate_artifact/);
  }
  assert.equal(await stop(sid), "{}");
  const events = await exhaustion(sid);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.session_known, true);
  const task = (await loadSessionState(sid)).activeTask;
  assert.equal(events[0]?.task_id, task?.id);
  assert.equal(events[0]?.generation, task?.generation);
  assert.equal(events[0]?.attempts, 2);
  assert.equal(await stop(sid), "{}");
  assert.equal((await exhaustion(sid)).length, 1);
});
