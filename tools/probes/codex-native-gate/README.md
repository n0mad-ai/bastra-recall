# Native Codex CLI 0.166.0 Gate probe

Run `python3 tools/probes/codex-native-gate/run.py` with the installed `codex-cli 0.166.0`.
It creates a separate empty temporary Codex config for every case, uses a local scripted Responses SSE server, and invokes no real model or remote provider. It does not copy credentials, change installed hooks/config or contact the live daemon. Its inline hooks run only with invocation-local trust bypass in these clean profiles.

Cases: exec_command/Bash and view_image, each allowed, denied with the native PreToolUse permissionDecision, and denied once/retried through the actual Bastra source Gate. Controls must produce real command output or deliver a valid synthetic PNG. Denied calls must deliver a hook-block tool result without that output/image; retries must pass. All assertions must succeed. The raw result and CLI/hook artifacts are stored under the printed temporary artifact directory. The committed result is an actual run, not a manually reconstructed summary.

The source-adapter case seeds one invented pending must-load claim in temporary state. It calls runGateLane directly; it does not certify shipped Node/stub-to-HTTP routing, all tool types, fork, or model understanding. Other version numbers are rejected by the runner.

For Stop, use the sibling codex-rulebook-stop runner with `--expected-version 0.166.0` and an empty temporary Codex profile. Never disable or replace live hooks to make a probe run. The Stop runner refuses unrelated installed hooks.
