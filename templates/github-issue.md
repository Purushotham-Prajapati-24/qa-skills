# GitHub issue template

Rendered by `node bin/ast.mjs finding render FIND-00003`. Wording lives in
`engine/defect-engine/index.mjs` so it is versioned with the engine rather than drifting
between sessions.

---

**Title** `[critical] Order is not persisted after a successful payment`

**Labels** `bug` · `severity:critical` · `found-by:agent`

---

## Summary

Payment is captured by Stripe but no order row is created, so the customer is charged with
no record of the purchase.

| Field | Value |
| --- | --- |
| Severity | critical |
| Kind | defect |
| Component | checkout/payment |
| Environment | local-docker |
| Reproducible | always (3 attempts) |
| Commit | `abc1234` |
| Branch | `feat/checkout` |
| Confidence | 0.82 |
| Basis | observed |

## Preconditions

- Cart contains SKU-1001
- Stripe test mode reachable

## Steps to reproduce

1. Go to `/checkout`
2. Enter test card `4242 4242 4242 4242`
3. Click **Pay now**

## Expected result

An order row exists in `orders` with `total_cents = 1250`, and the confirmation page shows
an order number matching `ORD-\d{6}`.

## Actual result

`SELECT count(*) FROM orders` returns 0. The page shows "Something went wrong". The Stripe
dashboard shows charge `ch_3P…` as succeeded.

## Impact

Customer is charged and receives nothing. Requires a manual refund. Affects every card
payment on this branch.

## Evidence

- **EV-2026-00021** (test-report, observed): playwright 0/1 passed — `test-results/results.json`
- **EV-2026-00022** (trace, observed): Playwright trace — `test-results/checkout/trace.zip`
- **EV-2026-00023** (database-snapshot, observed): `orders` row count before and after

## Recommended next action

Check the transaction boundary in `src/orders/create.ts:88` — the insert appears to be
outside the committed transaction.

---

Filed by the Autonomous Software Testing agent — finding `FIND-00003`, session
`SESSION-0031`, skill v0.5.0.
Fingerprint: `sha256:…` (used to prevent duplicate filings).

---

## Low-confidence variant

When confidence is below 0.6, the body **leads** with this and the Uncertainty section is
mandatory:

> **Reported with low confidence (0.40).** This may not be a defect. See "Uncertainty"
> below before acting.

## Uncertainty

- Reproduction has not been independently verified (observed once in 5 attempts).
- Agent confidence is 0.40; alternative explanations have not been excluded — a stale
  browser cache in the testing session would produce the same symptom.

---

## Rules

1. **No secrets.** Never paste a token, key or credential. Reference the location and the
   kind.
2. **No personal data.** Redact anything from a real dataset.
3. **Evidence or honesty.** No evidence means the body says so, plainly.
4. **No duplicates.** The fingerprint suppresses agent-created duplicates. Search for a
   human-filed one too: `gh issue list --search "<title words> in:title" --state all`.
5. **No assignee the agent chose.** Not from CODEOWNERS, not from `git blame`. The user
   names the account or it stays unassigned.
6. **Never file an `observation`.** Observations belong in the report, not the tracker.
