import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempState, sampleProfile } from './helpers.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as execution from '../engine/execution-engine/index.mjs';
import * as evidence from '../engine/evidence-engine/index.mjs';
import * as decisions from '../engine/decision-engine/index.mjs';
import * as defects from '../engine/defect-engine/index.mjs';
import * as uncertainty from '../engine/uncertainty-register/index.mjs';
import * as auth from '../engine/authorization/index.mjs';
import * as reporting from '../engine/reporting-engine/index.mjs';
import { analyse } from '../engine/flakiness/index.mjs';
import { query } from '../engine/traceability/index.mjs';
import * as risk from '../engine/risk-engine/index.mjs';
import * as applicability from '../engine/applicability-engine/index.mjs';

const tmp = useTempState('lifecycle');
test.after(() => tmp.cleanup());

const GIT = { repository: 'demo-shop', branch: 'feat/checkout', commit: 'abc1234', dirty: false };
const LONG_TOKEN = 'z'.repeat(40);

function evidenceFile(name, body) {
  const f = path.join(tmp.dir, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body, 'utf8');
  return f;
}

test('session start creates schema-valid state', () => {
  const s = state.startSession({
    request: 'Test the new checkout flow',
    git: GIT,
    goals: [{ goal: 'Validate payment flow', success_criteria: ['successful payment', 'failed payment handled'] }],
  });
  assert.match(s.session_id, /^SESSION-\d{4}$/);
  assert.equal(s.phase, 'discover');
  assert.equal(s.goals[0].success_criteria.length, 2);
  state.saveProfile(sampleProfile());
  assert.ok(state.loadProfile());
});

test('a PASSED claim without evidence is downgraded, not accepted', () => {
  const e = execution.start({ goal: 'Run unit suite', method: 'existing-suite', testCategory: 'unit', git: GIT });
  const { record, downgraded, verdict } = execution.finish(e.execution_id, {
    status: 'PASSED',
    statusReason: 'Checkout works.',
    evidence: [],
  });
  assert.equal(downgraded, true);
  assert.equal(record.status, 'INCONCLUSIVE');
  assert.match(verdict.reasons.join(' '), /Absence of failure is not proof of correctness/);
});

test('a screenshot alone cannot support a PASSED claim', () => {
  const shot = evidence.add({
    kind: 'screenshot',
    summary: 'Checkout page after submit',
    artifactPath: evidenceFile('shots/checkout.png', 'not-a-real-png-but-real-bytes'),
  });
  const v = evidence.verifyClaim({ status: 'PASSED', evidenceIds: [shot.evidence_id] });
  assert.equal(v.permitted, false);
  assert.match(v.reasons.join(' '), /corroborating only/);
});

test('execution evidence supports a PASSED claim and is hashed', () => {
  const e = execution.start({
    goal: 'Run unit suite (retry)',
    method: 'existing-suite',
    testCategory: 'unit',
    git: GIT,
    environment: 'local',
    command: 'npm test',
  });
  const ev = evidence.captureOutput({
    argv: 'npm test',
    cwd: tmp.dir,
    exitCode: 0,
    durationMs: 4200,
    stdout: 'Test Files 12 passed (12)\nTests 87 passed (87)',
    stderr: '',
    summary: 'vitest: 87/87 passed',
    executionId: e.execution_id,
    git: GIT,
  });
  assert.match(ev.artifact.sha256, /^sha256:[0-9a-f]{64}$/);

  const { record, downgraded } = execution.finish(e.execution_id, {
    status: 'PASSED',
    statusReason: 'vitest suite executed against abc1234; 87 assertions passed.',
    evidence: [ev.evidence_id],
    testResults: [
      { name: 'cart totals', status: 'PASSED', file: 'src/cart.test.ts', validates_requirements: ['REQ-1'], test_case_id: 'TC-00001' },
      { name: 'tax rounding', status: 'PASSED', file: 'src/cart.test.ts', validates_requirements: ['REQ-2'], test_case_id: 'TC-00002' },
    ],
  });
  assert.equal(downgraded, false);
  assert.equal(record.status, 'PASSED');
  assert.equal(record.totals.passed, 2);
});

