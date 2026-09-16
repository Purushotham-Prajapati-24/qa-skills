---
name: defect-reporting
description: Turn a test failure or observation into an actionable defect report — reproduction steps, expected versus actual, severity, impact, evidence, confidence, and a GitHub or Jira issue that a developer can act on without asking questions. Use when a real defect is found, when writing up a bug, or when deciding whether a finding is worth filing at all.
when_to_use: "write up this bug", "create a GitHub issue for this", "report this defect", "is this worth filing"
allowed-tools: Read, Glob, Grep, Bash, PowerShell
metadata:
  system_version: 0.5.0
  role: specialist
---

# Defect Reporting

A good report answers every question the developer would have asked. A bad one costs them
an hour and costs you their trust in every future report.

## Before writing anything: is it a defect?

```bash
node bin/ast.mjs failure classify --json '{"signals":["assertion-mismatch","http-500"],"evidenceIds":["EV-2026-00021"]}'
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

## Record it

```bash
node bin/ast.mjs finding add --input finding.json
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
node bin/ast.mjs finding promote FIND-00001 --authorised --quote "yes, open a GitHub issue"
```

`may_file: false` — stop and read the blockers:

- duplicate fingerprint → comment on the existing issue
- already written and confirmed in the ledger
- no explicit user authorisation **in this session**
- kind is `observation` — observations go in the report, not the tracker

Warnings do not block but change the content: confidence below 0.6 must **lead** the issue
body with the uncertainty; unverified reproduction must be stated plainly.

## Filing

```bash
node bin/ast.mjs finding render FIND-00001    # title, body, labels
node bin/ast.mjs write check   --json '{"system":"github","action":"github.create_issue","idempotencyKey":"<fingerprint>"}'
# create the issue via the resolved provider, then:
node bin/ast.mjs write record  --json '{"system":"github","action":"github.create_issue","idempotencyKey":"<fingerprint>","target":"owner/repo","confirmed":true,"resultId":"#412","url":"…","authorisedBy":"user-explicit"}'
```

`confirmed: true` **only** when the provider returned an identifier. Otherwise
`confirmed: false` with the error — the report will print `NOT CONFIRMED`, which is the
correct outcome.

**Assignment:** never choose the person. Not from CODEOWNERS, not from `git blame`. The
user names the account, or it stays unassigned and you tell them the candidates.

## Low-confidence findings

Sometimes worth reporting. Always worth labelling:

> **Reported with low confidence (0.4).** This may not be a defect. I saw the stale price
> once in 5 attempts and could not reproduce it deterministically. Filing it because the
> failure mode — a customer charged a different price than displayed — would be serious if
> real. Alternative explanation not excluded: a stale cache in my browser session.

That is a useful report. "There might be a caching bug somewhere" is not.
