/** #1090: every pre-registered attempt remains in the outcome denominator.
 * These fixture oracles are deliberately narrow, not a semantic classifier. */
export function validateAttempt(row) {
  if (!row.attempt_id || !row.cluster_id || !row.host?.name || !row.host?.version || !row.model?.requested) throw Error('missing host/model/attempt attribution');
  if (!row.rule?.id || !row.rule?.revision) throw Error('missing rule revision');
  if (!Number.isSafeInteger(row.task?.generation) || !row.context_generation) throw Error('missing task/context generation');
  for (const phase of [row.first, row.repaired].filter(Boolean)) {
    if (!['passed', 'failed', 'blocked', 'unverified'].includes(phase.status)) throw Error('invalid outcome');
    if (['passed', 'failed'].includes(phase.status) && (typeof phase.text !== 'string' || !phase.sha256)) throw Error('judgement requires actual output bytes');
  }
  if (!row.first) throw Error('missing first output outcome');
  return row;
}
export function summarizeAttempts(rows, plannedIds = rows.map(r => r.attempt_id)) {
  const ids = new Set();
  for (const row of rows) { validateAttempt(row); if (ids.has(row.attempt_id)) throw Error('duplicate attempt'); ids.add(row.attempt_id); }
  const planned = new Set(plannedIds);
  if (planned.size !== plannedIds.length) throw Error('duplicate planned attempt');
  if (rows.some(r => !planned.has(r.attempt_id))) throw Error('unplanned attempt');
  const missing = planned.size - rows.length;
  const n = status => rows.filter(r => r.first.status === status).length + (status === 'unverified' ? missing : 0);
  const eventual = r => r.repaired ?? r.first;
  const e = status => rows.filter(r => eventual(r).status === status).length + (status === 'unverified' ? missing : 0);
  return { attempts: planned.size, first_correct: n('passed'), eventual_correct: e('passed'),
    repaired_correct: rows.filter(r => r.first.status !== 'passed' && r.repaired?.status === 'passed').length,
    first_failed: n('failed'), first_blocked: n('blocked'), first_unverified: n('unverified'),
    eventual_failed: e('failed'), eventual_blocked: e('blocked'), eventual_unverified: e('unverified'),
    initial_correct_fraction: planned.size ? n('passed') / planned.size : null,
    eventual_correct_fraction: planned.size ? e('passed') / planned.size : null };
}
export function judgeFixture(kind, text, label) {
  if (kind !== 'arithmetic' && kind !== 'rule-change') return { status: 'unverified', reason: 'Semantic fixture requires independent assessment of actual final bytes.' };
  try {
    const value = JSON.parse(text);
    return { status: value && Object.keys(value).length === 2 && value.answer === 7 && value.label === label ? 'passed' : 'failed', oracle: 'exact arithmetic JSON fixture v1' };
  } catch { return { status: 'failed', oracle: 'exact arithmetic JSON fixture v1' }; }
}

/** At most one separately observed repair, retaining first visible bytes and scope. */
export async function repairOnce(row, generate) {
  if (row.repaired) return row;
  if (row.first.status !== 'failed') {
    row.repair_not_attempted_reason = row.first.status === 'passed' ? 'First output passed the fixture oracle.' : 'No assessed failed output to repair; blocked/unverified attempts are retained.';
    return row;
  }
  if (row.repair_attempted) return row;
  row.repair_attempted = true;
  row.repaired = await generate(row);
  validateAttempt(row);
  return row;
}

/** An independent assessment is bound to exact first-output bytes and rule/task scope. */
export function applyAssessments(rows, assessment, rubricSha256) {
  if (!assessment.reviewer || assessment.rubric_sha256 !== rubricSha256) throw Error('assessment requires matching rubric and independent reviewer');
  const seen = new Set();
  for (const decision of assessment.decisions) {
    if (seen.has(decision.attempt_id)) throw Error('duplicate assessment'); seen.add(decision.attempt_id);
    const row = rows.find(r => r.attempt_id === decision.attempt_id);
    if (!row || row.first.sha256 !== decision.output_sha256 || row.rule.revision !== decision.rule_revision || row.task.generation !== decision.task_generation) throw Error('stale assessment/output binding');
    if (!['passed', 'failed'].includes(decision.status) || !decision.reason) throw Error('assessment requires explicit outcome and reason');
  }
  return rows.map(row => {
    const decision = assessment.decisions.find(d => d.attempt_id === row.attempt_id);
    return decision ? { ...row, first: { ...row.first, status: decision.status, assessment: { reviewer: assessment.reviewer, reason: decision.reason, rubric_sha256: rubricSha256 } } } : row;
  });
}