test('command output evidence is redacted before it is stored', () => {
  const ev = evidence.captureOutput({
    argv: `curl -H "Authorization: Bearer ${LONG_TOKEN}" https://api.example.com`,
    cwd: tmp.dir,
    exitCode: 0,
    durationMs: 100,
    stdout: 'ok',
    summary: 'probe',
  });
  const onDisk = fs.readFileSync(ev.artifact.path, 'utf8');
  assert.ok(!onDisk.includes(LONG_TOKEN), 'the token must not reach disk');
  assert.ok(!ev.excerpt.includes(LONG_TOKEN));
  assert.equal(ev.redacted, true);
});

test('decisions require options, reasons, confidence and reversibility', () => {
  assert.throws(
    () => decisions.record({ question: 'x?', options: ['only-one'], selected: 'only-one', reason: ['a'], confidence: 0.5, reversible: true }),
    /at least two candidate options/,
  );
  assert.throws(
    () => decisions.record({ question: 'x?', options: ['a', 'b'], selected: 'a', reason: [], confidence: 0.5, reversible: true }),
    /at least one reason/,
  );
  assert.throws(
    () => decisions.record({ question: 'x?', options: ['a', 'b'], selected: 'c', reason: ['r'], confidence: 0.5, reversible: true }),
    /not among the candidates/,
  );
  assert.throws(
    () => decisions.record({ question: 'x?', options: ['a', 'b'], selected: 'a', reason: ['r'], reversible: true }),
    /confidence must be a number/,
  );

  const d = decisions.record({
    question: 'How should the checkout UI be tested?',
    category: 'browser-method',
    options: [{ id: 'playwright-mcp', label: 'Explore' }, { id: 'hybrid', label: 'Explore then automate' }],
    selected: 'hybrid',
    reason: ['UI behaviour has not been explored', 'scenario will be re-run every release'],
    confidence: 0.87,
    reversible: true,
    policyRefs: ['browser-decision.matrix@1.0.0'],
  });
  assert.match(d.decision_id, /^DEC-\d{5}$/);
});

test('a blocker stops one branch, never the whole session', () => {
  const u = uncertainty.raise({
    question: 'Should payment tests use real provider credentials?',
    status: 'user-input-required',
    impact: 'cannot safely execute a real transaction',
    affectedScope: ['payment-e2e'],
    blocksCategories: ['e2e'],
    nextAction: 'request an explicit environment choice from the user',
    owner: 'user',
  });
  const partition = uncertainty.partitionWork([
    { id: 'payment-e2e', category: 'e2e' },
    { id: 'cart-unit', category: 'unit' },
    { id: 'api-contract', category: 'api' },
  ]);
  assert.equal(partition.blocked.length, 1);
  assert.equal(partition.runnable.length, 2);
  assert.match(partition.guidance, /do not wait/);

  uncertainty.noteIndependentWork(u.id, 'Ran unit and API suites while payment E2E stayed blocked.');
  assert.equal(state.get('uncertainties', u.id).independent_work_continued.length, 1);
});

test('blocked work is recorded as a first-class execution, not omitted', () => {
  const { record } = execution.recordNonExecution({
    goal: 'Payment E2E against the real provider',
    status: 'BLOCKED',
    reason: 'No authorised sandbox credentials; refusing to transact against production.',
    testCategory: 'e2e',
    uncertainties: state.list('uncertainties').map((u) => u.id),
  });
  assert.equal(record.status, 'BLOCKED');
  assert.equal(record.method, 'not-executed');
});

