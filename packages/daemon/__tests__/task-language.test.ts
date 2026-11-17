import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import ts from "typescript";
import { friendlyTaskError, friendlyTaskResult } from "../src/cli/task-friendly.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
/** Every task source file: the daemon's task modules and the `bastra tasks` CLI. */
function taskSourceFiles(): string[] {
  const daemon = readdirSync(SRC)
    .filter((f) => /^task-.*\.ts$/.test(f))
    .map((f) => join(SRC, f));
  const cli = readdirSync(join(SRC, "cli"))
    .filter((f) => /^tasks?-.*\.ts$/.test(f))
    .map((f) => join(SRC, "cli", f));
  return [...daemon, ...cli];
}
/** A German table is an object under a `de` key or a `const de`. */
function insideGermanTable(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isPropertyAssignment(n) && n.name.getText() === "de") return true;
    if (ts.isVariableDeclaration(n) && n.name.getText() === "de") return true;
  }
  return false;
}
// Umlauts and ß mark German text; the check reads characters, not word lists.
const GERMAN_LETTERS = /[äöüÄÖÜß]/;

test("#1602 German literals in the task files live only in the language tables", () => {
  const found: string[] = [];
  const files = taskSourceFiles();
  assert.ok(files.length > 30, "the scan reaches the task files");
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      const literal =
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node);
      if (literal && GERMAN_LETTERS.test(node.getText()) && !insideGermanTable(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push(`${file.slice(SRC.length)}:${line + 1} ${node.getText().slice(0, 60)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(found, []);
});

test("#1602 the task CLI is English as a whole without language.primary, German only for de", () => {
  const task = {
    id: "t1",
    goal: "Check",
    schedule: { kind: "instant", at: Date.parse("2026-10-12T16:00:00Z") },
    timezone: "Europe/Madrid",
    armed: true,
    state: "due",
    action_level: "notify",
    deliveries: [{ last_attempt: 1 }],
    review_reason: "Reconciliation required: execution outcome unknown",
    last_failure: { code: "source_budget", message: "Source byte limit exceeded" },
  };
  const status = {
    controls: { enabled: true, muted: false, execution_stopped: true },
    runtime: { running: true, next_tick: 0, last_error: null, backoff_ms: 0 },
    tasks: [task],
    sources: [{ id: "s", enabled: true }],
    adapters: [],
    capacity: { intents: 0, intent_limit: 1000, receipts: 0, receipt_limit: 10000 },
    intents: [{ id: "i", state: "unknown", target_id: "x" }],
    receipts: [],
    leases: [{ id: "l", state: "active", expires_at: 1 }],
  };
  for (const language of [undefined, "en", "fr"]) {
    const text = [
      friendlyTaskResult("status", status, language),
      friendlyTaskResult("list", { tasks: [] }, language),
      friendlyTaskResult("due", { cards: [] }, language),
      friendlyTaskError("validation", "create", "duration_format", language),
    ].join("\n");
    assert.doesNotMatch(text, GERMAN_LETTERS, String(language));
    assert.match(text, /Feature: on · Automation: running/);
    assert.match(text, /Review: "Reconciliation required: execution outcome unknown"/);
    assert.match(text, /No tasks\./);
  }
  const german = friendlyTaskResult("status", status, "de");
  assert.match(german, /Funktion: an · Automatik: läuft/);
  assert.match(german, /Prüfung: "Abgleich nötig: unklarer Ausführungsausgang"/, "stored English text shown in German");
  assert.match(german, /Absicht i: Ausgang unklar/);
  assert.match(friendlyTaskError("validation", "create", "duration_format", "de"), /Dauer mit --after/);
});
