/**
 * Test Applicability Engine.
 *
 * Answers "which of the 47 test categories are actually relevant here?" and,
 * just as importantly, records why each of the others is not. A category the
 * engine never considered is indistinguishable from one it silently dropped,
 * so the output always contains every category.
 *
 * The scoring is deliberately simple and legible:
 *
 *   value      = risk_alignment * coverage_deficit
 *   score      = value / normalised_cost, gated by tool availability
 *
 * The point is not numerical sophistication. The point is that a human can
 * read the row and say "no, coverage there is better than you think" and fix
 * exactly one input.
 */
import path from 'node:path';
import { readJson } from '../core/fsjson.mjs';
import { PACKAGE_ROOT } from '../core/paths.mjs';

const CATALOG = readJson(path.join(PACKAGE_ROOT, 'engine', 'applicability-engine', 'catalog.json'));

export const CATEGORIES = Object.keys(CATALOG.categories);
export const SIGNALS = Object.keys(CATALOG.signals);

const COVERAGE_DEFICIT = { none: 1.0, minimal: 0.8, partial: 0.5, substantial: 0.2, unknown: 0.7 };

function requirementMet(def, signals) {
  const req = def.requires ?? ['any'];
  if (req.includes('any')) return { met: true, matched: ['any repository'] };
  const matched = req.filter((r) => signals.includes(r));
  const mode = def.match ?? 'any';
  const met = mode === 'all' ? matched.length === req.length : matched.length > 0;
  return { met, matched, missing: req.filter((r) => !signals.includes(r)) };
}

function priorityFor(score, risk) {
  if (score >= 0.6 || (risk >= 0.85 && score >= 0.35)) return 'P0';
  if (score >= 0.35) return 'P1';
  if (score >= 0.15) return 'P2';
  return 'P3';
}

/**
 * @param {object} input
 * @param {string[]} input.signals            Signals asserted by repository-intelligence.
 * @param {object}   [input.riskAssessment]   Output of the risk engine (optional but recommended).
 * @param {Record<string,string>} [input.coverage]   category -> none|minimal|partial|substantial|unknown
 * @param {Record<string,boolean>} [input.capabilities]  capability verb -> available
 * @param {string[]} [input.unmetPrerequisites]  Free-text prerequisites known to be unsatisfiable.
 * @param {Record<string,string>} [input.forceNotApplicable]  category -> reason (human override)
 */
