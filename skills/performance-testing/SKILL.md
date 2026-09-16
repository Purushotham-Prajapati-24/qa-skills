---
name: performance-testing
description: Measure and test performance — latency, throughput, load, stress, spike and endurance testing, plus frontend performance — against stated requirements and a measured baseline. Use when a change affects a performance-sensitive path, when latency or throughput requirements exist, or when performance testing is explicitly requested.
when_to_use: "performance testing", "load test", "is this fast enough", "stress test", "why is this slow", "check for a performance regression"
allowed-tools: Read, Glob, Grep, Bash, PowerShell, Write, Edit
metadata:
  system_version: 0.6.0
  role: specialist
---

# Performance Testing

Two hard prerequisites. Without either, stop and get it.

1. **A target.** "Fast" is not testable. `p95 < 300ms at 100 rps` is. If no target exists,
   raise a `requirement-ambiguity` uncertainty — do not invent one.
2. **A baseline measured in the same session.** A single number means nothing. A number
   compared to a baseline measured minutes earlier on the same machine means something.

## Authorisation

Load traffic is indistinguishable from an attack. Stress, spike and endurance tests need
explicit authorisation **and** an isolated non-production target.

```bash
node bin/ast.mjs auth check --json '{"action":"load_test.execute","target":"staging","userAuthorised":true,"authorisationQuote":"yes, load test staging"}'
```

Never point load at shared infrastructure without telling whoever owns it.

## The test types

| Type | Question | Shape |
| --- | --- | --- |
| **Latency** | How long does one operation take? | Single user, many iterations |
| **Load** | Does it hold up at expected traffic? | Ramp to expected peak, hold |
| **Stress** | Where does it break, and how? | Ramp past peak until failure |
| **Spike** | Does it survive a sudden surge? | Instant jump, then drop |
| **Endurance / soak** | Does it degrade over time? | Moderate load for hours |

Endurance finds what nothing else does: memory leaks, connection-pool exhaustion, log disk
filling, cache unbounded growth. It is also the one nobody runs.

## Measure properly

**Percentiles, not averages.** An average hides the tail, and the tail is what users
experience. Report p50, p95, p99 and max.

**Discard warm-up.** JIT, connection pools and caches make the first requests
unrepresentative. Ramp, then measure.

**Vary the data.** Hitting one cached ID measures your cache, not your system.

**Watch the client.** A saturated load generator produces numbers about itself.

**Record the environment.** A laptop result does not predict production. Say which
machine, which data volume, which concurrency.

## Frontend performance

Core Web Vitals, measured on a throttled connection and CPU:

| Metric | Good | Usual cause when bad |
| --- | --- | --- |
| LCP | < 2.5s | Unoptimised hero image, render-blocking resources |
| CLS | < 0.1 | Images without dimensions, late-injected banners |
| INP | < 200ms | Long tasks on the main thread |
| TBT | < 200ms | Oversized JavaScript bundle |

Also check bundle size deltas on a change — a 400KB dependency added for one helper is a
finding.

## Interpreting a regression

A slower number is not automatically a regression:

1. Re-measure. Once is noise.
2. Measure the base commit **in the same session, on the same machine**.
3. Check for environmental causes — other processes, thermal throttling, a cold cache.
4. Only then call it a regression, and state the delta with both numbers.

```bash
node bin/ast.mjs failure classify --json '{"signals":["latency-above-baseline"],"evidenceIds":["EV-2026-00061"]}'
```

The classifier caps confidence here deliberately: performance conclusions from one run are
unreliable.

## Evidence

Performance metrics are execution evidence when they include the conditions:

```bash
node bin/ast.mjs evidence add --json '{
  "kind":"performance-metric",
  "summary":"GET /api/orders p95 412ms at 50rps (baseline 180ms at abc1234)",
  "epistemicClass":"observed","executionId":"EXEC-2026-00012",
  "artifactPath":"perf/orders-k6-summary.json","mediaType":"application/json",
  "environment":{"os":"windows","base_url":"http://localhost:3000","ci":false}
}'
```

A number without its conditions is not evidence. Always report: the target, the baseline,
the measured value, the concurrency, the data volume, the environment, and the run count.

## Common mistakes

- Reporting an average and calling it latency.
- Comparing against a baseline from a different machine or a different day.
- Load testing through a browser — you measure the browser.
- Testing against an empty database, then being surprised in production.
- Declaring "no regression" from a single run within noise.
