/**
 * Der Evidenzentscheid im Schattenlauf (#264, §10.4 Stufe 2, §21.1).
 *
 * Das Prädikat selbst ist in `core/__tests__/evidence-decision.test.ts`
 * geprüft. Hier geht es um die LAUFZEIT: dass er auf dem echten Recall-Pfad
 * läuft, dass sein Ereignis die Merkmale trägt — und vor allem, dass er nichts
 * tut. Ein Schatten, der die Antwort verändert, ist kein Schatten, und das
 * fiele erst auf, wenn jemand die Hinweise vermisst.
 *
 * Dazu die drei Auflagen, die mit diesem Teilpaket scharf werden:
 *
 *  - Eigene Ereignisklasse. Das `no_answer` aus §10.3 („die Evidenz reicht für
 *    keine Ausspielung") ist nicht das aus §8.5 („die Suche wurde erschöpft").
 *    Ein gemeinsames Feld wäre die Einladung, sie zu addieren
 *    (C-052/C-056/C-061).
 *  - Ein Budget-Abbruch ist keine Abstention: Der degraded-Fall ist am Event
 *    markiert, damit die Quote ihn ausschließen kann (C-047/C-052).
 *  - Kein Inhalt im Event (#377): keine Query-Rohtexte, keine Frontmatter, keine
 *    Pfade.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/evidence-shadow.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { startHttpServer } from "../src/http.js";

const GEHEIM = "Hausratversicherung Allianz Police 4711";

function memo(id: string, title: string, trigger: string, body: string): string {
  return [
    "---", `id: ${id}`, `title: ${title}`, "type: reference", `summary: ${title}`,
    "topic_path:", "  - test", "tags:", "  - test", "scope: evidence-test",
    "recall_when:", `  - ${trigger}`, "created: 2026-01-01", "updated: 2026-01-01",
    "---", "", body, "",
  ].join("\n");
}

function httpPost(port: number, path: string, payload: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw || "{}") }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function readEvents(logDir: string, kind: string): Promise<Record<string, unknown>[]> {
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 40));
    let files: string[];
    try { files = await readdir(logDir); } catch { continue; }
    const out: Record<string, unknown>[] = [];
    for (const f of files.filter((n) => n.startsWith("events-"))) {
      const raw = await readFile(join(logDir, f), "utf8");
      for (const line of raw.split("\n")) {
        if (line.includes(`"${kind}"`)) out.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
    if (out.length > 0) return out;
  }
  return [];
}

async function daemon(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-evid-vault-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-evid-logs-"));
  await writeFile(join(dir, "a.md"), memo("a", "Deployment-Strategie", "wenn wir deployen", "Text über deployen."), "utf8");
  await writeFile(join(dir, "b.md"), memo("b", GEHEIM, "wenn die Police faellig ist", "Police 4711."), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const prev = process.env.BASTRA_LOG_PATH;
  process.env.BASTRA_LOG_PATH = logDir;
  const telemetry = new Telemetry();
  if (prev === undefined) delete process.env.BASTRA_LOG_PATH;
  else process.env.BASTRA_LOG_PATH = prev;
  const handle = await startHttpServer({
    port: 0, vault, search, telemetry, version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
  });
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    await handle.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { port: handle.port!, logDir };
}

// ── Der Schatten wirkt nicht ────────────────────────────────────

test("die Antwort ist dieselbe, ob der Entscheid läuft oder nicht — er filtert nichts", async (t) => {
  const d = await daemon(t);
  const res = await httpPost(d.port, "/hook/recall", { query: "deployen", k: 5 });
  assert.equal(res.status, 200);
  const hits = res.json.hits as { id: string }[];
  assert.ok(hits.length > 0, "der Recall trifft");

  const events = await readEvents(d.logDir, "evidence_decision");
  assert.equal(events.length, 1, "der Entscheid lief");
  const decisions = events[0].decisions as { memory_id: string }[];
  assert.deepEqual(
    decisions.map((x) => x.memory_id),
    hits.map((h) => h.id),
    "je Treffer eine Entscheidung, in derselben Reihenfolge — und kein Treffer weniger",
  );
  assert.equal(events[0].shadow, true, "ein Leser muss Schatten von Wirkbetrieb trennen können");
});

test("auch ein `no_answer` entfernt keinen Treffer aus der Antwort", async (t) => {
  const d = await daemon(t);
  // Eine Anfrage ohne jede Evidenzgrundlage: trifft lexikalisch, aber weder
  // Trigger noch Scope noch zwei Arme.
  const res = await httpPost(d.port, "/hook/recall", { query: "text", k: 5 });
  const hits = res.json.hits as { id: string }[];
  const events = await readEvents(d.logDir, "evidence_decision");
  const decisions = events[0].decisions as { decision: string }[];
  assert.ok(
    decisions.some((x) => x.decision === "no_answer" || x.decision === "optional"),
    "die Anfrage trägt keine Pflicht",
  );
  assert.equal(
    (events[0].decisions as unknown[]).length,
    hits.length,
    "die Antwort behält jeden Treffer — der Entscheid ist Beobachtung, nicht Filter",
  );
});

// ── Was im Event steht, und was nicht ───────────────────────────

test("das Event trägt die Evidenzmerkmale und die Zählung", async (t) => {
  const d = await daemon(t);
  await httpPost(d.port, "/hook/recall", { query: "deployen", k: 5 });
  const [e] = await readEvents(d.logDir, "evidence_decision");
  const first = (e.decisions as Record<string, unknown>[])[0];
  const ev = first.evidence as Record<string, unknown>;
  for (const key of [
    "exact_identifier",
    "recall_when_coverage",
    "arm_agreement",
    "scope_match",
    "temporal_status",
  ]) {
    assert.ok(key in ev, `${key} fehlt`);
  }
  assert.ok(!("source_confidence" in ev), "C-049: bleibt abwesend");
  const counts = e.counts as Record<string, number>;
  assert.equal(
    counts.required + counts.optional + counts.no_answer,
    (e.decisions as unknown[]).length,
    "die Zählung deckt jede Entscheidung ab — Grundlage der Shadow-Acceptance",
  );
});

test("kein Query-Rohtext und kein Vault-Inhalt im Event (#377)", async (t) => {
  const d = await daemon(t);
  await httpPost(d.port, "/hook/recall", { query: "Police 4711 Allianz", k: 5 });
  const [e] = await readEvents(d.logDir, "evidence_decision");
  const raw = JSON.stringify(e);
  assert.ok(!raw.includes("Police 4711 Allianz"), "die Anfrage steht nicht im Event");
  assert.ok(!raw.includes(GEHEIM), "kein Titel, keine Frontmatter");
  assert.ok(!raw.includes("/tmp/"), "keine Pfade");
  // Die id ist ein Name, kein Inhalt — sie darf und soll drinstehen.
  assert.match(raw, /"memory_id":"[ab]"/);
});

test("die #263-Dimensionen laufen automatisch mit", async (t) => {
  const d = await daemon(t);
  await httpPost(d.port, "/hook/recall", {
    query: "deployen", k: 5, session_id: "s-264", client: "claude-code", hook_source: "pre-tool",
  });
  const [e] = await readEvents(d.logDir, "evidence_decision");
  const dims = e.dimensions as Record<string, unknown>;
  assert.equal(dims.client, "claude-code");
  assert.equal(dims.hook_source, "pre-tool");
  assert.ok(dims.experiment_session, "das Session-Pseudonym");
  assert.notEqual(dims.experiment_session, "s-264", "§23: nie die rohe id");
});

// ── Die Trennung, die hier scharf wird ──────────────────────────

test("der Entscheid hat eine eigene Ereignisklasse — nicht ein Feld am Recall", async (t) => {
  const d = await daemon(t);
  await httpPost(d.port, "/hook/recall", { query: "deployen", k: 5 });
  const recalls = await readEvents(d.logDir, "hook_recall");
  assert.ok(recalls.length > 0);
  const raw = JSON.stringify(recalls[0]);
  assert.ok(!raw.includes('"decision"'), "der Recall trägt keinen Entscheid");
  assert.ok(!raw.includes("no_answer"), "und kein no_answer — §10.3 und §8.5 dürfen nie ein Feld teilen");
});

test("das Event markiert den unvollständigen Retrievalpfad", async (t) => {
  const d = await daemon(t);
  await httpPost(d.port, "/hook/recall", { query: "deployen", k: 5 });
  const [e] = await readEvents(d.logDir, "evidence_decision");
  // Ohne Vektorarm ist dieser Lauf nicht degradiert, sondern lexikalisch von
  // vornherein — das Feld muss trotzdem da sein, weil die Abstentionsquote es
  // liest (C-047/C-052).
  assert.equal(typeof e.degraded, "boolean");
});

// ── Teilpaket 3: Flag, Fallback, fail-open ──────────────────────

/**
 * Der Gate wird über `runHookRecall` direkt geprüft statt über die Route: Das
 * Flag ist eine Deps-Frage, und die Route reicht es nur durch. So lässt sich
 * derselbe Aufruf einmal mit und einmal ohne Flag fahren — der Vergleich IST
 * die Aussage.
 */
