---
name: unit-testing
description: Write, run and assess unit and component tests — the repository's existing framework and conventions, meaningful assertions, boundary and negative cases, test doubles, determinism and coverage interpretation. Use when unit-level testing is applicable, when adding tests for changed functions or components, or when assessing whether existing unit tests are actually worth anything.
when_to_use: "write unit tests", "run the unit suite", "is this covered by tests", "add tests for this function"
allowed-tools: Read, Glob, Grep, Bash, PowerShell, Write, Edit
metadata:
  system_version: 0.5.0
  role: specialist
---

# Unit and Component Testing

The cheapest, fastest, most diagnostic level. Almost always applicable, and almost always
where a change-aware plan should start.

## Match the repository first

```bash
cat package.json | grep -A5 '"scripts"'
ls vitest.config.* jest.config.* pytest.ini tox.ini 2>/dev/null
```

Then read two or three existing tests. Copy their structure, naming, assertion style and
fixture usage. A test that ignores local convention gets deleted by whoever maintains it.

## Run the existing suite before writing anything

```bash
node bin/ast.mjs exec start --json '{"goal":"Baseline the existing unit suite","method":"existing-suite","testCategory":"unit","command":"npm test","environment":"local"}'
npm test
```

You need a baseline. Without it you cannot tell whether a failure is yours.

## What to test

Test the **contract**, not the implementation. A test coupled to internals breaks on every
refactor and teaches the team that red means "ignore it".

For each changed function or component:

| Case | Example |
| --- | --- |
| Happy path | Valid input → expected output |
| Boundaries | 0, 1, max, max+1, empty, single-element |
| Negative | Invalid type, missing field, malformed input |
| Errors | Does it throw or return the right error, with a useful message? |
| Edge semantics | Null vs. undefined vs. empty string; timezone; float rounding |
| Idempotence | Calling twice — does that matter here? |

For components: render and assert what a **user** would see — text, roles, enabled state.
Not internal state, not prop plumbing.

## Assertion quality

This is the whole game. A test that exercises code without asserting anything meaningful
is not coverage, it is a coverage *number* — worse than nothing because it creates false
confidence.

| Weak | Strong |
| --- | --- |
| `expect(result).toBeDefined()` | `expect(result.total).toBe(1250)` |
| `expect(() => f()).not.toThrow()` | `expect(f()).toEqual({ status: 'ok', id: 'ORD-1' })` |
| `expect(spy).toHaveBeenCalled()` | `expect(spy).toHaveBeenCalledWith({ amount: 1250, currency: 'GBP' })` |
| `expect(list.length).toBeGreaterThan(0)` | `expect(list.map(x => x.id)).toEqual(['a','b'])` |

## Test doubles

Mock the **boundary**, not your own logic. Mock the HTTP client, not the service that uses
it. Over-mocking produces tests that pass while the system is broken — the most expensive
kind of green.

- Stub network, filesystem, clock and randomness.
- Do not stub the thing under test.
- Prefer a real in-memory implementation over a mock where one exists.
- Freeze time explicitly rather than tolerating drift.

## Determinism

Non-deterministic unit tests are a bug in the test. No real network, no real clock, no
unseeded randomness, no dependence on test ordering, no shared mutable module state.

## Coverage

A number, not a goal. 100% line coverage with weak assertions proves nothing; 60% with
sharp assertions on the risky paths is better.

Useful question: **do any existing tests execute the changed lines?** That is
`coverage_deficit` for the risk engine, and it is answerable precisely.

```bash
npx vitest run --coverage --changed
```

## Evidence

```bash
node bin/ast.mjs evidence add --json '{
  "kind":"test-report","summary":"vitest: 91 passed, 0 failed","epistemicClass":"observed",
  "executionId":"EXEC-2026-00002","artifactPath":"coverage/coverage-summary.json","mediaType":"application/json"
}'
node bin/ast.mjs exec finish EXEC-2026-00002 --input result.json
```

Attach per-test results with `validates_requirements` so traceability works.

## When a new test fails first time

More often a test defect than a product defect. Check your assumptions, the fixture setup
and the import path before writing a defect report. Classify it:

```bash
node bin/ast.mjs failure classify --json '{"signals":["assertion-typo"],"evidenceIds":["EV-2026-00009"]}'
```

And never adjust product code to make your new test pass.

## No test infrastructure at all

Do not scatter tests into a repository with no harness. Establish one first — the smallest
setup that runs, wired into the repository's package scripts — and raise it as a
`coverage-gap` finding. Then add tests for the riskiest changed behaviour only, so the
first PR is reviewable.
