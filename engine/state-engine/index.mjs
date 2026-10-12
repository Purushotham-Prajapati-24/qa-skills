/**
 * State Engine -- durable working memory.
 *
 * Design rule: the conversation is NOT the state. Anything the agent would be
 * upset to lose is written here after every phase transition. On resume, the
 * engine reconstructs the phase from files, and it never infers that an
 * unfinished execution succeeded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dir, p, LAYOUT, stateRoot, isImplicitProjectState } from '../core/paths.mjs';
import { readJson, writeJson, updateJson, ensureDir, readCollection, exists, appendJsonl } from '../core/fsjson.mjs';
import { nextId } from '../core/ids.mjs';
import { provenance, DOC_VERSIONS } from '../core/version.mjs';
import { assertValid } from '../schema/validate.mjs';
import { redact } from '../core/redact.mjs';
import { captureGitInfo } from '../core/git.mjs';
import { snapshotTestFiles } from '../core/authored-tests.mjs';

const COLLECTIONS = ['decisions', 'executions', 'evidence', 'findings', 'uncertainties', 'reports', 'plans', 'ledger', 'history', 'logs'];

export function init() {
  ensureDir(stateRoot());
  for (const c of COLLECTIONS) ensureDir(dir(c));
  if (!exists(p(LAYOUT.counters))) writeJson(p(LAYOUT.counters), { version: 1, counters: {} });
  // Implicit project-local state should not show up as untracked files in the user's repo. An
  // explicitly chosen directory is left alone: committing it is a legitimate choice.
  const ignore = path.join(stateRoot(), '.gitignore');
  if (isImplicitProjectState() && !fs.existsSync(ignore)) {
    fs.writeFileSync(ignore, '# autonomous-software-testing state (evidence, runs, reports). Delete this file to commit it.\n*\n');
  }
  return stateRoot();
}

/* ------------------------------------------------------------------ session */

export function sessionFile() {
  return p(LAYOUT.session);
}

export function loadSession() {
  return readJson(sessionFile(), null);
}

export function startSession({ request, trigger = 'user-request', git = captureGitInfo(), goals = [], now = new Date() }) {
  init();
  // Runs the previous session left open can never be finished now; close them honestly as
  // INTERRUPTED before archiving, or they stay "in progress" forever.
  if (loadSession()?.open_executions?.length) recover({ now, interruptAll: true });
  const existing = loadSession();
  // Archive the previous session rather than clobbering it: history is evidence.
  if (existing) {
    writeJson(path.join(dir('history'), `${existing.session_id}.json`), existing);
  }
  const state = {
    session_id: nextId('session', now),
    started_at: now.toISOString(),
    updated_at: now.toISOString(),
    state_version: DOC_VERSIONS['session-state'],
    trigger,
    user_request: request ?? '',
    phase: 'discover',
    phase_history: [{ phase: 'discover', at: now.toISOString(), note: 'session started' }],
    goals: goals.map((g, i) => normaliseGoal(g, i)),
    selected_tests: [],
    completed_executions: [],
    open_executions: [],
    decisions: [],
    findings: [],
    uncertainties: [],
    blockers: [],
    deferred: [],
    remaining_work: [],
    interruptions: [],
    next_action: 'Run the discovery workflow: profile the repository before choosing any test.',
    provenance: provenance({ now }),
  };
  if (git) state.git = git;
  state.provenance.session_id = state.session_id;
  const saved = save(state);
  // Baseline of every test file as it was before this session touched anything, so a test
  // written (or rewritten) during the session can be told apart from one that already existed.
  writeJson(p(LAYOUT.authoredBaseline), { session_id: saved.session_id, ...snapshotTestFiles({ excludeDir: stateRoot() }) });
  return saved;
}

export function loadAuthoredBaseline() {
  const session = loadSession();
  const b = readJson(p(LAYOUT.authoredBaseline), null);
  return b && session && b.session_id === session.session_id ? b : null;
}