import { runHookRecall } from "../src/http-hook-routes.js";
import type { RecallDecisionHit } from "@bastra-recall/core";

async function vaultFixture(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-gate-"));
  await writeFile(join(dir, "a.md"), memo("a", "Deployment-Strategie", "wenn wir deployen", "Text über deployen."), "utf8");
  await writeFile(join(dir, "b.md"), memo("b", "Kochbuch", "wenn wir kochen", "Text über deployen und kochen."), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { vault, search, telemetry };
}

const ids = (payload: Record<string, unknown>): string[] =>
  (payload.hits as { id: string }[]).map((h) => h.id);

test("Flag aus: die Antwort ist die heutige — der Entscheid wirkt auf nichts", async (t) => {
  const f = await vaultFixture(t);
  const aus = await runHookRecall({ query: "deployen", k: 5 }, "deployen", Date.now(), f);
  // Alles, was der Recall findet, steht in der Antwort.
  assert.ok(ids(aus).length >= 2, "beide Memories treffen auf `deployen`");
});

test("Flag an: ein `no_answer` wird respektiert — der Treffer verschwindet", async (t) => {
  const f = await vaultFixture(t);
  const aus = await runHookRecall({ query: "deployen", k: 5 }, "deployen", Date.now(), f);
  const an = await runHookRecall({ query: "deployen", k: 5 }, "deployen", Date.now(), {
    ...f,
    evidenceGateEnabled: () => true,
    // Ein Entscheid, der genau einen Treffer als no_answer führt.
    decideFn: ((hits: { id: string }[]) =>
      hits.map((h, i) => ({
        id: h.id,
        decision: i === 0 ? "no_answer" : "optional",
        evidence: {
          exact_identifier: false,
          recall_when_coverage: 0,
          arm_agreement: false,
          scope_match: false,
          temporal_status: "unknown",
        },
      })) as unknown as RecallDecisionHit[]) as never,
  });
  assert.equal(ids(an).length, ids(aus).length - 1, "genau der eine fehlt");
  assert.ok(!ids(an).includes(ids(aus)[0]), "und zwar der als no_answer entschiedene");
});

test("Flag an, aber der Entscheid ist defekt: die Antwort bleibt vollständig", async (t) => {
  const f = await vaultFixture(t);
  const aus = await runHookRecall({ query: "deployen", k: 5 }, "deployen", Date.now(), f);
  const kaputt = await runHookRecall({ query: "deployen", k: 5 }, "deployen", Date.now(), {
    ...f,
    evidenceGateEnabled: () => true,
    decideFn: (() => {
      throw new Error("Controller-Defekt");
    }) as never,
  });
  // fail-open wie überall auf dem Hook-Pfad: Ein Defekt im Entscheid darf die
  // Antwort nicht kosten (C-047 — er geht in keine Statistik und in keine
  // Unterdrückung).
  assert.deepEqual(ids(kaputt), ids(aus), "kein Treffer verloren");
});

test("Flag an, alle no_answer: die Antwort ist leer — und das ist die Aussage, nicht ein Fehler", async (t) => {
  const f = await vaultFixture(t);
  const an = await runHookRecall({ query: "deployen", k: 5 }, "deployen", Date.now(), {
    ...f,
    evidenceGateEnabled: () => true,
    decideFn: ((hits: { id: string }[]) =>
      hits.map((h) => ({
        id: h.id,
        decision: "no_answer",
        abstain_reason: "no_evidence",
        evidence: {
          exact_identifier: false,
          recall_when_coverage: 0,
          arm_agreement: false,
          scope_match: false,
          temporal_status: "unknown",
        },
      })) as unknown as RecallDecisionHit[]) as never,
  });
  assert.deepEqual(ids(an), [], "§10.3: reicht die Evidenz für keine Ausspielung, wird nichts ausgespielt");
  assert.equal(typeof an.vault_size, "number", "die Antwort bleibt wohlgeformt");
});
