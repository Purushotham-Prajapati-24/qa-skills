---
name: requirement-analysis
description: Find and read the requirements that testing should validate — Jira tickets, GitHub issues, acceptance criteria, specs, README claims and the code itself — assess which are relevant to the change at hand, extract testable criteria, and flag ambiguity instead of inventing expected behaviour. Use when asked to plan testing from a ticket, derive test cases from acceptance criteria, or establish what the software is supposed to do.
when_to_use: "read Jira ticket XYZ and plan testing", "what are the acceptance criteria", "derive test cases from this ticket", "what is this supposed to do"
allowed-tools: Read, Glob, Grep, Bash, PowerShell
metadata:
  system_version: 0.10.0
  role: specialist
---

# Requirement Analysis

A test asserts an expectation. If nobody wrote the expectation down, you are about to
invent one — and a test built on an invented expectation is worse than no test, because it
looks authoritative.

## Sources, in order of authority

1. **Acceptance criteria** on a ticket — explicit, negotiated, testable.
2. **A specification or schema** — OpenAPI, GraphQL SDL, JSON Schema, protobuf.
3. **Ticket description** — intent, usually underspecified.
4. **Existing tests** — what the team previously agreed the behaviour is.
5. **Code** — what it *currently* does. Never treat this as what it *should* do; that
   reasoning makes every defect unfalsifiable.
6. **README / docs** — often stale; verify before relying on it.
7. **The user** — authoritative when they state it, recorded as `reported-by-user`.

## Getting tickets

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" caps resolve jira.read_ticket
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" caps resolve github.search_issues
```

If Jira resolves, read the ticket, its acceptance criteria, its links and its comments —
comments frequently contain the decision that contradicts the description.

If it does not resolve, say **"Jira unavailable"** plainly and continue from repository
evidence. See [../../integrations/jira/README.md](../../integrations/jira/README.md).

## Ticket relevance — do not just grab the first match

Score each candidate before using it:

| Factor | Question |
| --- | --- |
| Change overlap | Does the ticket name the files, modules or feature that changed? |
| Requirements overlap | Do its criteria describe behaviour this change touches? |
| Component | Same component/label/epic? |
| Risk | Does it concern a high-risk area? |
| Acceptance criteria | Does it have any? Without them it is context, not a specification. |
| Historical relationship | Linked to past defects in this area? |
| Testability | Can its criteria be observed and asserted? |

Record why a ticket was considered relevant — as a decision when the choice was
non-obvious. "It was the branch name" is a legitimate reason; "it was the first result"
is not.

## Extracting testable criteria

Turn each requirement into something with an observable outcome:

```jsonc
{
  "id": "REQ-3",
  "statement": "A guest can pay with a saved card",
  "source": "jira", "source_ref": "SHOP-412",
  "acceptance_criteria": [
    "Given a guest with a saved card, when they select it and pay, an order is created",
    "Given a declined card, when they pay, the error is shown and no order is created"
  ],
  "testable": true
}
```

Not testable yet: "checkout should be fast", "the UI should be intuitive", "handle errors
gracefully". Either get a number and a condition, or record an ambiguity.

## Ambiguity is a finding, not an obstacle

When a requirement admits two readings and they imply different tests:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" uncertainty raise --json '{
  "question":"Does \"saved card\" include a card saved during a previous guest checkout, or only a logged-in user'"'"'s card?",
  "status":"ambiguous-requirement",
  "impact":"the two readings need different test data and different expected outcomes",
  "affectedScope":["REQ-3","checkout-saved-card"],
  "nextAction":"ask the ticket author, or test the narrower reading and state the assumption",
  "owner":"user"
}'
```

Then **do not stop**. Test the narrower reading, state the assumption explicitly, and flag
the other reading as untested. Also raise a finding of kind `requirement-ambiguity` — the
ambiguity is itself worth someone's attention.

## Non-functional requirements

These hide in prose and get dropped. Hunt for them: response time, throughput,
availability, browser support, accessibility conformance level, locale support, data
retention, audit requirements. Each becomes a requirement with a number, or an ambiguity.

## Traceability

Every scenario declares which requirements it validates, and every test result carries
`validates_requirements`. That is what makes this work:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" trace query what-remains-untested
```

The answer always carries the caveat that it counts only requirements someone declared.
Requirements nobody wrote down remain the largest untested surface in any system, and no
tool can show them to you.
