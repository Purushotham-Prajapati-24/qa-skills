import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempState } from './helpers.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as execution from '../engine/execution-engine/index.mjs';
import * as evidenceEngine from '../engine/evidence-engine/index.mjs';
import * as defects from '../engine/defect-engine/index.mjs';
import { compute } from '../engine/evaluation-engine/metrics.mjs';

/**
 * Two field-trial defects, both in the findings <-> execution <-> metrics triangle:
 *
 *  - `actionable_finding_rate` was mathematically pinned at 0 for every possible session.
 *    Its numerator counted findings with triage.state in {confirmed, reported, resolved};
 *    the ONLY code path in the codebase that ever writes a non-'new' triage state is the
 *    duplicate-detection branch, which sets duplicate_of at the same time -- exactly what
 *    the denominator (nonDuplicate) filters out. So the numerator was always drawn from a
 *    set the denominator had already excluded.
 *  - `finding add --executionId` wrote execution_id onto the FINDING but never appended to
 *    the EXECUTION's own findings[], so `unnecessary_test_rate`'s "barren" check (zero
 *    findings, zero decision, zero test_results) counted an execution that had produced a
 *    real, filed, evidenced finding as an unnecessary test.
 *
 * Every test below gets its own isolated state (`compute()` aggregates over ALL state in
 * the session, so a shared fixture across tests would let one test's findings pollute
 * another's denominator -- exactly the mistake this session already made once, in
 * tests/git-provenance.test.mjs, before fixing it the same way here from the start).
 * Cleanup runs via the test context's own `t.after`, so it fires even if an assertion
 * throws mid-test, not just on a clean fall-through.
 */
function isolated(t, label) {
  const iso = useTempState(label);
  t.after(() => iso.cleanup());
}

function realExecution(goal = 'typecheck') {
  const exec = execution.start({ goal, method: 'static-analysis' });
  const ev = evidenceEngine.add({ kind: 'static-analysis', summary: 'tsc: 0 errors', executionId: exec.execution_id });
  execution.finish(exec.execution_id, { status: 'PASSED', statusReason: 'clean run', evidence: [ev.evidence_id] });
  return { execId: exec.execution_id, evidenceId: ev.evidence_id };
}

/* --------------------------------------------------------- actionable_finding_rate */

test('a freshly-filed finding (triage.state: "new") with a recommended action and evidence counts as actionable', (t) => {
  isolated(t, 'actionable-basic');
  state.startSession({ request: 'actionable rate test 1' });
  const { execId, evidenceId } = realExecution();
  const f = defects.create({
    title: 'Unauthenticated write route', kind: 'security-issue', severity: 'critical', confidence: 0.95,
    summary: 'PUT /api/portfolio has no auth check', component: 'src/app/api/portfolio/route.ts',
    impact: 'full defacement', recommendedAction: 'add checkAuth', evidence: [evidenceId], executionId: execId,
  });
  assert.equal(f.triage.state, 'new', 'triage state itself is unchanged by this fix');
  const m = compute();
  assert.equal(m.metrics.actionable_finding_rate, 1);
});

test('a "new" finding with no recommended action does not count as actionable', (t) => {
  isolated(t, 'actionable-no-action');
  state.startSession({ request: 'actionable rate test 2' });
  const { execId, evidenceId } = realExecution();
  defects.create({
    title: 'Something looks off', kind: 'defect', severity: 'minor', confidence: 0.5,
    summary: 'unclear behaviour', component: 'x', impact: 'unclear',
    evidence: [evidenceId], executionId: execId, // no recommendedAction
  });
  const m = compute();
  assert.equal(m.metrics.actionable_finding_rate, 0,
    '"something is wrong" with no next step is not actionable, and the metric should say so');
});

test('a "new" finding with a recommended action but zero evidence does not count as actionable', (t) => {
  isolated(t, 'actionable-no-evidence');
  state.startSession({ request: 'actionable rate test 3' });
  defects.create({
    title: 'Unevidenced claim', kind: 'defect', severity: 'major', confidence: 0.7,
    summary: 'asserted, not proven', component: 'x', impact: 'y', recommendedAction: 'investigate',
    // no evidence array supplied
  });
  const m = compute();
  assert.equal(m.metrics.actionable_finding_rate, 0,
    '"actionable" without "evidenced" is the assertion-not-proof problem this system exists to prevent elsewhere');
});

