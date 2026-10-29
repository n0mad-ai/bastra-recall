import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPromptLane } from "../src/prompt-lane.js";
import { runStopLane } from "../src/stop-lane.js";
import { loadSessionState, mutateSessionState } from "../src/session-state.js";
import { decideTask, taskSignals } from "../src/prompt-classify.js";
import { callerSessionStore } from "../src/caller-session.js";
import { validateArtifactHandler } from "../src/validate-artifact-handler.js";

const convention = { id: "fixture-correspondence", title: "Invented message convention", summary: "Draft, review, then approved copy.", type: "workflow", scope: "all-projects", score: 150, matched_recall_when: true,
  validator: { tool: "validate_artifact" as const, channel: "discord-dm", limit: 2000, unit: "utf16" as const } };
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url === "/hook/recall" ? { hits: [convention], score_kind: "rrf", vault_size: 1 } : { hits: [] }));
  });
});
let root = "";
let base = "";
const saved: Record<string, string | undefined> = {};
before(async () => {
  root = await mkdtemp(join(tmpdir(), "bastra-1328-"));
  for (const [key, value] of Object.entries({ BASTRA_HOOK_STATE_DIR: join(root, "state"), BASTRA_LOG_PATH: join(root, "logs"), BASTRA_TELEMETRY: "off", BASTRA_PROMPT_HOOK_MODE: "all" })) {
    saved[key] = process.env[key]; process.env[key] = value;
  }
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(root, { recursive: true, force: true });
});
async function prompt(sid: string, text: string) {
  await runPromptLane({ hook_event_name: "UserPromptSubmit", session_id: sid, prompt: text, cwd: root }, null, base, undefined, () => [convention.id], {
    conventionOf: async () => ({ revision: "sha256:fixture-1328", validator: convention.validator }),
  });
  return loadSessionState(sid);
}
test("#1328: exact three-prompt dogfood sequence reaches approved-copy and stores a receipt", async () => {
  const sid = "1328-exact";
  const first = await prompt(sid, '<pasted_content>Alex: Hello, can you send the question?</pasted_content>\ndm verlauf mit X den du noch nicht kennst');
  assert.equal(first.activeTask?.kind ?? "none", "none");
  assert.ok(first.taskQuestion);
  assert.equal((await prompt(sid, "… und dass wir die Frage dann mal an X schicken")).activeTask?.kind, "draft-for-review");
  const state = await prompt(sid, "ok, mach die englische Fassung");
  assert.equal(state.activeTask?.kind, "approved-copy");
  const validation = await callerSessionStore.run(sid, () => validateArtifactHandler({ text: "Hi Alex, could you check the invented question?", channel: "discord-dm", normalize: "none", rule: { id: convention.id, revision: "sha256:fixture-1328" }, task: { kind: state.activeTask!.kind, generation: state.activeTask!.generation } }));
  assert.equal(validation.receipt_stored, true);
});
test("#1328: approval plus target-language request recovers none only under a correspondence convention", async () => {
  for (const text of ["ok, mach die englische Fassung", "passt, englisch bitte", "ok, übersetz", "okay, give me the English version", "yes, translate it"]) {
    const sid = `1328-recover-${text}`;
    await mutateSessionState(sid, s => { s.activeConventions = [{ id: convention.id, revision: "sha256:fixture-1328", scope: "task", setAt: 1, validator: convention.validator }]; });
    assert.equal((await prompt(sid, text)).activeTask?.kind, "approved-copy", text);
    assert.notEqual(decideTask(taskSignals(text), { current: "none", questionOpen: false, mode: "generic", hitActive: false }).next, "approved-copy", `no context: ${text}`);
  }
});
test("#1328: an assistant's German review draft binds draft-for-review from Stop", async () => {
  const sid = "1328-assistant-draft";
  await prompt(sid, '<pasted_content>Alex: An invented incoming message.</pasted_content>\ndm verlauf mit X den du noch nicht kennst');
  await runStopLane({ hook_event_name: "Stop", session_id: sid, cwd: root, transcript: [
    { role: "user", content: "dm verlauf mit X den du noch nicht kennst" },
    { role: "assistant", content: "Deutscher Entwurf zur Freigabe:\n\n```\nHallo Alex, könntest du die erfundene Frage prüfen?\n```\n\nPasst das so?" },
  ] }, base);
  assert.equal((await loadSessionState(sid)).activeTask?.kind, "draft-for-review");
  assert.equal((await prompt(sid, "passt, englisch bitte")).activeTask?.kind, "approved-copy");
});
test("#1328: sending correspondence differs from writing files or quoted approvals", () => {
  const ctx = { current: "none" as const, questionOpen: false, mode: "generic" as const, hitActive: false };
  for (const text of ["die Frage an Alex schicken", "Nachricht an Alex", "send the message to Alex", "write to Alex"]) {
    assert.equal(decideTask(taskSignals(text), ctx).next, "draft-for-review", text);
  }
  assert.equal(decideTask(taskSignals("Alex schreiben"), { ...ctx, correspondenceActive: true }).next, "draft-for-review");
  for (const text of ["Datei schreiben", "Datei nach /tmp schreiben", "write to config.json", "das Paket an den Server schicken", "> ok, mach die englische Fassung", "Die Mail liegt auf dem Server", "Die englische Fassung der Dokumentation liegt im Repo"]) {
    assert.notEqual(decideTask(taskSignals(text), ctx).next, "draft-for-review", text);
  }
  assert.equal(decideTask(taskSignals("ok, aber die englische Fassung ist falsch, bitte korrigieren"), { ...ctx, current: "draft-for-review" }).next, null);
});

test("#1328: plain review drafts bind, but missing context and existing task kinds are preserved", async () => {
  const { recordReviewDraft } = await import("../src/stop-task.js");
  const content = "Deutscher Entwurf zur Freigabe:\n\nHallo Alex, bitte prüfe die erfundene Frage.\n\nPasst das so?";
  const transcript = [{ role: "assistant", content }];
  await recordReviewDraft("1328-no-context", transcript);
  assert.equal((await loadSessionState("1328-no-context")).activeTask, undefined);
  await prompt("1328-plain", '<pasted_content>Invented DM</pasted_content>\ndm verlauf mit X den du noch nicht kennst');
  await recordReviewDraft("1328-plain", transcript);
  assert.equal((await loadSessionState("1328-plain")).activeTask?.kind, "draft-for-review");
  for (const kind of ["translate-only", "approved-copy"] as const) {
    const sid = `1328-preserve-${kind}`;
    await mutateSessionState(sid, s => { s.activeTask = { id: sid, kind, generation: 3, since: 1 }; s.activeConventions = [{ id: convention.id, revision: null, scope: "task", setAt: 1, validator: convention.validator }]; });
    await recordReviewDraft(sid, transcript);
    assert.equal((await loadSessionState(sid)).activeTask?.kind, kind);
  }
});
test("#1328: target-copy cues can be supplied in another language through the user lexicon", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dir = join(root, "lexicon");
  await mkdir(dir);
  await writeFile(join(dir, "target-copy.txt"), "version française\n");
  const before = process.env.BASTRA_LEXICON_DIR;
  process.env.BASTRA_LEXICON_DIR = dir;
  try {
    assert.equal(decideTask(taskSignals("version française"), { current: "draft-for-review", questionOpen: false, mode: "generic", hitActive: false }).next, "approved-copy");
  } finally { if (before === undefined) delete process.env.BASTRA_LEXICON_DIR; else process.env.BASTRA_LEXICON_DIR = before; }
});
