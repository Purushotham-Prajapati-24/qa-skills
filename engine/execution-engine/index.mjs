/**
 * Execution Engine.
 *
 * Executions are opened BEFORE the work starts and finalised after. That order
 * is the whole trick: if the session dies mid-run, the open record survives and
 * recovery marks it INTERRUPTED. Nothing is ever silently assumed to have
 * passed because the process did not get to write "failed".
 */
import { nextId } from '../core/ids.mjs';
import { provenance } from '../core/version.mjs';
import * as state from '../state-engine/index.mjs';
import { verifyClaim } from '../evidence-engine/index.mjs';
import { classify } from '../failure-classifier/index.mjs';
import { inheritedGit } from '../core/git.mjs';

export function start({
  goal,
  method,
  testCategory = null,
  decisionId = null,
  planId = null,
  command = null,
  cwd = null,
  environment = null,
  // No default: an omitted key (undefined) inherits the session's captured git info; an
  // explicit `git: null` means "no git context for this execution specifically" and must
  // stay distinguishable from "not supplied" all the way to inheritedGit(). See
  // core/git.mjs.
  git,
  skillName = 'testing-orchestrator',
  now = new Date(),
} = {}) {
  const session = state.requireSession();
  const id = nextId('execution', now);

  const rec = {
    execution_id: id,
    session_id: session.session_id,
    started_at: now.toISOString(),
    goal,
    method,
    status: 'PARTIAL',
    status_reason: 'Execution opened; not yet finalised. If this record still says PARTIAL, the run did not complete.',
    evidence: [],
    findings: [],
    uncertainties: [],
    retries: 0,
    provenance: provenance({ sessionId: session.session_id, skillName, now }),
  };
  if (testCategory) rec.test_category = testCategory;
  if (decisionId) rec.decision_id = decisionId;
  if (planId) rec.plan_id = planId;
  if (command) rec.command = command;
  if (cwd) rec.cwd = cwd;
  if (environment) rec.environment = environment;
  const gitInfo = inheritedGit(git, session);
  if (gitInfo) rec.git = gitInfo;

  state.put('executions', id, rec, 'execution');
  state.update((s) => {
    s.open_executions.push(id);
    return s;
  }, now);
  state.telemetry({ event: 'execution.start', execution_id: id, method, test_category: testCategory });
  return rec;
}

/**
 * Finalise an execution. The claimed status is checked against the attached
 * evidence and downgraded if it cannot be supported.
 */
export function finish(executionId, {
  status,
  statusReason = '',
  testResults = [],
  evidence = [],
  findings = [],
  uncertainties = [],
  signals = [],
  nextAction = null,
  now = new Date(),
} = {}) {
  const rec = state.get('executions', executionId);
  if (!rec) throw new Error(`No such execution: ${executionId}`);

  const verdict = verifyClaim({ status, evidenceIds: evidence, statement: statusReason, executionId });
  let finalStatus = status;
  let reason = statusReason;
  if (!verdict.permitted) {
    finalStatus = verdict.downgrade_to ?? 'INCONCLUSIVE';
    reason = `${statusReason} [DOWNGRADED from ${status}: ${verdict.reasons.join(' ')}]`;
  }

  rec.finished_at = now.toISOString();
  rec.duration_ms = Math.max(0, new Date(rec.finished_at) - new Date(rec.started_at));
  rec.status = finalStatus;
  rec.status_reason = reason;
  rec.evidence = evidence;
  rec.findings = findings;
  rec.uncertainties = uncertainties;
  if (nextAction) rec.next_action = nextAction;

  if (testResults.length) {
    rec.test_results = testResults;
    rec.totals = {
      total: testResults.length,
      passed: testResults.filter((t) => t.status === 'PASSED').length,
      failed: testResults.filter((t) => t.status === 'FAILED').length,
      skipped: testResults.filter((t) => t.status === 'SKIPPED').length,
      errored: testResults.filter((t) => t.status === 'INCONCLUSIVE').length,
    };
  }

  if (['FAILED', 'INCONCLUSIVE', 'PARTIAL'].includes(finalStatus)) {
    rec.failure_classification = classify({ signals, status: finalStatus, evidenceIds: evidence });
  }

  state.put('executions', executionId, rec, 'execution');
  state.update((s) => {
    s.open_executions = s.open_executions.filter((e) => e !== executionId);
    if (!s.completed_executions.includes(executionId)) s.completed_executions.push(executionId);
    return s;
  }, now);
  state.telemetry({
    event: 'execution.finish',
    execution_id: executionId,
    claimed_status: status,
    final_status: finalStatus,
    downgraded: finalStatus !== status,
    duration_ms: rec.duration_ms,
  });
  return { record: rec, verdict, downgraded: finalStatus !== status };
}

/**
 * Open an execution purely to document work that was NOT run. This is how
 * BLOCKED / SKIPPED / NOT_APPLICABLE items get a first-class, auditable record
 * instead of vanishing from the report.
 */
export function recordNonExecution({ goal, status, reason, testCategory = null, uncertainties = [], now = new Date() }) {
  const rec = start({ goal, method: 'not-executed', testCategory, now });
  return finish(rec.execution_id, {
    status,
    statusReason: reason,
    uncertainties,
    nextAction: 'Revisit when the blocking condition changes.',
    now,
  });
}

export function summarise() {
  const all = state.list('executions');
  const byStatus = {};
  let duration = 0;
  let cases = 0;
  for (const e of all) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    duration += e.duration_ms ?? 0;
    cases += e.test_results?.length ?? 0;
  }
  return { executions: all.length, by_status: byStatus, total_duration_ms: duration, test_cases: cases };
}
