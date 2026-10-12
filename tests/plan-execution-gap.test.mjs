import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { useTempState, sampleProfile } from './helpers.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as execution from '../engine/execution-engine/index.mjs';
import * as evidence from '../engine/evidence-engine/index.mjs';
import * as decisions from '../engine/decision-engine/index.mjs';
import * as uncertainty from '../engine/uncertainty-register/index.mjs';
import { check, planProgress } from '../engine/evaluation-engine/process-completeness.mjs';

/**
 * Adversarial tests for the plan-to-execution gap: each one is a way an agent could plan
 * work, not do it, and still pass `validate --final`. Every test asserts the CLOSED
 * behaviour; each was seen failing against the engine before the fix that closes it.
 */

const created = [];
test.after(() => created.forEach((t) => t.cleanup()));

function fresh(label) {
  const t = useTempState(`gap-${label}`);
  created.push(t);
  state.startSession({ request: `gap probe: ${label}`, git: null });
  return t;
}

function plan(scenarios, planId = 'PLAN-00001') {
  return state.savePlan({
    plan_id: planId,
    created_at: new Date().toISOString(),
    objective: 'Probe the plan-to-execution gap',
    scope: { in_scope: ['everything'], out_of_scope: [] },
    applicability: [{ category: 'e2e', applicable: true, reason: 'multi-step user paths present' }],
    scenarios: scenarios.map((s) => ({ category: 'e2e', method: 'api-client', ...s })),
    exit_criteria: ['All must-test scenarios executed'],
    provenance: { skill_version: '0.12.0', created_at: new Date().toISOString(), created_by: 'agent' },
  });
}

/** A real, evidenced run linked to a scenario -- the thing that SHOULD satisfy the floor. */
function realRun(scenarioId, { status = 'PASSED', exitCode = 0, testFiles, command = 'npm test' } = {}) {
  const e = execution.start({ goal: `run ${scenarioId}`, method: 'api-client', testCategory: 'e2e', planScenarioId: scenarioId, git: null, command, testFiles });
  const ev = evidence.captureOutput({ argv: command, cwd: '/repo', exitCode, durationMs: 10, stdout: exitCode ? '1 failed' : '1 passed', summary: 'probe', executionId: e.execution_id, git: null });
  return execution.finish(e.execution_id, { status, statusReason: `scenario ${scenarioId} ran; see evidence`, evidence: [ev.evidence_id] }).record;
}

const finding = (name) => check().find((f) => f.check === name);
const scenarioGap = () => finding('scenario-coverage-floor');

/* ------------------------------------------------------------- holes */

test('HOLE 1: an execution opened and never run (recovered as INTERRUPTED) does not satisfy a must-test scenario', () => {
  fresh('interrupted');
  plan([{ id: 'S-01', title: 'checkout', obligation: 'must-test' }]);
  execution.start({ goal: 'checkout', method: 'api-client', testCategory: 'e2e', planScenarioId: 'S-01', git: null });
  state.recordInterruption({ kind: 'tool-failure', note: 'agent moved on' });
  state.recover();
  assert.ok(scenarioGap(), 'an INTERRUPTED execution tested nothing; S-01 must still be owed');
  assert.match(scenarioGap().message, /S-01/);
});

test('HOLE 2: an unevidenced PASSED (downgraded to INCONCLUSIVE, zero evidence) does not satisfy a must-test scenario', () => {
  fresh('unevidenced');
  plan([{ id: 'S-01', title: 'checkout', obligation: 'must-test' }]);
  const e = execution.start({ goal: 'checkout', method: 'api-client', testCategory: 'e2e', planScenarioId: 'S-01', git: null });
  execution.finish(e.execution_id, { status: 'PASSED', statusReason: 'it works', evidence: [] });
  assert.ok(scenarioGap(), 'a claim with nothing behind it is not a run');
});

test('HOLE 3: an agent cannot self-defer a must-test scenario with its own "deferred" uncertainty', () => {
  fresh('self-defer');
  plan([{ id: 'S-01', title: 'checkout', obligation: 'must-test' }]);
  const u = uncertainty.raise({ question: 'Out of time?', status: 'deferred', owner: 'agent', impact: 'not run', affectedScope: ['S-01'], nextAction: 'run it later' });
  execution.recordNonExecution({ goal: 'checkout', status: 'DEFERRED', reason: 'ran out of my own budget', testCategory: 'e2e', planScenarioId: 'S-01', uncertainties: [u.id] });
  assert.ok(scenarioGap(), 'the agent choosing not to run something is not a blocker');
});

