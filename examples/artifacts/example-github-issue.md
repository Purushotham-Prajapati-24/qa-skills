<!--
GENERATED ARTEFACT — illustrative example.

Produced by `node scripts/demo-session.mjs`, which drives the engines through a
simulated session. The software described does not exist and no real testing occurred.
It is included so you can see the exact shape the system produces, rather than a
hand-written approximation of it.
-->
# [critical] Saved card belonging to another user is selectable and chargeable

**Labels:** bug, severity:critical, found-by:agent, kind:security-issue

---


## Summary

The payment-method lookup does not compare the record owner to the session user, so any authenticated user can select and charge a card saved by someone else.

| Field | Value |
| --- | --- |
| Severity | critical |
| Kind | security-issue |
| Component | server/payments |
| Environment | local-docker |
| Reproducible | always (3 attempts) |
| Commit | abc1234 |
| Branch | feat/SHOP-412-saved-card |
| Confidence | 0.86 |
| Basis | observed |

## Preconditions

- User A and user B both exist
- User B has a saved card

## Steps to reproduce

1. Authenticate as user A
2. Request GET /api/payment-methods/<user B's card id>
3. Observe the response

## Expected result

403 Forbidden, or 404 if the design hides existence

## Actual result

200 OK with user B's card brand, last4 and billing postcode

## Impact

Any authenticated user can enumerate and charge other users' stored cards. Financial and personal data exposure.

## Evidence

- **EV-2026-00002** (command-output, observed): api: 11/12 passed, 1 failed — `C:\Users\purus\AppData\Local\Temp\ast-demo-wXn3KG\evidence\blobs\output-2026-09-18T09-38-21-523Z-62516.txt`

## Recommended next action

Add an ownership check in server/payments/stripe.ts:52 before returning or using a payment method.

## Related requirements

- REQ-3

---

Filed by the Autonomous Software Testing agent — finding `FIND-00001`, session `SESSION-0001`, skill v0.8.0.
Fingerprint: `sha256:8e75ed09c720ff3b2d0d11c070217e76cd94e69c7cf0f2993e59016addb1f112` (used to prevent duplicate filings).
