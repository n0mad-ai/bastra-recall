# Rulebook hook evidence, 2026-10-30

These are boundary observations, not a universal claim that the host honors a deny on every tool.
Runtime: **Codex CLI 0.162.1**, reported by the installed executable. No certification for Desktop/IDE or other versions.

During the Phase-3 implementation, in the actual Codex session:

- `apply_patch` created a disposable text file under `/private/tmp`. The installed write hook emitted `hook_call`, `tool_name=apply_patch`, at `2026-10-30T16:43:09.071Z`. The file was verified and removed. This establishes a PreToolUse boundary, **not a deny**: the running daemon still used the preceding implementation. `apply_patch` therefore remains outside runtime-verified deny coverage.
- A read-only Bastra MCP `load_memory` call was executed in this session. The running daemon exempts Bastra MCP calls from denial. Successful retrieval cannot establish a denied MCP write, nor does absence of a gate log prove absence of a host boundary. MCP deny remains **unverified**. No live vault write was used as a probe.
- An `exec_command` started a waiting Python stdin reader; `write_stdin` delivered a marker and completed it. The recent installed gate trace contained Bash events and the patch event, with no new write_stdin event. This observation is consistent with the existing #1300 probe: there is no fresh PreToolUse boundary for the resumed process. A shell continuation must not be advertised as a newly gated action.
- The preceding #1300 runtime probe remains the deny evidence for `exec_command` (hook name Bash) and `view_image`. Sources are linked in `host-capabilities.ts`; a lane replay is not another host certification.
- A separate isolated Codex CLI 0.162.1 Stop protocol probe is now verified below. It certifies Stop continuation, not every MCP or patch denial and not semantic rule compliance.

Local raw observation source: the installed hook telemetry, filtered to the current session and the event/tool fields above. No prompt text, credentials or user's rules are included here. The host matrix intentionally retains the distinction between observed boundary, documented behavior and runtime-verified deny.

## Deutsch

Der Patch-Hook wurde in dieser Sitzung live beobachtet. Das beweist noch keine funktionierende Sperre. MCP-Schreibsperren bleiben ungeprüft; Codex-Stop ist für CLI 0.162.1 mit der separaten lokalen Probe belegt; `write_stdin` hat keine neue Sperrgrenze. Die Host-Matrix weist diese Grenzen ausdrücklich aus. Die neuen automatischen Tests prüfen Bastras Verhalten, zertifizieren aber keinen zusätzlichen Host.


## Isolated Codex Stop protocol (counter-review correction)

