---
name: test-strategy
description: Turn a repository profile, change analysis, requirements and risk assessment into a concrete test plan — scope, out-of-scope, strategy, depth, prioritised scenarios, test data, environments, tooling, expected evidence, success and exit criteria, fallbacks, deferred work and open questions. Use when asked for a test plan, a test strategy, a test implementation plan, or what testing a piece of work needs.
when_to_use: "create a test plan", "what's the test strategy", "detailed test implementation plan", "how should we test this", "acceptance testing plan"
allowed-tools: Read, Glob, Grep, Bash, PowerShell, Write
metadata:
  system_version: 0.9.0
  role: specialist
---

# Test Strategy

A plan states what will be tested, what will not, and why. A plan with no out-of-scope
section did not think about scope.

Template: [../../templates/test-plan.md](../../templates/test-plan.md).
Schema: `schemas/testing-plan.schema.json`.

## Inputs

You need all four before planning. If one is missing, get it — planning without a risk
assessment produces a plan ordered by what was easy to think of.

1. Repository profile → `ast profile show`
2. Change summary → `change-intelligence`
3. Requirements → `requirement-analysis`
4. Risk assessment → `ast risk score`

## Obligations

Every scenario carries exactly one:

| Obligation | Meaning |
| --- | --- |
| `must-test` | The plan has failed if this does not run. High risk, or an explicit requirement. |
| `should-test` | Real value. Drop only under time pressure, and say that you dropped it. |
| `nice-to-test` | Do it if the budget allows. |
| `not-applicable` | Considered and excluded. **Give the reason.** |
| `blocked` | Cannot run. Carries the uncertainty ID that blocks it. |
| `deferred` | Worth doing later. Says what would make it worth doing. |

## Writing a scenario

```jsonc
{
  "id": "SC-04",
  "title": "Declined card shows an error and creates no order",
  "category": "e2e",
  "obligation": "must-test",
  "priority": "P0",
  "method": "playwright-script",
  "preconditions": ["Cart contains SKU-1001", "Stripe test mode reachable"],
  "steps": ["Go to /checkout", "Enter card 4000000000000002", "Submit"],
  "expected": "An inline error naming the decline reason; no order row; cart preserved",
  "test_data": "Stripe test card 4000000000000002 (generic decline)",
  "environment": "local-docker",
  "expected_evidence": ["playwright JSON report", "trace", "DB query showing no order row"],
  "validates_requirements": ["REQ-3"],
  "covers_risks": ["irreversibility", "business_criticality"],
  "estimated_minutes": 12
}
```

Note what the expectation asserts: not "it fails gracefully" but a specific observable
outcome plus a **negative** assertion (no order row). Negative assertions are where
payment bugs actually live.

## Test data

State it explicitly, and prefer data that cannot cause harm:

- Documented provider test values (Stripe test cards, sandbox accounts).
- Synthetic personal data. Never real customer data, even in staging.
- Deterministic values. A test seeded with `Math.random()` fails differently each time.
- Explicit cleanup — or an environment that is disposable.

## Environments

For each: is it available, what is its base URL, and **is it safe to write to?**

An environment is non-production only when the repository profile says so. Unknown counts
as production. See [../testing-orchestrator/policies/authorization-policy.md](../testing-orchestrator/policies/authorization-policy.md).

## Success versus exit criteria

They are different and both are needed.

- **Success criteria** — what "the software is good enough" means. *All P0 scenarios pass;
  no open blocker or critical finding; no regression in the existing suite.*
- **Exit criteria** — what "testing is finished" means, including unhappy endings. *Every
  planned scenario has a terminal status; every blocked item has an uncertainty with a next
  action; the report's false-confidence rate is 0.*

You can meet exit criteria while failing success criteria. That is a valid, useful outcome:
testing finished, the software is not ready.

## Fallback strategy

Say in advance what happens when the plan meets reality:

> If the Stripe sandbox is unreachable, mock at the HTTP boundary to cover our own logic,
> mark the true integration `BLOCKED`, and raise an uncertainty. Do not skip the scenario
> silently and do not point it at live keys.

## Parallel and serial

Declare both. Parallelise reads freely. Never parallelise anything sharing mutable state —
a database under test, an external write, a report version bump.

## Validate and record

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" applicability eval --input applicability.json   # every category, applicable or not
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" uncertainty partition --input scenarios.json    # what can start now
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" decide --input scope-decision.json              # record the scope call
```

## Smells

- No out-of-scope section → scope was not considered.
- No `not-applicable` rows → the applicability matrix was not read.
- Every scenario is `must-test` → nothing was prioritised.
- No test data named → the plan is not executable.
- No evidence expectations → results will not be verifiable.
- Exit criteria that only describe success → no plan for the unhappy path.
