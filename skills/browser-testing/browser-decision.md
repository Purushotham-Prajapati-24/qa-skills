# Browser Method Decision Matrix

Source of truth: `engine/browser-decision/matrix.json`. This document explains the model;
the JSON is what runs.

## How scoring works

Each method declares an **affinity** for each factor, in [-1, 1]:

- `+1.0` — this method is at its best when the factor is high
- `-1.0` — this method is at its worst when the factor is high
- `0` / absent — the factor does not bear on this method

For each supplied factor, the engine computes `aligned = pull >= 0 ? value : 1 - value`,
then takes the weighted mean using `|pull|` as the weight. **Factors you do not supply
are excluded, never assumed.** Supplying five factors yields a weaker, honestly-scored
answer than supplying fourteen.

## Affinity summary

| Factor | MCP (A) | Script (B) | Existing (C) | Hybrid (D) | Repo stack (E) |
| --- | --- | --- | --- | --- | --- |
| ui_known | −0.9 | +0.8 | · | −0.5 | · |
| repeatability | −0.6 | +1.0 | +0.6 | +0.9 | +0.8 |
| determinism_required | −1.0 | +1.0 | +0.8 | +0.4 | +0.9 |
| exploratory_value | +1.0 | −0.6 | −0.8 | +0.8 | −0.7 |
| ci_suitability | −1.0 | +1.0 | +0.8 | +0.5 | +0.9 |
| business_criticality | · | +0.6 | · | +0.7 | · |
| assertion_complexity | −0.5 | +0.9 | · | +0.3 | · |
| execution_frequency | −0.5 | +0.8 | · | +0.6 | · |
| maintenance_cost_tolerance | +0.4 | −0.5 | +0.8 | −0.3 | +0.7 |
| existing_automation | −0.3 | −0.2 | +1.0 | −0.4 | +0.9 |
| environment_stability | −0.2 | +0.5 | +0.4 | · | · |
| evidence_requirements | · | +0.6 | · | +0.5 | · |
| network_mocking_required | −0.6 | +0.9 | · | · | · |
| tool_reliability | +0.3 | +0.5 | +0.4 | · | · |

Read a row to understand a trade-off. `maintenance_cost_tolerance` is negative for B and
D because both add a file someone has to keep alive; it is positive for C and E because
running what already exists adds nothing to maintain.

## Rules applied after scoring

Order matters.

**1. Existing first.** `existing_automation >= 0.7` selects the repository's own suite.
Running what exists is nearly always the cheapest reliable evidence, regardless of score.

**2. Hybrid trigger.** `exploratory_value >= 0.55` **and** `repeatability >= 0.55`
selects explore-then-automate. Rationale: the behaviour must be discovered before it can
be asserted, and it will recur often enough to justify committing a script afterwards.

**3. Otherwise**, the highest-scoring eligible method.

**4. Ambiguity gate.** If the top two are within `0.05`, the engine sets
`escalate: true` rather than committing. Guessing here produces confidently wrong browser
strategy, which is expensive to unwind.

**When `escalate: true`, `selected` is always `null`.** The engine will never hand you a
usable answer at the same time as telling you not to trust it. The candidate it would have
picked, had it been forced to, appears as `top_candidate` instead — read that name as a
warning, not a fallback. Do not substitute `top_candidate` (or `candidates[0]`) for
`selected` yourself; that is precisely the guess this gate exists to prevent. Either supply
better factors and re-decide, or record a `decide` entry that names the ambiguity and your
chosen tiebreak explicitly, so the choice is auditable as a decision rather than invisible
as a default.

## Hard rules

Applied before scoring; they remove methods entirely.

| ID | Condition | Forbids | Why |
| --- | --- | --- | --- |
| `no-mcp-for-ci-gate` | `ci_suitability >= 0.8` | A | A gate must be reproducible and return an exit code. An agent session is neither. |
| `no-script-for-unknown-ui` | `ui_known <= 0.25` | B | Selectors written for an unexamined UI encode guesses and rot immediately. |
| `no-existing-without-existing` | `existing_automation <= 0.15` | C, E | There is nothing to run. |
| `no-exploration-on-production` | production target | A, D | Open-ended agent interaction with production can trigger real side effects. |

A method whose capability is unavailable is also removed, with the reason recorded.

## Conversion thresholds

After exploration, `should-automate` requires **all** of:

| Check | Threshold | Why |
| --- | --- | --- |
| `repeatability` | ≥ 0.5 | A test run once is a cost, not an asset. |
| `business_criticality` | ≥ 0.4 | Low-value tests dilute signal and slow CI. |
| `environment_stability` | ≥ 0.5 | An unstable target produces false failures and trains people to ignore red. |
| `expected_runtime_minutes` | ≤ 10 | A slow test gets skipped, then deleted. |

## Worked examples

**Stable UI, needs a CI gate** — `ui_known 0.9`, `repeatability 0.9`,
`ci_suitability 0.9`, `existing_automation 0.1` → **B**. Hard rule removes A.

**Unfamiliar UI, one-off investigation** — `ui_known 0.1`, `exploratory_value 0.9`,
`repeatability 0.2` → **A**. Hard rule removes B; hybrid trigger does not fire because
repeatability is low, so there is nothing worth committing.

**Unfamiliar UI, recurring critical flow** — `ui_known 0.2`, `exploratory_value 0.8`,
`repeatability 0.85` → **D**. This is the common case for a changed feature.

**Repository already has good Cypress coverage** — `existing_automation 0.9` → **E**.
Do not introduce Playwright alongside Cypress to make a point.

**Production incident investigation** — production, `exploratory_value 0.9` → A and D are
forbidden. Escalate: ask for a staging reproduction, or for explicit authorisation and a
strictly read-only interaction plan.

## Tuning

Edit `matrix.json`. Add a factor by declaring it under `factors` and giving it an affinity
in each method that cares. Add a method by adding an entry under `methods` with its
capability, `produces_regression_asset`, `deterministic` and affinities. Adjust thresholds
under `thresholds`.

Then re-run the benchmark, which is what catches an edit that silently changed behaviour
somewhere else:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" eval run
```
