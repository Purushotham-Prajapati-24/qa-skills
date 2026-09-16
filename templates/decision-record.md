# Decision Record — {{DECISION_ID}}

Canonical form is JSON (`schemas/decision.schema.json`, stored in `state/decisions/`).
Created with `node bin/ast.mjs decide --input decision.json`.

```jsonc
{
  "decision_id": "DEC-00042",
  "timestamp": "2026-09-16T13:58:02Z",
  "session_id": "SESSION-0031",
  "category": "browser-method",
  "question": "How should the changed checkout UI be tested?",
  "context": {
    "summary": "Checkout gained saved-card support. Playwright exists with partial coverage; the new flow has not been examined.",
    "git": { "repository": "shop", "branch": "feat/checkout", "commit": "abc1234" }
  },
  "candidate_options": [
    { "id": "playwright-mcp", "label": "Agent-driven exploratory session",
      "pros": ["fast discovery of an unknown UI"],
      "cons": ["not reproducible", "leaves no regression asset"],
      "score": 0.53,
      "rejected_because": "Would leave nothing behind for a flow that runs every release." },
    { "id": "playwright-script", "label": "Write a deterministic spec directly",
      "cons": ["selectors would be guesses"],
      "score": 0.59,
      "rejected_because": "Hard rule no-script-for-unknown-ui: ui_known 0.2 <= 0.25." },
    { "id": "existing-tests", "label": "Run the existing Playwright suite",
      "score": 0.51,
      "rejected_because": "existing_automation 0.35 -- it does not reach the saved-card branch." },
    { "id": "hybrid", "label": "Explore first, then commit a script for the stable path",
      "pros": ["discovers behaviour AND leaves a regression asset"],
      "score": 0.74 }
  ],
  "selected_option": "hybrid",
  "reason": [
    "ui_known 0.2: the saved-card flow has not been examined, so any selector written now would be a guess",
    "repeatability 0.85: checkout is exercised every release, so a committed spec pays for itself",
    "business_criticality 0.95: the only revenue path",
    "existing Playwright coverage stops before the changed branch"
  ],
  "evidence_refs": ["EV-2026-00014"],
  "confidence": 0.87,
  "risk": { "level": "critical", "score": 0.87, "note": "payment path with no coverage of the new branch" },
  "reversible": true,
  "downstream_effect": [
    "An exploratory execution runs first",
    "A committed spec is added to e2e/ if the scenario meets the conversion threshold"
  ],
  "policy_refs": ["browser-decision.matrix@1.0.0#hybrid_trigger"],
  "provenance": { "skill_version": "0.5.0", "skill_name": "browser-testing", "created_at": "…", "created_by": "agent" }
}
```

## What the CLI enforces, and why

| Requirement | Why |
| --- | --- |
| ≥ 2 candidate options | If you cannot name the alternative you rejected, you defaulted rather than decided. |
| ≥ 1 itemised reason | One entry per independent reason. A prose paragraph hides the weak link. |
| `confidence` in [0,1] | Rounding 0.6 up to 1 makes a wrong choice unchallengeable later. |
| `reversible` boolean | Drives whether authorisation is needed and whether it can be tried and undone. |

`rejected_because` on the losing options is optional in the schema and worth writing every
time. Six months later it is the only thing that stops someone re-litigating a settled
question.

## Assessing it afterwards

```bash
node bin/ast.mjs decision assess DEC-00042 --verdict correct --note "exploration found the saved-card branch in 4 minutes; the committed spec has run 11 times since without maintenance"
```

Verdicts: `correct` · `acceptable` · `suboptimal` · `wrong` · `unknown`.

This is what makes `decision_accuracy` mean anything — and why it is paired with
`decision_assessment_rate`. A 100% accuracy over 2 assessed decisions out of 40 is noise.

## Changing your mind

Do not edit a decision. Record a new one and supersede the old:

```bash
node bin/ast.mjs decide --input new-decision.json
```

What you believed, and when, is part of the audit trail.
