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
import * as decisions from '../engine/decision-engine/index.mjs';
import * as uncertainty from '../engine/uncertainty-register/index.mjs';
import * as evidence from '../engine/evidence-engine/index.mjs';
import { check as checkCompleteness } from '../engine/evaluation-engine/process-completeness.mjs';

/**
 * `ast validate` checks schemas and referential integrity. Neither says anything about
 * whether the PROCESS the orchestrator's skill describes actually happened: a session can
 * run real executions, record zero decisions, and leave blocked work unraised as an
 * uncertainty, and validate said "No problems found." A field trial did exactly this and
 * confessed to it only in a hand-written appendix nothing in the tool's own output echoed.
 *
 * These tests cover `process-completeness.check()` directly (in-process -- it is a pure
 * function over state) plus `ast validate [--final]`'s promotion of "blocking" findings
 * (subprocess -- that merge logic lives in bin/ast.mjs, not in any importable engine).
 */
const tmp = useTempState('process-completeness');
test.after(() => tmp.cleanup());
// One session, built up sequentially by the tests below (each depends on state the
// previous one left behind, matching how a real session accumulates) -- node:test runs
// top-level tests in declaration order within a file, which this relies on.
state.startSession({ request: 'process-completeness in-process test session' });

function openRealExecution(goal = 'typecheck') {
  // git: null, explicitly -- this whole file's fixture is meant to stay git-less until
  // "an execution carrying a real commit clears the no-git-provenance finding" adds the
  // first one. Without this, git auto-capture (now real) would silently inherit this
  // actual repository's git info onto every execution the fixture creates, since none of
  // them would be explicitly opting out.
  return execution.start({ goal, method: 'static-analysis', testCategory: 'sanity', git: null });
}

test('a session with no real executions at all raises no findings -- nothing has happened yet to be incomplete', () => {
  const findings = checkCompleteness();
  assert.deepEqual(findings, []);
});

test('a "not-executed" record (BLOCKED/SKIPPED placeholder) alone does not trigger the no-decisions check', () => {
  execution.recordNonExecution({ goal: 'Load test', status: 'DEFERRED', reason: 'no isolated environment' });
  const findings = checkCompleteness();
  assert.equal(findings.find((f) => f.check === 'no-decisions'), undefined,
    'a record that only documents work which never ran is not "real work with no decision behind it"');
});

test('a real execution with zero decision records is a blocking finding', () => {
  const exec = openRealExecution();
  execution.finish(exec.execution_id, { status: 'PARTIAL', statusReason: 'still running' });
  const findings = checkCompleteness();
  const f = findings.find((c) => c.check === 'no-decisions');
  assert.ok(f, 'expected a no-decisions finding');
  assert.equal(f.severity, 'blocking');
  assert.match(f.message, /cannot be reconstructed/);
});

test('recording a decision clears the no-decisions finding', () => {
  decisions.record({
    question: 'Which browser method?',
    options: ['playwright-script', 'playwright-mcp'],
    selected: 'playwright-script',
    reason: 'deterministic and produces a regression asset',
    confidence: 0.8,
    reversible: true,
  });
  const findings = checkCompleteness();
  assert.equal(findings.find((f) => f.check === 'no-decisions'), undefined);
});

test('a BLOCKED execution with no uncertainty raised is a blocking finding naming the execution', () => {
  const blocked = execution.start({ goal: 'Live payment E2E', method: 'playwright-script', testCategory: 'e2e', git: null });
  execution.finish(blocked.execution_id, { status: 'BLOCKED', statusReason: 'no sandbox credentials' });
  const findings = checkCompleteness();
  const f = findings.find((c) => c.check === 'blocked-without-uncertainty');
  assert.ok(f, 'expected a blocked-without-uncertainty finding');
  assert.equal(f.severity, 'blocking');
  assert.match(f.message, new RegExp(blocked.execution_id));
});

