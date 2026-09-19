import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempState, sampleProfile } from './helpers.mjs';
import * as risk from '../engine/risk-engine/index.mjs';
import * as applicability from '../engine/applicability-engine/index.mjs';
import * as browser from '../engine/browser-decision/index.mjs';
import { classify } from '../engine/failure-classifier/index.mjs';

const tmp = useTempState('decisions');
test.after(() => tmp.cleanup());

/* ------------------------------------------------------------------- risk */

test('risk excludes unevidenced factors instead of guessing them', () => {
  const a = risk.score({
    profile: 'balanced',
    factors: { security_sensitivity: { value: 1, basis: 'auth middleware changed' } },
  });
  assert.equal(a.factors.length, 1);
  assert.ok(a.unscored_factors.length >= 12, 'every unsupplied factor is listed as unscored');
  assert.ok(a.confidence < 0.2, `confidence must reflect thin evidence, got ${a.confidence}`);
});

test('risk refuses a number without a stated basis', () => {
  assert.throws(
    () => risk.score({ factors: { user_impact: { value: 0.9 } } }),
    /no basis/,
    'an unexplained number is not a risk assessment',
  );
});

test('risk rejects unknown factors rather than silently dropping them', () => {
  assert.throws(() => risk.score({ factors: { vibes: { value: 1, basis: 'feels risky' } } }), /Unknown risk factor/);
});

test('risk profiles change the answer for the same inputs', () => {
  const factors = {
    security_sensitivity: { value: 0.9, basis: 'auth touched' },
    business_criticality: { value: 0.3, basis: 'internal admin page' },
  };
  const secure = risk.score({ profile: 'security-critical', factors });
  const internal = risk.score({ profile: 'internal-tooling', factors });
  assert.ok(secure.risk_score > internal.risk_score, 'the security profile must weight security sensitivity higher');
});

/* ---------------------------------------------------------- applicability */

test('every known category appears in the matrix, applicable or not', () => {
  const r = applicability.evaluate({ signals: ['ui', 'web-ui'] });
  assert.equal(r.matrix.length, applicability.CATEGORIES.length);
  assert.ok(r.not_applicable.length > 0);
  for (const na of r.not_applicable) {
    assert.ok(na.reason.length > 10, `"${na.category}" must state why it is not applicable`);
  }
});

test('a category with no matching signal is not applicable', () => {
  const r = applicability.evaluate({ signals: ['ui', 'web-ui'] });
  const migration = r.matrix.find((m) => m.category === 'migration');
  assert.equal(migration.applicable, false);
  assert.match(migration.reason, /no signal/i);
});

test('a missing capability marks a category blocked, never quietly done', () => {
  const r = applicability.evaluate({ signals: ['web-ui'], capabilities: { 'browser.explore': false } });
  const a11y = r.matrix.find((m) => m.category === 'accessibility');
  assert.equal(a11y.applicable, true);
  assert.equal(a11y.tool_available, false);
  assert.match(a11y.reason, /BLOCKED, not as done/);
});

test('budget selection honours priority tiers before cheapness', () => {
  const riskAssessment = risk.score({
    profile: 'security-critical',
    factors: {
      security_sensitivity: { value: 1, basis: 'auth' },
      business_criticality: { value: 1, basis: 'checkout' },
      coverage_deficit: { value: 1, basis: 'nothing covers it' },
    },
  });
  const r = applicability.evaluate({
    signals: ['web-ui', 'ui', 'http-api', 'auth', 'user-input', 'existing-tests', 'third-party-deps'],
    riskAssessment,
    budgetMinutes: 40,
  });
  assert.ok(r.estimated_minutes <= 40, `must not exceed the budget, spent ${r.estimated_minutes}`);
  assert.ok(r.deferred_for_budget.length > 0, 'over-budget categories are deferred explicitly');
  const selectedRows = r.matrix.filter((m) => r.selected.includes(m.category));
  const bestTier = Math.min(...selectedRows.map((m) => Number(m.priority.slice(1))));
  const anyP0 = r.matrix.some((m) => m.applicable && m.priority === 'P0');
  if (anyP0) assert.equal(bestTier, 0, 'P0 work must be selected before cheaper lower-priority work');
});

test('signals are derived from profile evidence, not filenames', () => {
  const signals = applicability.signalsFromProfile(sampleProfile());
  assert.ok(signals.includes('web-ui'));
  assert.ok(signals.includes('database'));
  assert.ok(signals.includes('payments'), 'a payment dependency implies the payments signal');
  assert.ok(signals.includes('existing-tests'));
  assert.ok(!signals.includes('llm'), 'no LLM technology was declared, so no llm signal');
});

