/**
 * #1514 — characterization of `importVault` before it is split up. One rich
 * source folder runs through every pass (id minting, collisions with a foreign
 * node, index harvest, synthetic index, dry-run, unchanged re-run, a removed
 * source file) and the snapshot records what the user ends up with: the
 * result, every file in the vault with its content, the marker and the audit
 * trail in write order. A structural change must leave all of it identical.
 *
 * Volatile values (temp paths, dates, run ids) are normalized; nothing else is.
 * Update deliberately with `--test-update-snapshots` only when the behaviour is
 * meant to change.
 */
import { test } from "node:test";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { resetAuditLogCache } from "../src/audit-trail.js";
import { importVault } from "../src/import-vault.js";

async function put(dir: string, rel: string, content: string): Promise<void> {
  await mkdir(dirname(join(dir, rel)), { recursive: true });
  await writeFile(join(dir, rel), content, "utf8");
}

function normalize(value: unknown, roots: string[]): unknown {
  let text = JSON.stringify(value);
  for (const root of roots) text = text.split(root).join("<root>");
  text = text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<time>")
    .replace(/\d{4}-\d{2}-\d{2}/g, "<date>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");
  return JSON.parse(text) as unknown;
}

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string): Promise<void> => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name !== "audit-log.ndjson") out[relative(dir, full)] = await readFile(full, "utf8");
    }
  };
  await walk(dir);
  return out;
}

async function auditTrail(vault: string): Promise<unknown[]> {
  const raw = await readFile(join(vault, ".bastra", "audit-log.ndjson"), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const e = JSON.parse(l) as Record<string, unknown>;
      return {
        memory_id: e.memory_id,
        operation: e.operation,
        actor: e.actor,
        actor_detail: e.actor_detail,
        file_path: e.file_path,
        session_id: e.session_id,
        diff_before: e.diff_before,
        diff_after: e.diff_after,
      };
    });
}

test("#1514 importVault: every pass, dry-run, re-run and a removed source stay byte-identical", async (t) => {
  resetAuditLogCache();
  const root = await mkdtemp(join(tmpdir(), "bastra-1514-import-"));
  const src = join(root, "notes");
  const vault = join(root, "vault");
  await mkdir(vault);
  try {
    await put(
      src,
      "MEMORY.md",
      "# Memory\n\n## Rules\n- [No borders](feedback_borders.md) — keep borders single\n" +
        "- [Windows](project_windows.md) — ship via CI\n\n## Notes\n- [Plain](plain.md) — a plain note\n"
    );
    await put(
      src,
      "feedback_borders.md",
      "---\nname: No double borders\ndescription: Always check borders\ntype: feedback\n---\nSee [[project_windows]] and [[ghost]].\n"
    );
    await put(
      src,
      "project_windows.md",
      "---\nname: Windows strategy\ndescription: Ship the windows build via CI\nmetadata:\n  type: project\n---\nDetails.\n"
    );
    await put(src, "plain.md", "# Plain note\n\nFirst paragraph of a plain note.\n\nSecond paragraph.\n");
    await put(src, "no-frontmatter.md", "Just text without a heading.\n");
    await put(src, "sub/dir/plain.md", "# Nested plain\n\nSame basename, deeper.\n");
    await put(src, "hub.md", "# Hub\n\n- [[plain]]\n- [[feedback_borders]]\n- [[project_windows]]\n");
    await put(src, "skipme/ignored.md", "# Ignored\n\nExcluded directory.\n");
    await put(src, "taken.md", "# Taken\n\nCollides with a hand-authored memory.\n");
    // A hand-authored node already sits on the readable id of taken.md.
    await put(
      vault,
      "memories/imported/notes/notes-taken.md",
      "---\nid: notes-taken\ntitle: Mine\ntype: lesson\nsummary: Hand-authored.\nscope: notes\n---\nHand-authored body.\n"
    );

    // The real path first: on macOS it extends the temp path (/private/var vs /var).
    const roots = [await realpath(root), root];
    const dry = await importVault(vault, src, { label: "notes", dryRun: true, exclude: ["skipme"] });
    const afterDry = await tree(vault);
    const first = await importVault(vault, src, { label: "notes", exclude: ["skipme"] });
    const afterFirst = await tree(vault);
    const again = await importVault(vault, src, { label: "notes", exclude: ["skipme"] });
    await put(
      src,
      "project_windows.md",
      "---\nname: Windows strategy\ndescription: Ship the windows build via CI\nmetadata:\n  type: project\n---\nChanged details.\n"
    );
    await rm(join(src, "plain.md"));
    const shrunk = await importVault(vault, src, { label: "notes", exclude: ["skipme"] });

    t.assert.snapshot(
      normalize(
        {
          dry,
          afterDry,
          first,
          afterFirst,
          again,
          shrunk,
          afterShrunk: await tree(vault),
          audit: await auditTrail(vault),
        },
        roots
      )
    );
  } finally {
    resetAuditLogCache();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("#1514 importVault: refusals keep their messages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bastra-1514-refuse-"));
  try {
    const vault = join(root, "vault");
    await mkdir(join(vault, "inner"), { recursive: true });
    const errors: string[] = [];
    for (const [v, s] of [
      [vault, join(root, "missing")],
      [vault, join(vault, "inner")],
      [join(vault, "inner"), vault],
    ]) {
      await importVault(v, s).then(
        () => errors.push("resolved"),
        (e: Error) => errors.push(e.message)
      );
    }
    t.assert.snapshot(normalize(errors, [await realpath(root), root]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
