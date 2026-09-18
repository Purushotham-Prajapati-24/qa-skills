# JiraAdapter — contract

**Not implemented.** No executable module exists at `engine/adapters/jira.mjs` (see
PROGRESS.md). `jira` is listed in `engine/capability-registry/capabilities.json`'s
`manual_only_systems`, so `ast caps resolve jira.*` still reports `available: true` once
credentials or the connector are present — but every resolution now also carries
`executable: false` and a reason stating there is no code to drive it. Follow this contract
by hand; record any write with `ast write record` the same way `performWrite` would have.

## Shape

```
JiraAdapter
  capabilities:  jira.search, jira.read_ticket, jira.comment, jira.create_issue, jira.transition
  read(verb, args)  -> { ok, data, evidence }
  write(verb, args) -> { ok, resultId, url, confirmed, error, evidence }
  authorization: per-verb, from engine/authorization/policy.json
  failureModes, rateLimit, idempotency
```

## Read operations

| Verb | REST v3 | Notes |
| --- | --- | --- |
| `jira.search` | `GET /rest/api/3/search?jql=...` | JQL. Prefer a narrow query; `project = X` alone can return thousands. |
| `jira.read_ticket` | `GET /rest/api/3/issue/{key}?fields=...` | Request only the fields you need; `*all` is slow and noisy. |
| (comments) | `GET /rest/api/3/issue/{key}/comment` | Often where the real decision is recorded. |
| (changelog) | `GET /rest/api/3/issue/{key}?expand=changelog` | Useful for `historical_failures`. |

Useful JQL:

```
project = SHOP AND component = checkout AND updated >= -30d ORDER BY updated DESC
project = SHOP AND issuetype = Bug AND component = checkout AND resolution != Unresolved
key in (SHOP-412, SHOP-418)
```

## The description field is ADF, not text

Jira Cloud returns Atlassian Document Format — nested JSON, not Markdown. Naively
stringifying it produces unreadable noise that then ends up in a test plan.

Walk the node tree and extract `text` from `text` nodes, preserving `bulletList`,
`orderedList` and `codeBlock` structure. If you cannot parse it, say the description could
not be read rather than pasting JSON into a plan.

Acceptance criteria are usually **either** a custom field whose ID differs per instance,
**or** a heading inside the description. Check both. Never assume `customfield_10001` means
the same thing on someone else's Jira.

## Write operations

| Verb | REST v3 | Authorisation | Idempotency key |
| --- | --- | --- | --- |
| `jira.comment` | `POST /rest/api/3/issue/{key}/comment` | explicit | `<key>:<content hash>` |
| `jira.create_issue` | `POST /rest/api/3/issue` | explicit | finding fingerprint |
| `jira.transition` | `POST /rest/api/3/issue/{key}/transitions` | **prohibited by default** | — |

Comment bodies must be ADF, not plain strings:

```json
{ "body": { "type": "doc", "version": 1,
  "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "..." }] }] } }
```

### Write contract

`auth.check` → `alreadyWritten` → render and read → perform → `recordWrite` with
`confirmed` taken from the response body (a created issue returns `key` and `id`).

## Why transitions are prohibited

Moving a ticket to "Done" asserts that the work is complete and verified. A testing agent
can report evidence; it cannot make that judgement on a team's behalf, and a wrongly-closed
ticket disappears from everyone's board. Post a comment with the evidence instead and let a
human move it.

## Failure modes

| Condition | `ok` | Caller does |
| --- | --- | --- |
| 401 | false | Not authorised → capability unavailable → `BLOCKED` |
| 403 | false | Authenticated but lacks permission on that project |
| 404 | false | Wrong key or no browse permission. **Do not guess a neighbouring key.** |
| 400 on create | false | Usually a required custom field. Read the error; do not retry unchanged. |
| 429 | false | Honour `Retry-After` once, then `BLOCKED` |
| Network error mid-write | false | Verify by searching before any retry |

## Rate limits

Jira Cloud rate limits are dynamic and not published as a fixed number. Treat 429 as
authoritative, honour `Retry-After`, and batch reads with a single JQL query rather than
fetching issues one at a time.

## Evidence

Kind `jira-object`, classed `observed` for reads that returned data. Jira content is
**corroborating** evidence: a ticket saying a feature works is a claim by a person, not a
test result. When a requirement comes from a ticket, its epistemic class is
`reported-by-user`, never `verified`.
