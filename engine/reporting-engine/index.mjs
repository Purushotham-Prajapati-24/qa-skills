/**
 * Reporting Engine.
 *
 * The Markdown report is RENDERED from the JSON report, which is itself derived
 * from records on disk. Nothing is hand-written. That is the mechanism that
 * stops polished prose from outrunning the evidence: if a claim is not in the
 * data, there is no code path that puts it in the document.
 *
 * Every report carries an `integrity` block stating its own false-confidence
 * rate. A report that cannot audit itself is not trustworthy.
 */
import path from 'node:path';
import { nextId } from '../core/ids.mjs';
import { provenance, DOC_VERSIONS, SYSTEM_VERSION } from '../core/version.mjs';
import { writeText } from '../core/fsjson.mjs';
import { dir } from '../core/paths.mjs';
import * as state from '../state-engine/index.mjs';
import { auditClaims } from '../evidence-engine/index.mjs';
import { summarise } from '../execution-engine/index.mjs';
import { listWrites } from '../authorization/index.mjs';
import { compute } from '../evaluation-engine/metrics.mjs';
import { open as openUncertainties } from '../uncertainty-register/index.mjs';

const STATUS_ORDER = ['FAILED', 'BLOCKED', 'NEEDS_USER_INPUT', 'INCONCLUSIVE', 'INTERRUPTED', 'PARTIAL', 'DEFERRED', 'SKIPPED', 'NOT_APPLICABLE', 'PASSED', 'COMPLETED'];

