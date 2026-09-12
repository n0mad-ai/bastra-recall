#!/bin/sh
# Codex plan-event probe (#506) — the whole hook.
#
# Appends the hook payload it was handed, verbatim, to $PROBE_LOG and answers
# `{}` so the Codex turn is never blocked or altered. It touches nothing else:
# no daemon, no vault, no telemetry.
cat >> "$PROBE_LOG"
printf '\n' >> "$PROBE_LOG"
echo '{}'
