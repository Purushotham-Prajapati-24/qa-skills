# Workflow: Planning

Goal: a plan that names what will be tested, what will not, and why — before anything runs.

## 1. Understand the change (when there is one)

Change-aware testing beats running everything. Delegate to `change-intelligence`, or:

```bash
git diff --stat <base>...<head>
git diff --name-only <base>...<head>
gh pr view <n> --json title,body,files,additions,deletions   # if gh is authenticated
```

Produce: files changed → modules impacted → user-facing behaviour affected → existing
tests that touch those modules → the gap between the two.

The gap is the plan's raw material.

## 2. Assess risk

Score only the factors you can evidence. The risk engine excludes the rest and lowers
stated confidence rather than guessing:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" risk score --input factors.json --profile security-critical --explain
```

Pick the profile deliberately: `balanced`, `security-critical`, `internal-tooling`,
`prototype`. See [../policies/risk-policy.md](../policies/risk-policy.md).

## 3. Compute applicability

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" applicability eval --input applicability.json
```

Input takes the signals from the profile, the risk assessment, known coverage per
category, resolved capabilities, unmet prerequisites and a time budget. Output contains
**every** category — applicable or not, each with a reason.

Read the `not_applicable` list before accepting it. The engine works from signals; if a
signal is wrong, fix the profile rather than overriding the verdict.

## 4. Choose the browser method (if there is a UI)

Do not reach for the browser MCP by reflex. Run the decision:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" browser decide --input browser-factors.json
```

Full reasoning in the `browser-testing` skill. Record the outcome as a decision.

## 5. Decide depth

| Depth | When | Roughly |
| --- | --- | --- |
| `smoke` | Trivial change, strong existing coverage | Does it still start and serve? |
| `targeted` | Small change, clear blast radius | The changed path plus its immediate neighbours |
| `standard` | Normal feature work | Changed behaviour, its integrations, regression around it |
| `deep` | High risk, weak coverage, security or money involved | Adds negative paths, boundaries, concurrency, authorisation matrix |
| `exhaustive` | Release candidate, migration, rewrite | Everything applicable, including non-functional |

Depth is a decision. Record it with its rationale.

## 6. Write the plan

Use [../../../templates/test-plan.md](../../../templates/test-plan.md). Every scenario
carries an obligation:

- `must-test` — the plan fails without it
- `should-test` — real value, drop only under pressure
- `nice-to-test` — do it if the budget allows
- `not-applicable` — with a reason
- `blocked` — with the uncertainty ID that blocks it
- `deferred` — with what would make it worth doing later

A plan with no `not-applicable` and no `deferred` entries is almost certainly a plan that
did not think about scope.

## 7. Partition around blockers

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" uncertainty partition --input scenarios.json
```

Run everything in `runnable` now. Blocked items get an execution record with status
`BLOCKED` so they appear in the report rather than vanishing.

## 8. Record the plan decisions

At minimum: scope, depth, browser method, and anything you chose not to test that a
reader might expect. Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" session phase plan --note "plan PLAN-00001 written"
```

→ Next: [execution.md](execution.md)
