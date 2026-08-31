/**
 * Die SessionStart-Lane holt ihren Kontext in EINEM Aufruf (#265, §16.1, §26.1).
 *
 * Die Geschichte dieser Datei in zwei Schritten:
 *
 *  1. #369 zog die Pipeline aus dem Hook-Prozess in den Daemon — das sparte den
 *     Node-Start, ließ die Aufrufe aber sequenziell. Teilpaket 1 machte sie
 *     nebenläufig: drei Recalls, dann sechs Seitenabrufe, Höchststand 6.
 *  2. Teilpaket 4 ersetzt beides durch einen einzigen Aufruf gegen den
 *     projektbewussten Assembler. Die Nebenläufigkeit ist nicht verschwunden,
 *     sie ist umgezogen: Der Assembler erhebt seine sieben Teile in-Prozess
 *     nebeneinander (`session-assembler.test.ts`), ganz ohne HTTP.
 *
 * Was hier gemessen wird, hat sich deshalb geändert — und das ist die Aussage:
 * An der HTTP-Grenze bleiben zwei gleichzeitige Anfragen (Assembler und
 * Health-Probe), nicht mehr zehn nacheinander. Die alten Erwartungen (sechs
 * gleichzeitige Seitenabrufe) beschreiben eine Architektur, die es nicht mehr
 * gibt; sie stehen unten als das, was NICHT mehr passieren darf.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/session-lane-parallel.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { runSessionLane } from "../src/session-lane.js";

const DELAY_MS = 40;

interface Probe {
  port: number;
  peak: number;
  calls: Map<string, number>;
  bodies: Map<string, Record<string, unknown>>;
}

const RECALL_RESP = {
  hits: [
    {
      id: "m1",
      title: "Session fact",
      type: "reference",
      scope: "user-preference",
      summary: "Ein Fakt.",
      score: 150,
      rrf: { rank_bm25: 1, rank_vector: 1, personal_score: 0.03, raw: 0.03 },
    },
  ],
  vault_size: 1,
  latency_ms: 1,
  recall_id: "r1",
  score_kind: "rrf",
};

/** Die Antwort des Assemblers, wie die Lane sie liest. */
const SESSION_CONTEXT = JSON.stringify({
  context: "",
  vault_size: 1,
  blocks: [],
  retrieval: "hybrid",
  budget: {},
  aborted: [],
  data: {
    recalls: [{ scope: "user-preference", resp: RECALL_RESP }],
    floors: [],
    conventions: [],
    care: { open: 0, queued: 0 },
    imports: { open: 0, queued: 0 },
    onboarding: false,
  },
});

const BODIES: Record<string, string> = {
  "/hook/session-context": SESSION_CONTEXT,
  "/health": JSON.stringify({ ok: true }),
  "/hook/hinted": "{}",
};

async function withProbe(fn: (p: Probe) => Promise<void>): Promise<void> {
  let inFlight = 0;
  let peak = 0;
  const calls = new Map<string, number>();
  const bodies = new Map<string, Record<string, unknown>>();

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    calls.set(path, (calls.get(path) ?? 0) + 1);
    inFlight++;
    peak = Math.max(peak, inFlight);
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (raw) {
        try {
          bodies.set(path, JSON.parse(raw) as Record<string, unknown>);
        } catch {
          /* kein JSON — für diese Messung egal */
        }
      }
      setTimeout(() => {
        inFlight--;
        const body = BODIES[path];
        res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
        res.end(body ?? "{}");
      }, DELAY_MS);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await fn({
      port,
      get peak() {
        return peak;
      },
      calls,
      bodies,
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const PAYLOAD = {
  hook_event_name: "SessionStart" as const,
  source: "startup" as const,
  cwd: "/tmp",
  session_id: "s-265",
};

test("die Lane holt ihren Kontext in genau einem Aufruf", async () => {
  await withProbe(async (p) => {
    const out = await runSessionLane(PAYLOAD, `http://127.0.0.1:${p.port}`);
    assert.doesNotThrow(() => JSON.parse(out), "der fail-open-Vertrag: immer ein JSON-Dokument");
    assert.equal(p.calls.get("/hook/session-context"), 1, "genau einmal — nicht null, nicht zweimal");
  });
});

test("die sechs früheren Einzelabrufe finden nicht mehr statt", async () => {
  await withProbe(async (p) => {
    await runSessionLane(PAYLOAD, `http://127.0.0.1:${p.port}`);
    for (const path of [
      "/hook/recall",
      "/hook/floors",
      "/hook/taxonomy",
      "/hook/care",
      "/hook/import",
      "/hook/onboarding",
    ]) {
      assert.equal(p.calls.get(path) ?? 0, 0, `${path} wurde noch aufgerufen`);
    }
  });
});

test("der Health-Probe läuft NEBEN dem Assembler, nicht dahinter", async () => {
  await withProbe(async (p) => {
    await runSessionLane(PAYLOAD, `http://127.0.0.1:${p.port}`);
    // Er gehört zum Update-Block, den der Assembler nicht abdeckt, und hängt an
    // keiner seiner Ausgaben. Liefe er danach, hätte der Umbau die
    // Nebenläufigkeit gegen einen zweiten Round Trip eingetauscht.
    assert.ok(
      p.peak >= 2,
      `Höchststand ${p.peak}: Assembler und Health-Probe liefen nacheinander`,
    );
  });
});

test("die Lane setzt ihre eigenen Mengen und fragt die Cross-Project-Regeln an", async () => {
  await withProbe(async (p) => {
    await runSessionLane(PAYLOAD, `http://127.0.0.1:${p.port}`);
    const body = p.bodies.get("/hook/session-context");
    assert.ok(body, "der Aufruf trägt einen Body");
    assert.equal(body!.cross_project, true, "nur die Lane fragt sie");
    // Ohne diese Zeilen wäre der Umzug eine stille Produktänderung: Der
    // Endpunkt kappt von sich aus bei 4 Konventionen und 5 Floors.
    assert.deepEqual(body!.caps, { conventions: 6, pinned: 0 }, "0 = ungekappt");
  });
});

test("die Lane überschreibt die Hop-Baseline nicht", async () => {
  await withProbe(async (p) => {
    await runSessionLane(PAYLOAD, `http://127.0.0.1:${p.port}`);
    const body = p.bodies.get("/hook/session-context");
    // C-046: Der Assembler-Default ist 1. Die Lane darf ihn nicht auf 0 setzen —
    // der `related_via`-Hop ist der Kontrollarm, den jede neue Sicht schlagen
    // muss, und er verschwände sonst still mit dem Umzug.
    assert.equal(
      (body as Record<string, unknown>).expand_hops,
      undefined,
      "kein Override — die Baseline kommt aus dem Assembler",
    );
  });
});

test("ein unerreichbarer Daemon bleibt fail-open — kein Wurf, ein JSON-Dokument", async () => {
  const out = await runSessionLane(
    { hook_event_name: "SessionStart", source: "startup", cwd: "/tmp" },
    "http://127.0.0.1:1",
  );
  assert.doesNotThrow(() => JSON.parse(out));
});
