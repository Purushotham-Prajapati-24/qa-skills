# Walkthrough C — "Test the new payment feature"

> **Illustrative walkthrough, not a record of a real run.**

The blocked-branch case. A credential is missing; most of the work is still available. This
is the walkthrough to read if you want to see what "never stall on one blocker" means in
practice.

---

## User

> Test the new payment feature.

## 1. Scope it from code, and say so

There is no PR and no ticket reference. So the agent locates the feature and is explicit
about where scope came from:

```bash
git log --oneline -15 | grep -i pay
grep -rln "stripe\|payment" src/ server/ --include=*.ts --include=*.tsx
```

> Scoping from the code and recent commits, not from a diff or a ticket. If there is a PR or
> a Jira ticket for this, point me at it — a description can omit the change that breaks
> things.

That sentence matters: a scope derived from a description is `reported-by-user`, not
`observed`, and the report will class it that way.

## 2. Hit the blocker early

```bash
grep -rn "STRIPE_SECRET_KEY" server/ .env.example
node bin/ast.mjs caps resolve http.request
```

`server/payments/stripe.ts:8` constructs the client from `STRIPE_SECRET_KEY`, which is
**unset** in this environment. No sandbox key, no documented test account.

The wrong move is to stop here. The right move is to record it and carry on:

```bash
node bin/ast.mjs uncertainty raise --json '{
  "question":"Should payment tests use real provider credentials, a sandbox key, or a mock?",
  "status":"user-input-required",
  "impact":"cannot safely execute a real transaction; will not transact against a live key",
  "affectedScope":["payment-e2e","payment-integration"],
  "blocksCategories":["e2e"],
  "nextAction":"ask the user which environment and credentials to use",
  "owner":"user"
}'
```
→ `U-00019`

```bash
node bin/ast.mjs uncertainty partition --input scenarios.json
```

```json
{
  "runnable": 11,
  "blocked": 2,
  "guidance": "11 scenario(s) are unaffected by the 1 open blocker(s). Run those now; do not wait."
}
```

Eleven of thirteen scenarios do not need a Stripe key.

## 3. Run the eleven

| # | What | Result |
| --- | --- | --- |
| 1 | Unit suite baseline | 211/211 at `abc1234` — `EV-2026-00030` |
| 2 | Unit tests for the new `PaymentIntent` builder | Written, 7 cases, all pass |
| 3 | Amount arithmetic at boundaries — 0, 1, max, negative | **Found:** negative amounts are accepted and sent upstream |
| 4 | Currency rounding on 3-decimal currencies (KWD, BHD) | **Found:** hard-coded ×100 produces a 10× error |
| 5 | API tests against a mocked provider at the HTTP boundary | 12/12 pass |
| 6 | Object-level authorisation on `/api/payment-methods/:id` | Passes — ownership is checked |
| 7 | Idempotency: repeated POST with the same key | Passes — no duplicate |
| 8 | Webhook signature verification | **Found:** verified, but a failure is logged and swallowed, returning 200 |
| 9 | Static read of the money type | `Int` cents throughout — correct, worth recording as verified |
| 10 | `npm audit` | 0 exploitable in production paths |
| 11 | Secret scan of source and git history | Clean |

Three real findings, none of which needed a payment provider. The most valuable — the
currency rounding bug — came from a unit test of arithmetic.

```bash
node bin/ast.mjs uncertainty resolve U-00019 --answer "(pending)" 2>/dev/null   # not yet — still open
node bin/ast.mjs exec not-run --json '{"goal":"Payment E2E against the real provider","status":"BLOCKED","reason":"No authorised sandbox credentials; refusing to transact against a live key.","testCategory":"e2e","uncertainties":["U-00019"]}'
```

The blocked work gets a **first-class execution record**, so it appears in the report rather
than vanishing.

## 4. Prepare the blocked work anyway

The E2E spec is written now, so it is ready the moment credentials arrive:

```ts
// e2e/payment.spec.ts — cannot run until STRIPE_SECRET_KEY (test mode) is available
test('a declined card shows the decline reason and creates no order', async ({ page, testCart, api }) => {
  await testCart.addItem('SKU-1001');
  await page.goto('/checkout');
  await page.getByRole('textbox', { name: 'Card number' }).fill('4000000000000002');
  await page.getByRole('button', { name: 'Pay now' }).click();

  await expect(page.getByRole('alert')).toContainText(/declined/i);
  expect(await api.countOrders()).toBe(0);      // the negative assertion is the point
});
```

```bash
node bin/ast.mjs uncertainty raise --json '{"...":"..."}'   # (already raised)
```

And the independent work is recorded against the blocker, which is the evidence the agent
did not stall:

```bash
node bin/ast.mjs uncertainty partition --input scenarios.json
```

## 5. Then ask — once, with context

> **Three defects found without touching a payment provider.**
>
> 1. **Negative amounts are accepted** and forwarded upstream (`FIND-00011`, critical).
>    `buildPaymentIntent` has no lower bound; `amount: -500` produces a valid request.
> 2. **10× overcharge on 3-decimal currencies** (`FIND-00012`, critical).
>    `Math.round(amount * 100)` is hard-coded; KWD and BHD use 1000 minor units.
>    A 1.500 KWD charge becomes 15.000 KWD.
> 3. **Webhook signature failures are swallowed** (`FIND-00013`, major). Verification runs,
>    but on failure it logs and returns 200 — so a forged webhook looks accepted.
>
> **Verified working:** amount is stored as integer cents throughout; object-level
> authorisation on payment methods; idempotency keys prevent duplicate charges (12/12 API
> tests against a mocked provider, `EV-2026-00034`).
>
> **Blocked (`U-00019`):** the real payment journey. `STRIPE_SECRET_KEY` is unset and I will
> not transact against a live key. **Which would you like?**
>
> (a) Give me a Stripe **test-mode** key — I run the full journey including declines.
> (b) Keep the HTTP-boundary mock — covers our logic, not the integration.
> (c) Skip it — I record it as a coverage gap.
>
> `e2e/payment.spec.ts` is already written and will run unchanged under (a).
>
> **Not tested:** 3-D Secure, refunds, and partial captures — no code path for them exists
> yet, so not applicable rather than missing.

## What this walkthrough demonstrates

- **A blocker stopped one branch, not the session.** Eleven of thirteen scenarios ran.
- The blocked scenario got an execution record with status `BLOCKED`, so it is in the report.
- The blocked work was **prepared**, not just deferred.
- The question was asked **once**, at the end, with options and consequences — not the
  moment the credential turned out to be missing.
- The two most serious findings came from unit-level arithmetic tests, which is a good
  argument for running cheap categories before expensive ones.
- 3-D Secure and refunds were declared `NOT_APPLICABLE` with a reason, not silently omitted.
