/** Measurement observations, NOT a proposed task/API/storage schema. */
export type Verdict = "passed" | "failed" | "pending" | "not_evaluable";
export interface ProactiveCase {
  id: string;
  issue: 402 | 410;
  dependencies: string[];
  stimulus: string;
  /** Assertions must be derived from receipts/state/effects, never an adapter's verdict. */
  expected: Record<string, boolean | number | string>;
}

export const PROACTIVE_CASES: ProactiveCase[] = [
  {"id":"p3-source-key-tuple-boundary","issue":410,"dependencies":["P1","P2","P3"],"stimulus":"Register two valid event sources in separate owner domains: source collision:a with key b, and source collision with key a:b. Submit equal values through their own authenticated configured producers. Both accepted events must have separate IDs and retain their exact source/actor/domain bindings.","expected":{"accepted_submissions":2,"journal_events":2,"distinct_event_ids":2,"source_actor_bindings_exact":true,"foreign_domain_receipt_reused":false}},

  {"id":"p3-automatic-evaluation","issue":402,"dependencies":["P1","P2","P3"],"stimulus":"No task_reconcile anywhere: persist future armed tasks, cross their due instant with a child-only fixture clock, and observe exactly one durable firing after daemon restart, ordinary next contact and 60s background polling in separate subruns.","expected":{"startup_logical_firings":1,"contact_logical_firings":1,"poll_logical_firings":1,"manual_reconcile_calls":0}},
  {"id":"p3-returning-source-transitions","issue":410,"dependencies":["P1","P2","P3"],"stimulus":"Register real temporary file and Git-ref sources; observe A,B,A,B using the published source adapter and frozen timestamps; repeated unchanged polls remain quiet. Four journal events per source are required, even when a prior value returns.","expected":{"file_events":4,"git_events":4,"unchanged_polls_quiet":true,"distinct_event_ids":8}},

  {"id":"p2-auth-boundaries","issue":410,"dependencies":["P1","P2"],"stimulus":"Run unauthenticated/legacy-token/foreign-Origin, cross-domain, agent owner-operation, spoof-field, rotated/revoked-credential requests against the real isolated daemon.","expected":{"unauthorised_successes":0,"cross_domain_visible":false,"agent_notify_arm_allowed":true,"spoofed_authority":false,"revocation_immediate":true,"foreign_origin_denied":true}},
  {"id":"p2-transport-parity","issue":402,"dependencies":["P1","P2"],"stimulus":"Create/get/list with the same agent credential and idempotency key through canonical REST, tool HTTP, an actual MCP stdio forwarder and CLI subprocess; explicit notify arm+origin now accepted under Owner decision11.10.2026; compare state/revisions and unchanged Owner-review denial codes.","expected":{"same_task_all_transports":true,"stored_tasks":1,"agent_notify_armed":true,"denial_codes_match":true}},
  {"id":"p2-owner-lifecycle","issue":402,"dependencies":["P1","P2"],"stimulus":"Owner review without signing key, snooze, cosmetic/trigger edits, resolve/cancel, explicit rearm; missing occurrence acknowledgement denied; Owner decision 11.10.2026 replaces notify authority expectation: agent resolves notify and snoozes30/60days without ceiling; rearm/review remain Owner.","expected":{"owner_notify_armed":true,"agent_rearm_denied":true,"agent_notify_resolve_allowed":true,"missing_occurrence_ack_denied":true,"notify_snooze_unbounded":true,"edits_disarm":true,"terminal_not_resurrected":true,"rearm_unarmed_new_generation":true}},
  {"id":"p2-durable-restart","issue":402,"dependencies":["P1","P2"],"stimulus":"Create and owner-review a task through HTTP, stop/restart the actual isolated daemon, retrieve through HTTP/MCP/CLI and verify unchanged task/revision/history/private file modes.","expected":{"task_equal_after_restart":true,"history_retained":true,"private_modes":true,"fabricated_occurrences":0}},
  {"id":"p2-concurrency-cas","issue":410,"dependencies":["P1","P2"],"stimulus":"Race equal expected_revision edits and duplicate idempotent creates over real concurrent HTTP requests; reject a changed payload under the old idempotency key and stale tokens.","expected":{"cas_winners":1,"cas_conflicts":1,"idempotent_ids":1,"idempotency_drift_denied":true,"history_append_only":true}},
  {"id":"p1-p2-corruption-recovery","issue":410,"dependencies":["P1","P2"],"stimulus":"Check ENOENT first-run and v1 round-trip; stop daemon, inject truncated/future store, restart and verify 503 preservation. Invoke published P1 explicit backup recovery while stopped; preserve originals, disarm, invalidate old revision and retrieve via daemon.","expected":{"first_run_empty":true,"corruption_503":true,"future_version_503":true,"original_bytes_preserved":true,"recovery_disarmed":true,"old_revision_denied":true,"private_modes":true}},

  { id: "seven-day-evaluation", issue: 402, dependencies: ["P2", "P3", "P5"], stimulus: "Persist a request to evaluate a run after seven days. Advance the frozen clock seven days, then contact the client.", expected: { durable_before_fire: true, logical_firings: 1, gate_claimed_passed: false } },
  { id: "active-session-deadline", issue: 402, dependencies: ["P2", "P3", "P5"], stimulus: "Reach a deadline in an ongoing session with no semantic recall hits; perform the next suitable contact.", expected: { logical_firings: 1, delivery_attempts: 1, acknowledgement_receipts: 0 } },
  { id: "offline-restart", issue: 402, dependencies: ["P2", "P3", "P5"], stimulus: "Create a task, disconnect past its due time, restart, then contact a hookless client.", expected: { logical_firings: 1, due_retained: true, background_claimed: false } },
  { id: "relay-overflow-disabled-purged", issue: 402, dependencies: ["P2", "P5"], stimulus: "Overflow output, disable and purge the relay in separate subruns, then retry contact.", expected: { due_retained_all_subruns: true, fabricated_acknowledgements: 0, stable_retry_ids_all_subruns: true } },
  { id: "multi-client-occurrence", issue: 402, dependencies: ["P2", "P3", "P5"], stimulus: "Race two isolated clients and retry delivery for the same due occurrence.", expected: { logical_firings: 1, stable_retry_ids: true, duplicate_resolutions: 0 } },
  { id: "acknowledged-unfinished", issue: 402, dependencies: ["P2", "P5"], stimulus: "Acknowledge a presented occurrence without resolving, restart, then inspect it.", expected: { acknowledgement_receipts: 1, remains_open: true, resolution_receipts: 0 } },
  { id: "dst-recurrence-rollback", issue: 402, dependencies: ["P2", "P3"], stimulus: "Replay Europe/Madrid DST gap and overlap, recurrence catch-up and clock rollback against the declared P0 policy.", expected: { declared_policy_followed_all_subruns: true, duplicate_occurrences: 0 } },
  { id: "material-premise-change", issue: 402, dependencies: ["P2", "P4", "P5", "P6"], stimulus: "Change a pinned load-bearing premise with fresh evidence; retry its event, then exercise keep/change/snooze/stop in separate subruns.", expected: { reconsiderations_per_event: 1, automatic_decision_reversals: 0, controls_persist_all_subruns: true } },
  { id: "unknown-source-controls", issue: 402, dependencies: ["P2", "P4", "P6"], stimulus: "Separately replay unchanged, irrelevant, stale, failed and contested sources.", expected: { false_reconsiderations: 0, unknown_not_false_all_subruns: true } },
  { id: "supersession", issue: 410, dependencies: ["P2", "P6", "P7"], stimulus: "Edit, cancel and supersede a watched decision after creating a proposal in separate subruns.", expected: { silent_rebindings: 0, old_approvals_spent: 0, history_retained_all_subruns: true } },
  { id: "prepare-forgery-drift", issue: 410, dependencies: ["P2", "P7", "P8"], stimulus: "Prepare without executing; try source=user/approved=true forgery, old/expired/revoked approval and payload/source/target drift as separate subruns.", expected: { unauthorised_effects: 0, exact_review_required_all_subruns: true } },
  { id: "external-success-no-receipt", issue: 410, dependencies: ["P7", "P8"], stimulus: "Inject crashes before the adapter call, after artifact write/before local receipt, and during recovery; verify artifact hashes and rollback.", expected: { unsafe_retries: 0, duplicate_effects: 0, reconciled_or_review_required_all_subruns: true, rollback_restores_hash: true } },
  { id: "owners-fencing", issue: 410, dependencies: ["P7", "P8"], stimulus: "Withhold one required owner-domain approval; separately expire and replace a local lease before spending it.", expected: { partial_approval_effects: 0, expired_lease_effects: 0 } },
  { id: "kill-recovery", issue: 410, dependencies: ["P2", "P7", "P8", "P9"], stimulus: "Stop execution globally and disable the adapter separately, then recover read/review/notify.", expected: { stopped_effects: 0, history_retained_all_subruns: true, read_review_notify_available: true } },
  { id: "migration-corruption", issue: 410, dependencies: ["P1", "P2", "P10"], stimulus: "Replay clean install, supported old schema and downgrade; inject a truncated/corrupt store and recover originals.", expected: { silent_loss: 0, corruption_visible: true, originals_preserved: true, supported_migrations_pass: true } },
  { id: "reference-containment-revocation", issue: 410, dependencies: ["P7", "P8"], stimulus: "Try an artifact outside the registered root and a revoked exact approval; perform one valid approved reversible update inside the temporary root.", expected: { escaped_writes: 0, revoked_effects: 0, valid_effects: 1, rollback_restores_hash: true } },
  {"id":"p11-session-hook-auto","issue":402,"dependencies":["P11"],"stimulus":"Fresh empty task access; real daemon auto creates Agent credential. Agent creates armed user-request notify, cross due by frozen child clock, actual default session-hook.js subprocess receives exactly one data card/one attempt; restart/access/client config retained. No manual mint/setup/env token.","expected":{"agent_armed_notify":true,"logical_firings":1,"hook_blocks":1,"hook_card_received":true,"delivery_attempts":1,"fabricated_acknowledgements":0,"automatic_agent_private":true,"restart_access_stable":true,"foreign_client_unchanged":true}},
  {"id":"p11-prompt-hook-auto","issue":402,"dependencies":["P11"],"stimulus":"Same real automatic access boundary; armed agent-observed notify delivered by actual prompt-hook.js UserPromptSubmit subprocess. One frame/attempt, no acknowledgement by display.","expected":{"agent_armed_notify":true,"logical_firings":1,"hook_blocks":1,"hook_card_received":true,"delivery_attempts":1,"fabricated_acknowledgements":0,"automatic_agent_private":true,"restart_access_stable":true,"foreign_client_unchanged":true}},
  {"id":"p11-no-upgrade","issue":410,"dependencies":["P11"],"stimulus":"Agent tries notify\u2192prepare/execute for armed and unarmed tasks and direct armed prepare/execute; zero upgrades. Owner review/rearm and default execution stop retain old boundary.","expected":{"unauthorised_upgrades":0,"notify_levels_preserved":true,"review_rearm_still_owner":true,"execution_default_stopped":true}},
  {"id":"p11-raw-reminder-dedup","issue":402,"dependencies":["P11"],"stimulus":"Equal content/time with new key/client/session returns one ID; equal invented secrets under redaction returns one ID; distinct actual secrets whose stored redaction text matches remain distinct. Different time/goal separate, no raw secret stored.","expected":{"same_content_time_single_id":true,"redacted_exact_same_single_id":true,"distinct_raw_secrets_distinct_ids":true,"distinct_time_target_not_merged":true,"raw_secrets_persisted":false,"tasks_stored":5}},
  {"id":"p11-conversation-controls","issue":402,"dependencies":["P11"],"stimulus":"Automatically configured Agent acknowledges exact due occurrence, snoozes30 then60days without ceiling, resolves and cancels notify; ack remains separate from resolution; actual restart preserves all commands. This is tool-mediated conversation mechanics, not human understanding.","expected":{"agent_acknowledgement":true,"ack_not_resolution":true,"unbounded_notify_snooze":true,"agent_resolve_cancel":true,"controls_survive_restart":true}},
  {"id":"p11-no-reminder-quota","issue":402,"dependencies":["P11"],"stimulus":"Automatic Agent creates35 distinct open notify reminders then5 on next frozen day; no policy/day/open quota rejection. Finite probe only, not an infinite capacity assertion.","expected":{"accepted_notify":40,"distinct_open_tasks":40,"rejected_by_quota":0}},
];

