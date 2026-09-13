/**
 * Die Mindest-N-Prüfung der Armauswertung (#437, §18.1/§17.4).
 *
 * Die Regel, die diese Tests verteidigen, steht nicht im Code, sondern in der
 * committeten Registrierung und in §26.1: Die Auswertung des Retrieval-/
 * Präsentationsexperiments weist „einen Arm unterhalb des Mindest-N
 * ausdrücklich als **nicht auswertbar** aus statt als Nullbefund". Eine Quote
 * ist die Form, in der ein Ergebnis auftritt — sie unter dem Mindest-N zu
 * drucken macht den Messvertrag operativ falsch, nicht bloß unvollständig.
 *
 * Run: npx tsx --test packages/daemon/__tests__/stats-arms.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  armIdentities,
  evaluateArms,
  loadMinNRule,
  minNRuleFrom,
  sessionsPerArm,
} from "../src/stats-arms.js";
import { buildTelemetryReport } from "../src/telemetry-report.js";
import { aggregate, renderStats } from "../src/cli/log-stats.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REGISTRATION = "packages/eval/registrations/presentation-experiment.json";

const IDENTITY = {
  experiment: "presentation-vs-retrieval",
  registration: REGISTRATION,
  registration_version: 1,
};

function row(arm: string, session: string, identity = true): unknown {
  return {
    dimensions: {
      arm,
      experiment_session: session,
      ...(identity ? IDENTITY : {}),
    },
  };
}

test("#437: an arm below its registered min-N is NOT EVALUABLE, not a rate", () => {
  const events = [row("a", "s1"), row("a", "s1"), row("a", "s2"), row("b", "s3")];
  const arms = evaluateArms(events, { minN: 50, reportingRule: null, fallbackVerdict: null }, null);
  assert.equal(arms.get("a")?.evaluable, false);
  assert.equal(arms.get("a")?.sessions, 2, "die Versuchseinheit ist die Session, nicht das Ereignis");
  assert.match(arms.get("a")!.why, /2 session\(s\) of the registered min-N 50/);
  assert.equal(arms.get("b")?.evaluable, false);
});

test("#437: an arm that reached its min-N stays evaluable", () => {
  // Die Gegenprobe: Die Prüfung darf nicht einfach alles sperren.
  const events = Array.from({ length: 12 }, (_, i) => row("a", `s${i}`));
  const arms = evaluateArms(events, { minN: 10, reportingRule: null, fallbackVerdict: null }, null);
  assert.equal(arms.get("a")?.evaluable, true);
  assert.equal(arms.get("a")?.sessions, 12);
  assert.equal(arms.get("a")?.why, "");
});

test("#437: the experimental unit is the session — 300 events of one session are one unit", () => {
  // §17.4: „Eine Session verbleibt für alle zugehörigen Ereignisse im selben
  // Arm." Über Ereignisse zu zählen ignorierte diese Clusterung und käme auf
  // ein Vielfaches der tatsächlichen Fallzahl.
  const events = Array.from({ length: 300 }, () => row("a", "eine-einzige-session"));
  assert.equal(sessionsPerArm(events).get("a")?.size, 1);
  const arms = evaluateArms(events, { minN: 50, reportingRule: null, fallbackVerdict: null }, null);
  assert.equal(arms.get("a")?.evaluable, false);
});

test("#437: the committed registration carries no min_n_per_arm — every arm is NOT EVALUABLE", () => {
  // Die verbindliche Regel wird GELESEN, nicht im Code angenommen: Die
  // Registrierung hat `min_n_per_arm: null` und trägt stattdessen ihren
  // gemessenen Underpowered-Fallback.
  const { rule, error } = loadMinNRule(REGISTRATION, [REPO_ROOT]);
  assert.equal(error, null, "die committete Registrierung muss auffindbar sein");
  assert.equal(rule?.minN, null);
  assert.equal(rule?.fallbackVerdict, "not_evaluable_on_current_population");
  assert.match(rule!.reportingRule!, /NICHT AUSWERTBAR/);

  const arms = evaluateArms([row("a", "s1"), row("b", "s2")], rule, error);
  assert.equal(arms.get("a")?.evaluable, false);
  assert.match(arms.get("a")!.why, /no min_n_per_arm/);
});

test("#437: rows without a registration identity cannot be cleared against any min-N", () => {
  const arms = evaluateArms(
    [row("a", "s1", false), row("a", "s2", false)],
    { minN: 1, reportingRule: null, fallbackVerdict: null },
    null,
  );
  assert.equal(arms.get("a")?.evaluable, false);
  assert.match(arms.get("a")!.why, /no registration identity/);
});

test("#437: rows from two registrations are not pooled into one arm", () => {
  const other = {
    dimensions: { arm: "a", experiment_session: "s9", ...IDENTITY, registration_version: 2 },
  };
  const events = [row("a", "s1"), other];
  assert.equal(armIdentities(events).length, 2);
  const arms = evaluateArms(events, { minN: 1, reportingRule: null, fallbackVerdict: null }, null);
  assert.equal(arms.get("a")?.evaluable, false);
  assert.match(arms.get("a")!.why, /2 different registrations/);
});

test("#437: `unassigned` gets no arm verdict — it is the absence of an arm", () => {
  const arms = evaluateArms([row("unassigned", "s1")], null, null);
  assert.equal(arms.has("unassigned"), false);
});

test("minNRuleFrom reads a real number and rejects a nonsensical one", () => {
  assert.equal(minNRuleFrom({ min_n_per_arm: 255 }).minN, 255);
  assert.equal(minNRuleFrom({ min_n_per_arm: 0 }).minN, null, "0 ist kein Mindest-N");
  assert.equal(minNRuleFrom({ min_n_per_arm: "viele" }).minN, null);
  assert.equal(minNRuleFrom({}).minN, null);
});

test("loadMinNRule says which registration it could not find, instead of passing silently", () => {
  const { rule, error } = loadMinNRule("packages/eval/registrations/gibt-es-nicht.json", [REPO_ROOT]);
  assert.equal(rule, null);
  assert.match(error!, /was not found/);
});

// ── Die Ausgabeflächen, jede einzeln ───────────────────────────
//
// §18.1 verlangt nicht, dass IRGENDWO „not evaluable" steht, sondern dass ein
// unterbesetzter Arm NIRGENDS wie eine Entscheidungsgrundlage aussieht. Das
// Repo hat drei Flächen, auf denen ein Armvergleich landen könnte, und jede
// wird hier einzeln geprüft: das Statistik-Skript (CLI), der JSON-Report unter
// GET /ui/telemetry (zugleich die Web-/Dev-Telemetrieansicht) und
// `bastra logs --stats`.

const exec = promisify(execFile);

/** Ein Log mit zwei besetzten Armen — 1 bzw. 1 Session, also weit unter jedem N. */
function underpoweredLog(): unknown[] {
  const events: unknown[] = [];
  const plan: Array<[string, string, number]> = [
    ["wording_current", "aaaaaaaaaaaaaaa1", 3],
    ["wording_variant", "bbbbbbbbbbbbbbb1", 2],
  ];
  let n = 0;
  for (const [arm, session, calls] of plan) {
    for (let i = 0; i < calls; i++) {
      const recall_id = `r${++n}`;
      events.push({
        kind: "hook_recall",
        ts: "2026-09-10T10:00:00.000Z",
        recall_id,
        tool_name: "Write",
        latency_ms_total: 40,
        hint_count: 1,
        hits: [{ id: "m1", score: 120 }],
        dimensions: {
          client: "claude-code",
          hook_source: "pre-tool",
          experiment_session: session,
          arm,
          ...IDENTITY,
        },
      });
      events.push({
        kind: "recall_episode",
        ts: "2026-09-10T10:00:05.000Z",
        recall_id,
        band: "required",
        surfaced: true,
        acted_on: true,
      });
    }
  }
  return events;
}

