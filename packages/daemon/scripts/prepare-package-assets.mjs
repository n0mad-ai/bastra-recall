/** Package Skill assets for Claude, Codex and ChatGPT desktop (#232/#15). */
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// #455: the client projections (Cursor rule, Codex/ChatGPT plugin skill) are
// GENERATED from packages/skill/SKILL.md. Regenerate before copying, so the
// package can never ship a Cursor rule that disagrees with the skill.
const { buildSkillProjections } = await import(
  resolve(packageRoot, "..", "..", "scripts", "build-skill-projections.mjs")
);
await buildSkillProjections();

// The convention layers live in packages/skill/ but must ship inside the daemon
// package (that is what npm publishes). Discovered, not listed (#232): every
// markdown file is skill payload — SKILL.md plus the reference files it points
// at — and cursor-rules.mdc ships alongside for Cursor project rules (#7). A
// hand-kept list is how the copy went stale; package.json ships "skill" whole.
// Runs on `build` as well as `prepack`, so a source edit can't outlive the sync.
const src = resolve(packageRoot, "..", "skill");
const dst = resolve(packageRoot, "skill");

const assets = (await readdir(src, { withFileTypes: true }))
  .filter((e) => e.isFile() && (e.name.endsWith(".md") || e.name === "cursor-rules.mdc"))
  .map((e) => e.name);

await mkdir(dst, { recursive: true });
for (const name of assets) {
  await copyFile(resolve(src, name), resolve(dst, name));
}

// ChatGPT/Codex skill presentation + MCP dependency metadata (#15).
const agentsSrc = resolve(src, "agents");
const agentsDst = resolve(dst, "agents");
await mkdir(agentsDst, { recursive: true });
await copyFile(resolve(agentsSrc, "openai.yaml"), resolve(agentsDst, "openai.yaml"));