test('an unknown signal is rejected, not ignored', () => {
  assert.throws(() => applicability.evaluate({ signals: ['quantum'] }), /Unknown repository signal/);
});

/**
 * CHANGELOG 0.8.0 named this as a known gap: "critical" at 0.10 confidence used to drive
 * category selection exactly as one at 0.95 would, because nothing downstream consulted
 * `confidence` -- only `risk_score`. This asserts the fix actually changes an outcome, not
 * just that the field is now threaded through somewhere.
 */
test('a critical risk score backed by thin evidence produces a materially different applicability outcome than one backed by thorough evidence', () => {
  const ALL_FACTORS = Object.keys(risk.factorCatalog());
  const thinAssessment = risk.score({
    profile: 'balanced',
    factors: { security_sensitivity: { value: 1, basis: 'auth touched' } },
  });
  const thoroughAssessment = risk.score({
    profile: 'balanced',
    factors: Object.fromEntries(ALL_FACTORS.map((f) => [f, { value: 1, basis: 'evidenced' }])),
  });

  // Same headline risk_score both times -- the only thing that differs is how much of it
  // is backed by evidence. If applicability selection did not change, confidence is still
  // advisory only.
  assert.equal(thinAssessment.risk_score, 1);
  assert.equal(thoroughAssessment.risk_score, 1);
  assert.equal(thinAssessment.confidence_band, 'low');
  assert.equal(thoroughAssessment.confidence_band, 'high');

  const thin = applicability.evaluate({ signals: ['user-input', 'auth'], riskAssessment: thinAssessment });
  const thorough = applicability.evaluate({ signals: ['user-input', 'auth'], riskAssessment: thoroughAssessment });
  const thinRow = thin.matrix.find((r) => r.category === 'security');
  const thoroughRow = thorough.matrix.find((r) => r.category === 'security');

  assert.ok(
    thoroughRow.expected_value > thinRow.expected_value,
    `well-evidenced critical (${thoroughRow.expected_value}) must score higher than thinly-evidenced critical (${thinRow.expected_value})`,
  );
  assert.equal(thoroughRow.priority, 'P0', 'full-confidence critical earns the P0 override');
  assert.notEqual(thinRow.priority, 'P0', 'low-confidence critical must not force the same override');
  assert.match(thinRow.reason, /tempered toward neutral/, 'the qualification must be visible in the reason, not just the score');
  assert.doesNotMatch(thoroughRow.reason, /tempered toward neutral/, 'high-confidence rows carry no such caveat');
});

/* -------------------------------------------------------- browser method */

test('a CI gate never selects the agent-driven browser session', () => {
  const d = browser.decide({
    factors: { ci_suitability: 0.9, determinism_required: 0.9, repeatability: 0.9, ui_known: 0.8, existing_automation: 0.1 },
  });
  assert.notEqual(d.selected, 'playwright-mcp');
  assert.ok(d.fired_rules.some((r) => r.id === 'no-mcp-for-ci-gate'));
});

test('an unknown UI never gets a script written blind', () => {
  const d = browser.decide({ factors: { ui_known: 0.1, repeatability: 0.9, determinism_required: 0.9, existing_automation: 0.0 } });
  const script = d.candidates.find((c) => c.id === 'playwright-script');
  assert.equal(script.eligible, false);
  assert.match(script.blocked_because.join(' '), /Explore first/);
});

test('unknown UI + high repeatability selects the hybrid explore-then-automate path', () => {
  const d = browser.decide({
    factors: { ui_known: 0.2, exploratory_value: 0.8, repeatability: 0.85, business_criticality: 0.9, existing_automation: 0.3 },
    capabilities: { 'browser.explore': true },
  });
  assert.equal(d.selected, 'hybrid');
  assert.match(d.reason.join(' '), /discovered before it can be asserted/);
});

test('strong existing coverage wins over writing anything new', () => {
  const d = browser.decide({
    factors: { existing_automation: 0.9, ui_known: 0.8, repeatability: 0.8, determinism_required: 0.8, exploratory_value: 0.1 },
    capabilities: { 'shell.run': true },
  });
  // This factor set does not distinguish *which* existing tool the repo has (a real session
  // would supply that from repository-intelligence); "existing-tests" and "existing-other-
  // tooling" are near-duplicate affinity profiles by design and legitimately tie here, which
  // correctly escalates (see the dedicated escalation tests below). The property this test
  // actually asserts -- Rule 1 beating "write something new" -- holds either way: the winner
  // is one of the two existing-tooling flavours, resolved or tied.
  const winner = d.selected ?? d.top_candidate;
  assert.ok(['existing-tests', 'existing-other-tooling'].includes(winner));
  assert.match(d.reason.join(' '), /cheapest reliable evidence/);
});

