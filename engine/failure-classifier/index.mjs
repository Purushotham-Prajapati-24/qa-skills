/**
 * Failure Classifier.
 *
 * A red result is not a defect report. It is an observation that needs a cause.
 * This module maps observed signals to a class with a confidence, and it
 * refuses to reach a confident conclusion from thin evidence -- the default
 * outcome is "unclassified", which downstream forces more investigation rather
 * than a defect filing.
 *
 * Signals are short tokens the caller extracted from real output, e.g.
 * 'econnrefused', 'assertion-mismatch', 'timeout', 'passed-on-retry'.
 */

const RULES = [
  {
    class: 'infrastructure-failure',
    any: ['econnrefused', 'enotfound', 'ehostunreach', 'docker-not-running', 'port-in-use', 'out-of-memory', 'disk-full'],
    weight: 0.85,
    note: 'The system under test could not be reached or the runner could not start.',
  },
  {
    class: 'environment-defect',
    any: ['missing-env-var', 'missing-binary', 'wrong-node-version', 'browser-not-installed', 'missing-migration', 'config-file-absent'],
    weight: 0.8,
    note: 'The environment does not satisfy the test\'s stated prerequisites.',
  },
  {
    class: 'dependency-failure',
    any: ['upstream-5xx', 'third-party-timeout', 'rate-limited', 'api-key-rejected-upstream'],
    weight: 0.75,
    note: 'An external system the test depends on failed.',
  },
  {
    class: 'authentication-failure',
    any: ['http-401', 'http-403', 'invalid-credentials', 'token-expired', 'login-redirect'],
    weight: 0.6,
    note: 'Could be a product authz defect OR missing test credentials. These have opposite conclusions -- do not guess.',
    requiresDisambiguation: true,
  },
  {
    class: 'flaky-test',
    any: ['passed-on-retry', 'intermittent', 'race-condition-suspected', 'timing-variance-high'],
    weight: 0.55,
    note: 'Never conclude flakiness from a single failure. Requires a repeated-run history.',
    requiresHistory: true,
  },
  {
    class: 'timeout',
    any: ['timeout', 'deadline-exceeded', 'element-not-found-after-wait'],
    weight: 0.6,
    note: 'Separate a slow environment from a product regression by timing a known-good path in the same run.',
  },
  {
    class: 'performance-degradation',
    any: ['latency-above-baseline', 'throughput-below-baseline', 'memory-growth'],
    weight: 0.6,
    note: 'Needs a baseline measured in the same session to mean anything.',
  },
  {
    class: 'data-failure',
    any: ['fixture-missing', 'seed-mismatch', 'unique-constraint', 'stale-test-data', 'foreign-key-violation'],
    weight: 0.7,
    note: 'Test data did not match what the test assumed.',
  },
  {
    class: 'configuration-failure',
    any: ['feature-flag-off', 'wrong-base-url', 'cors-blocked', 'wrong-locale'],
    weight: 0.7,
    note: 'Fix the configuration, never the assertion.',
  },
  {
    class: 'test-defect',
    any: ['brittle-selector', 'hardcoded-date', 'test-order-dependency', 'assertion-typo', 'obsolete-expectation'],
    weight: 0.75,
    note: 'The test is wrong. Fix it and re-run; this is not a product signal.',
  },
  {
    class: 'expected-behaviour-mismatch',
    any: ['spec-disagrees-with-test', 'acceptance-criteria-conflict'],
    weight: 0.65,
    note: 'The test and the requirement disagree. Resolve the requirement before touching either.',
  },
  {
    class: 'ambiguous-requirement',
    any: ['requirement-unclear', 'no-acceptance-criteria', 'contradictory-spec'],
    weight: 0.7,
    note: 'Raise an uncertainty; do not invent the expected behaviour.',
  },
  {
    class: 'product-defect',
    // The last four (advisory-in-range, missing-auth-check, hardcoded-secret,
    // policy-violation) are static-analysis-shaped: a dependency scan or a manual security
    // review (skills/security-testing) has no RUNTIME signal to supply -- econnrefused,
    // http-500 and the rest all describe something that happened while a program ran --
    // so without these, a static finding was always routed to the no-signal fallback by
    // construction, which read as "the evidence is insufficient" for exactly the findings
    // most likely to be the report's most important ones.
    any: [
      'assertion-mismatch', 'http-500', 'unhandled-exception', 'console-error', 'wrong-value-rendered', 'data-not-persisted', 'broken-redirect',
      'advisory-in-range', 'missing-auth-check', 'hardcoded-secret', 'policy-violation',
    ],
    weight: 0.7,
    note: 'Consistent with a real defect -- but only once environment, data and test-quality causes have been excluded.',
    requiresExclusion: ['infrastructure-failure', 'environment-defect', 'data-failure', 'configuration-failure', 'test-defect'],
  },
];

