<!--
GENERATED ARTEFACT — illustrative example.

Produced by `node scripts/demo-session.mjs`, which drives the engines through a
simulated session. The software described does not exist and no real testing occurred.
It is included so you can see the exact shape the system produces, rather than a
hand-written approximation of it.
-->
# Testing Report · REPORT-2026-00001

**FAILED** — 4 executions run · 1 finding, worst critical · 2 planned items not run.

| Session | Repository | Commit | PR | Generated | Skill |
| --- | --- | --- | --- | --- | --- |
| SESSION-0001 | acme/shop (feat/SHOP-412-saved-card) | abc1234 | 412 | 2026-09-16 11:19:16Z | v0.6.0 |

## Verdict

- 1 execution(s) failed — each carries a failure classification below.
- 1 execution(s) blocked; their scope was NOT covered by anything else.
- 1 finding(s) at critical severity or above.

## Needs attention

| Severity | Count | Findings |
| --- | --- | --- |
| Critical | 1 | FIND-00001 |

### Critical

#### FIND-00001 — Saved card belonging to another user is selectable and chargeable

`server/payments` · reproduced 3/3 (always) · confidence 0.86 · security-issue

The payment-method lookup does not compare the record owner to the session user, so any authenticated user can select and charge a card saved by someone else.

| Expected | Actual |
| --- | --- |
| 403 Forbidden, or 404 if the design hides existence | 200 OK with user B's card brand, last4 and billing postcode |

**Impact.** Any authenticated user can enumerate and charge other users' stored cards. Financial and personal data exposure.

**Next.** Add an ownership check in server/payments/stripe.ts:52 before returning or using a payment method.

_Evidence: EV-2026-00002_

## What was proven

| Execution | What was checked | Category | Method | Evidence |
| --- | --- | --- | --- | --- |
| EXEC-2026-00002 | Baseline: full unit suite at head | regression | existing-suite | EV-2026-00001 |

_Every row above executed against the commit named at the top and is backed by the evidence cited. Nothing else in this report is a claim that something works._

## What was not tested

_Read this before drawing any conclusion from the results above._

**Planned, not run.**

- Payment E2E against the real provider — BLOCKED: STRIPE_SECRET_KEY is unset; refusing to transact against a live key.
- Localisation testing — NOT_APPLICABLE: No i18n resources exist in the repository; nothing is translated.

**Not applicable to this repository.**

- 22 categories — no matching repository signal: agent-tool-eval, ai-llm, caching, compatibility, concurrency, contract, cross-browser, deployment, endurance, infrastructure, load, localization, logging-monitoring, mobile-viewport, non-functional, observability, performance, rag-evaluation, responsive, rollback, spike, stress

**Coverage gaps.**

- security: no existing coverage
- migration: no existing coverage

## Open questions

| ID | Status | Question | What would resolve it | Owner |
| --- | --- | --- | --- | --- |
| U-00001 | user-input-required | Should payment E2E use a real provider sandbox key, or a mock at the HTTP boundary? | ask the user which environment and credentials to use | user |

_Questions owned by you are the only ones the agent cannot progress on its own._

## Remaining work

| Status | Item | Why | Blocked by |
| --- | --- | --- | --- |
| BLOCKED | Payment E2E against a provider sandbox | awaiting an environment decision | U-00001 |
| INTERRUPTED | Accessibility scan of the checkout pages | user redirected mid-run; must restart from the beginning | — |
| DEFERRED | Migration rollback compatibility check | deferred for budget; the forward migration was verified | — |

## Recommended next

- Add the ownership check in server/payments/stripe.ts:52 before anything else ships.
- Decide the payment E2E environment so the drafted spec can run.
- Add a rollback-compatibility check to CI — the forward migration passes but the previous app version was not tested against the new schema.

---

## Detail

### Executions

| ID | Status | Goal | Method | Failure class | Duration |
| --- | --- | --- | --- | --- | --- |
| EXEC-2026-00003 | FAILED | User A cannot select user B's saved card | api-client | authentication-failure (0.5) | 8 ms |
| EXEC-2026-00004 | BLOCKED | Payment E2E against the real provider | not-executed | — | 0 ms |
| EXEC-2026-00001 | INCONCLUSIVE | Quick smoke of the checkout page | existing-suite | insufficient-evidence (0.9) | 5 ms |
| EXEC-2026-00006 | INTERRUPTED | Accessibility scan of the checkout pages | static-analysis | — | — |
| EXEC-2026-00005 | NOT_APPLICABLE | Localisation testing | not-executed | — | 0 ms |
| EXEC-2026-00002 | PASSED | Baseline: full unit suite at head | existing-suite | — | 11 ms |

