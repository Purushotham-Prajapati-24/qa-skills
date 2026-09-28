# Test Data Policy

Every specialist skill creates or reads test data. This is the one place the rules live, so
they are the same rules everywhere.

## 1. Create what the test needs; never borrow what happens to exist

A test that depends on a row someone else created passes until that row changes, then fails
for a reason nobody can see.

- Create data through the application's own API or a fixture/factory the repository already
  has. Reuse its factories; do not start a parallel harness.
- Make every identifier unique per run (`order-${runId}`, a UUID), so parallel runs and
  reruns cannot collide.
- A test that needs "an existing customer" creates one. "The staging database has a good
  one" is not a precondition, it is a dependency on luck.

## 2. Synthetic by default, deterministic when it matters

- Personal data in tests is **synthetic**: generated names, `@example.test` addresses, phone
  numbers from reserved ranges. Never real customer data, not even "just a few rows".
- Seed any generator (`faker.seed(n)`, a fixed RNG seed) and record the seed in the
  execution's `command` or evidence. An unseeded failure cannot be reproduced, which makes it
  an anecdote.
- Payment, SMS and email providers publish test values (test card numbers, sandbox numbers).
  Use those, and only in the provider's test mode.

## 3. Real data is the exception, and it is transformed first

If a test genuinely needs production-shaped data (a migration rehearsal, a performance run on
realistic volumes):

1. It needs explicit authorisation, and the source must be named by the user.
2. It is anonymised **before** it reaches any test environment: replace direct identifiers,
   hash join keys consistently (so relationships survive), generalise quasi-identifiers
   (exact birth date → year, postcode → region).
3. The anonymisation is itself verified — sample it and check no direct identifier survived.
   An unverified anonymisation step is a data leak with a comment above it.

## 4. Fixtures are versioned with the code that reads them

- Fixtures live in the repository next to the tests that use them, not in a shared bucket.
- A schema change updates its fixtures in the same commit. A fixture that no longer matches
  the schema fails loudly; it must never be "fixed" by loosening the assertion.
- Large generated fixtures are regenerated from a script and a seed, not committed as blobs
  nobody can re-derive.

## 5. Test data dies with the test

- Clean up what the test created — in a teardown that runs on failure too — or run against a
  disposable environment that is thrown away whole.
- Nothing a test creates is written to long-term storage, analytics, or a shared queue.
- Test data never appears in evidence un-redacted. Evidence passes through redaction, which
  masks known secret shapes; it does not recognise a real person's name. Do not capture it.

## 6. Where it applies

| Skill | What this policy means there |
| --- | --- |
| `database-testing` | Disposable instance, seeded fixtures, anonymised copies only with authorisation |
| `api-testing` | Provider test values; unique resources per run; delete what you create |
| `e2e-testing` | Create state through the API, not the UI, before the journey starts |
| `security-testing` | Synthetic personal data for authz matrices; never a real account |
| `performance-testing` | Volume from a seeded generator, not a copy of production |
| `ai-testing` | Evaluation sets are synthetic or consented; record their version with the result |

A test blocked on data it is not allowed to have is `BLOCKED` with an uncertainty naming the
data it needs — not a reason to use something you were not given.
