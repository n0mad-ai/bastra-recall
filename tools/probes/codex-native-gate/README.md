# Native Codex CLI 0.166.0 Gate probe

Run `python3 tools/probes/codex-native-gate/run.py` with the installed `codex-cli 0.166.0`, or `--expected-version <version>` for a new release (see "Checking a new Codex CLI release" in `docs/rulebook-host-probes.md`). The runner refuses any other installed version before launching Codex.
It creates a separate empty temporary Codex config for every case, uses a local scripted Responses SSE server, and invokes no real model or remote provider. It does not copy credentials, change installed hooks/config or contact the live daemon. Its inline hooks run only with invocation-local trust bypass in these clean profiles.

Cases: exec_command/Bash and view_image, each allowed, denied with the native PreToolUse permissionDecision, and denied once/retried through the actual Bastra source Gate. Controls must produce real command output or deliver a valid synthetic PNG. Denied calls must deliver a hook-block tool result without that output/image; retries must pass. All assertions must succeed. The raw result and CLI/hook artifacts are stored under the printed temporary artifact directory. The committed result is an actual run, not a manually reconstructed summary.

The source-adapter case seeds one invented pending must-load claim in temporary state. It calls runGateLane directly; it does not certify shipped Node/stub-to-HTTP routing, all tool types, fork, or model understanding. The source-adapter case reports the expected version to the Gate, so a candidate version passes it only in a source copy where that version was added to `CODEX_GATE_VERIFIED_VERSIONS`.

For Stop, use the sibling codex-rulebook-stop runner with the same `--expected-version` and an empty temporary Codex profile. Never disable or replace live hooks to make a probe run. The Stop runner refuses unrelated installed hooks.
