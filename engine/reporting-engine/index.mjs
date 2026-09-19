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
import { writeText, sha256String } from '../core/fsjson.mjs';
import { dir } from '../core/paths.mjs';
import * as state from '../state-engine/index.mjs';
import { auditClaims } from '../evidence-engine/index.mjs';
import { summarise } from '../execution-engine/index.mjs';
import { listWrites } from '../authorization/index.mjs';
import { compute } from '../evaluation-engine/metrics.mjs';
import { open as openUncertainties } from '../uncertainty-register/index.mjs';
import { check as checkProcessCompleteness } from '../evaluation-engine/process-completeness.mjs';

const STATUS_ORDER = ['FAILED', 'BLOCKED', 'NEEDS_USER_INPUT', 'INCONCLUSIVE', 'INTERRUPTED', 'PARTIAL', 'DEFERRED', 'SKIPPED', 'NOT_APPLICABLE', 'PASSED', 'COMPLETED'];

/**
 * Hash a report record's content, excluding its own digest field (which does not exist
 * yet when this is first called, and must not be part of what it certifies). Used
 * identically when SETTING the digest in `generate` and when RECOMPUTING it in `verify`,
 * so the two can never drift out of sync with each other.
 */
function digestOf(reportLike) {
  const { digest, ...rest } = reportLike;
  return sha256String(JSON.stringify(rest)); // already "sha256:<hex>" -- do not re-wrap it
}

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

  // The mechanical evidence gate (auditClaims, above) cannot catch everything: a vague
  // status reason, a screenshot standing in for an assertion, evidence that does not
  // actually show what it claims. The evidence-auditor subagent is the check for that, but
  // nothing forced it to run -- an agent under time pressure could finish a session without
  // it, and a report from that session looked identical to one where it ran and found
  // nothing. This does not force the subagent to run (no code path can -- launching it is
  // the orchestrating agent's own action), but it makes the omission visible rather than
  // silent: the record it leaves behind is `kind: 'evidence-audit'` evidence, filed the same
  // way any other observation is.
  const evidenceAuditorRun = evidence.some((e) => e.kind === 'evidence-audit');
  const claimsToAudit = executions.filter((e) => ['PASSED', 'FAILED', 'COMPLETED', 'PARTIAL'].includes(e.status)).length > 0;

  const id = nextId('report', now);
  const previous = session.last_report ?? null;

  // Two different kinds of "not tested", and they deserve different treatment.
  //
  // Work that was planned and did not happen is specific and actionable -- every item
  // gets its own line. Categories that do not apply are mostly one repeated sentence
  // ("no matching repository signal"), and listing thirty of them buries the handful of
  // items a reader actually needs. So those are grouped by reason, with the full list
  // kept in the appendix.
  const notTested = executions
    .filter((e) => ['BLOCKED', 'SKIPPED', 'DEFERRED', 'NOT_APPLICABLE', 'NEEDS_USER_INPUT'].includes(e.status))
    .map((e) => `${e.goal} — ${e.status}: ${e.status_reason}`);

  const notApplicable = applicability.filter((a) => !a.applicable);
  const byReason = new Map();
  for (const row of notApplicable) {
    const key = /no signal/i.test(row.reason)
      ? 'no matching repository signal'
      : /override/i.test(row.reason)
        ? 'excluded by explicit override'
        : 'other';
    if (!byReason.has(key)) byReason.set(key, []);
    byReason.get(key).push({ category: row.category, reason: row.reason });
  }
  const notApplicableSummary = {
    total: notApplicable.length,
    groups: [...byReason.entries()]
      .map(([reason, rows]) => ({ reason, count: rows.length, categories: rows.map((r) => r.category).sort() }))
      .sort((a, b) => b.count - a.count),
  };

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
      not_applicable_summary: notApplicableSummary,
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
      grade: e.grade ?? null,
      ...(e.artifact?.path ? { path: e.artifact.path } : {}),
      ...(e.artifact?.sha256 ? { sha256: e.artifact.sha256 } : {}),
    })),
    findings: findings.map((f) => f.finding_id),
    // Findings are embedded, not merely referenced. A report whose most important
    // section is a list of IDs forces the reader to go and look each one up, which in
    // practice means they do not. A stored report should also stay readable on its own
    // long after the state directory has moved on.
    finding_details: findings.map((f) => ({
      finding_id: f.finding_id,
      title: f.title,
      kind: f.kind,
      severity: f.severity,
      confidence: f.confidence,
      component: f.component || undefined,
      summary: f.summary || undefined,
      expected: f.reproduction?.expected || undefined,
      actual: f.reproduction?.actual || undefined,
      reproducible: f.reproduction?.reproducible || undefined,
      attempts: f.reproduction?.attempts,
      impact: f.impact || undefined,
      evidence: f.evidence ?? [],
      recommended_action: f.recommended_action || undefined,
      duplicate_of: f.duplicate_of || undefined,
      external_refs: f.external_refs ?? [],
    })),
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
    // Same principle as finding_details: a bare list of identifiers is a list of
    // lookups, and a reader does not perform them.
    uncertainty_details: uncertainties.map((u) => ({
      id: u.id,
      status: u.status,
      question: u.question,
      next_action: u.next_action,
      owner: u.owner ?? 'agent',
      affected_scope: u.affected_scope ?? [],
      resolved: u.status === 'resolved',
    })),
    coverage_gaps: (plan?.change_summary?.coverage_gaps ?? []).concat(
      applicability.filter((a) => a.applicable && a.existing_coverage === 'none').map((a) => `${a.category}: no existing coverage`),
    ),
    remaining_work: session.remaining_work ?? [],
    recommendations,
    decision_history: decisions.map((d) => d.decision_id),
    decision_summaries: decisions.map((d) => ({
      decision_id: d.decision_id,
      question: d.question,
      selected_option: d.selected_option,
      confidence: d.confidence,
      reversible: d.reversible,
      top_reason: d.reason?.[0] ?? '',
      outcome: d.outcome?.verdict ?? undefined,
    })),
    metrics,
    integrity: {
      unevidenced_pass_claims: audit.unevidenced_pass_claims,
      false_confidence_rate: audit.false_confidence_rate,
      // Counted, not asserted: a check over an empty set ("0 writes -- nothing to
      // check") is not the same claim as a check that found nothing wrong, and printing
      // the same four lines regardless of what ran made every report look equally
      // audited whether or not there was anything to audit.
      checks_run: [
        `every PASSED/COMPLETED claim checked against attached evidence (${audit.pass_claims} claim(s))`,
        `external writes checked for provider confirmation (${writes.length} write(s)${writes.length === 0 ? ' -- nothing to check' : ''})`,
        `unfinished executions surfaced as INTERRUPTED (${interrupted.length} found)`,
        `not-applicable categories listed with reasons (${notApplicable.length} categor${notApplicable.length === 1 ? 'y' : 'ies'})`,
      ],
      violations: audit.violations.concat(metrics.violations).concat(
        claimsToAudit && !evidenceAuditorRun
          ? ['No evidence-auditor record for this session (kind: evidence-audit). Claims here have only passed the mechanical evidence gate, not independent adversarial review.']
          : [],
      ).concat(
        // Process-completeness gaps are advisory mid-session (see process-completeness.mjs)
        // but by the time a report exists, the session is over -- there is no "still in
        // progress" excuse left, so every gap found is stated here regardless of severity.
        checkProcessCompleteness().map((f) => `[process:${f.severity}] ${f.message}`),
      ),
      evidence_auditor_run: evidenceAuditorRun,
    },
    provenance: provenance({ sessionId: session.session_id, skillName: 'test-reporting', now }),
  };

  if (session.git) report.git = session.git;
  if (previous) report.supersedes = previous;
  if (riskAssessment) report.risk_assessment = riskAssessment;
  if (applicability.length) report.applicable_categories = applicability;
  if (session.goals?.length) report.goals = session.goals;

  // The digest is computed over everything above -- including every field just
  // conditionally added -- and must be the LAST thing set before this record is stored or
  // rendered, or a conditional field added after it would go uncovered. See digestOf's own
  // comment for why it excludes itself and why generate/verify share it.
  report.digest = digestOf(report);

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


