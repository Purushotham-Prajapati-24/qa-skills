---
name: risk-analysis
description: Score the risk of a change or component from evidence — business criticality, security sensitivity, user impact, data sensitivity, change magnitude and frequency, dependency and integration complexity, historical failures, coverage deficit, flakiness, deployment exposure, irreversibility and external dependencies — and produce an explainable risk level that drives test priority. Use when deciding what to test first, how deep to go, or whether a change is risky enough to justify expensive testing.
when_to_use: "how risky is this change", "what should we test first", "is this worth deep testing", "prioritise the testing"
allowed-tools: Read, Glob, Grep, Bash, PowerShell
metadata:
  system_version: 0.7.0
  role: specialist
---

# Risk Analysis

Risk orders the work. It does not decide applicability — a high-risk backend still does
not need visual regression testing.

```bash
node bin/ast.mjs risk profiles
node bin/ast.mjs risk score --input factors.json --profile security-critical --explain
```

## Pick the profile deliberately

`balanced` · `security-critical` · `internal-tooling` · `prototype`

The profile changes the answer for identical inputs, which is the point. Record the choice
as a decision when it is not obvious.

## Score only what you can evidence

Every factor needs a `basis`. The engine throws without one — deliberately, because an
unexplained number cannot be argued with and therefore cannot be corrected.

```jsonc
{
  "profile": "security-critical",
  "factors": {
    "business_criticality": { "value": 1.0, "basis": "checkout is the only revenue path", "epistemic_class": "observed" },
    "security_sensitivity": { "value": 0.9, "basis": "diff modifies auth/session.ts middleware", "epistemic_class": "observed" },
    "change_magnitude":     { "value": 0.6, "basis": "312 changed lines across 7 files in a ~2k-line module", "epistemic_class": "observed" },
    "coverage_deficit":     { "value": 0.8, "basis": "no test exercises the saved-card branch (grep across test/ found none)", "epistemic_class": "observed" },
    "irreversibility":      { "value": 0.9, "basis": "captures a real payment; refunds are manual", "epistemic_class": "inferred" }
  }
}
```

**Unevidenced factors are excluded, not guessed.** Guessing 0.5 manufactures a score.
Excluding lowers stated confidence — which is the honest signal.

## Where each value comes from

| Factor | Evidence |
| --- | --- |
| business_criticality | Profile's `critical_components`; what the product is for |
| security_sensitivity | Does the diff touch authn, authz, secrets, crypto or sessions? |
| user_impact | How many users, how visibly, how recoverable |
| data_sensitivity | Personal, financial or regulated data in scope |
| change_magnitude | `git diff --stat` relative to module size |
| change_frequency | `git log --format=%H -- <path> \| wc -l` over a window |
| dependency_complexity | Count of modules importing the changed one |
| integration_complexity | External systems in the behaviour's path |
| historical_failures | Past issues/incidents touching these paths |
| coverage_deficit | Which tests execute the changed lines — check, do not assume |
| test_flakiness | `ast flaky analyse` on recorded history |
| deployment_exposure | Continuous deploy, or gated behind review and a flag? |
| irreversibility | Moves money, sends messages, alters schema? |
| external_system_dependency | Third parties you cannot control in test |

## Read the confidence value

Confidence is the share of profile weight you could evidence.

> `risk_score: 0.91, risk_level: critical, confidence: 0.30`

means *"given the third of the picture I can see, this looks critical"* — not "risk is
critical". Report it that way.

When confidence is below about 0.4, gathering two more factors is usually a better next
action than starting to test.

## Output

```
risk_score: 0.8683
risk_level: critical
profile: security-critical
confidence: 0.4632
factors (by contribution):
  - security_sensitivity: 0.9 × 2    => 1.80  [observed] auth middleware modified in diff
  - irreversibility:      0.9 × 1.5  => 1.35  [inferred] captures a real payment
  - business_criticality: 1.0 × 1    => 1.00  [observed] only revenue path
  ...
unscored (excluded from the score): user_impact, data_sensitivity, change_frequency, ...
```

Paste this into the plan and the report. The number and the story must never drift apart.

## Turning risk into priority

- `critical` → `deep` or `exhaustive`; every applicable P0 category runs; blocked P0 items
  escalate rather than being deferred.
- `high` → `standard` or `deep`; P0 and P1.
- `medium` → `standard`; P0 and P1 as budget allows.
- `low` / `negligible` → `smoke` or `targeted`; regression only.

Then let applicability and budget do the rest:

```bash
node bin/ast.mjs applicability eval --input applicability.json
```

## Tuning

Weights, thresholds and factor definitions live in `engine/risk-engine/weights.json`. Add
a profile rather than arguing with a score. After editing, re-run `ast eval run` — the
benchmark exists to catch an edit that silently changed behaviour elsewhere.
