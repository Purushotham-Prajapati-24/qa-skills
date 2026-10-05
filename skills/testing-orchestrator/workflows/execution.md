# Workflow: Execution

Goal: run the plan, capture proof, and never report more certainty than you earned.

> **Turn-one rule.** If the target has any API surface at all, your first evidence captures
> must be API-level (`evidence capture -- curl ...`), not browser screenshots. Screenshots
> are corroborating-only and cap claims at INCONCLUSIVE. Plan API-first evidence from the
> start — do not learn this by getting downgraded 30 times.

## The execution contract

Every attempt follows the same three steps. Step 1 happens **before** the work, which is
what makes an interrupted session recoverable.

```bash
# 1. Open the record first
```

`exec.json`:

```json
{
  "goal": "Guest checkout with a test card creates an order",
  "method": "playwright-script",
  "testCategory": "e2e",
  "decisionId": "DEC-00007",
  "command": "npx playwright test checkout --reporter=json",
  "environment": "local-docker",
  "git": {
    "repository": "shop",
    "branch": "feat/checkout",
    "commit": "abc1234"
  }
}
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" exec start --input exec.json

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

`exec start --example` and `exec finish --example` print valid payloads. Four fields matter
more than they look:

- **`feature`** on `exec start` — the id of the `functionality_inventory` item this execution
  exercises (`"feature": "FEAT-login"`). This is how the per-feature coverage floor confirms
  every critical feature was addressed; an execution with no `feature` tag does not count
  toward any inventory item, so a run that proves checkout works but is untagged still reads
  as "checkout untested" at `validate --final`.

- **`target`** on `exec start` — when you test a deployed system over the network, give its
  URL (and `deployed_commit` if the hosting dashboard shows it). The local git commit says
  nothing about what is deployed, and the report says so instead of pinning live-site results
  to your working tree.
- **`junit`** on `exec finish` — a path to the runner's JUnit XML (`node --test
  --test-reporter=junit`, `playwright test --reporter=junit`, Jest, pytest, Vitest). A suite
  run is one execution; without per-test results, 9 passing tests next to 3 failing ones read
  as nothing but FAILED and never reach "What was proven".
- **Goals** — when a goal or criterion is settled, record it:
  `session goal G-01 --criterion 1 --status PASSED --evidence EV-…`. It goes through the same
  evidence gate. Unassessed goals render as "not assessed" in the report.

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

**Multi-line and quote-heavy commands:** Use `--script <file>` to avoid all quoting issues.
Write the command to a file, then pass the file — the CLI dispatches by extension (`.sh` →
bash, `.ps1` → powershell, `.mjs`/`.js` → node, `.py` → python) with `shell: false`, so
no intermediate shell re-tokenizes your quotes.

Bash / Linux / macOS:
```bash
# Write the command to a file
cat > /tmp/ast-probe.sh << 'SCRIPT'
curl -s -X POST "https://api.example.com/register" \
  -H "Content-Type: application/json" \
  -d '{"name":"<img src=x onerror=alert(1)>","email":"test@example.test"}'
SCRIPT

# Execute through the CLI — --script dispatches by extension
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" evidence capture --exec EXEC-2026-00003 \
  --summary "XSS probe on registration name field" --script /tmp/ast-probe.sh
```

Windows / PowerShell:
```powershell
# Write the command to a file
@'
curl -s -X POST "https://api.example.com/register" `
  -H "Content-Type: application/json" `
  -d '{"name":"<img src=x onerror=alert(1)>","email":"test@example.test"}'
'@ | Out-File -Encoding UTF8 "$env:TEMP\ast-probe.ps1"

# Execute through the CLI — --script dispatches by extension
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" evidence capture --exec EXEC-2026-00003 `
  --summary "XSS probe on registration name field" --script "$env:TEMP\ast-probe.ps1"
```

For Node.js scripts (JSON payloads, multi-step API probes):
```bash
# Write the probe script
cat > /tmp/ast-idor-probe.mjs << 'SCRIPT'
const res = await fetch('https://api.example.com/orders/42', {
  headers: { 'Authorization': `Bearer ${process.env.TOKEN_USER_A}` }
});
console.log(JSON.stringify({ status: res.status, body: await res.text() }));
process.exit(res.status === 403 || res.status === 404 ? 0 : 1);
SCRIPT

