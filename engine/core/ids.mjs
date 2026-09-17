/**
 * Identifier allocation.
 *
 * Every artefact the agent produces gets a stable, sortable, searchable ID.
 * IDs are allocated from a single counters file so that two artefacts can
 * never collide, and so that "DEC-00042" means exactly one thing forever.
 *
 * Formats (documented in docs/versioning.md):
 *   SESSION-0031        session
 *   DEC-00042           decision record
 *   EXEC-2026-00142     execution record  (year-scoped)
 *   EV-2026-00311       evidence item     (year-scoped)
 *   FIND-00042          finding / defect
 *   U-00019             uncertainty
 *   REPORT-2026-00142   report            (year-scoped)
 *   TC-00123            generated test case
 *   PLAN-00007          test plan
 */
import { readJson, updateJson } from './fsjson.mjs';
import { p, LAYOUT } from './paths.mjs';

const SPECS = {
  session: { prefix: 'SESSION', pad: 4, yearScoped: false },
  decision: { prefix: 'DEC', pad: 5, yearScoped: false },
  execution: { prefix: 'EXEC', pad: 5, yearScoped: true },
  evidence: { prefix: 'EV', pad: 5, yearScoped: true },
  finding: { prefix: 'FIND', pad: 5, yearScoped: false },
  uncertainty: { prefix: 'U', pad: 5, yearScoped: false },
  report: { prefix: 'REPORT', pad: 5, yearScoped: true },
  testcase: { prefix: 'TC', pad: 5, yearScoped: false },
  plan: { prefix: 'PLAN', pad: 5, yearScoped: false },
};

export const ID_KINDS = Object.keys(SPECS);

function countersFile() {
  return p(LAYOUT.counters);
}

function load() {
  return readJson(countersFile(), { version: 1, counters: {} });
}

/**
 * Allocate the next ID for `kind`. Year-scoped counters restart each calendar
 * year, which keeps IDs short without ever repeating a full identifier.
 *
 * The read-modify-write against the shared counters file happens under
 * `updateJson`'s lock, so concurrent callers (e.g. several subagents each
 * opening their own execution) can never read the same "current" value and
 * allocate the same ID -- see docs on the concurrency incident this fixes.
 */
export function nextId(kind, now = new Date()) {
  const spec = SPECS[kind];
  if (!spec) throw new Error(`Unknown ID kind: ${kind}. Known: ${ID_KINDS.join(', ')}`);
  const year = String(now.getUTCFullYear());
  const bucket = spec.yearScoped ? `${kind}:${year}` : kind;

  const db = updateJson(countersFile(), (current) => {
    const next = (current.counters[bucket] ?? 0) + 1;
    current.counters[bucket] = next;
    current.updated_at = now.toISOString();
    return current;
  }, { version: 1, counters: {} });

  const num = String(db.counters[bucket]).padStart(spec.pad, '0');
  return spec.yearScoped ? `${spec.prefix}-${year}-${num}` : `${spec.prefix}-${num}`;
}

/** Peek without allocating. Used by `ast validate` and reporting. */
export function currentCount(kind, now = new Date()) {
  const spec = SPECS[kind];
  if (!spec) throw new Error(`Unknown ID kind: ${kind}`);
  const bucket = spec.yearScoped ? `${kind}:${now.getUTCFullYear()}` : kind;
  return load().counters[bucket] ?? 0;
}

const PATTERNS = {
  session: /^SESSION-\d{4,}$/,
  decision: /^DEC-\d{5,}$/,
  execution: /^EXEC-\d{4}-\d{5,}$/,
  evidence: /^EV-\d{4}-\d{5,}$/,
  finding: /^FIND-\d{5,}$/,
  uncertainty: /^U-\d{5,}$/,
  report: /^REPORT-\d{4}-\d{5,}$/,
  testcase: /^TC-\d{5,}$/,
  plan: /^PLAN-\d{5,}$/,
};

export function isId(kind, value) {
  const re = PATTERNS[kind];
  return Boolean(re && typeof value === 'string' && re.test(value));
}

/** Infer the kind from an ID string, or null if it matches nothing. */
export function kindOf(value) {
  for (const [kind, re] of Object.entries(PATTERNS)) {
    if (re.test(value)) return kind;
  }
  return null;
}
