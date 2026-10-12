---
name: defect-reporting
description: Turn a test failure or observation into an actionable defect report — reproduction steps, expected versus actual, severity, impact, evidence, confidence, and a GitHub or Jira issue that a developer can act on without asking questions. Use when a real defect is found, when writing up a bug, or when deciding whether a finding is worth filing at all.
when_to_use: "write up this bug", "create a GitHub issue for this", "report this defect", "is this worth filing"
allowed-tools: Read, Glob, Grep, Bash, PowerShell
metadata:
  system_version: 0.13.0
  role: specialist
---

# Defect Reporting

A good report answers every question the developer would have asked. A bad one costs them
an hour and costs you their trust in every future report.

## Before writing anything: is it a defect?

`signals.json`:

```json
{"signals":["assertion-mismatch","http-500"],"evidenceIds":["EV-2026-00021"]}
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" failure classify --input signals.json
```

The classifier deliberately ranks non-product causes above `product-defect` on a tie. Rule
out, in this order: infrastructure, environment, test data, configuration, test defect.

Then reproduce. Three attempts, and record the count:

| Attempts | `reproducible` |
| --- | --- |
| 3/3 | `always` |
| 1–2 of 3 | `intermittent` — and say which |
| Observed once, not retried | `once` |
| Not attempted | `unverified` — state this prominently |

An intermittent defect is still worth reporting. Pretending it is deterministic is not.

## Prove it: a repro check that fails today

Reproduction counts say how often you saw it. They do not prove it. A defect claim
(`defect`, `regression`, `security-issue`, `accessibility-violation`, `performance-issue`,
`data-integrity-issue`) is **confirmed** only by an executable check that fails today on the
assertion encoding the bug — and will pass once it is fixed. The engine decides this, not
you:

1. Record the candidate with `finding add` (below). It starts **unverified**.
2. Write the smallest check that encodes the bug: a test asserting the expected behaviour,
   or a script that exits non-zero while the bug is present. Match the repo's test
   conventions; keep it out of the gating suite until fixed (a `bugbash` tag or directory).
3. Run it linked to the finding:

   ```json
   {"goal":"Repro FIND-00001","method":"playwright-script","reproduces":"FIND-00001","test_files":["tests/bugbash/order-persist.spec.ts"],"command":"npx playwright test tests/bugbash/order-persist.spec.ts"}
   ```

   `exec start` → `evidence capture -- <command>` → `exec finish` with `"status":"FAILED"` and
   the **real** failure signals (`"assertion-mismatch"`, `"data-not-persisted"`, …).

If the run you found the bug in already is such a check (an API test that failed on the
assertion), linking the finding with `executionId` is enough. Nothing more to do.

What does **not** confirm: a failure classified as anything but `product-defect` (a
locator not found or a timeout means the *test* is wrong — fix it and re-run); evidence that
is only your own sentence or `echo FAILED`; a run with no recorded command. If the repro
**passes**, the claim is refuted: reject it as `not-reproduced`, or write a better repro.
If the repro genuinely cannot run (sandbox down), hold it: `exec not-run` with `reproduces`
and a blocking uncertainty.

Check where each finding stands at any time:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" finding verify
```

`validate --final` fails while a `major`+ defect claim is unverified or refuted. Minor ones
are reported as unverified. The report labels every defect **Confirmed** (with its repro
command) or not.

## Triage candidates out — with a citation

Explorers produce false positives. Before writing a repro, rule out the usual ones, and
reject with a reason someone else can check:

| `--class` | When |
| --- | --- |
| `explorer-artifact` | The tool could not do what a user can: new-tab links, lazy-loaded images, hover-only menus |
| `environment` | Local setup, not the product: missing env var, unstarted service, stale build |
| `intended-design` | The behaviour is deliberate — cite the code, spec or ticket that says so |
| `fixture-gap` | The seed or test data does not cover the state you hit |
| `not-reproduced` | A repro check passed |
| `out-of-scope` | Real, but outside what this session was asked to test |

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" finding reject FIND-00004 --class intended-design --reason "Discount applies at the payment step by design" --cite "src/checkout/pricing.ts:88"
```

All three are required. Rejected candidates are listed in the report with their citation,
never silently dropped. Read the source before rejecting — "probably intended" is a guess.