node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" evidence capture --exec EXEC-2026-00003 \
  --summary "IDOR probe: user A requesting user B order 42" --script /tmp/ast-idor-probe.mjs
```

If a test runner already wrote its own structured report to disk (Playwright's
`results.json`, a coverage summary) and you did not just invoke it yourself, register that
file directly instead:

`evidence.json`:

```json
{
  "kind": "test-report",
  "summary": "playwright: 11 passed, 1 failed",
  "epistemicClass": "observed",
  "executionId": "EXEC-2026-00003",
  "artifactPath": "test-results/results.json",
  "mediaType": "application/json"
}
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" evidence add --input evidence.json
```

Registering an artefact that does not exist on disk is an error, not a warning.

## Order of operations

Run in this order unless there is a reason not to — it front-loads cheap, high-signal
evidence and defers the expensive, fragile work:

1. **Verify the harness runs at all.** A green suite you never executed is worthless.
2. **Existing tests over new ones.** Cheapest reliable evidence — and a floor, not a
   ceiling. A green unit suite does not cover the `e2e`, `api`, `input-validation`,
   `security` or `perf-baseline` categories, nor any inventory feature it never exercises.
   For a repository, start the app and test the running system next. "No running instance"
   is a valid BLOCKED reason only after you tried to start it and recorded why it failed.
3. **Static and dependency analysis.** Seconds, no environment needed.
4. **Unit → integration → API → UI → E2E.** Failures get cheaper to diagnose the lower
   you are in the stack.
5. **Non-functional last.** Performance and load need a settled system and explicit
   authorisation.

Parallelise reads freely (repository analysis, ticket retrieval, coverage inspection).
Never parallelise anything that shares mutable state: a database under test, an external
write, a report version bump.

### The non-functional checkpoint

When all functional testing has a terminal status, **explicitly ask the user** before
proceeding to non-functional testing:

> Functional testing is complete. The following non-functional categories are applicable
> and have not run:
> - `security-testing` (mandatory baseline + deep scan) — needs non-production confirmation
> - `performance-testing` (load/stress) — needs explicit authorisation
> - `accessibility-testing` — ready to run
>
> **Which should I proceed with?**
> (a) All applicable non-functional testing
> (b) Security and accessibility only (skip load)
> (c) Skip all non-functional — record as DEFERRED
> (d) [specific selection]

Do not silently defer non-functional testing to never. The checkpoint ensures it either
runs or is explicitly deferred by the user — never quietly dropped.

The mandatory security baseline (see orchestrator's "Mandatory testing baselines") runs
regardless of this checkpoint when its trigger conditions are met.

## When something fails

Stop. Classify before concluding:

`signals.json`:

```json
{"signals":["assertion-mismatch","stale-test-data"],"evidenceIds":["EV-2026-00007"]}
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" failure classify --input signals.json
```

`next.json`:

```json
{"status":"FAILED","failureClass":"data-failure","remainingWork":["a11y scan"]}
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" decision next --input next.json
```

Signal tokens come from real output — `http-500`, `econnrefused`, `timeout`,
`missing-env-var`, `brittle-selector`, `passed-on-retry`, `stale-test-data`; the full list is
`failure signals`, and an unknown token comes back in `unknown_signals` rather than being
silently ignored. A runner that died or matched nothing before any test ran (wrong path, bad
flag, empty filter) is `harness-invocation-error` / `no-tests-executed`. A static
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

`uncertainty.json`:

```json
{
  "question": "Should payment tests use real provider credentials?",
  "status": "user-input-required",
  "impact": "cannot safely execute a real transaction",
  "affectedScope": [
    "payment-e2e"
  ],
  "blocksCategories": [
    "e2e"
  ],
  "nextAction": "ask the user which environment and credentials to use",
  "owner": "user"
}
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" uncertainty raise --input uncertainty.json
```

`not-run.json`:

```json
{"goal":"Payment E2E","status":"BLOCKED","reason":"...","testCategory":"e2e"}
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" exec not-run --input not-run.json
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
