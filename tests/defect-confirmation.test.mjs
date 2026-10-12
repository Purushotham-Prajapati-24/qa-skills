import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { useTempState, confirmWithRepro } from './helpers.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as execution from '../engine/execution-engine/index.mjs';
import * as evidence from '../engine/evidence-engine/index.mjs';
import * as defects from '../engine/defect-engine/index.mjs';
import * as uncertainty from '../engine/uncertainty-register/index.mjs';
import { classify } from '../engine/failure-classifier/index.mjs';
import { check, findingVerifier } from '../engine/evaluation-engine/process-completeness.mjs';

/**
 * A defect claim is proven by an executable check that fails today on the assertion encoding
 * the bug -- the rule tester-army/e2e's bug bash describes in prose, enforced here in code.
 */

const created = [];
test.after(() => created.forEach((t) => t.cleanup()));

function fresh(label) {
  const t = useTempState(`confirm-${label}`);
  created.push(t);
  state.startSession({ request: `defect confirmation: ${label}`, git: null });
  return t;
}

function candidate(overrides = {}) {
  return defects.create({
    title: overrides.title ?? `Order total ignores the discount code ${Math.random()}`,
    kind: 'defect', severity: 'major', confidence: 0.8, epistemicClass: 'observed',
    component: `checkout-${Math.random()}`,
    reproduction: { expected: 'total reduced by 10%', actual: 'full price charged', reproducible: 'always', attempts: 2 },
    ...overrides,
  });
}

function reproRun(findingId, { status = 'FAILED', exitCode = 1, signals = ['assertion-mismatch'], command = 'npx playwright test tests/bugbash/discount.spec.ts' } = {}) {
  const e = execution.start({ goal: `repro ${findingId}`, method: 'playwright-script', reproduces: findingId, command, git: null });
  const ev = evidence.captureOutput({ argv: command, cwd: '/repo', exitCode, durationMs: 5, stdout: exitCode ? '1 failed' : '1 passed', summary: 'repro', executionId: e.execution_id, git: null });
  return execution.finish(e.execution_id, { status, statusReason: 'repro ran against the live app', evidence: [ev.evidence_id], signals }).record;
}

const gate = (name = 'unconfirmed-defect') => check().find((f) => f.check === name);
const status = (id) => findingVerifier()(state.get('findings', id)).status;

test('a serious defect claim with no repro is unverified and blocks --final; a minor one is only advisory', () => {
  fresh('unverified');
  const major = candidate();
  const minor = candidate({ severity: 'minor' });
  assert.equal(status(major.finding_id), 'unverified');
  const g = gate();
  assert.ok(g);
  assert.equal(g.severity, 'blocking');
  assert.match(g.message, new RegExp(major.finding_id));
  assert.doesNotMatch(g.message, new RegExp(minor.finding_id));
  assert.equal(gate('unconfirmed-minor-defect').severity, 'advisory');
});

test('a repro that FAILED on an assertion with a captured non-zero exit confirms the finding', () => {
  fresh('confirmed');
  const f = candidate();
  const run = reproRun(f.finding_id);
  assert.equal(run.failure_classification.class, 'product-defect');
  const v = findingVerifier()(state.get('findings', f.finding_id));
  assert.equal(v.status, 'confirmed');
  assert.equal(v.execution_id, run.execution_id);
  assert.match(v.repro, /discount\.spec\.ts/);
  assert.equal(gate(), undefined);
});

test('a repro that failed on a locator timeout is a broken test, not a confirmed bug', () => {
  fresh('timeout');
  const f = candidate();
  reproRun(f.finding_id, { signals: ['element-not-found-after-wait'] });
  const v = findingVerifier()(state.get('findings', f.finding_id));
  assert.equal(v.status, 'unverified');
  assert.match(v.reason, /classified timeout, not product-defect/);
});

test('a "repro" whose only evidence is echo FAILED confirms nothing', () => {
  fresh('trivial');
  const f = candidate();
  reproRun(f.finding_id, { command: 'echo FAILED' });
  assert.equal(status(f.finding_id), 'unverified');
});

test('a repro that PASSED refutes the claim and the gate says to reject it', () => {
  fresh('refuted');
  const f = candidate();
  reproRun(f.finding_id, { status: 'PASSED', exitCode: 0, signals: [] });
  assert.equal(status(f.finding_id), 'refuted');
  assert.match(check().find((c) => c.check === 'unconfirmed-defect').items[0].next, /finding reject .* --class not-reproduced/);
});

