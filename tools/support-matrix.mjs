/**
 * #525 — ONE support matrix, and the places that have to repeat it.
 *
 * The release-path review found the same claim stated four different ways: the
 * live Homebrew caveat listed three clients while the repository formula listed
 * four, the npm package README required "macOS (Apple Silicon) today" while the
 * release workflow builds hook clients for macOS and Linux on two architectures
 * each, and the published package descriptions named a client set and a tool
 * set that neither matched the installer nor the shipped surface.
 *
 * The matrix itself lives in README.md (`### Supported surfaces` and
 * `### Supported platforms`). This module holds the machine-readable anchors —
 * the CLI's own surface list and the release workflow's hook-client targets —
 * and the small extractors the drift test compares the prose against.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const read = (rel) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

/**
 * The installable clients, taken from the CLI itself
 * (`packages/daemon/src/cli/completion.ts`) rather than restated here — the
 * code is what `bastra install all` actually registers.
 */
export function installableSurfaces() {
  const src = read("packages/daemon/src/cli/completion.ts");
  const match = src.match(/export const SURFACES = \[([^\]]+)\] as const;/);
  if (!match) throw new Error("SURFACES not found in packages/daemon/src/cli/completion.ts");
  return match[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s && s !== "all");
}

/**
 * The compiled hook-client targets, taken from
 * `packages/daemon/src/cli/stub-install.ts` — the list the release workflow
 * builds and the platform half of the matrix has to agree with.
 */
export function hookClientTargets() {
  const src = read("packages/daemon/src/cli/stub-install.ts");
  const match = src.match(/export const STUB_TARGETS = \[([^\]]+)\] as const;/);
  if (!match) throw new Error("STUB_TARGETS not found in packages/daemon/src/cli/stub-install.ts");
  return match[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** How each installable surface is spelled in user-facing prose. */
export const SURFACE_LABELS = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex/ChatGPT Desktop",
  cursor: "Cursor",
};

/** The client list the Homebrew caveat states, as an array of labels. */
export function formulaCaveatClients(formulaSource = read("distribution/homebrew/bastra-recall.rb")) {
  const match = formulaSource.match(
    /registers bastra-recall with every supported AI client\s*\n?\s*\(([^)]+)\)/,
  );
  if (!match) return null;
  return match[1]
    .replace(/\s+/g, " ")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The formula with the two tap-owned lines removed, for a drift comparison. */
export function formulaWithoutTapOwnedLines(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*(url|sha256)\s+"/.test(line))
    // The header comment differs by design: each copy explains its own role.
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .join("\n");
}

export const REPO_FORMULA_PATH = "distribution/homebrew/bastra-recall.rb";
export const LIVE_FORMULA_URL =
  "https://raw.githubusercontent.com/n0mad-ai/homebrew-tap/main/Formula/bastra-recall.rb";

export { read as readRepoFile };