export function generate({ plan = null, riskAssessment = null, applicability = [], recommendations = [], now = new Date() } = {}) {
  const session = state.requireSession();
  const executions = state.list('executions');
  const findings = state.list('findings');
  const evidence = state.list('evidence');
  const decisions = state.list('decisions');
  const writes = listWrites();
  const uncertainties = state.list('uncertainties');

  const claims = executions
    .filter((e) => e.method !== 'not-executed')
    .map((e) => ({ id: e.execution_id, status: e.status, evidenceIds: e.evidence ?? [], statement: e.status_reason }));
  const audit = auditClaims(claims);

  const id = nextId('report', now);
  const previous = session.last_report ?? null;

  const notTested = [
    ...applicability.filter((a) => !a.applicable).map((a) => `${a.category}: ${a.reason}`),
    ...executions.filter((e) => ['BLOCKED', 'SKIPPED', 'DEFERRED', 'NOT_APPLICABLE', 'NEEDS_USER_INPUT'].includes(e.status)).map((e) => `${e.goal} — ${e.status}: ${e.status_reason}`),
  ];

  const failed = executions.filter((e) => e.status === 'FAILED');
  const blocked = executions.filter((e) => ['BLOCKED', 'NEEDS_USER_INPUT'].includes(e.status));
  const interrupted = executions.filter((e) => e.status === 'INTERRUPTED');
  const deferred = executions.filter((e) => e.status === 'DEFERRED');

  const overall = failed.length ? 'FAILED'
    : blocked.length ? 'PARTIAL'
    : interrupted.length ? 'INTERRUPTED'
    : executions.some((e) => e.status === 'PASSED' || e.status === 'COMPLETED') ? 'COMPLETED'
    : 'INCONCLUSIVE';

  const metrics = compute({
    declaredRequirements: (plan?.requirements ?? []).map((r) => r.id),
    highRiskBehaviours: (riskAssessment?.factors ?? []).filter((f) => f.value >= 0.7).map((f) => f.factor),
    automationCandidates: (plan?.scenarios ?? []).filter((s) => s.obligation === 'must-test'),
  });

  const report = {
    report_id: id,
    report_version: DOC_VERSIONS.report,
    generated_at: now.toISOString(),
    session_id: session.session_id,
    executive_summary: {
      headline: headline({ overall, executions, findings, notTested }),
      overall_status: overall,
      confidence: Number((1 - audit.false_confidence_rate).toFixed(2)),
      key_points: keyPoints({ executions, findings, blocked, failed }),
      what_was_not_tested: notTested,
    },
    execution_summary: { ...summarise() },
    detailed_results: executions
      .slice()
      .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))
      .map((e) => ({
        execution_id: e.execution_id,
        goal: e.goal,
        category: e.test_category ?? null,
        method: e.method,
        status: e.status,
        status_reason: e.status_reason,
        duration_ms: e.duration_ms ?? null,
        evidence: e.evidence ?? [],
        findings: e.findings ?? [],
        failure_classification: e.failure_classification ?? null,
        decision_id: e.decision_id ?? null,
      })),
    evidence_index: evidence.map((e) => ({
      evidence_id: e.evidence_id,
      kind: e.kind,
      summary: e.summary,
      ...(e.artifact?.path ? { path: e.artifact.path } : {}),
      ...(e.artifact?.sha256 ? { sha256: e.artifact.sha256 } : {}),
    })),
    findings: findings.map((f) => f.finding_id),
    external_writes: writes.map((w) => ({
      system: w.system,
      action: w.action,
      target: w.target,
      result_id: w.result_id ?? undefined,
      url: w.url ?? undefined,
      confirmed: Boolean(w.confirmed),
      authorised_by: w.authorised_by,
      ...(w.decision_id ? { decision_id: w.decision_id } : {}),
    })),
    blocked_work: blocked.map((e) => ({ execution_id: e.execution_id, goal: e.goal, reason: e.status_reason })),
    deferred_work: deferred.map((e) => ({ execution_id: e.execution_id, goal: e.goal, reason: e.status_reason })),
    interrupted_work: interrupted.map((e) => ({ execution_id: e.execution_id, goal: e.goal, reason: e.status_reason })),
    uncertainty_register: uncertainties.map((u) => u.id),
    coverage_gaps: (plan?.change_summary?.coverage_gaps ?? []).concat(
      applicability.filter((a) => a.applicable && a.existing_coverage === 'none').map((a) => `${a.category}: no existing coverage`),
    ),
    remaining_work: session.remaining_work ?? [],
    recommendations,
    decision_history: decisions.map((d) => d.decision_id),
    metrics,
    integrity: {
      unevidenced_pass_claims: audit.unevidenced_pass_claims,
      false_confidence_rate: audit.false_confidence_rate,
      checks_run: [
        'every PASSED/COMPLETED claim checked against attached evidence',
        'external writes checked for provider confirmation',
        'unfinished executions surfaced as INTERRUPTED',
        'not-applicable categories listed with reasons',
      ],
      violations: audit.violations.concat(metrics.violations),
    },
    provenance: provenance({ sessionId: session.session_id, skillName: 'test-reporting', now }),
  };

  if (session.git) report.git = session.git;
  if (previous) report.supersedes = previous;
  if (riskAssessment) report.risk_assessment = riskAssessment;
  if (applicability.length) report.applicable_categories = applicability;
  if (session.goals?.length) report.goals = session.goals;

  state.put('reports', id, report, 'report');
  state.update((s) => {
    s.last_report = id;
    return s;
  }, now);

  const md = render(report);
  const mdPath = writeText(path.join(dir('reports'), `${id}.md`), md);

  state.telemetry({ event: 'report', report_id: id, overall, false_confidence_rate: audit.false_confidence_rate });
  return { report, markdown: md, markdown_path: mdPath };
}

function headline({ overall, executions, findings, notTested }) {
  const real = executions.filter((e) => e.method !== 'not-executed').length;
  const defects = findings.filter((f) => f.kind === 'defect' && !f.duplicate_of).length;
  return `${overall}: ${real} execution(s) run, ${defects} defect finding(s), ${notTested.length} item(s) explicitly not tested.`;
}