/**
 * Record something the user said. `source: 'hook'` is written by the UserPromptSubmit hook
 * from the prompt Claude Code actually received; `source: 'agent'` is the agent's own
 * transcription and is labelled as such wherever it is relied on.
 */
export function recordUserStatement(quote, { source = 'agent', now = new Date() } = {}) {
  const text = String(quote ?? '').trim().slice(0, 4000);
  if (!text) throw new Error('A user statement needs the user\'s words.');
  return update((s) => {
    s.user_statements = [...(s.user_statements ?? []), { quote: text, at: now.toISOString(), source }];
    return s;
  }, now);
}

const squash = (t) => String(t ?? '').toLowerCase().replace(/[\s"'`“”‘’]+/g, ' ').trim();

/** Where, if anywhere, the user actually said `quote`: the request, a hook-recorded prompt, or an agent transcription. */
export function verifyUserQuote(quote) {
  const q = squash(quote);
  if (q.length < 4) return null;
  const s = loadSession();
  if (!s) return null;
  if (squash(s.user_request).includes(q)) return 'request';
  const statements = s.user_statements ?? [];
  if (statements.some((u) => u.source === 'hook' && squash(u.quote).includes(q))) return 'hook';
  // Once the hook is recording real prompts, the agent's own transcription is no longer
  // accepted as the user's words -- it could otherwise discharge a hold the user never gave.
  if (statements.some((u) => u.source === 'hook')) return null;
  const hit = statements.find((u) => squash(u.quote).includes(q));
  return hit ? hit.source : null;
}

function normaliseGoal(g, i) {
  if (typeof g === 'string') {
    return { id: `G-${String(i + 1).padStart(2, '0')}`, goal: g, status: 'PARTIAL', success_criteria: [] };
  }
  return {
    id: g.id ?? `G-${String(i + 1).padStart(2, '0')}`,
    goal: g.goal,
    ...(g.target ? { target: g.target } : {}),
    status: g.status ?? 'PARTIAL',
    success_criteria: (g.success_criteria ?? []).map((c) =>
      typeof c === 'string' ? { criterion: c, status: 'NEEDS_USER_INPUT' } : c,
    ),
  };
}

export function save(state, now = new Date()) {
  state.updated_at = now.toISOString();
  assertValid(state, 'session-state');
  const safe = redact(state);
  writeJson(sessionFile(), safe);
  return safe;
}

export function requireSession() {
  const s = loadSession();
  if (!s) throw new Error('No active session. Run `ast session start --request "..."` first.');
  return s;
}

/**
 * Mutate the session through a callback, validating and persisting once.
 *
 * The read (current session), the callback's mutation, and the write all
 * happen under one lock via `updateJson` -- several subagents each opening
 * their own execution (which pushes onto `open_executions`) is the normal,
 * designed-for case, not a rare race, so the read-modify-write cannot be
 * split across an unlocked `loadSession()` + `save()` pair.
 */
export function update(fn, now = new Date()) {
  return updateJson(sessionFile(), (current) => {
    if (!current) throw new Error('No active session. Run `ast session start --request "..."` first.');
    const next = fn(current) ?? current;
    next.updated_at = now.toISOString();
    assertValid(next, 'session-state');
    return redact(next);
  }, null);
}

export function setPhase(phase, note, now = new Date()) {
  return update((s) => {
    s.phase = phase;
    s.phase_history.push({ phase, at: now.toISOString(), note: note ?? '' });
    return s;
  }, now);
}

export function setNextAction(action) {
  return update((s) => {
    s.next_action = action;
    return s;
  });
}

export function recordInterruption({ kind, note, now = new Date() }) {
  return update((s) => {
    s.interruptions.push({
      at: now.toISOString(),
      kind,
      during_phase: s.phase,
      during_execution: s.open_executions.at(-1),
      note: note ?? '',
    });
    return s;
  }, now);
}

/* -------------------------------------------------------------- collections */

/** Persist a record into a collection directory, keyed by its ID. */
export function put(collection, id, record, schemaName) {
  if (schemaName) assertValid(record, schemaName);
  const safe = redact(record);
  writeJson(path.join(dir(collection), `${id}.json`), safe);
  return safe;
}

export function get(collection, id) {
  const file = path.join(dir(collection), `${id}.json`);
  return readJson(file, null);
}

export function list(collection) {
  return readCollection(dir(collection));
}

export function ids(collection) {
  const d = dir(collection);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
}

/* ------------------------------------------------------------- repo profile */

export function saveProfile(profile) {
  assertValid(profile, 'repository-profile');
  const safe = redact(profile);
  writeJson(p(LAYOUT.profile), safe);
  return safe;
}

export function loadProfile() {
  return readJson(p(LAYOUT.profile), null);
}

/* ------------------------------------------------------ applicability matrix */

/**
 * Persist the applicability matrix so the coverage floor (`validate --final`) can later
 * compare what was judged applicable against what actually ran. Without this, applicability
 * was computed, printed once, and forgotten -- nothing downstream could tell an applicable
 * P0/P1 category that silently never ran from one that was never relevant.
 */
export function saveApplicability(result) {
  const session = loadSession();
  writeJson(p(LAYOUT.applicability), session ? { ...result, session_id: session.session_id } : result);
  return result;
}

/** The matrix evaluated in THIS session. One from an earlier session judged other code and other risk. */
export function loadApplicability() {
  const m = readJson(p(LAYOUT.applicability), null);
  const session = loadSession();
  if (m && session && m.session_id && m.session_id !== session.session_id) return null;
  return m;
}

/* -------------------------------------------------------------------- plans */

export function savePlan(plan) {
  // Fail before any write: a plan saved with no session would be orphaned and then picked up by
  // the next session as if it were its own.
  const session = requireSession();
  if (!plan.session_id) plan = { ...plan, session_id: session.session_id };
  assertValid(plan, 'testing-plan');
  const safe = redact(plan);
  recordCommitments(safe, session);
  put('plans', plan.plan_id, safe, null);
  update((s) => {
    s.plan_ref = plan.plan_id;
    return s;
  });
  return safe;
}

export function loadPlan(planId = null) {
  if (planId) return get('plans', planId);
  const session = loadSession();
  const id = session?.plan_ref;
  return id ? get('plans', id) : null;
}

// Obligation strength. A scenario's commitment can only ratchet up within a session: re-saving
// a plan (same id or a new one) with a scenario dropped or downgraded does not release it.
const OBLIGATION_RANK = { 'must-test': 3, blocked: 3, 'should-test': 2, 'nice-to-test': 1, deferred: 1, 'not-applicable': 0 };

function recordCommitments(plan, session) {
  const file = p(LAYOUT.planCommitments);
  const sid = session?.session_id ?? null;
  let ledger = readJson(file, null);
  if (!ledger || ledger.session_id !== sid) ledger = { session_id: sid, scenarios: {} };
  for (const s of plan.scenarios ?? []) {
    const prev = ledger.scenarios[s.id];
    const keepPrev = prev && (OBLIGATION_RANK[prev.obligation] ?? 0) > (OBLIGATION_RANK[s.obligation] ?? 0);
    ledger.scenarios[s.id] = {
      id: s.id,
      title: s.title,
      category: s.category,
      obligation: keepPrev ? prev.obligation : s.obligation,
      plan_id: keepPrev ? prev.plan_id : plan.plan_id,
      ...((s.feature ?? prev?.feature) ? { feature: s.feature ?? prev.feature } : {}),
    };
  }
  writeJson(file, ledger);
}

/** The strongest obligation each scenario has ever had in this session, keyed by scenario id. */
export function planCommitments() {
  const session = loadSession();
  const ledger = readJson(p(LAYOUT.planCommitments), null);
  if (!ledger || ledger.session_id !== (session?.session_id ?? null)) return {};
  return ledger.scenarios;
}

/**
 * Records belonging to the active session. Every judgement -- floors, the work queue, metrics,
 * the report -- is about THIS session: a run from yesterday's session tested yesterday's code
 * and must not count as today's coverage, and yesterday's open questions must not gate today.
 * Records with no session id (created with no session open) are included. With no active
 * session, everything is returned. Raw listings (`exec list`) and duplicate suppression stay
 * global on purpose.
 */
export function listForSession(collection) {
  const all = list(collection);
  const session = loadSession();
  if (!session) return all;
  return all.filter((r) => !r.session_id || r.session_id === session.session_id);
}

/** Every plan saved in the active session, oldest first. A re-save never erases an earlier commitment. */
export function sessionPlans() {
  const session = loadSession();
  return list('plans').filter((pl) => !session || !pl.session_id || pl.session_id === session.session_id);
}

/* ---------------------------------------------------------------- telemetry */

/**
 * Append-only observability stream. Redacted. Never contains payload bodies --
 * only what is needed to debug the agent's behaviour.
 */
export function telemetry(event) {
  const file = path.join(dir('logs'), `${new Date().toISOString().slice(0, 10)}.jsonl`);
  appendJsonl(file, redact({ at: new Date().toISOString(), ...event }));
  return file;
}

/* ----------------------------------------------------------------- recovery */

/**
 * Reconstruct what is true right now from disk alone.
 * Deliberately makes no optimistic assumptions: an execution that was started
 * and never finalised comes back as INTERRUPTED, not PASSED.
 */
export function recover({ now = new Date(), interruptAll = false, idleMinutes = 10 } = {}) {
  let state = loadSession();
  if (!state) {
    return {
      recoverable: false,
      reason: 'No session state on disk.',
      next_action: 'Start a new session with `ast session start`.',
    };
  }

  // An open run is not necessarily dead: a parallel explorer may be mid-charter. A run counts
  // as abandoned only when nothing has happened on it (start, or any evidence captured for it)
  // for `idleMinutes`. Recent ones are reported as in flight and left alone, unless the caller
  // knows nothing else is running (`interruptAll`).
  const lastActivity = new Map();
  for (const ev of list('evidence')) {
    if (!ev.execution_id) continue;
    const t = new Date(ev.timestamp ?? 0).getTime();
    if (t > (lastActivity.get(ev.execution_id) ?? 0)) lastActivity.set(ev.execution_id, t);
  }
  // An explicitly recorded interruption (`session interrupt`) is a precise signal: a run with no
  // activity since then was stopped by it, however recently it started.
  // Recovery's own 'restart' entries are bookkeeping, not a stop signal: counting them made a
  // second resume kill the runs the first one had deliberately left in flight.
  const lastInterrupt = Math.max(0, ...(state.interruptions ?? [])
    .filter((i) => i.kind !== 'restart')
    .map((i) => new Date(i.at).getTime()));
  const orphaned = [];
  const inFlight = [];
  const close = new Set();
  for (const execId of state.open_executions ?? []) {
    const rec = get('executions', execId);
    if (!rec) {
      orphaned.push({ execution_id: execId, issue: 'referenced but missing on disk' });
      close.add(execId);
      continue;
    }
    if (rec.finished_at) { close.add(execId); continue; }
    const last = Math.max(new Date(rec.started_at).getTime(), lastActivity.get(execId) ?? 0);
    const idleMs = now.getTime() - last;
    const stoppedByInterruption = lastInterrupt > 0 && last <= lastInterrupt;
    if (!interruptAll && !stoppedByInterruption && idleMs < idleMinutes * 60_000) {
      inFlight.push({ execution_id: execId, goal: rec.goal, idle_minutes: Math.round(idleMs / 60_000), plan_scenario_id: rec.plan_scenario_id ?? null });
      continue;
    }
    rec.status = 'INTERRUPTED';
    rec.status_reason = 'Session ended before this execution was finalised. No outcome may be inferred.';
    rec.finished_at = now.toISOString();
    put('executions', execId, rec, 'execution');
    orphaned.push({ execution_id: execId, issue: 'marked INTERRUPTED on recovery' });
    close.add(execId);
  }

  if (close.size) {
    state = update((s) => {
      s.open_executions = (s.open_executions ?? []).filter((id) => !close.has(id));
      if (orphaned.length) {
        s.interruptions.push({
          at: now.toISOString(),
          kind: 'restart',
          during_phase: s.phase,
          note: `Recovery finalised ${orphaned.length} unfinished execution(s) as INTERRUPTED.`,
          recovered_at: now.toISOString(),
        });
      }
      return s;
    }, now);
  }

  const unresolved = listForSession('uncertainties').filter((u) => u.status !== 'resolved');

  return {
    recoverable: true,
    session_id: state.session_id,
    phase: state.phase,
    started_at: state.started_at,
    updated_at: state.updated_at,
    git: state.git ?? null,
    goals: state.goals,
    orphaned_executions: orphaned,
    in_flight_executions: inFlight,
    ...(inFlight.length ? {
      in_flight_note: `${inFlight.length} open run(s) had activity in the last ${idleMinutes} minutes and were left open: a parallel explorer may still be running them. If nothing else is running, finalise them with \`session resume --interrupt-all\`.`,
    } : {}),
    completed_executions: state.completed_executions.length,
    unresolved_uncertainties: unresolved.map((u) => ({ id: u.id, status: u.status, question: u.question, next_action: u.next_action })),
    remaining_work: state.remaining_work,
    last_report: state.last_report ?? null,
    next_action: state.next_action,
  };
}

/* -------------------------------------------------------------------- goals */

const DONE = ['PASSED', 'COMPLETED'];

function rollUp(criteria) {
  if (criteria.some((c) => c.status === 'FAILED')) return 'FAILED';
  if (criteria.every((c) => DONE.includes(c.status))) return 'PASSED';
  if (criteria.every((c) => c.status === 'NOT_APPLICABLE')) return 'NOT_APPLICABLE';
  return 'PARTIAL';
}

/**
 * Record the assessed status of a goal, or of one of its success criteria (1-based).
 * The caller runs the evidence gate first; this only stores the outcome. When every
 * criterion of a goal has been assessed, the goal's own status is rolled up from them.
 */
export function assessGoal({ goalId, criterion = null, status, evidence = [], executionId = null, note = '', now = new Date() }) {
  let result;
  update((s) => {
    const goal = (s.goals ?? []).find((g) => g.id === goalId);
    if (!goal) throw new Error(`No goal "${goalId}". Goals: ${(s.goals ?? []).map((g) => g.id).join(', ') || 'none'}`);
    const at = now.toISOString();
    const stamp = (target) => {
      target.status = status;
      target.assessed_at = at;
      if (evidence.length) target.evidence = evidence;
      if (note) target.note = note;
    };
    if (criterion === null) {
      stamp(goal);
      delete goal.evidence;
      if (evidence.length) goal.note = [note, `evidence: ${evidence.join(', ')}`].filter(Boolean).join(' -- ');
    } else {
      const c = goal.success_criteria?.[criterion - 1];
      if (!c) throw new Error(`Goal ${goalId} has no criterion ${criterion} (it has ${goal.success_criteria?.length ?? 0}).`);
      stamp(c);
      if (executionId) c.execution_id = executionId;
      if (goal.success_criteria.every((x) => x.assessed_at)) {
        goal.status = rollUp(goal.success_criteria);
        goal.assessed_at = at;
      }
    }
    result = goal;
    return s;
  }, now);
  return result;
}