export const CLASSES = [...new Set(RULES.map((r) => r.class))].concat(['unclassified-no-signals', 'unclassified']);

/**
 * @param {object} input
 * @param {string[]} input.signals
 * @param {string[]} [input.evidenceIds]
 * @param {Array<{status:string}>} [input.history]  Prior runs of the same test.
 */
export function classify({ signals = [], evidenceIds = [], history = [], status = 'FAILED' } = {}) {
  const normalised = signals.map((s) => String(s).toLowerCase().trim());

  if (normalised.length === 0) {
    // Renamed from 'insufficient-evidence' at confidence 0.9: that name and confidence
    // described "the caller gave me nothing to work with" but read, to anyone skimming a
    // report, as a verdict on the FINDING's evidence -- exactly backwards for a static
    // review or a dependency scan, which has no runtime signal to supply and was routed
    // here by construction regardless of how solid the underlying finding was. 0.9 was
    // also the single highest confidence this function could ever return, on its weakest
    // possible input. Confidence now reads as absence, consistent with this file's other
    // low-certainty cases (requiresHistory/requiresDisambiguation/requiresExclusion below
    // all cap out well under this).
    return {
      class: 'unclassified-no-signals',
      confidence: 0.2,
      signals: [],
      evidence_refs: evidenceIds,
    };
  }

  const matches = RULES
    .map((rule) => {
      const hits = rule.any.filter((s) => normalised.includes(s));
      return hits.length ? { rule, hits } : null;
    })
    .filter(Boolean);

  if (matches.length === 0) {
    return {
      class: 'unclassified',
      confidence: 0.4,
      signals: normalised,
      evidence_refs: evidenceIds,
    };
  }

  // Non-product causes win ties: attributing an environment failure to the
  // product produces a false defect report, which is the expensive error.
  // "Ties" means scores within TIE_MARGIN of each other -- it must not fire
  // whenever *any* non-product rule matched, or one incidental "timeout"
  // signal would displace three strong product-defect signals every time.
  const TIE_MARGIN = 0.1;
  matches.forEach((m) => { m.score = m.hits.length * m.rule.weight; });
  matches.sort((a, b) => {
    const diff = b.score - a.score;
    if (Math.abs(diff) > TIE_MARGIN) return diff;
    const aProduct = a.rule.class === 'product-defect' ? 1 : 0;
    const bProduct = b.rule.class === 'product-defect' ? 1 : 0;
    if (aProduct !== bProduct) return aProduct - bProduct;
    return diff;
  });

  const top = matches[0];
  let confidence = Math.min(0.95, top.rule.weight * (0.7 + 0.15 * top.hits.length));

  // Guardrails that lower confidence rather than changing the label.
  const caveats = [];
  if (top.rule.requiresHistory && history.length < 3) {
    confidence = Math.min(confidence, 0.35);
    caveats.push(`Flakiness needs at least 3 runs to assert; only ${history.length} recorded.`);
  }
  if (top.rule.requiresDisambiguation) {
    confidence = Math.min(confidence, 0.5);
    caveats.push('Ambiguous between a product authorisation defect and missing test credentials.');
  }
  if (top.rule.requiresExclusion) {
    const competing = matches.slice(1).filter((m) => top.rule.requiresExclusion.includes(m.rule.class));
    if (competing.length) {
      confidence = Math.min(confidence, 0.45);
      caveats.push(`Competing non-product explanations present: ${competing.map((c) => c.rule.class).join(', ')}. Exclude them before filing a defect.`);
    }
  }
  if (evidenceIds.length === 0) {
    confidence = Math.min(confidence, 0.5);
    caveats.push('No evidence attached; classification rests on signal tokens alone.');
  }

  return {
    class: top.rule.class,
    confidence: Number(confidence.toFixed(2)),
    signals: [...top.hits, ...caveats.map((c) => `caveat: ${c}`)],
    evidence_refs: evidenceIds,
  };
}

export function rules() {
  return RULES;
}
