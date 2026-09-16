import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempState } from './helpers.mjs';
import { nextId, isId, kindOf, currentCount } from '../engine/core/ids.mjs';
import { redact, redactText, containsSecret } from '../engine/core/redact.mjs';
import { validate, assertValid } from '../engine/schema/validate.mjs';

const tmp = useTempState('core');
test.after(() => tmp.cleanup());

test('IDs are sequential, zero-padded and year-scoped where declared', () => {
  const now = new Date('2026-03-04T10:00:00Z');
  assert.equal(nextId('decision', now), 'DEC-00001');
  assert.equal(nextId('decision', now), 'DEC-00002');
  assert.equal(nextId('execution', now), 'EXEC-2026-00001');
  assert.equal(currentCount('decision', now), 2);

  const nextYear = new Date('2027-01-01T00:00:00Z');
  assert.equal(nextId('execution', nextYear), 'EXEC-2027-00001', 'year-scoped counters restart per year');
  assert.equal(nextId('decision', nextYear), 'DEC-00003', 'non-scoped counters do not restart');
});

test('ID kinds are recognisable from the string alone', () => {
  assert.ok(isId('decision', 'DEC-00042'));
  assert.ok(!isId('decision', 'DEC-42'));
  assert.equal(kindOf('EXEC-2026-00142'), 'execution');
  assert.equal(kindOf('nonsense'), null);
});

test('unknown ID kinds fail loudly rather than inventing a prefix', () => {
  assert.throws(() => nextId('sandwich'), /Unknown ID kind/);
});

test('redaction masks token shapes in free text', () => {
  const secret = `ghp_${'a'.repeat(36)}`;
  const text = `curl -H "Authorization: Bearer ${'x'.repeat(40)}" && export GH_TOKEN=${secret}`;
  const clean = redactText(text);
  assert.ok(!clean.includes(secret), 'GitHub token must not survive redaction');
  assert.ok(!clean.includes('x'.repeat(40)), 'bearer token must not survive redaction');
  assert.ok(containsSecret(text));
  assert.ok(!containsSecret(clean));
});

test('redaction masks sensitive-looking object keys', () => {
  const out = redact({ user: 'ana', password: 'hunter2', nested: { api_key: 'abcd1234', note: 'fine' } });
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.nested.api_key, '[REDACTED]');
  assert.equal(out.user, 'ana', 'non-sensitive fields are preserved');
  assert.equal(out.nested.note, 'fine');
});

test('redaction survives circular structures', () => {
  const a = { name: 'a' };
  a.self = a;
  assert.equal(redact(a).self, '[circular]');
});

test('schema validator enforces required fields and patterns', () => {
  const bad = { decision_id: 'DEC-1', timestamp: 'yesterday' };
  const r = validate(bad, 'decision');
  assert.equal(r.valid, false);
  const messages = r.errors.map((e) => `${e.path} ${e.message}`).join('\n');
  assert.match(messages, /decision_id/);
  assert.match(messages, /timestamp/);
  assert.match(messages, /missing required property "question"/);
});

test('schema validator resolves cross-file $refs', () => {
  const r = validate({ name: 'checkout renders', status: 'PASSED', test_case_id: 'TC-00001' }, 'test-result');
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  const bad = validate({ name: 'x', status: 'MOSTLY_FINE' }, 'test-result');
  assert.equal(bad.valid, false);
  assert.match(bad.errors[0].message, /not in enum/);
});

test('assertValid throws with a readable message', () => {
  assert.throws(() => assertValid({}, 'evidence'), /Schema validation failed for "evidence"/);
});

/* ------------------------------------------------------------ regressions */

test('redaction does not mask "passed" — an optional suffix made `pass` match on its own', () => {
  const out = redact({ totals: { total: 2, passed: 2, failed: 0, skipped: 0 } });
  assert.deepEqual(out.totals, { total: 2, passed: 2, failed: 0, skipped: 0 });
});

test('redaction still masks real password-shaped keys', () => {
  const out = redact({ password: 'hunter2', passphrase: 'x', passwd: 'y', db_password: 'z' });
  for (const v of Object.values(out)) assert.equal(v, '[REDACTED]');
});

test('redaction matches "token" as a whole segment, not as a prefix', () => {
  const out = redact({ access_token: 'abc12345', token: 'def12345', tokens_used: 4120, tokenizer: 'bpe' });
  assert.equal(out.access_token, '[REDACTED]');
  assert.equal(out.token, '[REDACTED]');
  assert.equal(out.tokens_used, 4120, 'a token-count metric is not a secret');
  assert.equal(out.tokenizer, 'bpe');
});

test('a shared reference is not a cycle', () => {
  // Executions routinely hold the same array in two places. A visited-set treats the
  // second reference as circular and silently corrupts the record.
  const shared = ['EV-2026-00001'];
  const out = redact({ evidence: shared, failure_classification: { evidence_refs: shared } });
  assert.deepEqual(out.evidence, ['EV-2026-00001']);
  assert.deepEqual(out.failure_classification.evidence_refs, ['EV-2026-00001']);
});

test('a genuine cycle is still caught', () => {
  const a = { name: 'a' };
  a.self = a;
  assert.equal(redact(a).self, '[circular]');
  const x = { name: 'x' };
  const y = { name: 'y', back: x };
  x.forward = y;
  assert.equal(redact(x).forward.back, '[circular]');
});