export function evaluate({
  signals = [],
  riskAssessment = null,
  coverage = {},
  capabilities = {},
  unmetPrerequisites = [],
  forceNotApplicable = {},
  budgetMinutes = null,
} = {}) {
  const unknownSignals = signals.filter((s) => !CATALOG.signals[s]);
  if (unknownSignals.length) {
    throw new Error(`Unknown repository signal(s): ${unknownSignals.join(', ')}. Declare them in applicability-engine/catalog.json.`);
  }

  const riskScore = riskAssessment?.risk_score ?? 0.5;
  const riskFactorWeight = new Map(
    (riskAssessment?.factors ?? []).map((f) => [f.factor, f.contribution]),
  );
  const maxContribution = Math.max(0.0001, ...[...riskFactorWeight.values()], 0.0001);

  const rows = [];

  for (const [category, def] of Object.entries(CATALOG.categories)) {
    const { met, matched, missing } = requirementMet(def, signals);

    const deficitKey = coverage[category] ?? 'unknown';
    const deficit = COVERAGE_DEFICIT[deficitKey] ?? 0.7;

    // How well this category attacks the risks we actually scored.
    const addressed = def.addresses ?? [];
    const alignment = addressed.length === 0
      ? riskScore
      : addressed.reduce((a, f) => a + (riskFactorWeight.get(f) ?? 0), 0) / (addressed.length * maxContribution);
    const riskAlignment = Math.min(1, Math.max(0.05, alignment));

    const capability = def.capability ?? null;
    // Three states: true, false, and undeclared. Only an explicit `true` counts as
    // available -- an undeclared capability is exactly as unusable as a declared-false
    // one, per ARCHITECTURE §3, so this must not be a loose `!== false` check.
    const toolAvailable = capability ? capabilities[capability] === true : true;

    const cost = def.cost ?? 30;
    const normalisedCost = Math.min(1, cost / 120); // 2 hours == full cost
    const expectedValue = Number((riskAlignment * deficit).toFixed(4));
    const rawScore = expectedValue / (0.25 + normalisedCost);
    let score = Number(Math.min(1, rawScore / 2.5).toFixed(4));

    const blockingPrereqs = (def.prerequisites ?? []).filter((p) =>
      unmetPrerequisites.some((u) => p.toLowerCase().includes(u.toLowerCase()) || u.toLowerCase().includes(p.toLowerCase())),
    );

    let applicable = met;
    let reason;

    if (forceNotApplicable[category]) {
      applicable = false;
      reason = `Excluded by explicit override: ${forceNotApplicable[category]}`;
      score = 0;
    } else if (!met) {
      reason = `Repository shows no signal for this category (needs ${def.match === 'all' ? 'all of' : 'any of'}: ${(def.requires ?? []).join(', ')}; missing: ${(missing ?? []).join(', ') || 'n/a'}).`;
      score = 0;
    } else if (!toolAvailable) {
      applicable = true;
      reason = `Relevant (signals: ${matched.join(', ')}) but the required capability "${capability}" is unavailable. Treat as BLOCKED, not as done.`;
      score = Number((score * 0.4).toFixed(4));
    } else if (blockingPrereqs.length) {
      applicable = true;
      reason = `Relevant (signals: ${matched.join(', ')}) but prerequisite(s) unmet: ${blockingPrereqs.join('; ')}.`;
      score = Number((score * 0.5).toFixed(4));
    } else {
      reason = `Signals present: ${matched.join(', ')}. Existing coverage "${deficitKey}" leaves a deficit of ${deficit}; addresses risk factor(s): ${addressed.join(', ') || 'general'}.`;
    }

    rows.push({
      category,
      applicable,
      reason,
      priority: applicable ? priorityFor(score, riskScore) : 'P3',
      expected_value: expectedValue,
      risk_addressed: addressed,
      estimated_cost_minutes: cost,
      existing_coverage: deficitKey,
      tool_available: toolAvailable,
      prerequisites: def.prerequisites ?? [],
      automation_suitability: def.automation ?? 'medium',
      recommended_method: def.skill ? `delegate to skill: ${def.skill}` : 'orchestrator-direct',
      score,
    });
  }

  rows.sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));
  rows.forEach((r, i) => {
    r.execution_priority = r.applicable && r.score > 0 ? i + 1 : 0;
  });

  // Budget selection walks priority tiers, not raw score. A budget must never
  // silently drop a P0 category in favour of several cheap P2 wins -- that
  // produces a full-looking report that skipped the thing that mattered.
  const TIERS = ['P0', 'P1', 'P2', 'P3'];
  const selected = [];
  const deferred = [];
  let spent = 0;
  for (const tier of TIERS) {
    for (const row of rows) {
      if (!row.applicable || row.score <= 0 || row.priority !== tier) continue;
      if (budgetMinutes !== null && spent + row.estimated_cost_minutes > budgetMinutes) {
        row.reason += ` Deferred: would exceed the ${budgetMinutes}-minute budget (already committed ${spent} minutes on higher- or equal-priority work).`;
        deferred.push(row.category);
        continue;
      }
      spent += row.estimated_cost_minutes;
      selected.push(row.category);
    }
  }

  return {
    matrix: rows,
    applicable: rows.filter((r) => r.applicable).map((r) => r.category),
    not_applicable: rows.filter((r) => !r.applicable).map((r) => ({ category: r.category, reason: r.reason })),
    selected,
    deferred_for_budget: deferred,
    estimated_minutes: spent,
    budget_minutes: budgetMinutes,
  };
}

/** Derive signals from a repository profile. Pure, so it is unit-testable. */
export function signalsFromProfile(profile) {
  const out = new Set();
  const tech = (profile.technologies ?? []).map((t) => `${t.kind}:${t.name}`.toLowerCase());
  const has = (needle) => tech.some((t) => t.includes(needle));

  if (profile.architecture?.frontend?.present) { out.add('ui'); out.add('web-ui'); }
  if ((profile.apis ?? []).some((a) => a.kind === 'rest')) out.add('http-api');
  if ((profile.apis ?? []).some((a) => a.kind === 'graphql')) out.add('graphql');
  if ((profile.apis ?? []).some((a) => a.kind === 'grpc')) out.add('grpc');
  if ((profile.apis ?? []).some((a) => a.auth_required)) out.add('auth');
  if (has('database')) out.add('database');
  if (has('cache')) out.add('cache');
  if (has('queue')) out.add('queue');
  if (has('auth')) { out.add('auth'); out.add('sessions'); }
  if (has('ci')) out.add('ci');
  if (has('container')) out.add('container');
  if (has('observability')) out.add('observability');
  if (has('llm')) out.add('llm');
  if (has('package-manager')) out.add('third-party-deps');
  if ((profile.testing_frameworks ?? []).length) out.add('existing-tests');
  if ((profile.testing_frameworks ?? []).some((f) => /playwright|cypress|selenium|puppeteer|webdriver/i.test(f.name))) {
    out.add('browser-tooling');
  }
  if (has('framework:react') || has('framework:vue') || has('framework:svelte') || has('framework:angular')) {
    out.add('component-framework');
  }
  for (const c of profile.critical_components ?? []) {
    if (['personal', 'financial', 'regulated'].includes(c.data_sensitivity)) out.add('pii');
    if (/pay|checkout|billing|invoice|subscription/i.test(c.name)) out.add('payments');
  }
  for (const d of profile.external_dependencies ?? []) {
    out.add('external-integration');
    if (d.kind === 'payment') out.add('payments');
    if (d.kind === 'llm') out.add('llm');
  }
  return [...out].sort();
}

export function catalog() {
  return CATALOG;
}