test('raising the uncertainty clears the blocked-without-uncertainty finding', () => {
  uncertainty.raise({
    question: 'Should payment tests use real provider credentials?',
    status: 'user-input-required',
    owner: 'user',
    impact: 'cannot safely execute a real transaction',
    affectedScope: ['payment-e2e'],
    nextAction: 'ask the user which environment and credentials to use',
  });
  const findings = checkCompleteness();
  assert.equal(findings.find((f) => f.check === 'blocked-without-uncertainty'), undefined);
});

test('no execution carries a commit is an advisory finding, never blocking -- there is no auto-capture path yet to hold sessions to', () => {
  const findings = checkCompleteness();
  const f = findings.find((c) => c.check === 'no-git-provenance');
  assert.ok(f, 'expected a no-git-provenance finding');
  assert.equal(f.severity, 'advisory');
});

test('an execution carrying a real commit clears the no-git-provenance finding', () => {
  const withGit = execution.start({
    goal: 'build', method: 'static-analysis',
    git: { repository: 'demo', branch: 'main', commit: 'abc1234' },
  });
  execution.finish(withGit.execution_id, { status: 'PASSED', statusReason: 'build ok' });
  const findings = checkCompleteness();
  assert.equal(findings.find((f) => f.check === 'no-git-provenance'), undefined);
});

test('a fully-compliant session (decisions recorded and assessed, no blocked work, commit present) raises nothing at all', () => {
  // Guards against a check that fires unconditionally regardless of what actually happened.
  // "Compliant" includes assessing at least one decision (0.11.0's no-decision-assessed).
  for (const d of state.list('decisions')) decisions.assess(d.decision_id, { verdict: 'correct' });
  // Compliance also means: the plan was persisted and its must-test scenario ran with evidence;
  // every floor category was addressed ('sanity' ran with evidence, 'e2e' is held by an open
  // user-owned blocker, linked). With all of that true, nothing fires.
  const payment = state.list('uncertainties').find((u) => /payment/.test(u.question));
  state.savePlan({
    plan_id: 'PLAN-00001', created_at: new Date().toISOString(), objective: 'Compliant session fixture',
    scope: { in_scope: ['sanity', 'payments'], out_of_scope: [] },
    applicability: [{ category: 'sanity', applicable: true, reason: 'always applicable' }],
    scenarios: [
      { id: 'S-01', title: 'sanity sweep', category: 'sanity', method: 'static-analysis', obligation: 'must-test' },
      { id: 'S-02', title: 'live payment e2e', category: 'e2e', method: 'playwright-script', obligation: 'blocked', blocked_by: payment.id },
    ],
    exit_criteria: ['S-01 ran'],
    provenance: { skill_version: '0.12.0', created_at: new Date().toISOString(), created_by: 'agent' },
  });
  const run = execution.start({ goal: 'sanity sweep', method: 'static-analysis', testCategory: 'sanity', planScenarioId: 'S-01', git: { repository: 'demo', branch: 'main', commit: 'abc1234' } });
  const ev = evidence.captureOutput({ argv: 'npm run lint', cwd: '/repo', exitCode: 0, durationMs: 5, stdout: 'ok', summary: 'lint', executionId: run.execution_id, git: null });
  execution.finish(run.execution_id, { status: 'PASSED', statusReason: 'lint exited 0 at abc1234', evidence: [ev.evidence_id] });
  execution.recordNonExecution({ goal: 'Live payment E2E', status: 'BLOCKED', reason: 'no sandbox credentials', testCategory: 'e2e', planScenarioId: 'S-02', uncertainties: [payment.id] });
  state.saveApplicability({ matrix: [
    { category: 'sanity', applicable: true, priority: 'P0' },
    { category: 'e2e', applicable: true, priority: 'P1' },
  ] });
  const findings = checkCompleteness();
  assert.deepEqual(findings, []);
});

/* ------------------------------------------------------------- coverage floor */

test('coverage floor: an applicable P0/P1 category with no execution of any kind is a blocking finding', () => {
  state.saveApplicability({ matrix: [{ category: 'load', applicable: true, priority: 'P0' }] });
  const findings = checkCompleteness();
  const f = findings.find((c) => c.check === 'coverage-floor');
  assert.ok(f, 'expected a coverage-floor finding');
  assert.equal(f.severity, 'blocking');
  assert.match(f.message, /load \(P0\)/);
});

