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
import { open as openUncertainties } from '../uncertainty-register/index.mjs';
import { catalog } from '../applicability-engine/index.mjs';
import { SYSTEM_VERSION } from '../core/version.mjs';

const BLOCKED_LIKE = new Set(['BLOCKED', 'NEEDS_USER_INPUT']);
const JUSTIFIED_NOTRUN = new Set(['BLOCKED', 'NEEDS_USER_INPUT', 'DEFERRED']);

/**
 * Does this execution count toward a coverage floor? A real run always does, whatever its
 * outcome -- a FAILED run is still testing. A not-run counts only when it documents a real
 * obstacle (BLOCKED/NEEDS_USER_INPUT/DEFERRED) AND links the uncertainty saying what would
 * unblock it. A bare SKIPPED, or a DEFERRED with nothing linked, waves the gap away without
 * testing or justifying it, so it does not count.
 */
export function countsAsCoverage(e) {
  if (e.method !== 'not-executed') return true;
  return JUSTIFIED_NOTRUN.has(e.status) && (e.uncertainties ?? []).length > 0;
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
  const executions = state.list('executions');
  const decisions = state.list('decisions');

  // "not-executed" records exist purely to document a BLOCKED/SKIPPED item (see
  // execution-engine's `not-run`) -- they never represent a choice that needed deciding,
  // so they must not count toward "real work happened here and nothing was decided".
  const real = executions.filter((e) => e.method !== 'not-executed');

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
    const covered = new Set(executions.filter(countsAsCoverage).map((e) => e.test_category).filter(Boolean));
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
    const coveredFeatures = new Set(executions.filter(countsAsCoverage).map((e) => e.feature).filter(Boolean));
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
    [session, ...decisions, ...real, ...state.list('evidence'), ...state.list('findings')]
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
