---
name: e2e-testing
description: Test complete user journeys against a running application — critical paths, cross-page flows, real integration, authentication states and data setup and teardown. Use when a change affects a journey a user completes end to end, when validating a critical business flow, or when pre-release confidence is needed.
when_to_use: "end to end test", "test the whole checkout journey", "test the signup flow", "critical path testing", "pre-release testing"
allowed-tools: Read, Glob, Grep, Bash, PowerShell, Write, Edit
metadata:
  system_version: 0.7.0
  role: specialist
---

# End-to-End Testing

The most realistic and the most expensive. Slow, environment-sensitive, and the first
thing people disable when it flakes. So: few, critical, and rock solid.

For the browser method, defer to the `browser-testing` skill — do not assume Playwright,
and do not assume the agent-driven browser.

## What earns an E2E test

Only journeys where failure is unacceptable:

- The revenue path — checkout, subscribe, upgrade.
- The entry path — signup, login, password reset.
- The core value action — the thing the product exists to do.
- Anything that has broken in production before.

Everything else belongs at a lower level. Ten E2E tests that always pass are worth more
than a hundred that fail twice a week.

## Before writing

Confirm the environment can actually run a journey:

```bash
node bin/ast.mjs caps resolve browser.run_deterministic_test
docker compose -f docker-compose.test.yml up -d
curl -sf http://localhost:3000/health || echo "app not up"
```

If it cannot start, the status is `BLOCKED` — not `FAILED`, and certainly not skipped
quietly.

## Data setup

The most common cause of E2E flakiness is data, not the browser.

- Create what the test needs, via API or fixture — never rely on data that happens to
  exist.
- Unique identifiers per run (`user-${Date.now()}@example.test`), so parallel runs do not
  collide.
- Clean up, or use a disposable environment.
- Never depend on test ordering. Each test stands alone.

## Authentication

Logging in through the UI in every test is slow and makes login a single point of failure
for the whole suite. Authenticate once and reuse storage state; keep **one** test that
logs in through the UI, because that journey matters too.

## Stability rules

| Rule | Why |
| --- | --- |
| No arbitrary sleeps | `waitForTimeout(3000)` is a race you have not lost yet |
| Wait for conditions | Element visible, request settled, URL changed |
| Role/label/test-id locators | CSS paths encode the DOM's current shape |
| Web-first assertions | They retry; manual `await ... textContent()` does not |
| Deterministic time and data | Freeze the clock where the journey depends on it |
| Retry only to *detect* flakiness | Retrying to get green hides the problem |

## Assert the whole outcome

A journey is not verified by the confirmation page alone. Assert the side effects too:

```
✓ Confirmation heading visible
✓ Order number matches /^ORD-\d{6}$/
✓ URL is /orders/ORD-…
✓ An order row exists in the database with the expected total
✓ No console errors were emitted during the journey
```

And assert **negatives** on the failure path: declined card → error shown **and no order
created**. That negative is where payment bugs live.

## Running and evidence

```bash
node bin/ast.mjs exec start --json '{"goal":"Guest checkout, card payment","method":"playwright-script","testCategory":"e2e","decisionId":"DEC-00007","command":"npx playwright test checkout --trace=on --reporter=json","environment":"local-docker"}'
npx playwright test checkout --trace=on --reporter=json
```

Register the JSON report and the trace (execution evidence), plus screenshots and console
output (corroborating). Traces are worth their storage: they are the only artefact that
makes a CI failure diagnosable without reproducing it.

## When it fails

E2E failures are the least trustworthy signal in the stack — there are many ways to fail
that have nothing to do with the product. Classify before concluding:

```bash
node bin/ast.mjs failure classify --json '{"signals":["timeout","element-not-found-after-wait"],"evidenceIds":["EV-2026-00021"]}'
```

Then reproduce at a lower level. If an E2E failure can be reproduced by an API or
component test, **write that test** — it will be faster, clearer, and it will survive.

## Common mistakes

- Using E2E to test validation branches. Slow, fragile, and better covered lower down.
- Hardcoding waits until it goes green.
- Sharing one account across parallel tests.
- Asserting only the URL — pages render error states at the right URL all the time.
- Declaring the journey "works" when only the happy path ran.