## Record it

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" finding add --input finding.json
```

```jsonc
{
  "title": "Order is not persisted after a successful payment",
  "kind": "defect", "severity": "critical", "confidence": 0.82,
  "epistemicClass": "observed", "component": "checkout/payment", "environment": "local-docker",
  "summary": "Payment is captured by Stripe but no order row is created, so the customer is charged with no record of the purchase.",
  "reproduction": {
    "preconditions": ["Cart contains SKU-1001", "Stripe test mode"],
    "steps": ["Go to /checkout", "Enter test card 4242…", "Click Pay now"],
    "expected": "An order row exists and the confirmation shows ORD-xxxxxx",
    "actual": "Stripe shows a successful charge; `orders` table is empty; UI shows a generic error",
    "reproducible": "always", "attempts": 3
  },
  "impact": "Customer is charged and receives nothing. Requires a manual refund. Affects every card payment on this branch.",
  "evidence": ["EV-2026-00021", "EV-2026-00022"],
  "recommendedAction": "Check the transaction boundary in src/orders/create.ts:88 — the insert appears to be outside the committed transaction."
}
```

Findings are fingerprinted on `(component, normalised title, expected, actual)`, so the
same defect found again in a later session is recognised even if you word it differently.

## Severity

Severity is **impact**, not how annoyed you are.

| Severity | Meaning |
| --- | --- |
| `blocker` | Data loss, security exposure, money wrong, nothing can proceed. **Surface immediately.** |
| `critical` | A core journey is broken with no workaround |
| `major` | Significant function broken; a workaround exists |
| `minor` | Small impact, easy workaround |
| `trivial` | Cosmetic |

A typo in an admin tooltip is `trivial` however much it irritates you. A charge with no
order is `critical` even if it took three attempts to see.

## Expected versus actual

The most-skipped and most-important section.

> **Expected:** an order row exists in `orders` with `total_cents = 1250`, and the
> confirmation page shows an order number matching `ORD-\d{6}`.
> **Actual:** `SELECT count(*) FROM orders` returns 0. The page shows "Something went
> wrong". Stripe dashboard shows charge `ch_3P…` as succeeded.

Not "it doesn't work". Say what you saw, where you saw it, and what you expected instead.

## Should this be filed?

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" finding promote FIND-00001 --authorised --quote "yes, open a GitHub issue"
```

`may_file: false` — stop and read the blockers:

- duplicate fingerprint → comment on the existing issue
- already written and confirmed in the ledger
- no explicit user authorisation **in this session**
- kind is `observation` — observations go in the report, not the tracker
- the defect is not **confirmed** by a failing repro check — prove it first. Only if the
  user explicitly asks for an unverified issue, pass `--allow-unverified`; the rendered
  issue then leads with "Unverified" automatically

Warnings do not block but change the content: confidence below 0.6 must **lead** the issue
body with the uncertainty; unverified reproduction must be stated plainly. A confirmed
issue leads with its repro command, so the developer can watch it go green.

## Filing

**Use the adapter. Do not run `gh issue create` yourself.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" github file-issue FIND-00001 --repo owner/name --dry-run
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" github file-issue FIND-00001 --repo owner/name --authorised --quote "yes, open a GitHub issue"
```

One command runs the whole protocol in order: capability → authorisation → duplicate
ledger → render → perform → parse the provider's response → record → evidence. You cannot
use half of it, and there is no path to a ledger entry that skips a gate.

Start with `--dry-run`. It passes every gate, shows you the exact title, body, labels and
command, and calls nothing.

Read the result's `status`:

| Status | Meaning |
| --- | --- |
| `COMPLETED` + `confirmed: true` | Filed. `result_id` and `url` came from GitHub. |
| `SKIPPED` | Duplicate — the ledger or the fingerprint already has it. |
| `NEEDS_USER_INPUT` | A gate refused. Read `reason` and `required_of_user`. |
| `BLOCKED` | Capability unavailable, or the provider returned 401/403/404/429. |
| `INCONCLUSIVE` | It ran and **no identifier came back**. Attempted, not done. |

`INCONCLUSIVE` is the one to take seriously. A `gh` command can exit 0 having printed a
warning and created nothing, so the adapter derives confirmation by parsing GitHub's own
output for an issue number. No number, no confirmation — and the report prints
`NOT CONFIRMED`.

**Before filing anywhere**, check the token can actually do it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" github preflight
```

Authentication succeeding is not the same as having the `repo` scope. Reads can work while
writes fail.

**Assignment:** never choose the person. Not from CODEOWNERS, not from `git blame`. The
adapter refuses without a user-named account:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" github assign --repo owner/name --number 418 --assignee octocat --authorised
```

**When the capability resolves to an MCP server** rather than the CLI, the adapter cannot
call it — MCP tools live in your tool list, not in Node. It runs the gates, hands you a
ticket and the rendered content, and you finish it:

```bash
# perform the call with your own GitHub MCP tools, then:
```

`response.json` is the provider's raw response, saved unedited. `adapter complete --example`
shows the shape for a GitHub issue. The engine reads the identifier back from GitHub itself,
so an edited or invented response does not confirm anything.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" adapter complete --ticket WT-… --input response.json
```

Nothing is recorded until you do. `ast adapter pending` lists tickets left open.

## Low-confidence findings

Sometimes worth reporting. Always worth labelling:

> **Reported with low confidence (0.4).** This may not be a defect. I saw the stale price
> once in 5 attempts and could not reproduce it deterministically. Filing it because the
> failure mode — a customer charged a different price than displayed — would be serious if
> real. Alternative explanation not excluded: a stale cache in my browser session.

That is a useful report. "There might be a caching bug somewhere" is not.
