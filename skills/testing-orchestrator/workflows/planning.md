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

Include `"environment"` (or a `"target"` URL declared in the profile). Undeclared is treated
as production, which removes the exploration methods. Full reasoning in the `browser-testing`
skill. Record the outcome as a decision.

## 5. Decide depth

| Depth | When | Roughly |
| --- | --- | --- |
| `smoke` | Trivial change, strong existing coverage | Does it still start and serve? |
| `targeted` | Small change, clear blast radius | The changed path plus its immediate neighbours |
| `standard` | Normal feature work | Changed behaviour, its integrations, regression around it |
| `deep` | High risk, weak coverage, security or money involved | Adds negative paths, boundaries, concurrency, authorisation matrix |
| `exhaustive` | Release candidate, migration, rewrite | Everything applicable, including non-functional |

Depth is a decision. Record it with its rationale.

## 5b. Set and track the time budget

If the user specified a time constraint, record it. If they did not, estimate one based on
the target's complexity:

| Complexity | Typical budget | Covers |
| --- | --- | --- |
| Single page, 1 role | 30–60 minutes | Functional + security baseline + a11y scan |
| Multi-page, 1–2 roles | 1–2 hours | Functional + security baseline + edge cases + a11y |
| Multi-app, 3+ roles | 2–4 hours | Functional + security + edge cases + journey + a11y |
| Full QA (exhaustive) | 4–8 hours | Everything including load testing |

At ~75% of the budget, trigger the non-functional checkpoint (execution.md). At ~90%,
begin report generation regardless of remaining work — record unfinished items as
`DEFERRED` with "time budget exhausted" as the reason. A partial report delivered on time
is better than a complete one delivered never.

The budget is a decision. Record the estimate and the rationale.

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

## 6b. Cover every feature, and respect the coverage floor

Two obligations the engine now enforces at `validate --final` — plan for them here, do not
discover them at the end:

1. **Per-feature floor.** Every `high`/`critical` item in the profile's
   `functionality_inventory` needs at least one `must-test` scenario, and at execution time
   at least one execution tagged with its id (`exec start ... "feature": "FEAT-…"`). A
   critical feature with no tagged execution fails `--final`. Give each inventory item a
   happy-path scenario **and** at least one edge-case scenario (empty input, boundary,
   unauthorised actor).
2. **Category floor.** Every applicable **P0/P1** category in the persisted applicability
   matrix needs at least one execution — a real run, or an explicit `exec not-run` with a
   `BLOCKED`/`DEFERRED` status and an uncertainty saying what would unblock it. A P0/P1
   category with no record at all fails `--final`. So if load testing is applicable but you
   lack authorisation, you do not skip it silently — you record it BLOCKED with the reason.

`perf-baseline` is applicable to any reachable API or UI, independent of a stated perf
target. Treat a latency/throughput baseline as part of the default sweep on an authorised
non-production target; the deeper `load`/`stress`/`endurance` categories still need a
`perf-sensitive` signal plus explicit authorisation.

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

## 8b. Consider parallel execution

If the applicability matrix identifies **≥3 independent partitions** — distinct roles, separate
applications, or isolated surfaces with no shared mutable state — propose fanning out before
starting serial execution.

Decision rule:
- ≥3 roles, each with its own login and surface → spin up one `browser-explorer` per role
- ≥2 independent applications → one `browser-explorer` per app
- Large test matrix (>20 scenarios) with independent groups → partition to `test-author`
  subagents

Record this as a decision with the fan-out rationale:

`fanout.json`:

```json
{
  "question": "Serial vs parallel execution",
  "options": [
    {"id": "serial", "description": "One agent, 8 roles sequentially (~2h)"},
    {"id": "parallel", "description": "Fan out to 3 browser-explorer subagents by app surface (~45min)"}
  ],
  "chosen": "parallel",
  "reasons": ["8 independent roles with separate logins", "no shared mutable state between surfaces"],
  "confidence": 0.85,
  "reversible": true
}
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" decide --input fanout.json
```

Subagents must:
1. Share the same session directory (so evidence and findings aggregate)
2. Each register their own evidence via the CLI
3. Never share mutable state — no two subagents write to the same database, external
   service, or user account. Fan-out is for reads and exploration, not concurrent writes

If subagents are available but the matrix has <3 partitions, serial execution is correct —
record why you did not fan out.

## 9. Golden-path journey (mandatory for multi-role systems)

When the target involves **≥2 roles that interact** (e.g., host → guest → guard →
supervisor → admin), the plan MUST contain at least one `must-test` e2e scenario tagged
`journey:golden-path` that traverses the core value chain across roles.

Steps:
1. **Pick the core value chain** — the sequence of actions that produces the system's
   primary deliverable (e.g., "invite created → guest arrives → guard admits → visit logged").
2. **Identify the handoff points** — where one role's output becomes the next role's input.
   Each handoff is an assertion site.
3. **Assert side effects at every step** — not just "the next role can see the entity" but
   also audit trail entries, notifications, state transitions.

Record this as a planning decision:

```json
{
  "question": "Golden-path journey scope",
  "options": [
    {"id": "full-chain", "description": "All 5 roles in sequence"},
    {"id": "core-3", "description": "Creator → actor → observer only"}
  ],
  "chosen": "full-chain",
  "reasons": ["all roles interact on the same entity", "field trial showed single-role sweeps missed handoff bugs"],
  "confidence": 0.9,
  "reversible": true
}
```

If any role is blocked (missing credentials, unreachable URL), the journey is `PARTIAL`
with the blocked step identified — not silently dropped. Use alternate paths (admin
override, direct API) to keep downstream roles testable.

The `e2e-testing` skill has the execution template for cross-role journeys.

→ Next: [execution.md](execution.md)
