/**
 * Uncertainty Register.
 *
 * The rule this enforces: a blocker may stop one branch of work, never the
 * whole session. Every entry must name what it blocks and what would unblock
 * it, and `independentWork` records what the agent did anyway -- which is the
 * evidence that it did not down tools the moment something got hard.
 */
import { nextId } from '../core/ids.mjs';
import { provenance } from '../core/version.mjs';
import * as state from '../state-engine/index.mjs';

export const BLOCKING_STATUSES = new Set([
  'blocked', 'user-input-required', 'environment-unavailable', 'external-dependency',
]);

export function raise({
  question,
  status = 'unresolved',
  impact,
  affectedScope,
  blocksCategories = [],
  nextAction,
  owner = 'agent',
  raisedByExecution = null,
  evidence = [],
  independentWork = [],
  skillName = 'testing-orchestrator',
  now = new Date(),
} = {}) {
  if (!Array.isArray(affectedScope) || affectedScope.length === 0) {
    throw new Error('An uncertainty must name what it affects. "Something might be wrong somewhere" is not actionable.');
  }
  if (!nextAction) {
    throw new Error('An uncertainty must name the next action that would resolve it.');
  }
  const session = state.loadSession();
  const id = nextId('uncertainty', now);

  const rec = {
    id,
    timestamp: now.toISOString(),
    question,
    status,
    impact,
    affected_scope: affectedScope,
    blocks_categories: blocksCategories,
    next_action: nextAction,
    owner,
    evidence,
    independent_work_continued: independentWork,
    provenance: provenance({ sessionId: session?.session_id, skillName, now }),
  };
  if (session) rec.session_id = session.session_id;
  if (raisedByExecution) rec.raised_by_execution = raisedByExecution;

  state.put('uncertainties', id, rec, 'uncertainty');
  if (session) {
    state.update((s) => {
      s.uncertainties.push(id);
      if (BLOCKING_STATUSES.has(status)) s.blockers.push(id);
      return s;
    }, now);
  }
  state.telemetry({ event: 'uncertainty', id, status, blocks: blocksCategories });
  return rec;
}

export function resolve(id, { answer, resolvedBy = 'user', evidence = [], now = new Date() }) {
  const rec = state.get('uncertainties', id);
  if (!rec) throw new Error(`No such uncertainty: ${id}`);
  rec.status = 'resolved';
  rec.resolution = { resolved_at: now.toISOString(), answer, resolved_by: resolvedBy, evidence };
  state.put('uncertainties', id, rec, 'uncertainty');
  state.update((s) => {
    s.blockers = s.blockers.filter((b) => b !== id);
    return s;
  }, now);
  return rec;
}

/** Append to the record of what got done despite this blocker. */
export function noteIndependentWork(id, item) {
  const rec = state.get('uncertainties', id);
  if (!rec) throw new Error(`No such uncertainty: ${id}`);
  rec.independent_work_continued = [...(rec.independent_work_continued ?? []), item];
  state.put('uncertainties', id, rec, 'uncertainty');
  return rec;
}

export function open() {
  return state.list('uncertainties').filter((u) => u.status !== 'resolved');
}

/**
 * Which planned scenarios are still workable given the open blockers?
 * The orchestrator calls this instead of stopping.
 */
export function partitionWork(plannedScenarios = []) {
  const blockers = open().filter((u) => BLOCKING_STATUSES.has(u.status));
  const blockedScope = new Set(blockers.flatMap((b) => b.affected_scope));
  const blockedCats = new Set(blockers.flatMap((b) => b.blocks_categories));

  const runnable = [];
  const blocked = [];
  for (const s of plannedScenarios) {
    const id = s.id ?? s;
    const category = s.category ?? null;
    const hit = blockedScope.has(id) || (category && blockedCats.has(category));
    (hit ? blocked : runnable).push(s);
  }
  return {
    runnable,
    blocked,
    blockers: blockers.map((b) => ({ id: b.id, question: b.question, next_action: b.next_action, owner: b.owner })),
    guidance: runnable.length
      ? `${runnable.length} scenario(s) are unaffected by the ${blockers.length} open blocker(s). Run those now; do not wait.`
      : 'Every planned scenario is blocked. This is the only situation in which stopping to ask is correct.',
  };
}
