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

**Who set the budget decides what it may excuse.**

- **The user stated a budget** — it binds. At ~90%, generate the report; record each
  unfinished item as `DEFERRED` linked to an uncertainty with `owner: "user"` and
  `"user_quote"` set to the user's own words ("you have 30 minutes"). The engine looks for
  that quote in the session request and in what the user said since (recorded by the
  UserPromptSubmit hook, or by you with `session said --quote "…"`); without it, or with a
  quote the user never said, the hold does not count.
- **You estimated the budget** — it is a pacing guide, not a stopping rule. It never
  justifies dropping a committed scenario, a floor category or a test you wrote. An
  agent-owned "out of time" deferral does not count toward any floor, so `validate --final`
  will still fail. If the work is genuinely larger than one session, plan fewer must-test
  scenarios up front and say why — do not commit to work and then quietly shed it.

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
   matrix, and every applicable **mandatory baseline** (`security`, `input-validation`,
   `accessibility`, `perf-baseline`) whatever its priority, needs at least one execution — a
   real run, or an explicit `exec not-run` with a `BLOCKED`/`DEFERRED` status whose
   `uncertainties` links the uncertainty saying what would unblock it. A not-run with no
   linked uncertainty does not count. So if the security sweep is applicable but you lack
   authorisation, you do not skip it silently — you record it BLOCKED with the reason.

`perf-baseline` is applicable to any reachable API or UI, independent of a stated perf
target, and as a mandatory baseline the floor enforces it: run a latency/throughput baseline
on an authorised non-production target, or record why you could not. The deeper
`load`/`stress`/`endurance` categories still need a `perf-sensitive` signal plus explicit
authorisation.

## 6c. Persist the plan

After writing the plan, **save it to the engine** so the scenario coverage floor can check
that every `must-test` scenario was executed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" plan save --input plan.json
```

Start from `plan save --example > plan.json` rather than writing the shape from memory.
Every scenario needs `id` (e.g. `S-01`), `title`, `category` (a catalog test category),
`method` and `obligation`, plus `feature` when it exercises an inventory item; `provenance`
needs `created_at` and `created_by: "agent"`. The
CLI generates a `plan_id` if you omit one, links the plan to the session, and validates the
whole structure.

**Why this matters:** `validate --final` checks the persisted plan for `must-test` scenarios
and fails when any of them has no execution linked to it. A plan that lives only in a
Markdown document or in your own reasoning is invisible to the coverage floor — it is a
wish list, not a commitment. Persist it.

What the engine holds you to once the plan is saved:

- **Commitments only ratchet up.** Every scenario keeps the strongest obligation it has had
  in this session. Re-saving the plan with a must-test scenario dropped or downgraded does
  not release it — `plan save` warns, and the floor still enforces it. To retire one
  legitimately, record a decision and an `exec not-run` NOT_APPLICABLE citing it.
- **`blocked` is a commitment too.** A scenario planned as `blocked` must name its
  `blocked_by` uncertainty and still needs an `exec not-run` linked to it, so it appears in
  the report instead of vanishing.
- **`should-test` needs a disposition.** Run it, or record an `exec not-run` (SKIPPED is
  fine) with the reason. An exclusion the reader cannot see is not allowed.
- **A plan with no `must-test` scenario commits to nothing** and fails `--final`.
- **No plan at all**, once real work has run, fails `--final`.
- **The plan must name everything the floors will demand.** One committed scenario per floor
  category (applicable P0/P1, plus the mandatory baselines); one per `high` inventory item and
  **two** per `critical` one (happy path and an edge case), tagged with `"feature": "FEAT-…"`.
  A thin plan fails `--final` as `plan-misses-floor-category` / `plan-misses-feature` — plan it
  up front so `todo` is the complete list from the start.
- **Applicable P2/P3 categories need a disposition.** They need not run, but each needs a run
  or a recorded skip (`exec not-run` with `SKIPPED` and the reason) so the exclusion is in the
  report.

Then work the queue, not the document:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" todo            # what is still owed, with next commands
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" plan progress   # per-scenario view, every attempt and whether it counted
```

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
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" session phase plan --note "plan PLAN-00001 saved"
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
    {"id": "serial", "label": "One agent, 8 roles sequentially (~2h)"},
    {"id": "parallel", "label": "Fan out to 3 browser-explorer subagents by app surface (~45min)"}
  ],
  "selected": "parallel",
  "reason": ["8 independent roles with separate logins", "no shared mutable state between surfaces"],
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

## 8c. Exploratory charters: a bug bash that ends in proof

When `exploratory` is applicable (a UI nobody has mapped, or "find bugs in X"), plan the
exploration as charters, not as one open-ended wander:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" plan charters --areas "checkout,signup,account" --postures first-time-user,edge-input,error-paths
```

It prints one `must-test` scenario per area × posture (category `exploratory`, with the
persona and mission filled in). The five postures are `first-time-user`, `numbers-and-copy`,
`edge-input`, `state-after-reload` and `error-paths`; pick the ones that fit, or omit
`--postures` for all five. Add the scenarios to the plan and `plan save` — the scenario floor
then enforces that every charter was actually explored.

Then:

1. **Fan out.** One `browser-explorer` subagent per charter, up to four at once. Give each
   its scenario ID; it records its run with `plan_scenario_id` and files candidates with
   `finding add`. They share the session safely.
2. **Merge.** Duplicate candidates collapse on their fingerprint automatically.
3. **Triage before writing any test.** Reject explorer artifacts, environment issues,
   intended design and fixture gaps with `finding reject … --class … --reason … --cite …`.
   Read the source before calling anything intended.
4. **Prove what survives.** For each remaining candidate, write a repro check and run it
   with `"reproduces": "FIND-…"` (`defect-reporting` skill). A failure on the assertion
   confirms it; a locator miss or a timeout means the repro is wrong; a pass refutes it.
5. **Report** confirmed defects first, then unverified risks, then rejections with reasons —
   the rendered report does this ordering for you.

`validate --final` holds you to step 4 for every `major`+ defect claim.

## 9. Golden-path journey (mandatory for multi-role systems)

When the target involves **≥2 roles that interact** (e.g., host → guest → guard →
supervisor → admin), the plan MUST contain at least one `must-test` e2e scenario that
traverses the core value chain across roles. Make it enforceable: add the chain to the
profile's `functionality_inventory` as a `critical` `flow` (for example `FLOW-golden-path`),
and tag the journey's executions with `"feature": "FLOW-golden-path"`. The per-feature floor
then fails `validate --final` if the journey never ran.

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
    {"id": "full-chain", "label": "All 5 roles in sequence"},
    {"id": "core-3", "label": "Creator → actor → observer only"}
  ],
  "selected": "full-chain",
  "reason": ["all roles interact on the same entity", "field trial showed single-role sweeps missed handoff bugs"],
  "confidence": 0.9,
  "reversible": true
}
```

If any role is blocked (missing credentials, unreachable URL), the journey is `PARTIAL`
with the blocked step identified — not silently dropped. Use alternate paths (admin
override, direct API) to keep downstream roles testable.

The `e2e-testing` skill has the execution template for cross-role journeys.

→ Next: [execution.md](execution.md)
