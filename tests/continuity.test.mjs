import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { useTempState } from './helpers.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as execution from '../engine/execution-engine/index.mjs';
import * as evidence from '../engine/evidence-engine/index.mjs';
import * as decisions from '../engine/decision-engine/index.mjs';
import * as defects from '../engine/defect-engine/index.mjs';
import { CLASSES } from '../engine/failure-classifier/index.mjs';
import { check, planProgress } from '../engine/evaluation-engine/process-completeness.mjs';

/**
 * Continuity: long sessions, interruptions, compactions, resumes and second sessions on the
 * same state directory. Each test is a failure seen in the 2026-10-09 continuity audit.
 */

const created = [];
test.after(() => created.forEach((t) => t.cleanup()));
const fresh = (label) => { const t = useTempState(`cont-${label}`); created.push(t); return t; };

function plan(scenarios, planId = 'PLAN-00001') {
  return state.savePlan({
    plan_id: planId, created_at: new Date().toISOString(), objective: 'Continuity test plan',
    scope: { in_scope: ['x'], out_of_scope: [] },
    applicability: [{ category: 'e2e', applicable: true, reason: 'multi-step user paths present' }],
    scenarios: scenarios.map((s) => ({ category: 'e2e', method: 'api-client', obligation: 'must-test', ...s })),
    exit_criteria: ['run'],
    provenance: { skill_version: '0.12.0', created_at: new Date().toISOString(), created_by: 'agent' },
  });
}
function realRun(sid) {
  const e = execution.start({ goal: `run ${sid}`, method: 'api-client', planScenarioId: sid, git: null, command: 'npm test' });
  const ev = evidence.captureOutput({ argv: 'npm test', cwd: '/r', exitCode: 0, durationMs: 5, stdout: 'ok', summary: `ran ${sid}`, executionId: e.execution_id, git: null });
  return execution.finish(e.execution_id, { status: 'PASSED', statusReason: `${sid} passed`, evidence: [ev.evidence_id] }).record;
}
const decide = () => decisions.record({ question: 'How deep should testing go?', options: ['standard', 'deep'], selected: 'standard', reason: 'fixture', confidence: 0.8, reversible: true });

/* ------------------------------------------------- a new session starts clean */

test('a new session does not inherit the previous session\'s runs, decisions, findings or matrix', async () => {
  fresh('scope');
  state.startSession({ request: 'session A', git: null });
  decide();
  state.saveApplicability({ matrix: [{ category: 'e2e', applicable: true, priority: 'P0', reason: 'x' }] });
  plan([{ id: 'S-01', title: 'checkout' }]);
  realRun('S-01');
  defects.create({ title: 'Search shows stale results after an edit', kind: 'defect', severity: 'major', confidence: 0.7, epistemicClass: 'observed' });

  state.startSession({ request: 'session B, new commit', git: null });
  plan([{ id: 'S-01', title: 'checkout again' }]);
  assert.equal(planProgress().must_test_executed, 0, 'A\'s run tested A\'s code');
  assert.equal(state.loadApplicability(), null, 'A\'s matrix judged A\'s change');
  assert.ok(!check().some((f) => f.check === 'unconfirmed-defect'), 'A\'s finding does not gate B');

  realRun('S-01');
  const gaps = check().map((f) => f.check);
  assert.ok(gaps.includes('no-decisions'), 'A\'s decisions do not cover B\'s work');
  assert.ok(gaps.includes('no-applicability-matrix'));

  const reporting = await import('../engine/reporting-engine/index.mjs');
  const { report } = reporting.generate({});
  assert.equal(report.detailed_results.length, 1, 'B\'s report lists only B\'s run');
});

/* ------------------------------------------------------------ resume */

