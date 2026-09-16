---
name: api-testing
description: Test HTTP, GraphQL and gRPC APIs — status codes, response shapes, schema conformance, validation, error handling, authentication and authorisation, pagination, idempotency, rate limiting and backwards compatibility. Use when a change affects an API, when testing endpoints, validating a contract, or checking that a schema change does not break consumers.
when_to_use: "test the API", "test these endpoints", "did the schema change break anything", "test the GraphQL API", "validate the OpenAPI contract"
allowed-tools: Read, Glob, Grep, Bash, PowerShell, Write, Edit
metadata:
  system_version: 0.7.0
  role: specialist
---

# API Testing

High value per minute: fast, deterministic, no browser, and it exercises the boundary
other people actually depend on.

## Establish the surface

```bash
ls openapi.* swagger.* schema.graphql *.proto 2>/dev/null
grep -rn "router\.\(get\|post\|put\|patch\|delete\)\|@app\.\(route\|get\|post\)\|@RestController" src/ | head -50
```

If a schema exists it is the specification — assert against it. If not, that absence is a
`documentation-gap` finding worth raising.

## Per endpoint

| Dimension | Check |
| --- | --- |
| Happy path | Correct status, correct body shape, correct values |
| Schema conformance | Response validates against the declared schema |
| Validation | Missing required field, wrong type, out-of-range, oversized payload |
| Error shape | Errors are consistent and machine-readable, not raw stack traces |
| Status codes | 400 vs 401 vs 403 vs 404 vs 409 vs 422 used correctly |
| Auth | Unauthenticated → 401. Authenticated-but-forbidden → 403. |
| **Object-level authz** | User A cannot read or modify user B's object by changing an ID |
| Idempotency | Repeating a POST with the same key does not duplicate |
| Pagination | Limits enforced, cursors stable, no duplicates or gaps across pages |
| Rate limiting | Enforced, and returns a useful `Retry-After` |
| Content type | Correct, and a wrong one is rejected rather than misparsed |

**Object-level authorisation is the single highest-yield API test.** It is simple to write,
routinely broken, and the failure mode is a data breach. Test it on every endpoint that
takes an identifier.

## 401 versus 403

These get conflated constantly and the distinction matters:

- **401** — I do not know who you are.
- **403** — I know who you are, and you may not do this.

Returning 403 for an unauthenticated request leaks that the resource exists. Returning 404
for a forbidden resource is a legitimate design choice — but it must be deliberate and
consistent, not accidental.

## GraphQL specifics

- Query depth and complexity limits exist and are enforced (otherwise one query can DoS
  the server).
- Field-level authorisation, not just operation-level.
- Errors appear in `errors[]` with a sensible `path`, and partial data is intentional.
- Introspection is disabled in production if that is the stated policy.
- N+1: a list query does not fan out into per-item database calls.

## Backwards compatibility

When a schema changed, test what **existing consumers** do:

| Change | Breaking? |
| --- | --- |
| Added optional response field | No |
| Removed or renamed response field | **Yes** |
| Narrowed a type or enum | **Yes** |
| New required request field | **Yes** |
| Changed error shape or status code | **Yes** |
| Changed default sort order or pagination size | Usually yes, in practice |

## Running

Use the repository's existing API test setup if one exists — supertest, pytest+httpx,
RestAssured, `.http` files. Only reach for raw `curl` when nothing exists, and then say
that the checks were ad hoc rather than committed.

```bash
node bin/ast.mjs exec start --json '{"goal":"Checkout API contract and authz","method":"api-client","testCategory":"api","command":"npm run test:api","environment":"local-docker"}'
```

Capture full request/response pairs as evidence. **Redact headers** — an `Authorization`
header in a report is a leaked credential. The redaction pass masks known shapes, but do
not deliberately capture them.

## A read-only request is not always read-only

`GET /export?send=true` has side effects. Before calling any endpoint, ask whether it
mutates state or triggers an external action. If it does, it is an external write and needs
authorisation — regardless of the HTTP verb.

## Common mistakes

- Only testing 200s. Most defects live in the error paths.
- Asserting the whole body when only two fields matter — brittle, and it hides the intent.
- Testing with an admin token throughout, which makes every authorisation bug invisible.
- Treating a 500 as a test failure without checking the server log for the actual cause.
- Hardcoding IDs that a fresh database will not have.
