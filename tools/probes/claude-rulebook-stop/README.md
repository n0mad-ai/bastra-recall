# Claude Stop continuation fixture (#1370)

Run `nice -n 15 python3 tools/probes/claude-rulebook-stop/run.py` with a locally installed Claude Code CLI. The script uses a temporary working/config directory, explicit settings with no user/project/local settings sources, a loopback Anthropic protocol fixture and one local test MCP server. It does not call a real model or alter installed hooks. Raw stdout, hook inputs, requests and tool calls remain in the printed temporary artifact directory. Assertions fail if continuation, MCP execution, loop flags or notification behavior differ.

Observed 2026-11-07 on Claude Code 2.1.319: both `decision: block` and Stop `additionalContext` produced three provider requests, one actual `rulebook_check` tool execution and Stop flags `false`, then `true`. Only block emitted a `stop-hook-error` notification. See [result](result-2.1.319.json). The issue's older 2.1.316 was not installed or tested.

The current [official Stop contract](https://code.claude.com/docs/en/hooks#stop-decision-control), checked 2026-11-07, explicitly describes `additionalContext` as non-error feedback that continues the conversation. Its wording: “It keeps the conversation going through the same loop protections as `decision: "block"`”. The same section names `stop_hook_active` and the eight-continuation limit for both forms.

This is a deterministic host protocol test, not a real-model follow-through rate or interactive TUI certification. The stream notification difference matches the documented display distinction; no claim about universal semantic rule compliance follows. Bastra changes only the Claude Stop output/dispatch, preserves its one-request budget, and retains Codex's separately certified block format and all PreToolUse denial behavior.