test('HOLE 3b: the same self-deferral does not satisfy the category floor either', () => {
  fresh('self-defer-cat');
  state.saveApplicability({ matrix: [{ category: 'security', applicable: true, priority: 'P1', reason: 'auth present' }] });
  const u = uncertainty.raise({ question: 'Skip security?', status: 'deferred', owner: 'agent', impact: 'not run', affectedScope: ['security'], nextAction: 'later' });
  execution.recordNonExecution({ goal: 'security sweep', status: 'DEFERRED', reason: 'budget', testCategory: 'security', uncertainties: [u.id] });
  assert.ok(finding('coverage-floor'), 'a self-deferred mandatory baseline is still uncovered');
});

test('HOLE 4: a not-run whose blocker was later RESOLVED must be re-run, not left on hold', () => {
  fresh('resolved');
  plan([{ id: 'S-01', title: 'payment e2e', obligation: 'must-test' }]);
  const u = uncertainty.raise({ question: 'Sandbox key?', status: 'user-input-required', owner: 'user', impact: 'cannot pay', affectedScope: ['S-01'], nextAction: 'ask for key' });
  execution.recordNonExecution({ goal: 'payment e2e', status: 'BLOCKED', reason: 'no key', testCategory: 'e2e', planScenarioId: 'S-01', uncertainties: [u.id] });
  assert.equal(scenarioGap(), undefined, 'while the blocker is open, the BLOCKED record is a legitimate hold');
  uncertainty.resolve(u.id, { answer: 'key is in .env.test' });
  assert.ok(scenarioGap(), 'the obstacle is gone, so the hold no longer counts');
  const f = finding('unblocked-not-rerun');
  assert.ok(f, 'a named finding tells the agent exactly which held items to run now');
  assert.match(f.message, /S-01|payment e2e/);
  realRun('S-01');
  assert.equal(scenarioGap(), undefined);
  assert.equal(finding('unblocked-not-rerun'), undefined);
});

test('HOLE 5: real executions with no persisted plan is a blocking gap (skipping `plan save` cannot skip the floor)', () => {
  fresh('no-plan');
  realRun('S-01');
  const f = finding('no-plan');
  assert.ok(f);
  assert.equal(f.severity, 'blocking');
});

test('HOLE 6: re-saving a smaller plan does not erase must-test scenarios an earlier plan committed to', () => {
  fresh('shrink');
  plan([{ id: 'S-01', title: 'a', obligation: 'must-test' }, { id: 'S-02', title: 'b', obligation: 'must-test' }], 'PLAN-00001');
  plan([{ id: 'S-01', title: 'a', obligation: 'must-test' }], 'PLAN-00002');
  realRun('S-01');
  assert.ok(scenarioGap(), 'S-02 was committed to; dropping it from a later plan is not executing it');
  assert.match(scenarioGap().message, /S-02/);
});

test('HOLE 6b: downgrading a must-test scenario to nice-to-test in a re-save does not release it', () => {
  fresh('downgrade');
  plan([{ id: 'S-01', title: 'a', obligation: 'must-test' }], 'PLAN-00001');
  plan([{ id: 'S-01', title: 'a', obligation: 'nice-to-test' }], 'PLAN-00001');
  realRun('S-99');
  assert.ok(scenarioGap());
});

test('HOLE 7: a scenario planned as "blocked" still needs a recorded not-run with its blocker', () => {
  fresh('planned-blocked');
  plan([{ id: 'S-01', title: 'a', obligation: 'must-test' }, { id: 'S-02', title: 'payment', obligation: 'blocked' }]);
  realRun('S-01');
  assert.ok(scenarioGap(), 'a scenario labelled blocked at plan time otherwise disappears without a record');
  assert.match(scenarioGap().message, /S-02/);
});

test('HOLE 8: a plan that commits to nothing (no must-test scenario) is a blocking gap', () => {
  fresh('no-commitment');
  plan([{ id: 'S-01', title: 'a', obligation: 'should-test' }, { id: 'S-02', title: 'b', obligation: 'nice-to-test' }]);
  realRun('S-01');
  const f = finding('plan-without-commitments');
  assert.ok(f);
  assert.equal(f.severity, 'blocking');
});

