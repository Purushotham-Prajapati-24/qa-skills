import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempState } from './helpers.mjs';
import { add, verifyClaim, auditClaims } from '../engine/evidence-engine/index.mjs';

const tmp = useTempState('evidence-engine');
test.after(() => tmp.cleanup());

test('a non-zero exit code contradicts a PASSED claim even though the evidence kind is right', () => {
  const ev = add({
    kind: 'command-output',
    summary: 'checkout e2e run',
    command: { argv: 'npx playwright test checkout', exit_code: 1 },
    excerpt: '6 failing ... AssertionError: expected 500 to equal 200',
  });

  const verdict = verifyClaim({ status: 'PASSED', evidenceIds: [ev.evidence_id] });
  assert.equal(verdict.permitted, false);
  assert.equal(verdict.downgrade_to, 'INCONCLUSIVE');
  assert.match(verdict.reasons.join(' '), /non-zero exit code/);
});

test('a non-zero exit code does not block a FAILED claim -- it is consistent with it', () => {
  const ev = add({
    kind: 'command-output',
    summary: 'checkout e2e run',
    command: { argv: 'npx playwright test checkout', exit_code: 1 },
  });
  const verdict = verifyClaim({ status: 'FAILED', evidenceIds: [ev.evidence_id] });
  assert.equal(verdict.permitted, true);
});

test('evidence from an unrelated execution cannot back this claim, even with the right kind and class', () => {
  const ev = add({
    kind: 'test-report',
    summary: 'CSV exporter: 8 passed, 0 failed',
    executionId: 'EXEC-2026-00099',
  });

  const verdict = verifyClaim({ status: 'PASSED', evidenceIds: [ev.evidence_id], executionId: 'TC-00099' });
  assert.equal(verdict.permitted, false);
  assert.match(verdict.reasons.join(' '), /not linked to TC-00099|None of the attached execution evidence is linked/);
});

test('evidence linked via supports[] (not execution_id) is accepted', () => {
  const ev = add({
    kind: 'test-report',
    summary: '3DS fallback: 4 passed, 0 failed',
    supports: ['TC-00099'],
  });
  const verdict = verifyClaim({ status: 'PASSED', evidenceIds: [ev.evidence_id], executionId: 'TC-00099' });
  assert.equal(verdict.permitted, true);
});

test('a test-report describing zero executed cases cannot support a PASSED claim', () => {
  const ev = add({ kind: 'test-report', summary: 'auth suite: 0 passing / No tests found' });
  const verdict = verifyClaim({ status: 'PASSED', evidenceIds: [ev.evidence_id] });
  assert.equal(verdict.permitted, false);
  assert.match(verdict.reasons.join(' '), /zero executed cases/);
});

test('a real test-report with actual cases still passes the gate', () => {
  const ev = add({
    kind: 'test-report',
    summary: 'auth suite: 12 passed, 0 failed',
    executionId: 'EXEC-2026-00005',
  });
  const verdict = verifyClaim({ status: 'PASSED', evidenceIds: [ev.evidence_id], executionId: 'EXEC-2026-00005' });
  assert.equal(verdict.permitted, true);
});

test('auditClaims (the integrity self-audit) is not fooled by any of the three bypasses', () => {
  const contradictory = add({
    kind: 'command-output',
    summary: 'checkout e2e',
    command: { argv: 'npx playwright test', exit_code: 1 },
  });
  const unlinked = add({ kind: 'test-report', summary: 'unrelated: 8 passed', executionId: 'EXEC-2026-00099' });
  const empty = add({ kind: 'test-report', summary: '0 passing / No tests found' });

  const audit = auditClaims([
    { id: 'claim-1', status: 'PASSED', evidenceIds: [contradictory.evidence_id] },
    { id: 'claim-2', status: 'PASSED', evidenceIds: [unlinked.evidence_id], executionId: 'TC-00099' },
    { id: 'claim-3', status: 'PASSED', evidenceIds: [empty.evidence_id] },
  ]);

  assert.equal(audit.pass_claims, 3);
  assert.equal(audit.unevidenced_pass_claims, 3, 'all three bypass attempts must be caught');
  assert.equal(audit.false_confidence_rate, 1, 'the self-audit must not report 0 false confidence over false claims');
});
