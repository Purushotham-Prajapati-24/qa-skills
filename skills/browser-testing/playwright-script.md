# Method B — Deterministic browser scripts

For **certification** and **regression**. A committed spec that runs the same way every
time and returns an exit code.

## When

- Stable regression coverage of a known flow.
- CI gates.
- Precise assertions — exact values, DOM state, network calls, timing.
- Parameterised runs across data, viewports or locales.
- Anything that will run more than a handful of times.
- Network interception or stubbing.

## When not

- The UI has not been examined (`ui_known <= 0.25` — the engine forbids it). Explore first.
- One-off investigation.
- The repository already has coverage — run that instead.
- The team uses Cypress/WebdriverIO/Selenium. **Match the repository.** Adding a second
  browser framework is a maintenance tax, not a contribution.

## Before writing anything

Read the existing tests. Match them. Specifically:

```bash
ls e2e tests/e2e cypress/e2e playwright 2>/dev/null
cat playwright.config.* 2>/dev/null
```

- Where do specs live, and what are they named?
- Which fixtures, page objects, factories and helpers already exist? **Reuse them.**
- How is authentication handled — storage state, a fixture, a UI login?
- How is test data created and cleaned up?
- What is `baseURL`, and which projects/browsers are configured?
- Are there existing `data-testid` conventions?

A spec that ignores the repository's conventions will be deleted by the first person who
has to maintain it.

## Quality rules

| Rule | Why |
| --- | --- |
| Assert on user-visible behaviour | Implementation-coupled tests break on refactors and teach people to distrust the suite. |
| Prefer role/label/test-id locators | CSS paths encode the DOM's current shape, which is the thing most likely to change. |
| Never use arbitrary sleeps | `waitForTimeout(3000)` is a race you have not lost *yet*. Wait for a condition. |
| Use web-first assertions | `expect(locator).toHaveText(...)` retries; `expect(await locator.textContent())` does not. |
| One reason to fail per test | A test asserting six unrelated things tells you nothing when it goes red. |
| Independent tests | No shared mutable state, no ordering dependency. Each creates what it needs. |
| Meaningful failure messages | The person reading CI at 6pm is not you and has no context. |
| Fast | Over ~10 minutes and it gets skipped, then deleted. |
| No duplicates | Check whether an existing spec covers this before adding another. |

A test that exercises code without meaningful assertions is not coverage. It is a
coverage *number*, which is worse than none because it creates false confidence.

## Shape

```ts
// e2e/checkout.spec.ts — conventions copied from the repository's existing specs
import { test, expect } from './fixtures';        // reuse, do not re-invent

test.describe('guest checkout', () => {
  test('a card payment creates an order and shows the confirmation', async ({ page, testCart }) => {
    await testCart.addItem('SKU-1001');           // existing helper
    await page.goto('/checkout');

    await page.getByRole('textbox', { name: 'Email' }).fill('guest@example.test');
    await page.getByRole('textbox', { name: 'Postcode' }).fill('SW1A 1AA');
    await page.getByRole('button', { name: 'Pay now' }).click();

    // Web-first assertions: these retry, so no sleeps are needed.
    await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
    await expect(page.getByTestId('order-number')).toHaveText(/^ORD-\d{6}$/);
    await expect(page).toHaveURL(/\/orders\/ORD-\d{6}$/);
  });
});
```

## Running it and capturing evidence

```bash
node bin/ast.mjs exec start --json '{"goal":"Guest checkout creates an order","method":"playwright-script","testCategory":"e2e","decisionId":"DEC-00007","command":"npx playwright test checkout --reporter=json --trace=on","environment":"local-docker"}'

npx playwright test checkout --reporter=json --trace=on

node bin/ast.mjs evidence add --json '{"kind":"test-report","summary":"playwright: 1/1 passed","epistemicClass":"observed","executionId":"EXEC-2026-00005","artifactPath":"test-results/results.json","mediaType":"application/json"}'
node bin/ast.mjs evidence add --json '{"kind":"trace","summary":"Playwright trace for guest checkout","epistemicClass":"observed","executionId":"EXEC-2026-00005","artifactPath":"test-results/checkout/trace.zip"}'

node bin/ast.mjs exec finish EXEC-2026-00005 --input result.json
```

Both the JSON report and the trace are **execution evidence** — either supports a
`PASSED` claim. Screenshots alone do not.

## If it fails

Do not assume a defect and do not touch product code. Classify:

```bash
node bin/ast.mjs failure classify --json '{"signals":["assertion-mismatch","brittle-selector"],"evidenceIds":["EV-2026-00011"]}'
```

A brand-new spec failing first time is more often a test defect than a product defect.
Check your locator and your assumptions before you write a defect report.

## Keeping it alive (EVOLVE)

When the application legitimately changes, update the test to match the new intended
behaviour and record *why* the expectation changed. Never loosen an assertion to make red
go green — that is the single fastest way to turn a test suite into decoration.