test("#437: the shipped CLI report prints NOT EVALUABLE and no arm rate", async () => {
  // Die reinen Funktionen oben beweisen die Regel, nicht die Ausgabe. Genau
  // dort saß der Befund: Der Report druckte für einen unterbesetzten Arm eine
  // gewöhnliche Quote, die wie eine Entscheidungsgrundlage aussieht.
  const logDir = await mkdtemp(join(tmpdir(), "bastra-437-logs-"));
  try {
    const events = underpoweredLog();
    await writeFile(
      join(logDir, "events-2026-09-10.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );

    const { stdout } = await exec(
      process.execPath,
      ["--import", "tsx", join(REPO_ROOT, "packages/daemon/scripts/stats.ts")],
      { cwd: REPO_ROOT, env: { ...process.env, BASTRA_LOG_PATH: logDir } },
    );

    const armLines = stdout
      .split("\n")
      .slice(stdout.split("\n").findIndex((l) => l.includes("by arm:")) + 1)
      .filter((l) => l.includes("wording_"));
    assert.equal(armLines.length, 2, `expected two arm lines, got:\n${stdout}`);
    for (const line of armLines) {
      assert.match(line, /NOT EVALUABLE/, `an underpowered arm must say so: ${line}`);
      assert.doesNotMatch(line, /%/, `no rate may be printed for an underpowered arm: ${line}`);
    }
    assert.match(stdout, /never as a null result/);
  } finally {
    await rm(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("#437: the JSON/web telemetry report publishes no arm rate at all", () => {
  // GET /ui/telemetry liefert genau dieses Objekt — es ist zugleich die
  // JSON-Fläche und die Datenquelle des Telemetry-Tabs (#463). Ein Armvergleich
  // wäre hier eine ZWEITE Auswertung, die die Mindest-N-Prüfung aus stats.ts
  // nicht durchläuft. Solange die Fläche keinen Arm kennt, kann sie auch keinen
  // unterbesetzten als Ergebnis zeigen; wer das ändert, macht diesen Test rot
  // und muss die Prüfung mitbringen.
  const events = underpoweredLog();
  const report = buildTelemetryReport(
    { events: events as never[], files: 1, from: "2026-09-10T10:00:00.000Z", to: "2026-09-10T10:00:05.000Z" },
    7,
    { mustLoadScore: 100, scoreFloor: 30 },
    7,
  );
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /wording_current|wording_variant/, "no arm may appear as a grouping key");
  assert.doesNotMatch(serialized, /"arm"|"arms"/, "no arm section may appear");
});

test("#437: `bastra logs --stats` publishes no arm rate either", () => {
  // Die zweite CLI-Fläche. Sie schlüsselt nach Lane auf, nicht nach Arm — und
  // darf es ohne die Mindest-N-Prüfung auch nicht tun.
  const out = renderStats(aggregate(underpoweredLog() as never[]));
  assert.doesNotMatch(out, /wording_current|wording_variant/);
  assert.doesNotMatch(out, /\barm\b/i);
});
