/**
 * #544 — a save whose body arrives truncated must fail loudly, not land
 * silently as a shorter memory that looks exactly like a successful save.
 *
 * The guard is a TAIL SENTINEL: `body_ends_with`, the last ~40 characters of
 * `body` copied verbatim. A declared char COUNT was the obvious shape and the
 * wrong one — a language model cannot count characters, so the field would
 * fail legitimate saves and (after three in a row) talk the model out of
 * saving at all. Copying text is the thing models do reliably, and truncation
 * in transport always takes the END.
 *
 * The check lives in core's `assertBodyTail` and is called from two places:
 * `saveMemory()` (packages/core/src/save.ts), which every transport reaches —
 * including the Mac-App bridge via `auditedSave` — and the daemon handler,
 * because `conflict_with` and the claim gate return ABOVE `saveMemory` and
 * `markConflict` writes.
 *
 * Every dispatch case here goes through the REAL entry point
 * (`saveMemoryHandler`), per the issue's acceptance criterion, not the
 * internal function.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/save-body-sentinel.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, AuditLog, auditedSave, CONFLICT_START } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import {
  resetSaveFailures,
  saveMemoryHandler,
  SAVE_FAILURE_CAP,
  type ToolDeps,
  type SaveMemoryResult,
} from "../src/tool-handlers.js";
import { resetAuditLogCache } from "../src/audit-trail.js";

interface Fixture {
  deps: ToolDeps;
  vaultRoot: string;
}

async function fixture(t: { after: (fn: () => unknown) => void }): Promise<Fixture> {
  resetAuditLogCache();
  resetSaveFailures();
  const vaultRoot = await mkdtemp(join(tmpdir(), "bastra-544-save-"));
  const vault = new Vault(vaultRoot);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: vaultRoot };
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    resetAuditLogCache();
    resetSaveFailures();
    await rm(vaultRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { deps, vaultRoot };
}

/** Non-special scopes route to `memories/projects/<scope>/<id>.md`. */
const filePath = (vaultRoot: string, scope: string, id: string): string =>
  join(vaultRoot, "memories", "projects", scope, `${id}.md`);

