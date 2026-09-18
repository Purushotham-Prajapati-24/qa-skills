---
name: regression-testing
description: Re-run existing tests intelligently against a change — selecting which suites matter, running smoke and sanity checks, detecting flaky tests from run history, distinguishing a new failure from a pre-existing one, and turning fixed defects into permanent regression coverage. Use when validating that a change broke nothing, running the existing suite, or investigating whether a failing test is flaky or real.
when_to_use: "run the regression suite", "did this break anything", "smoke test", "is this test flaky", "add a regression test for this bug"
allowed-tools: Read, Glob, Grep, Bash, PowerShell, Write, Edit
metadata:
  system_version: 0.8.0
  role: specialist
---

# Regression Testing

Running what already exists is the cheapest reliable evidence in testing. Do it before
writing anything new.

## Establish the baseline first

You cannot tell a new failure from an old one without one. Run the suite at the **base**
commit, not just the head:

```bash
git stash && git checkout <base>
npm test          # capture as evidence
git checkout -    && git stash pop
```

If that is impractical, check CI for the last green run on the base branch. If neither is
possible, say so: a failure of unknown vintage is `INCONCLUSIVE`, not a regression.

## Selection

Running everything is sometimes right — a fast suite, a risky change, a release. Often it
is not. Select when the suite is slow and the change is narrow:

| Signal | Include |
| --- | --- |
| Test imports a changed module | Always |
| Test exercises an impacted user-facing behaviour | Always |
| Test covers a high-risk area near the change | Always |
| Whole suite is under ~5 minutes | Just run it all |
| Change touched config, build or CI | Run it all — blast radius is unknowable |
| Test is unrelated by both import graph and behaviour | Skip, and say you skipped it |

Record the selection as a decision. "I ran a subset" without saying which is not a result.

## Smoke and sanity

- **Smoke** — does the system come up and serve its core function at all? Run first;
  everything else is wasted if it fails.
- **Sanity** — does the specific thing that changed do its basic job? Run second, before
  the long tail.

Both should be minutes, not tens of minutes.

## Flakiness

**Never label a test flaky from one failure.** Doing so teaches people to ignore a true
signal, which is the most expensive habit a test suite can create.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" flaky analyse
```

Requires ≥3 recorded runs. Verdicts:

| Verdict | Meaning |
| --- | --- |
| `insufficient-data` | Fewer than 3 runs. Re-run before saying anything. |
| `stable` | All recorded runs passed. |
| `consistently-failing` | All runs failed. **This is a defect signal**, not flakiness. |
| `flaky` | Mixed outcomes **at the same commit** — the code did not change between runs. |
| `outcome-changed-with-code` | Mixed across commits. Bisect; this looks like a real behavioural change. |
| `unstable-cause-unknown` | Mixed, but environments also differ. Control for that first. |

The distinction that matters: *did the code change between the pass and the fail?* If not,
it is the test or its environment. If so, it is probably the product.

## Handling a flaky test

Do not retry until green and move on. In order of preference:

1. Fix the root cause — usually a timing assumption, shared state, or unseeded randomness.
2. If it cannot be fixed now, quarantine it explicitly and raise a
   `test-quality-issue` finding. A quarantined test is visible; a retried one is not.
3. Never delete it without saying so.

A flaky gate is worse than no gate: it gives false confidence **and** trains people to
override red.

## New failure versus pre-existing

```
Fails at head, passes at base  → regression caused by this change
Fails at both                  → pre-existing. Report it, but it is not this change's fault
Passes at head, failed at base → this change fixed something. Say so.
```

Reporting a pre-existing failure as a regression wastes an author's afternoon. Check.

## Turning a fixed defect into coverage

Every defect worth fixing is worth a test that would have caught it. When a finding is
resolved:

1. Write the test **first** and watch it fail against the unfixed code. A regression test
   that was never seen to fail proves nothing.
2. Confirm it passes against the fix.
3. Name it after the behaviour, not the ticket — `rejects a declined card without creating
   an order`, not `test_bug_412`.
4. Link it to the finding so traceability survives.

## Evidence

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" exec start --json '{"goal":"Regression: suites touching checkout and auth","method":"existing-suite","testCategory":"regression","command":"npm test -- checkout auth","environment":"local"}'
```

Attach the run report and per-test results. Recording results over time is what makes
flakiness analysis possible later — a single run tells you nothing about stability.
