# GoogleDocsAdapter — contract

## Shape

```
GoogleDocsAdapter
  capabilities:  docs.read, docs.create, docs.update_testing_log
  read(verb, args)  -> { ok, data, evidence }
  write(verb, args) -> { ok, resultId, url, confirmed, revisionId, error, evidence }
  authorization: explicit for every write
  idempotency:   execution ID for log appends
```

## Operations

| Verb | Behaviour | Idempotency key |
| --- | --- | --- |
| `docs.read` | Fetch document content. No authorisation needed. | — |
| `docs.create` | Create a new document. Only when no canonical log exists. | document title |
| `docs.update_testing_log` | **Append** a cycle section to the canonical log. | execution ID |

`docs.update_testing_log` appends. It does not rewrite. Rewriting a shared document is how
an agent destroys someone's manual annotations.

## Append section format

Rendered from state, never hand-written — same rule as the report:

```markdown
## Cycle SESSION-0031 — 2026-09-16T14:22:11Z

**Repository** shop · **Branch** feat/checkout · **Commit** abc1234 · **PR** #412
**Skill version** v0.5.0 · **Report** REPORT-2026-00142

### Goals
- G-01 Validate the payment flow — PARTIAL

### Completed
- EXEC-2026-00001 unit suite — PASSED (87/87) — EV-2026-00012
- EXEC-2026-00003 checkout E2E — FAILED — FIND-00003 — EV-2026-00021, EV-2026-00022

### Blocked
- EXEC-2026-00004 payment E2E — BLOCKED: no authorised sandbox credentials (U-00019)

### Deferred
- Accessibility scan of account pages — deferred for budget

### Not applicable
- localization — no i18n resources in the repository
- migration — no migration files in this change

### Uncertainties
- U-00019 user-input-required — which environment and credentials for payment E2E

### Decisions
- DEC-00007 browser method: hybrid (explore then automate) — confidence 0.87

### Evidence
- EV-2026-00012 test-report — vitest 87/87 — sha256:…
- EV-2026-00021 trace — playwright checkout — sha256:…

### External writes
- github.create_issue → #412 — CONFIRMED — authorised by user

### Remaining
- Payment E2E (blocked), saved-card path (untested), account-page a11y (deferred)

### Next recommended action
Ask the user which payment environment to use, then run the prepared E2E spec.
```

Note what this format makes impossible: a section cannot say "all tests passed" because
every line is generated from an execution record with a status.

## Formatting constraints

The Docs API works in structural requests (`insertText`, `updateParagraphStyle`), not
Markdown. Whichever provider you use, keep the shape above and accept plainer formatting
rather than distorting the content to fit an API.

Practical limits: batch structural requests rather than sending one per line; documents
over a few hundred pages become slow to update; very long append-only logs should roll
over per quarter, with the old one linked.

## Failure modes

| Condition | `ok` | `confirmed` | Caller does |
| --- | --- | --- | --- |
| Appended, revision ID returned | true | true | Record revision ID as evidence |
| Not authorised | false | false | Fall back to the local mirror; **say so** |
| Document not found | false | false | Do not create a replacement silently — ask |
| Permission denied | false | false | `BLOCKED` |
| Partial write | false | unknown → false | Verify before retrying |
| 429 | false | false | Back off once, then `BLOCKED` |

## Evidence

Kind `document-revision`:

```jsonc
{ "kind": "document-revision", "summary": "Appended cycle SESSION-0031 to the Execution Log",
  "epistemic_class": "observed",
  "artifact": { "uri": "https://docs.google.com/document/d/…#revision=…" } }
```

Classed `observed` only when a revision ID came back. Otherwise the write is recorded with
`confirmed: false` and the report shows `NOT CONFIRMED`.

## Local mirror fallback

When no provider resolves, the same section is written to
`state/reports/REPORT-YYYY-NNNNN.md`, which is authoritative in that case. The report then
carries an explicit line: *the external testing log was not updated because no documents
capability was available.*
