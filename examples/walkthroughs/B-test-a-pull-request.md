# Walkthrough B — "Test this pull request"

> **Illustrative walkthrough, not a record of a real run.**

Change-aware testing. The interesting part is how much the agent declines to run.

---

## User

> Test PR #412.

## 1. Establish the diff precisely

```bash
gh pr view 412 --json title,body,files,additions,deletions,baseRefName,headRefName,commits
git merge-base HEAD origin/main      # -> a1b2c3d
git diff --stat a1b2c3d...abc1234
```

```
 server/orders/create.ts        | 88 ++++++++++----
 server/payments/stripe.ts      | 41 ++++---
 src/checkout/PaymentForm.tsx   | 96 +++++++++++++----
 src/checkout/SavedCards.tsx    | 74 +++++++++++++ (new)
 prisma/schema.prisma           |  6 ++
 prisma/migrations/0007_.../    | 12 +++ (new)
 e2e/checkout.spec.ts           |  3 +-
 7 files changed, 312 insertions(+), 44 deletions(-)
```

Base `a1b2c3d`, head `abc1234`. Every result below is only valid for that head, and the
report says so.

## 2. Read the diff, not just the file list

| Hunk | Kind | Implication |
| --- | --- | --- |
| `SavedCards.tsx` (new) | New behaviour | Nothing existing covers it |
| `create.ts` — order insert moved | Behaviour change | Regression risk on the existing path |
| `stripe.ts` — payment-method branch | Behaviour change | Integration + negative paths |
| `schema.prisma` + migration | Schema | Migration, data integrity, **rollback compatibility** |
| `e2e/checkout.spec.ts` — 1 line | Test edit | **Read it.** Was an assertion weakened? |

That last row matters. A test file touched in a feature PR deserves a look:

```bash
git diff a1b2c3d...abc1234 -- e2e/checkout.spec.ts
```

```diff
-  await expect(page.getByTestId('order-number')).toHaveText(/^ORD-\d{6}$/);
+  await expect(page.getByTestId('order-number')).toBeVisible();
```

The assertion was **weakened** — from "matches the order-number format" to "something is
there". That is a finding in its own right (`test-quality-issue`), and it is exactly the
kind of thing that makes a suite go green while the product breaks.

## 3. Map impact

```bash
grep -rn "from '.*orders/create'" server/ src/
grep -rln "createOrder\|SavedCards" src/ server/ e2e/
```

Impacted modules → `checkout/payment`, `orders/create`, `auth/session` (touched indirectly
through the payment-method lookup).

Existing tests that touch them: `server/orders/create.test.ts` (happy path only),
`e2e/checkout.spec.ts` (guest card only).

**Coverage gaps:** the saved-card branch, the declined path through the new branch, the
migration, and rollback compatibility.

## 4. Risk, with the diff as evidence

Every factor below comes from something measured, not estimated:

```bash
node bin/ast.mjs risk score --profile security-critical --explain --input factors.json
```

```
risk_score: 0.8683   risk_level: critical   confidence: 0.4632
  - security_sensitivity: 0.9 × 2   => 1.80  [observed] payment-method lookup reads session identity
  - irreversibility:      0.9 × 1.5 => 1.35  [observed] captures real payments; migration has a lossy down step
  - business_criticality: 1.0 × 1   => 1.00  [observed] only revenue path
  - coverage_deficit:     0.8 × 1.2 => 0.96  [observed] no test exercises the saved-card branch
  - change_magnitude:     0.6 × 0.6 => 0.36  [observed] 312 lines across 7 files
```

`git log --format=%H -- server/payments/ | wc -l` → 31 commits in 6 months, so
`change_frequency` gets evidenced too rather than left unscored.

## 5. What to re-run, write, explore, skip

The four lists the plan is built from:

**Re-run** — `server/orders/create.test.ts`, `e2e/checkout.spec.ts`, the full unit suite
(12s, so selection is not worth the reasoning).

**Write** — saved-card API tests including the negative authorisation case; a migration
test with realistic data; a rollback-compatibility check.

**Explore** — `SavedCards.tsx`. Nobody has opened it. See
[D-explore-then-automate.md](D-explore-then-automate.md).

**Skip, and why** — i18n, cross-browser, load, visual regression. None is touched by this
diff, and each appears in the report's not-applicable table with that reason.

## 6. Execute, and classify what fails

```bash
node bin/ast.mjs exec start --json '{"goal":"Baseline: full unit suite at head","method":"existing-suite","testCategory":"regression","command":"npm test","environment":"local"}'
```

211/211 pass. Then the same suite at **base**, because a failure of unknown vintage is not a
regression:

```bash
git stash && git checkout a1b2c3d && npm test && git checkout - && git stash pop
```

Also 211/211. Now any new failure is attributable.

The API tests find it:

```
FAIL  saved card belonging to another user is not selectable
  expected 403, received 200
```

```bash
node bin/ast.mjs failure classify --json '{"signals":["assertion-mismatch","http-403"],"evidenceIds":["EV-2026-00019"]}'
```

The classifier returns `authentication-failure` at confidence **0.5**, capped, with the
caveat: *ambiguous between a product authorisation defect and missing test credentials*.

So the agent disambiguates before writing a defect report: it re-runs with a deliberately
valid second-user session and confirms the 200 persists. Only then does confidence rise and
the finding get written — as `security-issue`, severity `critical`.

## 7. Migration and rollback

```bash
docker compose -f docker-compose.test.yml up -d db
npx prisma migrate deploy
```

Applies cleanly against seeded data. The check teams usually skip:

> Can the **previous** application version run against the **new** schema?

During a rolling deploy both versions run at once. The migration adds a `NOT NULL` column
with no default, so the old code's `INSERT` fails. That is `FIND-00008`, severity `major` —
a deployment incident rather than a code defect, and invisible to every test that only runs
one version at a time.

## 8. Report

> **PR #412 — FAILED.** 9 executions at `abc1234` against base `a1b2c3d`.
>
> **Critical:** a saved card belonging to another user is selectable and chargeable —
> `FIND-00007`, reproduced 3/3 with two distinct sessions, `EV-2026-00019`.
> `server/payments/stripe.ts:52` looks up the payment method by ID without checking
> ownership.
>
> **Major:** the migration adds a `NOT NULL` column with no default. The previous app
> version cannot insert against the new schema, so a rolling deploy will fail —
> `FIND-00008`.
>
> **Minor:** `e2e/checkout.spec.ts` weakened an assertion from an order-number format check
> to a visibility check (`FIND-00009`). That reduces what the suite detects; worth a look in
> review.
>
> **Passed:** 211 unit tests at both base and head; migration applies cleanly forward
> (`EV-2026-00021`).
>
> **Not tested:** the declined-card path through the new branch — blocked on sandbox
> credentials (`U-00019`). i18n, cross-browser, load and visual regression are not
> applicable to this diff and are listed with reasons.
>
> **Recommended next:** the ownership check on `stripe.ts:52` before anything else.

Nothing was filed to GitHub — no authorisation was given. The agent offers, once, at the end.

## What this walkthrough demonstrates

- The diff produced **evidence** for risk factors rather than estimates.
- Base and head were both baselined, so "regression" means something.
- A capped-confidence classification triggered **disambiguation** rather than a defect report.
- A weakened assertion in the diff was caught — the failure mode where a suite stays green
  while detection quietly drops.
- Rollback compatibility, which no single-version test can see, was checked explicitly.
