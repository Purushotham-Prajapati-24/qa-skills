/**
 * Defect Engine.
 *
 * Turns observations into findings, fingerprints them so the same defect never
 * becomes three issues, and renders the issue body. It deliberately does NOT
 * create the issue -- that crosses an authorization boundary and belongs to the
 * GitHub adapter, gated by engine/authorization.
 *
 * Promotion rules (a finding may become an issue only when):
 *   - it is reproducible or its non-reproducibility is stated in the body,
 *   - confidence is at or above the reporting threshold, or the uncertainty is
 *     spelled out in the issue itself,
 *   - it is not a duplicate of an already-filed finding.
 */
import { nextId } from '../core/ids.mjs';
import { provenance } from '../core/version.mjs';
import { sha256String } from '../core/fsjson.mjs';
import * as state from '../state-engine/index.mjs';
import * as auth from '../authorization/index.mjs';
import { inheritedGit } from '../core/git.mjs';

/** Below this, a finding is an observation to discuss, not an issue to file. */
export const REPORTING_CONFIDENCE_THRESHOLD = 0.6;

const SEVERITY_ORDER = ['trivial', 'minor', 'major', 'critical', 'blocker'];

function normaliseTitle(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Stable identity for a defect, independent of wording drift between runs. */
export function fingerprint({ component = '', title = '', expected = '', actual = '' }) {
  return sha256String([component, normaliseTitle(title), normaliseTitle(expected), normaliseTitle(actual)].join('|'));
}

export function create({
  title,
  kind = 'defect',
  severity = 'major',
  confidence,
  epistemicClass = 'observed',
  summary = '',
  component = '',
  environment = '',
  reproduction = null,
  impact = '',
  // No default: see core/git.mjs -- an omitted key inherits the session's git info; an
  // explicit `git: null` must stay distinguishable from "not supplied".
  git,
  evidence = [],
  relatedRequirements = [],
  recommendedAction = '',
  executionId = null,
  skillName = 'defect-reporting',
  now = new Date(),
} = {}) {
  if (typeof confidence !== 'number') {
    throw new Error('A finding must carry a confidence. Unquantified certainty is how false defect reports happen.');
  }
  const session = state.loadSession();
  const id = nextId('finding', now);
  const fp = fingerprint({ component, title, expected: reproduction?.expected, actual: reproduction?.actual });

  const existing = state.list('findings').find((f) => f.fingerprint === fp);

  const rec = {
    finding_id: id,
    timestamp: now.toISOString(),
    title,
    kind,
    severity,
    confidence,
    epistemic_class: epistemicClass,
    summary,
    component,
    environment,
    impact,
    evidence,
    related_requirements: relatedRequirements,
    recommended_action: recommendedAction,
    fingerprint: fp,
    triage: { state: 'new', decided_by: 'agent' },
    provenance: provenance({ sessionId: session?.session_id, skillName, now }),
  };
  if (session) rec.session_id = session.session_id;
  if (executionId) rec.execution_id = executionId;
  const gitInfo = inheritedGit(git, session);
  if (gitInfo) rec.git = gitInfo;
  if (reproduction) rec.reproduction = reproduction;
  if (existing) {
    rec.duplicate_of = existing.finding_id;
    rec.triage.state = 'confirmed';
    rec.triage.note = `Same fingerprint as ${existing.finding_id}; recorded for traceability but must not be filed again.`;
  }

  state.put('findings', id, rec, 'finding');
  if (session) {
    state.update((s) => {
      s.findings.push(id);
      return s;
    }, now);
  }
  // Back-link into the execution's OWN findings[], not just the session's. Findings are
  // naturally identified after an execution finishes (finish, then analyse, then file),
  // so this is the only point at which the link can be made without forcing the wrong
  // order -- exec finish's own findings[] parameter exists for the (rarer) case where
  // they are already known at finish time, and this appends to whatever it already set
  // rather than requiring one path or the other. Silently does nothing if executionId
  // names an execution that does not exist; this function has never validated that and
  // adding the requirement now would be a second, unrelated change.
  if (executionId) {
    const exec = state.get('executions', executionId);
    if (exec) {
      exec.findings = [...(exec.findings ?? []), id];
      state.put('executions', executionId, exec, 'execution');
    }
  }
  state.telemetry({ event: 'finding', finding_id: id, kind, severity, confidence, duplicate_of: rec.duplicate_of ?? null });
  return rec;
}

/**
 * May this finding be filed as an external issue right now?
 * Combines duplicate suppression, confidence, reproducibility and authorization.
 */
export function assessPromotion(findingId, { system = 'github', userAuthorised = false, authorisationQuote = '', assignee = null } = {}) {
  const f = state.get('findings', findingId);
  if (!f) throw new Error(`No such finding: ${findingId}`);

  const blockers = [];
  const warnings = [];

  if (f.duplicate_of) {
    blockers.push(`Duplicate of ${f.duplicate_of} (identical fingerprint). Comment on the existing issue instead.`);
  }

  const dup = auth.alreadyWritten({ system, action: `${system}.create_issue`, idempotencyKey: f.fingerprint });
  if (dup.duplicate) blockers.push(dup.reason);
  else if (dup.previous) warnings.push(dup.reason);

  if (f.kind === 'observation') {
    blockers.push('Kind is "observation". Observations belong in the report, not in the issue tracker.');
  }

  if (f.confidence < REPORTING_CONFIDENCE_THRESHOLD) {
    warnings.push(
      `Confidence ${f.confidence} is below the reporting threshold ${REPORTING_CONFIDENCE_THRESHOLD}. You may still file it, but the issue body MUST lead with the uncertainty, and the user must have opted into low-confidence reports.`,
    );
  }

  const repro = f.reproduction?.reproducible ?? 'unverified';
  if (repro === 'unverified') {
    warnings.push('Reproducibility is unverified. State that plainly in the body rather than implying a reliable repro.');
  }
  if (!f.evidence?.length) {
    warnings.push('No evidence attached. An issue without evidence wastes the reader\'s time and erodes trust in the agent.');
  }

  const authCheck = auth.check({
    action: `${system}.create_issue`,
    target: f.component || f.title,
    userAuthorised,
    authorisationQuote,
  });
  if (!authCheck.allowed) blockers.push(authCheck.reason);

  let assignCheck = null;
  if (assignee !== null) {
    assignCheck = auth.check({ action: `${system}.assign_issue`, target: f.title, userAuthorised, authorisationQuote, assignee });
    if (!assignCheck.allowed) warnings.push(`Assignment refused: ${assignCheck.reason}`);
  }

  return {
    finding_id: findingId,
    may_file: blockers.length === 0,
    blockers,
    warnings,
    idempotency_key: f.fingerprint,
    authorization: authCheck,
    assignment: assignCheck,
  };
}

/** Render the issue body. Kept here so the wording is versioned with the engine. */
export function renderIssue(findingId, { includeAgentFooter = true } = {}) {
  const f = state.get('findings', findingId);
  if (!f) throw new Error(`No such finding: ${findingId}`);
  const ev = (f.evidence ?? []).map((id) => state.get('evidence', id)).filter(Boolean);

  const lines = [];
  const confidenceBanner =
    f.confidence < REPORTING_CONFIDENCE_THRESHOLD
      ? `> **Reported with low confidence (${f.confidence}).** This may not be a defect. See "Uncertainty" below before acting.\n`
      : '';

  lines.push(confidenceBanner);
  lines.push('## Summary', '', f.summary || f.title, '');
  lines.push('| Field | Value |', '| --- | --- |');
  lines.push(`| Severity | ${f.severity} |`);
  lines.push(`| Kind | ${f.kind} |`);
  lines.push(`| Component | ${f.component || 'unknown'} |`);
  lines.push(`| Environment | ${f.environment || 'not recorded'} |`);
  lines.push(`| Reproducible | ${f.reproduction?.reproducible ?? 'unverified'}${f.reproduction?.attempts ? ` (${f.reproduction.attempts} attempts)` : ''} |`);
  lines.push(`| Commit | ${f.git?.commit ?? 'not recorded'} |`);
  lines.push(`| Branch | ${f.git?.branch ?? 'not recorded'} |`);
  lines.push(`| Confidence | ${f.confidence} |`);
  lines.push(`| Basis | ${f.epistemic_class} |`);
  lines.push('');

  if (f.reproduction) {
    if (f.reproduction.preconditions?.length) {
      lines.push('## Preconditions', '', ...f.reproduction.preconditions.map((s) => `- ${s}`), '');
    }
    if (f.reproduction.steps?.length) {
      lines.push('## Steps to reproduce', '', ...f.reproduction.steps.map((s, i) => `${i + 1}. ${s}`), '');
    }
    lines.push('## Expected result', '', f.reproduction.expected || '_not stated_', '');
    lines.push('## Actual result', '', f.reproduction.actual || '_not stated_', '');
  }

  if (f.impact) lines.push('## Impact', '', f.impact, '');

  if (ev.length) {
    lines.push('## Evidence', '');
    for (const e of ev) {
      const where = e.artifact?.path ? ` — \`${e.artifact.path}\`` : e.artifact?.uri ? ` — ${e.artifact.uri}` : '';
      lines.push(`- **${e.evidence_id}** (${e.kind}, ${e.epistemic_class}): ${e.summary}${where}`);
    }
    lines.push('');
  } else {
    lines.push('## Evidence', '', '_None captured. Treat this report as an observation pending verification._', '');
  }

  if (f.confidence < REPORTING_CONFIDENCE_THRESHOLD || f.reproduction?.reproducible === 'unverified') {
    lines.push('## Uncertainty', '');
    if (f.reproduction?.reproducible === 'unverified') lines.push('- Reproduction has not been independently verified.');
    if (f.confidence < REPORTING_CONFIDENCE_THRESHOLD) lines.push(`- Agent confidence is ${f.confidence}; alternative explanations have not been fully excluded.`);
    lines.push('');
  }

  if (f.recommended_action) lines.push('## Recommended next action', '', f.recommended_action, '');

  if (f.related_requirements?.length) {
    lines.push('## Related requirements', '', ...f.related_requirements.map((r) => `- ${r}`), '');
  }
  if (f.external_refs?.length) {
    lines.push('## Related records', '', ...f.external_refs.map((r) => `- ${r.system}: ${r.id}${r.url ? ` (${r.url})` : ''} — ${r.relation}`), '');
  }

  if (includeAgentFooter) {
    lines.push('---', '', `Filed by the Autonomous Software Testing agent — finding \`${f.finding_id}\`, session \`${f.session_id ?? 'n/a'}\`, skill v${f.provenance.skill_version}.`);
    lines.push(`Fingerprint: \`${f.fingerprint}\` (used to prevent duplicate filings).`);
  }

  return {
    title: `[${f.severity}] ${f.title}`,
    body: lines.join('\n'),
    labels: ['bug', `severity:${f.severity}`, `found-by:agent`].concat(f.kind !== 'defect' ? [`kind:${f.kind}`] : []),
  };
}

export function bySeverity() {
  return state.list('findings').sort(
    (a, b) => SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity) || b.confidence - a.confidence,
  );
}
