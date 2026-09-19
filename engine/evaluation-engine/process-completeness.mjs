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

const BLOCKED_LIKE = new Set(['BLOCKED', 'NEEDS_USER_INPUT']);

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

  const withGit = real.filter((e) => e.git?.commit);
  if (real.length > 0 && withGit.length === 0) {
    findings.push({
      check: 'no-git-provenance',
      severity: 'advisory',
      message: 'No execution carries a commit. Nothing in this session is reproducible against a known tree.',
    });
  }

  return findings;
}