test('resume leaves a recent run open (a parallel explorer may own it) and finalises an idle one', () => {
  fresh('resume');
  state.startSession({ request: 'resume', git: null });
  const t0 = new Date('2026-10-09T10:00:00Z');
  const stale = execution.start({ goal: 'abandoned run', method: 'api-client', git: null, now: t0 });
  const live = execution.start({ goal: 'explorer run', method: 'api-client', git: null, now: new Date('2026-10-09T10:25:00Z') });
  const r = state.recover({ now: new Date('2026-10-09T10:30:00Z') });
  assert.deepEqual(r.orphaned_executions.map((o) => o.execution_id), [stale.execution_id]);
  assert.deepEqual(r.in_flight_executions.map((o) => o.execution_id), [live.execution_id]);
  assert.match(r.in_flight_note, /--interrupt-all/);
  assert.equal(state.get('executions', live.execution_id).status, 'PARTIAL');
  assert.ok(state.loadSession().open_executions.includes(live.execution_id), 'it stays open for its owner to finish');

  const all = state.recover({ now: new Date('2026-10-09T10:31:00Z'), interruptAll: true });
  assert.deepEqual(all.orphaned_executions.map((o) => o.execution_id), [live.execution_id]);
  assert.equal(state.loadSession().open_executions.length, 0);
});

test('resume treats a run with evidence after its start as active, and one stopped by a recorded interruption as interrupted', () => {
  fresh('activity');
  state.startSession({ request: 'activity', git: null });
  const e = execution.start({ goal: 'long probe run', method: 'api-client', git: null, now: new Date(Date.now() - 60 * 60_000) });
  evidence.captureOutput({ argv: 'npm test', cwd: '/r', exitCode: 0, durationMs: 1, stdout: 'ok', summary: 'still working', executionId: e.execution_id, git: null });
  assert.equal(state.recover().in_flight_executions.length, 1, 'fresh evidence means someone is working on it');
  state.recordInterruption({ kind: 'user', note: 'user stopped everything' });
  assert.equal(state.recover().orphaned_executions.length, 1, 'nothing happened on it since the recorded interruption');
});

/* ------------------------------------------------------- results are final */

test('a finished run cannot be re-finished: a FAILED result is never rewritten as PASSED', () => {
  fresh('immutable');
  state.startSession({ request: 'immutable', git: null });
  const e = execution.start({ goal: 'checkout run', method: 'api-client', git: null });
  const ev = evidence.captureOutput({ argv: 'npm test', cwd: '/r', exitCode: 1, durationMs: 1, stdout: '1 failed', summary: 'failing run', executionId: e.execution_id, git: null });
  execution.finish(e.execution_id, { status: 'FAILED', statusReason: 'assertion failed', evidence: [ev.evidence_id], signals: ['assertion-mismatch'] });
  assert.throws(() => execution.finish(e.execution_id, { status: 'PASSED', statusReason: 'rerun passed', evidence: [ev.evidence_id] }), /already finished as FAILED.*new execution/);
  assert.equal(state.get('executions', e.execution_id).status, 'FAILED');
});

/* ------------------------------------------------------------ the CLI */

const AST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ast.mjs');
const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'hooks', 'session-start.mjs');
function cliState(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ast-cont-${label}-`));
  created.push({ cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) });
  const run = (args, ok = true) => {
    try { return JSON.parse(execFileSync(process.execPath, [AST, '--state', dir, ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 15_000 })); }
    catch (e) { if (ok) throw e; return { error: `${e.stdout}${e.stderr}` }; }
  };
  const input = (args, body, ok) => { const f = path.join(dir, `in-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(body)); return run([...args, '--input', f], ok); };
  const savePlan = (ids) => input(['plan', 'save'], {
    plan_id: 'PLAN-00001', created_at: new Date().toISOString(), objective: 'CLI continuity plan', scope: { in_scope: ['x'], out_of_scope: [] },
    applicability: [{ category: 'e2e', applicable: true, reason: 'multi-step user paths present' }],
    scenarios: ids.map((id) => ({ id, title: `scenario ${id}`, category: 'e2e', method: 'api-client', obligation: 'must-test' })),
    exit_criteria: ['run'], provenance: { skill_version: '0.12.0', created_at: new Date().toISOString(), created_by: 'agent' },
  });
  return { dir, run, input, savePlan };
}

test('CLI: session start refuses to replace a recent unfinished session; --new abandons it honestly', () => {
  const c = cliState('restart');
  c.run(['session', 'start', '--request', 'the real session']);
  c.savePlan(['S-01']);
  const open = c.input(['exec', 'start'], { goal: 'half-done run', method: 'api-client', plan_scenario_id: 'S-01', git: null });
  const refused = c.run(['session', 'start', '--request', 'continue testing'], false);
  assert.match(refused.error, /unfinished .*session resume.*--new/s);
  assert.equal(c.run(['session', 'show']).user_request, 'the real session', 'nothing was replaced');
  c.run(['session', 'start', '--new', '--request', 'deliberately fresh']);
  assert.equal(c.run(['exec', 'list']).find((e) => e.execution_id === open.execution_id).status, 'INTERRUPTED');
});

