import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempState } from './helpers.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as execution from '../engine/execution-engine/index.mjs';
import * as reporting from '../engine/reporting-engine/index.mjs';

/**
 * The Appendix's "Evaluation metrics" table used to render every metric in one table,
 * with a zero-denominator ("no PASSED/COMPLETED claims yet", "no decisions assessed", ...)
 * shown inline as "_n/a (zero denominator)_" -- indistinguishable at a glance from a real
 * measurement sitting two rows away. A field trial's own report carried three defective
 * metrics this way, with nothing about the table's PRESENTATION marking them as different
 * in kind from the honest ones. The table now shows only metrics with a real denominator;
 * everything else collapses into one named line, "not measured this session".
 */
function isolated(t, label) {
  const iso = useTempState(label);
  t.after(() => iso.cleanup());
}

test('a fresh session with nothing recorded has no real-denominator metrics, and every metric is named in the collapsed line', (t) => {
  isolated(t, 'split-fresh');
  state.startSession({ request: 'fresh session metrics test' });
  const { markdown } = reporting.generate();
  assert.match(markdown, /_No metric had a real denominator this session\._/);
  assert.match(markdown, /_Not measured this session \(zero denominator, honestly excluded rather than shown as 0\): [^.]+\._/);
  assert.doesNotMatch(markdown, /_n\/a \(zero denominator\)_/, 'the old inline "n/a" rendering must be gone entirely');
});

test('a metric with a real denominator renders in the table; one with a zero denominator does not', (t) => {
  isolated(t, 'split-mixed');
  state.startSession({ request: 'mixed metrics test' });
  const exec = execution.start({ goal: 'typecheck', method: 'static-analysis', git: null });
  execution.finish(exec.execution_id, { status: 'PASSED', statusReason: 'ok' });
  const { markdown, report } = reporting.generate();

  // reproducibility has a real denominator here (one real execution) -- it belongs in the table.
  assert.ok(report.metrics.metrics.reproducibility !== null);
  const tableSection = markdown.split('### Evaluation metrics')[1].split('### Integrity self-audit')[0];
  assert.match(tableSection, /\| reproducibility \|/);

  // requirement_coverage has zero declared requirements -- it belongs in the collapsed list, not the table.
  assert.equal(report.metrics.metrics.requirement_coverage, null);
  assert.doesNotMatch(tableSection, /\| requirement_coverage \|/);
  assert.match(tableSection, /Not measured this session[^\n]*requirement_coverage/);
});

test('false_confidence_rate with zero PASSED/COMPLETED claims is "not measured", not a misleading 0', (t) => {
  isolated(t, 'split-fcr-zero');
  state.startSession({ request: 'no claims yet metrics test' });
  const { report } = reporting.generate();
  assert.equal(report.metrics.metrics.false_confidence_rate, null,
    'zero claims is a zero denominator, same as every other metric in this table -- it must not render as a real 0');
  assert.ok(!('false_confidence_rate' in Object.fromEntries(
    Object.entries(report.metrics.metrics).filter(([, v]) => v !== null),
  )));
});

test('false_confidence_rate with a real PASSED claim still reports its real value, not null', (t) => {
  isolated(t, 'split-fcr-real');
  state.startSession({ request: 'real claim metrics test' });
  const exec = execution.start({ goal: 'typecheck', method: 'static-analysis', git: null });
  execution.finish(exec.execution_id, { status: 'PASSED', statusReason: 'ok', evidence: [] });
  const { report } = reporting.generate();
  // PASSED with no evidence is downgraded by the false-confidence gate before it is
  // counted as a claim at all -- so this, too, is legitimately zero claims. Assert the
  // metric stays consistent with that (null), not that the gate's downgrade is itself
  // miscounted as a measured 0.
  assert.equal(report.metrics.metrics.false_confidence_rate, null);
});

test('a measured metric below the noise floor still shows its warning inside the table', (t) => {
  isolated(t, 'split-noise');
  state.startSession({ request: 'noise floor metrics test' });
  const exec = execution.start({ goal: 'typecheck', method: 'static-analysis', git: null });
  execution.finish(exec.execution_id, { status: 'PASSED', statusReason: 'ok' });
  const { markdown } = reporting.generate();
  const tableSection = markdown.split('### Evaluation metrics')[1].split('### Integrity self-audit')[0];
  assert.match(tableSection, /\| reproducibility \| 0 \| 1 \| ⚠️ below noise floor \(5\) \|/);
});
