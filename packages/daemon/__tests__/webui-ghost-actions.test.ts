// UI v2: the ghost card's two actions (views/ghost-actions.js) — "request
// note" queues the unwritten memory on the care list (POST /ui/annotate kind
// "write"), "is a skill" declares it (POST /ui/skills) and reloads the graph.
// The module runs against a fake DOM; the daemon side runs against a temporary
// vault, care file and skills registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createServer, request } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, buildGraph } from "@bastra-recall/core";
import { handleUiAnnotate, handleUiAnnotations, CARE_FILE } from "../src/webui.js";
import { handleUiSkills, listSkills } from "../src/skills-registry.js";

type El = {
  tag: string;
  children: El[];
  textContent: string;
  title: string;
  hidden: boolean;
  disabled: boolean;
  classes: Set<string>;
  classList: { add: (c: string) => void };
  click: () => Promise<void>;
};

function element(tag: string, props: Record<string, any> | null, ...children: El[]): El {
  const el = {
    tag,
    children: children.flat(Infinity).filter(Boolean) as El[],
    textContent: props?.text || "",
    title: "",
    hidden: !!props?.hidden,
    disabled: false,
    classes: new Set<string>(),
    classList: { add: (c: string) => el.classes.add(c) },
    click: async () => {},
  };
  return el;
}

// chrome.js actionButton stand-in: a button whose click awaits the handler
function button(cls: string, key: string, click: (e: unknown) => Promise<void>): El {
  const b = element(`button.${cls}`, { text: key });
  b.click = () => click({ currentTarget: b });
  return b;
}

type Call = { url: string; body: any };
async function load(answer: (url: string) => { status: number; body?: unknown }) {
  const src = await readFile(new URL("../webui/app/js/views/ghost-actions.js", import.meta.url), "utf8");
  const calls: Call[] = [];
  let reloads = 0;
  const fetch = async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    const a = answer(url);
    return { ok: a.status < 400, status: a.status, json: async () => a.body ?? {} };
  };
  const mod = runInNewContext(src.replace(/^import .*;$/gm, "").replace(/^export /gm, "") + "\n({ ghostActions })", {
    h: element,
    t: (k: string) => k,
    fetch,
    loadGraph: () => reloads++,
  });
  const [status, row] = mod.ghostActions({ id: "wanted-note" }, button) as [El, El];
  await new Promise((r) => setImmediate(r)); // the care-list read settles
  return { status, write: row.children[0], skill: row.children[1], calls, reloads: () => reloads };
}

const noFlags = (url: string) =>
  url === "/ui/annotations" ? { status: 200, body: { annotations: [] } } : { status: 200 };

test("request note: one click posts a write flag for the ghost and marks the button done", async () => {
  const ui = await load(noFlags);
  assert.equal(ui.write.textContent, "vv.ghost.write");
  assert.equal(ui.write.title, "vv.ghost.writeT");
  await ui.write.click();
  assert.deepEqual(ui.calls.at(-1), { url: "/ui/annotate", body: { id: "wanted-note", kind: "write", note: "" } });
  assert.equal(ui.write.textContent, "vv.ghost.queued");
  assert.ok(ui.write.disabled);
  assert.equal(ui.reloads(), 0, "a care flag does not change the graph");
  await ui.write.click();
  assert.equal(ui.calls.filter((c) => c.url === "/ui/annotate").length, 1, "no second flag");
});

test("is a skill: posts the id to the skills registry and reloads the graph", async () => {
  const ui = await load(noFlags);
  await ui.skill.click();
  assert.deepEqual(ui.calls.at(-1), { url: "/ui/skills", body: { id: "wanted-note" } });
  assert.equal(ui.skill.textContent, "vv.ghost.skilled");
  assert.ok(ui.skill.disabled);
  assert.equal(ui.reloads(), 1);
});

test("a ghost already on the care list opens as requested; a failed action says so and can be retried", async () => {
  const flagged = await load((url) =>
    url === "/ui/annotations"
      ? { status: 200, body: { annotations: [{ id: "wanted-note", kind: "write", done: false, note: "" }] } }
      : { status: 200 }
  );
  assert.equal(flagged.write.textContent, "vv.ghost.queued");
  assert.ok(flagged.write.disabled);

  const failing = await load((url) => (url === "/ui/skills" ? { status: 400 } : noFlags(url)));
  await failing.skill.click();
  assert.equal(failing.status.hidden, false);
  assert.equal(failing.status.textContent, "vv.ghost.fail");
  assert.equal(failing.skill.disabled, false, "retry possible");
  assert.equal(failing.skill.textContent, "vv.ghost.skill");
  assert.equal(failing.reloads(), 0);
});

function post(port: number, path: string, payload: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = request(
      { hostname: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("daemon: the card's two requests flag the ghost for writing and turn it into a skill node", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-actions-"));
  try {
    const vaultDir = join(root, "vault"),
      memDir = join(vaultDir, "memories", "projects", "ghosts");
    await mkdir(memDir, { recursive: true });
    const settingsPath = join(root, "settings.json"),
      registryPath = join(root, "skills.json");
    await writeFile(settingsPath, JSON.stringify({ ui: { enabled: true } }));
    await writeFile(
      join(memDir, "linker.md"),
      "---\nid: linker\ntitle: Linker\ntype: reference\nsummary: Links a ghost\ntopic_path: [ghosts]\n" +
        "tags: [ghosts]\nscope: ghosts\nrecall_when: [linker]\nrelated: [wanted-note]\n" +
        "created: 2026-11-25\nupdated: 2026-11-25\n---\n\nBody.\n"
    );
    const vault = new Vault(vaultDir);
    await vault.init();
    assert.equal(buildGraph(vault).nodes.find((n) => n.id === "wanted-note")?.kind, "ghost");
    // the graph projection the routes check: the ghost is a visible node
    const visible = new Set(buildGraph(vault).nodes.map((n) => n.id));
    const server = createServer((req, res) => {
      if (req.url === "/ui/skills") void handleUiSkills(req, res, settingsPath, registryPath);
      else if (req.method === "POST") void handleUiAnnotate(req, res, vaultDir, settingsPath, visible);
      else void handleUiAnnotations(res, vaultDir, settingsPath, visible);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const flag = { id: "wanted-note", kind: "write", note: "" };
      assert.deepEqual(
        await Promise.all([post(port, "/ui/annotate", flag), post(port, "/ui/annotate", flag)]),
        [200, 200]
      );
      const care = await readFile(join(vaultDir, CARE_FILE), "utf8");
      const openFlag = /^- \[ \] \d{4}-\d{2}-\d{2} · write · \[\[wanted-note\]\]$/gm;
      assert.equal([...care.matchAll(openFlag)].length, 1);
      await writeFile(
        join(vaultDir, CARE_FILE),
        care.replace(openFlag, (line) => line.replace("[ ]", "[x]"))
      );
      assert.equal(await post(port, "/ui/annotate", flag), 200);
      assert.equal([...(await readFile(join(vaultDir, CARE_FILE), "utf8")).matchAll(openFlag)].length, 1);
      assert.equal(await post(port, "/ui/skills", { id: "wanted-note" }), 200);
      const skills = await listSkills(registryPath);
      assert.deepEqual(
        skills.map((s) => s.id),
        ["wanted-note"]
      );
      const node = buildGraph(vault, skills).nodes.find((n) => n.id === "wanted-note");
      assert.equal(node?.kind, "skill", "no longer counted as unwritten");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await vault.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
