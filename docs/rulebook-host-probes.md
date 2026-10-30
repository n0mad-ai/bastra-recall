# Rulebook hook evidence, 2026-10-30

These are boundary observations, not a universal claim that the host honors a deny on every tool.
Runtime: **Codex CLI 0.162.1**, reported by the installed executable. No certification for Desktop/IDE or other versions.

During the Phase-3 implementation, in the actual Codex session:

- `apply_patch` created a disposable text file under `/private/tmp`. The installed write hook emitted `hook_call`, `tool_name=apply_patch`, at `2026-10-30T16:43:09.071Z`. The file was verified and removed. This establishes a PreToolUse boundary, **not a deny**: the running daemon still used the preceding implementation. `apply_patch` therefore remains outside runtime-verified deny coverage.
- A read-only Bastra MCP `load_memory` call was executed in this session. The running daemon exempts Bastra MCP calls from denial. Successful retrieval cannot establish a denied MCP write, nor does absence of a gate log prove absence of a host boundary. MCP deny remains **unverified**. No live vault write was used as a probe.
- An `exec_command` started a waiting Python stdin reader; `write_stdin` delivered a marker and completed it. The recent installed gate trace contained Bash events and the patch event, with no new write_stdin event. This observation is consistent with the existing #1300 probe: there is no fresh PreToolUse boundary for the resumed process. A shell continuation must not be advertised as a newly gated action.
- The preceding #1300 runtime probe remains the deny evidence for `exec_command` (hook name Bash) and `view_image`. Sources are linked in `host-capabilities.ts`; a lane replay is not another host certification.
- No live Codex Stop-block probe was performed. Codex Stop checking remains unimplemented/unverified; the shipped lane explicitly skips it. Claude Code uses its documented command Stop `decision: block` contract, tested with bounded lane replays. There is no guarantee that the first answer was hidden before a continuation.

Local raw observation source: the installed hook telemetry, filtered to the current session and the event/tool fields above. No prompt text, credentials or user's rules are included here. The host matrix intentionally retains the distinction between observed boundary, documented behavior and runtime-verified deny.

## Deutsch

Der Patch-Hook wurde in dieser Sitzung live beobachtet. Das beweist noch keine funktionierende Sperre. MCP-Schreibsperren und Codex-Stop bleiben ungeprüft; `write_stdin` hat keine neue Sperrgrenze. Die Host-Matrix weist diese Grenzen ausdrücklich aus. Die neuen automatischen Tests prüfen Bastras Verhalten, zertifizieren aber keinen zusätzlichen Host.
