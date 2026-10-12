/**
 * Process-completeness checks.
 *
 * `ast validate` checks schema conformance and referential integrity. It says nothing
 * about whether the PROCESS the orchestrator's own skill describes actually happened: a
 * session can run real executions, skip every decision record, and leave blocked work
 * unraised as an uncertainty, and `validate` will say "No problems found." A field trial
 * did exactly this and the resulting report's own integrity block said "No integrity
 * violations detected" over a session with zero decisions, zero uncertainties and zero
 * git provenance -- gaps its own agent later confessed to in a written appendix that nothing
 * in the tool's output ever surfaced.
 *
 * Two severities, not one, because the same fact means something different depending on
 * when it is checked:
 *
 *  - `advisory` -- true and worth knowing mid-session, but not yet a defect. A session
 *    that opened one execution a moment ago legitimately has zero decisions so far; a
 *    hard failure here, at the exact point the orchestrator's skill tells the agent to
 *    run `ast validate` (BEFORE `report generate`), would fire during correct behaviour
 *    and teach agents to route around the check rather than heed it.
 *  - `blocking` -- promoted only under `ast validate --final`, the "before you tell the
 *    user you have finished" gate. By then the gap is permanent, not in-progress.
 *
 * `no-git-provenance` ships advisory-only even under `--final`, on purpose: nothing in
 * this system yet captures git provenance automatically (see PROGRESS.md's "Known
 * issues"), so promoting it to blocking today would fail every session on a gap it has no
 * way to close by itself. Promote it once an auto-capture path exists.
 */
import * as state from '../state-engine/index.mjs';
import { open as openUncertainties, BLOCKING_STATUSES } from '../uncertainty-register/index.mjs';
import { catalog } from '../applicability-engine/index.mjs';
import { SYSTEM_VERSION } from '../core/version.mjs';
import { stateRoot } from '../core/paths.mjs';
import { authoredTestFiles, executionRanFile } from '../core/authored-tests.mjs';
import * as integrity from './integrity.mjs';

const BLOCKED_LIKE = new Set(['BLOCKED', 'NEEDS_USER_INPUT']);
const JUSTIFIED_NOTRUN = new Set(['BLOCKED', 'NEEDS_USER_INPUT', 'DEFERRED']);
const RAN = new Set(['PASSED', 'FAILED', 'PARTIAL', 'COMPLETED', 'INCONCLUSIVE']);
const COMMITTED = new Set(['must-test', 'blocked']);