async function auditEntries(vaultRoot: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(vaultRoot, ".bastra", "audit-log.ndjson"), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const BODY = "Line one.\n\nLine two.\n\nLine three, the closing sentence that must survive.\n";
/** What a caller copies: the last ~40 characters of what it sent. */
const tailOf = (text: string, n = 40): string => text.trimEnd().slice(-n);

const baseInput = (over: Record<string, unknown> = {}) => ({
  id: "trunc-test",
  title: "Truncation test memory",
  type: "lesson",
  summary: "A memory used to exercise body_ends_with.",
  body: BODY,
  topic_path: ["test"],
  tags: ["test"],
  scope: "test-544",
  recall_when: ["testing body_ends_with"],
  ...over,
});

// ── (a) correct sentinel — the save lands ───────────────────────────

test("#544: a correct body_ends_with lets the save through", async (t) => {
  const { deps, vaultRoot } = await fixture(t);

  const result = (await saveMemoryHandler(
    deps,
    baseInput({ body_ends_with: tailOf(BODY) }),
  )) as SaveMemoryResult;

  assert.equal(result.created, true);
  const mem = deps.vault.get("trunc-test");
  assert.ok(mem, "the memory must be indexed after a successful save");
  assert.equal(mem.body.trim(), BODY.trim());
  await stat(filePath(vaultRoot, "test-544", "trunc-test"));
});

// ── (b) truncated body — nothing lands ──────────────────────────────

test("#544: a body missing its declared ending fails, writes nothing, logs no audit event", async (t) => {
  const { deps, vaultRoot } = await fixture(t);
  // The shape of a mid-flight truncation: the caller copied the tail of the
  // body it MEANT to send, and the bytes that actually arrived stop earlier.
  const truncated = BODY.slice(0, 20);

  await assert.rejects(
    () => saveMemoryHandler(deps, baseInput({ body: truncated, body_ends_with: tailOf(BODY) })),
    (err: Error) =>
      /body_ends_with: the body that arrived does not end with the declared tail/.test(err.message)
      && err.message.includes("NOTHING was written")
      && err.message.includes("resend save_memory with the COMPLETE body")
      && err.message.includes("must survive")
      && err.message.includes("Line one"),
  );

  assert.equal(deps.vault.get("trunc-test"), undefined, "no memory may be indexed");
  await assert.rejects(() => stat(filePath(vaultRoot, "test-544", "trunc-test")), "no file may exist on disk");
  assert.deepEqual(await auditEntries(vaultRoot), [], "a held save must not log an audit event");
});

// ── (c) field absent — unchanged behaviour ──────────────────────────

test("#544: omitting body_ends_with behaves exactly like today", async (t) => {
  const { deps, vaultRoot } = await fixture(t);
  const oddBody = "x".repeat(7);

  const result = (await saveMemoryHandler(deps, baseInput({ body: oddBody }))) as SaveMemoryResult;

  assert.equal(result.created, true);
  assert.equal(deps.vault.get("trunc-test")?.body.trim(), oddBody);
  await stat(filePath(vaultRoot, "test-544", "trunc-test"));
});

// ── (d) edge whitespace and line endings — still lands ──────────────

test("#544: trailing whitespace and CRLF do not fail an intact body", async (t) => {
  const { deps } = await fixture(t);
  const crlfBody = "First line.\r\nSecond line, the one that ends this memory.\r\n";

  const result = (await saveMemoryHandler(
    deps,
    baseInput({
      // `\n` where the body carries `\r\n`, plus trailing whitespace the
      // caller picked up while copying — a line-ending convention and some
      // stray blanks are not damage.
      body: crlfBody,
      body_ends_with: "Second line, the one that ends this memory.   \n\n",
    }),
  )) as SaveMemoryResult;

  assert.equal(result.created, true);
  assert.ok(deps.vault.get("trunc-test"), "the memory landed");
});

// ── a sentinel too short to be evidence is refused ──────────────────

test("#544: a sentinel that proves nothing is refused, and a short body stays protectable", async (t) => {
  const { deps } = await fixture(t);

  // "ends with a full stop" would match almost every truncation too.
  await assert.rejects(
    () => saveMemoryHandler(deps, baseInput({ body_ends_with: "." })),
    /body_ends_with must repeat at least 12 characters/,
  );
  // Whitespace only normalises to nothing — it must not pass trivially.
  await assert.rejects(
    () => saveMemoryHandler(deps, baseInput({ body_ends_with: "   \n " })),
    /body_ends_with must repeat at least/,
  );

  // The floor yields to the body: a sentinel is never required to be longer
  // than the body it guards.
  const shortBody = "Port 8080.";
  const result = (await saveMemoryHandler(
    deps,
    baseInput({ id: "trunc-short", body: shortBody, body_ends_with: shortBody }),
  )) as SaveMemoryResult;
  assert.equal(result.created, true);
});

// ── a legitimate save of any size is unaffected ─────────────────────

test("#544: a large body with a correct sentinel saves unaffected", async (t) => {
  const { deps, vaultRoot } = await fixture(t);
  const bigBody = Array.from({ length: 400 }, (_, i) => `Paragraph ${i}: some multiline content here.`).join(
    "\n\n",
  );

  const result = (await saveMemoryHandler(
    deps,
    baseInput({ id: "trunc-test-large", body: bigBody, body_ends_with: tailOf(bigBody) }),
  )) as SaveMemoryResult;

  assert.equal(result.created, true);
  assert.equal(deps.vault.get("trunc-test-large")?.body.trim(), bigBody.trim());
  await stat(filePath(vaultRoot, "test-544", "trunc-test-large"));
});

// ── (e) the #482 framing repair — both directions ───────────────────

/**
 * A save_memory call whose client fell back to legacy XML inside `body`:
 * the sibling parameters never arrived as JSON, they are trailing prose
 * inside the body string. `repairCallCorruption` undoes the framing and cuts
 * the body back at `</body>` — see packages/daemon/src/call-corruption.ts.
 */
const framed = (body: string, extra: Record<string, unknown> = {}) => ({
  id: "trunc-repair",
  title: "Repaired save",
  type: "lesson",
  summary: "A save that arrived XML-framed.",
  body:
    `${body}\n</body>\n` +
    `<parameter name="topic_path">["test"]</parameter>\n` +
    `<parameter name="tags">["test"]</parameter>\n` +
    `<parameter name="scope">test-544</parameter>\n` +
    `<parameter name="recall_when">["testing the repair"]</parameter>`,
  ...extra,
});

test("#544 × #482: the sentinel CONFIRMS a repair that only cut framing garbage", async (t) => {
  const { deps } = await fixture(t);
  const authored = "The repaired body.\n\nIts real closing sentence, which the framing did not eat.";

  const result = (await saveMemoryHandler(
    deps,
    framed(authored, { body_ends_with: tailOf(authored) }),
  )) as SaveMemoryResult;

  assert.equal(result.created, true);
  assert.equal(
    deps.vault.get("trunc-repair")?.body.trim(),
    authored,
    "the repair kept the authored body, and the sentinel proved it",
  );
});

test("#544 × #482: a repair that cut real content is caught by the sentinel", async (t) => {
  const { deps } = await fixture(t);
  const arrived = "The repaired body.\n\nIts real closing sentence, which the framing did not eat.";
  // What the caller MEANT to send — the ending never made it into the
  // container, so the repair cannot bring it back and the save must fail.
  const intended = `${arrived}\n\nAnd a final paragraph that was lost in transit entirely.`;

  await assert.rejects(
    () => saveMemoryHandler(deps, framed(arrived, { body_ends_with: tailOf(intended) })),
    /body_ends_with: the body that arrived does not end with the declared tail/,
  );
  assert.equal(deps.vault.get("trunc-repair"), undefined, "nothing was written");
});

// ── (f) the conflict_with diversion writes too ──────────────────────

test("#544: a conflict_with save with a wrong sentinel writes no conflict block", async (t) => {
  const { deps } = await fixture(t);
  const existing = (await saveMemoryHandler(
    deps,
    baseInput({ id: "conflict-host", body: "The server listens on port 80." }),
  )) as SaveMemoryResult;

  await assert.rejects(
    () =>
      saveMemoryHandler(
        deps,
        baseInput({
          id: "conflict-incoming",
          body: "The server listens on port 443.",
          conflict_with: existing.id,
          body_ends_with: "port 443, and a tail that never arrived.",
        }),
      ),
    /body_ends_with: the body that arrived does not end with the declared tail/,
  );

  const raw = await readFile(filePath(deps.vaultPath, "test-544", "conflict-host"), "utf8");
  assert.ok(!raw.includes(CONFLICT_START), "markConflict must not have touched the existing memory");
  assert.equal(deps.vault.get("conflict-incoming"), undefined, "and no sibling was created");
});

// ── (g) the bridge / auditedSave path ───────────────────────────────

test("#544: auditedSave — the Mac-App transport — inherits the guard", async (t) => {
  const { deps, vaultRoot } = await fixture(t);
  const auditLog = new AuditLog(vaultRoot);
  const input = {
    id: "bridge-save",
    title: "Bridge save",
    type: "lesson" as const,
    summary: "Saved past the daemon dispatch.",
    body: BODY.slice(0, 20),
    topic_path: ["test"],
    tags: ["test"],
    scope: "test-544",
    recall_when: ["testing the bridge path"],
    body_ends_with: tailOf(BODY),
  };

  await assert.rejects(
    () =>
      auditedSave({
        vault: deps.vault,
        auditLog,
        vaultRoot,
        input,
        context: { actor: "user", actor_detail: "test", reason: "bridge save" },
      }),
    /body_ends_with: the body that arrived does not end with the declared tail/,
  );
  await assert.rejects(() => stat(filePath(vaultRoot, "test-544", "bridge-save")), "no file may exist");

  // The same input WITH its real body lands — the guard is not a blanket ban
  // on that transport.
  const { result } = await auditedSave({
    vault: deps.vault,
    auditLog,
    vaultRoot,
    input: { ...input, body: BODY },
    context: { actor: "user", actor_detail: "test", reason: "bridge save" },
  });
  assert.equal(result.created, true);
});

// ── the anti-thrash cap (#150) must not punish the guard ────────────

test("#544: repeated sentinel failures never escalate into 'STOP retrying this save'", async (t) => {
  const { deps } = await fixture(t);
  const bad = baseInput({ body: BODY.slice(0, 20), body_ends_with: tailOf(BODY) });

  for (let i = 0; i < SAVE_FAILURE_CAP + 2; i += 1) {
    await assert.rejects(
      () => saveMemoryHandler(deps, bad),
      (err: Error) => {
        assert.ok(
          !err.message.includes("STOP retrying"),
          `attempt ${i + 1} escalated, though resending the complete body is the right move`,
        );
        return /body_ends_with/.test(err.message);
      },
    );
  }

  // And the streak is genuinely untouched: an ordinary failure right after
  // still counts as the FIRST one.
  await assert.rejects(
    () => saveMemoryHandler(deps, baseInput({ replaces: "does-not-exist" })),
    (err: Error) => /unknown memory 'does-not-exist'/.test(err.message) && !err.message.includes("STOP retrying"),
  );
});
