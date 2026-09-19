import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempState } from './helpers.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as execution from '../engine/execution-engine/index.mjs';
import * as evidenceEngine from '../engine/evidence-engine/index.mjs';
import * as reporting from '../engine/reporting-engine/index.mjs';
import { compute } from '../engine/evaluation-engine/metrics.mjs';

/**
 * `duration_ms` on an execution has always measured the gap between two CLI calls
 * (`exec start` .. `exec finish`), including the agent's own reasoning and every other
 * tool call in between -- never the runtime of whatever was actually tested. A field
 * trial's report recorded a Playwright suite at 100,488ms against a transcript stating the
 * real run took 17.1s, a 6x overstatement, because that field was the only number the
 * report had and it was rendered under a plain "Duration" header inviting exactly that
 * reading.
 *
 * `wall_clock_ms` gives the honest name to the number that already existed (`duration_ms`
 * stays, unchanged, as a deprecated alias -- nothing reads it differently now).
 * `command_duration_ms` is new: the real, captured runtime of the command(s) actually run,
 * summed from linked evidence's `command.duration_ms` (populated by `evidence capture`,
 * see tests/evidence-capture.test.mjs). It is absent, not zero, when nothing was captured
 * that way.
 */
function isolated(t, label) {
  const iso = useTempState(label);
  t.after(() => iso.cleanup());
}

test('finish() sets wall_clock_ms and keeps duration_ms as an identical, unremoved alias', (t) => {
  isolated(t, 'wallclock-alias');
  state.startSession({ request: 'wall clock alias test' });
  const exec = execution.start({ goal: 'typecheck', method: 'static-analysis', git: null });
  const { record } = execution.finish(exec.execution_id, { status: 'PASSED', statusReason: 'ok' });
  assert.equal(typeof record.wall_clock_ms, 'number');
  assert.equal(record.duration_ms, record.wall_clock_ms);
});

test('finish() with no linked evidence leaves command_duration_ms entirely absent, not zero', (t) => {
  isolated(t, 'wallclock-no-evidence');
  state.startSession({ request: 'no evidence duration test' });
  const exec = execution.start({ goal: 'typecheck', method: 'static-analysis', git: null });
  const { record } = execution.finish(exec.execution_id, { status: 'PASSED', statusReason: 'ok' });
  assert.equal('command_duration_ms' in record, false);
});

test('finish() sums command.duration_ms from linked evidence into command_duration_ms', (t) => {
  isolated(t, 'wallclock-summed');
  state.startSession({ request: 'summed duration test' });
  const exec = execution.start({ goal: 'build then test', method: 'existing-suite', git: null });
  const ev1 = evidenceEngine.add({
    kind: 'command-output', summary: 'build finished',
    executionId: exec.execution_id, command: { argv: 'npm run build', exit_code: 0, duration_ms: 4200 },
  });
  const ev2 = evidenceEngine.add({
    kind: 'command-output', summary: 'tests finished',
    executionId: exec.execution_id, command: { argv: 'npm test', exit_code: 0, duration_ms: 1300 },
  });
  const { record } = execution.finish(exec.execution_id, {
    status: 'PASSED', statusReason: 'ok', evidence: [ev1.evidence_id, ev2.evidence_id],
  });
  assert.equal(record.command_duration_ms, 5500);
});

test('evidence linked to the execution but with no command block does not count as zero', (t) => {
  isolated(t, 'wallclock-mixed-evidence');
  state.startSession({ request: 'mixed evidence duration test' });
  const exec = execution.start({ goal: 'typecheck', method: 'static-analysis', git: null });
  const ev1 = evidenceEngine.add({
    kind: 'command-output', summary: 'captured command',
    executionId: exec.execution_id, command: { argv: 'tsc --noEmit', exit_code: 0, duration_ms: 900 },
  });
  const ev2 = evidenceEngine.add({ kind: 'screenshot', summary: 'a screenshot, no command behind it', executionId: exec.execution_id });
  const { record } = execution.finish(exec.execution_id, {
    status: 'PASSED', statusReason: 'ok', evidence: [ev1.evidence_id, ev2.evidence_id],
  });
  assert.equal(record.command_duration_ms, 900, 'the screenshot must not contribute a phantom 0 to the sum');
});

test('runtime_efficiency_ms_per_case is null (not a wall-clock-derived number) when nothing was captured this session', (t) => {
  isolated(t, 'runtime-eff-null');
  state.startSession({ request: 'runtime efficiency null test' });
  const exec = execution.start({ goal: 'typecheck', method: 'static-analysis', git: null });
  execution.finish(exec.execution_id, {
    status: 'PASSED', statusReason: 'ok', testResults: [{ name: 'a', status: 'PASSED' }],
  });
  const m = compute();
  assert.equal(m.metrics.runtime_efficiency_ms_per_case, null,
    'no command_duration_ms exists anywhere this session -- this must not fall back to wall_clock_ms');
});

