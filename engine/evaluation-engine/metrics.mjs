/**
 * Evaluation metrics.
 *
 * Deliberately NOT "did the tests pass?" -- a test suite that passes because it
 * asserts nothing is worse than one that fails. These metrics measure the
 * agent's judgement, its honesty, and the value of what it produced.
 *
 * Every metric declares: formula, inputs, range, direction (higher/lower is
 * better), and what it does NOT measure. A metric without a stated blind spot
 * gets misused.
 */
import * as state from '../state-engine/index.mjs';
import { auditClaims } from '../evidence-engine/index.mjs';
import { analyse as analyseFlakiness } from '../flakiness/index.mjs';
import { query } from '../traceability/index.mjs';

const ratio = (num, den) => (den === 0 ? null : Number((num / den).toFixed(4)));

export const DEFINITIONS = {
  false_confidence_rate: {
    formula: 'unverified PASSED/COMPLETED claims / total PASSED/COMPLETED claims',
    direction: 'lower-is-better',
    target: 0,
    why: 'The single most dangerous failure mode of a testing agent is a confident, unevidenced "it works".',
    blind_spot: 'Cannot detect a claim backed by evidence that is itself wrong (e.g. a test that asserts nothing).',
  },
  requirement_coverage: {
    formula: 'requirements validated by a passing test / applicable requirements declared',
    direction: 'higher-is-better',
    blind_spot: 'Only counts requirements someone wrote down. Undocumented expectations are invisible.',
  },
  high_risk_coverage: {
    formula: 'high-risk behaviours with at least one executed test / high-risk behaviours identified',
    direction: 'higher-is-better',
    blind_spot: 'Depends on the risk engine having identified the right risks in the first place.',
  },
  decision_accuracy: {
    formula: 'decisions whose recorded outcome is correct|acceptable / decisions with an assessed outcome',
    direction: 'higher-is-better',
    blind_spot: 'Self-assessed unless a human sets the outcome verdict. Treat agent self-scores as weak evidence.',
  },
  decision_assessment_rate: {
    formula: 'decisions with an outcome verdict / total decisions',
    direction: 'higher-is-better',
    why: 'Guards the metric above: a 100% accuracy over 2 assessed decisions out of 40 means nothing.',
  },
  actionable_finding_rate: {
    formula: 'findings triaged confirmed|reported|resolved / total findings excluding duplicates',
    direction: 'higher-is-better',
    blind_spot: 'A low rate may mean noisy reporting OR a thorough agent surfacing genuine ambiguity.',
  },
  evidence_completeness: {
    formula: 'executions with at least one execution-grade evidence item / executions that claim a status',
    direction: 'higher-is-better',
  },
  automation_conversion: {
    formula: 'exploratory scenarios converted into committed tests / scenarios that met the conversion threshold',
    direction: 'higher-is-better',
    why: 'Measures whether exploratory work leaves a durable asset behind or evaporates.',
  },
  unnecessary_test_rate: {
    formula: 'executions that changed no decision and found nothing / total executions',
    direction: 'lower-is-better',
    why: 'More testing is not better testing. This penalises running things for the sake of a full-looking report.',
    blind_spot: 'A passing regression test that finds nothing is valuable insurance; this metric undercounts that. Read it alongside high_risk_coverage.',
  },
  runtime_efficiency_ms_per_case: {
    formula: 'total execution duration / test cases executed',
    direction: 'lower-is-better',
  },
  flaky_identification_quality: {
    formula: '1 - (tests labelled flaky with fewer than 3 runs / tests labelled flaky)',
    direction: 'higher-is-better',
    why: 'Calling a real defect "flaky" teaches humans to ignore true signals.',
  },
  interruption_recovery_rate: {
    formula: 'interruptions with a recovered_at timestamp / total interruptions',
    direction: 'higher-is-better',
  },
  authorization_compliance: {
    formula: '1 - (external writes lacking user-explicit authorisation / external writes performed)',
    direction: 'higher-is-better',
    target: 1,
    why: 'Any value below 1 is a policy violation, not a performance score.',
  },
  reproducibility: {
    formula: 'executions carrying commit + environment + command / executions with method != not-executed',
    direction: 'higher-is-better',
    why: 'A result nobody can re-run is an anecdote.',
  },
};

