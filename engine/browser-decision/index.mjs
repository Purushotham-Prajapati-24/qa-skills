/**
 * Browser Method Decision Engine.
 *
 * Chooses between agent-driven exploration, a deterministic script, the
 * repository's existing browser tests, a hybrid of explore-then-automate, or
 * the repository's own non-Playwright stack.
 *
 * The engine exists because the tempting default -- "we have a browser MCP,
 * use the browser MCP" -- is wrong most of the time. An agent session is not
 * reproducible, so it cannot be a CI gate, and it produces no regression asset.
 * Equally, writing selectors for a UI nobody has looked at encodes guesses.
 *
 * Output is a fully itemised score per method plus the hard rules that fired,
 * so the choice can be audited and argued with.
 */
import path from 'node:path';
import { readJson } from '../core/fsjson.mjs';
import { PACKAGE_ROOT } from '../core/paths.mjs';

const M = readJson(path.join(PACKAGE_ROOT, 'engine', 'browser-decision', 'matrix.json'));

export const METHODS = Object.keys(M.methods);
export const FACTORS = Object.keys(M.factors);

function checkCondition(expr, value) {
  const m = /^(>=|<=|==|>|<)\s*(-?[\d.]+)$/.exec(String(expr).trim());
  if (!m) throw new Error(`Malformed hard-rule condition: ${expr}`);
  const [, op, nStr] = m;
  const n = Number(nStr);
  if (value === undefined || value === null) return false;
  switch (op) {
    case '>=': return value >= n;
    case '<=': return value <= n;
    case '>': return value > n;
    case '<': return value < n;
    case '==': return value === n;
    default: return false;
  }
}

/**
 * @param {object} input
 * @param {Record<string, number>} input.factors  Factor name -> value in [0,1].
 * @param {Record<string, boolean>} [input.capabilities] Capability verb -> available.
 * @param {boolean} [input.environmentIsProduction=false]
 * @param {string} [input.scenario] Free text, echoed into the rationale.
 */