test('CLI: a finished session can be followed by a new one without --new', () => {
  const c = cliState('finished');
  c.run(['session', 'start', '--request', 'done session']);
  c.run(['session', 'start', '--request', 'next session']);
  assert.equal(c.run(['session', 'show']).user_request, 'next session');
});

test('CLI: session resume says what is owed and derives the next action from the queue', () => {
  const c = cliState('owed');
  c.run(['session', 'start', '--request', 'resume me']);
  c.savePlan(['S-01', 'S-02']);
  const r = c.run(['session', 'resume']);
  assert.equal(r.plan_progress.remaining, 2);
  assert.ok(r.owed.count >= 2);
  assert.match(r.next_action, /Continue the work queue/);
  assert.match(r.recorded_next_action, /discovery/);
});

test('CLI: evidence cannot be captured into a finished run, and a scenario-id typo warns at once', () => {
  const c = cliState('integrity');
  c.run(['session', 'start', '--request', 'integrity']);
  c.savePlan(['S-01']);
  const typo = c.input(['exec', 'start'], { goal: 'typo run', method: 'api-client', plan_scenario_id: 'S-1', git: null });
  assert.match(typo.warning, /"S-1" is not a scenario .*known: S-01/);
  const ev = c.run(['evidence', 'capture', '--exec', typo.execution_id, '--summary', 'probe run', '--', process.execPath, '-e', "require('node:assert').ok(1)"]);
  c.input(['exec', 'finish', typo.execution_id], { status: 'PASSED', statusReason: 'assertion held', evidence: [ev.evidence_id] });
  const late = c.run(['evidence', 'capture', '--exec', typo.execution_id, '--summary', 'late run', '--', process.execPath, '-e', "require('node:assert').ok(1)"], false);
  assert.match(late.error, /already finished .*Start a new execution/s);
});

test('CLI: uncertainty note records work done despite a blocker', () => {
  const c = cliState('note');
  c.run(['session', 'start', '--request', 'note']);
  const u = c.input(['uncertainty', 'raise'], { question: 'Which payment sandbox may be charged?', status: 'user-input-required', impact: 'cannot run the real payment hop', affectedScope: ['payment-e2e'], nextAction: 'ask the user' });
  const noted = c.run(['uncertainty', 'note', u.id, '--work', 'Ran the payment journey with the provider mocked: 5/5']);
  assert.deepEqual(noted.independent_work_continued, ['Ran the payment journey with the provider mocked: 5/5']);
  assert.match(c.run(['uncertainty', 'note', u.id], false).error, /--work is required/);
});

/* ------------------------------------------- the next step never crashes */

test('decision next has guidance for every class the classifier can return, and warns on an unknown one', () => {
  for (const cls of CLASSES) {
    const out = decisions.nextAction({ status: 'FAILED', failureClass: cls });
    assert.ok(out.next && !out.unknown_failure_class, `no guidance for "${cls}"`);
  }
  const unknown = decisions.nextAction({ status: 'FAILED', failureClass: '...' });
  assert.equal(unknown.unknown_failure_class, '...');
  assert.match(unknown.warning, /not a failure class/);
});

/* ------------------------------------------------- after a compaction */

test('the SessionStart hook fires on compaction and hands back the session, not a fresh start', () => {
  const hooks = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'hooks.json'), 'utf8'));
  assert.match(hooks.hooks.SessionStart[0].matcher, /\bcompact\b/);
  const c = cliState('compact');
  c.run(['session', 'start', '--request', 'compacted']);
  c.savePlan(['S-01']);
  const out = JSON.parse(execFileSync(process.execPath, [HOOK], { input: JSON.stringify({ source: 'compact' }), encoding: 'utf8', env: { ...process.env, AST_STATE_DIR: c.dir } }));
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /item\(s\) are still owed/);
  assert.match(ctx, /Do NOT start a new session/);
  assert.match(ctx, /bin\/ast\.mjs" session resume/);
});
