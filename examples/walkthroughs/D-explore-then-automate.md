# Walkthrough D — Explore the UI for bugs, then create regression tests

> **This is an illustrative walkthrough, not a record of a real run.** IDs, outputs and
> findings are invented to show the shape of the process. Nothing here is evidence of
> anything. Real runs produce records under `state/`.

**The reference pattern.** When a UI is unfamiliar and the scenario will recur, explore to
learn and script to assert. This is the example the browser decision engine is built around.

---

## User

> Explore the checkout flow for UI bugs and create regression tests for anything worth
> keeping.

## 1. Orient

```bash
node bin/ast.mjs session resume
```

```json
{ "recoverable": false, "reason": "No session state on disk." }
```

New session.

```bash
node bin/ast.mjs caps probe
node bin/ast.mjs caps declare mcp-playwright true --note "browser_navigate/browser_snapshot/browser_click present in tool list"
```

```
playwright-cli   available   Version 1.49.1
mcp-playwright   available   agent-declared
gh-cli           available   Logged in to github.com
mcp-google-drive unknown     NOT DECLARED -- treat as unavailable
```

Google Docs is unavailable. The testing log will fall back to `state/reports/`, and the
report will say so.

## 2. Discover what already exists

This is the step that most often changes the answer, so it comes before any decision.

```bash
ls e2e/ && cat playwright.config.ts
grep -rn "checkout" e2e/
```

```
e2e/auth.spec.ts
e2e/cart.spec.ts
e2e/checkout.spec.ts        <- exists
e2e/fixtures.ts             <- reusable fixtures: testCart, authedPage
```

`e2e/checkout.spec.ts` covers a guest card payment happy path. Nothing covers the saved-card
branch, the declined path, or the postcode validation the diff touched.

**Existing coverage: partial.** That single fact removes "just run the existing tests" as a
complete answer, and it also removes "write everything from scratch".

## 3. Decide the method

```bash
node bin/ast.mjs browser decide --input browser-factors.json
```

Factors, each justified from what step 2 established:

| Factor | Value | Why |
| --- | --- | --- |
| `ui_known` | 0.2 | The changed flow has not been opened |
| `repeatability` | 0.85 | Checkout is exercised every release |
| `exploratory_value` | 0.8 | Requirements do not describe the new interaction |
| `business_criticality` | 0.95 | Only revenue path |
| `existing_automation` | 0.35 | Happy path only |
| `ci_suitability` | 0.6 | Should end up in CI, but not as a gate today |
| `environment_stability` | 0.7 | Local Docker, stable |

```json
{
  "selected": "hybrid",
  "confidence": 0.77,
  "margin": 0.2085,
  "reason": [
    "exploratory_value=0.8 >= 0.55 and repeatability=0.85 >= 0.55: the behaviour must be discovered before it can be asserted, and it will be re-run often enough to justify committing a script afterwards.",
    "Hard rule \"no-script-for-unknown-ui\" removed [playwright-script]: Writing selectors for a UI nobody has looked at produces brittle tests that encode guesses. Explore first."
  ],
  "policy_ref": "browser-decision.matrix@1.0.0"
}
```

Note what happened: writing a script *directly* was **removed by a hard rule**, not
out-scored. And pure exploration scored 0.53 against hybrid's 0.74 — because it leaves
nothing behind for a flow that runs every release.

```bash
node bin/ast.mjs decide --input decision.json      # -> DEC-00007
```

## 4. Explore (DISCOVER)

```bash
node bin/ast.mjs exec start --json '{"goal":"Explore the changed checkout flow","method":"playwright-mcp","testCategory":"exploratory","decisionId":"DEC-00007","environment":"local-docker"}'
```
→ `EXEC-2026-00004`

Working through `skills/browser-testing/playwright-mcp.md`: navigate, **snapshot the
accessibility tree first** (cheaper and more precise than a screenshot, and it yields real
element references), walk the happy path, then attack the edges.

