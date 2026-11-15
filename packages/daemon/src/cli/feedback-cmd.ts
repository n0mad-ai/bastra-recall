/**
 * `bastra feedback [bug|idea]` — the low-friction feedback path: opens the
 * matching GitHub issue form PREFILLED with a sanitized diagnostics block
 * (version, OS, node, embedding mode, vault size — never any vault content,
 * never a path). The user sees the block in the terminal first and submits
 * the issue themselves in their own browser/GitHub context — no telemetry
 * endpoint, no auto-egress, consistent with the local-first promise.
 */
import { release, arch } from "node:os";
import { VERSION } from "./helpers.js";
import { openInBrowser, mapUrl } from "./map-cmd.js";
import type { ParsedArgs } from "./types.js";

const REPO = "https://github.com/n0mad-ai/bastra-recall";

export interface DiagnosticsParts {
  version: string;
  os: string;
  node: string;
  embedding: string;
  vaultSize: string;
  daemon: string;
}

/** The block shown to the user AND prefilled into the form — nothing else
 *  is ever included. Pure so tests can pin the no-paths guarantee. */
export function formatDiagnostics(p: DiagnosticsParts): string {
  return [
    `version:    ${p.version}`,
    `os:         ${p.os}`,
    `node:       ${p.node}`,
    `embedding:  ${p.embedding}`,
    `vault_size: ${p.vaultSize}`,
    `daemon:     ${p.daemon}`,
  ].join("\n");
}

export function buildFeedbackUrl(kind: "bug" | "idea", diagnostics?: DiagnosticsParts): string {
  if (kind === "idea") {
    return `${REPO}/issues/new?template=feature_request.yml`;
  }
  const params = new URLSearchParams({ template: "bug_report.yml" });
  if (diagnostics) {
    params.set("bastra-version", diagnostics.version);
    params.set("os", diagnostics.os);
    params.set("node", diagnostics.node);
    params.set("doctor-output", formatDiagnostics(diagnostics));
  }
  return `${REPO}/issues/new?${params.toString()}`;
}

async function collectDiagnostics(): Promise<DiagnosticsParts> {
  let embedding = "unknown";
  let vaultSize = "unknown";
  let daemon = "not reachable";
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 1200);
    try {
      const res = await fetch(`${mapUrl().replace(/\/ui$/, "")}/health`, { signal: ctrl.signal });
      if (res.ok) {
        const h = (await res.json()) as { vault_size?: number; embedding_mode?: string; version?: string };
        embedding = h.embedding_mode ?? "unknown";
        vaultSize = String(h.vault_size ?? "unknown");
        daemon = `ok (v${h.version ?? "?"})`;
      }
    } finally {
      clearTimeout(tid);
    }
  } catch {
    /* daemon down — the block says so, that's diagnostic signal too */
  }
  return {
    version: VERSION,
    os: `${process.platform} ${release()} (${arch()})`,
    node: process.version,
    embedding,
    vaultSize,
    daemon,
  };
}

export async function cmdFeedback(args: ParsedArgs): Promise<number> {
  const kind = args.surface;
  if (kind !== "bug" && kind !== "idea") {
    process.stdout.write(
      "usage: bastra feedback <bug|idea>\n" +
        "  bug   open a prefilled bug report (includes the diagnostics below — nothing else)\n" +
        "  idea  open a feature-request form\n\n" +
        `Other channels: ${REPO}/discussions (questions) · ${REPO}/issues (all reports)\n`
    );
    return 2;
  }
  if (kind === "idea") {
    const url = buildFeedbackUrl("idea");
    process.stdout.write(`opening feature-request form…\n${url}\n`);
    openInBrowser(url);
    return 0;
  }
  const diagnostics = await collectDiagnostics();
  process.stdout.write(
    "This diagnostics block is prefilled into the report — and nothing else\n" +
      "(no vault content, no paths). Edit or remove it in the form as you like:\n\n" +
      formatDiagnostics(diagnostics) +
      "\n\nopening bug-report form…\n"
  );
  openInBrowser(buildFeedbackUrl("bug", diagnostics));
  return 0;
}