export function decide({
  factors = {},
  capabilities = {},
  environmentIsProduction = false,
  scenario = '',
} = {}) {
  const unknown = Object.keys(factors).filter((f) => !M.factors[f]);
  if (unknown.length) {
    throw new Error(`Unknown browser-decision factor(s): ${unknown.join(', ')}. Declare them in browser-decision/matrix.json.`);
  }
  for (const [k, v] of Object.entries(factors)) {
    if (M.factors[k]?.raw) continue;
    if (typeof v !== 'number' || v < 0 || v > 1) {
      throw new Error(`Factor "${k}" must be a number in [0,1], got ${JSON.stringify(v)}`);
    }
  }

  const ruleInputs = { ...factors, environment_is_production: environmentIsProduction ? 1 : 0 };
  const forbidden = new Map();
  const firedRules = [];

  for (const rule of M.hard_rules) {
    const conditionsMet = Object.entries(rule.when).every(([f, expr]) => checkCondition(expr, ruleInputs[f]));
    if (!conditionsMet) continue;
    firedRules.push({ id: rule.id, because: rule.because, forbids: rule.forbid });
    for (const method of rule.forbid) {
      if (!forbidden.has(method)) forbidden.set(method, []);
      forbidden.get(method).push(`${rule.id}: ${rule.because}`);
    }
  }

  const candidates = [];
  for (const [id, def] of Object.entries(M.methods)) {
    const affinity = def.affinity ?? {};
    let weighted = 0;
    let weightTotal = 0;
    const contributions = [];

    for (const [factorName, pull] of Object.entries(affinity)) {
      const value = factors[factorName];
      if (typeof value !== 'number') continue; // unsupplied factors are excluded, never assumed
      // Map value in [0,1] against a pull in [-1,1]: agreement raises the score.
      const aligned = pull >= 0 ? value : 1 - value;
      const w = Math.abs(pull);
      weighted += aligned * w;
      weightTotal += w;
      contributions.push({ factor: factorName, value, pull, aligned: Number(aligned.toFixed(3)), weight: w });
    }

    const base = weightTotal === 0 ? 0 : weighted / weightTotal;
    const capability = def.capability;
    // Three states: true, false, and undeclared. Only an explicit `true` counts as
    // available -- an undeclared capability is exactly as unusable as a declared-false
    // one, per ARCHITECTURE §3, so this must not be a loose `!== false` check.
    const capAvailable = capability ? capabilities[capability] === true : true;
    const blocks = forbidden.get(id) ?? [];
    if (!capAvailable) blocks.push(`capability "${capability}" is not available in this environment`);

    candidates.push({
      id,
      label: def.label,
      score: Number(base.toFixed(4)),
      eligible: blocks.length === 0,
      blocked_because: blocks,
      produces_regression_asset: def.produces_regression_asset,
      deterministic: def.deterministic,
      coverage: Number((weightTotal === 0 ? 0 : contributions.length / Object.keys(affinity).length).toFixed(2)),
      contributions: contributions.sort((a, b) => b.weight - a.weight),
    });
  }

  const eligible = candidates.filter((c) => c.eligible).sort((a, b) => b.score - a.score);
  const reason = [];
  let selected = eligible[0] ?? null;
  let escalate = false;

  if (scenario) reason.push(`Scenario: ${scenario}`);

  // Rule 1: cheapest reliable evidence first. If the repo already covers this,
  // run that before inventing anything.
  const existingAutomation = factors.existing_automation;
  const existingCandidate = eligible.find((c) => c.id === 'existing-tests' || c.id === 'existing-other-tooling');
  if (
    existingCandidate &&
    typeof existingAutomation === 'number' &&
    existingAutomation >= M.thresholds.existing_first.min_existing_automation
  ) {
    selected = existingCandidate;
    reason.push(
      `existing_automation=${existingAutomation} >= ${M.thresholds.existing_first.min_existing_automation}: the repository already covers this, so running its own suite is the cheapest reliable evidence.`,
    );
  } else {
    // Rule 2: explore-then-automate when the UI is unknown but the scenario will recur.
    const ht = M.thresholds.hybrid_trigger;
    const hybridCandidate = eligible.find((c) => c.id === 'hybrid');
    if (
      hybridCandidate &&
      (factors.exploratory_value ?? 0) >= ht.min_exploratory_value &&
      (factors.repeatability ?? 0) >= ht.min_repeatability
    ) {
      selected = hybridCandidate;
      reason.push(
        `exploratory_value=${factors.exploratory_value} >= ${ht.min_exploratory_value} and repeatability=${factors.repeatability} >= ${ht.min_repeatability}: the behaviour must be discovered before it can be asserted, and it will be re-run often enough to justify committing a script afterwards.`,
      );
    } else if (selected) {
      reason.push(`Highest-scoring eligible method (${selected.score}) on the configured affinity matrix.`);
    }
  }

  // Rule 3: refuse to commit when the top two are indistinguishable.
  const margin = eligible.length >= 2 ? Number((eligible[0].score - eligible[1].score).toFixed(4)) : 1;
  if (selected && eligible.length >= 2 && selected.id === eligible[0].id && margin < M.thresholds.ambiguity_gate.min_margin) {
    escalate = true;
    reason.push(
      `Margin between "${eligible[0].id}" and "${eligible[1].id}" is ${margin}, below the ambiguity gate of ${M.thresholds.ambiguity_gate.min_margin}. Escalating rather than guessing.`,
    );
  }

  for (const rule of firedRules) {
    reason.push(`Hard rule "${rule.id}" removed [${rule.forbids.join(', ')}]: ${rule.because}`);
  }

  if (!selected) {
    reason.push('No eligible method remains. Every candidate was removed by a hard rule or a missing capability.');
  }

  const supplied = Object.keys(factors).length;
  const confidence = Number(
    Math.min(0.95, Math.max(0.2, (supplied / FACTORS.length) * 0.6 + Math.min(margin, 0.4)))
      .toFixed(2),
  );

  return {
    selected: selected?.id ?? null,
    escalate: escalate || !selected,
    confidence,
    margin,
    reason,
    candidates: candidates.sort((a, b) => b.score - a.score),
    fired_rules: firedRules,
    policy_ref: `browser-decision.matrix@${M.version}`,
  };
}

/**
 * Post-exploration question: is this discovered scenario worth committing as a
 * permanent deterministic test? Separate from `decide` on purpose -- it runs
 * after evidence exists, not before.
 */
export function shouldAutomate({ factors = {} } = {}) {
  const t = M.thresholds.script_conversion;
  const checks = [
    { name: 'repeatability', ok: (factors.repeatability ?? 0) >= t.min_repeatability, need: `>= ${t.min_repeatability}`, got: factors.repeatability },
    { name: 'business_criticality', ok: (factors.business_criticality ?? 0) >= t.min_business_criticality, need: `>= ${t.min_business_criticality}`, got: factors.business_criticality },
    { name: 'environment_stability', ok: (factors.environment_stability ?? 0) >= t.min_environment_stability, need: `>= ${t.min_environment_stability}`, got: factors.environment_stability },
    { name: 'expected_runtime_minutes', ok: (factors.expected_runtime_minutes ?? 0) <= t.max_expected_runtime_minutes, need: `<= ${t.max_expected_runtime_minutes}`, got: factors.expected_runtime_minutes },
  ];
  const failed = checks.filter((c) => !c.ok);
  return {
    automate: failed.length === 0,
    checks,
    reason: failed.length === 0
      ? 'Scenario is repeatable, valuable, stable and fast enough to earn a permanent place in the suite.'
      : `Not converting: ${failed.map((f) => `${f.name}=${f.got} (need ${f.need})`).join('; ')}.`,
    policy_ref: `browser-decision.matrix@${M.version}#script_conversion`,
  };
}

export function matrix() {
  return M;
}