| Status | Count |
| --- | --- |
| INCONCLUSIVE | 1 |
| PASSED | 1 |
| FAILED | 1 |
| BLOCKED | 1 |
| NOT_APPLICABLE | 1 |
| INTERRUPTED | 1 |

### Evidence

| ID | Kind | Summary | Artifact |
| --- | --- | --- | --- |
| EV-2026-00001 | command-output | vitest: 211/211 passed | C:\Users\purus\AppData\Local\Temp\ast-demo-cRnOgw\evidence\blobs\output-2026-09-16T11-19-16-425Z-18112.txt |
| EV-2026-00002 | command-output | api: 11/12 passed, 1 failed | C:\Users\purus\AppData\Local\Temp\ast-demo-cRnOgw\evidence\blobs\output-2026-09-16T11-19-16-438Z-18112.txt |

### External writes

| System | Action | Target | Provider confirmation | Authorised by | Reference |
| --- | --- | --- | --- | --- | --- |
| github | github.create_issue | acme/shop | CONFIRMED | user-explicit | https://github.com/acme/shop/issues/418 |
| jira | jira.comment | SHOP-412 | NOT CONFIRMED | user-explicit | — |

_An unconfirmed write means the agent attempted it and did not receive a success response. It is reported as attempted, never as done._

### Decisions

| ID | Question | Chose | Confidence | Reversible | Outcome | Leading reason |
| --- | --- | --- | --- | --- | --- | --- |
| DEC-00001 | How should the changed saved-card checkout UI be tested? | hybrid | 0.78 | yes | — | Scenario: Saved-card checkout flow was changed; existing Playwright coverage is partial and the new branch has not been examined. |

### Observations

_Recorded for the reader, not filed as defects._

### Duplicates suppressed

- FIND-00002 — same fingerprint as FIND-00001

---

## Appendix

### Risk assessment

**0.8905** (critical) · profile `security-critical` · assessment confidence 0.6176

| Factor | Value | Weight | Contribution | Basis | Why |
| --- | --- | --- | --- | --- | --- |
| security_sensitivity | 0.9 | 2 | 1.8 | observed | payment-method lookup reads session identity (stripe.ts:52) |
| data_sensitivity | 1 | 1.8 | 1.8 | observed | stored card references and billing addresses |
| irreversibility | 0.9 | 1.5 | 1.35 | inferred | captures real payments; refunds are manual |
| business_criticality | 1 | 1 | 1 | observed | checkout is the only revenue path |
| coverage_deficit | 0.8 | 1.2 | 0.96 | observed | no test exercises the saved-card branch (grep across e2e/ and server/) |
| change_magnitude | 0.6 | 0.6 | 0.36 | observed | 312 changed lines across 7 files (git diff --stat) |
| change_frequency | 0.7 | 0.3 | 0.21 | observed | 31 commits to server/payments in 6 months |

_Excluded for lack of evidence — not scored, not guessed: user_impact, dependency_complexity, integration_complexity, historical_failures, test_flakiness, deployment_exposure, external_system_dependency._

### Test applicability matrix

