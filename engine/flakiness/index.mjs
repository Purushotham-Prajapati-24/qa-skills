/**
 * Flakiness detection.
 *
 * The cardinal rule: a single failure is never flakiness. Labelling a real
 * defect "flaky" is one of the most expensive mistakes a testing system can
 * make, because it teaches humans to ignore a true signal.
 *
 * A test is only called flaky when the SAME code produced both outcomes.
 */
import * as state from '../state-engine/index.mjs';

export const MIN_RUNS = 3;

/** Build per-test history across every recorded execution. */
export function history() {
  const byTest = new Map();
  for (const exec of state.list('executions')) {
    for (const t of exec.test_results ?? []) {
      const key = `${t.file ?? ''}::${t.suite ?? ''}::${t.name}`;
      if (!byTest.has(key)) byTest.set(key, []);
      byTest.get(key).push({
        execution_id: exec.execution_id,
        at: exec.started_at,
        commit: exec.git?.commit ?? null,
        environment: exec.environment ?? null,
        status: t.status,
        duration_ms: t.duration_ms ?? null,
        retry_count: t.retry_count ?? 0,
      });
    }
  }
  return byTest;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, v) => a + v, 0) / values.length;
  return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1));
}

/**
 * @returns Array of {test, runs, verdict, confidence, reasons, evidence_needed}
 */
export function analyse() {
  const out = [];
  for (const [test, runs] of history()) {
    const sorted = [...runs].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const statuses = sorted.map((r) => r.status);
    const passed = statuses.filter((s) => s === 'PASSED').length;
    const failed = statuses.filter((s) => s === 'FAILED').length;
    const reasons = [];

    if (sorted.length < MIN_RUNS) {
      out.push({
        test,
        runs: sorted.length,
        verdict: 'insufficient-data',
        confidence: 0.9,
        reasons: [`Only ${sorted.length} run(s) recorded; flakiness cannot be asserted below ${MIN_RUNS}.`],
        evidence_needed: `Re-run this test ${MIN_RUNS - sorted.length} more time(s) at the same commit, in isolation.`,
        history: sorted,
      });
      continue;
    }

    if (passed === 0 || failed === 0) {
      out.push({
        test,
        runs: sorted.length,
        verdict: passed === 0 ? 'consistently-failing' : 'stable',
        confidence: 0.85,
        reasons: [passed === 0 ? 'Every recorded run failed. This is a defect signal, not flakiness.' : 'Every recorded run passed.'],
        history: sorted,
      });
      continue;
    }

    // Mixed outcomes. Did the code change between them?
    const commits = new Set(sorted.map((r) => r.commit).filter(Boolean));
    const environments = new Set(sorted.map((r) => r.environment).filter(Boolean));
    const sameCode = commits.size <= 1;
    const retried = sorted.some((r) => r.retry_count > 0);
    const durations = sorted.map((r) => r.duration_ms).filter((d) => typeof d === 'number');
    const variance = durations.length >= 2 ? stdev(durations) / (durations.reduce((a, v) => a + v, 0) / durations.length) : 0;

    let verdict = 'unstable-cause-unknown';
    let confidence = 0.4;

    if (sameCode) {
      verdict = 'flaky';
      confidence = 0.7;
      reasons.push(`Mixed outcomes (${passed} passed / ${failed} failed) at a single commit (${[...commits][0] ?? 'unrecorded'}): the code did not change between runs.`);
    } else {
      verdict = 'outcome-changed-with-code';
      confidence = 0.75;
      reasons.push(`Outcomes differ across ${commits.size} commits. This looks like a real behavioural change, not flakiness. Bisect before blaming the test.`);
    }

    if (environments.size > 1) {
      confidence = Math.min(confidence, 0.5);
      reasons.push(`Runs span ${environments.size} environments (${[...environments].join(', ')}); the environment is a competing explanation.`);
    }
    if (retried) reasons.push('At least one run passed only after a retry — a classic flakiness marker.');
    if (variance > 0.5) reasons.push(`Duration variance is high (coefficient ${variance.toFixed(2)}), consistent with timing sensitivity.`);

    out.push({
      test,
      runs: sorted.length,
      verdict,
      confidence: Number(confidence.toFixed(2)),
      pass_rate: Number((passed / sorted.length).toFixed(2)),
      reasons,
      history: sorted,
    });
  }
  return out.sort((a, b) => (a.pass_rate ?? 1) - (b.pass_rate ?? 1));
}

export function flakyTests() {
  return analyse().filter((a) => a.verdict === 'flaky');
}
