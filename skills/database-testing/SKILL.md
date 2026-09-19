---
name: database-testing
description: Test data layer behaviour — queries, constraints, transactions, data integrity, schema migrations forward and backward, seed and fixture correctness, and the data-safety implications of a change. Use when a change touches the database, adds a migration, alters a schema, or when data correctness is in question.
when_to_use: "test the migration", "database testing", "is the data correct", "test the schema change", "will this migration lose data"
allowed-tools: Read, Glob, Grep, Bash, PowerShell, Write, Edit
metadata:
  system_version: 0.10.0
  role: specialist
---

# Database Testing

## Safety, before anything else

**Never touch a production database.** Not a read, not a count, not "just to check".

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" auth check --json '{"action":"db.read_non_production","environmentClass":"non-production"}'
```

An environment is non-production only when the repository profile explicitly says so.
Unknown counts as production. Work against a disposable instance:

```bash
docker compose -f docker-compose.test.yml up -d db
```

If no disposable database exists, that is a `BLOCKED` result and a finding worth raising —
not a reason to point at staging.

## Constraints and integrity

The database is the last line of defence. Application validation gets bypassed by scripts,
other services, and the next developer.

- `NOT NULL` where nullability is meaningless.
- Unique constraints actually exist for things the application assumes are unique.
- Foreign keys exist, with a deliberate `ON DELETE` behaviour — `CASCADE` silently deleting
  a user's orders is a data-loss bug.
- Check constraints for bounded values (a quantity cannot be negative).
- Money is not a float. Verify the column type; this is a real and common defect.
- Timestamps are timezone-aware, and stored in UTC.

Test each by attempting the violation and asserting the database rejects it.

## Transactions

- A failure mid-operation leaves **nothing** partially applied.
- The isolation level matches what the code assumes — read-committed and serialisable
  behave very differently under concurrency.
- Deadlocks are handled, not just logged.
- Long transactions do not hold locks across an external HTTP call. (Grep for it; it is
  common and it causes outages.)

## Migrations — forward

Run against a realistic dataset, not an empty schema. Most migration defects only appear
with data present.

1. Does it apply cleanly from the previous schema version?
2. Is it **idempotent** or properly guarded — what happens if it runs twice?
3. How long does it take at production row counts? A table rewrite that takes 4 hours is a
   deployment incident.
4. Does it lock a table that serves live traffic?
5. Is existing data transformed correctly — spot-check rows before and after.
6. Does it handle nulls and pre-existing invalid data, or abort halfway through?

## Migrations — backward

The question everyone skips: **what happens if this must be rolled back?**

- Does a down migration exist, and does it run?
- Is it lossy? Dropping a column loses the data in it. Say so explicitly.
- Can the **previous application version** run against the new schema? During a rolling
  deploy, both versions run simultaneously — a migration that removes a column the old code
  still selects causes an outage.

The safe pattern is expand/contract: add the new thing, migrate reads and writes, then
remove the old thing in a later release. If the change does not follow it, that is worth
flagging.

## Data integrity checks

After any migration or data-affecting change:

```sql
-- Row counts before and after
SELECT count(*) FROM orders;
-- Orphans the FK should have prevented
SELECT count(*) FROM order_items oi LEFT JOIN orders o ON o.id = oi.order_id WHERE o.id IS NULL;
-- Values outside the expected domain
SELECT count(*) FROM orders WHERE total_cents < 0;
-- Duplicates on a supposedly unique key
SELECT email, count(*) FROM users GROUP BY email HAVING count(*) > 1;
```

Capture the results before and after as `database-snapshot` evidence — this is execution
evidence and it is what makes a data claim verifiable.

## Query behaviour

- Does the query return correct results at the boundaries — empty table, single row, nulls?
- Is there an index for the query's filter and sort? Run `EXPLAIN`; a sequential scan on a
  large table is a latency incident waiting for traffic.
- N+1: does one API call fan out into hundreds of queries? Count queries in a test.

## Seeds and fixtures

- Do seeds produce a state the application can actually run against?
- Are they deterministic? A fixture using `random()` produces tests that fail differently
  each run.
- Do they contain anything resembling real personal data? They should not.

## Evidence

Database snapshots, query results and migration output are execution evidence. Record the
schema version, the row counts and the exact SQL. **Redact any personal data** before it
reaches a report — a report containing customer email addresses is itself a data incident.