What the session surfaced:

1. The saved-card selector only appears when a card exists — so the test needs a fixture
   that creates one.
2. Postcode validation fires on blur, not on submit.
3. **Double-clicking "Pay now" fires two `POST /api/orders`.** Console clean; network tab is
   where it shows.
4. The declined-card path shows a generic "Something went wrong" rather than the decline
   reason.

Items 3 and 4 are the reason exploration was worth doing. Neither is visible from the code
diff, and neither would have been asserted by a test written blind.

```bash
node bin/ast.mjs evidence add --json '{"kind":"network-request","summary":"Two POST /api/orders fired from one double-click on Pay now","epistemicClass":"observed","executionId":"EXEC-2026-00004","artifactPath":".playwright-mcp/double-submit.har"}'
node bin/ast.mjs evidence add --json '{"kind":"screenshot","summary":"Declined card shows generic error, no decline reason","epistemicClass":"observed","executionId":"EXEC-2026-00004","artifactPath":".playwright-mcp/declined-generic.png"}'

node bin/ast.mjs exec finish EXEC-2026-00004 --json '{"status":"COMPLETED","statusReason":"Mapped 4 states of the changed checkout flow; 2 candidate defects observed.","evidence":["EV-2026-00014","EV-2026-00015"]}'
```

Status is `COMPLETED`, not `PASSED`. The exploration happened; it asserted nothing.

## 5. Decide what is worth keeping (STABILIZE)

```bash
node bin/ast.mjs browser should-automate --json '{"factors":{"repeatability":0.9,"business_criticality":0.95,"environment_stability":0.7,"expected_runtime_minutes":4}}'
```

```json
{ "automate": true,
  "reason": "Scenario is repeatable, valuable, stable and fast enough to earn a permanent place in the suite.",
  "policy_ref": "browser-decision.matrix@1.0.0#script_conversion" }
```

The double-submit scenario passes all four checks. A one-off curiosity would not have, and
would correctly stay unautomated.

## 6. Write the script (AUTOMATE)

Read `e2e/checkout.spec.ts` and `e2e/fixtures.ts` first, and match them. Reusing `testCart`
rather than inventing a parallel harness is what makes the difference between a test that
survives and one that gets deleted.

```ts
// e2e/checkout-double-submit.spec.ts
import { test, expect } from './fixtures';

test('double-clicking Pay now creates exactly one order', async ({ page, testCart, api }) => {
  await testCart.addItem('SKU-1001');
  await page.goto('/checkout');
  await page.getByRole('textbox', { name: 'Email' }).fill('guest@example.test');
  await page.getByRole('textbox', { name: 'Postcode' }).fill('SW1A 1AA');

  const pay = page.getByRole('button', { name: 'Pay now' });
  await pay.dblclick();

  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
  // The assertion that matters: the side effect, not the page.
  expect(await api.countOrdersFor('guest@example.test')).toBe(1);
});
```

## 7. Run it (REGRESS)

```bash
node bin/ast.mjs exec start --json '{"goal":"Double-click on Pay now creates exactly one order","method":"playwright-script","testCategory":"e2e","decisionId":"DEC-00007","command":"npx playwright test checkout-double-submit --trace=on --reporter=json","environment":"local-docker"}'

npx playwright test checkout-double-submit --trace=on --reporter=json
```

```
1 failed
  expected 1, received 2
```

The test fails — which is the correct outcome. A regression test that was never seen to fail
proves nothing.

