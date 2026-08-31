/**
 * Der geteilte Session-Assembler (#265, §16.1, §9.4, §26.1).
 *
 * Vier Zusagen, und die erste ist die, die einen bestehenden Client brechen
 * würde:
 *
 *  1. Der GET-Vertrag bleibt Wort für Wort derselbe. `buildSessionContext` ist
 *     seit dem Umbau nur noch die Projektion „projektlos, ohne Budget" auf
 *     denselben Assembler — wenn dabei auch nur ein Zeichen kippt, liest der
 *     MCP-Forwarder etwas anderes als vorher.
 *  2. Mit Projekt kommt der Projektblock dazu, und die Floors sind
 *     projekt-gescopt statt auf global gefiltert.
 *  3. Budgets greifen nach PRIORITÄT, nicht nach Textreihenfolge, und ein
 *     weggelassener Block sagt, warum er fehlt.
 *  4. §9.4: Ein unvollständiger Hybridpfad gibt sich nicht als vollständig
 *     aus, und ein Deadline-Abbruch ist eine Teilabdeckung — nie `no_answer`.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/session-assembler.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleSessionSections,
  renderSessionContext,
  estimateTokens,
  type SessionContextDeps,
} from "../src/session-assembler.js";
import { buildSessionContext } from "../src/session-context.js";
import { HOOK_SOURCES } from "../src/telemetry-dimensions.js";
import type { ToolDeps } from "../src/tool-handlers.js";

/** Ein Vault-Stub: der Assembler braucht `size()` und `get()`. */
function fakeVault(memories: Record<string, { summary: string; title: string }> = {}) {
  return {
    size: () => 42,
    get: (id: string) =>
      memories[id] ? ({ fm: { summary: memories[id].summary, title: memories[id].title } } as never) : undefined,
  } as never;
}

