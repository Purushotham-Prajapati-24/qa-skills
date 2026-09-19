import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempState } from './helpers.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as execution from '../engine/execution-engine/index.mjs';
import * as evidenceEngine from '../engine/evidence-engine/index.mjs';
import * as reporting from '../engine/reporting-engine/index.mjs';

/**
 * `classify()`'s own unit tests live in tests/decision-engines.test.mjs, alongside the
 * other decision engines. This file covers the one thing that needs a full session/report
 * round trip to observe: the renderer suppresses the Failure class cell entirely for
 * `unclassified-no-signals`, rather than printing a confident-looking label for an
 * absence ("the caller gave the classifier nothing to work with" is not a verdict on the
 * finding, and rendering it with a confidence number invited reading it as one anyway).
 */
function isolated(t, label) {
  const iso = useTempState(label);
  t.after(() => iso.cleanup());
}

test('the rendered report suppresses the Failure class cell for unclassified-no-signals, showing "—" like no classification at all', (t) => {
  isolated(t, 'classifier-report-suppressed');
  state.startSession({ request: 'suppressed classification test' });
  const exec = execution.start({ goal: 'A claim with nothing to classify from', method: 'static-analysis' });
  execution.finish(exec.execution_id, {
    status: 'FAILED', statusReason: 'no signal tokens were ever supplied',
    signals: [], // triggers unclassified-no-signals
  });
  const { markdown } = reporting.generate();
  assert.doesNotMatch(markdown, /unclassified-no-signals/,
    'the class name itself must never reach the rendered table');
  const row = markdown.split('\n').find((l) => l.includes(exec.execution_id));
  assert.ok(row, 'the execution must still appear in the Executions table');
  assert.match(row, /\| — \|/, 'the Failure class cell must read "—", the same as no classification at all');
});

test('a real classification (product-defect) still renders normally, with its class and confidence', (t) => {
  isolated(t, 'classifier-report-normal');
  state.startSession({ request: 'normal classification test' });
  const exec = execution.start({ goal: 'A real product defect', method: 'api-client' });
  const ev = evidenceEngine.add({ kind: 'command-output', summary: 'assertion failed', executionId: exec.execution_id });
  execution.finish(exec.execution_id, {
    status: 'FAILED', statusReason: 'assertion failed', evidence: [ev.evidence_id],
    signals: ['assertion-mismatch'],
  });
  const { markdown } = reporting.generate();
  assert.match(markdown, /product-defect \(/, 'a genuine classification must still render its class and confidence');
});
