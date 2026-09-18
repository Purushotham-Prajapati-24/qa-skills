---
name: integration-testing
description: Test how components work together — database access, queues, caches, external service boundaries, contracts, concurrency, resilience and fault injection, observability, infrastructure and CI/CD configuration, deployment and rollback. Use when a change crosses a module or system boundary, when integration points are involved, or when unit tests pass but the assembled system is suspect.
when_to_use: "integration tests", "test the service boundary", "does this work end to end internally", "test the queue/cache", "resilience testing", "test the CI config"
allowed-tools: Read, Glob, Grep, Bash, PowerShell, Write, Edit
metadata:
  system_version: 0.8.0
  role: specialist
---

# Integration Testing

Unit tests prove the pieces. Integration tests prove the seams — which is where most
real defects live, because the seams are where two people's assumptions meet.

## Scope covered here

Integration · contract · caching · concurrency · resilience / fault injection ·
observability · logging and monitoring validation · infrastructure and configuration ·
CI/CD validation · deployment and rollback.

## Decide the boundary first

| Boundary | Real or double? |
| --- | --- |
| Your own modules | Real. That is the point. |
| Your database | Real, disposable. An in-memory substitute has different semantics and hides real bugs. |
| Queue / cache | Real if containerisable, otherwise a faithful fake. |
| Third-party API | Double by default. Real only against a documented sandbox, with authorisation. |
| Payment / email / SMS | **Always** double, unless the user explicitly authorises a sandbox. |

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" caps resolve container.run
docker compose -f docker-compose.test.yml up -d
```

## Contract testing

When another team or customer consumes your API, the contract is the thing worth testing.

- Schema present (OpenAPI/GraphQL/proto)? Assert responses **validate against it**, not
  against hand-written expectations that will drift.
- No schema? Capture current responses as approved snapshots and diff future runs — then
  raise the absence of a schema as a `documentation-gap` finding.
- Breaking-change checks: removed field, narrowed type, new required request field,
  changed error shape, changed status code. These are the five that break consumers.

## Caching

Cache bugs are invisible until they are catastrophic. Test:

- Miss → populate → hit returns the same value.
- Invalidation actually invalidates, including on the paths the author forgot.
- TTL expiry behaves as configured.
- Stale-while-revalidate does not serve stale data past its window.
- **Cache keys do not collide across tenants or users.** This is a data-leak class bug and
  deserves a security-level look.

## Concurrency

- Two writers on the same row → last-write-wins, or a proper conflict?
- Idempotency keys actually deduplicate under simultaneous requests.
- Optimistic locking rejects the stale write.
- Transaction boundaries hold: a failure mid-way leaves nothing partially applied.

Run the racing calls genuinely in parallel. Sequential calls do not test concurrency.

## Resilience / fault injection

Only where a mechanism exists and only in an isolated environment. Inject: upstream 5xx,
upstream timeout, connection refused, slow response, malformed response, partial failure
of a batch.

Assert on behaviour, not absence of a crash: does it retry with backoff, does it fall
back, does it fail closed where safety demands it, and does it **surface a useful error**?

## Observability and logging

Undertested nearly everywhere, and the reason incidents take hours.

- Errors are logged with enough context to diagnose — request ID, user ID, operation.
- **No secrets or personal data in logs.** Grep the captured output; this is a real and
  common defect.
- Metrics increment on the paths they claim to measure.
- Trace context propagates across the boundary.

## Infrastructure and configuration

- Does the container build, and does the app start inside it?
- Does the app start with the documented **minimum** environment? (Missing-variable
  handling is usually untested and usually bad.)
- `terraform plan` / `helm template` parse and produce the expected shape.
- Are secrets injected rather than baked into an image?

## CI/CD validation

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" caps resolve ci.read_runs
gh run list --limit 10
gh run view <id> --log-failed
```

- Does CI actually run the tests, or just install dependencies?
- Does a failing test actually fail the build? (Check for `|| true` and `continue-on-error`
  — both silently disable a gate.)
- Are the gates on the branch what the team believes they are?

## Deployment and rollback

Non-production only, explicit authorisation, never against production.

- Does the deploy succeed from a clean state?
- Health checks report honestly — a health check that returns 200 unconditionally is
  worse than none.
- Does rollback restore the previous version **and** leave data consistent? Forward-only
  migrations make rollback a data problem, not a deploy problem — test that explicitly.

## Evidence

Container logs, command output, database snapshots before and after, HTTP exchanges,
metric samples, CI run URLs. Command output and database snapshots are execution evidence;
container logs on their own are corroborating.

## Common mistakes

- Mocking so much that only the mocks are tested.
- Sharing one database across parallel tests — flakiness disguised as concurrency.
- Asserting "no exception" instead of the actual integrated outcome.
- Testing the retry wrapper without testing that the retry ever succeeds.
- Calling a real third-party API and calling it an integration test. That is a live
  dependency in your CI, and it will break on someone else's schedule.
