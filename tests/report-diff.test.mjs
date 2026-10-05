import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempState } from './helpers.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as execution from '../engine/execution-engine/index.mjs';
import * as uncertainty from '../engine/uncertainty-register/index.mjs';
import * as reporting from '../engine/reporting-engine/index.mjs';

/**
 * `ast report diff` compares two stored report records. Its first version read fields
 * generate() never writes (`report.overall`, metrics from `integrity`, blocked work keyed by
 * `id`), so it silently reported "No changes" for real changes. These tests pin the diff to
 * the shape generate() actually stores.
 */
const tmp = useTempState('report-diff');
test.after(() => tmp.cleanup());
state.startSession({ request: 'report diff test session' });

function report(id, overrides = {}) {
  return {
    report_id: id,
    executive_summary: { overall_status: 'PASSED' },
    detailed_results: [],
    finding_details: [],
    blocked_work: [],
    metrics: { metrics: { evidence_completeness: 0.5, requirement_coverage: null } },
    integrity: { false_confidence_rate: 0 },
    ...overrides,
  };
}

test('synthetic: overall status, metrics, severity and blocked-reason changes are all detected and summarised', () => {
  state.put('reports', 'REPORT-2026-09001', report('REPORT-2026-09001', {
    finding_details: [{ finding_id: 'FIND-00001', severity: 'major', title: 'authz gap' }],
    blocked_work: [{ execution_id: 'EXEC-2026-00001', goal: 'payment e2e', reason: 'no sandbox key' }],
  }));
  state.put('reports', 'REPORT-2026-09002', report('REPORT-2026-09002', {
    executive_summary: { overall_status: 'FAILED' },
    finding_details: [{ finding_id: 'FIND-00001', severity: 'critical', title: 'authz gap' }],
    blocked_work: [{ execution_id: 'EXEC-2026-00001', goal: 'payment e2e', reason: 'sandbox key revoked' }],
    metrics: { metrics: { evidence_completeness: 0.75, requirement_coverage: null } },
    integrity: { false_confidence_rate: 0.25 },
  }));

  const d = reporting.diff('REPORT-2026-09002', 'REPORT-2026-09001');

  assert.deepEqual(d.overall_change, { old: 'PASSED', new: 'FAILED' });
  assert.deepEqual(d.metrics.evidence_completeness, { old: 0.5, new: 0.75, delta: 0.25 });
  assert.deepEqual(d.metrics.false_confidence_rate, { old: 0, new: 0.25, delta: 0.25 });
  assert.equal(d.metrics.requirement_coverage, undefined, 'an unchanged null metric is not a change');
  assert.equal(d.findings.severity_changed.length, 1);
  // Same execution, new reason: a reason change, not "one unblocked plus one newly blocked".
  assert.deepEqual(d.blocked_work.newly_blocked, []);
  assert.deepEqual(d.blocked_work.unblocked, []);
  assert.deepEqual(d.blocked_work.reason_changed, [
    { execution_id: 'EXEC-2026-00001', old_reason: 'no sandbox key', new_reason: 'sandbox key revoked' },
  ]);
  assert.match(d.summary, /1 severity change/);
  assert.match(d.summary, /metric change\(s\): .*evidence_completeness/);
  assert.match(d.summary, /1 blocked reason change/);
  assert.match(d.summary, /overall: PASSED → FAILED/);
});

test('synthetic: a report pair whose only change is one metric does not summarise as "No changes"', () => {
  state.put('reports', 'REPORT-2026-09003', report('REPORT-2026-09003'));
  state.put('reports', 'REPORT-2026-09004', report('REPORT-2026-09004', {
    metrics: { metrics: { evidence_completeness: 0.9, requirement_coverage: null } },
  }));
  const d = reporting.diff('REPORT-2026-09004', 'REPORT-2026-09003');
  assert.notEqual(d.summary, 'No changes');
  assert.deepEqual(Object.keys(d.metrics), ['evidence_completeness']);
});

test('synthetic: genuinely identical reports summarise as "No changes"', () => {
  state.put('reports', 'REPORT-2026-09005', report('REPORT-2026-09005'));
  state.put('reports', 'REPORT-2026-09006', report('REPORT-2026-09006'));
  const d = reporting.diff('REPORT-2026-09006', 'REPORT-2026-09005');
  assert.equal(d.summary, 'No changes');
  assert.equal(d.overall_change, null);
});

test('end to end: diff agrees with the fields generate() really stores, and defaults to the supersedes chain', () => {
  const u = uncertainty.raise({
    question: 'Which payment sandbox key?',
    impact: 'payment E2E cannot run',
    affectedScope: ['payment-e2e'],
    nextAction: 'ask the user',
  });
  const blocked = execution.recordNonExecution({
    goal: 'Payment E2E', status: 'BLOCKED', reason: 'no sandbox key', testCategory: 'e2e', uncertainties: [u.id],
  });
  const first = reporting.generate({ recommendations: [] }).report;

  // Same blocked execution, new reason; plus one new execution.
  const rec = state.get('executions', blocked.record.execution_id);
  rec.status_reason = 'sandbox key revoked by the provider';
  state.put('executions', rec.execution_id, rec, 'execution');
  const extra = execution.start({ goal: 'API smoke', method: 'api-client', testCategory: 'api', git: null });
  execution.finish(extra.execution_id, { status: 'FAILED', statusReason: 'GET /health returned 500' });
  const second = reporting.generate({ recommendations: [] }).report;

  assert.equal(second.supersedes, first.report_id);
  const d = reporting.diff(); // defaults: latest report vs the one it supersedes
  assert.equal(d.old_id, first.report_id);
  assert.equal(d.new_id, second.report_id);

  assert.ok(d.executions.added.some((e) => e.execution_id === extra.execution_id));
  assert.deepEqual(d.blocked_work.reason_changed.map((b) => b.execution_id), [blocked.record.execution_id]);
  assert.deepEqual(d.blocked_work.unblocked, []);

  const o = first.executive_summary.overall_status;
  const n = second.executive_summary.overall_status;
  assert.deepEqual(d.overall_change, o === n ? null : { old: o, new: n });

  const changed = Object.keys({ ...first.metrics.metrics, ...second.metrics.metrics })
    .filter((k) => first.metrics.metrics[k] !== second.metrics.metrics[k]
      && first.metrics.metrics[k] !== undefined && second.metrics.metrics[k] !== undefined);
  for (const k of changed) assert.ok(k in d.metrics, `metric ${k} changed between the reports but the diff missed it`);
});
