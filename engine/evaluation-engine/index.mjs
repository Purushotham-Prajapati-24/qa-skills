/**
 * Evaluation Engine -- benchmark runner.
 *
 * Runs the deterministic parts of the agent's judgement (risk, applicability,
 * browser-method, authorization, failure classification) against benchmark
 * cases with expected outcomes, and scores them.
 *
 * What this DOES measure: whether the decision machinery behaves as designed,
 * and whether a policy edit silently changed behaviour elsewhere. It is a
 * regression suite for judgement.
 *
 * What it does NOT measure: whether the agent gathered the right inputs in the
 * first place. That needs a human or a live repository, and the benchmark says
 * so rather than pretending otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../core/fsjson.mjs';
import { PACKAGE_ROOT } from '../core/paths.mjs';
import * as risk from '../risk-engine/index.mjs';
import * as applicability from '../applicability-engine/index.mjs';
import * as browser from '../browser-decision/index.mjs';
import * as auth from '../authorization/index.mjs';
import { classify } from '../failure-classifier/index.mjs';

const CASES_DIR = path.join(PACKAGE_ROOT, 'evaluation', 'benchmark-cases');
const RUBRIC = path.join(PACKAGE_ROOT, 'evaluation', 'scoring', 'rubric.json');

export function loadCases() {
  if (!fs.existsSync(CASES_DIR)) return [];
  return fs
    .readdirSync(CASES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: f, ...readJson(path.join(CASES_DIR, f)) }));
}

function checkExpectation(actual, expectation, label) {
  if (expectation === undefined) return null;
  if (typeof expectation === 'object' && expectation !== null && !Array.isArray(expectation)) {
    if ('equals' in expectation) return { label, pass: JSON.stringify(actual) === JSON.stringify(expectation.equals), actual, expected: expectation.equals };
    if ('one_of' in expectation) return { label, pass: expectation.one_of.includes(actual), actual, expected: `one of ${expectation.one_of.join('|')}` };
    if ('at_least' in expectation) return { label, pass: Number(actual) >= expectation.at_least, actual, expected: `>= ${expectation.at_least}` };
    if ('at_most' in expectation) return { label, pass: Number(actual) <= expectation.at_most, actual, expected: `<= ${expectation.at_most}` };
    if ('includes' in expectation) {
      const arr = Array.isArray(actual) ? actual : [];
      const missing = expectation.includes.filter((x) => !arr.includes(x));
      return { label, pass: missing.length === 0, actual, expected: `includes ${expectation.includes.join(', ')}`, missing };
    }
    if ('excludes' in expectation) {
      const arr = Array.isArray(actual) ? actual : [];
      const present = expectation.excludes.filter((x) => arr.includes(x));
      return { label, pass: present.length === 0, actual, expected: `excludes ${expectation.excludes.join(', ')}`, unexpected: present };
    }
  }
  return { label, pass: JSON.stringify(actual) === JSON.stringify(expectation), actual, expected: expectation };
}

function runCase(c) {
  const checks = [];
  const outputs = {};

  if (c.given?.risk_factors) {
    const assessment = risk.score({ profile: c.given.risk_profile ?? 'balanced', factors: c.given.risk_factors });
    outputs.risk = assessment;
    checks.push(checkExpectation(assessment.risk_level, c.expect?.risk_level, 'risk_level'));
    checks.push(checkExpectation(assessment.risk_score, c.expect?.risk_score, 'risk_score'));
  }

  if (c.given?.signals) {
    const result = applicability.evaluate({
      signals: c.given.signals,
      riskAssessment: outputs.risk ?? null,
      coverage: c.given.coverage ?? {},
      capabilities: c.given.capabilities ?? {},
      unmetPrerequisites: c.given.unmet_prerequisites ?? [],
      budgetMinutes: c.given.budget_minutes ?? null,
    });
    outputs.applicability = result;
    checks.push(checkExpectation(result.applicable, c.expect?.applicable_includes ? { includes: c.expect.applicable_includes } : undefined, 'applicable_includes'));
    checks.push(checkExpectation(result.applicable, c.expect?.applicable_excludes ? { excludes: c.expect.applicable_excludes } : undefined, 'applicable_excludes'));
    checks.push(checkExpectation(result.selected, c.expect?.selected_includes ? { includes: c.expect.selected_includes } : undefined, 'selected_includes'));
  }

  if (c.given?.browser_factors) {
    const d = browser.decide({
      factors: c.given.browser_factors,
      capabilities: c.given.capabilities ?? {},
      environmentIsProduction: c.given.environment_is_production ?? false,
      scenario: c.title,
    });
    outputs.browser = d;
    checks.push(checkExpectation(d.selected, c.expect?.browser_method, 'browser_method'));
    checks.push(checkExpectation(d.escalate, c.expect?.escalate, 'escalate'));
  }

  if (c.given?.automation_factors) {
    const a = browser.shouldAutomate({ factors: c.given.automation_factors });
    outputs.automation = a;
    checks.push(checkExpectation(a.automate, c.expect?.automate, 'automate'));
  }

  if (c.given?.authorization) {
    const a = auth.check(c.given.authorization);
    outputs.authorization = a;
    checks.push(checkExpectation(a.allowed, c.expect?.authorization_allowed, 'authorization_allowed'));
  }

  if (c.given?.failure_signals) {
    const f = classify({ signals: c.given.failure_signals, evidenceIds: c.given.evidence_ids ?? [], history: c.given.history ?? [] });
    outputs.failure = f;
    checks.push(checkExpectation(f.class, c.expect?.failure_class, 'failure_class'));
    checks.push(checkExpectation(f.confidence, c.expect?.failure_confidence_at_most ? { at_most: c.expect.failure_confidence_at_most } : undefined, 'failure_confidence'));
  }

  const applied = checks.filter(Boolean);
  const passed = applied.filter((c) => c.pass).length;

  return {
    id: c.id,
    title: c.title,
    file: c.file,
    checks: applied,
    passed,
    total: applied.length,
    score: applied.length === 0 ? null : Number((passed / applied.length).toFixed(3)),
    outputs,
    reasoning_notes: c.reasoning_notes ?? [],
    not_covered: c.not_covered ?? [],
  };
}

export function run({ only = null } = {}) {
  const cases = loadCases().filter((c) => !only || c.id === only || c.file === only);
  if (cases.length === 0) throw new Error(only ? `No benchmark case matched "${only}".` : 'No benchmark cases found.');

  const results = cases.map(runCase);
  const totalChecks = results.reduce((a, r) => a + r.total, 0);
  const totalPassed = results.reduce((a, r) => a + r.passed, 0);
  const rubric = fs.existsSync(RUBRIC) ? readJson(RUBRIC) : null;

  return {
    ran_at: new Date().toISOString(),
    cases: results.length,
    checks: totalChecks,
    passed: totalPassed,
    score: totalChecks === 0 ? null : Number((totalPassed / totalChecks).toFixed(4)),
    failures: results.flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => ({ case: r.id, check: c.label, actual: c.actual, expected: c.expected }))),
    results,
    rubric_thresholds: rubric?.thresholds ?? null,
    caveat: 'This suite exercises the decision machinery on supplied inputs. It does not verify that the agent gathers correct inputs from a real repository -- that requires the live walkthroughs in examples/.',
  };
}