test('coverage floor: a lower-priority (P2/P3) applicable category never bites', () => {
  state.saveApplicability({ matrix: [{ category: 'load', applicable: true, priority: 'P2' }] });
  assert.equal(checkCompleteness().find((c) => c.check === 'coverage-floor'), undefined);
});

test('coverage floor: a DEFERRED not-run with no linked uncertainty does NOT satisfy the floor', () => {
  // An open uncertainty exists elsewhere in this session, but this record links none --
  // "some uncertainty exists" is not "this gap is justified".
  execution.recordNonExecution({ goal: 'Load test', status: 'DEFERRED', reason: 'later', testCategory: 'load' });
  state.saveApplicability({ matrix: [{ category: 'load', applicable: true, priority: 'P0' }] });
  const f = checkCompleteness().find((c) => c.check === 'coverage-floor');
  assert.ok(f, 'an unlinked not-run must not count as coverage');
  assert.match(f.message, /load \(P0\)/);
});

test('coverage floor: an explicit not-run BLOCKED record that links its uncertainty satisfies the floor', () => {
  const u = uncertainty.raise({
    question: 'Is there an isolated environment for load tests?',
    status: 'environment-unavailable',
    impact: 'load traffic cannot be pointed at shared infrastructure',
    affectedScope: ['load'],
    nextAction: 'ask the owner for an isolated environment',
  });
  execution.recordNonExecution({ goal: 'Load test', status: 'BLOCKED', reason: 'no isolated environment', testCategory: 'load', uncertainties: [u.id] });
  state.saveApplicability({ matrix: [{ category: 'load', applicable: true, priority: 'P0' }] });
  assert.equal(checkCompleteness().find((c) => c.check === 'coverage-floor'), undefined);
});

test('coverage floor: an applicable mandatory baseline is enforced even at P3', () => {
  state.saveApplicability({ matrix: [{ category: 'perf-baseline', applicable: true, priority: 'P3' }] });
  const f = checkCompleteness().find((c) => c.check === 'coverage-floor');
  assert.ok(f, 'perf-baseline is a mandatory baseline: low priority does not exempt it');
  assert.match(f.message, /perf-baseline \(mandatory baseline, P3\)/);
});

test('coverage floor: a mandatory baseline that is NOT applicable is not demanded', () => {
  state.saveApplicability({ matrix: [{ category: 'perf-baseline', applicable: false, priority: 'P3' }] });
  assert.equal(checkCompleteness().find((c) => c.check === 'coverage-floor'), undefined);
});

test('coverage floor: a real run of any outcome counts as coverage -- a FAILED run with evidence is still testing', () => {
  const run = execution.start({ goal: 'regression suite', method: 'existing-suite', testCategory: 'regression', git: null });
  const ev = evidence.captureOutput({ argv: 'npm test', cwd: '/repo', exitCode: 1, durationMs: 5, stdout: '3 failed', summary: 'suite', executionId: run.execution_id, git: null });
  execution.finish(run.execution_id, { status: 'FAILED', statusReason: '3 tests failed', evidence: [ev.evidence_id] });
  state.saveApplicability({ matrix: [{ category: 'regression', applicable: true, priority: 'P0' }] });
  assert.equal(checkCompleteness().find((c) => c.check === 'coverage-floor'), undefined);
});

test('coverage floor: a run that left no evidence (the early PARTIAL "typecheck") does not count', () => {
  state.saveApplicability({ matrix: [{ category: 'sanity', applicable: true, priority: 'P0' }] });
  const before = state.list('executions').filter((e) => e.test_category === 'sanity');
  assert.ok(before.some((e) => (e.evidence ?? []).length === 0), 'fixture: an evidence-less sanity run exists');
  // The compliant-session test above added an evidenced sanity run, so the category IS covered --
  // by that run, not by the evidence-less one.
  assert.equal(checkCompleteness().find((c) => c.check === 'coverage-floor'), undefined);
});