/* ------------------------------------------------------------- summarising */

const SEVERITY_ORDER = ['blocker', 'critical', 'major', 'minor', 'trivial'];
const SEVERITY_LABEL = {
  blocker: 'Blocker', critical: 'Critical', major: 'Major', minor: 'Minor', trivial: 'Trivial',
};

function headline({ overall, executions, findings, notTested }) {
  const real = executions.filter((e) => e.method !== 'not-executed').length;
  const actionable = findings.filter((f) => !f.duplicate_of && f.kind !== 'observation');
  const worst = actionable
    .map((f) => SEVERITY_ORDER.indexOf(f.severity))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];

  const parts = [`${real} execution${real === 1 ? '' : 's'} run`];
  if (actionable.length) {
    parts.push(`${actionable.length} finding${actionable.length === 1 ? '' : 's'}${worst !== undefined ? `, worst ${SEVERITY_ORDER[worst]}` : ''}`);
  } else {
    parts.push('no findings');
  }
  if (notTested.length) parts.push(`${notTested.length} planned item${notTested.length === 1 ? '' : 's'} not run`);
  return `**${overall}** — ${parts.join(' · ')}.`;
}

function keyPoints({ executions, findings, blocked, failed }) {
  const points = [];
  if (failed.length) points.push(`${failed.length} execution(s) failed — each carries a failure classification below.`);
  if (blocked.length) points.push(`${blocked.length} execution(s) blocked; their scope was NOT covered by anything else.`);
  const high = findings.filter((f) => ['blocker', 'critical'].includes(f.severity) && !f.duplicate_of);
  if (high.length) points.push(`${high.length} finding(s) at critical severity or above.`);
  const lowConfidence = findings.filter((f) => f.confidence < 0.6 && !f.duplicate_of);
  if (lowConfidence.length) points.push(`${lowConfidence.length} finding(s) carry low confidence and need human confirmation before action.`);
  if (points.length === 0) {
    points.push('No failures, no blockers and no findings were recorded. Check "What was not tested" before reading this as a clean bill of health.');
  }
  return points;
}

