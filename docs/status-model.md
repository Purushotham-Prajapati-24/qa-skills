# The status model

Pass/fail is not enough. It forces every ambiguous outcome into one of two boxes, and the
box it usually lands in is "pass" — which is how a testing agent produces confident
nonsense.

Eleven statuses, each with an exact meaning.

| Status | Means | Does **not** mean |
| --- | --- | --- |
| `COMPLETED` | The work happened and finished. Used for activities without a pass/fail notion, like exploration. | That everything was correct |
| `PASSED` | It executed and every assertion held. **Requires execution evidence.** | That the feature works in general |
| `FAILED` | It executed and at least one assertion did not hold. | That a defect exists — classify first |
| `PARTIAL` | Some of it ran and completed; some did not. | That the rest is fine |
| `BLOCKED` | Could not run. A prerequisite, capability or environment was missing. | Anything at all about correctness |
| `DEFERRED` | Deliberately postponed. Worth doing later. | Not needed |
| `INTERRUPTED` | Started and never finished — user stop, crash, timeout. | That it would have passed |
| `SKIPPED` | Deliberately not run this time, though it could have been. | Not applicable |
| `NOT_APPLICABLE` | Considered and genuinely does not apply here. **Requires a reason.** | Not done |
| `NEEDS_USER_INPUT` | Cannot proceed without a decision only the user can make. | Blocked by the environment |
| `INCONCLUSIVE` | It ran, but the evidence does not settle the question. | Failed |

## The four that agents skip

**`BLOCKED`** is not `FAILED`. A test that could not run tells you nothing about the
software. Reporting a missing browser binary as a failure wastes a developer's afternoon
looking for a bug that is not there.

**`NOT_APPLICABLE`** is not `SKIPPED`. "We have no UI, so visual regression does not apply"
is a conclusion. "We did not get to visual regression" is a gap. The report must not blur
them, and `NOT_APPLICABLE` always carries its reason.

**`INCONCLUSIVE`** is the one that does the most work. It is the honest answer whenever
something ran but the evidence is insufficient — and it is what `PASSED` gets downgraded to
when the evidence gate refuses a claim.

**`INTERRUPTED`** exists so that a half-run leaves a trace. Recovery marks unfinished
executions `INTERRUPTED`; it never infers that they would have passed.

## The evidence gate

`PASSED`, `FAILED`, `COMPLETED` and `PARTIAL` all claim something executed, so all four
require evidence:

```bash
node bin/ast.mjs evidence verify --json '{"status":"PASSED","evidenceIds":["EV-2026-00031"]}'
```

A claim that fails the gate is downgraded to `INCONCLUSIVE` with the reason recorded in
`status_reason`. `exec finish` applies this automatically — you cannot route around it by
asserting harder.

## Choosing one

```
Did it run?
├── No
│   ├── Could not → BLOCKED
│   ├── Chose not to, this time → SKIPPED
│   ├── Does not apply here → NOT_APPLICABLE (give the reason)
│   ├── Postponed on purpose → DEFERRED
│   └── Needs a user decision → NEEDS_USER_INPUT
└── Yes
    ├── Stopped mid-flight → INTERRUPTED
    ├── Finished, all assertions held → PASSED
    ├── Finished, an assertion failed → FAILED
    ├── Some ran, some did not → PARTIAL
    ├── Ran, but evidence does not settle it → INCONCLUSIVE
    └── No pass/fail notion (e.g. exploration) → COMPLETED
```

## Roll-up

An overall status is derived, not asserted:

- any `FAILED` → overall `FAILED`
- else any `BLOCKED` / `NEEDS_USER_INPUT` → `PARTIAL`
- else any `INTERRUPTED` → `INTERRUPTED`
- else any `PASSED` / `COMPLETED` → `COMPLETED`
- else → `INCONCLUSIVE`

`COMPLETED` at the top level never means "the software is fine". It means testing finished.
The report's "What was NOT tested" section carries the rest of the truth, which is why it
sits near the top rather than in an appendix.
