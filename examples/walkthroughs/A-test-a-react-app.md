# Walkthrough A — "Test this React application"

> **Illustrative walkthrough, not a record of a real run.** IDs and outputs are invented to
> show the shape of the process.

An open-ended request against a repository the agent has never seen. The interesting part
is what it decides **not** to do.

---

## User

> Test this React application.

## 1. Orient, then look

```bash
node bin/ast.mjs session resume     # -> recoverable: false
node bin/ast.mjs caps probe
```

```
shell / git / node    available
gh-cli                available    Logged in to github.com
playwright-cli        unavailable  npx: playwright not found
mcp-playwright        unknown      NOT DECLARED
docker                available
```

No browser automation. That is not a blocker for everything — it is a blocker for specific
categories, and it must be recorded as one rather than quietly reducing scope.

## 2. Profile the repository

Delegated to `repository-intelligence`. Evidence, not filenames:

| Claim | Evidence |
| --- | --- |
| React 18 | `package.json:dependencies.react@^18.3.1`, imported in `src/main.tsx` |
| Vite | `vite.config.ts` |
| Vitest + Testing Library | `vitest.config.ts`, 34 files under `src/**/*.test.tsx` |
| Express API | `server/index.ts:12` — `app.listen` |
| Postgres via Prisma | `prisma/schema.prisma`, 6 migrations |
| Auth: session cookies | `server/middleware/session.ts` |
| Stripe | `server/payments/stripe.ts:8` — `new Stripe(...)` |
| CI: GitHub Actions | `.github/workflows/ci.yml` runs `npm test` only |

**Verified runnable:** `npm test` → 34 files, 211 tests, all pass in 12s.
That is a real baseline, and it is worth having before anything else.

**Gaps recorded honestly:**
- No coverage report is produced; coverage figures are unavailable.
- Cannot tell whether `server/payments` reaches live Stripe — the key comes from an unset
  env var.
- No E2E or integration tests exist anywhere in the repository.

```bash
node bin/ast.mjs profile save --input profile.json
node bin/ast.mjs profile signals
```

```json
{ "signals": ["auth","component-framework","database","existing-tests","external-integration",
              "http-api","payments","pii","sessions","third-party-deps","ui","web-ui","ci"] }
```

## 3. Risk

No specific change to scope against, so the assessment is about the *repository*:

```bash
node bin/ast.mjs risk score --input factors.json --profile balanced --explain
```

```
risk_score: 0.6421   risk_level: medium   confidence: 0.4318
  - coverage_deficit:  0.9 × 1.0 => 0.90  [observed] no integration or E2E tests exist
  - security_sensitivity: 0.7 × 1.0 => 0.70 [observed] session auth + Stripe integration
  - business_criticality: 0.7 × 1.0 => 0.70 [inferred] e-commerce checkout present
  ...
unscored: change_magnitude, change_frequency, historical_failures, test_flakiness, ...
```

Confidence 0.43 — and the agent reports it that way: *"given the fraction of the picture I
can evidence, this looks medium"*. With no change to analyse, half the risk factors have no
input, and guessing them would manufacture a number.

## 4. Applicability — including what is excluded

```bash
node bin/ast.mjs applicability eval --input applicability.json
```

47 categories evaluated. 24 applicable, 23 not. The excluded ones carry reasons:

| Not applicable | Reason |
| --- | --- |
| `localization` | No i18n resources found in the repository |
| `migration` | Applicable in principle, but no migration is under test — nothing changed |
| `rag-evaluation` | No retrieval or LLM code present |
| `load` / `stress` / `endurance` | No stated performance requirement, and they need explicit authorisation |
| `cross-browser` | No stated support matrix |

And two applicable-but-blocked:

| Blocked | Reason |
| --- | --- |
| `e2e`, `browser-automation` | `browser.run_deterministic_test` unavailable — no browser installed |

That distinction is the point. "Not applicable" is a conclusion. "Blocked" is a gap.

## 5. Plan and check in

Budget: 90 minutes. Selection walks priority tiers, so P0 work is taken before cheap P2 wins.

> **Before I run anything.** This repository has 211 unit tests that pass in 12 seconds, and
> **no** integration or E2E tests at all. Given it handles sessions and Stripe payments,
> that gap is the story here, not the unit tests.
>
> I plan to: re-run the unit suite as a baseline (done — 211/211), run `npm audit`, review
> the authorisation paths statically, and write API tests for the checkout and session
> endpoints against a Docker Postgres.
>
> **Blocked:** E2E and browser testing — no browser installed. `npx playwright install
> chromium` would unblock it. Want me to?
>
> **Not doing:** load testing (no stated target, needs authorisation), i18n (no locales),
> cross-browser (no support matrix).

## 6. Execute what is unblocked

```bash
node bin/ast.mjs uncertainty raise --json '{"question":"Should I install Playwright browsers to enable E2E?","status":"user-input-required","impact":"E2E and browser categories cannot run","affectedScope":["e2e","browser-automation"],"blocksCategories":["e2e"],"nextAction":"ask the user whether to run npx playwright install","owner":"user"}'
node bin/ast.mjs uncertainty partition --input scenarios.json
```

```json
{ "runnable": 9, "blocked": 3,
  "guidance": "9 scenario(s) are unaffected by the 1 open blocker(s). Run those now; do not wait." }
```

So it runs the nine. Highlights:

- `npm audit` → 2 high CVEs, both in a transitive dev dependency on a code path that never
  executes in production. Reported as `minor` with exploitability stated, not as "2 high
  vulnerabilities".
- API tests against Docker Postgres → **`GET /api/orders/:id` returns another user's order.**
  Object-level authorisation is missing.

That last one is the highest-value finding in the session, it took twelve minutes, and it
needed no browser.

## 7. Report

> **211 unit tests pass at `abc1234` (`EV-2026-00002`). That is the only automated coverage
> this repository has.**
>
> **One critical finding:** `GET /api/orders/:id` returns orders belonging to other users —
> `FIND-00006`, reproduced 3/3, request/response pair in `EV-2026-00009` (headers redacted).
> The handler loads by ID and never compares `order.userId` to the session user
> (`server/orders/get.ts:34`).
>
> **Not tested:** every E2E and browser scenario (blocked, `U-00022` — no browser
> installed). Load, i18n and cross-browser are not applicable and are listed with reasons in
> the report.
>
> **The structural gap:** no integration or E2E tests exist. The authorisation defect above
> is exactly the class of bug that an API test suite catches and a unit suite never will.
>
> **Recommended next:** fix the authorisation check, then let me add the API test suite that
> would have caught it.

## What this walkthrough demonstrates

- The agent **ran the existing suite first** and got a real baseline before deciding anything.
- It recorded 23 categories as not applicable **with reasons**, so the report's scope is
  legible.
- A missing browser blocked three scenarios and stopped none of the other nine.
- Coverage was reported as file counts with `measured: false`, not dressed up as a percentage.
- The most valuable finding came from the cheapest applicable category, which is what
  cost-aware prioritisation is for.
