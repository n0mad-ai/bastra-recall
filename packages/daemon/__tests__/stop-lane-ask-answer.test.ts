/**
 * #701: the Stop lane sees a decision the user made through Claude Code's
 * AskUserQuestion tool. The answer comes back as a tool result, which the
 * prose heuristics skip on purpose; the structural check reads the tool call
 * followed by the `"question"="answer"` pair.
 *
 * The fixture rows have the shape Claude Code writes (2.1.x): the tool_use in
 * an assistant row, the result as a `user` row with a `tool_result` block and
 * a `toolUseResult` twin.
 *
 * Run: node --import tsx --test packages/daemon/__tests__/stop-lane-ask-answer.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { detectArchitectureDecision, detectFrustration, parseTranscriptFile } from "../src/stop-lane.js";

const QUESTION = "Welche Toolchain für das Mono-Repo?";
const ANSWER = "pnpm + Turborepo (Empfehlung)";

const user = (text: string): object => ({ type: "user", message: { role: "user", content: text } });
const assistant = (text: string): object => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const ask = (id: string): object => ({
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id,
        name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: QUESTION,
              header: "Toolchain",
              multiSelect: false,
              options: [
                { label: ANSWER, description: "Schnelle Builds, ein Lockfile." },
                { label: "npm workspaces", description: "Keine weitere Abhängigkeit." },
              ],
            },
          ],
        },
      },
    ],
  },
});
const toolResult = (id: string, content: string, extra: object = {}): object => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  ...extra,
});
const answered = (id: string): object =>
  toolResult(id, `User has answered your questions: "${QUESTION}"="${ANSWER}". You can now continue with the user's answers in mind.`, {
    toolUseResult: { questions: [{ question: QUESTION }], answers: { [QUESTION]: ANSWER } },
  });

const turnsOf = (rows: object[]) => parseTranscriptFile(rows.map((r) => JSON.stringify(r)).join("\n"));

test("#701 — an AskUserQuestion answer counts as a user decision", () => {
  const turns = turnsOf([
    user("Richte das Mono-Repo ein."),
    assistant("Dazu brauche ich eine Entscheidung."),
    ask("toolu_01"),
    answered("toolu_01"),
    assistant("Gut, ich richte pnpm und Turborepo ein."),
  ]);
  // No cue word anywhere in what the user typed — the answer is the only signal.
  assert.equal(turns.filter((t) => t.role === "user").length, 1);
  const s = detectArchitectureDecision(turns);
  assert.ok(s, "the answered question must fire");
  assert.equal(s!.heuristic, "architecture-decision");
  assert.equal(s!.type, "decision");
  assert.ok(s!.body.includes(`"${QUESTION}"="${ANSWER}"`), s!.body);
  assert.equal(detectFrustration(turns), null, "the tool result stays out of the prose heuristics");
});

test("#701 — a declined question, or a pair no AskUserQuestion call precedes, does not count", () => {
  const declined = turnsOf([
    user("Richte das Mono-Repo ein."),
    ask("toolu_02"),
    toolResult("toolu_02", "The user doesn't want to proceed with this tool use. The tool use was rejected."),
  ]);
  assert.equal(detectArchitectureDecision(declined), null);

  const otherTool = turnsOf([
    user("Zeig mir die Konfiguration."),
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_03", name: "Bash", input: { command: "cat .env" } }] },
    },
    toolResult("toolu_03", `"${QUESTION}"="${ANSWER}"`),
  ]);
  assert.equal(detectArchitectureDecision(otherTool), null);
});

test("#701 — an answer older than the last five user turns is out of the window", () => {
  const later = ["eins", "zwei", "drei", "vier", "fünf"].flatMap((t) => [user(`weiter mit schritt ${t}`), assistant("erledigt")]);
  const turns = turnsOf([user("Richte das Mono-Repo ein."), ask("toolu_04"), answered("toolu_04"), ...later]);
  assert.equal(detectArchitectureDecision(turns), null);
  // …and inside the window it still fires.
  assert.ok(detectArchitectureDecision(turnsOf([user("Richte das Mono-Repo ein."), ask("toolu_04"), answered("toolu_04"), ...later.slice(0, 8)])));
});
