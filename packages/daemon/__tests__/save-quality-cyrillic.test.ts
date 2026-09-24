/**
 * save_quality tokeniser must be script-agnostic.
 *
 * `words()` matched `[a-z0-9]` only, so a non-Latin recall_when phrase
 * ("тон письма outward") collapsed to its single Latin token and tripped the
 * `tokens.length <= 1` → "too short/generic" penalty (−25 each, up to −55).
 * Every Cyrillic/CJK author was structurally forced into the `low` band no
 * matter how specific their multi-word triggers were.
 *
 * Guard: a genuinely one-word trigger stays flagged — the fix widens the
 * alphabet, it must not disable the specificity check.
 *
 * Runner: `tsx --test __tests__/save-quality-cyrillic.test.ts`
 * Real file vault, no mocking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { saveMemoryHandler, type ToolDeps } from "../src/tool-handlers.js";

async function makeDeps(): Promise<{ deps: ToolDeps; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-cyrillic-quality-"));
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: dir };
  return {
    deps,
    close: async () => {
      search.stop();
      await vault.stop?.();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

const CYRILLIC = {
  title: "feedback показать и отправить два хода",
  type: "meta-working",
  summary: "Показ outward-текста и отправка обязаны быть двумя ходами с ходом юзера между ними.",
  topic_path: ["feedback", "outward"],
  tags: ["feedback", "outward", "boundary"],
  scope: "selftest",
  recall_when: [
    "показать и отправить два хода",
    "разрешение на задачу не подпись под грузом",
    "юзер видел этот текст отдельным ходом",
  ],
  body: "Если ход содержит «вот текст» — ход заканчивается; отправка живёт в следующем вызове.",
};

test("multi-word Cyrillic recall_when is not flagged as too short/generic", async (t) => {
  const { deps, close } = await makeDeps();
  t.after(close);

  const res = await saveMemoryHandler(deps, CYRILLIC);
  assert.equal(res.created, true);
  assert.ok(res.save_quality); // #542: absent only on a conflict diversion

  const shortIssues = res.save_quality.issues.filter((i) => i.includes("too short/generic"));
  assert.deepEqual(
    shortIssues,
    [],
    `multi-word Cyrillic triggers must tokenise past 1 word, got: ${JSON.stringify(shortIssues)}`,
  );
});

test("a genuinely one-word Cyrillic trigger is still flagged", async (t) => {
  const { deps, close } = await makeDeps();
  t.after(close);

  const res = await saveMemoryHandler(deps, {
    ...CYRILLIC,
    title: "feedback односложный триггер",
    recall_when: ["дрейф"],
  });
  assert.ok(res.save_quality); // #542: absent only on a conflict diversion

  const shortIssues = res.save_quality.issues.filter((i) => i.includes("too short/generic"));
  assert.ok(
    shortIssues.length >= 1,
    "the specificity check must still catch a real one-word trigger — the fix widens the alphabet, not the gate",
  );
});

test("a Cyrillic-only title slugifies instead of throwing", async (t) => {
  const { deps, close } = await makeDeps();
  t.after(close);

  // Pre-fix `slugify` matched `[^a-z0-9]`, so an all-Cyrillic title collapsed
  // to "" and threw `cannot slugify` before the memory could be written.
  const res = await saveMemoryHandler(deps, {
    ...CYRILLIC,
    title: "тон письма и регистр",
  });

  assert.equal(res.created, true);
  assert.ok(res.id.length > 0, `Cyrillic title must produce a non-empty slug, got '${res.id}'`);
});