/* -------------------------------------------------------- per-feature floor */

test('missing inventory: a profile with no feature surface (no UI, API or critical component) is not asked for one', () => {
  state.saveApplicability({ matrix: [] });
  state.saveProfile({
    ...sampleProfile(),
    architecture: { frontend: { present: false } },
    apis: [],
    critical_components: [],
  });
  assert.equal(checkCompleteness().find((c) => c.check === 'no-functionality-inventory'), undefined);
});

test('missing inventory: a profile showing a UI/API but no functionality_inventory is a blocking finding -- skipping the inventory no longer skips the floor', () => {
  // sampleProfile() has a frontend, a REST API and a critical checkout component, and no inventory.
  state.saveProfile(sampleProfile());
  const f = checkCompleteness().find((c) => c.check === 'no-functionality-inventory');
  assert.ok(f, 'expected a no-functionality-inventory finding');
  assert.equal(f.severity, 'blocking');
});

test('per-feature floor: a high/critical inventory feature with no tagged execution is a blocking finding; a low one is exempt', () => {
  // Neutralise the category floor so only the feature floor is under test.
  state.saveApplicability({ matrix: [] });
  state.saveProfile({ ...sampleProfile(), functionality_inventory: [
    { id: 'FEAT-login', name: 'Login', kind: 'flow', criticality: 'critical' },
    { id: 'FEAT-help', name: 'Help page', kind: 'page', criticality: 'low' },
  ] });
  const all = checkCompleteness();
  assert.equal(all.find((c) => c.check === 'no-functionality-inventory'), undefined, 'an inventory now exists');
  const f = all.find((c) => c.check === 'feature-coverage-floor');
  assert.ok(f, 'expected a feature-coverage-floor finding');
  assert.equal(f.severity, 'blocking');
  assert.match(f.message, /FEAT-login \(Login\)/);
  assert.doesNotMatch(f.message, /FEAT-help/, 'a low-criticality feature is not demanded by the floor');
});

test('per-feature floor: an execution tagged with the feature id satisfies it', () => {
  const exec = execution.start({ goal: 'Login happy path', method: 'playwright-script', testCategory: 'e2e', feature: 'FEAT-login', git: null });
  const ev = evidence.captureOutput({ argv: 'npx playwright test login', cwd: '/repo', exitCode: 0, durationMs: 5, stdout: '1 passed', summary: 'login', executionId: exec.execution_id, git: null });
  execution.finish(exec.execution_id, { status: 'PASSED', statusReason: 'login spec passed', evidence: [ev.evidence_id] });
  assert.equal(checkCompleteness().find((c) => c.check === 'feature-coverage-floor'), undefined);
});

/* --------------------------------------------------- CLI: ast validate [--final] */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST = path.join(ROOT, 'bin', 'ast.mjs');

function freshState(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ast-validate-${label}-`));
}

function ast(args, stateDir) {
  return execFileSync(process.execPath, [AST, '--state', stateDir, ...args], { encoding: 'utf8', timeout: 15_000 });
}

function astInput(args, payload, stateDir) {
  const file = path.join(stateDir, `input-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  return ast([...args, '--input', file], stateDir);
}

function cliPlan(dir, scenarios) {
  return astInput(['plan', 'save'], {
    plan_id: 'PLAN-00001',
    created_at: '2026-10-08T10:00:00.000Z',
    objective: 'CLI fixture plan',
    scope: { in_scope: ['fixture'], out_of_scope: [] },
    applicability: [{ category: 'e2e', applicable: true, reason: 'fixture category' }],
    scenarios: scenarios.map((s) => ({ category: 'e2e', method: 'api-client', obligation: 'must-test', ...s })),
    exit_criteria: ['All must-test scenarios run'],
    provenance: { skill_version: '0.12.0', created_at: '2026-10-08T10:00:00.000Z', created_by: 'agent' },
  }, dir);
}