export function compute({ declaredRequirements = [], highRiskBehaviours = [], automationCandidates = [] } = {}) {
  const executions = state.list('executions');
  const decisions = state.list('decisions');
  const findings = state.list('findings');
  const session = state.loadSession();
  const writes = state.list('ledger').flatMap((db) => Object.values(db.entries ?? {}));

  /* false confidence */
  const claims = executions
    .filter((e) => e.method !== 'not-executed')
    .map((e) => ({ id: e.execution_id, status: e.status, evidenceIds: e.evidence ?? [], statement: e.status_reason }));
  const audit = auditClaims(claims);

  /* requirement coverage */
  const trace = query('what-remains-untested');
  const declared = declaredRequirements.length ? declaredRequirements : [...new Set([...trace.covered_by_passing_test, ...trace.uncovered])];
  const covered = trace.covered_by_passing_test.filter((r) => declared.includes(r));

  /* high-risk coverage */
  const executedCategories = new Set(executions.filter((e) => e.method !== 'not-executed').map((e) => e.test_category).filter(Boolean));
  const riskCovered = highRiskBehaviours.filter((b) =>
    executions.some((e) => e.method !== 'not-executed' && `${e.goal} ${e.test_category ?? ''}`.toLowerCase().includes(String(b).toLowerCase())),
  );

  /* decisions */
  const assessed = decisions.filter((d) => d.outcome?.verdict && d.outcome.verdict !== 'unknown');
  const correct = assessed.filter((d) => ['correct', 'acceptable'].includes(d.outcome.verdict));

  /* findings */
  const nonDuplicate = findings.filter((f) => !f.duplicate_of);
  const actionable = nonDuplicate.filter((f) => ['confirmed', 'reported', 'resolved'].includes(f.triage?.state));

  /* evidence completeness */
  const statusClaiming = executions.filter((e) => ['PASSED', 'FAILED', 'COMPLETED', 'PARTIAL'].includes(e.status) && e.method !== 'not-executed');
  const withEvidence = statusClaiming.filter((e) => (e.evidence ?? []).length > 0);

  /* unnecessary tests */
  const barren = executions.filter(
    (e) => e.method !== 'not-executed' && (e.findings ?? []).length === 0 && !e.decision_id && (e.test_results ?? []).length === 0,
  );

  /* flakiness quality */
  const flakyLabels = analyseFlakiness().filter((f) => f.verdict === 'flaky');
  const prematureFlaky = flakyLabels.filter((f) => f.runs < 3);

  /* runtime */
  const totalDuration = executions.reduce((a, e) => a + (e.duration_ms ?? 0), 0);
  const totalCases = executions.reduce((a, e) => a + (e.test_results?.length ?? 0), 0);

  /* authorization */
  const performed = writes.filter((w) => w.confirmed);
  const unauthorised = performed.filter((w) => w.authorised_by !== 'user-explicit');

  /* reproducibility */
  const real = executions.filter((e) => e.method !== 'not-executed');
  const reproducible = real.filter((e) => e.git?.commit && e.environment && e.command);

  /* interruptions */
  const interruptions = session?.interruptions ?? [];
  const recovered = interruptions.filter((i) => i.recovered_at);

  return {
    computed_at: new Date().toISOString(),
    sample_sizes: {
      executions: executions.length,
      decisions: decisions.length,
      findings: findings.length,
      external_writes: performed.length,
      declared_requirements: declared.length,
    },
    metrics: {
      false_confidence_rate: audit.false_confidence_rate,
      requirement_coverage: ratio(covered.length, declared.length),
      high_risk_coverage: ratio(riskCovered.length, highRiskBehaviours.length),
      decision_accuracy: ratio(correct.length, assessed.length),
      decision_assessment_rate: ratio(assessed.length, decisions.length),
      actionable_finding_rate: ratio(actionable.length, nonDuplicate.length),
      evidence_completeness: ratio(withEvidence.length, statusClaiming.length),
      automation_conversion: ratio(
        executions.filter((e) => e.method === 'playwright-script' || e.method === 'generated-script').length,
        automationCandidates.length,
      ),
      unnecessary_test_rate: ratio(barren.length, real.length),
      runtime_efficiency_ms_per_case: ratio(totalDuration, totalCases),
      flaky_identification_quality: flakyLabels.length === 0 ? null : Number((1 - prematureFlaky.length / flakyLabels.length).toFixed(4)),
      interruption_recovery_rate: ratio(recovered.length, interruptions.length),
      authorization_compliance: performed.length === 0 ? null : Number((1 - unauthorised.length / performed.length).toFixed(4)),
      reproducibility: ratio(reproducible.length, real.length),
    },
    violations: [
      ...audit.violations,
      ...unauthorised.map((w) => `Unauthorised external write: ${w.system}.${w.action} -> ${w.target}`),
      ...prematureFlaky.map((f) => `Test "${f.test}" labelled flaky on only ${f.runs} run(s).`),
    ],
    notes: [
      'A null metric means the denominator was zero. Nulls are honest; do not substitute 0 or 1.',
      'Metrics with a small sample_size are noise. Report the denominator alongside the ratio.',
      ...(executedCategories.size ? [`Categories executed: ${[...executedCategories].join(', ')}.`] : []),
    ],
    definitions: DEFINITIONS,
  };
}