| Category | Applicable | Priority | Coverage | Score | Reason |
| --- | --- | --- | --- | --- | --- |
| dependency-scan | yes | P0 | unknown | 0.84 | Signals present: third-party-deps. Existing coverage "unknown" leaves a deficit of 0.7; addresses risk factor(s): security_sensitivity. |
| security | yes | P0 | none | 0.6 | Signals present: user-input, auth, pii. Existing coverage "none" leaves a deficit of 1; addresses risk factor(s): security_sensitivity, data_sensitivity. |
| input-validation | yes | P0 | unknown | 0.56 | Signals present: user-input. Existing coverage "unknown" leaves a deficit of 0.7; addresses risk factor(s): security_sensitivity. |
| session-management | yes | P0 | unknown | 0.56 | Signals present: sessions. Existing coverage "unknown" leaves a deficit of 0.7; addresses risk factor(s): security_sensitivity. |
| database | yes | P0 | unknown | 0.5169 | Signals present: database. Existing coverage "unknown" leaves a deficit of 0.7; addresses risk factor(s): data_sensitivity. Deferred: would exceed the 150-minute budget (already committed 120 minutes on higher- or equal-priority work). |
| authn-authz | yes | P0 | unknown | 0.48 | Signals present: auth, authz. Existing coverage "unknown" leaves a deficit of 0.7; addresses risk factor(s): security_sensitivity. Deferred: would exceed the 150-minute budget (already committed 120 minutes on higher- or equal-priority work). |
| data-integrity | yes | P0 | unknown | 0.4523 | Signals present: database. Existing coverage "unknown" leaves a deficit of 0.7; addresses risk factor(s): data_sensitivity, irreversibility. Deferred: would exceed the 150-minute budget (already committed 120 minutes on higher- or equal-priority work). |
| migration | yes | P0 | none | 0.45 | Signals present: migrations. Existing coverage "none" leaves a deficit of 1; addresses risk factor(s): irreversibility. Deferred: would exceed the 150-minute budget (already committed 120 minutes on higher- or equal-priority work). |
| acceptance | yes | P2 | unknown | 0.2872 | Signals present: any repository. Existing coverage "unknown" leaves a deficit of 0.7; addresses risk factor(s): business_criticality. Deferred: would exceed the 150-minute budget (already committed 120 minutes on higher- or equal-priority work). |
| regression | yes | P2 | unknown | 0.2184 | Signals present: existing-tests. Existing coverage "unknown" leaves a deficit of 0.7; addresses risk factor(s): coverage_deficit, change_frequency. |
| api | yes | P2 | minimal | 0.1862 | Signals present: http-api. Existing coverage "minimal" leaves a deficit of 0.8; addresses risk factor(s): integration_complexity, coverage_deficit. Deferred: would exceed the 150-minute budget (already committed 140 minutes on higher- or equal-priority work). |
| accessibility | yes | P2 | unknown | 0.1697 | Signals present: web-ui. Existing coverage "unknown" leaves a deficit of 0.7; addresses risk factor(s): user_impact, business_criticality. Deferred: would exceed the 150-minute budget (already committed 140 minutes on higher- or equal-priority work). |
| sanity | yes | P2 | unknown | 0.168 | Signals present: any repository. Existing coverage "unknown" leaves a deficit of 0.7; addresses risk factor(s): change_magnitude. |
| component | yes | P2 | unknown | 0.1629 | Signals present: component-framework. Existing coverage "unknown" leaves a deficit of 0.7; addresses risk factor(s): coverage_deficit, user_impact. Deferred: would exceed the 150-minute budget (already committed 150 minutes on higher- or equal-priority work). |
| exploratory | yes | P3 | unknown | 0.1494 | Signals present: ui, http-api. Existing coverage "unknown" leaves a deficit of 0.7; addresses risk factor(s): coverage_deficit, historical_failures. Deferred: would exceed the 150-minute budget (already committed 150 minutes on higher- or equal-priority work). |
| unit | yes | P3 | substantial | 0.0782 | Signals present: any repository. Existing coverage "substantial" leaves a deficit of 0.2; addresses risk factor(s): change_magnitude, coverage_deficit. Deferred: would exceed the 150-minute budget (already committed 150 minutes on higher- or equal-priority work). |
| e2e | yes | P3 | partial | 0.0741 | Signals present: web-ui. Existing coverage "partial" leaves a deficit of 0.5; addresses risk factor(s): business_criticality, user_impact. Deferred: would exceed the 150-minute budget (already committed 150 minutes on higher- or equal-priority work). |
| smoke | yes | P3 | unknown | 0.042 | Signals present: any repository. Existing coverage "unknown" leaves a deficit of 0.7; addresses risk factor(s): deployment_exposure. Deferred: would exceed the 150-minute budget (already committed 150 minutes on higher- or equal-priority work). |
| ci-cd | yes | P3 | unknown | 0.0336 | Signals present: ci. Existing coverage "unknown" leaves a deficit of 0.7; addresses risk factor(s): deployment_exposure. Deferred: would exceed the 150-minute budget (already committed 150 minutes on higher- or equal-priority work). |
| functional | yes | P3 | unknown | 0.028 | Signals present: any repository. Existing coverage "unknown" leaves a deficit of 0.7; addresses risk factor(s): user_impact. Deferred: would exceed the 150-minute budget (already committed 150 minutes on higher- or equal-priority work). |
| ui | yes | P3 | unknown | 0.028 | Signals present: ui. Existing coverage "unknown" leaves a deficit of 0.7; addresses risk factor(s): user_impact. Deferred: would exceed the 150-minute budget (already committed 150 minutes on higher- or equal-priority work). |
| integration | yes | P3 | unknown | 0.0258 | Signals present: database, http-api, external-integration. Existing coverage "unknown" leaves a deficit of 0.7; addresses risk factor(s): dependency_complexity, integration_complexity. Deferred: would exceed the 150-minute budget (already committed 150 minutes on higher- or equal-priority work). |
| visual | yes | P3 | unknown | 0.0258 | Signals present: web-ui. Existing coverage "unknown" leaves a deficit of 0.7; addresses risk factor(s): user_impact. Deferred: would exceed the 150-minute budget (already committed 150 minutes on higher- or equal-priority work). |
| browser-automation | yes | P3 | unknown | 0.024 | Signals present: web-ui. Existing coverage "unknown" leaves a deficit of 0.7; addresses risk factor(s): user_impact. Deferred: would exceed the 150-minute budget (already committed 150 minutes on higher- or equal-priority work). |
| resilience | yes | P3 | unknown | 0.0187 | Signals present: external-integration. Existing coverage "unknown" leaves a deficit of 0.7; addresses risk factor(s): external_system_dependency. Deferred: would exceed the 150-minute budget (already committed 150 minutes on higher- or equal-priority work). |
| agent-tool-eval | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: agent-tools; missing: agent-tools). |
| ai-llm | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: llm; missing: llm). |
| caching | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: cache; missing: cache). |
| compatibility | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: multi-browser, container; missing: multi-browser, container). |
| concurrency | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: concurrency; missing: concurrency). |
| contract | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: public-contract; missing: public-contract). |
| cross-browser | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: multi-browser; missing: multi-browser). |
| deployment | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: deploy-config; missing: deploy-config). |
| endurance | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: perf-sensitive; missing: perf-sensitive). |
| infrastructure | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: container, deploy-config; missing: container, deploy-config). |
| load | no | P3 | unknown | 0 | Repository shows no signal for this category (needs all of: perf-sensitive, http-api; missing: perf-sensitive). |
| localization | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: i18n; missing: i18n). |
| logging-monitoring | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: observability; missing: observability). |
| mobile-viewport | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: responsive; missing: responsive). |
| non-functional | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: perf-sensitive, observability; missing: perf-sensitive, observability). |
| observability | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: observability; missing: observability). |
| performance | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: perf-sensitive; missing: perf-sensitive). |
| rag-evaluation | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: rag; missing: rag). |
| responsive | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: responsive; missing: responsive). |
| rollback | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: rollback-path; missing: rollback-path). |
| spike | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: perf-sensitive; missing: perf-sensitive). |
| stress | no | P3 | unknown | 0 | Repository shows no signal for this category (needs any of: perf-sensitive; missing: perf-sensitive). |

