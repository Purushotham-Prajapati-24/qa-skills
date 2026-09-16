/**
 * Decision Engine.
 *
 * Persists decision records and enforces the properties that make them useful
 * later: at least two candidate options, at least one itemised reason, a
 * confidence value, and an explicit reversibility flag.
 *
 * It also holds the adaptive next-action logic. After a result comes in, the
 * agent must not just continue -- it must classify what happened and pick the
 * next move from that classification.
 */
import { nextId } from '../core/ids.mjs';
import { provenance } from '../core/version.mjs';
import * as state from '../state-engine/index.mjs';

export function record({
  question,
  category = 'other',
  options,
  selected,
  reason,
  confidence,
  reversible,
  context = null,
  evidenceRefs = [],
  risk = null,
  downstreamEffect = [],
  policyRefs = [],
  skillName = 'testing-orchestrator',
  now = new Date(),
} = {}) {
  const session = state.loadSession();
  const id = nextId('decision', now);

  const candidates = (options ?? []).map((o, i) =>
    typeof o === 'string' ? { id: o, label: o } : { id: o.id ?? `opt-${i}`, ...o },
  );
  if (candidates.length < 2) {
    throw new Error('A decision needs at least two candidate options. If there was only one path, record it as an assumption in the plan, not as a decision.');
  }
  if (!candidates.some((c) => c.id === selected)) {
    throw new Error(`Selected option "${selected}" is not among the candidates: ${candidates.map((c) => c.id).join(', ')}`);
  }
  const reasons = Array.isArray(reason) ? reason : [reason].filter(Boolean);
  if (reasons.length === 0) {
    throw new Error('A decision needs at least one reason. "It seemed best" is not a reason.');
  }
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    throw new Error('Decision confidence must be a number in [0,1]. State genuine uncertainty rather than rounding up to 1.');
  }
  if (typeof reversible !== 'boolean') {
    throw new Error('Decision must state whether it is reversible. This drives whether authorisation is required.');
  }

  const rec = {
    decision_id: id,
    timestamp: now.toISOString(),
    category,
    question,
    candidate_options: candidates,
    selected_option: selected,
    reason: reasons,
    evidence_refs: evidenceRefs,
    confidence,
    reversible,
    downstream_effect: downstreamEffect,
    policy_refs: policyRefs,
    provenance: provenance({ sessionId: session?.session_id, skillName, now }),
  };
  if (session) rec.session_id = session.session_id;
  if (context) rec.context = context;
  if (risk) rec.risk = risk;

  state.put('decisions', id, rec, 'decision');
  if (session) {
    state.update((s) => {
      s.decisions.push(id);
      return s;
    }, now);
  }
  state.telemetry({ event: 'decision', decision_id: id, category, selected, confidence });
  return rec;
}

/** Attach the observed outcome later. This is what makes decision accuracy measurable. */
export function assess(decisionId, { verdict, note = '', evidenceRefs = [], now = new Date() }) {
  const rec = state.get('decisions', decisionId);
  if (!rec) throw new Error(`No such decision: ${decisionId}`);
  rec.outcome = { assessed_at: now.toISOString(), verdict, note, evidence_refs: evidenceRefs };
  state.put('decisions', decisionId, rec, 'decision');
  return rec;
}

export function supersede(oldId, newId) {
  const rec = state.get('decisions', oldId);
  if (!rec) throw new Error(`No such decision: ${oldId}`);
  rec.superseded_by = newId;
  state.put('decisions', oldId, rec, 'decision');
  return rec;
}

/* --------------------------------------------------------- adaptive next */

const NEXT_ACTION_BY_CLASS = {
  'product-defect': {
    next: 'Raise a finding with reproduction steps and evidence. Do NOT modify product code to make the test pass.',
    continue_suite: true,
  },
  'test-defect': {
    next: 'Fix the test, re-run it, and record both runs. A test that was wrong is not a product signal.',
    continue_suite: true,
  },
  'environment-defect': {
    next: 'Repair or re-provision the environment, then re-run. Mark the result BLOCKED until then -- not FAILED.',
    continue_suite: false,
  },
  'infrastructure-failure': {
    next: 'Mark BLOCKED, capture the infrastructure error as evidence, and continue with test categories that do not need it.',
    continue_suite: false,
  },
  'dependency-failure': {
    next: 'Determine whether a test double is acceptable. If not, raise an uncertainty and continue independent work.',
    continue_suite: false,
  },
  'flaky-test': {
    next: 'Re-run in isolation at least three times before labelling it flaky. Record the pass/fail sequence as evidence.',
    continue_suite: true,
  },
  'configuration-failure': {
    next: 'Diff the effective configuration against what the test expects; fix the config, not the assertion.',
    continue_suite: true,
  },
  'data-failure': {
    next: 'Reset or reseed test data, then re-run. If the data problem is in the product, that is a finding.',
    continue_suite: true,
  },
  'authentication-failure': {
    next: 'Check whether this is a product authn defect or missing test credentials. These have opposite conclusions -- gather evidence before choosing.',
    continue_suite: false,
  },
  timeout: {
    next: 'Distinguish a slow environment from a product performance regression by timing a known-good path in the same run.',
    continue_suite: true,
  },
  'performance-degradation': {
    next: 'Re-measure with a baseline in the same session. A single slow run is not a regression.',
    continue_suite: true,
  },
  'expected-behaviour-mismatch': {
    next: 'The test and the requirement disagree. Resolve the requirement first; raise an ambiguity uncertainty.',
    continue_suite: true,
  },
  'ambiguous-requirement': {
    next: 'Raise an uncertainty with status ambiguous-requirement, mark this scenario INCONCLUSIVE, and continue everything that does not depend on it.',
    continue_suite: true,
  },
  'insufficient-evidence': {
    next: 'Do not report a status. Gather the missing evidence or mark INCONCLUSIVE.',
    continue_suite: true,
  },
  unclassified: {
    next: 'Gather more signal before deciding. An unclassified failure must not be reported as a defect.',
    continue_suite: true,
  },
};

/**
 * Given a result, say what to do next. Deliberately not "continue" by default:
 * blind continuation after a failure is how agents produce confident nonsense.
 */
export function nextAction({ status, failureClass = null, remainingWork = [], blockers = [] }) {
  if (status === 'PASSED' || status === 'COMPLETED') {
    const next = remainingWork.length
      ? `Proceed to the next highest-priority item: ${remainingWork[0]}`
      : blockers.length
        ? `All unblocked work is done. ${blockers.length} blocker(s) remain -- surface them to the user and stop.`
        : 'All planned work is complete. Generate the report and state explicitly what was NOT tested.';
    return { next, reassess: false, rationale: 'Successful result; no reclassification needed.' };
  }

  if (status === 'BLOCKED' || status === 'NEEDS_USER_INPUT') {
    return {
      next: `Record the blocker as an uncertainty, then continue every independent item. Candidates: ${remainingWork.slice(0, 3).join('; ') || 'none remaining'}`,
      reassess: false,
      rationale: 'One blocked branch must never stall the unblocked ones.',
    };
  }

  const guide = NEXT_ACTION_BY_CLASS[failureClass ?? 'unclassified'];
  return {
    next: guide.next,
    reassess: true,
    continue_suite: guide.continue_suite,
    rationale: `Failure classified as "${failureClass ?? 'unclassified'}". Response is determined by the classification, not by the fact that something went red.`,
  };
}
