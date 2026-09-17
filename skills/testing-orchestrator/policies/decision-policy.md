# Decision Policy

How the agent chooses, and what it must record when it does.

## What counts as a decision

Anything a reviewer could reasonably disagree with:

- what to test, and what not to
- how deep to go
- which tool or method
- exploratory versus deterministic
- reuse an existing test versus write a new one
- whether a finding becomes an external issue
- whether to consult a ticket system
- whether to stop and ask
- what to do after a failure

Not a decision: mechanical steps with one sensible option. Those are assumptions — record
them in the plan's `assumptions` array instead.

## The record

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" decide --input decision.json
```

The CLI refuses anything missing:

- **≥2 candidate options.** If you cannot name the alternative, you defaulted rather than
  decided. Write down the option you rejected and why.
- **≥1 itemised reason.** One entry per independent reason. Not a paragraph.
- **A confidence in [0,1].** State genuine uncertainty. Rounding 0.6 up to 1 is how a
  wrong choice becomes unchallengeable.
- **A reversibility flag.** Irreversible decisions require authorisation; reversible ones
  can be tried and undone.

Add `policy_refs` pointing at the matrix row that drove it
(e.g. `browser-decision.matrix@1.0.0#hybrid_trigger`), so a policy edit can be traced to
the behaviour it changed.

## Ranking principle

> **The cheapest reliable evidence that addresses the highest risk.**

In order:

1. **Does something already answer this?** An existing suite, a CI run, a coverage report.
   Running it beats writing anything.
2. **What is the risk?** Weight by the risk engine's scored factors, not by what is
   interesting to test.
3. **What does it cost?** Wall clock, environment setup, maintenance burden, and the
   ongoing cost of one more test file.
4. **Will the evidence settle the question?** A test that cannot fail informatively is
   not worth running.

More testing is not better testing. The `unnecessary_test_rate` metric exists to catch a
report padded with executions that changed no decision and found nothing.

## Reuse versus write new

| Condition | Choice |
| --- | --- |
| An existing test covers the changed behaviour and runs | Run it |
| An existing test is close but asserts the wrong thing | Extend it — do not fork a near-duplicate |
| The behaviour is new and will recur | Write a new test |
| The behaviour is new and one-off | Verify manually; record why it was not automated |
| The existing test is flaky | Fix the flakiness first; a flaky gate is worse than no gate |

## Depth

Set by risk × coverage deficit, capped by budget. `smoke` → `targeted` → `standard` →
`deep` → `exhaustive`. Choosing `deep` on a typo fix wastes the user's time; choosing
`smoke` on a payments change is negligence. Record which and why.

## Escalating instead of guessing

The browser decision engine refuses to commit when the top two methods are within 0.05 of
each other, and returns `escalate: true`. Apply the same instinct everywhere: when two
options are genuinely balanced and the choice matters, ask. When they are balanced and it
does not matter, pick one and say you did.

## Assessing decisions afterwards

Once the consequence is observable:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" decision assess DEC-00042 --verdict suboptimal --note "MCP exploration found the flow in 3 minutes, but the script was rewritten twice because the selectors changed"
```

Verdicts: `correct`, `acceptable`, `suboptimal`, `wrong`, `unknown`. This feeds
`decision_accuracy`, which is meaningless without it — hence the companion metric
`decision_assessment_rate`. Self-assessment is weak evidence; a human verdict is strong.

## Changing your mind

Do not edit a decision. Record a new one and supersede the old:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" decide --input new-decision.json
```

The history of what you believed and when is part of the audit trail.