test('runtime_efficiency_ms_per_case uses only command_duration_ms, ignoring wall-clock time entirely', (t) => {
  isolated(t, 'runtime-eff-real');
  state.startSession({ request: 'runtime efficiency real test' });
  const exec = execution.start({ goal: 'run suite', method: 'existing-suite', git: null });
  const ev = evidenceEngine.add({
    kind: 'test-report', summary: '2 passed',
    executionId: exec.execution_id, command: { argv: 'npm test', exit_code: 0, duration_ms: 2000 },
  });
  execution.finish(exec.execution_id, {
    status: 'PASSED', statusReason: 'ok', evidence: [ev.evidence_id],
    testResults: [{ name: 'a', status: 'PASSED' }, { name: 'b', status: 'PASSED' }],
  });
  const m = compute();
  assert.equal(m.metrics.runtime_efficiency_ms_per_case, 1000, '2000ms captured / 2 cases -- never the wall-clock gap');
  assert.equal(m.denominators.runtime_efficiency_ms_per_case, 2);
});

test('an execution with real wall-clock time but no captured command duration does not pollute runtime_efficiency_ms_per_case', (t) => {
  isolated(t, 'runtime-eff-excluded');
  state.startSession({ request: 'runtime efficiency exclusion test' });
  const timed = execution.start({ goal: 'run suite', method: 'existing-suite', git: null });
  const ev = evidenceEngine.add({
    kind: 'test-report', summary: '1 passed',
    executionId: timed.execution_id, command: { argv: 'npm test', exit_code: 0, duration_ms: 500 },
  });
  execution.finish(timed.execution_id, {
    status: 'PASSED', statusReason: 'ok', evidence: [ev.evidence_id], testResults: [{ name: 'a', status: 'PASSED' }],
  });
  const untimed = execution.start({ goal: 'manual review', method: 'manual-review', git: null });
  execution.finish(untimed.execution_id, {
    status: 'PASSED', statusReason: 'ok', testResults: [{ name: 'b', status: 'PASSED' }, { name: 'c', status: 'PASSED' }],
  });
  const m = compute();
  // If the untimed execution's 2 cases leaked into the denominator, this would be 500/3.
  assert.equal(m.metrics.runtime_efficiency_ms_per_case, 500);
  assert.equal(m.denominators.runtime_efficiency_ms_per_case, 1);
});

test('the rendered Executions table shows "Wall clock" and "Command time" as separate columns, never one ambiguous "Duration"', (t) => {
  isolated(t, 'report-columns');
  state.startSession({ request: 'report columns test' });
  const exec = execution.start({ goal: 'run suite', method: 'existing-suite', git: null });
  const ev = evidenceEngine.add({
    kind: 'test-report', summary: '1 passed',
    executionId: exec.execution_id, command: { argv: 'npm test', exit_code: 0, duration_ms: 777 },
  });
  execution.finish(exec.execution_id, {
    status: 'PASSED', statusReason: 'ok', evidence: [ev.evidence_id], testResults: [{ name: 'a', status: 'PASSED' }],
  });
  const { markdown } = reporting.generate();
  assert.match(markdown, /\| Wall clock \| Command time \|/);
  assert.doesNotMatch(markdown, /\| Duration \|/, 'the old ambiguous single column must be gone');
  // The execution ID also appears in the Traceability section below -- scope to the
  // Executions table specifically so that unrelated row is never what gets matched.
  const executionsSection = markdown.split('### Executions')[1].split('### Evidence')[0];
  const row = executionsSection.split('\n').find((l) => l.includes(exec.execution_id));
  assert.match(row, /\| 777 ms \|/, 'the real captured command time must appear in its own column');
});

test('the rendered Executions table shows "—" for command time when nothing was captured, not a wall-clock substitute', (t) => {
  isolated(t, 'report-columns-unknown');
  state.startSession({ request: 'report columns unknown test' });
  const exec = execution.start({ goal: 'manual review', method: 'manual-review', git: null });
  execution.finish(exec.execution_id, { status: 'PASSED', statusReason: 'ok' });
  const { markdown } = reporting.generate();
  const executionsSection = markdown.split('### Executions')[1].split('### Evidence')[0];
  const row = executionsSection.split('\n').find((l) => l.includes(exec.execution_id));
  const cells = row.split('|').map((c) => c.trim());
  // ID, Status, Goal, Method, Failure class, Wall clock, Command time
  assert.equal(cells[7], '—', 'command time must read "—", never a wall-clock number standing in for it');
  assert.notEqual(cells[6], '—', 'wall clock must still be known and shown -- an execution that finished always has one');
});