/** exec start + a real captured command + exec finish, all through the CLI. */
function cliEvidencedRun(dir, startPayload, status = 'PASSED') {
  const ex = JSON.parse(astInput(['exec', 'start'], { git: null, ...startPayload }, dir));
  const ev = JSON.parse(ast(['evidence', 'capture', '--exec', ex.execution_id, '--summary', 'fixture run', '--', process.execPath, '-e', "require('node:assert').ok(1 + 1 === 2)"], dir));
  astInput(['exec', 'finish', ex.execution_id], { status, statusReason: 'fixture command exited 0', evidence: [ev.evidence_id] }, dir);
  return ex.execution_id;
}

/** `applicability eval` with no signals still finds a few P3 categories; give each a visible disposition. */
function cliMatrixWithDispositions(dir) {
  const m = JSON.parse(astInput(['applicability', 'eval'], { signals: [] }, dir));
  for (const r of (m.matrix ?? []).filter((x) => x.applicable)) {
    astInput(['exec', 'not-run'], { goal: `${r.category} testing`, status: 'SKIPPED', reason: `${r.priority}, out of scope for this fixture`, testCategory: r.category }, dir);
  }
}

test('CLI: "ast validate" reports a blocking process gap as a warning and stays valid: true', () => {
  const dir = freshState('warn');
  ast(['session', 'start', '--request', 'x'], dir);
  const execOut = JSON.parse(astInput(['exec', 'start'], { goal: 'smoke', method: 'static-analysis' }, dir));
  // Finished, not left open -- an open execution fails validate on its own (a real,
  // separate, unrelated check), which would make this test pass for the wrong reason.
  astInput(['exec', 'finish', execOut.execution_id], { status: 'PASSED', statusReason: 'ok' }, dir);
  const out = JSON.parse(ast(['validate'], dir));
  assert.equal(out.valid, true);
  assert.ok(out.warnings.some((w) => /no-decisions|No decision records/.test(w)));
});

test('CLI: "ast validate --final" promotes the same gap to a failure', () => {
  const dir = freshState('promote');
  ast(['session', 'start', '--request', 'x'], dir);
  // Persist a matrix with nothing the floor enforces, so the only gap under test is no-decisions.
  astInput(['applicability', 'eval'], { signals: [] }, dir);
  const execOut = JSON.parse(astInput(['exec', 'start'], { goal: 'smoke', method: 'static-analysis' }, dir));
  astInput(['exec', 'finish', execOut.execution_id], { status: 'PASSED', statusReason: 'ok' }, dir);
  let out;
  let threw = false;
  try {
    ast(['validate', '--final'], dir);
  } catch (err) {
    threw = true;
    assert.equal(err.status, 1);
    out = JSON.parse(err.stdout);
  }
  assert.ok(threw, '--final must exit non-zero when a blocking process gap exists');
  assert.equal(out.valid, false);
  // Confirms failure comes from the process gap specifically, not from some other,
  // unrelated validate problem coincidentally also being true.
  assert.ok(out.problems.every((p) => p.startsWith('process:')), out.problems.join('\n'));
  assert.ok(out.problems.some((p) => /No decision records/.test(p)));
});

