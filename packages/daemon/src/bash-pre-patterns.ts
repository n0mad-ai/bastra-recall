/**
 * The tripwire's pattern tables (#650/#651): what counts as destructive or
 * risky, and — per destructive row, in the same place — what the hint may say
 * instead of STOP. The matching (segments, heredocs, prose) and the per-command
 * decision live in `bash-pre-lane.ts`; this file is the part a reviewer reads
 * as the spec.
 */
/**
 * What the hint says instead of STOP when the act has an undo (#650 comment).
 *
 * - `receipt`: the command as typed is already recoverable — say how, no STOP.
 * - `reversible-form`: the bare command has no undo, but another form of it
 *   does — name it; the bare form keeps the STOP.
 * - `stop`: no local undo (DROP TABLE, kubectl delete, gh repo delete, …).
 *
 * Invariant for every undo: it changes HOW the act runs, never WHAT the caller
 * observes afterwards — the same end state, or a refusal the next step cannot
 * miss (`--force-with-lease`, `branch -d`), never a silently different one.
 * That is why `git clean` is not offered `git stash -u`: it also reverts
 * tracked edits. The test suite runs each git recipe in a real repo.
 */
export type HintKind = "stop" | "receipt" | "reversible-form";

export interface Undo {
  kind: Exclude<HintKind, "stop">;
  text: string;
  /** Only true on a host whose agent shell archives `rm` (see rmArchives). */
  needsArchivingRm?: true;
}

/**
 * The `rm` receipt: the command, as typed, runs the archiving `rm`. The only
 * undo that depends on WHICH `rm` the shell resolves — see rmRunsThroughPath.
 */
export const RM_ARCHIVES: Undo = {
  kind: "receipt",
  needsArchivingRm: true,
  text:
    `\`rm\` in this shell archives instead of deleting (host opt-in BASTRA_RM_ARCHIVES): ` +
    `targets move to ~/_archive/<date>/<full path>, \`agent-archive restore <path>\` puts them back; ` +
    `temp dirs are really removed; /, ~ and system dirs are refused.`,
};

const FORCE_WITH_LEASE: Undo = {
  kind: "reversible-form",
  text:
    `use \`git push --force-with-lease\` instead: same result when nobody else pushed, a refusal (not a ` +
    `silent overwrite) when someone did, and the overwritten tip stays in your remote-tracking reflog.`,
};

const DROP_PLUS_REFSPEC: Undo = {
  kind: "reversible-form",
  text:
    `drop the \`+\` and use \`git push --force-with-lease\` instead: a \`+\` refspec forces its ref even under a ` +
    `lease; without it the lease refuses when someone else pushed, and the overwritten tip stays in your ` +
    `remote-tracking reflog.`,
};

/** `git` plus the global options that may sit before the subcommand. */
const git = (rest: string): RegExp => new RegExp(String.raw`\bgit(?:\s+-[Cc]\s+\S+)*\s+` + rest);

/**
 * Destructive patterns — always need a recall. Each row decides its undo side
 * here, in the same place as its pattern: `undo: null` is a deliberate STOP,
 * not a default — a new row cannot be added without choosing.
 * Order matters: longer / more specific phrases first so the *match string*
 * we surface to the user is the meaningful one.
 */
