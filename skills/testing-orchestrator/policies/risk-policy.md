# Risk Policy

Risk decides what gets tested first and how deeply. A risk number nobody can argue with
is a risk number nobody can correct.

## Rules

1. **Weights are configuration.** `engine/risk-engine/weights.json`. A fintech backend and
   a marketing site must not share a weighting.
2. **Every scored factor needs a stated basis.** The engine throws on a value without one.
3. **An unevidenced factor is excluded, not guessed.** Guessing 0.5 manufactures a score.
   Excluding it lowers the assessment's stated confidence, which is the honest signal.
4. **The score is explainable.** Every contribution is itemised and printed in the report.

## Profiles

| Profile | For | Emphasises |
| --- | --- | --- |
| `balanced` | General web applications | Even spread; coverage deficit and criticality lead |
| `security-critical` | Auth, payments, regulated data | Security 2×, data sensitivity 1.8×, irreversibility 1.5× |
| `internal-tooling` | Low blast radius, technical users, easy rollback | Change magnitude over user impact |
| `prototype` | Early-stage, shipping beats certainty | Low across the board — except security and data, because a prototype leak is still a leak |

Choosing a profile is itself a decision. Record it.

## Factors

`business_criticality`, `security_sensitivity`, `user_impact`, `data_sensitivity`,
`change_magnitude`, `change_frequency`, `dependency_complexity`,
`integration_complexity`, `historical_failures`, `coverage_deficit`, `test_flakiness`,
`deployment_exposure`, `irreversibility`, `external_system_dependency`.

`coverage_deficit` is a **deficit**: 1.0 means nothing covers it.

## Scoring a factor honestly

Derive values from evidence, not vibes:

| Factor | Derive from |
| --- | --- |
| change_magnitude | `git diff --stat` relative to module size |
| change_frequency | `git log --format=%H -- <path> \| wc -l` over a window |
| historical_failures | Past issues/incidents touching these paths |
| coverage_deficit | Which existing tests execute the changed lines — check, do not assume |
| dependency_complexity | Count of modules importing the changed one |
| irreversibility | Does the behaviour move money, send messages, or alter schema? |
| deployment_exposure | Is deploy continuous, or gated behind review and a flag? |

Mark each with its `epistemic_class`. `observed` means you read it. `inferred` means you
reasoned to it. Do not label an inference as an observation.

## Levels

`negligible` <0.2 · `low` 0.2 · `medium` 0.4 · `high` 0.65 · `critical` 0.85

Thresholds live in `weights.json` and are tunable.

## Reading the confidence value

Confidence is the share of the profile's total weight you could evidence. A score of 0.91
at confidence 0.30 means: *given the third of the picture I can see, this looks critical.*
That is useful and must be reported as such — not flattened to "risk is critical".

When confidence is below ~0.4, gathering one or two more factors is usually a better next
action than starting to test.

## What risk does not decide

Risk sets **priority**. It does not set **applicability** — a high-risk repository with no
UI still does not need visual regression testing. Applicability comes from signals; risk
orders what remains.