async function withDeps(
  fn: (toolDeps: ToolDeps, vault: ReturnType<typeof fakeVault>) => Promise<void>,
): Promise<void> {
  // Ein leeres Verzeichnis: care/import/onboarding finden nichts und liefern
  // leere Abschnitte — genau der Zustand, den ein frischer Vault hat.
  const dir = await mkdtemp(join(tmpdir(), "bastra-assembler-"));
  try {
    await fn({ vaultPath: dir } as unknown as ToolDeps, fakeVault({ m1: { summary: "Ein Floor.", title: "F" } }));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const hit = (id: string, summary: string, score = 100) => ({
  id,
  type: "reference",
  summary,
  score,
});

/** Recall-Stub: liefert je Scope eine feste Antwort und merkt sich, womit er
 *  gerufen wurde. */
function recallStub(
  perScope: Record<string, { hits: ReturnType<typeof hit>[]; unfused?: boolean; degraded?: string }>,
) {
  const calls: Array<{ scope: string; options: Record<string, unknown> }> = [];
  const fn = (async (_deps: unknown, args: unknown, options: unknown = {}) => {
    const a = args as { scope: string };
    calls.push({ scope: a.scope, options: (options ?? {}) as Record<string, unknown> });
    return perScope[a.scope] ?? { hits: [] };
  }) as unknown as SessionContextDeps["recallFn"];
  return { fn, calls };
}

const noFloors: SessionContextDeps["listFloorsFn"] = (async () => []) as never;
const noConventions: SessionContextDeps["listConventionsFn"] = (() => []) as never;

/**
 * Ein Erheber, der nicht antwortet — bis der Test ihn freigibt.
 *
 * Eine nackte `new Promise(() => {})` wäre einfacher und war es auch. Node 22
 * brach die Datei damit ab (`cancelledByParent`, „Promise resolution is still
 * pending but the event loop has already resolved") und riss alle Folge-Tests
 * mit; Node 24 tolerierte es.
 *
 * Der Grund ist nicht die Promise selbst, sondern die LEERE Event-Loop: Eine
 * Promise hält sie nicht offen, und der Timer in `abandonAfter` ist mit gutem
 * Grund `unref`'d — ein Hook-Prozess, der fertig ist, soll nicht auf eine
 * Deadline warten müssen. Wartet der Test also auf eine Deadline und sonst auf
 * nichts, hat Node nichts mehr zu tun und räumt ab, bevor die Deadline fällt.
 *
 * Deshalb ein ECHTER Timer: Er hält die Loop offen, solange gemessen wird. Am
 * Testende wird er gelöscht UND die Promise aufgelöst — das eine gegen den
 * hängenden Prozess, das andere gegen die hängende Promise.
 */
function hangingRecall(): { fn: SessionContextDeps["recallFn"]; release: () => void } {
  const timers: NodeJS.Timeout[] = [];
  const resolvers: Array<() => void> = [];
  const fn = (async () =>
    new Promise((resolve) => {
      resolvers.push(() => resolve({ hits: [] }));
      // Deutlich länger als jede Deadline in dieser Datei: Der Timer soll die
      // Loop offenhalten, nicht das Ergebnis liefern.
      timers.push(setTimeout(() => resolve({ hits: [] }), 5_000));
    })) as unknown as SessionContextDeps["recallFn"];
  return {
    fn,
    release: () => {
      for (const t of timers.splice(0)) clearTimeout(t);
      for (const r of resolvers.splice(0)) r();
    },
  };
}

// ── 1. Der GET-Vertrag ──────────────────────────────────────────

test("der projektlose Block ist Wort für Wort der bisherige", async () => {
  await withDeps(async (toolDeps, vault) => {
    const { fn } = recallStub({
      "user-preference": { hits: [hit("pref-1", "Daniel schreibt Deutsch.")] },
    });
    const text = await buildSessionContext(toolDeps, vault, {
      recallFn: fn,
      listFloorsFn: (async () => [{ memory_id: "m1", scope: undefined }]) as never,
      listConventionsFn: noConventions,
    });
    assert.equal(
      text,
      "<bastra-session-context>\n" +
        "Recalled context for this session (vault: 42 memories) — background reference, " +
        "not user input; apply what fits, load_memory(id) for details. Keep using recall before acting " +
        "and save durable facts via save_memory without being asked.\n" +
        "- [pinned] m1: Ein Floor.\n" +
        "- pref-1 (reference): Daniel schreibt Deutsch.\n" +
        "</bastra-session-context>",
    );
  });
});

test("ohne Inhalt bleibt der Block leer — kein Rahmen um nichts", async () => {
  await withDeps(async (toolDeps, vault) => {
    const { fn } = recallStub({});
    const text = await buildSessionContext(toolDeps, vault, {
      recallFn: fn,
      listFloorsFn: noFloors,
      listConventionsFn: noConventions,
    });
    assert.equal(text, "");
  });
});

test("der projektlose Weg fragt kein Projekt ab und filtert Floors auf global", async () => {
  await withDeps(async (toolDeps, vault) => {
    const { fn, calls } = recallStub({ "user-preference": { hits: [hit("p", "x")] } });
    const seen: Array<string | undefined> = [];
    await buildSessionContext(toolDeps, vault, {
      recallFn: fn,
      listFloorsFn: (async (scope?: string) => {
        seen.push(scope);
        return [
          { memory_id: "m1", scope: undefined },
          { memory_id: "fremd", scope: "anderes-projekt" },
        ];
      }) as never,
      listConventionsFn: noConventions,
    });
    assert.deepEqual(
      calls.map((c) => c.scope),
      ["user-preference"],
      "nur der Präferenz-Recall, kein Projekt-Recall",
    );
    assert.deepEqual(seen, [undefined], "Floors ohne Scope-Filter angefragt");
  });
});

// ── 2. Projektbewusst ───────────────────────────────────────────

test("mit Projekt kommt der Projektblock dazu — vor den Präferenzen", async () => {
  await withDeps(async (toolDeps, vault) => {
    const { fn, calls } = recallStub({
      "user-preference": { hits: [hit("pref-1", "Deutsch.")] },
      "bastra-recall": { hits: [hit("proj-1", "Das Projekt nutzt node:test.")] },
    });
    const a = await assembleSessionSections(
      toolDeps,
      vault,
      { project: "bastra-recall" },
      { recallFn: fn, listFloorsFn: noFloors, listConventionsFn: noConventions },
    );
    assert.deepEqual(
      calls.map((c) => c.scope).sort(),
      ["bastra-recall", "user-preference"],
      "beide Recalls laufen",
    );
    const text = renderSessionContext(a.sections, 42);
    assert.ok(text.includes("- proj-1 (reference): Das Projekt nutzt node:test."));
    assert.ok(
      text.indexOf("proj-1") < text.indexOf("pref-1"),
      "der Projektblock steht vor den Präferenzen",
    );
  });
});

test("mit Projekt werden die Floors projekt-gescopt angefragt", async () => {
  await withDeps(async (toolDeps, vault) => {
    const seen: Array<string | undefined> = [];
    await assembleSessionSections(
      toolDeps,
      vault,
      { project: "bastra-recall" },
      {
        recallFn: recallStub({}).fn,
        listFloorsFn: (async (scope?: string) => {
          seen.push(scope);
          return [];
        }) as never,
        listConventionsFn: noConventions,
      },
    );
    assert.deepEqual(seen, ["bastra-recall"]);
  });
});

// ── 3. Budgets ──────────────────────────────────────────────────

test("ein knappes Token-Budget wirft den unwichtigsten Block raus, nicht den obersten", async () => {
  await withDeps(async (toolDeps, vault) => {
    const { fn } = recallStub({
      "user-preference": { hits: [hit("pref-1", "P".repeat(200))] },
    });
    const floors = (async () => [{ memory_id: "m1", scope: undefined }]) as never;
    const voll = await assembleSessionSections(
      toolDeps,
      vault,
      {},
      { recallFn: fn, listFloorsFn: floors, listConventionsFn: noConventions },
    );
    const pinnedCost = voll.reports.find((r) => r.kind === "pinned")!.tokens_est;
    assert.ok(pinnedCost > 0);

    // Budget genau so groß, dass nur der wichtigste Block hineinpasst.
    const knapp = await assembleSessionSections(
      toolDeps,
      vault,
      { budget: { tokens: pinnedCost } },
      { recallFn: fn, listFloorsFn: floors, listConventionsFn: noConventions },
    );
    const pinned = knapp.reports.find((r) => r.kind === "pinned")!;
    const hints = knapp.reports.find((r) => r.kind === "hints")!;
    assert.equal(pinned.included, true, "der gepinnte Floor überlebt — er ist push-by-state");
    assert.equal(hints.included, false);
    assert.equal(hints.omitted, "token_budget", "und sagt, warum er fehlt");
    assert.ok(
      estimateTokens(renderSessionContext(knapp.sections, 42)) > 0,
      "der Block ist nicht leer",
    );
  });
});

test("ein leerer Block meldet `empty`, nicht `token_budget`", async () => {
  await withDeps(async (toolDeps, vault) => {
    const a = await assembleSessionSections(
      toolDeps,
      vault,
      {},
      { recallFn: recallStub({}).fn, listFloorsFn: noFloors, listConventionsFn: noConventions },
    );
    for (const r of a.reports) {
      assert.equal(r.included, false);
      assert.equal(r.omitted, "empty", `${r.kind} hatte nichts zu sagen`);
    }
  });
});

test("die Prioritäten stehen in der Antwort — Reihenfolge ist nicht Priorität", async () => {
  await withDeps(async (toolDeps, vault) => {
    const a = await assembleSessionSections(
      toolDeps,
      vault,
      {},
      { recallFn: recallStub({}).fn, listFloorsFn: noFloors, listConventionsFn: noConventions },
    );
    const p = new Map(a.reports.map((r) => [r.kind, r.priority]));
    assert.ok(p.get("pinned")! < p.get("onboarding")!);
    assert.ok(p.get("project")! < p.get("hints")!);
  });
});

// ── 4. Deadline und §9.4-Marker ─────────────────────────────────

test("ein hängender Teil reißt die Deadline und wird als solcher benannt — die Antwort kommt", async () => {
  await withDeps(async (toolDeps, vault) => {
    const haenger = hangingRecall();
    try {
      const a = await assembleSessionSections(
        toolDeps,
        vault,
        { budget: { time_ms: 40 } },
        {
          recallFn: haenger.fn,
          listFloorsFn: (async () => [{ memory_id: "m1", scope: undefined }]) as never,
          listConventionsFn: noConventions,
        },
      );
      assert.ok(a.aborted.includes("hints"), "der hängende Recall ist als Abbruch vermerkt");
      const hints = a.reports.find((r) => r.kind === "hints")!;
      assert.equal(hints.included, false);
      assert.equal(hints.omitted, "deadline", "Teilabdeckung, kein `no_answer`");
      // Der Rest steht trotzdem: ein Abbruch kostet seinen Teil, nicht die Antwort.
      assert.equal(a.reports.find((r) => r.kind === "pinned")!.included, true);
    } finally {
      haenger.release();
    }
  });
});

test("ein degradierter Recall gibt sich nicht als vollständiger Hybrid aus", async () => {
  await withDeps(async (toolDeps, vault) => {
    const { fn } = recallStub({
      "user-preference": { hits: [hit("p", "x")], degraded: "vector-arm-timeout" },
    });
    const a = await assembleSessionSections(
      toolDeps,
      vault,
      {},
      { recallFn: fn, listFloorsFn: noFloors, listConventionsFn: noConventions },
    );
    assert.equal(a.marker, "degraded");
  });
});

test("ein rein lexikalischer Lauf heißt lexical_only, ein vollständiger hybrid", async () => {
  await withDeps(async (toolDeps, vault) => {
    const lex = recallStub({ "user-preference": { hits: [hit("p", "x")], unfused: true } });
    const a = await assembleSessionSections(
      toolDeps,
      vault,
      {},
      { recallFn: lex.fn, listFloorsFn: noFloors, listConventionsFn: noConventions },
    );
    assert.equal(a.marker, "lexical_only");

    const hyb = recallStub({ "user-preference": { hits: [hit("p", "x")] } });
    const b = await assembleSessionSections(
      toolDeps,
      vault,
      {},
      { recallFn: hyb.fn, listFloorsFn: noFloors, listConventionsFn: noConventions },
    );
    assert.equal(b.marker, "hybrid");
  });
});

test("degraded schlägt lexical_only — der ausgefallene Arm ist die stärkere Aussage", async () => {
  await withDeps(async (toolDeps, vault) => {
    const { fn } = recallStub({
      "user-preference": { hits: [hit("p", "x")], unfused: true, degraded: "vector-arm-empty" },
    });
    const a = await assembleSessionSections(
      toolDeps,
      vault,
      {},
      { recallFn: fn, listFloorsFn: noFloors, listConventionsFn: noConventions },
    );
    assert.equal(a.marker, "degraded");
  });
});

test("ohne Recall gibt es keinen Marker — null heißt nicht `vollständig`", async () => {
  await withDeps(async (toolDeps, vault) => {
    const haenger = hangingRecall();
    try {
      const a = await assembleSessionSections(
        toolDeps,
        vault,
        { budget: { time_ms: 20 } },
        { recallFn: haenger.fn, listFloorsFn: noFloors, listConventionsFn: noConventions },
      );
      assert.equal(a.marker, null);
    } finally {
      haenger.release();
    }
  });
});

// ── #263: die Oberfläche weist sich aus ─────────────────────────

test("der Assembler meldet sich als eigene hook_source, und die steht auf der Allowlist", async () => {
  await withDeps(async (toolDeps, vault) => {
    const { fn, calls } = recallStub({ "user-preference": { hits: [hit("p", "x")] } });
    await assembleSessionSections(
      toolDeps,
      vault,
      { client: "claude-desktop", session_id: "s-265" },
      { recallFn: fn, listFloorsFn: noFloors, listConventionsFn: noConventions },
    );
    assert.equal(calls[0].options.hook_source, "session-context");
    assert.equal(calls[0].options.client, "claude-desktop");
    assert.equal(calls[0].options.session_id, "s-265");
    assert.ok(
      (HOOK_SOURCES as readonly string[]).includes("session-context"),
      "sonst normalisiert die Telemetrie den Wert still auf unknown",
    );
  });
});

/**
 * #429: Dieselbe Zusage auf der ANDEREN Pipeline.
 *
 * Der Test oben prüft den GET-Zweig (`recallHandler`), der die Dimensionen als
 * Optionen bekommt. Die produktive SessionStart-Lane fährt seit #265 den
 * POST-Weg über `runHookRecall`, und der liest `client`/`hook_source` aus dem
 * BODY — stand dort nichts, landete jedes Ereignis dieser Lane als
 * `unknown/unknown`, ausgerechnet die Oberfläche, für die #263 die Splits
 * gebaut hat. Geprüft wird an der Telemetrie und nicht am Aufruf: die Body-
 * Felder sind nur der Weg, die Ereignisspalten sind die Zusage.
 */
test("auch über die Hook-Pipeline tragen Recall UND Entscheid ihre Dimensionen", async () => {
  const { Vault, SearchIndex } = await import("@bastra-recall/core");
  const { writeFile } = await import("node:fs/promises");

  const dir = await mkdtemp(join(tmpdir(), "bastra-sc-dims-"));
  await writeFile(
    join(dir, "a.md"),
    [
      "---", "id: a", "title: session fact", "type: reference", "summary: session fact",
      "topic_path:", "  - test", "tags:", "  - test", "scope: user-preference",
      "recall_when:", "  - session-start preferences active context",
      "created: 2026-01-01", "updated: 2026-01-01", "---", "", "Body.", "",
    ].join("\n"),
    "utf8",
  );
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();

  // Nur die Ereignisse zählen, also reicht ein Telemetrie-Doppel, das sie
  // mitschreibt — ein echter Sink würde hier nur Dateien anlegen.
  const recallEvents: Array<Record<string, unknown>> = [];
  const decisionEvents: Array<Record<string, unknown>> = [];
  let n = 0;
  const telemetry = {
    rotateTurn: () => {},
    newRecallId: () => `r-${++n}`,
    recordHookHints: () => {},
    matchLoadedMemories: () => [],
    logRecallEpisode: async () => {},
    logHookRecall: async (e: Record<string, unknown>) => {
      recallEvents.push(e);
    },
    logEvidenceDecision: async (e: Record<string, unknown>) => {
      decisionEvents.push(e);
    },
  } as never;

  try {
    await assembleSessionSections(
      { vault, search, telemetry, vaultPath: dir } as unknown as ToolDeps,
      vault as never,
      {
        client: "claude-code",
        session_id: "s-429",
        hookRecall: { vault, search, telemetry },
      } as never,
      { listFloorsFn: noFloors, listConventionsFn: noConventions },
    );
    // `fireAndForget` heißt: das Ereignis geht nach dem Recall raus, nicht in ihm.
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(recallEvents.length > 0, "die Lane hat überhaupt Recalls gefahren");
    for (const e of recallEvents) {
      assert.equal(e.hook_source, "session-context");
      assert.equal(e.client, "claude-code");
    }
    assert.ok(decisionEvents.length > 0, "und der Entscheid lief mit");
    for (const e of decisionEvents) {
      assert.equal(e.hook_source, "session-context");
      assert.equal(e.client, "claude-code");
    }
  } finally {
    search.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ── Die Route: GET bleibt, POST kommt dazu ──────────────────────

/**
 * Der Assembler ist oben mit Stubs abgedeckt; hier geht es um die Leitung —
 * dass beide Verben auf demselben Pfad existieren, dass POST den Body liest
 * und dass die Metadaten wirklich in der Antwort stehen. Ein Vertrag, den nur
 * der Handler kennt, ist keiner.
 */
test("GET und POST leben beide auf /hook/session-context", async () => {
  const { Vault, SearchIndex } = await import("@bastra-recall/core");
  const { Telemetry } = await import("../src/telemetry.js");
  const { startHttpServer } = await import("../src/http.js");
  const { writeFile } = await import("node:fs/promises");
  const { request } = await import("node:http");

  const dir = await mkdtemp(join(tmpdir(), "bastra-sc-route-"));
  await writeFile(
    join(dir, "a.md"),
    [
      "---", "id: a", "title: session fact", "type: reference", "summary: session fact",
      "topic_path:", "  - test", "tags:", "  - test", "scope: user-preference",
      "recall_when:", "  - session-start preferences active context",
      "created: 2026-01-01", "updated: 2026-01-01", "---", "", "Body.", "",
    ].join("\n"),
    "utf8",
  );
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const handle = await startHttpServer({
    port: 0, vault, search, telemetry, version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
  });

  const call = (method: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          host: "127.0.0.1", port: handle.port!, path: "/hook/session-context", method,
          headers: payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw || "{}") }));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });

  try {
    const get = await call("GET");
    assert.equal(get.status, 200);
    assert.equal(typeof get.json.context, "string", "der alte Vertrag: context + vault_size");
    assert.equal(get.json.vault_size, 1);
    assert.equal(get.json.blocks, undefined, "GET bleibt schlank — keine neuen Felder");

    const post = await call("POST", { cwd: dir, source: "startup", budget: { time_ms: 500 } });
    assert.equal(post.status, 200);
    assert.equal(typeof post.json.context, "string", "dieselben zwei Felder wie GET");
    assert.equal(post.json.vault_size, 1);
    assert.ok(Array.isArray(post.json.blocks), "plus die Blockliste");
    assert.ok("retrieval" in post.json, "plus der §9.4-Marker");
    assert.ok(Array.isArray(post.json.aborted), "plus die Abbruchliste");
    const budget = post.json.budget as Record<string, number>;
    assert.equal(typeof budget.time_ms, "number");
    assert.equal(typeof budget.tokens, "number");
  } finally {
    search.stop();
    await vault.stop?.();
    await handle.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ── Teilpaket 3: die Hop-Garantien, ausdrücklich ────────────────

/**
 * §13.1/§22, C-046: Der `related_via`-Hop ist der einzige live erprobte
 * semantische Blick des Hook-Pfades und der Kontrollarm, den jede neue Sicht
 * schlagen muss. Er kam bisher zustande, weil der `/hook/recall`-Endpunkt ihn
 * setzt, wenn niemand widerspricht — kein Hook fragt ihn an. Absorbiert der
 * Assembler diese Recalls, verschwände die Baseline stillschweigend.
 */
test("der Assembler nimmt den Hop mit, ohne dass jemand danach fragt", async () => {
  await withDeps(async (toolDeps, vault) => {
    const seen: Array<Record<string, unknown>> = [];
    const fn = (async (_d: unknown, args: unknown) => {
      seen.push(args as Record<string, unknown>);
      return { hits: [] };
    }) as unknown as SessionContextDeps["recallFn"];
    await assembleSessionSections(
      toolDeps,
      vault,
      {},
      { recallFn: fn, listFloorsFn: noFloors, listConventionsFn: noConventions },
    );
    assert.ok(seen.length > 0);
    for (const args of seen) {
      assert.equal(args.expand_hops, 1, "die Baseline gilt als Default, nicht als Auslassung");
    }
  });
});

test("der GET-Weg bleibt hoplos — und zwar ausdrücklich", async () => {
  await withDeps(async (toolDeps, vault) => {
    const seen: Array<Record<string, unknown>> = [];
    const fn = (async (_d: unknown, args: unknown) => {
      seen.push(args as Record<string, unknown>);
      return { hits: [] };
    }) as unknown as SessionContextDeps["recallFn"];
    await buildSessionContext(toolDeps, vault, {
      recallFn: fn,
      listFloorsFn: noFloors,
      listConventionsFn: noConventions,
    });
    for (const args of seen) {
      assert.equal(args.expand_hops, 0, "der Forwarder-Vertrag kennt keine Hops");
    }
  });
});

test("ein Aufrufer kann die Baseline überschreiben, aber nur ausdrücklich", async () => {
  await withDeps(async (toolDeps, vault) => {
    const seen: Array<Record<string, unknown>> = [];
    const fn = (async (_d: unknown, args: unknown) => {
      seen.push(args as Record<string, unknown>);
      return { hits: [] };
    }) as unknown as SessionContextDeps["recallFn"];
    await assembleSessionSections(
      toolDeps,
      vault,
      { expand_hops: 0 },
      { recallFn: fn, listFloorsFn: noFloors, listConventionsFn: noConventions },
    );
    assert.equal(seen[0].expand_hops, 0);
  });
});