test('CLI: "ast validate --final" fails when an applicable high-priority category never ran (coverage floor end-to-end)', () => {
  const dir = freshState('floor');
  ast(['session', 'start', '--request', 'test the API'], dir);
  // `applicability eval` auto-persists the matrix. A real risk assessment plus "none" coverage
  // lifts at least one category (unit) to P0, so the floor has real teeth here.
  astInput(['applicability', 'eval'], {
    signals: ['http-api'],
    coverage: { api: 'none' },
    riskAssessment: {
      risk_score: 0.9, confidence: 1, confidence_band: 'high',
      factors: [{ factor: 'coverage_deficit', contribution: 0.3 }, { factor: 'integration_complexity', contribution: 0.3 }],
    },
  }, dir);
  // Do real, decided work in a DIFFERENT category, so the ONLY thing wrong is the unrun floor.
  const execOut = JSON.parse(astInput(['exec', 'start'], { goal: 'smoke', method: 'static-analysis', testCategory: 'smoke', git: null }, dir));
  astInput(['decide'], {
    question: 'How deep?', options: ['shallow', 'deep'], selected: 'shallow', reason: 'time-boxed', confidence: 0.7, reversible: true,
  }, dir);
  astInput(['exec', 'finish', execOut.execution_id], { status: 'PASSED', statusReason: 'ok' }, dir);

  let out;
  let threw = false;
  try {
    ast(['validate', '--final'], dir);
  } catch (err) {
    threw = true;
    assert.equal(err.status, 1);
    out = JSON.parse(err.stdout);
  }
  assert.ok(threw, '--final must exit non-zero when an applicable high-priority category never ran');
  assert.equal(out.valid, false);
  assert.ok(out.problems.some((p) => /no qualifying execution/i.test(p)),
    'the failure must name the coverage floor');
});

test('CLI: "ast validate --final" fails when a critical inventory feature was never tested (per-feature floor end-to-end)', () => {
  const dir = freshState('feature-floor');
  ast(['session', 'start', '--request', 'test the app'], dir);
  astInput(['profile', 'save'], {
    ...sampleProfile(),
    functionality_inventory: [{ id: 'FEAT-checkout', name: 'Checkout', kind: 'flow', criticality: 'critical' }],
  }, dir);
  // Decided, real work that is NOT the critical feature, so only the per-feature floor is at stake.
  const execOut = JSON.parse(astInput(['exec', 'start'], { goal: 'smoke', method: 'static-analysis', testCategory: 'smoke', feature: 'FEAT-other', git: null }, dir));
  astInput(['decide'], {
    question: 'How deep?', options: ['shallow', 'deep'], selected: 'shallow', reason: 'time-boxed', confidence: 0.7, reversible: true,
  }, dir);
  astInput(['exec', 'finish', execOut.execution_id], { status: 'PASSED', statusReason: 'ok' }, dir);

  let out;
  let threw = false;
  try {
    ast(['validate', '--final'], dir);
  } catch (err) {
    threw = true;
    out = JSON.parse(err.stdout);
  }
  assert.ok(threw, '--final must fail when a critical feature was never tested');
  assert.ok(out.problems.some((p) => /FEAT-checkout|functionality inventory/i.test(p)),
    'the failure must name the untested feature');
});

test('CLI: "ast validate --final" fails when real work ran but no applicability matrix was ever persisted', () => {
  const dir = freshState('no-matrix');
  ast(['session', 'start', '--request', 'x'], dir);
  const execOut = JSON.parse(astInput(['exec', 'start'], { goal: 'smoke', method: 'static-analysis', git: null }, dir));
  astInput(['decide'], {
    question: 'How deep?', options: ['shallow', 'deep'], selected: 'shallow', reason: 'time-boxed', confidence: 0.7, reversible: true,
  }, dir);
  astInput(['exec', 'finish', execOut.execution_id], { status: 'PASSED', statusReason: 'ok' }, dir);
  // Mid-session it is only a warning...
  const mid = JSON.parse(ast(['validate'], dir));
  assert.equal(mid.valid, true);
  assert.ok(mid.warnings.some((w) => /No applicability matrix is persisted/.test(w)));
  // ...but skipping `applicability eval` must not silence the floor at the finish line.
  let out;
  let threw = false;
  try {
    ast(['validate', '--final'], dir);
  } catch (err) {
    threw = true;
    out = JSON.parse(err.stdout);
  }
  assert.ok(threw, '--final must fail when the coverage floor could never be checked');
  assert.ok(out.problems.some((p) => /No applicability matrix is persisted/.test(p)));
});

