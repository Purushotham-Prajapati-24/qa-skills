import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { useTempState } from './helpers.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as evidenceEngine from '../engine/evidence-engine/index.mjs';

/**
 * `evidence add` has no update path, and a field trial hit exactly the gap that leaves:
 * an agent recorded an audit under `kind: other`, generated the report, saw
 * `evidence_auditor_run: false` (the metric only recognises `kind: evidence-audit`), and
 * had no way to correct the mistake -- only to add a SECOND, correctly-typed record and
 * ship both. The final report rendered the same audit twice.
 *
 * `amend` closes that recovery path directly: fix the kind in place, nothing else.
 */
function isolated(t, label) {
  const iso = useTempState(label);
  t.after(() => iso.cleanup());
}

test('amending a kind updates the stored record and returns it', (t) => {
  isolated(t, 'amend-basic');
  state.startSession({ request: 'amend basic test' });
  const ev = evidenceEngine.add({ kind: 'other', summary: 'an audit, mistyped' });
  const amended = evidenceEngine.amend(ev.evidence_id, { kind: 'evidence-audit' });
  assert.equal(amended.kind, 'evidence-audit');
  assert.equal(state.get('evidence', ev.evidence_id).kind, 'evidence-audit');
});

test('amending does not touch any other field on the record', (t) => {
  isolated(t, 'amend-untouched');
  state.startSession({ request: 'amend untouched test' });
  const ev = evidenceEngine.add({ kind: 'other', summary: 'keep this summary' });
  const amended = evidenceEngine.amend(ev.evidence_id, { kind: 'evidence-audit' });
  assert.equal(amended.summary, 'keep this summary');
  assert.equal(amended.evidence_id, ev.evidence_id);
  assert.equal(amended.timestamp, ev.timestamp);
});

test('amending to the same kind it already has is a harmless no-op', (t) => {
  isolated(t, 'amend-noop');
  state.startSession({ request: 'amend noop test' });
  const ev = evidenceEngine.add({ kind: 'evidence-audit', summary: 'already correct' });
  const amended = evidenceEngine.amend(ev.evidence_id, { kind: 'evidence-audit' });
  assert.equal(amended.kind, 'evidence-audit');
});

test('amending an unknown evidence ID throws, naming the ID', (t) => {
  isolated(t, 'amend-missing');
  state.startSession({ request: 'amend missing test' });
  assert.throws(() => evidenceEngine.amend('EV-2026-99999', { kind: 'evidence-audit' }), /No such evidence: EV-2026-99999/);
});

test('amending to an unknown kind throws and lists the valid ones', (t) => {
  isolated(t, 'amend-bad-kind');
  state.startSession({ request: 'amend bad kind test' });
  const ev = evidenceEngine.add({ kind: 'other', summary: 'placeholder summary' });
  assert.throws(
    () => evidenceEngine.amend(ev.evidence_id, { kind: 'not-a-real-kind' }),
    /Unknown evidence kind "not-a-real-kind".*evidence-audit/s,
  );
});

test('omitting --kind throws a clear error rather than silently no-opping', (t) => {
  isolated(t, 'amend-no-kind');
  state.startSession({ request: 'amend no kind test' });
  const ev = evidenceEngine.add({ kind: 'other', summary: 'placeholder summary' });
  assert.throws(() => evidenceEngine.amend(ev.evidence_id, {}), /requires --kind/);
});

test('the amended kind must still validate against the evidence schema', (t) => {
  isolated(t, 'amend-schema');
  state.startSession({ request: 'amend schema test' });
  const ev = evidenceEngine.add({ kind: 'other', summary: 'placeholder summary' });
  // "evidence-audit" is a real enum value on the schema -- this would throw at state.put()
  // if amend() ever bypassed schema validation on the write.
  assert.doesNotThrow(() => evidenceEngine.amend(ev.evidence_id, { kind: 'evidence-audit' }));
});

/* -------------------------------------------------------------- CLI: ast evidence amend */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST = path.join(ROOT, 'bin', 'ast.mjs');

function freshState(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ast-amend-${label}-`));
}

function ast(args, stateDir) {
  return execFileSync(process.execPath, [AST, '--state', stateDir, ...args], { encoding: 'utf8', timeout: 15_000 });
}

function astInput(args, payload, stateDir) {
  const file = path.join(stateDir, `input-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  return ast([...args, '--input', file], stateDir);
}

test('CLI: "ast evidence amend <id> --kind <kind>" corrects a stored record', () => {
  const dir = freshState('cli-basic');
  ast(['session', 'start', '--request', 'x'], dir);
  const ev = JSON.parse(astInput(['evidence', 'add'], { kind: 'other', summary: 'audit recorded under the wrong kind' }, dir));
  const out = JSON.parse(ast(['evidence', 'amend', ev.evidence_id, '--kind', 'evidence-audit'], dir));
  assert.equal(out.kind, 'evidence-audit');
  const listed = JSON.parse(ast(['evidence', 'list'], dir));
  assert.equal(listed.find((e) => e.evidence_id === ev.evidence_id).kind, 'evidence-audit');
});

test('CLI: "ast evidence amend" with no ID is a clear error, not a crash', () => {
  const dir = freshState('cli-no-id');
  ast(['session', 'start', '--request', 'x'], dir);
  assert.throws(() => ast(['evidence', 'amend', '--kind', 'evidence-audit'], dir), /requires an evidence ID/);
});

test('CLI: "ast evidence amend <id>" with no --kind is a clear error', () => {
  const dir = freshState('cli-no-kind');
  ast(['session', 'start', '--request', 'x'], dir);
  const ev = JSON.parse(astInput(['evidence', 'add'], { kind: 'other', summary: 'placeholder summary' }, dir));
  assert.throws(() => ast(['evidence', 'amend', ev.evidence_id], dir), /requires --kind/);
});