/* ------------------------------------------------------------------ render */

/**
 * The report is rendered as an inverted pyramid: verdict, then what needs action, then
 * what was proven, then the gaps, then supporting detail, then reference material.
 *
 * Two rules do most of the work:
 *
 *   1. An empty section is not rendered. A heading over nothing trains the reader to
 *      skim past headings, which then hides the sections that DO have content.
 *   2. Findings are rendered with their content, not as a list of identifiers. The most
 *      important section of a testing report should not be a set of lookups.
 */

function table(rows, headers) {
  if (!rows.length) return '';
  const cell = (c) => String(c ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

function bullets(items, mapper = (x) => x) {
  return items.length ? items.map((i) => `- ${mapper(i)}`).join('\n') : '';
}

/** Render a section only when it has something to say. */
function section(heading, body, { level = 2 } = {}) {
  const content = Array.isArray(body) ? body.filter(Boolean).join('\n\n') : body;
  if (!content || !String(content).trim()) return '';
  return `${'#'.repeat(level)} ${heading}\n\n${String(content).trim()}`;
}

function shortDate(iso) {
  return typeof iso === 'string' ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : iso;
}

/** One finding, rendered so a reader can act on it without opening anything else. */
function renderFinding(f) {
  const meta = [
    f.component ? `\`${f.component}\`` : null,
    f.reproducible ? `reproduced ${f.attempts ? `${f.attempts}/${f.attempts}` : ''} (${f.reproducible})`.replace('  ', ' ') : null,
    `confidence ${f.confidence}`,
    f.kind !== 'defect' ? f.kind : null,
  ].filter(Boolean).join(' · ');

  const lines = [`#### ${f.finding_id} — ${f.title}`, '', meta, ''];

  if (f.confidence < 0.6) {
    lines.push(`> **Low confidence (${f.confidence}).** This may not be a defect. Confirm before acting.`, '');
  }
  if (f.summary) lines.push(f.summary, '');
  if (f.expected || f.actual) {
    lines.push(table(
      [[f.expected ?? '_not stated_', f.actual ?? '_not stated_']],
      ['Expected', 'Actual'],
    ), '');
  }
  if (f.impact) lines.push(`**Impact.** ${f.impact}`, '');
  if (f.recommended_action) lines.push(`**Next.** ${f.recommended_action}`, '');

  const refs = [
    f.evidence?.length ? `Evidence: ${f.evidence.join(', ')}` : 'Evidence: _none captured_',
    ...(f.external_refs ?? []).map((x) => `${x.system}: ${x.url ?? x.id}`),
  ];
  lines.push(`_${refs.join(' · ')}_`);
  return lines.join('\n');
}

export function render(r) {
  const out = [];
  const add = (s) => { if (s && s.trim()) out.push(s.trim()); };

  const details = r.finding_details ?? [];
  const actionable = details.filter((f) => !f.duplicate_of && f.kind !== 'observation');
  const observations = details.filter((f) => f.kind === 'observation' && !f.duplicate_of);
  const duplicates = details.filter((f) => f.duplicate_of);

  /* ---------------------------------------------------------------- header */

  add(`# Testing Report · ${r.report_id}`);
  add(r.executive_summary.headline);

  const git = r.git ?? {};
  add(table([[
    r.session_id,
    git.repository ? `${git.repository}${git.branch ? ` (${git.branch})` : ''}` : '—',
    git.commit ?? '—',
    git.pull_request ?? '—',
    shortDate(r.generated_at),
    `v${r.provenance.skill_version}`,
  ]], ['Session', 'Repository', 'Commit', 'PR', 'Generated', 'Skill']));

  if (r.supersedes) add(`_Supersedes ${r.supersedes}._`);

  /* ------------------------------------------------------------- 1. verdict */

  add(section('Verdict', bullets(r.executive_summary.key_points)));

  /* ---------------------------------------------------- 2. needs attention */

  if (actionable.length) {
    const groups = SEVERITY_ORDER
      .map((sev) => ({ sev, items: actionable.filter((f) => f.severity === sev) }))
      .filter((g) => g.items.length);

    const body = [
      table(
        groups.map((g) => [SEVERITY_LABEL[g.sev], g.items.length, g.items.map((f) => f.finding_id).join(', ')]),
        ['Severity', 'Count', 'Findings'],
      ),
      ...groups.flatMap((g) => [
        `### ${SEVERITY_LABEL[g.sev]}`,
        ...g.items.map(renderFinding),
      ]),
    ];
    add(section('Needs attention', body));
  }

  /* ------------------------------------------------------ 3. what was proven */

  const proven = (r.detailed_results ?? []).filter((d) => ['PASSED', 'COMPLETED'].includes(d.status));
  if (proven.length) {
    // This sentence must never assert a commit the report cannot actually name -- it did,
    // unconditionally, before git provenance was ever auto-captured (see core/git.mjs),
    // and a report with no commit still claimed traceability to one. Three honest states:
    // a real, clean commit; a real commit with the qualification that the tree had
    // uncommitted changes at capture time (which materially qualifies every result); or
    // no commit at all, stated plainly instead of asserted.
    const traceability = r.git?.commit
      ? r.git.dirty
        ? `_Every row above executed against commit \`${r.git.commit.slice(0, 7)}\` **with uncommitted changes in the working tree** at the time -- these results are not fixed against a stable, committed point -- and is backed by the evidence cited. Nothing else in this report is a claim that something works._`
        : '_Every row above executed against the commit named at the top and is backed by the evidence cited. Nothing else in this report is a claim that something works._'
      : '_No commit was recorded for this session, so these results are not traceable to a fixed point in the codebase -- only to the evidence cited. Nothing else in this report is a claim that something works._';
    add(section('What was proven', [
      table(
        proven.map((d) => [d.execution_id, d.goal, d.category ?? '—', d.method, (d.evidence ?? []).join(', ') || '—']),
        ['Execution', 'What was checked', 'Category', 'Method', 'Evidence'],
      ),
      traceability,
    ]));
  }

  /* ------------------------------------------------------- 4. not tested */

  const na = r.executive_summary.not_applicable_summary;
  const notTestedBody = [
    r.executive_summary.what_was_not_tested?.length
      ? ['**Planned, not run.**', '', bullets(r.executive_summary.what_was_not_tested)].join('\n')
      : '',
    na?.total
      ? ['**Not applicable to this repository.**', '',
        bullets(na.groups, (g) => `${g.count} categor${g.count === 1 ? 'y' : 'ies'} — ${g.reason}: ${g.categories.join(', ')}`),
      ].join('\n')
      : '',
    (r.coverage_gaps ?? []).length
      ? ['**Coverage gaps.**', '', bullets(r.coverage_gaps)].join('\n')
      : '',
  ];
  add(section('What was not tested', notTestedBody.length ? [
    '_Read this before drawing any conclusion from the results above._',
    ...notTestedBody,
  ] : ''));

  /* ------------------------------------------------- 5. open questions etc. */

  const openQuestions = (r.uncertainty_details ?? []).filter((u) => !u.resolved);
  add(section('Open questions', [
    table(
      openQuestions.map((u) => [u.id, u.status, u.question, u.next_action, u.owner]),
      ['ID', 'Status', 'Question', 'What would resolve it', 'Owner'],
    ),
    openQuestions.some((u) => u.owner === 'user')
      ? '_Questions owned by you are the only ones the agent cannot progress on its own._'
      : '',
  ]));
  add(section('Remaining work', table(
    (r.remaining_work ?? []).map((w) => [w.status, w.item, w.reason ?? '—', w.blocked_by ?? '—']),
    ['Status', 'Item', 'Why', 'Blocked by'],
  )));
  add(section('Recommended next', bullets(r.recommendations ?? [])));

  /* ------------------------------------------------------------- 6. detail */

  const detailBody = [
    section('Executions', [
      table(
        (r.detailed_results ?? []).map((d) => [
          d.execution_id, d.status, d.goal, d.method,
          // "unclassified-no-signals" means the caller supplied nothing to classify from
          // -- it is not a verdict on the finding, and printing it with a confidence
          // number invites reading it as one anyway. Suppressed to the same "—" as no
          // classification at all, rather than a confident-looking label for an absence.
          (d.failure_classification && d.failure_classification.class !== 'unclassified-no-signals')
            ? `${d.failure_classification.class} (${d.failure_classification.confidence})`
            : '—',
          d.duration_ms != null ? `${d.duration_ms} ms` : '—',
        ]),
        ['ID', 'Status', 'Goal', 'Method', 'Failure class', 'Duration'],
      ),
      table(
        Object.entries(r.execution_summary?.by_status ?? {}).map(([s, n]) => [s, n]),
        ['Status', 'Count'],
      ),
    ], { level: 3 }),

    section('Evidence', table(
      (r.evidence_index ?? []).map((e) => [
        e.evidence_id, e.kind, e.summary,
        e.grade === 'anchored' ? 'yes' : e.grade === 'asserted' ? 'no' : '—',
        e.path ?? e.sha256 ?? '—',
      ]),
      ['ID', 'Kind', 'Summary', 'Anchored?', 'Artifact'],
    ), { level: 3 }),

    section('External writes', [
      table(
        (r.external_writes ?? []).map((w) => [
          w.system, w.action, w.target ?? '—',
          w.confirmed ? 'CONFIRMED' : 'NOT CONFIRMED',
          w.authorised_by, w.url ?? w.result_id ?? '—',
        ]),
        ['System', 'Action', 'Target', 'Provider confirmation', 'Authorised by', 'Reference'],
      ),
      (r.external_writes ?? []).some((w) => !w.confirmed)
        ? '_An unconfirmed write means the agent attempted it and did not receive a success response. It is reported as attempted, never as done._'
        : '',
    ], { level: 3 }),

    section('Decisions', table(
      (r.decision_summaries ?? []).map((d) => [
        d.decision_id, d.question, d.selected_option, d.confidence,
        d.reversible ? 'yes' : 'no', d.outcome ?? '—', d.top_reason,
      ]),
      ['ID', 'Question', 'Chose', 'Confidence', 'Reversible', 'Outcome', 'Leading reason'],
    ), { level: 3 }),

    section('Observations', [
      '_Recorded for the reader, not filed as defects._',
      ...observations.map(renderFinding),
    ], { level: 3 }),

    section('Duplicates suppressed', bullets(duplicates, (f) => `${f.finding_id} — same fingerprint as ${f.duplicate_of}`), { level: 3 }),

    section('Automation added', table(
      (r.automation_added ?? []).map((a) => [a.path, a.kind, a.test_count ?? '—', a.converted_from ?? '—']),
      ['Path', 'Kind', 'Tests', 'Converted from'],
    ), { level: 3 }),
  ].filter(Boolean);

  if (detailBody.length) add(['---', '', section('Detail', detailBody)].join('\n'));

  /* ----------------------------------------------------------- 7. appendix */

  const ra = r.risk_assessment;
  const appendix = [
    ra ? section('Risk assessment', [
      `**${ra.risk_score}** (${ra.risk_level}) · profile \`${ra.weights_profile}\` · assessment confidence ${ra.confidence}`,
      table(
        ra.factors.map((f) => [f.factor, f.value, f.weight, f.contribution, f.epistemic_class, f.basis]),
        ['Factor', 'Value', 'Weight', 'Contribution', 'Basis', 'Why'],
      ),
      ra.unscored_factors?.length
        ? `_Excluded for lack of evidence — not scored, not guessed: ${ra.unscored_factors.join(', ')}._`
        : '',
    ], { level: 3 }) : '',

    section('Test applicability matrix', table(
      (r.applicable_categories ?? []).map((a) => [
        a.category, a.applicable ? 'yes' : 'no', a.priority, a.existing_coverage, a.score, a.reason,
      ]),
      ['Category', 'Applicable', 'Priority', 'Coverage', 'Score', 'Reason'],
    ), { level: 3 }),

    section('Goals', table(
      (r.goals ?? []).flatMap((g) =>
        (g.success_criteria?.length ? g.success_criteria : [{ criterion: '_no criteria declared_', status: g.status }])
          .map((c) => [g.id, g.goal, c.criterion, c.status, (c.evidence ?? []).join(', ') || '—'])),
      ['Goal', 'Description', 'Success criterion', 'Status', 'Evidence'],
    ), { level: 3 }),

    section('Evaluation metrics', [
      table(
        Object.entries(r.metrics?.metrics ?? {}).map(([k, v]) => [
          k,
          v === null ? '_n/a (zero denominator)_' : v,
          r.metrics?.denominators?.[k] ?? '—',
          r.metrics?.noisy_metrics?.includes(k) ? `⚠️ below noise floor (${r.metrics.noise_floor})` : '',
          r.metrics.definitions?.[k]?.direction ?? '',
        ]),
        ['Metric', 'Value', 'n', 'Noise', 'Direction'],
      ),
      `_A null means the denominator was zero — honest, and not to be read as 0. A ⚠️ means the denominator is real but thin (n < ${r.metrics?.noise_floor ?? 5}); read that value qualitatively, not as a ratio._`,
    ], { level: 3 }),

    section('Integrity self-audit', [
      table(
        [[r.integrity.unevidenced_pass_claims, r.integrity.false_confidence_rate, r.integrity.evidence_auditor_run ? 'yes' : 'no']],
        ['Unevidenced PASSED claims', 'False confidence rate', 'evidence-auditor ran'],
      ),
      r.integrity.violations.length
        ? ['**Violations detected:**', '', bullets(r.integrity.violations)].join('\n')
        : '_No integrity violations detected in this report._',
      ['**Checks run:**', '', bullets(r.integrity.checks_run)].join('\n'),
    ], { level: 3 }),
  ].filter(Boolean);

  if (appendix.length) add(['---', '', section('Appendix', appendix)].join('\n'));

  add(`---\n\nProduced by the Autonomous Software Testing skill system v${SYSTEM_VERSION}. Every status above is traceable to a record under \`state/\`.`);

  // Absent only for a record generated before this field existed -- a report generated by
  // this build always carries one. See digestOf's comment and `verify` below: this line is
  // the entire mechanism by which a hand-written or hand-edited report is distinguishable
  // from one this system actually rendered.
  if (r.digest) {
    add(`_Rendered from ${r.report_id} · digest \`${r.digest}\` · verify with \`ast report verify\`. A report with no digest line was not produced by this system._`);
  }

  return `${out.join('\n\n')}\n`;
}

/**
 * Prove that a rendered report was actually produced by this system's own renderer, not
 * hand-written, hand-edited after rendering, or copied from a state directory that no
 * longer has the record it claims. This is the mechanism behind the orchestrator's rule
 * that the report handed to a user is the one the CLI rendered -- a rule that a field
 * trial's session violated (a hand-written report, back-filled into state afterwards)
 * with nothing anywhere able to say so.
 *
 * Three ways this can fail, checked in the order a reader would actually hit them:
 *
 *  1. No title line in the expected shape at all -- does not look like this system's
 *     output (a hand-written report with different headings, for instance).
 *  2. The title names a report_id with no matching stored record, or a stored record
 *     with no digest, or a stored digest that does not match the record's own content
 *     (the record was altered on disk after being written).
 *  3. Re-rendering the stored record does not reproduce the given text byte for byte --
 *     the actual threat: the text was hand-written, or edited after being rendered.
 *
 * Deliberately NOT a signature: there is no secret to hold and no adversary this defends
 * against, only a capable agent under delivery pressure taking a convenient shortcut. A
 * hash the agent itself could recompute is exactly the right amount of ceremony for that.
 *
 * @param {string} text  The rendered Markdown, exactly as it would be delivered.
 * @returns {{rendered: boolean, report_id?: string, reason?: string, first_diff_line?: number, digest?: string}}
 */
export function verify(text) {
  const titleMatch = /^# Testing Report · (REPORT-\d{4}-\d{5,})/m.exec(text);
  if (!titleMatch) {
    return {
      rendered: false,
      reason: 'No report title line found (expected "# Testing Report · REPORT-...") -- this does not look like a report this system produced.',
    };
  }
  const reportId = titleMatch[1];

  const stored = state.get('reports', reportId);
  if (!stored) {
    return {
      rendered: false,
      report_id: reportId,
      reason: `No stored record for ${reportId} under state/reports/ -- it cannot be verified against state it does not exist in.`,
    };
  }

  if (!stored.digest) {
    return {
      rendered: false,
      report_id: reportId,
      reason: `Stored record for ${reportId} carries no digest -- it predates this check, or was written by something other than this renderer.`,
    };
  }

  const recomputed = digestOf(stored);
  if (recomputed !== stored.digest) {
    return {
      rendered: false,
      report_id: reportId,
      reason: `Stored record's digest does not match its own content (stored ${stored.digest}, recomputed ${recomputed}). The stored record was altered after being written.`,
    };
  }

  const rerendered = render(stored);
  // Normalise CRLF to LF before comparing text, never before hashing (the digest above
  // covers the JSON record, not rendered text, so line endings never touch it). writeText
  // always writes LF-only; a CRLF-converted file most often means an incidental tool
  // (an editor, a checkout with autocrlf) touched line endings, not that anyone edited the
  // content -- normalising here keeps that distinct from an actual edit, which this must
  // still catch.
  const normalise = (s) => s.replace(/\r\n/g, '\n');
  if (normalise(rerendered) !== normalise(text)) {
    const given = normalise(text).split('\n');
    const fresh = normalise(rerendered).split('\n');
    let firstDiff = 0;
    while (firstDiff < Math.min(given.length, fresh.length) && given[firstDiff] === fresh[firstDiff]) firstDiff += 1;
    return {
      rendered: false,
      report_id: reportId,
      reason: 'Re-rendering the stored record does not reproduce this text byte for byte. Either this file was not produced by the renderer, or it was edited after being rendered.',
      first_diff_line: firstDiff + 1,
    };
  }

  return { rendered: true, report_id: reportId, digest: stored.digest };
}