test('HOLE 9: a should-test scenario cannot vanish -- it needs a run or an explicit recorded skip', () => {
  fresh('should-test');
  plan([{ id: 'S-01', title: 'a', obligation: 'must-test' }, { id: 'S-02', title: 'load test', obligation: 'should-test' }]);
  realRun('S-01');
  const f = finding('scenario-disposition');
  assert.ok(f, 'S-02 has no record at all');
  assert.match(f.message, /S-02/);
  execution.recordNonExecution({ goal: 'load test', status: 'SKIPPED', reason: 'no isolated environment to load safely', testCategory: 'load', planScenarioId: 'S-02' });
  assert.equal(finding('scenario-disposition'), undefined, 'an explicit, reasoned skip is a disposition');
});

test('HOLE 10: an execution linked to a scenario id that is not in any plan is flagged, not silently counted', () => {
  fresh('dangling');
  plan([{ id: 'S-01', title: 'a', obligation: 'must-test' }]);
  realRun('S-1');
  const f = finding('unknown-plan-scenario');
  assert.ok(f);
  assert.match(f.message, /S-1\b/);
});

test('HOLE 11: plan progress agrees with the floor -- an INTERRUPTED run is not "executed"', () => {
  fresh('progress');
  plan([{ id: 'S-01', title: 'a', obligation: 'must-test' }]);
  execution.start({ goal: 'scenario a', method: 'api-client', testCategory: 'e2e', planScenarioId: 'S-01', git: null });
  state.recordInterruption({ kind: 'tool-failure', note: 'x' });
  state.recover();
  const p = planProgress();
  assert.equal(p.must_test_remaining, 1);
  assert.equal(p.scenarios[0].executed, false);
});

/* ------------------------------------------------- authored tests must run */

function tempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-gap-repo-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q');
  g('config', 'user.email', 'probe@example.test');
  g('config', 'user.name', 'probe');
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'old.test.js'), 'test("old", () => {});\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  return dir;
}

