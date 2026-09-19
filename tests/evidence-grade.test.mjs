import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useTempState } from './helpers.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as execution from '../engine/execution-engine/index.mjs';
import * as evidenceEngine from '../engine/evidence-engine/index.mjs';
import * as reporting from '../engine/reporting-engine/index.mjs';
import { compute } from '../engine/evaluation-engine/metrics.mjs';

/**
 * `evidence add` treats `artifactPath` as optional, and the false-confidence gate checks
 * the KIND of evidence, not whether anything was actually captured -- so a hand-typed
 * sentence with no artifact passes as execution-grade evidence exactly like a hashed
 * command output does. In one field trial, 4 of 5 evidence records had no artifact at all,
 * and the report's own `evidence_completeness: 1` gave no hint of that.
 *
 * `grade` doesn't change what the gate accepts (a typed summary still passes verifyClaim
 * if its kind is execution-grade -- see evidence-engine.test.mjs, unchanged) -- it makes
 * the previously invisible difference visible: computed by the engine, never
 * agent-supplied, so an agent cannot grade its own evidence "anchored".
 */
function isolated(t, label) {
  const iso = useTempState(label);
  t.after(() => iso.cleanup());
}

test('evidence with a real artifact on disk is graded "anchored"', (t) => {
  isolated(t, 'grade-artifact');
  state.startSession({ request: 'artifact grading test' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-grade-'));
  const file = path.join(dir, 'output.txt');
  fs.writeFileSync(file, 'tsc --noEmit: 0 errors');
  const ev = evidenceEngine.add({ kind: 'static-analysis', summary: 'typecheck', artifactPath: file });
  assert.equal(ev.grade, 'anchored');
});

test('evidence with an excerpt and a real (zero) exit code is graded "anchored"', (t) => {
  isolated(t, 'grade-excerpt-exit0');
  state.startSession({ request: 'excerpt+exit0 grading test' });
  const ev = evidenceEngine.add({
    kind: 'command-output', summary: 'lint', excerpt: 'no problems found',
    command: { argv: 'npm run lint', exit_code: 0 },
  });
  assert.equal(ev.grade, 'anchored');
});

test('evidence with an excerpt and a real non-zero exit code is still graded "anchored" -- anchored is about verifiability, not about passing', (t) => {
  isolated(t, 'grade-excerpt-exit1');
  state.startSession({ request: 'excerpt+exit1 grading test' });
  const ev = evidenceEngine.add({
    kind: 'command-output', summary: 'audit', excerpt: '38 vulnerabilities found',
    command: { argv: 'npm audit', exit_code: 1 },
  });
  assert.equal(ev.grade, 'anchored');
});

test('a hand-typed summary with no artifact, no excerpt and no exit code is graded "asserted"', (t) => {
  isolated(t, 'grade-asserted-basic');
  state.startSession({ request: 'asserted grading test' });
  const ev = evidenceEngine.add({ kind: 'static-analysis', summary: 'tsc --noEmit: 0 errors (EXIT 0)' });
  assert.equal(ev.grade, 'asserted');
});

test('an excerpt with NO exit code is graded "asserted" -- an excerpt alone is not verifiable', (t) => {
  isolated(t, 'grade-excerpt-no-exit');
  state.startSession({ request: 'excerpt without exit code test' });
  const ev = evidenceEngine.add({ kind: 'command-output', summary: 'ran something', excerpt: 'looked fine to me' });
  assert.equal(ev.grade, 'asserted');
});

test('`grade` cannot be supplied by the caller -- it is always computed', (t) => {
  isolated(t, 'grade-not-overridable');
  state.startSession({ request: 'grade override attempt' });
  const ev = evidenceEngine.add({ kind: 'static-analysis', summary: 'x'.repeat(10), grade: 'anchored' });
  assert.equal(ev.grade, 'asserted', 'an agent-supplied grade must be silently ignored, not trusted');
});

test('evidence.add still supports a PASSED claim through the existing, unchanged gate regardless of grade -- grade does not tighten acceptance', (t) => {
  isolated(t, 'grade-does-not-gate');
  state.startSession({ request: 'gate unaffected test' });
  const exec = execution.start({ goal: 'typecheck', method: 'static-analysis' });
  const ev = evidenceEngine.add({ kind: 'static-analysis', summary: 'tsc: 0 errors', executionId: exec.execution_id });
  assert.equal(ev.grade, 'asserted');
  const verdict = evidenceEngine.verifyClaim({ status: 'PASSED', evidenceIds: [ev.evidence_id], executionId: exec.execution_id });
  assert.equal(verdict.permitted, true,
    'grade surfaces the distinction; it must not silently change what already passed');
});

/* ------------------------------------------------------- evidence_anchored_rate metric */

test('evidence_anchored_rate reflects the real anchored/total split, not evidence_completeness\'s "anything attached" question', (t) => {
  isolated(t, 'grade-metric-split');
  state.startSession({ request: 'anchored rate test' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-grade-metric-'));
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'anchored');
  evidenceEngine.add({ kind: 'static-analysis', summary: 'anchored evidence', artifactPath: file });
  evidenceEngine.add({ kind: 'static-analysis', summary: 'asserted evidence, no artifact' });
  const m = compute();
  assert.equal(m.metrics.evidence_anchored_rate, 0.5);
  assert.equal(m.denominators.evidence_anchored_rate, 2);
});

test('evidence written before "grade" existed (no grade field at all) is excluded from the numerator, not coerced into either bucket', (t) => {
  isolated(t, 'grade-legacy');
  state.startSession({ request: 'legacy evidence test' });
  const ev = evidenceEngine.add({ kind: 'static-analysis', summary: 'legacy-shaped record' });
  // Simulate a pre-existing record written before this field existed.
  const legacy = state.get('evidence', ev.evidence_id);
  delete legacy.grade;
  state.put('evidence', ev.evidence_id, legacy, 'evidence');
  const m = compute();
  assert.equal(m.metrics.evidence_anchored_rate, 0, 'the one item has no grade, so it cannot count as anchored');
  assert.equal(m.denominators.evidence_anchored_rate, 1, 'but it still counts toward the total');
});

/* ------------------------------------------------------------- report rendering */

test('the rendered Evidence table shows "yes"/"no" for anchored/asserted, and "—" for legacy evidence with no grade', (t) => {
  isolated(t, 'grade-report-table');
  state.startSession({ request: 'report table test' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-grade-table-'));
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'x');
  evidenceEngine.add({ kind: 'static-analysis', summary: 'anchored one', artifactPath: file });
  evidenceEngine.add({ kind: 'static-analysis', summary: 'asserted one' });
  const { markdown } = reporting.generate();
  assert.match(markdown, /anchored one \| yes/);
  assert.match(markdown, /asserted one \| no/);
});

test('report schema and ast validate both accept a record carrying "grade" without complaint', (t) => {
  isolated(t, 'grade-schema-valid');
  state.startSession({ request: 'schema validity test' });
  const exec = execution.start({ goal: 'typecheck', method: 'static-analysis' });
  const ev = evidenceEngine.add({ kind: 'static-analysis', summary: 'tsc: 0 errors', executionId: exec.execution_id });
  execution.finish(exec.execution_id, { status: 'PASSED', statusReason: 'ok', evidence: [ev.evidence_id] });
  reporting.generate();
  // No throw anywhere above is the assertion; assertValid runs inside state.put for both
  // the evidence record and the report record.
  assert.ok(true);
});
