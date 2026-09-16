# Testing Strategy — acme/shop

> **Illustrative example.** The project described does not exist.
>
> Unlike the other files in this directory, this one is **hand-written** — a testing strategy
> is a human document expressing team decisions. The agent reads it and works within it; it
> does not generate it.

**Version** 2.0 · **Owner** Platform team · **Last reviewed** 2026-09-01
**Agent skill version in use** v0.5.0

---

## 1. What we are trying to achieve

Ship checkout changes without charging anyone incorrectly.

Everything below follows from that sentence. Where a trade-off is unclear, the question is
"which option is more likely to let a wrong charge through?", not "which gives better
coverage numbers".

## 2. Risk profile

**`security-critical`**, always, for anything touching `server/payments`, `server/auth` or
`prisma/schema.prisma`. `balanced` elsewhere.

We chose this deliberately: the default `balanced` profile weights irreversibility at 0.8,
which puts a lossy migration at 0.81 — just under `critical`. For a system that moves money,
that is the wrong side of the line.

Configured in `engine/risk-engine/weights.json`. Changing it requires a PR and a re-run of
`ast eval run`.

## 3. Test levels and what each is for

| Level | Owns | Target runtime |
| --- | --- | --- |
| Unit | Business logic, arithmetic, validation, edge cases | < 20s whole suite |
| Component | Rendering, form states, error and empty states | < 60s |
| API | Contracts, authorisation, idempotency | < 2 min |
| E2E | The four critical journeys only | < 5 min |
| Migration | Every schema change, forward **and** rollback-compatibility | per change |

**Validation branches belong in unit or component tests, not E2E.** Pushing them into E2E is
how the suite became slow enough to be ignored in 2025. We are not doing that again.

## 4. The four E2E journeys

Only these. Adding a fifth requires a team decision.

1. Guest checkout with a card
2. Signup → first purchase
3. Login → saved card → purchase
4. Refund request

Each asserts the **side effect**, not just the confirmation page. A journey that ends on a
confirmation screen with no order row has not succeeded.

## 5. Browser testing

We standardise on **Playwright**. Do not introduce a second browser framework.

The agent chooses its method through `engine/browser-decision/matrix.json`. Our expectations:

- New or unfamiliar UI → explore first. Never write selectors for a screen nobody opened.
- Recurring critical flow → the exploration must leave a committed spec behind.
- CI gates are **always** deterministic scripts. Agent sessions are not reproducible and
  cannot gate a merge.
- Production is never a target for exploratory browsing.

## 6. Environments

| Name | Class | Safe for writes | Notes |
| --- | --- | --- | --- |
| `local-docker` | non-production | yes | Compose stack; disposable database |
| `staging` | non-production | yes | Stripe test mode; **shared** — announce load tests |
| `production` | production | **no** | Read-only, and only with a named person's authorisation |

Environments not listed here are **unknown**, which the authorization policy treats as
production. Add an environment to this table before pointing anything at it.

## 7. Test data

- Stripe documented test cards only.
- Synthetic personal data. **Never** a production dump, even in staging — a staging leak is
  still a leak.
- Unique identifiers per run (`user-${Date.now()}@example.test`) so parallel runs do not
  collide.
- Deterministic values. Nothing seeded from `Math.random()`.

## 8. What the agent may and may not do

**May, without asking:** read anything; run the test suites; write test files; run `npm
audit`; query the disposable database; explore `local-docker` in a browser.

**Must ask, every time:** create or comment on a GitHub issue; comment on a Jira ticket;
update the testing log; run a load test; scan a deployed host.

**Never, regardless of who asks in passing:** merge a PR; close an issue; transition a Jira
ticket; force push; touch the production database; execute a payment; run a deployment; pick
an assignee.

Encoded in `engine/authorization/policy.json`. The list above is the human-readable version;
the JSON is what enforces it.

## 9. Evidence standard

A claim that something passed requires execution evidence: command output, a test report, a
trace, a coverage report, a scan result, a database snapshot. Screenshots corroborate; they
do not certify.

Every reported result carries the commit, the environment and the command. A result missing
any of the three cannot be re-run by anyone else.

**Target false-confidence rate: 0.** Anything above it is treated as a defect in the report,
not a metric to improve gradually.

## 10. Flaky tests

- Never labelled flaky on fewer than three runs at the same commit.
- A flaky test is fixed or quarantined **explicitly**, with a `test-quality-issue` finding.
  It is never retried into green and left alone.
- A quarantined test is visible. A retried one is not — that is the whole difference.

## 11. Known gaps

Stated here rather than discovered repeatedly:

- No performance targets exist for any endpoint. Performance testing is therefore not
  applicable, and that is a decision we should revisit, not a coverage win.
- No support matrix, so cross-browser scope is undefined. We test Chromium and Firefox.
- No i18n. Localisation testing is not applicable until that changes.
- Rollback compatibility is checked manually per migration. It should be in CI.

## 12. Review

Reviewed each quarter, or whenever `ast metrics` shows `false_confidence_rate > 0` or
`authorization_compliance < 1` — both of which mean something in this document was not
followed.