test('a repro held on a real blocker satisfies the gate; one held on the agent\'s own deferral does not', () => {
  fresh('held');
  const f = candidate();
  const own = uncertainty.raise({ question: 'Run the repro later?', status: 'deferred', owner: 'agent', impact: 'not reproduced yet', affectedScope: [f.finding_id], nextAction: 'later' });
  execution.recordNonExecution({ goal: 'repro discount bug', status: 'DEFERRED', reason: 'time', reproduces: f.finding_id, uncertainties: [own.id] });
  assert.equal(status(f.finding_id), 'unverified');
  const env = uncertainty.raise({ question: 'Payment sandbox down?', status: 'environment-unavailable', impact: 'cannot check out', affectedScope: [f.finding_id], nextAction: 'retry when the sandbox is back' });
  execution.recordNonExecution({ goal: 'repro discount bug', status: 'BLOCKED', reason: 'sandbox returns 503', reproduces: f.finding_id, uncertainties: [env.id] });
  assert.equal(status(f.finding_id), 'held');
  assert.equal(gate(), undefined);
});

test('rejection needs a class, a reason and a citation, and then clears the gate', () => {
  fresh('reject');
  const f = candidate();
  assert.throws(() => defects.reject(f.finding_id, { reasonClass: 'nope', reason: 'whatever it is', citation: 'x' }), /--class must be one of/);
  assert.throws(() => defects.reject(f.finding_id, { reasonClass: 'intended-design', reason: 'meh', citation: 'x' }), /--reason/);
  assert.throws(() => defects.reject(f.finding_id, { reasonClass: 'intended-design', reason: 'Discount applies at payment, by design', citation: ' ' }), /--cite/);
  defects.reject(f.finding_id, { reasonClass: 'intended-design', reason: 'Discount is applied at the payment step, by design', citation: 'src/checkout/pricing.ts:88' });
  const v = findingVerifier()(state.get('findings', f.finding_id));
  assert.equal(v.status, 'rejected');
  assert.match(v.reason, /intended-design: .*src\/checkout\/pricing\.ts:88/);
  assert.equal(gate(), undefined);
});

test('non-defect kinds (observations, coverage gaps, test-quality issues) are never gated', () => {
  fresh('kinds');
  candidate({ kind: 'observation', severity: 'major' });
  candidate({ kind: 'coverage-gap', severity: 'critical' });
  candidate({ kind: 'test-quality-issue', severity: 'major' });
  assert.equal(gate(), undefined);
});

test('a repro linked to a finding that does not exist is refused at exec start', () => {
  fresh('dangling');
  assert.throws(() => execution.start({ goal: 'repro ghost', method: 'api-client', reproduces: 'FIND-99999', git: null }), /not a recorded finding/);
});

test('an unverified defect is not filed externally unless the user asks, and then the issue says "Unverified"', () => {
  fresh('promote');
  const f = candidate();
  const blocked = defects.assessPromotion(f.finding_id, { userAuthorised: true, authorisationQuote: 'file it' });
  assert.equal(blocked.may_file, false);
  assert.match(blocked.blockers.join(' '), /not confirmed/);
  const allowed = defects.assessPromotion(f.finding_id, { userAuthorised: true, authorisationQuote: 'file it even if unverified', allowUnverified: true });
  assert.equal(allowed.may_file, true);
  assert.match(allowed.warnings.join(' '), /MUST lead with "Unverified"/);
  assert.match(defects.renderIssue(f.finding_id).body, /\*\*Unverified\.\*\*/);
  confirmWithRepro(f.finding_id);
  assert.equal(defects.assessPromotion(f.finding_id, { userAuthorised: true, authorisationQuote: 'file it' }).may_file, true);
  assert.match(defects.renderIssue(f.finding_id).body, /\*\*Confirmed\*\* by a failing repro check/);
});