Primary reference: [official OpenAI Hooks documentation, Stop](https://learn.chatgpt.com/docs/hooks#stop). A blocking Stop asks for a continuation; continue:false takes precedence and terminates the turn. This is distinct from PreToolUse denial.

Reproduce with `python3 tools/probes/codex-rulebook-stop/run.py` in a clean Codex account/config with no unrelated or managed hooks. The committed script refuses a normal installation containing other hooks before launching Codex; it does not move, disable or rewrite your installed configuration. The fixture invokes the installed **codex-cli 0.162.1** against a local deterministic Responses SSE server. No model is invoked, credentials are not copied, user configuration is unchanged, configured MCP clients/apps are disabled for the invocation, and only synthetic output/event metadata are retained. Vetted inline command hooks are supplied through invocation-only config overrides with hook trust bypassed. Earlier observed runs used the installed environment with additional Bastra hooks. A later attempt to rerun with hook-trust bypass was rejected by automatic approval review because unrelated installed hooks could have side effects. The stored successful protocol/source results are retained; no further such invocation was executed. An initial project-discovery attempt did not run the probe hooks and was rejected as inconclusive; the recorded successful probe explicitly verifies that the hooks ran.

[Recorded result](../tools/probes/codex-rulebook-stop/result-0.162.1.json) is an explicitly marked handwritten summary of the earlier observations, not raw script output. `run.py` emits `results` with `responses` and raw `events`, plus `artifact_dir`; the summary uses `cases` and selected derived fields. No new native run was performed for this correction.

- First Stop returned decision:block. Codex requested a second synthetic response. Stop flags were false then true. Session and turn IDs remained the same, and UserPromptSubmit ran only once.
- A Stop returning both decision:block and continue:false stopped after one response. There was no continuation.
- The third case runs the actual Bastra beginRulebookRound/runStopLane source through an inline source adapter invoked by the native hooks. It bypasses the shipped Node/stub hook client, HTTP routing and normal transcript reader (the adapter supplies the synthetic transcript directly). It certifies the source/host Stop continuation boundary, not the end-to-end shipped hook-client path. The prompt is only an invented Spanish message, with no instruction. It triggers one continuation, then finishes after the second response. The scripted provider deliberately calls no tools: this proves the bounded rulebook/Stop path, not semantic rule selection by a model.

The shipped rulebook Stop path is enabled for this exact Codex version and tested with EN/JA/RU/ES pasted-message fixtures. It blocks at most once per actor/round; deferred ordinary Stop work runs in the continuation. An installed Stop registration remains required. No certification for other versions, Desktop/IDE, hidden-first-display behavior or semantic model choices follows from this protocol test. Patch/MCP write-deny gaps above remain open. The matrix marks the overall Codex rulebook gate as preparation-only at the host-certification layer while retaining its shipped implementation status.

## Catalog-only performance observation

Read-only local observation with 1560 vault memories: first cache build 100.18 ms; 30 subsequent cached calls caused zero additional catalog scans (one total). The fixture supplied a fixed empty floor list; these are catalog-only timings, not end-to-end hook latency. Cache membership keys include the real floor configuration in normal use. Change-event invalidation and concurrent-call coalescing have deterministic regression tests.

## Session and actor attribution limits

The MCP forwarder uses only the Claude Code statusline's session identity. It ignores `CODEX_THREAD_ID`: Claude can inherit that variable from a launching Codex shell, so it cannot identify the current MCP host. There is no certified Codex MCP `load_memory` session attribution in this adapter. Codex uses `rulebook_check` with the exact `session_id` printed in the prompt notice or gate/Stop reason; the prompt notice includes a usable example before the first Stop. No Codex environment forwarding or adapter `env_vars` support is claimed.

A missing actor ID defaults to main for ordinary loads and checks. Explicit worker IDs remain separate. A Claude Code subagent that omits `agent_id` on `rulebook_check` cannot be distinguished from main and can record a main receipt; transport session identity is not worker authentication. The same limit applies to headerless loads. The caller must supply its worker ID; semantic compliance and adversarial caller isolation are not guaranteed.

Legacy pending-must-load and reflex denials retain their previous finite claims independently of C's two-denial round allowance. A previously unseen reflex can therefore deny after C is exhausted, once per rule/session. A pending hint can deny once per booked claim. The new allowance cannot swallow them.

The catalog cache expires after 2 seconds as well as on index events. Expiry rereads indexed source bytes and recomputes staleness, including privacy/scope changes missed by a cloud watcher; newly created unindexed files still require index discovery. This bounds reuse age, not cloud discovery or end-to-end latency.

Fix-round-2 local measurement, same 1560-memory vault: six forced TTL misses through in-process `runGateLane` (catalog rebuild, state persistence and deny rendering) took 104.48, 93.99, 94.26, 90.27, 89.79 and 91.34 ms; all returned deny within the 500 ms lane budget. Fixed empty floors, global scope and no reflex candidates; no HTTP/hook-client transport or arbitrary cloud latency guarantee. Raw local output: `/private/tmp/phase3-fix2-perf.json`.

## Fix-round-3: independent budgets and nested hosts

The action-side catalog lookup and C boundary together get at most 150 ms of the default 500 ms gate budget (at most half the configured hook budget). An exception, timeout or never-resolving catalog makes C unavailable for that call; the old pending/reflex gates continue on their original deadline. Late catalog completion cannot acquire a fresh denial reservation. No stale-while-revalidate path was added; the existing cache TTL remains.

A C action denial reserves a round attempt before the legacy write, to keep concurrent calls bounded. The lane settles that reservation at its return/delivery boundary. A passed call, timeout or later failed gate write releases the reservation for the same actor/context/round; a delayed rollback cannot alter a new round. Rollback requires working state storage, like legacy rollback; it cannot guarantee recovery while the store itself remains unwritable. Direct in-process calls settle on return. HTTP delivery receipts apply where the route supplies the existing delivery scope; this is not a host/model-reading receipt.

Process ancestry now stops when the nearer host is Codex instead of crossing it to reach a launching Claude process. A Codex forwarder therefore does not read or overwrite that Claude statusline feed; a Claude launched inside Codex still finds its own nearer Claude host. This complements ignoring inherited CODEX_THREAD_ID; inherited environment alone is not host identity.

### Claude subagent identity: Gate versus MCP load

Primary documentation checked 2026-10-30:

- [Claude Code hook common input fields](https://code.claude.com/docs/en/hooks#common-input-fields) documents agent_id/agent_type in hook payloads. Bastra's PreToolUse Gate uses that actor ID; a named worker does not inherit main's C receipt.
- [Subagent MCP server scope](https://code.claude.com/docs/en/sub-agents#scope-mcp-servers-to-a-subagent) documents that references to existing MCP servers share the parent's connection. Separate inline servers are possible, but are not Bastra's installed shared connection.
- [MCP dynamic headers](https://code.claude.com/docs/en/mcp#use-dynamic-headers-for-custom-authentication) describes headers helpers at connection/reconnection time, not per tool invocation; the documented helper environment names the server and URL, not the calling subagent. The [environment reference](https://code.claude.com/docs/en/env-vars) and MCP reference do not document an automatic per-call subagent identity for the shared stdio server.

Conclusion (an inference from the documented surfaces, not proof of every private implementation detail): there is no supported per-call Claude subagent ID transport established for Bastra's shared MCP connection. No environment guess or last-hook-wins global actor is implemented. Headerless load_memory is attributed to the session's main actor, so a worker load can satisfy main and activate main conventions; it does not satisfy the worker's separately keyed Gate receipt. A worker answers its own Gate using rulebook_check with the explicit agent_id shown by that Gate. An omitted or false ID remains an honest-self-report limitation, not authenticated isolation. A Gate actor ID is not evidence that the subsequent shared MCP load retained that ID.

## Fix-round-4: bounded catalog reads on every hook path

The common catalog boundary in rulebook-catalog.ts now limits each cache access and catalogFor read to 150 ms, including cold builds and injected providers. This covers Prompt, Stop, session-context construction and periodic kernel delivery, rather than only action C. Catalog errors/timeouts make the new check unavailable for that call; existing prompt task hints and ordinary Stop repair/harvest continue. A late read does not chain into a late Prompt/Stop state mutation. The underlying read may finish and populate the cache later; concurrent callers share a pending build for the same retained key even past the TTL. A failed build is removed for retry.

This fix retains the existing TTL/source-freshness contract instead of serving an expired catalog via stale-while-revalidate: it does not extend the lifetime of possibly changed binding/privacy metadata. A caller gets the current catalog within the short deadline or an unavailable result/error handled by its lane. JavaScript deadlines are cooperative; they cannot interrupt synchronous CPU work or an already running filesystem syscall.

Periodic delivery remains due until delivered: catalog failure/timeout leaves the tool counter due, and the next call retries. A finished context response resets cadence; an aborted response leaves delivery due. An empty, successfully checked catalog resets cadence without a context block. C rollback is now asynchronous bookkeeping with rollback-failed audit on persistence failure; it never waits for a held state lock in the response path. State-store failure still limits recovery.

The actual /hook/gate route now supplies createLaneDelivery, covering C, legacy pending/reflex claims and periodic context delivery. A close before finish or a response beyond its daemon deadline releases denials; periodic context stays due. The existing transport helper distinguishes deny receipts from context receipts so a context-only response cannot confirm a denied-action reservation. This closes the missing route scope; the daemon's deadline and client timeout still have different starting points. A server finish is a local HTTP transport observation, not proof that a timed-out client accepted the result or that the model read it. A disconnect after server finish is outside that observation; no end-to-end host receipt is claimed.
