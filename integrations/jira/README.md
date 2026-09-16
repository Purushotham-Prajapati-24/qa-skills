# Jira integration

Jira supplies **requirements**. It is where acceptance criteria live, and acceptance
criteria are what tests assert. Without them you are inventing expected behaviour.

```
skill  →  jira.read_ticket  →  capability-registry  →  mcp-atlassian  |  jira-rest  |  (none)
```

If neither resolves: **say "Jira unavailable" plainly**, continue from repository evidence,
and record the reduced requirement confidence. Do not guess at what a ticket said.

## Providers

**1. `mcp-atlassian`** — the Atlassian connector. Requires authorisation in an interactive
session; it cannot be authorised from a non-interactive one. Declare it yourself:

```bash
node bin/ast.mjs caps declare mcp-atlassian true --note "atlassian connector authorised"
```

**2. `jira-rest`** — direct Jira Cloud REST v3. Probed automatically from environment:

```bash
export JIRA_BASE_URL=https://your-org.atlassian.net
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=...      # create at id.atlassian.com/manage-profile/security/api-tokens
```

```bash
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  "$JIRA_BASE_URL/rest/api/3/issue/SHOP-412?fields=summary,description,status,labels,components,issuelinks,customfield_*"
```

Never put the token in a command you would paste into a report. The redaction pass masks
known shapes, but the safe habit is not to capture it at all.

## Capability surface

| Verb | Write? | Authorisation |
| --- | --- | --- |
| `jira.search` | no | none |
| `jira.read_ticket` | no | none |
| `jira.comment` | **yes** | explicit |
| `jira.create_issue` | **yes** | explicit |
| `jira.transition` | **yes** | prohibited by default |

Transitions are prohibited because moving a ticket to "Done" is a claim about the world
that a testing agent is not entitled to make. Tell the user what you found; they move the
ticket.

## Do not just grab the first ticket

A wrong ticket produces a plan that tests the wrong thing, confidently. Score candidates:

| Factor | Question |
| --- | --- |
| Change overlap | Does the ticket name the files, modules or feature that changed? |
| Requirements overlap | Do its criteria describe behaviour this change touches? |
| Component | Same component, label or epic? |
| Risk | Does it concern a high-risk area? |
| Acceptance criteria | Does it have any? Without them it is context, not a specification. |
| Historical relationship | Linked to past defects here? |
| Testability | Can its criteria be observed and asserted? |

Record why a ticket was considered relevant. "The branch name is `feat/SHOP-412-saved-card`"
is a good reason. "It was the first search result" is not.

## Finding the ticket

```bash
git log --oneline -20 | grep -oE '[A-Z]+-[0-9]+'
git branch --show-current | grep -oE '[A-Z]+-[0-9]+'
gh pr view <n> --json title,body | grep -oE '[A-Z]+-[0-9]+'
```

Branch names and commit messages are the most reliable link, because a human wrote them
deliberately at the time.

## What to extract

- **Acceptance criteria** — the highest-authority requirement source.
- **Description** — intent, usually underspecified.
- **Comments** — where the decision that contradicts the description usually lives. Read
  them; this is not optional.
- **Linked issues** — "blocks", "relates to", and especially "caused by", which points at
  past defects in the same area.
- **Components and labels** — scope hints, and the `historical_failures` risk input.
- **Attachments** — designs and specs, when accessible.

## Ambiguity is a finding

A requirement admitting two readings that imply different tests is not an obstacle — it is
something worth someone's attention:

```bash
node bin/ast.mjs uncertainty raise --json '{"question":"...","status":"ambiguous-requirement","impact":"the two readings need different expected outcomes","affectedScope":["REQ-3"],"nextAction":"ask the ticket author","owner":"user"}'
node bin/ast.mjs finding add --json '{"title":"SHOP-412 acceptance criteria are ambiguous about saved cards","kind":"requirement-ambiguity","severity":"minor","confidence":0.9}'
```

Then test the narrower reading, state the assumption, and flag the other as untested.

## Traceability

```
Requirement → Jira ticket → PR → Commit → Component → Test → Execution → Finding → Issue → Evidence
```

```bash
node bin/ast.mjs trace query what-validates REQ-3
node bin/ast.mjs trace query what-remains-untested
```

Record `related_requirements` on findings and `validates_requirements` on test results, or
the chain breaks and the "what remains untested" answer becomes meaningless.

## Failure modes

| Condition | Handling |
| --- | --- |
| Not authorised | Capability unavailable. Say so. Continue from repository evidence. |
| Ticket not found | Do not guess a neighbouring ID. Ask. |
| No acceptance criteria | Raise an ambiguity; derive candidate criteria from code and **label them as derived**. |
| Rate limited | Back off once, then `BLOCKED`. |
| Field missing (custom field IDs vary per instance) | Do not assume `customfield_10001` means the same thing everywhere. |

See [adapter.md](adapter.md).
