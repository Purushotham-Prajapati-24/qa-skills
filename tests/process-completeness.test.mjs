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
  // Compliance now also means the applicability matrix was persisted and its high-priority
  // categories were all addressed: 'sanity' ran above, 'e2e' is BLOCKED with its uncertainty
  // raised. With the matrix present and the floor met, nothing fires.
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

test('coverage floor: an explicit not-run BLOCKED record satisfies the floor for that category', () => {
  execution.recordNonExecution({ goal: 'Load test', status: 'BLOCKED', reason: 'no isolated environment', testCategory: 'load' });
  state.saveApplicability({ matrix: [{ category: 'load', applicable: true, priority: 'P0' }] });
  // The blocked not-run counts as coverage; the matching uncertainty raised earlier keeps the
  // blocked-without-uncertainty check quiet too, so the floor is genuinely satisfied.
  assert.equal(checkCompleteness().find((c) => c.check === 'coverage-floor'), undefined);
});

test('coverage floor: a real run of any outcome counts as coverage -- a FAILED or PARTIAL run is still testing', () => {
  // 'sanity' ran (PARTIAL) far above. That it did not PASS does not make the category untested.
  state.saveApplicability({ matrix: [{ category: 'sanity', applicable: true, priority: 'P0' }] });
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
  execution.finish(exec.execution_id, { status: 'PASSED', statusReason: 'login works' });
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
  assert.equal(out.problems.length, 1);
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
  assert.ok(out.problems.some((p) => /coverage floor|no execution of any kind/i.test(p)),
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

test('CLI: "ast validate --final" never promotes the advisory-only no-git-provenance finding', () => {
  const dir = freshState('git-advisory');
  ast(['session', 'start', '--request', 'x'], dir);
  // git: null, explicitly -- git is now auto-captured from this real repo checkout by
  // default (this test's whole point), so simulating "testing a target with no git
  // provenance" requires opting out explicitly rather than simply omitting the field.
  const execOut = JSON.parse(astInput(['exec', 'start'], { goal: 'smoke', method: 'static-analysis', git: null }, dir));
  astInput(['decide'], {
    question: 'How deep should this pass go?', options: ['shallow', 'deep'], selected: 'shallow',
    reason: 'time-boxed', confidence: 0.7, reversible: true,
  }, dir);
  astInput(['exec', 'finish', execOut.execution_id], { status: 'PASSED', statusReason: 'ok' }, dir);

  const out = JSON.parse(ast(['validate', '--final'], dir));
  assert.equal(out.valid, true, 'no-git-provenance alone must never fail --final');
  assert.ok(out.warnings.some((w) => /no-git-provenance|Nothing in this session is reproducible/.test(w)));
});
