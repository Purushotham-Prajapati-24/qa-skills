# Uncertainty Register

Everything the agent could not resolve. The register exists so that "unknown" never quietly
becomes "fine".

Canonical form: `schemas/uncertainty.schema.json`, stored in `state/uncertainties/`.

## Register

| ID | Question | Status | Blocks | Impact | Next action | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| U-00019 | Should payment tests use real provider credentials? | user-input-required | payment-e2e | Cannot safely execute a real transaction | Ask which environment and credentials to use | user |
| U-00021 | Does "saved card" include one saved during a previous guest checkout? | ambiguous-requirement | REQ-3 | The two readings need different test data and expected outcomes | Ask the ticket author; meanwhile test the narrower reading | user |
| U-00024 | Is WebKit available anywhere in CI? | environment-unavailable | cross-browser | Safari-specific defects would go undetected | Check the CI image, or accept the gap explicitly | agent |

## Entry

```jsonc
{
  "id": "U-00019",
  "timestamp": "2026-09-16T14:10:00Z",
  "question": "Should payment tests use real provider credentials?",
  "status": "user-input-required",
  "impact": "cannot safely execute a real transaction",
  "affected_scope": ["payment-e2e"],
  "blocks_categories": ["e2e"],
  "next_action": "request an explicit environment choice from the user",
  "owner": "user",
  "independent_work_continued": [
    "Ran the unit suite (87/87 at abc1234)",
    "Ran API contract tests against a mocked provider (12/12)",
    "Drafted e2e/checkout-saved-card.spec.ts so it is ready either way"
  ]
}
```

## Statuses

| Status | Meaning | Ask the user? |
| --- | --- | --- |
| `unresolved` | Open, not yet categorised | No |
| `blocked` | Something external prevents progress | No |
| `deferred` | Deliberately postponed | No |
| `user-input-required` | Only the user can answer | **Yes** |
| `environment-unavailable` | The environment cannot support it | No |
| `ambiguous-requirement` | Two readings imply different tests | Yes, eventually |
| `insufficient-evidence` | Not enough signal to conclude | No — gather more |
| `external-dependency` | Waiting on a third party | No |
| `interrupted` | Work stopped mid-flight | No |
| `future-case` | Worth testing later, not now | No |
| `resolved` | Answered | — |

Only `user-input-required` implies you should stop and ask. The rest are things to record
and work around.

## Two mandatory fields

**`affected_scope`** — what cannot be completed while this stands. "Something might be
wrong somewhere" is not actionable and the CLI rejects it.

**`next_action`** — what would resolve it. An uncertainty with no next action is a shrug,
not a record.

## `independent_work_continued` is the point

This field is the evidence that the agent did not down tools the moment something got hard.
A blocker stops one branch, never the session:

```bash
node bin/ast.mjs uncertainty partition --input scenarios.json
```

If `runnable` is non-empty, you are not blocked — you have one blocked branch. Run the rest,
then record what you did:

```bash
node bin/ast.mjs uncertainty raise --input u.json
node bin/ast.mjs uncertainty resolve U-00019 --answer "use the Stripe sandbox key in .env.test"
```

## Reading the register

A register full of `user-input-required` entries means the agent stopped too often. A
register with none, in a real session, usually means it did not notice what it did not know
— which is worse.