```bash
node bin/ast.mjs evidence add --json '{"kind":"test-report","summary":"playwright: 0/1 passed — expected 1 order, received 2","epistemicClass":"observed","executionId":"EXEC-2026-00005","artifactPath":"test-results/results.json"}'
node bin/ast.mjs evidence add --json '{"kind":"trace","summary":"Playwright trace, double-submit","epistemicClass":"observed","executionId":"EXEC-2026-00005","artifactPath":"test-results/checkout-double-submit/trace.zip"}'

node bin/ast.mjs exec finish EXEC-2026-00005 --json '{
  "status":"FAILED",
  "statusReason":"Two orders created from one double-click at commit abc1234.",
  "evidence":["EV-2026-00016","EV-2026-00017"],
  "signals":["assertion-mismatch","data-not-persisted"],
  "testResults":[{"name":"double-clicking Pay now creates exactly one order","status":"FAILED","file":"e2e/checkout-double-submit.spec.ts"}]
}'
```

Classifier returns `product-defect` at confidence 0.70. Next action: *raise a finding; do
NOT modify product code to make the test pass.*

## 8. File it

```bash
node bin/ast.mjs finding add --input finding.json          # -> FIND-00004
node bin/ast.mjs finding promote FIND-00004
```

```json
{ "may_file": false, "blockers": ["Requires explicit user authorisation for this specific action in this session."] }
```

So the agent asks:

> Found a real defect: double-clicking **Pay now** creates two orders and charges twice
> (`FIND-00004`, critical — reproduced 3/3, trace `EV-2026-00017`). The button is not
> disabled on submit and there is no idempotency key on `POST /api/orders`.
>
> Want me to open a GitHub issue for it?

User: *yes, open it*

```bash
node bin/ast.mjs github preflight
node bin/ast.mjs github file-issue FIND-00004 --repo acme/shop --dry-run
node bin/ast.mjs github file-issue FIND-00004 --repo acme/shop --authorised --quote "yes, open it" --decision DEC-00008
```

```json
{ "ok": true, "status": "COMPLETED", "confirmed": true,
  "result_id": "#418", "url": "https://github.com/acme/shop/issues/418",
  "ledger_entry": "sha256:…", "evidence_id": "EV-2026-00019" }
```

`confirmed: true` because GitHub's own response carried an issue number. Had it exited 0
with no number, the status would have been `INCONCLUSIVE` and the report would print
`NOT CONFIRMED` — attempted, not done.

Unassigned. The agent does not choose the person; the adapter refuses without a user-named
account.

## 9. Report

```bash
node bin/ast.mjs report generate --input report-context.json
node bin/ast.mjs validate
```

## What the agent says

> **Explored the checkout flow and left one regression test behind.**
>
> **Proved:** double-clicking **Pay now** creates two orders — `EXEC-2026-00005` at commit
> `abc1234`, trace `EV-2026-00017`, reproduced 3/3. Filed as
> [acme/shop#418](https://github.com/acme/shop/issues/418), unassigned.
> `e2e/checkout-double-submit.spec.ts` is committed and currently **red**, which is correct:
> it will go green when the defect is fixed and stay green afterwards.
>
> **Also observed, not yet proven:** the declined-card path shows a generic error rather
> than the decline reason (`FIND-00005`, minor, confidence 0.5). I have not confirmed
> whether that is deliberate.
>
> **Not tested:** the saved-card branch — it needs a fixture that creates a stored card,
> which does not exist yet. Postcode validation firing on blur rather than submit may be
> intentional; I could not tell from the code.
>
> **Note:** the external testing log was not updated — no Google Docs capability is
> available in this session. The record is in `state/reports/REPORT-2026-00003.md`.
>
> **Recommended next:** add the saved-card fixture, then I will cover that branch too.

## Why MCP first, then a script

| Step | Method | Because |
| --- | --- | --- |
| Discover | Agent-driven session | The flow had not been opened. Selectors written first would have been guesses — and neither the double-submit nor the generic error was visible in the diff. |
| Assert | Committed script | Reproducible, runs in CI, produces a trace, and survives after this conversation ends. |

Exploration alone would have left nothing behind. A script alone would have encoded
assumptions about a UI nobody had looked at. The hybrid is not a compromise — it is the
correct sequence.
