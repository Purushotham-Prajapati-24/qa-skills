/**
 * Structural integrity of the state directory: every record valid against its schema, every
 * reference resolvable, no run left open. These problems are always fatal to `validate`.
 *
 * They live here, not in the CLI, so the work queue (`ast todo`) and the Stop gate see exactly
 * what `validate --final` sees. Before, an open run or a dangling reference failed the gate
 * while the queue said "done" -- an agent following the queue stopped one step short.
 */
import * as state from '../state-engine/index.mjs';
import { validate as validateSchema } from '../schema/validate.mjs';

/**
 * Collection -> { schema, the field holding THAT record's own ID }.
 *
 * The ID field must be pinned per collection. A fallback chain like
 * `item.decision_id ?? item.execution_id ?? ...` looks harmless and is not: an execution
 * carries a `decision_id`, and evidence and findings carry an `execution_id`, so the chain
 * keys every record by a foreign ID and then reports every real reference as dangling.
 */
export const COLLECTION_SCHEMAS = {
  decisions: { schema: 'decision', idField: 'decision_id' },
  executions: { schema: 'execution', idField: 'execution_id' },
  evidence: { schema: 'evidence', idField: 'evidence_id' },
  findings: { schema: 'finding', idField: 'finding_id' },
  uncertainties: { schema: 'uncertainty', idField: 'id' },
  reports: { schema: 'report', idField: 'report_id' },
  plans: { schema: 'testing-plan', idField: 'plan_id' },
};

/**
 * @returns {{counts: Record<string, number>, problems: Array<{kind: 'schema'|'dangling'|'open-execution', ref: string, message: string, next: string}>}}
 */
export function structuralCheck() {
  const problems = [];
  const counts = {};
  const add = (kind, ref, message, next) => problems.push({ kind, ref, message, next });

  const session = state.loadSession();
  if (session) {
    const r = validateSchema(session, 'session-state');
    counts.session = 1;
    if (!r.valid) r.errors.forEach((e) => add('schema', 'session', `session-state ${e.path}: ${e.message}`, 'repair the session file; it was edited by hand or by an older version'));
  }

  const profile = state.loadProfile();
  if (profile) {
    const r = validateSchema(profile, 'repository-profile');
    counts.profile = 1;
    if (!r.valid) r.errors.forEach((e) => add('schema', 'profile', `repository-profile ${e.path}: ${e.message}`, 'fix the profile and re-run `profile save`'));
  }

  const known = { evidence: new Set(), decisions: new Set(), findings: new Set(), uncertainties: new Set(), executions: new Set() };
  for (const [collection, { schema: schemaName, idField }] of Object.entries(COLLECTION_SCHEMAS)) {
    const items = state.list(collection);
    counts[collection] = items.length;
    for (const item of items) {
      const id = item[idField];
      if (!id) {
        add('schema', collection, `${collection}: a record is missing its "${idField}"`, 'remove or repair the record');
        continue;
      }
      if (known[collection]) known[collection].add(id);
      const r = validateSchema(item, schemaName);
      if (!r.valid) r.errors.forEach((e) => add('schema', id, `${collection}/${id} ${e.path}: ${e.message}`, 'repair the record; it was edited by hand or by an older version'));
    }
  }

  const dangling = (ids, pool, where) => (ids ?? []).filter((i) => !pool.has(i))
    .forEach((i) => add('dangling', where, `${where} references missing ${i}`, `record ${i} or remove the reference`));
  for (const e of state.list('executions')) {
    dangling(e.evidence, known.evidence, `executions/${e.execution_id}.evidence`);
    dangling(e.findings, known.findings, `executions/${e.execution_id}.findings`);
    dangling(e.uncertainties, known.uncertainties, `executions/${e.execution_id}.uncertainties`);
    if (e.decision_id && !known.decisions.has(e.decision_id)) add('dangling', e.execution_id, `executions/${e.execution_id}.decision_id references missing ${e.decision_id}`, `record ${e.decision_id} or remove the reference`);
    if (!e.finished_at && e.status !== 'PARTIAL') add('schema', e.execution_id, `executions/${e.execution_id} has no finished_at but status ${e.status}`, 'finish or interrupt it');
  }
  for (const f of state.list('findings')) {
    dangling(f.evidence, known.evidence, `findings/${f.finding_id}.evidence`);
    if (f.duplicate_of && !known.findings.has(f.duplicate_of)) add('dangling', f.finding_id, `findings/${f.finding_id}.duplicate_of references missing ${f.duplicate_of}`, 'repair the reference');
  }
  for (const d of state.list('decisions')) dangling(d.evidence_refs, known.evidence, `decisions/${d.decision_id}.evidence_refs`);
  if (session) {
    dangling(session.decisions, known.decisions, 'session.decisions');
    dangling(session.findings, known.findings, 'session.findings');
    dangling(session.uncertainties, known.uncertainties, 'session.uncertainties');
    for (const id of session.open_executions ?? []) {
      const e = state.get('executions', id);
      add('open-execution', id, `${id} "${e?.goal ?? '?'}" is still open: it was started and never finished.`,
        `finish it (evidence capture, then exec finish ${id}); if it was abandoned, \`session resume\` finalises idle runs (or --interrupt-all)`);
    }
  }
  return { counts, problems };
}