test('a failure is classified before it becomes a defect report', () => {
  const e = execution.start({
    goal: 'Checkout happy path',
    method: 'playwright-script',
    testCategory: 'e2e',
    git: GIT,
    environment: 'local',
    command: 'npx playwright test checkout',
  });
  const ev = evidence.captureOutput({
    argv: 'npx playwright test checkout',
    cwd: tmp.dir,
    exitCode: 1,
    durationMs: 18342,
    stdout: 'expected 1 order, received 0',
    summary: 'playwright: 1 failed',
    executionId: e.execution_id,
    git: GIT,
  });
  const { record } = execution.finish(e.execution_id, {
    status: 'FAILED',
    statusReason: 'Order was not persisted after successful payment.',
    evidence: [ev.evidence_id],
    signals: ['assertion-mismatch', 'data-not-persisted'],
    testResults: [{ name: 'checkout creates an order', status: 'FAILED', file: 'e2e/checkout.spec.ts', validates_requirements: ['REQ-3'] }],
  });
  assert.equal(record.status, 'FAILED');
  assert.equal(record.failure_classification.class, 'product-defect');

  const next = decisions.nextAction({ status: 'FAILED', failureClass: 'product-defect', remainingWork: ['a11y scan'] });
  assert.match(next.next, /Do NOT modify product code/);
  assert.equal(next.reassess, true);
});

test('identical defects share a fingerprint and are not filed twice', () => {
  const exec = state.list('executions').find((e) => e.status === 'FAILED');
  const args = {
    title: 'Order is not persisted after a successful payment',
    component: 'checkout',
    severity: 'critical',
    confidence: 0.82,
    environment: 'local',
    reproduction: { steps: ['add item', 'pay with test card'], expected: 'an order row exists', actual: 'no order row', reproducible: 'always', attempts: 3 },
    evidence: exec.evidence,
    executionId: exec.execution_id,
    git: GIT,
  };
  const first = defects.create(args);
  const second = defects.create({ ...args, title: 'Order  is NOT persisted, after a successful payment!' });
  assert.equal(first.fingerprint, second.fingerprint, 'wording drift must not create a new identity');
  assert.equal(second.duplicate_of, first.finding_id);

  const promo = defects.assessPromotion(second.finding_id, { userAuthorised: true, authorisationQuote: 'yes, file it' });
  assert.equal(promo.may_file, false);
  assert.match(promo.blockers.join(' '), /Duplicate of/);
});

test('filing an issue needs explicit authorisation; assignment needs a named account', () => {
  const finding = defects.bySeverity().find((f) => !f.duplicate_of);

  const unauthorised = defects.assessPromotion(finding.finding_id, { userAuthorised: false });
  assert.equal(unauthorised.may_file, false);
  assert.match(unauthorised.blockers.join(' '), /explicit user authorisation/);

  const authorised = defects.assessPromotion(finding.finding_id, { userAuthorised: true, authorisationQuote: 'file it on GitHub' });
  assert.equal(authorised.may_file, true);

  const noAssignee = auth.check({ action: 'github.assign_issue', userAuthorised: true, assignee: null });
  assert.equal(noAssignee.allowed, false);
  assert.match(noAssignee.reason, /never choose the person/);

  const named = auth.check({ action: 'github.assign_issue', userAuthorised: true, assignee: 'octocat' });
  assert.equal(named.allowed, true);
});

test('destructive actions are refused by default', () => {
  for (const action of ['github.merge_pr', 'github.close_issue', 'git.force_push', 'payment.execute', 'db.any_production']) {
    const r = auth.check({ action, userAuthorised: true });
    assert.equal(r.allowed, false, `${action} must not be allowed even when the user says yes in passing`);
  }
});

test('an unknown environment is treated as production', () => {
  assert.equal(auth.check({ action: 'db.read_non_production', environmentClass: 'unknown' }).allowed, false);
  assert.equal(auth.check({ action: 'db.read_non_production', environmentClass: 'non-production' }).allowed, true);
});

test('the external-write ledger suppresses duplicates across sessions', () => {
  const finding = defects.bySeverity().find((f) => !f.duplicate_of);
  const key = finding.fingerprint;
  assert.equal(auth.alreadyWritten({ system: 'github', action: 'github.create_issue', idempotencyKey: key }).duplicate, false);

  auth.recordWrite({
    system: 'github',
    action: 'github.create_issue',
    idempotencyKey: key,
    target: 'demo-shop',
    confirmed: true,
    resultId: '#412',
    url: 'https://github.com/o/r/issues/412',
    authorisedBy: 'user-explicit',
  });
  const again = auth.alreadyWritten({ system: 'github', action: 'github.create_issue', idempotencyKey: key });
  assert.equal(again.duplicate, true);
  assert.match(again.reason, /Update it instead/);
});

