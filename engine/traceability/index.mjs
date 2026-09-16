/**
 * Traceability graph.
 *
 * Builds the chain
 *
 *   Requirement -> Ticket -> PR -> Commit -> Component -> Test -> Execution
 *                -> Finding -> Issue -> Evidence
 *
 * from records already on disk. It invents no edges: if a test does not declare
 * `validates_requirements`, the requirement shows as uncovered rather than
 * being optimistically attached to something nearby.
 *
 * This is what lets the system answer "what remains untested?" with a real
 * answer instead of a vibe.
 */
import * as state from '../state-engine/index.mjs';
import { listWrites } from '../authorization/index.mjs';

export function build() {
  const executions = state.list('executions');
  const findings = state.list('findings');
  const evidence = state.list('evidence');
  const decisions = state.list('decisions');
  const writes = listWrites();

  const nodes = new Map();
  const edges = [];

  const node = (type, id, attrs = {}) => {
    const key = `${type}:${id}`;
    if (!nodes.has(key)) nodes.set(key, { type, id, ...attrs });
    else Object.assign(nodes.get(key), attrs);
    return key;
  };
  const edge = (from, to, rel) => edges.push({ from, to, rel });

  for (const e of executions) {
    const execKey = node('execution', e.execution_id, { status: e.status, method: e.method, category: e.test_category });
    if (e.git?.commit) {
      const c = node('commit', e.git.commit, { branch: e.git.branch });
      edge(execKey, c, 'ran-against');
      if (e.git.pull_request) {
        const pr = node('pull-request', e.git.pull_request);
        edge(c, pr, 'belongs-to');
      }
    }
    if (e.decision_id) edge(node('decision', e.decision_id), execKey, 'caused');
    for (const t of e.test_results ?? []) {
      const tKey = node('test', t.test_case_id ?? `${t.file ?? ''}::${t.name}`, { name: t.name, status: t.status, file: t.file });
      edge(execKey, tKey, 'executed');
      for (const r of t.validates_requirements ?? []) edge(tKey, node('requirement', r), 'validates');
      for (const ev of t.evidence ?? []) edge(tKey, node('evidence', ev), 'evidenced-by');
    }
    for (const ev of e.evidence ?? []) edge(execKey, node('evidence', ev), 'evidenced-by');
    for (const f of e.findings ?? []) edge(execKey, node('finding', f), 'produced');
    for (const u of e.uncertainties ?? []) edge(execKey, node('uncertainty', u), 'raised');
  }

  for (const f of findings) {
    const fKey = node('finding', f.finding_id, { severity: f.severity, kind: f.kind, triage: f.triage?.state });
    if (f.component) edge(fKey, node('component', f.component), 'affects');
    for (const r of f.related_requirements ?? []) edge(fKey, node('requirement', r), 'relates-to');
    for (const ev of f.evidence ?? []) edge(fKey, node('evidence', ev), 'evidenced-by');
    if (f.duplicate_of) edge(fKey, node('finding', f.duplicate_of), 'duplicate-of');
    for (const x of f.external_refs ?? []) edge(fKey, node(x.system, x.id, { url: x.url }), x.relation ?? 'relates-to');
  }

  for (const w of writes) {
    if (!w.confirmed) continue;
    const key = node(w.system, w.result_id ?? w.idempotency_key, { url: w.url, action: w.action });
    const owner = findings.find((f) => f.fingerprint === w.idempotency_key);
    if (owner) edge(node('finding', owner.finding_id), key, 'reported-as');
  }

  for (const ev of evidence) node('evidence', ev.evidence_id, { kind: ev.kind, epistemic_class: ev.epistemic_class });
  for (const d of decisions) node('decision', d.decision_id, { question: d.question, selected: d.selected_option });

  return { nodes: [...nodes.values()], edges };
}

const QUERIES = {
  'what-validates': 'Which tests validate requirement <id>?',
  'why-did-this-run': 'Which decision caused execution <id>?',
  'what-proves': 'What evidence supports <id>?',
  'what-issue-resulted': 'Which external issue resulted from finding <id>?',
  'what-remains-untested': 'Which known requirements have no passing test?',
  'why-this-method': 'Which decision chose the execution method for <id>?',
};

export function queries() {
  return QUERIES;
}

export function query(name, arg = null) {
  const g = build();
  const out = (rel, from) => g.edges.filter((e) => e.rel === rel && (!from || e.from === from));

  switch (name) {
    case 'what-validates':
      return g.edges.filter((e) => e.rel === 'validates' && e.to === `requirement:${arg}`).map((e) => e.from);

    case 'why-did-this-run':
      return g.edges.filter((e) => e.rel === 'caused' && e.to === `execution:${arg}`).map((e) => e.from);

    case 'why-this-method': {
      const exec = state.get('executions', arg);
      if (!exec?.decision_id) return { decision: null, note: 'No decision record is linked to this execution. That is itself a gap: method choices should be recorded.' };
      return state.get('decisions', exec.decision_id);
    }

    case 'what-proves':
      return g.edges.filter((e) => e.rel === 'evidenced-by' && e.from.endsWith(`:${arg}`)).map((e) => e.to);

    case 'what-issue-resulted':
      return g.edges.filter((e) => e.rel === 'reported-as' && e.from === `finding:${arg}`).map((e) => {
        const n = g.nodes.find((x) => `${x.type}:${x.id}` === e.to);
        return n ?? e.to;
      });

    case 'what-remains-untested': {
      const requirements = new Set(g.nodes.filter((n) => n.type === 'requirement').map((n) => n.id));
      const covered = new Set();
      for (const e of out('validates')) {
        const test = g.nodes.find((n) => `${n.type}:${n.id}` === e.from);
        if (test?.status === 'PASSED') covered.add(e.to.replace('requirement:', ''));
      }
      return {
        total_requirements_known: requirements.size,
        covered_by_passing_test: [...covered],
        uncovered: [...requirements].filter((r) => !covered.has(r)),
        caveat: 'This counts only requirements that were declared to the system. Requirements nobody wrote down are invisible here and remain the largest untested surface.',
      };
    }

    default:
      throw new Error(`Unknown traceability query "${name}". Available: ${Object.keys(QUERIES).join(', ')}`);
  }
}
