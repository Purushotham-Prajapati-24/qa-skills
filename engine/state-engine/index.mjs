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
import { dir, p, LAYOUT, stateRoot } from '../core/paths.mjs';
import { readJson, writeJson, updateJson, ensureDir, readCollection, exists, appendJsonl } from '../core/fsjson.mjs';
import { nextId } from '../core/ids.mjs';
import { provenance, DOC_VERSIONS } from '../core/version.mjs';
import { assertValid } from '../schema/validate.mjs';
import { redact } from '../core/redact.mjs';
import { captureGitInfo } from '../core/git.mjs';

const COLLECTIONS = ['decisions', 'executions', 'evidence', 'findings', 'uncertainties', 'reports', 'ledger', 'history', 'logs'];

export function init() {
  ensureDir(stateRoot());
  for (const c of COLLECTIONS) ensureDir(dir(c));
  if (!exists(p(LAYOUT.counters))) writeJson(p(LAYOUT.counters), { version: 1, counters: {} });
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
  return save(state);
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
export function recover({ now = new Date() } = {}) {
  const state = loadSession();
  if (!state) {
    return {
      recoverable: false,
      reason: 'No session state on disk.',
      next_action: 'Start a new session with `ast session start`.',
    };
  }

  const orphaned = [];
  for (const execId of state.open_executions ?? []) {
    const rec = get('executions', execId);
    if (!rec) {
      orphaned.push({ execution_id: execId, issue: 'referenced but missing on disk' });
      continue;
    }
    if (!rec.finished_at) {
      rec.status = 'INTERRUPTED';
      rec.status_reason = 'Session ended before this execution was finalised. No outcome may be inferred.';
      rec.finished_at = now.toISOString();
      put('executions', execId, rec, 'execution');
      orphaned.push({ execution_id: execId, issue: 'marked INTERRUPTED on recovery' });
    }
  }

  if (orphaned.length) {
    state.open_executions = [];
    state.interruptions.push({
      at: now.toISOString(),
      kind: 'restart',
      during_phase: state.phase,
      note: `Recovery finalised ${orphaned.length} unfinished execution(s) as INTERRUPTED.`,
      recovered_at: now.toISOString(),
    });
    save(state, now);
  }

  const unresolved = list('uncertainties').filter((u) => u.status !== 'resolved');

  return {
    recoverable: true,
    session_id: state.session_id,
    phase: state.phase,
    started_at: state.started_at,
    updated_at: state.updated_at,
    git: state.git ?? null,
    goals: state.goals,
    orphaned_executions: orphaned,
    completed_executions: state.completed_executions.length,
    unresolved_uncertainties: unresolved.map((u) => ({ id: u.id, status: u.status, question: u.question, next_action: u.next_action })),
    remaining_work: state.remaining_work,
    last_report: state.last_report ?? null,
    next_action: state.next_action,
  };
}