test('CLI: "ast validate --final" fails on a UI/API profile with no inventory even before anything ran', () => {
  const dir = freshState('inventory-first');
  ast(['session', 'start', '--request', 'x'], dir);
  astInput(['profile', 'save'], sampleProfile(), dir);
  let out;
  let threw = false;
  try {
    ast(['validate', '--final'], dir);
  } catch (err) {
    threw = true;
    out = JSON.parse(err.stdout);
  }
  assert.ok(threw, 'a feature surface with no inventory is a gap whether or not anything has executed');
  assert.ok(out.problems.some((p) => /functionality_inventory/.test(p)));
});

test('CLI: "ast validate --final" never promotes the advisory-only no-git-provenance finding', () => {
  const dir = freshState('git-advisory');
  ast(['session', 'start', '--request', 'x'], dir);
  // Persist a matrix with nothing the floor enforces, so no blocking gap competes with the advisory.
  cliMatrixWithDispositions(dir);
  // git: null, explicitly -- git is now auto-captured from this real repo checkout by
  // default (this test's whole point), so simulating "testing a target with no git
  // provenance" requires opting out explicitly rather than simply omitting the field.
  astInput(['decide'], {
    question: 'How deep should this pass go?', options: ['shallow', 'deep'], selected: 'shallow',
    reason: 'time-boxed', confidence: 0.7, reversible: true,
  }, dir);
  cliPlan(dir, [{ id: 'S-01', title: 'smoke' }]);
  cliEvidencedRun(dir, { goal: 'smoke', method: 'static-analysis', plan_scenario_id: 'S-01' });

  const out = JSON.parse(ast(['validate', '--final'], dir));
  assert.equal(out.valid, true, 'no-git-provenance alone must never fail --final');
  assert.ok(out.warnings.some((w) => /no-git-provenance|Nothing in this session is reproducible/.test(w)));
});

/* -------------------------------------------------- scenario coverage floor */

test('scenario floor: must-test scenarios with no linked execution are a blocking finding', () => {
  // Use a fresh state scope for plan tests — the in-process state accumulated above
  // has no plan, so we need a clean slate.
  const dir = freshState('scenario-floor');
  ast(['session', 'start', '--request', 'test the VMS'], dir);
  astInput(['applicability', 'eval'], { signals: [] }, dir);
  astInput(['decide'], {
    question: 'How deep should testing go?', options: ['standard', 'deep'], selected: 'standard',
    reason: 'time-boxed', confidence: 0.8, reversible: true,
  }, dir);
  // Save a plan with 3 must-test and 1 should-test scenario.
  astInput(['plan', 'save'], {
    plan_id: 'PLAN-00001',
    created_at: '2026-10-08T10:00:00.000Z',
    objective: 'Test the VMS end to end',
    scope: { in_scope: ['visitor CRUD'], out_of_scope: ['billing'] },
    applicability: [{ category: 'e2e', applicable: true, reason: 'multi-role system with handoff points', priority: 'P0' }],
    scenarios: [
      { id: 'S-01', title: 'Host creates invite', category: 'e2e', obligation: 'must-test', method: 'api-client' },
      { id: 'S-02', title: 'Guard approves visitor', category: 'e2e', obligation: 'must-test', method: 'api-client' },
      { id: 'S-03', title: 'XSS on name field', category: 'security', obligation: 'must-test', method: 'api-client' },
      { id: 'S-04', title: 'Load test check-in', category: 'load', obligation: 'should-test', method: 'load-tool' },
    ],
    exit_criteria: ['All must-test scenarios run'],
    provenance: { skill_version: '0.13.0', created_at: '2026-10-08T10:00:00.000Z', created_by: 'agent' },
  }, dir);
  // Run only scenario S-01, leaving S-02 and S-03 unrun.
  cliEvidencedRun(dir, { goal: 'Host creates invite', method: 'api-client', testCategory: 'e2e', plan_scenario_id: 'S-01' });

  let out;
  let threw = false;
  try { ast(['validate', '--final'], dir); } catch (err) {
    threw = true;
    out = JSON.parse(err.stdout);
  }
  assert.ok(threw, '--final must fail when must-test scenarios were not executed');
  assert.ok(out.problems.some((p) => /scenario-coverage-floor|must-test scenario/i.test(p)));
  // S-02 and S-03 should be named in the message, but S-04 (should-test) should not.
  const msg = out.problems.find((p) => /scenario-coverage-floor|must-test scenario/i.test(p));
  assert.match(msg, /S-02/);
  assert.match(msg, /S-03/);
  assert.doesNotMatch(msg, /S-01/, 'S-01 ran with evidence');
  assert.doesNotMatch(msg, /S-04/, 'should-test scenarios are not enforced by the floor');
});