test('production forbids open-ended agent interaction', () => {
  const d = browser.decide({ factors: { exploratory_value: 0.9, ui_known: 0.2, repeatability: 0.8 }, environmentIsProduction: true });
  assert.notEqual(d.selected, 'playwright-mcp');
  assert.notEqual(d.selected, 'hybrid');
  assert.ok(d.fired_rules.some((r) => r.id === 'no-exploration-on-production'));
});

test('a missing browser capability removes that method', () => {
  const d = browser.decide({
    factors: { exploratory_value: 0.9, ui_known: 0.2, repeatability: 0.3 },
    capabilities: { 'browser.explore': false },
  });
  const mcp = d.candidates.find((c) => c.id === 'playwright-mcp');
  assert.equal(mcp.eligible, false);
  assert.match(mcp.blocked_because.join(' '), /not available/);
});

test('automation conversion refuses unstable or slow scenarios', () => {
  const yes = browser.shouldAutomate({
    factors: { repeatability: 0.8, business_criticality: 0.9, environment_stability: 0.8, expected_runtime_minutes: 3 },
  });
  assert.equal(yes.automate, true);

  const no = browser.shouldAutomate({
    factors: { repeatability: 0.8, business_criticality: 0.9, environment_stability: 0.2, expected_runtime_minutes: 45 },
  });
  assert.equal(no.automate, false);
  assert.match(no.reason, /environment_stability/);
  assert.match(no.reason, /expected_runtime_minutes/);
});

test('out-of-range factors are rejected', () => {
  assert.throws(() => browser.decide({ factors: { ui_known: 5 } }), /must be a number in \[0,1\]/);
});

/* ------------------------------------------------------ failure classes */

test('no signals yields unclassified-no-signals, not a defect, at a low confidence that reads as absence', () => {
  const c = classify({ signals: [] });
  assert.equal(c.class, 'unclassified-no-signals');
  assert.ok(c.confidence <= 0.3, 'a no-signal fallback must never look more confident than a genuine low-certainty classification');
});

test('environment causes outrank product-defect on a tie', () => {
  const c = classify({ signals: ['assertion-mismatch', 'missing-env-var'], evidenceIds: ['EV-2026-00001'] });
  assert.equal(c.class, 'environment-defect', 'attributing an environment failure to the product creates a false defect report');
});

test('flakiness cannot be asserted from a single run', () => {
  const c = classify({ signals: ['passed-on-retry'], history: [] });
  assert.equal(c.class, 'flaky-test');
  assert.ok(c.confidence <= 0.35, `confidence must be capped without run history, got ${c.confidence}`);
  assert.match(c.signals.join(' '), /at least 3 runs/);
});

test('product-defect confidence drops when a non-product cause competes', () => {
  const clean = classify({ signals: ['http-500', 'unhandled-exception'], evidenceIds: ['EV-2026-00001'] });
  const muddy = classify({ signals: ['http-500', 'stale-test-data'], evidenceIds: ['EV-2026-00001'] });
  assert.equal(clean.class, 'product-defect');
  assert.notEqual(muddy.class, 'product-defect');
});

test('classification without evidence is capped', () => {
  const c = classify({ signals: ['http-500', 'unhandled-exception'], evidenceIds: [] });
  assert.ok(c.confidence <= 0.5);
  assert.match(c.signals.join(' '), /No evidence attached/);
});

test('static-analysis-shaped signals classify as product-defect, not unclassified-no-signals', () => {
  // A dependency scan or a manual security review has no RUNTIME signal to supply --
  // econnrefused, http-500 and the rest all describe something that happened while a
  // program ran. Before these four signals existed, a static finding was routed to the
  // no-signal fallback by construction, regardless of how solid the underlying finding
  // was -- exactly what happened to two of Madhubala's most important findings (a
  // confirmed critical CVE and a hardcoded JWT secret), both rendered as
  // "insufficient-evidence (0.9)" as if the findings themselves were unsupported.
  for (const signal of ['advisory-in-range', 'missing-auth-check', 'hardcoded-secret', 'policy-violation']) {
    const c = classify({ signals: [signal], evidenceIds: ['EV-2026-00001'] });
    assert.equal(c.class, 'product-defect', `expected "${signal}" to classify as product-defect`);
  }
});

test('a static-analysis signal still competes fairly with non-product causes on a tie', () => {
  // The new signals join the EXISTING product-defect rule rather than becoming their own
  // rule, so they inherit the same "non-product causes outrank product-defect on a tie"
  // behaviour as every other product-defect signal -- confirmed here as a regression
  // guard, since a separate rule would have silently bypassed that protection.
  const c = classify({ signals: ['hardcoded-secret', 'missing-env-var'], evidenceIds: ['EV-2026-00001'] });
  assert.equal(c.class, 'environment-defect');
});
