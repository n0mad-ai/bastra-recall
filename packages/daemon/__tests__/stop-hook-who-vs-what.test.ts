/**
 * Wer-sagt-es vs. was-ist-passiert (05.09.2026).
 *
 * Zweimal hintereinander hatte die Stop-Lane denselben Fehlertyp: Eine
 * Heuristik prüfte, WER etwas tippt, statt WAS passiert ist. #476 — die
 * Cue-Listen waren deutsch, ein russisch schreibender Nutzer konnte nie einen
 * Save-Anstoß bekommen. Danach Feature-Completion — "git commit" musste aus
 * einem USER-Turn kommen, ein Agent, der selbst committet, konnte nie einen
 * auslösen.
 *
 * Dieser Test füttert jede Heuristik mit einem reinen Agent-Transkript: kein
 * Nutzer-Turn enthält ein Signalwort, das Ereignis ist trotzdem beobachtbar.
 * Für jede Heuristik steht hier EXPLIZIT, ob sie an den Menschen gebunden
 * ist und warum — eine Bindung, die still entsteht, bricht den Test; eine
 * Bindung, die gewollt ist, steht mit Begründung in der Tabelle.
 *
 * Runner: `tsx --test __tests__/stop-hook-who-vs-what.test.ts`
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  detectFrustration,
  detectFeatureCompletion,
  detectArchitectureDecision,
  evaluateHeuristics,
  normalizeTurns,
} from "../src/stop-lane.js";

// Der Nutzer sagt in JEDEM Turn nur "ok" — kein Cue in keiner Sprache.
const USER_OK = { role: "user", content: "ok" };

// Fünf existierende Quellpfade, wie der Agent sie beim Editieren nennt.
const EDITED =
  "edited packages/daemon/src/stop-lane.ts, packages/daemon/src/taxonomy.ts, " +
  "packages/daemon/src/hook.ts, packages/daemon/__tests__/stop-hook.test.ts, " +
  "packages/daemon/src/cli/adapters/claude-code.ts";

const ALL_EXIST = { cwd: "/repo", fileExists: () => true };

/**
 * Die Bindungs-Tabelle. `humanBound: true` heißt: Das Ereignis IST eine
 * Äußerung des Menschen und kann in einem reinen Agent-Transkript gar nicht
 * vorkommen — die Heuristik darf dort nicht feuern. `false` heißt: Das
 * Ereignis ist beobachtbar, egal wer es ausgelöst hat — die Heuristik MUSS
 * feuern. Wer hier einen Eintrag ändert, ändert einen Produktvertrag.
 */
const BINDING = {
  "frustration-density": {
    humanBound: true,
    why: "Frustration ist ein Gefühl des Nutzers; der Agent hat keins, das zu speichern wäre.",
  },
  "architecture-decision": {
    humanBound: true,
    why: "Architektur entscheidet der Mensch (§3 der Arbeitsregeln); ein Agent, der 'entschieden' schreibt, hat nichts entschieden.",
  },
  "feature-completion": {
    humanBound: false,
    why: "Ein Commit ist ein Ereignis im Repo, egal wer ihn getippt hat.",
  },
} as const;

describe("stop-lane: who says it vs. what happened", () => {
  it("frustration-density: agent prose full of frustration words is not the user's frustration", () => {
    const turns = [
      { role: "assistant", content: "schon wieder kaputt, again and again, снова, wie oft denn noch — FEHLER FEHLER" },
      USER_OK,
      { role: "assistant", content: "wieder das gleiche! again! снова!" },
      USER_OK,
    ];
    const fired = detectFrustration(turns) !== null;
    assert.equal(fired, !BINDING["frustration-density"].humanBound, BINDING["frustration-density"].why);
  });

  it("architecture-decision: agent prose with decision cues is not a decision", () => {
    const turns = [
      { role: "assistant", content: "ok dann, lass uns, entschieden, decided, settled on, решено — final." },
      USER_OK,
    ];
    const fired = detectArchitectureDecision(turns) !== null;
    assert.equal(fired, !BINDING["architecture-decision"].humanBound, BINDING["architecture-decision"].why);
  });

  it("feature-completion: an agent-run commit with no user signal word IS a commit", () => {
    // Genau die Form, in der Claude Code einen Agent-Commit aufzeichnet:
    // tool_use im Assistant-Content, Ergebnis als tool_result im User-Turn.
    const turns = normalizeTurns([
      { type: "user", message: { role: "user", content: "ok" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: EDITED },
            { type: "tool_use", name: "Bash", input: { command: "git add -A && git commit -q -m 'feat: x'" } },
          ],
        },
      },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "" }] } },
    ]);
    assert.ok(!turns.some((t) => t.role === "user" && /commit/i.test(t.content)), "fixture: no user turn mentions a commit");
    const fired = detectFeatureCompletion(turns, ALL_EXIST) !== null;
    assert.equal(fired, !BINDING["feature-completion"].humanBound, BINDING["feature-completion"].why);
  });

  it("feature-completion: the current Codex custom_tool_call is also an agent-run commit", () => {
    const turns = normalizeTurns([
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "ok" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: EDITED }] } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          input: 'const r = await tools.exec_command({ cmd: "git add -A && git commit -m codex" });',
        },
      },
    ]);
    assert.ok(!turns.some((t) => t.role === "user" && /commit/i.test(t.content)), "fixture: no user turn mentions a commit");
    const fired = detectFeatureCompletion(turns, ALL_EXIST) !== null;
    assert.equal(fired, !BINDING["feature-completion"].humanBound, BINDING["feature-completion"].why);
  });

  it("the table covers every heuristic evaluateHeuristics knows", () => {
    // Eine neue Heuristik ohne Eintrag hier hat ihre Bindung nicht erklärt.
    // Ein Transkript, das alle drei bekannten Signale trägt, liefert alle
    // Heuristik-Namen; jeder muss in BINDING stehen.
    const turns = normalizeTurns([
      { type: "user", message: { role: "user", content: "wieder kaputt, schon wieder, wie oft denn noch, wieder!" } },
      { type: "user", message: { role: "user", content: "wieder und wieder — ok dann, entschieden: git commit" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: EDITED }] } },
    ]);
    const names = evaluateHeuristics(turns, ALL_EXIST).map((s) => s.heuristic);
    assert.deepEqual([...names].sort(), Object.keys(BINDING).sort(), "every heuristic must declare its binding in BINDING");
  });
});
