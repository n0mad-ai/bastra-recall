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
import { taskCliLanguage } from "./task-cli-words.js";
import { usageBlocksIn } from "./usage-block-words.js";

const REPO = "https://github.com/n0mad-ai/bastra-recall";

/** The words `bastra feedback` prints by language.primary (#1602), English when
 *  unset or unlisted. The diagnostics block itself stays English: it goes into
 *  the GitHub issue, not only onto the screen. */
export const FEEDBACK_WORDS = {
  en: {
    openingIdea: "opening feature-request form…\n",
    bugIntro:
      "This diagnostics block is prefilled into the report — and nothing else\n" +
      "(no vault content, no paths). Edit or remove it in the form as you like:\n\n",
    openingBug: "\n\nopening bug-report form…\n",
  },
  de: {
    openingIdea: "öffne das Formular für einen Funktionswunsch…\n",
    bugIntro:
      "Dieser Diagnoseblock wird in den Bericht vorausgefüllt — und sonst nichts\n" +
      "(keine Vault-Inhalte, keine Pfade). Im Formular kannst du ihn ändern oder entfernen:\n\n",
    openingBug: "\n\nöffne das Formular für einen Fehlerbericht…\n",
  },
};
export const feedbackWordsIn = (language: string | undefined) =>
  FEEDBACK_WORDS[(language ?? "en") as keyof typeof FEEDBACK_WORDS] ?? FEEDBACK_WORDS.en;

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
  const language = await taskCliLanguage().catch(() => "en");
  if (kind !== "bug" && kind !== "idea") {
    process.stdout.write(usageBlocksIn(language).feedback(REPO));
    return 2;
  }
  const w = feedbackWordsIn(language);
  if (kind === "idea") {
    const url = buildFeedbackUrl("idea");
    process.stdout.write(`${w.openingIdea}${url}\n`);
    openInBrowser(url);
    return 0;
  }
  const diagnostics = await collectDiagnostics();
  process.stdout.write(w.bugIntro + formatDiagnostics(diagnostics) + w.openingBug);
  openInBrowser(buildFeedbackUrl("bug", diagnostics));
  return 0;
}