test('scenario floor: a BLOCKED not-run linked to an uncertainty satisfies a must-test scenario', () => {
  const dir = freshState('scenario-blocked');
  ast(['session', 'start', '--request', 'test'], dir);
  cliMatrixWithDispositions(dir);
  astInput(['decide'], {
    question: 'How deep should testing go?', options: ['standard', 'deep'], selected: 'standard', reason: 'time-boxed', confidence: 0.8, reversible: true,
  }, dir);
  astInput(['plan', 'save'], {
    plan_id: 'PLAN-00001',
    created_at: '2026-10-08T10:00:00.000Z',
    objective: 'Test security probes',
    scope: { in_scope: ['auth'], out_of_scope: [] },
    applicability: [{ category: 'security', applicable: true, reason: 'auth and user-input signals present', priority: 'P1' }],
    scenarios: [
      { id: 'S-01', title: 'XSS probe', category: 'security', obligation: 'must-test', method: 'api-client' },
    ],
    exit_criteria: ['All run'],
    provenance: { skill_version: '0.13.0', created_at: '2026-10-08T10:00:00.000Z', created_by: 'agent' },
  }, dir);
  // Raise an uncertainty and record the scenario as BLOCKED with a link.
  const uOut = JSON.parse(astInput(['uncertainty', 'raise'], {
    question: 'No non-prod environment for security probes',
    status: 'environment-unavailable',
    impact: 'cannot probe', affectedScope: ['security'], nextAction: 'ask user',
  }, dir));
  astInput(['exec', 'not-run'], {
    goal: 'XSS probe', status: 'BLOCKED', reason: 'no non-prod environment',
    testCategory: 'security', plan_scenario_id: 'S-01', uncertainties: [uOut.id],
  }, dir);

  const out = JSON.parse(ast(['validate', '--final'], dir));
  assert.equal(out.valid, true, 'a justified BLOCKED not-run should satisfy the scenario floor');
  assert.ok(!out.problems.some((p) => /scenario-coverage-floor/i.test(p)));
});

test('scenario floor: plan progress command shows executed vs remaining', () => {
  const dir = freshState('plan-progress');
  ast(['session', 'start', '--request', 'test'], dir);
  astInput(['plan', 'save'], {
    plan_id: 'PLAN-00001',
    created_at: '2026-10-08T10:00:00.000Z',
    objective: 'Test two things',
    scope: { in_scope: ['a', 'b'], out_of_scope: [] },
    applicability: [{ category: 'e2e', applicable: true, reason: 'multi-role user paths present', priority: 'P0' }],
    scenarios: [
      { id: 'S-01', title: 'Thing A', category: 'e2e', obligation: 'must-test', method: 'api-client' },
      { id: 'S-02', title: 'Thing B', category: 'e2e', obligation: 'must-test', method: 'api-client' },
    ],
    exit_criteria: ['Both run'],
    provenance: { skill_version: '0.13.0', created_at: '2026-10-08T10:00:00.000Z', created_by: 'agent' },
  }, dir);
  // Run only S-01.
  cliEvidencedRun(dir, { goal: 'Thing A', method: 'api-client', testCategory: 'e2e', plan_scenario_id: 'S-01' });

  const progress = JSON.parse(ast(['plan', 'progress'], dir));
  assert.equal(progress.must_test, 2);
  assert.equal(progress.must_test_executed, 1);
  assert.equal(progress.must_test_remaining, 1);
  const s2 = progress.scenarios.find((s) => s.id === 'S-02');
  assert.equal(s2.executed, false);
  assert.equal(s2.obligation, 'must-test');
});
