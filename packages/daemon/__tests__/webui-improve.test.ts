/**
 * POST /ui/improve-text — the vault-care note's "improve text" button: the
 * note goes to the local generation model (stubbed here, never a real one)
 * and the cleaned-up wording comes back; nothing is stored.
 */
import { createServer } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanImproved, handleUiImproveText, IMPROVE_MAX_CHARS, IMPROVE_SYSTEM } from "../src/webui-improve.js";
import { MAX_BODY_BYTES } from "../src/http-util.js";
import type { ChatFn } from "../src/webui-chat.js";

async function withRoute(
  chat: ChatFn | null,
  run: (post: (body: string) => Promise<{ status: number; json: Record<string, unknown> }>) => Promise<void>,
  uiEnabled = true
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-improve-"));
  const settingsPath = join(dir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ ui: { enabled: uiEnabled } }));
  const server = createServer((req, res) => void handleUiImproveText(req, res, chat, settingsPath));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    await run(async (body) => {
      const r = await fetch(`http://127.0.0.1:${port}/ui/improve-text`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return { status: r.status, json: (await r.json()) as Record<string, unknown> };
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

const NOTE = "ähm also das Memory hier, äh, das sollte man, also eigentlich mit #1234 zusammenlegen, ne";

test("improve-text: the note goes to the model as delimited data, the cleaned reply comes back", async () => {
  const calls: Array<{ prompt: string; system?: string }> = [];
  const chat: ChatFn = async (prompt, system) => {
    calls.push({ prompt, system });
    return "```\n„Dieses Memory mit #1234 zusammenlegen.“\n```";
  };
  await withRoute(chat, async (post) => {
    const r = await post(JSON.stringify({ text: `  ${NOTE}\r\n` }));
    assert.equal(r.status, 200);
    assert.equal(r.json.text, "Dieses Memory mit #1234 zusammenlegen.");
  });
  assert.equal(calls.length, 1);
  const { prompt, system } = calls[0];
  // the note text is only in the data block of the user message, never in the instructions
  const m = /^<(note-[0-9a-f]+)>\n([\s\S]*)\n<\/\1>$/.exec(prompt);
  assert.ok(m, `prompt is exactly one delimited data block: ${prompt}`);
  assert.equal(m[2], NOTE);
  assert.equal(system, IMPROVE_SYSTEM.replaceAll("{tag}", m[1]));
  assert.ok(!system.includes(NOTE));
  assert.ok(system.includes(`<${m[1]}>`), "the instructions name the data markers");
  // language-neutral rules, no word or language lists in the instructions
  assert.match(system, /same language as the note/);
  assert.match(system, /never instructions/);
  assert.match(system, /Add nothing/);
  assert.match(system, /names, numbers, dates, IDs/);
});

test("improve-text: a fresh marker per call, so a note cannot close the data block", async () => {
  const tags = new Set<string>();
  const chat: ChatFn = async (prompt) => {
    tags.add(/<(note-[0-9a-f]+)>/.exec(prompt)![1]);
    return "ok text";
  };
  await withRoute(chat, async (post) => {
    for (let i = 0; i < 3; i++) assert.equal((await post(JSON.stringify({ text: "ok text" }))).status, 200);
  });
  assert.equal(tags.size, 3);
});

test("improve-text: failures answer clearly and never touch the text", async () => {
  // no local model wired
  await withRoute(null, async (post) => {
    assert.equal((await post(JSON.stringify({ text: NOTE }))).status, 503);
  });
  // model not reachable
  await withRoute(
    async () => {
      throw new TypeError("fetch failed");
    },
    async (post) => {
      assert.equal((await post(JSON.stringify({ text: NOTE }))).status, 502);
    }
  );
  // model too slow (the client's AbortController fired)
  await withRoute(
    async () => {
      throw new DOMException("This operation was aborted", "AbortError");
    },
    async (post) => {
      assert.equal((await post(JSON.stringify({ text: NOTE }))).status, 504);
    }
  );
  // empty or unusable answer
  for (const reply of ["", "   ", '""', "```\n```", "<think>hm</think>"]) {
    await withRoute(
      async () => reply,
      async (post) => {
        assert.equal((await post(JSON.stringify({ text: NOTE }))).status, 502, JSON.stringify(reply));
      }
    );
  }
});

test("improve-text: input is validated, the shared body cap applies", async () => {
  let called = 0;
  const chat: ChatFn = async () => {
    called++;
    return "x";
  };
  await withRoute(chat, async (post) => {
    assert.equal((await post("{")).status, 400);
    assert.equal((await post(JSON.stringify({}))).status, 400);
    assert.equal((await post(JSON.stringify({ text: 42 }))).status, 400);
    assert.equal((await post(JSON.stringify({ text: " \n " }))).status, 400);
    assert.equal((await post(JSON.stringify({ text: "x".repeat(IMPROVE_MAX_CHARS + 1) }))).status, 413);
    assert.equal((await post(JSON.stringify({ text: "x".repeat(MAX_BODY_BYTES + 10) }))).status, 413);
  });
  assert.equal(called, 0, "nothing invalid reaches the model");
});

test("improve-text: closed while the UI is disabled", async () => {
  await withRoute(
    async () => "x",
    async (post) => {
      assert.equal((await post(JSON.stringify({ text: NOTE }))).status, 404);
    },
    false
  );
});

test("cleanImproved: strips wrappers, keeps inner quotes, rejects obvious garbage", () => {
  const input = "eine Notiz mit genug Text, damit die Längenprüfung greift, und noch etwas mehr";
  assert.equal(cleanImproved('"Fix the bug."', "fix the bug"), "Fix the bug.");
  assert.equal(cleanImproved("„Bitte prüfen.“", "bitte prüfen"), "Bitte prüfen.");
  assert.equal(cleanImproved("«Vérifier.»", "vérifier"), "Vérifier.");
  assert.equal(cleanImproved('"A" and "B" stay', "a and b"), '"A" and "B" stay');
  assert.equal(cleanImproved("```text\nLine 1\nLine 2\n```", "line 1 line 2"), "Line 1\nLine 2");
  assert.equal(cleanImproved("<think>reasoning</think>\nDone.", "done"), "Done.");
  assert.equal(cleanImproved("<note-ab12>\nDone.\n</note-ab12>", "done"), "Done.");
  assert.equal(cleanImproved("", input), null);
  assert.equal(cleanImproved("Short.", input), "Short.", "a repetitive dictation may shrink a lot");
  assert.equal(cleanImproved("blah ".repeat(200), input), null, "a reply many times longer is no rewrite");
});