export const DESTRUCTIVE_PATTERNS: ReadonlyArray<{ label: string; re: RegExp; undo: Undo | null }> = [
  { label: "rm -rf", re: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/, undo: RM_ARCHIVES },
  { label: "rm -r", re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\b/, undo: RM_ARCHIVES },
  { label: "rmdir", re: /\brmdir\b/, undo: null },
  {
    label: "git reset --hard",
    re: git(String.raw`reset\s+--hard\b`),
    undo: {
      kind: "reversible-form",
      text:
        `committed history is not at risk (the old HEAD stays in \`git reflog\`); what dies is uncommitted ` +
        `changes to tracked files. \`git stash push\` first, then the reset — same end state, and ` +
        `\`git stash pop\` brings the changes back (onto the new HEAD; on a conflict the stash is kept). ` +
        `Untracked files are in neither: an untracked file where the target tracks one is overwritten either way.`,
    },
  },
  {
    label: "git checkout --",
    re: git(String.raw`checkout\s+--\s`),
    undo: {
      kind: "reversible-form",
      text:
        `what dies is the unstaged changes in those paths. \`git stash push --keep-index -- <paths>\` leaves ` +
        `exactly the same worktree and index; \`git restore --source=stash@{0} --worktree -- <paths>\` brings the ` +
        `changes back (not \`git stash pop\` — it conflicts when those paths also have staged changes).`,
    },
  },
  {
    label: "git clean -f",
    re: git(String.raw`clean\b[^\n]*\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force)\b`),
    undo: {
      kind: "reversible-form",
      needsArchivingRm: true,
      text:
        `\`git clean\` unlinks directly and bypasses the archiving rm. Same result, reversible: ` +
        `list with the same command plus \`-n\`, then remove exactly those paths with \`rm -r\` — ` +
        `it archives in this shell.`,
    },
  },
  {
    label: "git branch -D",
    re: git(String.raw`branch\s+-D\b`),
    undo: {
      kind: "reversible-form",
      text:
        `use \`git branch -d\` instead: same result when the branch's commits are reachable from HEAD or its ` +
        `upstream — git prints \`(was <sha>)\` and \`git branch <name> <sha>\` brings it back — and a refusal ` +
        `(not a silent loss) when it holds commits nothing else reaches.`,
    },
  },
  // A delete refspec (`:branch`), `--delete`/`-d`, `--prune` and `--mirror`
  // remove remote refs; the remote-tracking ref goes too, and with it the
  // reflog that makes a lease receipt true. Listed before the force rows so a
  // lease that deletes (`--force-with-lease origin :x`) is weighed as this.
  { label: "git push --delete", re: git(String.raw`push\b[^\n]*\s(?:--delete|-d|--prune|--mirror|\+?:\S)`), undo: null },
  // A `+` refspec forces that ref and overrides the lease: `git push
  // --force-with-lease origin +main` overwrites commits never fetched, and
  // their tip is in no local reflog. Listed before the lease row so the
  // combination is weighed as a force, never as the lease receipt.
  { label: "git push +refspec", re: git(String.raw`push\b[^\n]*\s\+[^\s:]`), undo: DROP_PLUS_REFSPEC },
  {
    label: "git push --force-with-lease",
    re: git(String.raw`push\b[^\n]*--force-with-lease`),
    undo: {
      kind: "receipt",
      text:
        `the lease refuses if the remote branch moved since your last fetch, so only what you have seen is ` +
        `overwritten; the overwritten tip stays in the remote-tracking reflog (\`git reflog <remote>/<branch>\`) ` +
        `and can be pushed back.`,
    },
  },
  // `(?![\w-])`, not `\b`: `--force-with-lease` must not also count as a bare
  // `--force` now that every matched label is weighed (#651 review).
  { label: "git push --force", re: git(String.raw`push\b[^\n]*--force(?![\w-])`), undo: FORCE_WITH_LEASE },
  { label: "git push -f", re: git(String.raw`push\b[^\n]*\s-f\b`), undo: FORCE_WITH_LEASE },
  {
    label: "git commit --amend",
    re: git(String.raw`commit\b[^\n]*--amend\b`),
    undo: {
      kind: "receipt",
      text:
        `the pre-amend commit stays in HEAD's reflog: \`git reset --soft HEAD@{1}\` right after undoes the amend. ` +
        `If the old commit was already pushed, publishing the amend needs a force-push — that one is its own hint.`,
    },
  },
  { label: "gh repo delete", re: /\bgh\s+repo\s+delete\b/, undo: null },
  { label: "gh release delete", re: /\bgh\s+release\s+delete\b/, undo: null },
  { label: "npm uninstall", re: /\bnpm\s+uninstall\b/, undo: null },
  { label: "npm rm", re: /\bnpm\s+rm\b/, undo: null },
  { label: "yarn remove", re: /\byarn\s+remove\b/, undo: null },
  { label: "pnpm rm", re: /\bpnpm\s+(?:rm|remove)\b/, undo: null },
  { label: "DROP TABLE", re: /\bDROP\s+TABLE\b/i, undo: null },
  { label: "DROP DATABASE", re: /\bDROP\s+DATABASE\b/i, undo: null },
  // #415: `TRUNCATE` alone is an English word. Requiring the object — the same
  // shape the two DROP patterns above already have — is what separates the
  // statement from a sentence that mentions truncating.
  { label: "TRUNCATE TABLE", re: /\bTRUNCATE\s+TABLE\b/i, undo: null },
  { label: "docker rm", re: /\bdocker\s+rm\b/, undo: null },
  { label: "docker volume rm", re: /\bdocker\s+volume\s+rm\b/, undo: null },
  { label: "kubectl delete", re: /\bkubectl\s+delete\b/, undo: null },
];

/**
 * Risky patterns — surface a softer hint. Same code path, only the label
 * differs so the recall query can pick up the right lessons.
 */
export const RISKY_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "chmod -R", re: /\bchmod\s+-[a-zA-Z]*R[a-zA-Z]*\b/ },
  { label: "chown -R", re: /\bchown\s+-[a-zA-Z]*R[a-zA-Z]*\b/ },
  { label: "find ... -exec rm", re: /\bfind\b[^\n]*-exec\s+rm\b/ },
  { label: "find ... -delete", re: /\bfind\b[^\n]*\s-delete\b/ },
  // Overwrite redirect: `> file` (not `>>` append, not `2>` stderr, not `>&`).
  // Require a non-`>` char before `>` and at least one whitespace+filename after.
  // `> overwrite redirect` was a pattern here until 22.08.2026. Measured over
  // Jul–Aug: 90% of all tripwire calls, 1.1M injected tokens, the same three
  // unrelated memories in 99% of the hints, 12 loads in two months (0.4%).
  // A shell idiom, not a destructive act — it carried the noise, not the
  // value. Destructive patterns above keep the STOP warning.
];

/**
 * Host opt-in: on a machine whose agent shell puts an archiving `rm` first in
 * PATH, "STOP — needs explicit confirmation" is false for rm and teaches the
 * model to fear a reversible move. Only the claude-code surface is covered —
 * that is where the shim is installed; other surfaces keep the STOP.
 */
function rmArchives(surface: string): boolean {
  return process.env.BASTRA_RM_ARCHIVES === "1" && surface === "claude-code";
}

/** The undo a destructive label's row declares, where this host can keep it. */
export function reversibleDefault(label: string, surface: string): Undo | null {
  const undo = DESTRUCTIVE_PATTERNS.find((p) => p.label === label)?.undo ?? null;
  return undo?.needsArchivingRm && !rmArchives(surface) ? null : undo;
}
