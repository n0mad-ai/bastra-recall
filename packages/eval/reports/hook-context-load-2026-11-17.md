# Hook context load: baseline for #1460, #1461, #1464 (2026-11-17)

Measured read-only from one developer machine's event log with `packages/eval/src/hook-context-load.ts` (see `context-load-1371-2026-11-03.md`, "Repeating the measurement"). Window: 2026-11-03 to 2026-11-16 inclusive, 60,099 events, all before the changes of #1460 and #1461. Sizes are the lanes' own chars/4 estimates. One machine, one owner's work pattern: descriptive, not representative.

```sh
SINCE=2026-11-03 UNTIL=2026-11-16 npm run hook-context-load --workspace @bastra-recall/eval
```

## Lanes (tokens per call that injected text)

| lane · agent | calls | injected | p50 | p95 | max | sum |
|---|---:|---:|---:|---:|---:|---:|
| session_hook_call · main | 142 | 142 | 2,431 | 2,455 | 2,459 | 345,591 |
| prompt_hook_call · main | 803 | 514 | 280 | 782 | 1,604 | 184,154 |
| hook_call (Write/Edit) · subagent | 1,054 | 407 | 159 | 594 | 1,385 | 101,874 |
| bash_hook_call · subagent | 650 | 650 | 119 | 121 | 226 | 78,287 |
| todo_hook_call (plan) · main | 101 | 70 | 433 | 608 | 814 | 31,928 |
| bash_hook_call · main | 166 | 166 | 119 | 121 | 228 | 20,266 |
| bash_fail_hook_call · subagent | 171 | 66 | 239 | 437 | 484 | 16,948 |
| hook_call (Write/Edit) · main | 184 | 63 | 150 | 679 | 1,087 | 15,277 |
| bash_fail_hook_call · main | 43 | 25 | 310 | 406 | 629 | 7,755 |

Rows with agent `unknown` (client rows without a delivered answer) injected nothing and are left out. Draft quotes on top of the lanes: UserPromptSubmit 262 (p50 202, max 237, sum 52,836), PreToolUse 281 (p50 176, max 237, sum 48,031).

## #1460: pre-tool sizes

Before: no character limit per pre-tool event. Largest Write/Edit injections were Codex patches over four files, where the code-impact and applies-to blocks alone reached 1,062 + 471 tokens (event of 2026-10-31, 1,748 tokens total). The plan lane stays below 840 tokens (5 hits).

After: each pre-tool lane keeps its optional text within 4,000 characters (`packages/daemon/src/pretool-budget.ts`). In this window the cap would have bound only the Write/Edit calls above roughly the p99 (1,011 tokens ≈ 4,044 characters); the draft quote counts inside the cap, and inside the prompt lane's 10,000 characters. The after-measurement is the same command over a window after the release.

**Draft quote on `ls`:** the Bash lane's quiet path (no tripwire pattern) still runs the draft search with the raw command text as the query (`bash-pre-lane.ts`, the `appendLaneDrafts` call on the no-match path). Any command whose words or literals match a stored draft can therefore bring a quote, including a plain `ls <path>`; the quote is chosen by text match against the command, not by relevance to the action. The cap now bounds its size; whether quiet Bash commands should search drafts at all is left open (product question).

## #1461: rule kernel re-delivery

| agent | full deliveries | characters | identical repeats in the same session | characters |
|---|---:|---:|---:|---:|
| main | 255 | 2,380,464 | 210 | 1,960,662 |
| subagent | 593 | 5,534,743 | 542 | 5,058,430 |

848 full kernels (about 7.9 million characters, ~2 million tokens) in two weeks; 752 of them (89 %) repeated a kernel the same session had already received byte-identically. Subagents share the session's tool-call count, so in sessions with many parallel subagents the kernel arrived every few calls. One session received 164 deliveries.

After: an agent (main thread or one subagent) that already holds the identical kernel in this session gets a reminder of a few hundred characters with the catalog hash and the way back (`list_rules`, `load_memory`); a changed kernel, a new agent and every compact/clear bring the full text again. Telemetry marks the reminder as `kernel_reminder_chars`, which the measurement counts separately.

## #1464: plan lane after the ExitPlanMode switch

- Claude Code: **0** plan-lane calls in the window (2 in October, 2 in September). The registration listens to `TodoWrite|TaskCreate|ExitPlanMode`, but no Claude Code session on this machine called any of these tools since 2026-10-20 (local transcripts checked: the only `ExitPlanMode` and `TodoWrite` calls are from May 2026). The hook is not broken; its trigger does not occur in the current way of working.
- Codex (`update_plan`): 101 calls, 70 injected text (p50 433 tokens, sum 31,928 tokens), 31 suppressed by the empty-streak backoff.
- Usage signal: 4 of 101 plan-lane recalls were followed by a `load_memory` that names them as its source (`from_hook_recall`).

Decision for the owner: keep the Claude Code plan registration (costs nothing while it does not fire) or remove it, and whether the Codex plan lane's ~32k tokens per two weeks are worth 4 followed loads.
