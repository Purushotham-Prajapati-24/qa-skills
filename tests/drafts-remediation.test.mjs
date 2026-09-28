import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempState } from './helpers.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as execution from '../engine/execution-engine/index.mjs';
import * as evidenceEngine from '../engine/evidence-engine/index.mjs';
import * as decisions from '../engine/decision-engine/index.mjs';
import * as flakiness from '../engine/flakiness/index.mjs';
import * as reporting from '../engine/reporting-engine/index.mjs';
import { check as processCheck } from '../engine/evaluation-engine/process-completeness.mjs';

// Gap reports drafted 2026-09-18 (drafts/04, 05, 10, 13) that were still open at 0.10.0.

function evidenced(goal, stdout = 'ok', exitCode = 0) {
  const exec = execution.start({ goal, method: 'playwright-script' });
  const ev = evidenceEngine.captureOutput({ argv: 'npm test', cwd: '.', exitCode, durationMs: 5, stdout, summary: goal, executionId: exec.execution_id });
  return { exec, ev };
}

test('draft 04: "all passed" / "no failures" / "suite is green" are flagged as vague, a count is not', () => {
  const t = useTempState('vague');
  try {
    state.startSession({ request: 'x', git: null });
    const { ev } = evidenced('suite');
    for (const statement of ['All tests passed.', 'No failures.', 'The suite is green', 'everything passes', '0 failed']) {
      const r = evidenceEngine.verifyClaim({ status: 'PASSED', evidenceIds: [ev.evidence_id], statement });
      assert.ok(r.reasons.some((x) => x.startsWith('WARNING: the statement is vague')), statement);
    }
    for (const statement of ['12 of 12 checkout tests passed at abc1234', 'All 12/12 passed', 'EXEC-2026-00003 assertions held']) {
      const r = evidenceEngine.verifyClaim({ status: 'PASSED', evidenceIds: [ev.evidence_id], statement });
      assert.ok(!r.reasons.some((x) => x.startsWith('WARNING')), statement);
    }
  } finally {
    t.cleanup();
  }
});

test('draft 05: validate warns when decisions were recorded and none assessed, and stops once one is', () => {
  const t = useTempState('assess');
  try {
    state.startSession({ request: 'x', git: null });
    evidenced('run');
    const d = decisions.record({ question: 'Which browser method?', options: ['a', 'b'], selected: 'a', reason: 'scores', confidence: 0.6, reversible: true });
    assert.ok(processCheck().some((f) => f.check === 'no-decision-assessed' && f.severity === 'advisory'));
    decisions.assess(d.decision_id, { verdict: 'unknown' });
    assert.ok(!processCheck().some((f) => f.check === 'no-decision-assessed'));
  } finally {
    t.cleanup();
  }
});

test('draft 13: every execution records the runtime it opened on', () => {
  const t = useTempState('runtime');
  try {
    state.startSession({ request: 'x', git: null });
    const exec = execution.start({ goal: 'unit suite', method: 'existing-suite' });
    assert.equal(exec.runtime.node, process.version);
    assert.equal(exec.runtime.arch, process.arch);
    assert.match(exec.runtime.os, new RegExp(`^${process.platform} `));
  } finally {
    t.cleanup();
  }
});

const junit = (pass) => `<testsuites><testcase name="stable one" time="0.1"/>${pass
  ? '<testcase name="flips" time="0.2"/>'
  : '<testcase name="flips" time="0.9"><failure message="boom"/></testcase>'}</testsuites>`;

test('draft 10: a test proven flaky is quarantined by exec finish, once, and its passes stop counting as proven', () => {
  const t = useTempState('flaky');
  try {
    state.startSession({ request: 'x', git: { repository: 'o/r', branch: 'main', commit: 'b'.repeat(40), dirty: false } });
    let last;
    for (const [i, pass] of [true, false, true].entries()) {
      const { exec, ev } = evidenced(`run ${i}`, pass ? '2 passed' : '1 failed', pass ? 0 : 1);
      const file = path.join(t.dir, `j${i}.xml`);
      fs.writeFileSync(file, junit(pass));
      last = execution.finish(exec.execution_id, { status: pass ? 'PASSED' : 'FAILED', statusReason: `run ${i}: 1 of 2 or 2 of 2`, evidence: [ev.evidence_id], junit: file, signals: pass ? [] : ['assertion-mismatch'] });
      if (i < 2) assert.equal(last.quarantined, undefined, 'two runs are not enough to call a test flaky');
    }
    assert.equal(last.quarantined.length, 1);
    assert.equal(last.quarantined[0].test, 'flips');
    const finding = state.get('findings', last.quarantined[0].finding_id);
    assert.equal(finding.kind, 'test-quality-issue');
    assert.equal(finding.reproduction.reproducible, 'intermittent');

    assert.deepEqual(flakiness.quarantine(), [{ test: 'flips', status: 'already-quarantined' }]);
    assert.equal(state.list('findings').length, 1, 'a second quarantine call must not file a duplicate');

    const md = fs.readFileSync(reporting.generate({}).markdown_path, 'utf8');
    const proven = md.slice(md.indexOf('## What was proven'), md.indexOf('## What was not tested'));
    assert.match(proven, /includes quarantined flips; that pass is not counted/);
    assert.match(proven, /stable one _\(passed; run FAILED overall/);
    assert.doesNotMatch(proven, /\| flips _\(passed/);
  } finally {
    t.cleanup();
  }
});