// Commands that run nothing under test. Evidence from one of these proves only that a shell
// exists, so it never makes a run count. Deliberately narrow: it catches `echo PASSED` and
// `node -e 0`, not every weak command -- the evidence-auditor is the semantic check.
const TRIVIAL_EXE = new Set(['echo', 'printf', 'true', ':', 'exit', 'rem', 'write-output', 'write-host', 'cat', 'type', 'sleep']);
const TRIVIAL_INLINE = /^\s*(\d+|true|false|null|undefined|pass|""|''|process\.exit\(\s*\d*\s*\)|(sys\.)?exit\(\s*\d*\s*\)|(console\.log|print)\(\s*(['"`][^'"`]*['"`]|\d+)?\s*\))\s*;?\s*$/i;

export function isTrivialCommand(argv) {
  let tokens = String(argv ?? '').match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  if (tokens.length === 0) return true;
  // Records written before argv elements were quoted: an absolute Windows path with spaces
  // ("C:\Program Files\nodejs\node.exe -e 0") arrives split. Re-join up to the executable.
  if (/^[A-Za-z]:[\\/]/.test(tokens[0]) && !/\.(exe|cmd|bat|com)$/i.test(tokens[0])) {
    const end = tokens.findIndex((t) => /\.(exe|cmd|bat|com)$/i.test(t));
    if (end > 0) tokens = [tokens.slice(0, end + 1).join(' '), ...tokens.slice(end + 1)];
  }
  const unq = (t) => t.replace(/^["']|["']$/g, '');
  const exe = unq(tokens[0]).replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '');
  if (TRIVIAL_EXE.has(exe)) return true;
  if ((exe === 'cmd') && tokens.some((t) => /^\/c$/i.test(t))) {
    const after = tokens.slice(tokens.findIndex((t) => /^\/c$/i.test(t)) + 1);
    return after.length === 0 || TRIVIAL_EXE.has(unq(after[0]).toLowerCase());
  }
  if (/^(node|python3?|py|ruby|perl|deno|bun)$/.test(exe)) {
    const flag = tokens.findIndex((t) => /^-(e|c|p|-eval|-print)$/.test(t));
    if (flag !== -1) return TRIVIAL_INLINE.test(unq(tokens.slice(flag + 1).join(' ')));
  }
  return false;
}

/**
 * Build a judge for "does this execution count toward a coverage floor?". One rule for every
 * floor, so `plan progress`, `todo`, the report and `validate --final` can never disagree.
 *
 *  - A run counts when it finished and is backed by at least one ANCHORED evidence item (a
 *    real artifact, or captured output with an exit code) from a command that actually ran
 *    something -- whatever the outcome: FAILED is testing. An INTERRUPTED or still-open run,
 *    a claim with no evidence, evidence that is only the agent's own sentence (`asserted`),
 *    and `echo PASSED` tested nothing.
 *  - A hold (BLOCKED / NEEDS_USER_INPUT / DEFERRED) counts only while it links an OPEN
 *    uncertainty the agent cannot clear itself: a blocking status, or a user-owned hold whose
 *    `user_quote` is found in what the user actually said. "I chose not to" is not a blocker,
 *    labelling it user-owned without the user's words does not make it one, and a blocker that
 *    has since been resolved means the work must now run.
 *  - NOT_APPLICABLE counts only when a recorded decision backs it.
 */
export function coverageJudge() {
  const uncertainties = new Map(state.listForSession('uncertainties').map((u) => [u.id, u]));
  const decisionIds = new Set(state.listForSession('decisions').map((d) => d.decision_id));
  const evidence = new Map(state.listForSession('evidence').map((ev) => [ev.evidence_id, ev]));
  const isRealBlocker = (id) => {
    const u = uncertainties.get(id);
    if (!u || u.status === 'resolved') return false;
    if (BLOCKING_STATUSES.has(u.status)) return true;
    return u.owner === 'user' && Boolean(u.user_quote) && state.verifyUserQuote(u.user_quote) !== null;
  };
  const isProof = (id) => {
    const ev = evidence.get(id);
    if (!ev || ev.grade === 'asserted') return false;
    if (ev.command && !Number.isInteger(ev.command.exit_code)) return false; // never completed
    return !(ev.command?.argv !== undefined && isTrivialCommand(ev.command.argv));
  };
  return function judge(e) {
    if (!e.finished_at) return false;
    if (JUSTIFIED_NOTRUN.has(e.status)) return (e.uncertainties ?? []).some(isRealBlocker);
    if (e.status === 'NOT_APPLICABLE') return Boolean(e.decision_id && decisionIds.has(e.decision_id));
    if (e.method === 'not-executed') return false;
    return RAN.has(e.status) && (e.evidence ?? []).some(isProof);
  };
}

/** Single-record convenience form. Safe as an Array#filter callback. */
export function countsAsCoverage(e) {
  return coverageJudge()(e);
}

/**
 * Holds whose every linked blocker has since been resolved and whose target has not been
 * covered since. The obstacle is gone; the work is owed now.
 */
function unblockedHolds(executions, judge) {
  const resolved = new Set(state.listForSession('uncertainties').filter((u) => u.status === 'resolved').map((u) => u.id));
  const covered = executions.filter(judge);
  const coveredBy = (e) => covered.some((c) => (e.plan_scenario_id && c.plan_scenario_id === e.plan_scenario_id)
    || (!e.plan_scenario_id && e.feature && c.feature === e.feature)
    || (!e.plan_scenario_id && !e.feature && e.test_category && c.test_category === e.test_category));
  return executions.filter((e) => JUSTIFIED_NOTRUN.has(e.status)
    && (e.uncertainties ?? []).length > 0
    && e.uncertainties.every((id) => resolved.has(id))
    && !coveredBy(e));
}

/**
 * Per-scenario view of every plan commitment made this session: the strongest obligation the
 * scenario ever had, and whether it is covered under the same judge as the floor.
 */
export function planProgress() {
  const plans = state.sessionPlans();
  const commitments = state.planCommitments();
  const latest = state.loadPlan();
  const judge = coverageJudge();
  const executions = state.listForSession('executions');
  const ids = new Set([...Object.keys(commitments), ...plans.flatMap((pl) => pl.scenarios.map((s) => s.id))]);
  const scenarios = [...ids].map((id) => {
    const c = commitments[id] ?? plans.flatMap((pl) => pl.scenarios).find((s) => s.id === id);
    const linked = executions.filter((e) => e.plan_scenario_id === id);
    // A link only discharges a scenario when it tested the scenario's kind of thing: a smoke
    // run tagged with the security scenario's id is not a security test. Holds and
    // NOT_APPLICABLE records are exempt -- they record why nothing of that kind could run.
    const sameKind = (e) => !c.category || !e.test_category || e.test_category === c.category || e.method === 'not-executed';
    const covering = linked.find((e) => judge(e) && sameKind(e));
    return {
      id,
      title: c.title,
      category: c.category,
      ...(c.feature ? { feature: c.feature } : {}),
      obligation: c.obligation,
      executed: Boolean(covering),
      disposed: linked.some((e) => e.finished_at),
      execution: covering ? { execution_id: covering.execution_id, status: covering.status, method: covering.method } : null,
      attempts: linked.map((e) => ({ execution_id: e.execution_id, status: e.status, category: e.test_category ?? null, counts: judge(e) && sameKind(e) })),
      mismatched: linked.filter((e) => judge(e) && !sameKind(e)).map((e) => ({ execution_id: e.execution_id, category: e.test_category })),
    };
  });
  const committed = scenarios.filter((s) => COMMITTED.has(s.obligation));
  const done = committed.filter((s) => s.executed);
  return {
    plan_id: latest?.plan_id ?? null,
    plans_in_session: plans.map((pl) => pl.plan_id),
    total_scenarios: scenarios.length,
    must_test: committed.length,
    must_test_executed: done.length,
    must_test_remaining: committed.length - done.length,
    should_test_undisposed: scenarios.filter((s) => s.obligation === 'should-test' && !s.disposed).map((s) => s.id),
    scenarios,
  };
}

/** Test files authored this session and, for each, the qualifying execution that ran it (or null). */
export function authoredTests() {
  const session = state.loadSession();
  if (!session?.started_at) return [];
  const files = authoredTestFiles({
    baseline: state.loadAuthoredBaseline(),
    since: session.started_at,
    baseCommit: session.git?.commit ?? null,
    excludeDir: stateRoot(),
  });
  if (!files) return [];
  const judge = coverageJudge();
  const qualifying = state.listForSession('executions').filter(judge);
  return files.map((file) => {
    const ran = qualifying.filter((e) => executionRanFile(e, file));
    const real = ran.find((e) => e.method !== 'not-executed');
    const by = real ?? ran[0] ?? null;
    return { file, ran: Boolean(real), held: !real && Boolean(by), execution_id: by?.execution_id ?? null, status: by?.status ?? null };
  });
}

// Kinds that assert "the product is wrong". These need proof by an executable check; the rest
// (coverage gaps, test-quality issues, observations, ambiguities) are not defect claims.
export const DEFECT_KINDS = new Set(['defect', 'regression', 'security-issue', 'accessibility-violation', 'performance-issue', 'data-integrity-issue']);
const SERIOUS = new Set(['blocker', 'critical', 'major']);
const REJECTED = new Set(['not-a-defect', 'wont-report']);

/**
 * Is this finding a proven defect? Computed, never stored, so it cannot go stale.
 *
 * A finding is CONFIRMED only by a linked execution (the run it was found in, or a later run
 * with `reproduces: <finding id>`) that is a repro check failing today on the assertion that
 * encodes the bug: a real run, FAILED, classified `product-defect` (not a locator, timeout,
 * environment or setup failure), with real evidence of the failure -- a captured non-zero
 * exit from a command that ran something, or a failing per-test result -- and a recorded
 * command to re-run it. That check turns green when the bug is fixed.
 *
 *  - held:      a linked repro hold on a real, open blocker (the repro cannot run yet).
 *  - refuted:   a linked repro run PASSED with real evidence -- the claim did not reproduce.
 *  - rejected:  triaged out with a cited reason (`finding reject`).
 *  - unverified: anything else, with the reason each linked run did not confirm it.
 */
export function findingVerifier() {
  const judge = coverageJudge();
  const evidence = new Map(state.listForSession('evidence').map((ev) => [ev.evidence_id, ev]));
  const executions = state.listForSession('executions');
  const realEvidence = (id) => {
    const ev = evidence.get(id);
    return ev && ev.grade !== 'asserted' && !(ev.command?.argv !== undefined && isTrivialCommand(ev.command.argv)) ? ev : null;
  };
  return function verify(f) {
    if (f.duplicate_of) return { status: 'duplicate', execution_id: null, repro: null, reason: `Duplicate of ${f.duplicate_of}.` };
    if (REJECTED.has(f.triage?.state)) {
      return { status: 'rejected', execution_id: null, repro: null, reason: `${f.triage.reason_class ?? 'rejected'}: ${f.triage.note ?? ''}${f.triage.citation ? ` (${f.triage.citation})` : ''}`.trim() };
    }
    const linked = executions.filter((e) => e.reproduces === f.finding_id
      || (f.execution_id && e.execution_id === f.execution_id)
      || (e.findings ?? []).includes(f.finding_id));
    const why = [];
    for (const e of linked) {
      if (e.method === 'not-executed' || !e.finished_at || e.status !== 'FAILED') continue;
      const cls = e.failure_classification?.class;
      if (cls !== 'product-defect') {
        why.push(`${e.execution_id} FAILED but is classified ${cls ?? 'unclassified'}, not product-defect (pass the real failure signals, e.g. "assertion-mismatch", on exec finish)`);
        continue;
      }
      const proofs = (e.evidence ?? []).map(realEvidence).filter(Boolean);
      const failingExit = proofs.find((ev) => Number.isInteger(ev.command?.exit_code) && ev.command.exit_code !== 0);
      const failingTest = proofs.length > 0 && (e.test_results ?? []).some((t) => t.status === 'FAILED');
      if (!failingExit && !failingTest) {
        why.push(`${e.execution_id} has no real evidence of the failure (a captured non-zero exit, or a failing per-test result)`);
        continue;
      }
      const repro = e.command || failingExit?.command?.argv || (e.test_files ?? []).join(', ') || null;
      if (!repro) {
        why.push(`${e.execution_id} records no command to re-run the check`);
        continue;
      }
      return { status: 'confirmed', execution_id: e.execution_id, repro, reason: `${e.execution_id} fails on a product-defect assertion.` };
    }
    const hold = linked.find((e) => e.reproduces === f.finding_id && e.method === 'not-executed' && judge(e));
    if (hold) return { status: 'held', execution_id: hold.execution_id, repro: null, reason: `Repro held: ${hold.status_reason}` };
    const passed = linked.find((e) => e.reproduces === f.finding_id && e.method !== 'not-executed' && e.status === 'PASSED' && judge(e));
    if (passed) {
      return { status: 'refuted', execution_id: passed.execution_id, repro: passed.command ?? null, reason: `Repro ${passed.execution_id} PASSED: the claim did not reproduce. Reject it (not-reproduced) or write a repro that encodes the bug.` };
    }
    return {
      status: 'unverified',
      execution_id: null,
      repro: null,
      reason: why.length ? why.join('; ') : 'No linked execution fails on it. Write a check that encodes the bug and run it with "reproduces".',
    };
  };
}

/**
 * The work queue: everything still owed before `validate --final` can pass, as actionable
 * items. The orchestrator loops on this instead of deciding for itself that it is finished.
 */
// Queue order: set the session up first (plan, matrix, decisions), then do the committed work,
// then prove and tidy. An agent taking items top-down never does work twice or in the wrong order.
const QUEUE_ORDER = [
  'integrity:schema', 'integrity:dangling', 'no-plan', 'plan-without-commitments', 'no-applicability-matrix', 'no-functionality-inventory',
  'plan-misses-floor-category', 'plan-misses-feature', 'no-decisions', 'unknown-plan-scenario',
  'unblocked-not-rerun', 'scenario-coverage-floor', 'scenario-category-mismatch', 'authored-test-not-run',
  'unconfirmed-defect', 'coverage-floor', 'feature-coverage-floor', 'scenario-disposition',
  'category-disposition', 'blocked-without-uncertainty', 'integrity:open-execution',
];

/**
 * The work queue: everything still owed before `validate --final` can pass, as actionable
 * items, in the order to take them. A floor gap that an owed scenario will discharge is folded
 * into that scenario's item (`also_covers`) instead of being listed as separate work.
 */
export function outstanding() {
  if (!state.loadSession()) {
    return {
      done: false,
      count: 1,
      items: [{ check: 'no-session', what: 'No testing session exists here, so nothing has been planned or run.', next: 'session start --request "<the user\'s words>" (or `session resume` if you expected one)' }],
    };
  }
  // Structural problems fail `validate` outright, so they are owed first -- an open run or a
  // dangling reference must never leave the queue "done" while the gate still fails.
  let items = integrity.structuralCheck().problems.map((p) => ({ check: `integrity:${p.kind}`, ref: p.ref, what: p.message, next: p.next }));
  for (const f of check()) {
    if (f.severity !== 'blocking') continue;
    if (f.items) items.push(...f.items.map((i) => ({ check: f.check, ...i })));
    else items.push({ check: f.check, what: f.message, next: f.next ?? null });
  }
  const scenarioItems = new Map(items.filter((i) => i.check === 'scenario-coverage-floor').map((i) => [i.ref, i]));
  items = items.filter((i) => {
    const host = i.via && scenarioItems.get(i.via);
    if (!host) return true;
    host.also_covers = [...(host.also_covers ?? []), `${i.check}:${i.ref}`];
    return false;
  });
  const rank = (c) => { const r = QUEUE_ORDER.indexOf(c); return r === -1 ? QUEUE_ORDER.length : r; };
  items.sort((a, b) => rank(a.check) - rank(b.check));
  return { done: items.length === 0, count: items.length, items };
}

/**
 * The matrix rows the category floor enforces: every applicable P0/P1 category, plus every
 * applicable category the catalog marks `mandatory` (the security, input edge-case,
 * accessibility and performance baselines) whatever its score -- a baseline that only bites
 * when it happens to rank high is not a baseline.
 */
export function floorCategories(rows) {
  const defs = catalog().categories;
  return (rows ?? []).filter((r) => r.applicable
    && (r.priority === 'P0' || r.priority === 'P1' || defs[r.category]?.mandatory === true));
}

/**
 * @returns {Array<{check: string, severity: 'advisory'|'blocking', message: string}>}
 */
export function check() {
  const executions = state.listForSession('executions');
  const decisions = state.listForSession('decisions');

  // "not-executed" records exist purely to document a BLOCKED/SKIPPED item (see
  // execution-engine's `not-run`) -- they never represent a choice that needed deciding,
  // so they must not count toward "real work happened here and nothing was decided".
  const real = executions.filter((e) => e.method !== 'not-executed');
  const judge = coverageJudge();
  const progress = planProgress();
  // When a committed scenario that is still owed would also discharge a category or feature
  // gap, the gap points at that scenario -- one run, not two.
  const owedScenario = (pred) => progress.scenarios.find((s) => COMMITTED.has(s.obligation) && !s.executed && pred(s));

  const findings = [];

  if (real.length > 0 && decisions.length === 0) {
    findings.push({
      check: 'no-decisions',
      severity: 'blocking',
      message: 'No decision records. The tool, depth and scope choices in this session cannot be reconstructed from state alone.',
    });
  }

  const blockedExecutions = executions.filter((e) => BLOCKED_LIKE.has(e.status));
  const openUncertaintyCount = openUncertainties().length;
  if (blockedExecutions.length > 0 && openUncertaintyCount === 0) {
    findings.push({
      check: 'blocked-without-uncertainty',
      severity: 'blocking',
      message: `${blockedExecutions.length} execution(s) are BLOCKED or NEEDS_USER_INPUT `
        + `(${blockedExecutions.map((e) => e.execution_id).join(', ')}), but no uncertainty `
        + 'was ever raised, so nothing records what would unblock them.',
    });
  }

  // Coverage floor. The applicability matrix names which categories are relevant and how
  // important; nothing used to check that the important ones actually ran. A bare-URL session
  // could mark a dozen categories applicable, run three, and finish clean -- the exact silent
  // under-coverage this check exists to stop. See floorCategories() for what is enforced and
  // countsAsCoverage() for what satisfies it.
  const matrix = state.loadApplicability();
  if (matrix?.matrix) {
    const covered = new Set(executions.filter(judge).map((e) => e.test_category).filter(Boolean));
    const uncovered = floorCategories(matrix.matrix).filter((r) => !covered.has(r.category));
    if (uncovered.length > 0) {
      const defs = catalog().categories;
      findings.push({
        check: 'coverage-floor',
        severity: 'blocking',
        message: `${uncovered.length} applicable categor${uncovered.length === 1 ? 'y the floor enforces has' : 'ies the floor enforces have'} `
          + `no qualifying execution: ${uncovered.map((r) => `${r.category} (${defs[r.category]?.mandatory ? `mandatory baseline, ${r.priority}` : r.priority})`).join(', ')}. `
          + 'Each applicable P0/P1 category and each applicable mandatory baseline needs a real run, or an '
          + '`exec not-run` with a BLOCKED/DEFERRED status that links an uncertainty saying what would unblock '
          + 'it. A category with no such record is silent under-coverage.',
        items: uncovered.map((r) => {
          const via = owedScenario((s) => s.category === r.category);
          return {
            ref: r.category,
            what: `Category "${r.category}" (${r.priority}${defs[r.category]?.mandatory ? ', mandatory baseline' : ''}) has no qualifying execution.`,
            next: via
              ? `run scenario ${via.id}: exec start {"plan_scenario_id":"${via.id}"} -- it covers this category too`
              : `exec start {"testCategory":"${r.category}", ...} then evidence capture and exec finish`,
            ...(via ? { via: via.id } : {}),
          };
        }),
      });
    }
  } else if (real.length > 0) {
    // Blocking, not advisory: if skipping `applicability eval` silenced the floor, the floor
    // would be optional. Like every blocking gap it only fails `validate --final`.
    findings.push({
      check: 'no-applicability-matrix',
      severity: 'blocking',
      message: 'No applicability matrix is persisted, so the coverage floor could not be checked. '
        + 'Run `ast applicability eval` during planning so breadth is verified before you finish -- '
        + 'without it, nothing can tell an applicable category that silently never ran from one that '
        + 'was never relevant.',
    });
  }

  // Per-feature floor. The functionality inventory is the breadth ledger -- every feature the
  // agent found. "Test each functionality end to end" means each high/critical item must be
  // addressed by at least one execution tagged with its id (a real run or a justified not-run).
  // A critical feature with no tagged execution is exactly the "it didn't test everything" gap.
  const profile = state.loadProfile();
  const inventory = profile?.functionality_inventory ?? [];
  // The per-feature floor only bites when an inventory exists, so skipping the inventory used
  // to skip the floor too -- on a repository and on a URL alike. When the profile itself shows
  // a feature surface (a frontend, an API, a critical component), a missing inventory is the
  // gap, not a free pass -- whether or not anything has run yet.
  const hasFeatureSurface = Boolean(profile?.architecture?.frontend?.present)
    || (profile?.apis ?? []).length > 0
    || (profile?.critical_components ?? []).length > 0;
  if (profile && hasFeatureSurface && inventory.length === 0) {
    findings.push({
      check: 'no-functionality-inventory',
      severity: 'blocking',
      message: 'The profile shows a feature surface (frontend, API or critical components) but has no '
        + '`functionality_inventory`, so nothing can tell which features were tested and which were never '
        + 'touched. Enumerate every page, endpoint and flow -- from routes and handlers in a repository, from '
        + 'the UI and observed API calls on a URL -- save it with `profile save`, and tag executions with '
        + '`"feature": "<id>"`.',
    });
  }
  if (inventory.length > 0) {
    const coveredFeatures = new Set(executions.filter(judge).map((e) => e.feature).filter(Boolean));
    const mustCover = inventory.filter((it) => it.criticality === 'high' || it.criticality === 'critical');
    const uncovered = mustCover.filter((it) => !coveredFeatures.has(it.id));
    if (uncovered.length > 0) {
      findings.push({
        check: 'feature-coverage-floor',
        severity: 'blocking',
        message: `${uncovered.length} high/critical feature(s) from the functionality inventory have no execution `
          + `tagged to them: ${uncovered.map((it) => `${it.id} (${it.name})`).join(', ')}. `
          + '"Test each functionality end to end" means every critical feature needs at least one execution tagged '
          + 'with its id (`exec start ... "feature": "<id>"`), or a BLOCKED/DEFERRED not-run that links an '
          + 'uncertainty. Tag the runs you did, or test the features you missed.',
        items: uncovered.map((it) => {
          const via = owedScenario((s) => s.feature === it.id);
          return {
            ref: it.id,
            what: `Feature ${it.id} (${it.name}, ${it.criticality}) has no qualifying execution.`,
            next: via
              ? `run scenario ${via.id}: exec start {"plan_scenario_id":"${via.id}"} -- it covers this feature too`
              : `exec start {"feature":"${it.id}", ...} then evidence capture and exec finish`,
            ...(via ? { via: via.id } : {}),
          };
        }),
      });
    }
  }

  // Scenario coverage floor. A plan that names must-test scenarios is a commitment: every one
  // must either have a real execution linked to it, or a justified not-run (BLOCKED/DEFERRED
  // with an uncertainty). Without this, an agent can plan 15 scenarios, run 2, and pass
  // --final cleanly — the exact "writes a plan, doesn't execute it" gap the user reported.
  // Commitments ratchet: the union of every plan saved this session, at the strongest
  // obligation each scenario ever had, so re-saving a smaller plan cannot shed work.
  if (progress.plans_in_session.length === 0 && real.length > 0) {
    findings.push({
      check: 'no-plan',
      severity: 'blocking',
      message: 'Real executions exist but no plan was persisted, so nothing can check that what was planned was run. '
        + 'Write the plan and save it with `ast plan save --input plan.json`, then link each execution with `plan_scenario_id`.',
      next: 'plan save --input plan.json',
    });
  }
  if (progress.plans_in_session.length > 0 && progress.must_test === 0) {
    findings.push({
      check: 'plan-without-commitments',
      severity: 'blocking',
      message: 'The persisted plan has no must-test scenario, so it commits to nothing and the scenario floor has nothing to enforce. '
        + 'Mark the scenarios the session cannot finish without as `must-test`.',
      next: 'plan save --input plan.json (with must-test scenarios)',
    });
  }

  const unrun = progress.scenarios.filter((s) => COMMITTED.has(s.obligation) && !s.executed);
  if (unrun.length > 0) {
    findings.push({
      check: 'scenario-coverage-floor',
      severity: 'blocking',
      message: `${unrun.length} must-test scenario(s) have no qualifying execution: `
        + `${unrun.map((s) => `${s.id} (${s.title}${s.obligation === 'blocked' ? ', planned as blocked' : ''})`).join(', ')}. `
        + 'A scenario is discharged by a finished run with evidence (`plan_scenario_id` on `exec start`), or by an '
        + '`exec not-run` BLOCKED/DEFERRED linked to an open blocker the agent cannot clear itself. INTERRUPTED runs, '
        + 'claims with no evidence, and self-chosen deferrals do not count. A plan without execution is a wish list.',
      items: unrun.map((s) => ({
        ref: s.id,
        what: `${s.obligation} scenario ${s.id} "${s.title}" is not covered${s.attempts.length ? ` (attempts: ${s.attempts.map((a) => `${a.execution_id} ${a.status}`).join(', ')})` : ''}.`,
        next: `exec start {"plan_scenario_id":"${s.id}","testCategory":"${s.category}", ...} then evidence capture and exec finish`,
      })),
    });
  }

  if (progress.should_test_undisposed.length > 0) {
    findings.push({
      check: 'scenario-disposition',
      severity: 'blocking',
      message: `${progress.should_test_undisposed.length} should-test scenario(s) have no record at all: `
        + `${progress.should_test_undisposed.join(', ')}. Run each, or record an explicit `
        + '`exec not-run` (any status, with the reason) so the exclusion is visible in the report instead of silent.',
      items: progress.should_test_undisposed.map((id) => ({
        ref: id, what: `should-test scenario ${id} has no run and no recorded skip.`, next: `run it, or exec not-run {"plan_scenario_id":"${id}", "status":"SKIPPED", "reason":"..."}`,
      })),
    });
  }

  if (progress.plans_in_session.length > 0) {
    const known = new Set(progress.scenarios.map((s) => s.id));
    const dangling = executions.filter((e) => e.plan_scenario_id && !known.has(e.plan_scenario_id));
    if (dangling.length > 0) {
      findings.push({
        check: 'unknown-plan-scenario',
        severity: 'blocking',
        message: `${dangling.length} execution(s) link a scenario id that no plan in this session defines: `
          + `${dangling.map((e) => `${e.execution_id} -> ${e.plan_scenario_id}`).join(', ')}. They count toward nothing; `
          + 'fix the id (a typo leaves the real scenario unrun) or add the scenario to the plan.',
      });
    }
  }

  const reopen = unblockedHolds(executions, judge);
  if (reopen.length > 0) {
    findings.push({
      check: 'unblocked-not-rerun',
      severity: 'blocking',
      message: `${reopen.length} held item(s) had every blocker resolved and were never run: `
        + `${reopen.map((e) => `${e.execution_id} "${e.goal}"${e.plan_scenario_id ? ` (${e.plan_scenario_id})` : ''}`).join(', ')}. `
        + 'The obstacle is gone -- run them now.',
      items: reopen.map((e) => ({
        ref: e.plan_scenario_id ?? e.feature ?? e.test_category ?? e.execution_id,
        what: `"${e.goal}" was held by ${e.uncertainties.join(', ')}, now resolved.`,
        next: `exec start {${e.plan_scenario_id ? `"plan_scenario_id":"${e.plan_scenario_id}",` : ''}"testCategory":"${e.test_category ?? ''}", ...}`,
      })),
    });
  }

  const mismatched = progress.scenarios.filter((s) => !s.executed && s.mismatched.length > 0);
  if (mismatched.length > 0) {
    findings.push({
      check: 'scenario-category-mismatch',
      severity: 'blocking',
      message: `${mismatched.length} scenario(s) are linked only to runs of a different category: `
        + `${mismatched.map((s) => `${s.id} (${s.category}) <- ${s.mismatched.map((m) => `${m.execution_id} ${m.category}`).join(', ')}`).join('; ')}. `
        + 'A run of another kind does not test this scenario. Run the scenario itself, or correct the plan if the scenario was miscategorised.',
      items: mismatched.map((s) => ({
        ref: s.id, what: `${s.id} is a ${s.category} scenario; its linked run(s) were ${s.mismatched.map((m) => m.category).join(', ')}.`,
        next: `exec start {"plan_scenario_id":"${s.id}"} (category is inherited from the plan)`,
      })),
    });
  }

  const unrunTests = authoredTests().filter((t) => !t.ran && !t.held).map((t) => t.file);
  if (unrunTests.length > 0) {
    findings.push({
      check: 'authored-test-not-run',
      severity: 'blocking',
      message: `${unrunTests.length} test file(s) were written or changed this session and never executed: ${unrunTests.join(', ')}. `
        + 'A test that has not run is a draft. Run each one now (name it in the command, or list it in `test_files` on `exec start`); '
        + 'if it needs something missing, run what it can against a mock or local stand-in and record the rest BLOCKED '
        + 'with `test_files` and a linked blocker.',
      items: unrunTests.map((f) => ({
        ref: f, what: `Authored test ${f} has never run.`, next: `exec start {"test_files":["${f}"], "command":"<runner> ${f}", ...} then evidence capture -- <runner> ${f}`,
      })),
    });
  }

  // Defect claims need proof. A serious finding that asserts the product is wrong must be
  // confirmed by a failing repro check, held on a real blocker, or rejected with a cited
  // reason -- never shipped as "a bug" on the strength of an observation.
  const verify = findingVerifier();
  const claims = state.listForSession('findings')
    .filter((f) => !f.duplicate_of && DEFECT_KINDS.has(f.kind))
    .map((f) => ({ f, v: verify(f) }))
    .filter(({ v }) => v.status === 'unverified' || v.status === 'refuted');
  const seriousClaims = claims.filter(({ f }) => SERIOUS.has(f.severity));
  if (seriousClaims.length > 0) {
    findings.push({
      check: 'unconfirmed-defect',
      severity: 'blocking',
      message: `${seriousClaims.length} serious defect claim(s) are not proven: `
        + `${seriousClaims.map(({ f, v }) => `${f.finding_id} (${f.severity}, ${v.status})`).join(', ')}. `
        + 'Confirm each with a repro check that fails on the assertion encoding the bug (`exec start {"reproduces":"FIND-…"}`, '
        + '`evidence capture`, `exec finish` FAILED with the real failure signals), hold its repro on a real blocker, or '
        + '`finding reject` it with a cited reason.',
      items: seriousClaims.map(({ f, v }) => ({
        ref: f.finding_id,
        what: `${f.finding_id} "${f.title}" (${f.severity}) is ${v.status}: ${v.reason}`,
        next: v.status === 'refuted'
          ? `finding reject ${f.finding_id} --class not-reproduced --reason "..." --cite ${v.execution_id}, or write a repro that encodes the bug`
          : `exec start {"reproduces":"${f.finding_id}","test_files":["<repro test>"],"command":"<runner> <repro test>"} -> evidence capture -> exec finish {"status":"FAILED","signals":["assertion-mismatch"]}`,
      })),
    });
  }
  const minorClaims = claims.filter(({ f }) => !SERIOUS.has(f.severity));
  if (minorClaims.length > 0) {
    findings.push({
      check: 'unconfirmed-minor-defect',
      severity: 'advisory',
      message: `${minorClaims.length} minor defect claim(s) are not proven and will be reported as unverified: `
        + `${minorClaims.map(({ f, v }) => `${f.finding_id} (${v.status})`).join(', ')}.`,
    });
  }

  // Under-planning. The plan is the one list the agent works from (`todo`), so everything the
  // floors will demand has to be in it -- a thin plan that "forgets" the security baseline
  // only surfaces the gap at the very end, after the session has been paced around it.
  if (progress.plans_in_session.length > 0) {
    const committedScenarios = progress.scenarios.filter((s) => COMMITTED.has(s.obligation));
    if (matrix?.matrix) {
      const planned = new Set(committedScenarios.map((s) => s.category));
      const missing = floorCategories(matrix.matrix).filter((r) => !planned.has(r.category)).map((r) => r.category);
      if (missing.length > 0) {
        findings.push({
          check: 'plan-misses-floor-category',
          severity: 'blocking',
          message: `The plan has no must-test scenario for ${missing.length} categor${missing.length === 1 ? 'y' : 'ies'} the coverage floor enforces: `
            + `${missing.join(', ')}. Add one per category and re-save the plan.`,
          items: missing.map((c) => ({ ref: c, what: `No must-test scenario plans the ${c} category.`, next: `add {"id":"S-..","category":"${c}","obligation":"must-test",...} and plan save` })),
        });
      }
    }
    const mustCover = inventory.filter((it) => it.criticality === 'high' || it.criticality === 'critical');
    const thin = mustCover
      .map((it) => ({ it, n: committedScenarios.filter((s) => s.feature === it.id).length, need: it.criticality === 'critical' ? 2 : 1 }))
      .filter((x) => x.n < x.need);
    if (thin.length > 0) {
      findings.push({
        check: 'plan-misses-feature',
        severity: 'blocking',
        message: `${thin.length} high/critical feature(s) are under-planned: `
          + `${thin.map((x) => `${x.it.id} (${x.it.criticality}: ${x.n} of ${x.need} scenario(s))`).join(', ')}. `
          + 'Each high feature needs a committed scenario tagged with its `feature` id; each critical one needs two -- the happy path and an edge case.',
        items: thin.map((x) => ({
          ref: x.it.id, what: `${x.it.id} "${x.it.name}" has ${x.n} committed scenario(s); needs ${x.need}.`,
          next: `add {"id":"S-..","feature":"${x.it.id}","obligation":"must-test",...} and plan save`,
        })),
      });
    }
  }

  // Exclusions must be visible. Floor categories need real coverage; every other applicable
  // category needs at least a recorded disposition -- run, or a not-run (SKIPPED is fine) that
  // says why. Without this, P2/P3 categories the matrix called applicable vanished silently.
  if (matrix?.matrix) {
    const floor = new Set(floorCategories(matrix.matrix).map((r) => r.category));
    const touched = new Set(executions.filter((e) => e.finished_at && e.status !== 'INTERRUPTED').map((e) => e.test_category).filter(Boolean));
    const silent = matrix.matrix.filter((r) => r.applicable && !floor.has(r.category) && !touched.has(r.category));
    if (silent.length > 0) {
      findings.push({
        check: 'category-disposition',
        severity: 'blocking',
        message: `${silent.length} applicable categor${silent.length === 1 ? 'y has' : 'ies have'} no record at all: `
          + `${silent.map((r) => `${r.category} (${r.priority})`).join(', ')}. Run each, or record an \`exec not-run\` `
          + '(SKIPPED is fine for P2/P3) with the reason, so the exclusion is in the report instead of silent.',
        items: silent.map((r) => ({
          ref: r.category, what: `Applicable ${r.priority} category ${r.category} has no run and no recorded skip.`,
          next: `run it, or exec not-run {"testCategory":"${r.category}","status":"SKIPPED","reason":"..."}`,
        })),
      });
    }
  }

  // decision_accuracy is null and decision_assessment_rate is 0 until someone assesses a
  // decision, and nothing in the loop used to ask for it. Advisory: some outcomes are not
  // observable within one session, but "none of N" is worth saying out loud.
  if (decisions.length > 0 && !decisions.some((d) => d.outcome?.verdict)) {
    findings.push({
      check: 'no-decision-assessed',
      severity: 'advisory',
      message: `${decisions.length} decision(s) recorded, none assessed. For each whose outcome is now visible, run `
        + '`decision assess DEC-... --verdict correct|acceptable|suboptimal|wrong|unknown`; decision_accuracy stays null until you do.',
    });
  }

  const withGit = real.filter((e) => e.git?.commit);
  if (real.length > 0 && withGit.length === 0) {
    findings.push({
      check: 'no-git-provenance',
      severity: 'advisory',
      message: 'No execution carries a commit. Nothing in this session is reproducible against a known tree.',
    });
  }

  // A field trial's rendered report cited "AST v0.8.0" in one place while the skills it had
  // just run under declared v0.9.0 in another -- nothing had checked that the package was
  // not upgraded mid-session. `provenance.skill_version` is stamped from SYSTEM_VERSION at
  // the moment each record is created, so any stamped value other than the version running
  // right now IS that skew, whether it is the only version present (upgraded after the
  // session finished, before the report was generated) or one of several (upgraded partway
  // through). Advisory, like `no-git-provenance` above: an upgrade mid-session is not a
  // defect in the work, only a fact the report should be honest about.
  const session = state.loadSession();
  const stampedVersions = new Set(
    [session, ...decisions, ...real, ...state.listForSession('evidence'), ...state.listForSession('findings')]
      .map((r) => r?.provenance?.skill_version)
      .filter(Boolean),
  );
  const stale = [...stampedVersions].filter((v) => v !== SYSTEM_VERSION).sort();
  if (stale.length > 0) {
    findings.push({
      check: 'version-skew',
      severity: 'advisory',
      message: `Records were stamped under skill version(s) ${stale.join(', ')}, but the CLI `
        + `running right now is v${SYSTEM_VERSION}. The package was upgraded mid-session or `
        + 'after it -- findings, decisions and evidence recorded under the older version '
        + "reflect that version's behaviour, not this one's. Note the version(s) involved in "
        + 'the final report if that difference matters to how a finding should be read.',
    });
  }

  return findings;
}