function keyPoints({ executions, findings, blocked, failed }) {
  const points = [];
  if (failed.length) points.push(`${failed.length} execution(s) failed — see Detailed Results for the failure classification of each.`);
  if (blocked.length) points.push(`${blocked.length} execution(s) blocked; their scope was NOT covered by anything else.`);
  const high = findings.filter((f) => ['blocker', 'critical'].includes(f.severity) && !f.duplicate_of);
  if (high.length) points.push(`${high.length} finding(s) at critical severity or above.`);
  const lowConfidence = findings.filter((f) => f.confidence < 0.6);
  if (lowConfidence.length) points.push(`${lowConfidence.length} finding(s) carry low confidence and need human confirmation before action.`);
  if (points.length === 0) points.push('No failures, no blockers and no findings were recorded. Check the "what was not tested" list before reading this as a clean bill of health.');
  return points;
}

/* ------------------------------------------------------------------ render */

function table(rows, headers) {
  if (!rows.length) return '_None._\n';
  const out = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const r of rows) out.push(`| ${r.map((c) => String(c ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`);
  return `${out.join('\n')}\n`;
}

export function render(r) {
  const L = [];
  const push = (...lines) => L.push(...lines, '');

  push(`# Software Testing Report — ${r.report_id}`);
  push(
    `**Status:** ${r.executive_summary.overall_status} · **Session:** ${r.session_id} · **Generated:** ${r.generated_at}`,
    `**Skill version:** v${r.provenance.skill_version} · **Report schema:** v${r.report_version}${r.supersedes ? ` · **Supersedes:** ${r.supersedes}` : ''}`,
  );

  push('## 1. Executive summary', r.executive_summary.headline, '',
    ...r.executive_summary.key_points.map((p) => `- ${p}`));

  if (r.executive_summary.what_was_not_tested.length) {
    push('### What was NOT tested', '_This section is not an appendix. Read it before drawing any conclusion from the results above._', '',
      ...r.executive_summary.what_was_not_tested.map((p) => `- ${p}`));
  }

  if (r.git) {
    push('## 2. Repository context',
      table([[r.git.repository, r.git.branch ?? '—', r.git.commit ?? '—', r.git.pull_request ?? '—', r.git.dirty ? 'yes' : 'no']],
        ['Repository', 'Branch', 'Commit', 'PR', 'Uncommitted changes']));
  }

  if (r.goals?.length) {
    push('## 3. Testing goals',
      table(r.goals.flatMap((g) => (g.success_criteria?.length ? g.success_criteria : [{ criterion: '(no criteria declared)', status: g.status }])
        .map((c) => [g.id, g.goal, c.criterion, c.status, (c.evidence ?? []).join(', ') || '—'])),
        ['Goal', 'Description', 'Success criterion', 'Status', 'Evidence']));
  }

  if (r.risk_assessment) {
    const ra = r.risk_assessment;
    push('## 4. Risk assessment',
      `**Score:** ${ra.risk_score} (${ra.risk_level}) · **Profile:** ${ra.weights_profile} · **Assessment confidence:** ${ra.confidence}`,
      '', table(ra.factors.map((f) => [f.factor, f.value, f.weight, f.contribution, f.epistemic_class, f.basis]),
        ['Factor', 'Value', 'Weight', 'Contribution', 'Basis class', 'Why']));
    if (ra.unscored_factors?.length) {
      push(`_Excluded for lack of evidence (not scored, not guessed): ${ra.unscored_factors.join(', ')}._`);
    }
  }

  if (r.applicable_categories?.length) {
    push('## 5. Test applicability matrix',
      table(r.applicable_categories.map((a) => [a.category, a.applicable ? 'yes' : 'no', a.priority, a.existing_coverage, a.score, a.reason]),
        ['Category', 'Applicable', 'Priority', 'Existing coverage', 'Score', 'Reason']));
  }

  push('## 6. Execution summary',
    table(Object.entries(r.execution_summary.by_status ?? {}).map(([s, n]) => [s, n]), ['Status', 'Count']),
    `Total executions: ${r.execution_summary.executions} · Test cases: ${r.execution_summary.test_cases} · Wall clock: ${r.execution_summary.total_duration_ms} ms`);

  push('## 7. Detailed results',
    table(r.detailed_results.map((d) => [
      d.execution_id, d.goal, d.category ?? '—', d.method, d.status,
      d.failure_classification ? `${d.failure_classification.class} (${d.failure_classification.confidence})` : '—',
      (d.evidence ?? []).join(', ') || '—',
    ]), ['Execution', 'Goal', 'Category', 'Method', 'Status', 'Failure class', 'Evidence']));

  push('## 8. Evidence index',
    table(r.evidence_index.map((e) => [e.evidence_id, e.kind, e.summary, e.path ?? e.sha256 ?? '—']),
      ['ID', 'Kind', 'Summary', 'Artifact']));

  push('## 9. Findings', r.findings.length ? r.findings.map((f) => `- ${f}`).join('\n') : '_No findings recorded._');

  push('## 10. External writes',
    table(r.external_writes.map((w) => [w.system, w.action, w.target ?? '—', w.confirmed ? 'CONFIRMED' : 'NOT CONFIRMED', w.authorised_by, w.url ?? w.result_id ?? '—']),
      ['System', 'Action', 'Target', 'Provider confirmation', 'Authorised by', 'Reference']),
    '_An unconfirmed write means the agent attempted it and did not receive a success response. It is reported as attempted, never as done._');

  push('## 11. Blocked work', table(r.blocked_work.map((b) => [b.execution_id, b.goal, b.reason]), ['Execution', 'Goal', 'Reason']));
  push('## 12. Deferred work', table(r.deferred_work.map((b) => [b.execution_id, b.goal, b.reason]), ['Execution', 'Goal', 'Reason']));
  push('## 13. Interrupted work', table(r.interrupted_work.map((b) => [b.execution_id, b.goal, b.reason]), ['Execution', 'Goal', 'Reason']));

  push('## 14. Uncertainty register', r.uncertainty_register.length ? r.uncertainty_register.map((u) => `- ${u}`).join('\n') : '_No open uncertainties._');
  push('## 15. Coverage gaps', r.coverage_gaps.length ? r.coverage_gaps.map((c) => `- ${c}`).join('\n') : '_None identified. Note: "none identified" is not "none exist"._');
  push('## 16. Remaining work', table((r.remaining_work ?? []).map((w) => [w.item, w.status, w.reason ?? '—']), ['Item', 'Status', 'Reason']));
  push('## 17. Recommendations', r.recommendations.length ? r.recommendations.map((c) => `- ${c}`).join('\n') : '_None._');
  push('## 18. Decision history', r.decision_history.length ? r.decision_history.map((d) => `- ${d}`).join('\n') : '_No decisions recorded._');

  const m = r.metrics?.metrics ?? {};
  push('## 19. Evaluation metrics',
    table(Object.entries(m).map(([k, v]) => [k, v === null ? 'n/a (zero denominator)' : v, r.metrics.definitions?.[k]?.direction ?? '']),
      ['Metric', 'Value', 'Direction']),
    `_Sample sizes: ${JSON.stringify(r.metrics?.sample_sizes ?? {})}_`);

  push('## 20. Report integrity self-audit',
    table([[r.integrity.unevidenced_pass_claims, r.integrity.false_confidence_rate]],
      ['Unevidenced PASSED claims', 'False confidence rate']),
    ...(r.integrity.violations.length
      ? ['**Violations detected:**', ...r.integrity.violations.map((v) => `- ${v}`)]
      : ['_No integrity violations detected in this report._']),
    '', '**Checks run:**', ...r.integrity.checks_run.map((c) => `- ${c}`));

  push('---',
    `Produced by the Autonomous Software Testing skill system v${SYSTEM_VERSION}. Every status in this document is traceable to a record under \`state/\`.`);

  return L.join('\n');
}
