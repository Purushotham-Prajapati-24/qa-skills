# Test Plan — {{PLAN_ID}}

> Rendered from `schemas/testing-plan.schema.json`. Keep the machine-readable plan as the
> source of truth; this document is for humans.

**Objective** {{OBJECTIVE}}
**Trigger** {{user-request | pull-request | commit | ticket | schedule | deployment | failure | release-candidate}}
**Repository** {{REPO}} · **Branch** {{BRANCH}} · **Commit** {{COMMIT}} · **PR** {{PR}}
**Plan version** {{v1.0.0}} · **Skill version** {{v0.5.0}} · **Session** {{SESSION-ID}}

---

## 1. Scope

**In scope**
- …

**Out of scope**
- … *(and why — "not affected by this change" is a good reason; silence is not)*

**Rationale** {{Why this boundary and not a wider or narrower one.}}

## 2. Assumptions

- … *(Each assumption is something that, if wrong, changes the plan. Say so.)*

## 3. Requirements under test

| ID | Statement | Source | Acceptance criteria | Testable? | Ambiguity |
| --- | --- | --- | --- | --- | --- |
| REQ-1 | | jira / github-issue / readme / code / user / inferred / spec-file | | yes/no | |

*Requirements nobody wrote down are invisible here and remain the largest untested surface.*

## 4. Change summary

Files changed {{N}} · +{{ins}} / −{{del}}

**Impacted modules** …
**User-facing behaviour affected** …
**Existing tests that cover it** …
**Coverage gaps** …

## 5. Risk assessment

**Score** {{0.00}} ({{level}}) · **Profile** {{balanced}} · **Assessment confidence** {{0.00}}

| Factor | Value | Weight | Contribution | Basis class | Why |
| --- | --- | --- | --- | --- | --- |

**Excluded for lack of evidence (not guessed):** …

> Confidence is the share of profile weight that could be evidenced. Report the score
> *and* the confidence — "0.91 at confidence 0.30" means something quite different from
> "0.91".

## 6. Applicable test categories

| Category | Applicable | Priority | Existing coverage | Cost (min) | Reason |
| --- | --- | --- | --- | --- | --- |

**Not applicable, with reasons**

| Category | Why not |
| --- | --- |

*This table is mandatory. A category that was never considered is indistinguishable from one
that was silently dropped.*

## 7. Strategy

**Approach** …
**Depth** {{smoke / targeted / standard / deep / exhaustive}} — *because* …
**Parallelisable** …
**Must serialise** … *(anything sharing mutable state: a database under test, external
writes, report version bumps)*

## 8. Scenarios

| ID | Title | Category | Obligation | Pri | Method | Validates | Est. |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SC-01 | | | must-test | P0 | | REQ-1 | 12m |

Obligations: `must-test` · `should-test` · `nice-to-test` · `not-applicable` · `blocked` · `deferred`

### SC-01 — {{title}}

- **Preconditions** …
- **Steps** …
- **Expected** … *(a specific observable outcome, including the negative assertion where one
  applies — "and no order row is created")*
- **Test data** …
- **Environment** …
- **Expected evidence** …

## 9. Test data

| Data | Source | Safe? | Cleanup |
| --- | --- | --- | --- |

*Never real customer data, even in staging. Deterministic values only.*

## 10. Environments

| Name | Available | Base URL | Safe for writes | Notes |
| --- | --- | --- | --- | --- |

*An environment is non-production only when the repository profile says so. Unknown counts
as production.*

## 11. Tooling

| Capability | Resolved provider | Available | Fallback |
| --- | --- | --- | --- |

## 12. Success criteria

- … *(what "the software is good enough" means)*

## 13. Exit criteria

- … *(what "testing is finished" means — including the unhappy endings: every planned
  scenario has a terminal status, every blocker has a next action)*

> You can meet exit criteria while failing success criteria. That is a valid outcome:
> testing finished, the software is not ready.

## 14. Fallback strategy

{{What happens when the plan meets reality. "If the sandbox is unreachable, mock at the HTTP
boundary, mark the true integration BLOCKED, raise an uncertainty. Do not point at live keys."}}

## 15. Open questions

| ID | Question | Status | Blocks | Next action | Owner |
| --- | --- | --- | --- | --- | --- |

## 16. Deferred

| Item | Why deferred | What would make it worth doing |
| --- | --- | --- |

## 17. Estimated effort

{{N}} minutes across {{M}} scenarios.

---

**Decisions behind this plan** {{DEC-…, DEC-…}}