export interface Observation {
  case_id: string;
  repetition: number;
  values: Record<string, boolean | number | string>;
  /** Private receipt/state/effect evidence accompanies this row in the run artifact. */
  evidence: unknown[];
}
export interface CaseResult {
  case_id: string;
  repetition: number;
  verdict: Verdict;
  mismatches: string[];
  missing: string[];
}
export function evaluateObservation(c: ProactiveCase, row: Observation): CaseResult {
  if (row.case_id !== c.id || !Number.isInteger(row.repetition) || row.repetition < 1 || row.repetition > 3)
    throw new Error("invalid case/repetition");
  const missing = Object.keys(c.expected).filter(key => !Object.hasOwn(row.values, key));
  const mismatches = Object.keys(c.expected).filter(key => Object.hasOwn(row.values, key) && row.values[key] !== c.expected[key]);
  if (!Array.isArray(row.evidence) || !row.evidence.length) missing.push("receipt/state/effect evidence");
  return { case_id: c.id, repetition: row.repetition,
    // An observed violated invariant remains failed even with incomplete evidence elsewhere.
    verdict: mismatches.length ? "failed" : missing.length ? "not_evaluable" : "passed", mismatches, missing };
}
export function summarizeObservations(rows: Observation[]) {
  const cases = new Map(PROACTIVE_CASES.map(c => [c.id, c]));
  const seen = new Set<string>();
  const results = rows.map(row => {
    const c = cases.get(row.case_id);
    if (!c) throw new Error("unregistered case");
    const key = `${row.case_id}:${row.repetition}`;
    if (seen.has(key)) throw new Error("duplicate case/repetition");
    seen.add(key);
    return evaluateObservation(c, row);
  });
  const expected = PROACTIVE_CASES.length * 3;
  const missing_runs = expected - results.length;
  const functional: Verdict = results.some(r => r.verdict === "failed") ? "failed"
    : results.some(r => r.verdict === "not_evaluable") ? "not_evaluable"
    : missing_runs ? "pending" : "passed";
  return { functional_verdict: functional, expected_runs: expected, observed_runs: results.length, missing_runs,
    passed: results.filter(r => r.verdict === "passed").length,
    failed: results.filter(r => r.verdict === "failed").length,
    not_evaluable: results.filter(r => r.verdict === "not_evaluable").length,
    issue_verdicts: { "402": results.some(r => r.verdict === "failed" && cases.get(r.case_id)!.issue === 402) ? "failed" : "pending", "598": "pending", "410": results.some(r => r.verdict === "failed") ? "failed" : "pending" },
    reason: "Synthetic functional observations cannot pass longitudinal, human or independent-review gates.", results };
}
