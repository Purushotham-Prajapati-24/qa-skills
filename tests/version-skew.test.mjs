import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempState } from './helpers.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as execution from '../engine/execution-engine/index.mjs';
import * as evidenceEngine from '../engine/evidence-engine/index.mjs';
import * as reporting from '../engine/reporting-engine/index.mjs';
import { check as checkCompleteness } from '../engine/evaluation-engine/process-completeness.mjs';
import { SYSTEM_VERSION } from '../engine/core/version.mjs';

/**
 * A field trial's rendered report cited "AST v0.8.0" in its header while the skills it had
 * just run under declared v0.9.0 -- nothing had ever checked whether the CLI was upgraded
 * mid-session. `provenance.skill_version` is stamped from SYSTEM_VERSION at the moment each
 * record is written, so simulating the skew means writing a record and then downgrading its
 * stamped version directly on disk, the same way tests/evidence-grade.test.mjs simulates a
 * pre-existing record shape.
 */
function isolated(t, label) {
  const iso = useTempState(label);
  t.after(() => iso.cleanup());
}

/** Rewrite a persisted record's stamped skill_version, simulating one written by an older install. */
function downgrade(collection, id, version) {
  const rec = state.get(collection, id);
  rec.provenance.skill_version = version;
  state.put(collection, id, rec, collection === 'evidence' ? 'evidence' : collection.slice(0, -1));
}

test('a fresh session with nothing stamped under an old version raises no version-skew finding', (t) => {
  isolated(t, 'skew-clean');
  state.startSession({ request: 'clean version test' });
  const findings = checkCompleteness();
  assert.equal(findings.find((f) => f.check === 'version-skew'), undefined);
});

test('a session record stamped under an older skill version raises an advisory version-skew finding naming it', (t) => {
  isolated(t, 'skew-session');
  state.startSession({ request: 'stale session test' });
  const session = state.loadSession();
  session.provenance.skill_version = '0.8.0';
  state.save(session);
  const findings = checkCompleteness();
  const f = findings.find((c) => c.check === 'version-skew');
  assert.ok(f, 'expected a version-skew finding');
  assert.equal(f.severity, 'advisory');
  assert.match(f.message, /0\.8\.0/);
  assert.match(f.message, new RegExp(`v${SYSTEM_VERSION.replace(/\./g, '\\.')}`));
});

test('an execution record stamped under an older skill version also raises version-skew', (t) => {
  isolated(t, 'skew-execution');
  state.startSession({ request: 'stale execution test' });
  const exec = execution.start({ goal: 'typecheck', method: 'static-analysis', git: null });
  execution.finish(exec.execution_id, { status: 'PASSED', statusReason: 'ok' });
  downgrade('executions', exec.execution_id, '0.7.5');
  const f = checkCompleteness().find((c) => c.check === 'version-skew');
  assert.ok(f);
  assert.match(f.message, /0\.7\.5/);
});

test('an evidence record stamped under an older skill version also raises version-skew', (t) => {
  isolated(t, 'skew-evidence');
  state.startSession({ request: 'stale evidence test' });
  const ev = evidenceEngine.add({ kind: 'static-analysis', summary: 'legacy-stamped evidence' });
  downgrade('evidence', ev.evidence_id, '0.7.0');
  const f = checkCompleteness().find((c) => c.check === 'version-skew');
  assert.ok(f);
  assert.match(f.message, /0\.7\.0/);
});

test('multiple distinct stale versions across records are all named, sorted', (t) => {
  isolated(t, 'skew-multiple');
  state.startSession({ request: 'mixed version test' });
  const exec = execution.start({ goal: 'typecheck', method: 'static-analysis', git: null });
  execution.finish(exec.execution_id, { status: 'PASSED', statusReason: 'ok' });
  downgrade('executions', exec.execution_id, '0.9.0-nonexistent');
  const ev = evidenceEngine.add({ kind: 'static-analysis', summary: 'another stale record' });
  downgrade('evidence', ev.evidence_id, '0.7.0');
  const f = checkCompleteness().find((c) => c.check === 'version-skew');
  assert.ok(f);
  const idxA = f.message.indexOf('0.7.0');
  const idxB = f.message.indexOf('0.9.0-nonexistent');
  assert.ok(idxA !== -1 && idxB !== -1 && idxA < idxB, 'versions must be listed in sorted order');
});

test('the current running version alone -- even with real records present -- never raises version-skew', (t) => {
  isolated(t, 'skew-current-only');
  state.startSession({ request: 'all current version test' });
  const exec = execution.start({ goal: 'typecheck', method: 'static-analysis', git: null });
  execution.finish(exec.execution_id, { status: 'PASSED', statusReason: 'ok' });
  evidenceEngine.add({ kind: 'static-analysis', summary: 'current version evidence', executionId: exec.execution_id });
  assert.equal(checkCompleteness().find((c) => c.check === 'version-skew'), undefined);
});

test('version-skew flows into a rendered report\'s integrity violations, tagged with its severity', (t) => {
  isolated(t, 'skew-report');
  state.startSession({ request: 'report skew test' });
  const ev = evidenceEngine.add({ kind: 'static-analysis', summary: 'stale evidence for report test' });
  downgrade('evidence', ev.evidence_id, '0.6.0');
  const { markdown, report } = reporting.generate();
  assert.ok(report.integrity.violations.some((v) => v.includes('[process:advisory]') && v.includes('0.6.0')));
  assert.match(markdown, /0\.6\.0/);
});
