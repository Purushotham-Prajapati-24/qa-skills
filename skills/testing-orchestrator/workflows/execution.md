# Workflow: Execution

Goal: run the plan, capture proof, and never report more certainty than you earned.

## The execution contract

Every attempt follows the same three steps. Step 1 happens **before** the work, which is
what makes an interrupted session recoverable.

```bash
# 1. Open the record first
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" exec start --json '{
  "goal":"Guest checkout with a test card creates an order",
  "method":"playwright-script",
  "testCategory":"e2e",
  "decisionId":"DEC-00007",
  "command":"npx playwright test checkout --reporter=json",
  "environment":"local-docker",
  "git":{"repository":"shop","branch":"feat/checkout","commit":"abc1234"}
}'

# 2a. Preferred: let the CLI run the command and record what actually happened --
#     real exit code, real duration, a hashed artifact on disk. Nothing here can
#     become an unevidenced sentence, because there is no sentence: the CLI ran it.
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" evidence capture --exec EXEC-2026-00003 \
  --summary "Playwright checkout suite" -- npx playwright test checkout --reporter=json

# 2b. Only when the evidence is a file a DIFFERENT process already produced (a CI job's
#     artifact, a report written by a run you invoked some other way) -- register that
#     file directly. This is the fallback, not the default: prefer 2a whenever you are
#     the one about to run the command.
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" evidence add --input evidence.json

# 3. Close the record with the claimed status
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" exec finish EXEC-2026-00003 --input result.json
```

`exec finish` re-checks your claim against the evidence. Claim `PASSED` without execution
evidence and it comes back `INCONCLUSIVE` with the reason attached. Do not fight this —
attach the evidence or accept the downgrade.

## Evidence that counts

| Supports a PASSED/FAILED claim on its own | Corroborates only |
| --- | --- |
| command output, test report, assertion results | screenshots, video |
| trace, HAR | console logs, server logs |
| coverage report, static analysis, dependency scan | network requests, diffs |
| accessibility scan, performance metric, database snapshot | anything a user told you |

A screenshot shows what a page looked like. It does not show that an assertion held.

**Never type a command's output from memory into `evidence add`.** A hand-typed summary
with no artifact behind it is exactly what it looks like — an assertion you made, not proof
you have. Run the command through the CLI instead, so what gets hashed and stored is the
command's real output, not your recollection of it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" evidence capture --exec EXEC-2026-00003 \
  --summary "typecheck" -- npm run lint
```

This spawns the command, hashes its real stdout/stderr to a redacted blob on disk, and
records the real exit code and wall-clock duration — the exact three things a hand-typed
summary cannot honestly provide. A non-zero exit code recorded this way will correctly
block a `PASSED` claim later; there is no way to accidentally omit it.

Windows note: a command containing its own quoting (embedded spaces, quotes) should be
passed as separate argv words after `--`, e.g. `-- npx playwright test "checkout flow"`
rather than one pre-built string — the CLI spawns each word directly rather than asking a
shell to re-split a single string, which is where most quoting mistakes come from.

If a test runner already wrote its own structured report to disk (Playwright's
`results.json`, a coverage summary) and you did not just invoke it yourself, register that
file directly instead:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" evidence add --json '{
  "kind":"test-report","summary":"playwright: 11 passed, 1 failed",
  "epistemicClass":"observed","executionId":"EXEC-2026-00003",
  "artifactPath":"test-results/results.json","mediaType":"application/json"
}'
```

Registering an artefact that does not exist on disk is an error, not a warning.

## Order of operations

Run in this order unless there is a reason not to — it front-loads cheap, high-signal
evidence and defers the expensive, fragile work:

1. **Verify the harness runs at all.** A green suite you never executed is worthless.
2. **Existing tests over new ones.** Cheapest reliable evidence.
3. **Static and dependency analysis.** Seconds, no environment needed.
4. **Unit → integration → API → UI → E2E.** Failures get cheaper to diagnose the lower
   you are in the stack.
5. **Non-functional last.** Performance and load need a settled system and explicit
   authorisation.

Parallelise reads freely (repository analysis, ticket retrieval, coverage inspection).
Never parallelise anything that shares mutable state: a database under test, an external
write, a report version bump.

## When something fails

Stop. Classify before concluding:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" failure classify --json '{"signals":["assertion-mismatch","stale-test-data"],"evidenceIds":["EV-2026-00007"]}'
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" decision next --json '{"status":"FAILED","failureClass":"data-failure","remainingWork":["a11y scan"]}'
```

Signal tokens come from real output — `http-500`, `econnrefused`, `timeout`,
`missing-env-var`, `brittle-selector`, `passed-on-retry`, `stale-test-data`. A static
review or a dependency scan has no runtime output to draw a signal from — use
`advisory-in-range`, `missing-auth-check`, `hardcoded-secret` or `policy-violation`
instead of leaving `signals` empty, which routes to `unclassified-no-signals` regardless
of how solid the underlying finding is. The classifier deliberately lets non-product
causes outrank `product-defect` on a tie: filing a false defect costs more than
investigating one more environment issue.

Then act on the classification:

| Class | Do |
| --- | --- |
| product-defect | Raise a finding. **Never** change product code to make the test pass. |
| test-defect | Fix the test, re-run, record both runs. Not a product signal. |
| environment-defect / infrastructure | `BLOCKED`, not `FAILED`. Continue elsewhere. |
| flaky-test | Re-run ≥3 times at the same commit before using the word. |
| authentication-failure | Product defect or missing credentials? Opposite conclusions — get evidence. |
| timeout | Time a known-good path in the same run to separate slow env from regression. |
| ambiguous-requirement | Raise an uncertainty. Do not invent the expected behaviour. |
| unclassified-no-signals | You gave the classifier nothing to work with — supply real signal tokens from the actual output, or a static-analysis signal (`advisory-in-range`, `missing-auth-check`, `hardcoded-secret`, `policy-violation`) if this is a security-testing/dependency-scan finding rather than a runtime failure. Not a verdict on the finding itself. |

## When something blocks

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" uncertainty raise --json '{
  "question":"Should payment tests use real provider credentials?",
  "status":"user-input-required",
  "impact":"cannot safely execute a real transaction",
  "affectedScope":["payment-e2e"],
  "blocksCategories":["e2e"],
  "nextAction":"ask the user which environment and credentials to use",
  "owner":"user"
}'
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" exec not-run --json '{"goal":"Payment E2E","status":"BLOCKED","reason":"...","testCategory":"e2e"}'
```

Then **keep going**. Run the unit suite, mock the provider at the API boundary, inspect
the implementation, prepare the deterministic test for later. Record what you did anyway:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" uncertainty partition --input scenarios.json
```

## Writing tests

When the plan calls for new automated tests, read the repository's existing tests first
and match them. Specifics in the relevant specialist skill; the universal rules:

- Reuse existing fixtures, factories and helpers. Do not invent a parallel harness.
- Assert on behaviour a user or caller would notice, not on implementation detail.
- No arbitrary sleeps. Wait for a condition.
- No brittle selectors. Prefer roles, labels and test IDs over CSS paths.
- One reason to fail per test, and a failure message that says what went wrong.
- **Never weaken product behaviour, configuration or an assertion to get green.** A
  failing test that reflects a real defect is the deliverable.

## Interruptions

If the user interrupts, or a tool dies mid-run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" session interrupt --kind user --note "user asked to stop and look at the API instead"
```

The open execution stays open. On resume, recovery marks it `INTERRUPTED` — never
`PASSED`, never silently dropped.

→ Next: [reporting.md](reporting.md)
