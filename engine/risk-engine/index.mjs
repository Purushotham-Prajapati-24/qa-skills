/**
 * Risk Engine.
 *
 * Turns evidenced factor values into an explainable score. Three properties
 * matter more than the arithmetic:
 *
 *  1. Weights are configuration, not code (weights.json, selectable profile).
 *  2. A factor with no evidence is EXCLUDED, not guessed at 0.5. Guessing
 *     manufactures a score; excluding it lowers stated confidence instead.
 *  3. Every contribution is itemised so a human can argue with it.
 */
import path from 'node:path';
import { readJson } from '../core/fsjson.mjs';
import { PACKAGE_ROOT } from '../core/paths.mjs';

const CONFIG = readJson(path.join(PACKAGE_ROOT, 'engine', 'risk-engine', 'weights.json'));

export function profiles() {
  return Object.keys(CONFIG.profiles);
}

export function factorCatalog() {
  return CONFIG.factors;
}

function levelFor(score) {
  const entries = Object.entries(CONFIG.levels).sort((a, b) => b[1] - a[1]);
  for (const [level, threshold] of entries) if (score >= threshold) return level;
  return 'negligible';
}

function bandFor(confidence) {
  const entries = Object.entries(CONFIG.confidence_bands)
    .filter(([k]) => !k.startsWith('$'))
    .sort((a, b) => b[1] - a[1]);
  for (const [band, threshold] of entries) if (confidence >= threshold) return band;
  return 'low';
}

/**
 * @param {object} input
 * @param {string} [input.profile='balanced']
 * @param {Record<string, {value:number, basis:string, epistemic_class?:string, evidence?:string[]}>} input.factors
 * @returns risk assessment matching testing-plan.schema.json#/definitions/riskAssessment
 */
export function score({ profile = 'balanced', factors = {}, overrides = {} } = {}) {
  const prof = CONFIG.profiles[profile];
  if (!prof) {
    throw new Error(`Unknown risk profile "${profile}". Available: ${profiles().join(', ')}`);
  }
  const weights = { ...prof.weights, ...overrides };

  const scored = [];
  const unscored = [];

  for (const name of Object.keys(CONFIG.factors)) {
    const supplied = factors[name];
    const weight = weights[name];
    if (weight === undefined) continue;
    if (!supplied || typeof supplied.value !== 'number') {
      unscored.push(name);
      continue;
    }
    if (supplied.value < 0 || supplied.value > 1) {
      throw new Error(`Risk factor "${name}" must be in [0,1], got ${supplied.value}`);
    }
    if (!supplied.basis) {
      throw new Error(`Risk factor "${name}" has a value but no basis. An unexplained number is not a risk assessment.`);
    }
    scored.push({
      factor: name,
      value: supplied.value,
      weight,
      contribution: Number((supplied.value * weight).toFixed(6)),
      basis: supplied.basis,
      epistemic_class: supplied.epistemic_class ?? 'inferred',
      ...(supplied.evidence?.length ? { evidence: supplied.evidence } : {}),
    });
  }

  const unknown = Object.keys(factors).filter((f) => !CONFIG.factors[f]);
  if (unknown.length) {
    // Never tell the caller to edit weights.json: an unrecognised name here is a caller
    // typo or shape error, not a missing entry in the risk model's configuration. The
    // most common real cause: factor names were passed at the top level instead of nested
    // under "factors", so each one collected a camelCase alias (see aliasKeys in
    // bin/ast.mjs) that this engine then correctly does not recognise.
    throw new Error(
      `Unknown risk factor(s): ${unknown.join(', ')}. `
      + 'Factors must be nested under "factors" as {value, basis} objects: '
      + '{ "factors": { "security_sensitivity": { "value": 0.9, "basis": "..." } } }. '
      + 'If you passed them at the top level, that is almost certainly the cause of these exact '
      + 'names. Known factors: `ast risk profiles`. Worked example: skills/risk-analysis/SKILL.md.',
    );
  }

  const weightSum = scored.reduce((a, f) => a + f.weight, 0);
  const rawScore = weightSum === 0 ? 0 : scored.reduce((a, f) => a + f.contribution, 0) / weightSum;
  const riskScore = Number(rawScore.toFixed(4));

  // Confidence is the share of the profile's total weight we could actually
  // evidence. Scoring 3 of 14 factors is a weak assessment and must say so.
  const totalWeight = Object.values(weights).reduce((a, w) => a + w, 0);
  const confidence = totalWeight === 0 ? 0 : Number((weightSum / totalWeight).toFixed(4));

  // A level without its band is a false precision: `critical` off one evidenced factor
  // renders identically to `critical` off thirteen. Carry the band next to the level so a
  // reader cannot see one without the other -- in both directions, because a thinly
  // evidenced `negligible` is what silently excludes whole test categories.
  const level = levelFor(riskScore);
  const band = bandFor(confidence);
  const thin = band !== 'high';

  return {
    risk_score: riskScore,
    risk_level: level,
    risk_level_qualified: thin ? `${level} (${band} confidence)` : level,
    weights_profile: profile,
    confidence,
    confidence_band: band,
    ...(thin
      ? {
          confidence_warning: `Only ${scored.length} of ${scored.length + unscored.length} weighted factors could be evidenced (${Math.round(confidence * 100)}% of profile weight). Quote this level as "${level} (${band} confidence)" and do not use it on its own to exclude a test category.`,
        }
      : {}),
    factors: scored.sort((a, b) => b.contribution - a.contribution),
    unscored_factors: unscored,
  };
}

/**
 * Human-readable explanation. Used verbatim in reports so the number and the
 * story can never drift apart.
 */
export function explain(assessment) {
  const lines = [
    `risk_score: ${assessment.risk_score}`,
    `risk_level: ${assessment.risk_level_qualified ?? assessment.risk_level}`,
    `profile: ${assessment.weights_profile}`,
    `confidence: ${assessment.confidence} (${assessment.confidence_band ?? 'unbanded'} — share of profile weight backed by evidence)`,
    ...(assessment.confidence_warning ? [`WARNING: ${assessment.confidence_warning}`] : []),
    'factors (by contribution):',
  ];
  for (const f of assessment.factors) {
    lines.push(`  - ${f.factor}: value=${f.value} x weight=${f.weight} => ${f.contribution}  [${f.epistemic_class}] ${f.basis}`);
  }
  if (assessment.unscored_factors.length) {
    lines.push(`unscored (no evidence, excluded from the score): ${assessment.unscored_factors.join(', ')}`);
  }
  return lines.join('\n');
}