test('the report labels each defect confirmed or not, and lists rejected candidates with their citation', async () => {
  fresh('report');
  const reporting = await import('../engine/reporting-engine/index.mjs');
  const proven = candidate({ title: 'Discount code ignored at checkout total' });
  confirmWithRepro(proven.finding_id);
  candidate({ title: 'Footer copyright year looks stale', severity: 'minor' });
  const out = candidate({ title: 'Link opens in a new tab unexpectedly', severity: 'minor' });
  defects.reject(out.finding_id, { reasonClass: 'explorer-artifact', reason: 'The explorer cannot follow target=_blank links; the link is correct', citation: 'src/components/Footer.tsx:14' });
  const { report, markdown } = reporting.generate({});
  assert.equal(report.finding_details.find((d) => d.finding_id === proven.finding_id).verification.status, 'confirmed');
  assert.match(markdown, /\*\*Confirmed\*\* — repro check `npx playwright test tests\/repro\.spec\.ts` fails on it/);
  assert.match(markdown, /\*\*Unverified — not a proven defect\.\*\*/);
  assert.match(markdown, /## Rejected candidates/);
  assert.match(markdown, /explorer-artifact: .*Footer\.tsx:14/);
  const needs = markdown.split('## Needs attention')[1]?.split('\n## ')[0] ?? '';
  assert.doesNotMatch(needs, /new tab unexpectedly/, 'a rejected candidate is not "needs attention"');
});

test('triage signals: explorer artifacts, seed-data gaps and by-design behaviour are not product defects', () => {
  assert.equal(classify({ signals: ['explorer-artifact'] }).class, 'test-defect');
  assert.equal(classify({ signals: ['seed-data-gap'] }).class, 'data-failure');
  assert.equal(classify({ signals: ['by-design'] }).class, 'expected-behaviour-mismatch');
});

/* ---------------------------------------------------------------- CLI */

const AST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ast.mjs');
const cli = (dir, args) => JSON.parse(execFileSync(process.execPath, [AST, '--state', dir, ...args], { encoding: 'utf8', timeout: 15_000 }));
const cliFail = (dir, args) => {
  try { execFileSync(process.execPath, [AST, '--state', dir, ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 15_000 }); } catch (e) { return `${e.stdout}${e.stderr}`; }
  throw new Error('expected the command to fail');
};

test('CLI: plan charters builds area x posture scenarios that plan save accepts and the floor enforces', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-charters-'));
  created.push({ cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) });
  cli(dir, ['session', 'start', '--request', 'bug bash the shop']);
  const out = cli(dir, ['plan', 'charters', '--areas', 'checkout,signup', '--postures', 'first-time-user,edge-input,error-paths']);
  assert.equal(out.scenarios.length, 6);
  assert.deepEqual(out.scenarios.map((s) => s.id), ['S-20', 'S-21', 'S-22', 'S-23', 'S-24', 'S-25']);
  assert.ok(out.scenarios.every((s) => s.category === 'exploratory' && s.obligation === 'must-test' && s.posture && s.area && s.persona));
  const f = path.join(dir, 'plan.json');
  fs.writeFileSync(f, JSON.stringify({
    plan_id: 'PLAN-00001', created_at: new Date().toISOString(), objective: 'Bug bash checkout and signup',
    scope: { in_scope: ['checkout', 'signup'], out_of_scope: [] },
    applicability: [{ category: 'exploratory', applicable: true, reason: 'unknown UI, recurring flows' }],
    scenarios: out.scenarios, exit_criteria: ['every charter explored'],
    provenance: { skill_version: '0.12.0', created_at: new Date().toISOString(), created_by: 'agent' },
  }));
  cli(dir, ['plan', 'save', '--input', f]);
  const todo = cli(dir, ['todo']);
  assert.deepEqual(todo.items.filter((i) => i.check === 'scenario-coverage-floor').map((i) => i.ref), out.scenarios.map((s) => s.id));
  assert.match(cliFail(dir, ['plan', 'charters', '--areas', 'x', '--postures', 'pirate']), /Unknown posture/);
  assert.match(cliFail(dir, ['plan', 'charters']), /--areas is required/);
});

test('CLI: finding reject and finding verify', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-reject-'));
  created.push({ cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) });
  cli(dir, ['session', 'start', '--request', 'triage']);
  const input = path.join(dir, 'f.json');
  fs.writeFileSync(input, JSON.stringify({ title: 'Price shows NaN for empty cart', kind: 'defect', severity: 'major', confidence: 0.7, epistemicClass: 'observed' }));
  const f = cli(dir, ['finding', 'add', '--input', input]);
  assert.equal(cli(dir, ['finding', 'verify', f.finding_id]).status, 'unverified');
  assert.match(cliFail(dir, ['finding', 'reject', f.finding_id, '--class', 'fixture-gap', '--reason', 'Seed data has no empty-cart state']), /--cite/);
  cli(dir, ['finding', 'reject', f.finding_id, '--class', 'fixture-gap', '--reason', 'Seed data has no empty-cart state at all', '--cite', 'db/seed.sql:40']);
  assert.equal(cli(dir, ['finding', 'verify', f.finding_id]).status, 'rejected');
});