test('HOLE 12: a test file written during the session and never executed is a blocking gap', () => {
  fresh('authored');
  const repo = tempGitRepo();
  const prev = process.cwd();
  try {
    process.chdir(repo);
    plan([{ id: 'S-01', title: 'checkout', obligation: 'must-test' }]);
    const written = path.join(repo, 'tests', 'checkout.spec.js');
    fs.writeFileSync(written, 'test("checkout", () => {});\n');
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(written, future, future);
    realRun('S-01', { command: 'npm run lint' });
    const f = finding('authored-test-not-run');
    assert.ok(f, 'a written test that never ran is a draft, not coverage');
    assert.equal(f.severity, 'blocking');
    assert.match(f.message, /checkout\.spec\.js/);
    assert.doesNotMatch(f.message, /old\.test\.js/, 'pre-existing tests are not "authored this session"');

    realRun('S-01', { command: 'npx playwright test', testFiles: ['tests/checkout.spec.js'] });
    assert.equal(finding('authored-test-not-run'), undefined, 'running it (and saying which file ran) clears the gap');
  } finally {
    process.chdir(prev);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HOLE 12b: naming the authored file in the run command also counts as running it', () => {
  fresh('authored-cmd');
  const repo = tempGitRepo();
  const prev = process.cwd();
  try {
    process.chdir(repo);
    plan([{ id: 'S-01', title: 'checkout', obligation: 'must-test' }]);
    const written = path.join(repo, 'tests', 'api_orders.test.mjs');
    fs.writeFileSync(written, '// new\n');
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(written, future, future);
    realRun('S-01', { command: 'node --test tests/api_orders.test.mjs' });
    assert.equal(finding('authored-test-not-run'), undefined);
  } finally {
    process.chdir(prev);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------- CLI work queue */

const AST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ast.mjs');
const cli = (dir, args) => execFileSync(process.execPath, [AST, '--state', dir, ...args], { encoding: 'utf8', timeout: 15_000 });
const cliIn = (dir, args, body) => {
  const f = path.join(dir, `in-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(body));
  return cli(dir, [...args, '--input', f]);
};

test('CLI: `ast todo` lists every owed scenario with a next command, and empties as they run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-gap-todo-'));
  created.push({ cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) });
  cli(dir, ['session', 'start', '--request', 'todo probe']);
  cliIn(dir, ['plan', 'save'], {
    plan_id: 'PLAN-00001', created_at: new Date().toISOString(), objective: 'Work queue probe',
    scope: { in_scope: ['x'], out_of_scope: [] },
    applicability: [{ category: 'e2e', applicable: true, reason: 'multi-step user paths present' }],
    scenarios: [
      { id: 'S-01', title: 'first', category: 'e2e', method: 'api-client', obligation: 'must-test' },
      { id: 'S-02', title: 'second', category: 'e2e', method: 'api-client', obligation: 'must-test' },
    ],
    exit_criteria: ['both run'],
    provenance: { skill_version: '0.12.0', created_at: new Date().toISOString(), created_by: 'agent' },
  });
  let todo = JSON.parse(cli(dir, ['todo']));
  assert.equal(todo.done, false);
  const refs = () => todo.items.filter((i) => i.check === 'scenario-coverage-floor').map((i) => i.ref);
  assert.deepEqual(refs(), ['S-01', 'S-02']);
  assert.match(todo.items.find((i) => i.ref === 'S-01').next, /plan_scenario_id.*S-01/);

  for (const id of ['S-01', 'S-02']) {
    const ex = JSON.parse(cliIn(dir, ['exec', 'start'], { goal: `run ${id}`, method: 'api-client', testCategory: 'e2e', plan_scenario_id: id, git: null }));
    const ev = JSON.parse(cli(dir, ['evidence', 'capture', '--exec', ex.execution_id, '--summary', id, '--', process.execPath, '-e', "require('node:assert').ok(1 + 1 === 2)"]));
    cliIn(dir, ['exec', 'finish', ex.execution_id], { status: 'PASSED', statusReason: `${id} command exited 0`, evidence: [ev.evidence_id] });
  }
  todo = JSON.parse(cli(dir, ['todo']));
  assert.deepEqual(refs(), [], 'both scenarios ran with evidence');
  const progress = JSON.parse(cli(dir, ['plan', 'progress']));
  assert.equal(progress.must_test_remaining, 0);
});

test('CLI: `plan save` warns when a re-save drops a committed scenario, and keeps enforcing it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-gap-resave-'));
  created.push({ cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) });
  cli(dir, ['session', 'start', '--request', 'resave probe']);
  const base = {
    created_at: new Date().toISOString(), objective: 'Re-save probe',
    scope: { in_scope: ['x'], out_of_scope: [] },
    applicability: [{ category: 'e2e', applicable: true, reason: 'multi-step user paths present' }],
    exit_criteria: ['run'],
    provenance: { skill_version: '0.12.0', created_at: new Date().toISOString(), created_by: 'agent' },
  };
  cliIn(dir, ['plan', 'save'], { ...base, plan_id: 'PLAN-00001', scenarios: [
    { id: 'S-01', title: 'kept', category: 'e2e', method: 'api-client', obligation: 'must-test' },
    { id: 'S-02', title: 'dropped later', category: 'e2e', method: 'api-client', obligation: 'must-test' },
  ] });
  const out = JSON.parse(cliIn(dir, ['plan', 'save'], { ...base, plan_id: 'PLAN-00001', scenarios: [
    { id: 'S-01', title: 'kept', category: 'e2e', method: 'api-client', obligation: 'must-test' },
  ] }));
  assert.ok(out.plan_warnings.some((w) => /S-02.*still enforced/.test(w)));
  const progress = JSON.parse(cli(dir, ['plan', 'progress']));
  assert.ok(progress.scenarios.some((s) => s.id === 'S-02' && s.obligation === 'must-test'));
});

/* ------------------------------------------------ legitimate holds still work */

test('CONTROL: a real FAILED run with evidence satisfies the scenario -- failing is testing', () => {
  fresh('failed');
  plan([{ id: 'S-01', title: 'a', obligation: 'must-test' }]);
  realRun('S-01', { status: 'FAILED', exitCode: 1 });
  assert.equal(scenarioGap(), undefined);
});

test('CONTROL: a BLOCKED not-run linked to an open environment blocker satisfies the scenario', () => {
  fresh('env-blocked');
  plan([{ id: 'S-01', title: 'a', obligation: 'must-test' }]);
  const u = uncertainty.raise({ question: 'Staging down?', status: 'environment-unavailable', impact: 'no target', affectedScope: ['S-01'], nextAction: 'retry when staging is back' });
  execution.recordNonExecution({ goal: 'scenario a', status: 'BLOCKED', reason: 'staging returns 503 on every route', testCategory: 'e2e', planScenarioId: 'S-01', uncertainties: [u.id] });
  assert.equal(scenarioGap(), undefined);
});

test('CONTROL: a user-owned deferral backed by the user\'s recorded words satisfies the scenario', () => {
  fresh('user-defer');
  state.recordUserStatement('You have 30 minutes. Defer whatever does not fit.', { source: 'hook' });
  plan([{ id: 'S-01', title: 'a', obligation: 'must-test' }]);
  const u = uncertainty.raise({ question: 'User capped the session at 30 minutes', status: 'deferred', owner: 'user', userQuote: 'you have 30 minutes', impact: 'not reached', affectedScope: ['S-01'], nextAction: 'schedule a follow-up session' });
  execution.recordNonExecution({ goal: 'scenario a', status: 'DEFERRED', reason: 'user-imposed 30 minute budget', testCategory: 'e2e', planScenarioId: 'S-01', uncertainties: [u.id] });
  assert.equal(scenarioGap(), undefined);
});

/* ------------------------------------------------------ round two: residual gaps */

test('HOLE 13: labelling a self-deferral "owner: user" without the user\'s words does not count', () => {
  fresh('fake-owner');
  plan([{ id: 'S-01', title: 'checkout', obligation: 'must-test' }]);
  const noQuote = uncertainty.raise({ question: 'Out of time', status: 'deferred', owner: 'user', impact: 'not run', affectedScope: ['S-01'], nextAction: 'later' });
  execution.recordNonExecution({ goal: 'checkout', status: 'DEFERRED', reason: 'time', testCategory: 'e2e', planScenarioId: 'S-01', uncertainties: [noQuote.id] });
  assert.ok(scenarioGap(), 'no quote: not attributable to the user');
  const fake = uncertainty.raise({ question: 'Out of time', status: 'deferred', owner: 'user', userQuote: 'skip checkout, it is fine', impact: 'not run', affectedScope: ['S-01'], nextAction: 'later' });
  execution.recordNonExecution({ goal: 'checkout', status: 'DEFERRED', reason: 'user said skip', testCategory: 'e2e', planScenarioId: 'S-01', uncertainties: [fake.id] });
  assert.ok(scenarioGap(), 'a quote the user never said does not count');
});

test('HOLE 14: evidence from a command that runs nothing (echo PASSED, node -e 0) does not count', () => {
  fresh('trivial');
  plan([{ id: 'S-01', title: 'checkout', obligation: 'must-test' }]);
  realRun('S-01', { command: 'echo PASSED' });
  assert.ok(scenarioGap());
  realRun('S-01', { command: 'C:\\Program Files\\nodejs\\node.exe -e 0' });
  assert.ok(scenarioGap(), 'a legacy unquoted absolute path does not hide the trivial command');
  realRun('S-01', { command: 'npx playwright test e2e/checkout.spec.ts' });
  assert.equal(scenarioGap(), undefined);
});

test('isTrivialCommand: catches no-op commands and leaves real ones alone', async () => {
  const { isTrivialCommand: t } = await import('../engine/evaluation-engine/process-completeness.mjs');
  const trivial = ['echo PASSED', 'Write-Output ok', 'true', 'cmd /c echo ok', 'node -e 0', 'node -e "console.log(\'ok\')"',
    'python -c "print(1)"', '"C:\\Program Files\\nodejs\\node.exe" -e 0', 'C:\\Program Files\\nodejs\\node.exe -e 0', 'node -e "process.exit(0)"'];
  const real = ['npm test', 'npx playwright test e2e/x.spec.ts', 'node --test tests/a.test.mjs', 'curl.exe -s https://api.example.test/orders',
    'node -e "require(\'node:assert\').ok(1 + 1 === 2)"', '[script] /tmp/probe.mjs', 'C:\\Program Files\\nodejs\\node.exe tests/a.test.mjs', 'pytest -q'];
  for (const c of trivial) assert.equal(t(c), true, c);
  for (const c of real) assert.equal(t(c), false, c);
});

test('HOLE 15: an evidence record that is only the agent\'s own sentence (grade asserted) does not count', () => {
  fresh('asserted');
  plan([{ id: 'S-01', title: 'checkout', obligation: 'must-test' }]);
  const e = execution.start({ goal: 'checkout', method: 'api-client', planScenarioId: 'S-01', git: null });
  const ev = evidence.add({ kind: 'command-output', summary: 'I ran the checkout tests and they all passed', epistemicClass: 'observed', executionId: e.execution_id });
  assert.equal(ev.grade, 'asserted');
  execution.finish(e.execution_id, { status: 'FAILED', statusReason: 'one assertion failed, per my notes', evidence: [ev.evidence_id] });
  assert.ok(scenarioGap());
});

test('HOLE 16: a run of a different category linked to a scenario does not discharge it', () => {
  fresh('mismatch');
  plan([{ id: 'S-01', title: 'XSS sweep', category: 'security', obligation: 'must-test' }]);
  const e = execution.start({ goal: 'smoke', method: 'api-client', testCategory: 'smoke', planScenarioId: 'S-01', git: null });
  const ev = evidence.captureOutput({ argv: 'npm run smoke', cwd: '/repo', exitCode: 0, durationMs: 5, stdout: 'ok', summary: 'smoke', executionId: e.execution_id, git: null });
  execution.finish(e.execution_id, { status: 'PASSED', statusReason: 'smoke ok', evidence: [ev.evidence_id] });
  assert.ok(scenarioGap());
  const f = finding('scenario-category-mismatch');
  assert.ok(f);
  assert.match(f.message, /S-01 \(security\) <- .* smoke/);
});

test('a run linked to a scenario inherits the scenario\'s category and feature when it states none', () => {
  fresh('inherit');
  plan([{ id: 'S-01', title: 'XSS sweep', category: 'security', feature: 'FEAT-signup', obligation: 'must-test' }]);
  const e = execution.start({ goal: 'xss probe', method: 'api-client', planScenarioId: 'S-01', git: null });
  assert.equal(e.test_category, 'security');
  assert.equal(e.feature, 'FEAT-signup');
});

async function withRepo(fn, { gitInit = true } = {}) {
  const repo = gitInit ? tempGitRepo() : fs.mkdtempSync(path.join(os.tmpdir(), 'ast-gap-nogit-'));
  if (!gitInit) {
    fs.mkdirSync(path.join(repo, 'tests'));
    fs.writeFileSync(path.join(repo, 'tests', 'old.test.js'), 'test("old", () => {});\n');
  }
  const prev = process.cwd();
  try {
    process.chdir(repo);
    return await fn(repo);
  } finally {
    process.chdir(prev);
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

test('HOLE 17: authored tests are found by content, not mtime -- a back-dated new file is still found, a touched old one is not', async () => {
  await withRepo((repo) => {
    fresh('baseline');
    plan([{ id: 'S-01', title: 'checkout', obligation: 'must-test' }]);
    const written = path.join(repo, 'e2e', 'pay.spec.ts');
    fs.mkdirSync(path.dirname(written));
    fs.writeFileSync(written, 'test("pay", () => {});\n');
    const past = new Date('2020-01-01');
    fs.utimesSync(written, past, past);
    const old = path.join(repo, 'tests', 'old.test.js');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(old, future, future);
    realRun('S-01', { command: 'npm run lint' });
    const f = finding('authored-test-not-run');
    assert.ok(f);
    assert.match(f.message, /e2e\/pay\.spec\.ts/);
    assert.doesNotMatch(f.message, /old\.test\.js/, 'touching a file does not make it authored');
    fs.appendFileSync(old, '// edited in session\n');
    assert.match(finding('authored-test-not-run').message, /old\.test\.js/, 'changing an existing test makes it authored');
  });
});

test('HOLE 18: authored tests are found outside git too', async () => {
  await withRepo((repo) => {
    fresh('nogit');
    plan([{ id: 'S-01', title: 'checkout', obligation: 'must-test' }]);
    fs.writeFileSync(path.join(repo, 'tests', 'new_api.test.js'), 'test("x", () => {});\n');
    realRun('S-01', { command: 'npm run lint' });
    assert.match(finding('authored-test-not-run')?.message ?? '', /tests\/new_api\.test\.js/);
    realRun('S-01', { command: 'node --test tests/new_api.test.js' });
    assert.equal(finding('authored-test-not-run'), undefined);
  }, { gitInit: false });
});

test('HOLE 19: a plan that leaves out a floor category is itself a blocking gap', () => {
  fresh('plan-floor');
  state.saveApplicability({ matrix: [{ category: 'security', applicable: true, priority: 'P1', reason: 'auth present' }] });
  plan([{ id: 'S-01', title: 'checkout', obligation: 'must-test' }]);
  const f = finding('plan-misses-floor-category');
  assert.ok(f);
  assert.equal(f.severity, 'blocking');
  assert.match(f.message, /security/);
});

test('HOLE 20: a critical feature needs two committed scenarios (happy path + edge case); a high one needs one', () => {
  fresh('plan-feature');
  state.saveProfile({
    ...sampleProfile(),
    functionality_inventory: [
      { id: 'FEAT-pay', name: 'Payment', kind: 'flow', criticality: 'critical' },
      { id: 'FEAT-search', name: 'Search', kind: 'page', criticality: 'high' },
    ],
  });
  plan([
    { id: 'S-01', title: 'pay happy path', feature: 'FEAT-pay', obligation: 'must-test' },
    { id: 'S-02', title: 'search', feature: 'FEAT-search', obligation: 'must-test' },
  ]);
  const f = finding('plan-misses-feature');
  assert.ok(f);
  assert.match(f.message, /FEAT-pay \(critical: 1 of 2/);
  assert.doesNotMatch(f.message, /FEAT-search/);
  plan([{ id: 'S-03', title: 'pay with declined card', feature: 'FEAT-pay', obligation: 'must-test' }], 'PLAN-00002');
  assert.equal(finding('plan-misses-feature'), undefined, 'commitments union across plans');
});

test('HOLE 21: an applicable low-priority category cannot vanish -- it needs a run or a recorded skip', () => {
  fresh('disposition');
  state.saveApplicability({ matrix: [{ category: 'compatibility', applicable: true, priority: 'P3', reason: 'two browsers in support matrix' }] });
  const f = finding('category-disposition');
  assert.ok(f);
  assert.match(f.message, /compatibility \(P3\)/);
  execution.recordNonExecution({ goal: 'cross-browser run', status: 'SKIPPED', reason: 'P3, only one browser installed here', testCategory: 'compatibility' });
  assert.equal(finding('category-disposition'), undefined);
});

test('the report shows the plan beside what ran, and every test written this session', async () => {
  await withRepo(async (repo) => {
    fresh('report');
    const reporting = await import('../engine/reporting-engine/index.mjs');
    plan([{ id: 'S-01', title: 'checkout journey', obligation: 'must-test' }, { id: 'S-02', title: 'refund journey', obligation: 'must-test' }]);
    fs.writeFileSync(path.join(repo, 'tests', 'checkout.spec.js'), 'test("c", () => {});\n');
    realRun('S-01', { command: 'npx playwright test tests/checkout.spec.js' });
    const { report, markdown } = reporting.generate({});
    assert.equal(report.plan_progress.committed, 2);
    assert.equal(report.plan_progress.covered, 1);
    assert.match(markdown, /## Plan vs executed/);
    assert.match(markdown, /\| S-02 \| refund journey \| must-test \| e2e \| \*\*NOT RUN\*\*/);
    assert.match(markdown, /## Tests written this session/);
    assert.match(markdown, /tests\/checkout\.spec\.js \| ran/);
  });
});

test('CONTROL: a NOT_APPLICABLE not-run backed by a recorded decision discharges a scenario', () => {
  fresh('na-decision');
  plan([{ id: 'S-01', title: 'saved cards', obligation: 'must-test' }]);
  const d = decisions.record({
    question: 'Does the saved-card scenario apply to this build?',
    options: ['applies', 'not-applicable'], selected: 'not-applicable',
    reason: 'feature flag SAVED_CARDS is compiled out of this build (config/flags.ts:12)', confidence: 0.9, reversible: true,
  });
  execution.recordNonExecution({ goal: 'saved cards', status: 'NOT_APPLICABLE', reason: 'feature compiled out', testCategory: 'e2e', planScenarioId: 'S-01', decisionId: d.decision_id });
  assert.equal(scenarioGap(), undefined);
});