test('the duplicate-confirmed path still counts as actionable (regression guard, unchanged behaviour)', (t) => {
  isolated(t, 'actionable-duplicate');
  state.startSession({ request: 'actionable rate test 4' });
  const { execId, evidenceId } = realExecution();
  const args = {
    title: 'Same bug twice', kind: 'defect', severity: 'major', confidence: 0.8,
    summary: 'x', component: 'y', impact: 'z', recommendedAction: 'fix it',
    evidence: [evidenceId], executionId: execId,
  };
  defects.create(args);
  const dup = defects.create(args); // identical fingerprint -> triage.state: 'confirmed', duplicate_of set
  assert.equal(dup.triage.state, 'confirmed');
  assert.ok(dup.duplicate_of);
  const m = compute();
  // nonDuplicate excludes the second (duplicate) finding; the first is actionable via
  // recommended_action+evidence regardless of the duplicate path's own triage state.
  assert.equal(m.metrics.actionable_finding_rate, 1);
});

test('a realistic multi-finding session scores actionable_finding_rate: 1, not the structural 0 from before this fix', (t) => {
  isolated(t, 'actionable-realistic');
  state.startSession({ request: 'realistic session' });
  const { execId, evidenceId } = realExecution();
  for (let i = 0; i < 5; i += 1) {
    defects.create({
      title: `Finding ${i}`, kind: 'defect', severity: 'major', confidence: 0.8,
      summary: `issue ${i}`, component: 'x', impact: 'y', recommendedAction: `fix ${i}`,
      evidence: [evidenceId], executionId: execId,
    });
  }
  const m = compute();
  assert.equal(m.metrics.actionable_finding_rate, 1);
});

/* --------------------------------------------------------- findings back-link (barren) */

test('filing a finding with executionId appends to the EXECUTION\'s own findings[], not just the session\'s', (t) => {
  isolated(t, 'backlink-basic');
  state.startSession({ request: 'back-link test' });
  const { execId, evidenceId } = realExecution();
  const f = defects.create({
    title: 'Real defect', kind: 'defect', severity: 'critical', confidence: 0.9,
    summary: 'x', component: 'y', impact: 'z', recommendedAction: 'fix it',
    evidence: [evidenceId], executionId: execId,
  });
  const exec = state.get('executions', execId);
  assert.ok(exec.findings.includes(f.finding_id), 'the execution record itself must list the finding');
});

test('filing a finding with no executionId does not throw and touches no execution record', (t) => {
  isolated(t, 'backlink-no-exec');
  state.startSession({ request: 'no-exec back-link test' });
  assert.doesNotThrow(() => defects.create({
    title: 'Orphan finding', kind: 'defect', severity: 'minor', confidence: 0.5,
    summary: 'x', component: 'y', impact: 'z',
  }));
});

test('filing a finding with an executionId that does not exist does not throw', (t) => {
  isolated(t, 'backlink-bad-exec');
  state.startSession({ request: 'bad-exec back-link test' });
  assert.doesNotThrow(() => defects.create({
    title: 'Finding against a ghost execution', kind: 'defect', severity: 'minor', confidence: 0.5,
    summary: 'x', component: 'y', impact: 'z', executionId: 'EXEC-9999-99999',
  }));
});

test('an execution with real evidence and no findings is NOT barren (unnecessary_test_rate)', (t) => {
  isolated(t, 'barren-evidenced');
  state.startSession({ request: 'barren test 1' });
  realExecution(); // evidence attached, no finding filed against it -- a clean typecheck
  const m = compute();
  assert.equal(m.metrics.unnecessary_test_rate, 0,
    'a clean, evidenced check (typecheck, build) is the useful outcome, not a wasted test');
});

test('an execution with a filed finding is NOT barren', (t) => {
  isolated(t, 'barren-with-finding');
  state.startSession({ request: 'barren test 2' });
  const { execId, evidenceId } = realExecution();
  defects.create({
    title: 'A real defect here', kind: 'defect', severity: 'major', confidence: 0.8,
    summary: 'x', component: 'y', impact: 'z', recommendedAction: 'fix',
    evidence: [evidenceId], executionId: execId,
  });
  const m = compute();
  assert.equal(m.metrics.unnecessary_test_rate, 0);
});

test('an execution with genuinely nothing attached (no evidence, no findings, no decision, no test_results) is still barren', (t) => {
  isolated(t, 'barren-genuine');
  state.startSession({ request: 'barren test 3' });
  const exec = execution.start({ goal: 'nothing attached', method: 'static-analysis' });
  execution.finish(exec.execution_id, { status: 'INCONCLUSIVE', statusReason: 'nothing was ever attached' });
  const m = compute();
  assert.equal(m.metrics.unnecessary_test_rate, 1,
    'the fix must narrow the false positive, not remove the check\'s teeth entirely');
});

test('a Madhubala-shaped session (typecheck + build, both evidenced, neither finding anything) scores 0, not 0.4', (t) => {
  isolated(t, 'barren-madhubala');
  state.startSession({ request: 'madhubala-shaped session' });
  realExecution('tsc --noEmit');
  realExecution('npm run build');
  const m = compute();
  assert.equal(m.metrics.unnecessary_test_rate, 0);
});