### Goals

| Goal | Description | Success criterion | Status | Evidence |
| --- | --- | --- | --- | --- |
| G-01 | Validate the saved-card payment flow | A saved card completes and creates exactly one order | NEEDS_USER_INPUT | — |
| G-01 | Validate the saved-card payment flow | A declined card errors and creates no order | NEEDS_USER_INPUT | — |
| G-01 | Validate the saved-card payment flow | A user cannot select another user's saved card | FAILED | EV-2026-00002 |

### Evaluation metrics

| Metric | Value | Direction |
| --- | --- | --- |
| false_confidence_rate | 0 | lower-is-better |
| requirement_coverage | 0.6667 | higher-is-better |
| high_risk_coverage | 0 | higher-is-better |
| decision_accuracy | _n/a (zero denominator)_ | higher-is-better |
| decision_assessment_rate | 0 | higher-is-better |
| actionable_finding_rate | 0 | higher-is-better |
| evidence_completeness | 1 | higher-is-better |
| automation_conversion | _n/a (zero denominator)_ | higher-is-better |
| unnecessary_test_rate | 0.5 | lower-is-better |
| runtime_efficiency_ms_per_case | 8 | lower-is-better |
| flaky_identification_quality | _n/a (zero denominator)_ | higher-is-better |
| interruption_recovery_rate | 0.5 | higher-is-better |
| authorization_compliance | 1 | higher-is-better |
| reproducibility | 0.5 | higher-is-better |

_Sample sizes: {"executions":6,"decisions":1,"findings":2,"external_writes":1,"declared_requirements":3}. A null means the denominator was zero — honest, and not to be read as 0._

### Integrity self-audit

| Unevidenced PASSED claims | False confidence rate |
| --- | --- |
| 0 | 0 |

_No integrity violations detected in this report._

**Checks run:**

- every PASSED/COMPLETED claim checked against attached evidence
- external writes checked for provider confirmation
- unfinished executions surfaced as INTERRUPTED
- not-applicable categories listed with reasons

---

Produced by the Autonomous Software Testing skill system v0.6.0. Every status above is traceable to a record under `state/`.