test('an unconfirmed write is never reported as done', () => {
  auth.recordWrite({
    system: 'jira',
    action: 'jira.comment',
    idempotencyKey: 'PROJ-7',
    target: 'PROJ-7',
    confirmed: false,
    error: 'connector not authorised',
    authorisedBy: 'user-explicit',
  });
  const entry = auth.listWrites('jira')[0];
  assert.equal(entry.confirmed, false);
});

test('the issue body leads with uncertainty when confidence is low', () => {
  const f = defects.create({
    title: 'Discount badge occasionally renders stale price',
    component: 'cart',
    severity: 'minor',
    confidence: 0.4,
    reproduction: { steps: ['apply a coupon twice'], expected: 'updated price', actual: 'previous price', reproducible: 'once', attempts: 1 },
  });
  const issue = defects.renderIssue(f.finding_id);
  assert.match(issue.body, /Reported with low confidence/);
  assert.match(issue.body, /## Uncertainty/);
  assert.match(issue.body, /Fingerprint/);
  assert.match(issue.title, /^\[minor\]/);
});

test('recovery marks unfinished executions INTERRUPTED rather than assuming success', () => {
  const open = execution.start({ goal: 'a11y scan', method: 'static-analysis', testCategory: 'accessibility', git: GIT });
  state.recordInterruption({ kind: 'user', note: 'user stopped the run' });

  const rec = state.recover();
  assert.equal(rec.recoverable, true);
  assert.equal(rec.orphaned_executions.length, 1);
  assert.equal(state.get('executions', open.execution_id).status, 'INTERRUPTED');
  assert.ok(rec.unresolved_uncertainties.length >= 1);
  assert.ok(rec.next_action.length > 0);
});

test('flakiness needs at least three runs before it can be claimed', () => {
  const rows = analyse();
  assert.ok(rows.some((r) => r.verdict === 'insufficient-data'));
  assert.ok(rows.every((r) => r.verdict !== 'flaky' || r.runs >= 3));
});

test('traceability answers what remains untested', () => {
  const r = query('what-remains-untested');
  assert.ok(r.covered_by_passing_test.includes('REQ-1'));
  assert.ok(r.uncovered.includes('REQ-3'), 'a requirement whose only test failed is not covered');
  assert.match(r.caveat, /Requirements nobody wrote down/);
});

test('the report is rendered from data and audits its own false confidence', () => {
  const { report, markdown } = reporting.generate({
    applicability: [{ category: 'localization', applicable: false, reason: 'No i18n resources found in the repository.' }],
    recommendations: ['Add an e2e test for the failed order-persistence path once fixed.'],
  });
  assert.match(report.report_id, /^REPORT-\d{4}-\d{5}$/);
  assert.equal(report.executive_summary.overall_status, 'FAILED');
  assert.ok(report.executive_summary.what_was_not_tested.length > 0);
  assert.equal(typeof report.integrity.false_confidence_rate, 'number');

  assert.match(markdown, /^# Testing Report · REPORT-/m);
  assert.match(markdown, /## Verdict/);
  assert.match(markdown, /## What was not tested/);
  assert.match(markdown, /### Integrity self-audit/);
  assert.match(markdown, /NOT CONFIRMED/, 'the unconfirmed Jira write must be visible as unconfirmed');
  assert.ok(fs.existsSync(path.join(tmp.dir, 'reports', `${report.report_id}.md`)), 'markdown is written to disk');
});

/**
 * PROGRESS.md named this as a gap: the evidence-auditor subagent is described as available
 * before a report, not required, so a session can finish without it and look no different
 * from one that ran it and found nothing. No code path can force a subagent launch, but the
 * report must not stay silent about whether one happened.
 */
test('a report is honest about whether the evidence-auditor ran', () => {
  const before = reporting.generate({ recommendations: [] });
  assert.equal(before.report.integrity.evidence_auditor_run, false);
  assert.equal(before.report.metrics.metrics.audit_coverage, 0, 'claims exist in this fixture and no audit record does');
  assert.ok(
    before.report.integrity.violations.some((v) => /evidence-auditor/.test(v)),
    'the omission must be a stated violation, not a silent gap',
  );
  assert.match(before.markdown, /\| evidence-auditor ran \|/);
  assert.match(before.markdown, /\| .* \| no \|/, 'the rendered table must say "no", not just omit the column');

  evidence.add({
    kind: 'evidence-audit',
    summary: 'evidence-auditor reviewed all claims this session; found nothing unsupported.',
    epistemicClass: 'observed',
  });

  const after = reporting.generate({ recommendations: [] });
  assert.equal(after.report.integrity.evidence_auditor_run, true);
  assert.equal(after.report.metrics.metrics.audit_coverage, 1);
  assert.ok(
    !after.report.integrity.violations.some((v) => /evidence-auditor/.test(v)),
    'the violation must clear once an audit record exists, not persist forever',
  );
});

test('findings are rendered with their content, not as a list of identifiers', () => {
  const { report, markdown } = reporting.generate({ recommendations: [] });
  const critical = report.finding_details.find((f) => f.severity === 'critical');
  assert.ok(critical, 'the fixture should include a critical finding');

  // The failure this guards against: a report whose most important section is a set of
  // lookups the reader will not perform.
  assert.match(markdown, /## Needs attention/);
  assert.match(markdown, /### Critical/);
  assert.match(markdown, new RegExp(`#### ${critical.finding_id} — `));
  // The content that makes a finding actionable without a second lookup.
  assert.match(markdown, /\| Expected \| Actual \|/);
  assert.match(markdown, /an order row exists/);
  assert.match(markdown, new RegExp(`_Evidence: ${critical.evidence[0]}`));
  // The fixture sets no recommended_action, so that line must be absent rather than
  // rendered empty -- the same skip-when-empty rule the sections follow.
  assert.ok(!markdown.includes('**Next.** \n'), 'an absent recommended action must not render a stub');
});

test('an empty section is not rendered at all', () => {
  const { markdown } = reporting.generate({ recommendations: [] });

  // A heading over nothing trains the reader to skim past headings, which then hides
  // the sections that do have content.
  for (const heading of ['## Automation added', '## Traceability', '## Repository context']) {
    assert.ok(!markdown.includes(heading), `"${heading}" has no content and must not be rendered`);
  }

  // Walk the document; a heading is empty only when the NEXT heading is at the same or
  // a shallower level with nothing between them. A heading followed by a sub-heading is
  // a container ("Detail" over "Executions"), which is legitimate.
  const lines = markdown.split('\n');
  const empties = [];
  for (let i = 0; i < lines.length; i += 1) {
    const h = /^(#{2,4}) (.+)$/.exec(lines[i]);
    if (!h) continue;
    const level = h[1].length;
    let body = '';
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const next = /^(#{1,4}) /.exec(lines[j]);
      if (next) { if (next[1].length <= level) break; body += 'sub'; break; }
      body += lines[j].trim();
    }
    if (!body) empties.push(h[2]);
  }
  assert.deepEqual(empties, [], `sections rendered with an empty body: ${empties.join(', ')}`);
});

test('not-applicable categories are grouped, not listed one per line', () => {
  const applicability = Array.from({ length: 12 }, (_, i) => ({
    category: ['unit', 'api', 'e2e', 'ui', 'visual', 'load', 'stress', 'migration', 'caching', 'localization', 'contract', 'database'][i],
    applicable: false,
    reason: 'Repository shows no signal for this category (needs any of: x; missing: x).',
  }));
  const { report, markdown } = reporting.generate({ applicability, recommendations: [] });

  assert.equal(report.executive_summary.not_applicable_summary.total, 12);
  const group = report.executive_summary.not_applicable_summary.groups[0];
  assert.equal(group.count, 12);
  assert.match(group.reason, /no matching repository signal/);

  // One grouped line, not twelve repetitions of the same sentence.
  const notTested = markdown.split('## What was not tested')[1].split(/^## /m)[0];
  assert.match(notTested, /12 categories — no matching repository signal/);
  assert.ok(
    (notTested.match(/Repository shows no signal/g) ?? []).length === 0,
    'the repeated boilerplate reason must not appear in the summary section',
  );
});

/**
 * Every other report test in this file hand-builds a partial `applicability` fixture, which
 * is exactly how a real gap survived: applicability-engine started emitting `risk_confidence`
 * on every row (the confidence-tempering fix), the schema had no such field, and
 * `reporting.generate()` threw on the very first real applicability output it saw --
 * `scripts/demo-session.mjs` caught it; no unit test did, because none of them fed the real
 * engine's output through the real report. This closes that path once.
 */
test('the real applicability engine output round-trips through report generation without a schema mismatch', () => {
  const riskAssessment = risk.score({
    profile: 'balanced',
    factors: { security_sensitivity: { value: 0.8, basis: 'auth touched' } },
  });
  const matrix = applicability.evaluate({
    signals: ['ui', 'web-ui', 'http-api', 'auth'],
    riskAssessment,
  }).matrix;

  const { report } = reporting.generate({ applicability: matrix, riskAssessment, recommendations: [] });
  assert.equal(report.applicable_categories.length, matrix.length);
  assert.ok(report.applicable_categories.some((r) => typeof r.risk_confidence === 'number'));
});

test('a second session archives the first rather than clobbering it', () => {
  const before = state.requireSession().session_id;
  const next = state.startSession({ request: 'second run' });
  assert.notEqual(next.session_id, before);
  assert.ok(fs.existsSync(path.join(tmp.dir, 'history', `${before}.json`)));
});

test('records are keyed by their own ID, not by a foreign key they happen to carry', () => {
  // Regression: an execution carries decision_id, and evidence/findings carry
  // execution_id. A fallback chain keyed every record by a foreign ID and then reported
  // every genuine reference as dangling.
  const d = decisions.record({
    question: 'Which suite should run first?',
    options: ['unit', 'e2e'],
    selected: 'unit',
    reason: ['cheapest reliable evidence'],
    confidence: 0.8,
    reversible: true,
  });
  const e = execution.start({ goal: 'linked run', method: 'existing-suite', decisionId: d.decision_id, git: GIT });
  const ev = evidence.captureOutput({
    argv: 'npm test', cwd: tmp.dir, exitCode: 0, durationMs: 10,
    stdout: 'ok', summary: 'linked evidence', executionId: e.execution_id,
  });
  execution.finish(e.execution_id, { status: 'PASSED', statusReason: 'linked run passed', evidence: [ev.evidence_id] });

  const exec = state.get('executions', e.execution_id);
  assert.equal(exec.decision_id, d.decision_id);
  assert.notEqual(exec.execution_id, exec.decision_id);

  const stored = state.get('evidence', ev.evidence_id);
  assert.equal(stored.execution_id, e.execution_id);
  assert.notEqual(stored.evidence_id, stored.execution_id);

  // Every referenced evidence ID must resolve against the evidence collection.
  const evidenceIds = new Set(state.list('evidence').map((e) => e.evidence_id));
  for (const e of state.list('executions')) {
    for (const ref of e.evidence ?? []) {
      assert.ok(evidenceIds.has(ref), `${e.execution_id} references ${ref}, which must exist`);
    }
  }
});

test('an execution with a shared evidence array survives persistence intact', () => {
  const failed = state.list('executions').find((e) => e.failure_classification);
  assert.ok(failed);
  assert.ok(Array.isArray(failed.failure_classification.evidence_refs),
    'evidence_refs must survive redaction as an array, not "[circular]"');
  assert.deepEqual(failed.failure_classification.evidence_refs, failed.evidence);
});

test('test totals survive redaction', () => {
  const withTotals = state.list('executions').find((e) => e.totals);
  assert.ok(withTotals);
  assert.equal(typeof withTotals.totals.passed, 'number', '"passed" must not be masked as a password');
});
