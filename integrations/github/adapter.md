# GitHubAdapter — contract

An adapter is the mapping from a capability verb to one provider's concrete calls. This
document specifies the contract any GitHub provider must satisfy.

## Shape

```
GitHubAdapter
  capabilities:   the verbs this provider implements
  read(verb, args)   -> { ok, data, evidence }
  write(verb, args)  -> { ok, resultId, url, confirmed, error, evidence }
  authorization:  per-verb level, from engine/authorization/policy.json
  failureModes:   what each failure means and what the caller should do
  rateLimit:      limits and backoff behaviour
  idempotency:    the key used to suppress duplicates
```

## Read operations

| Verb | `gh` implementation | Returns |
| --- | --- | --- |
| `github.read_repo` | `gh repo view --json ...` | repo metadata |
| `github.read_pr` | `gh pr view <n> --json ...` | PR metadata, commits, files |
| `github.list_changed_files` | `gh pr diff <n> --name-only` | file paths |
| `github.search_issues` | `gh issue list --search "..." --state all --json` | issue list |
| `ci.read_runs` | `gh run list --json` / `gh run view <id> --log-failed` | run status and failure logs |

Reads need no authorisation. Every read returns evidence of kind `github-object` —
corroborating, not execution evidence. A PR description is not proof a test ran.

## Write operations

| Verb | `gh` implementation | Authorisation | Idempotency key |
| --- | --- | --- | --- |
| `github.create_issue` | `gh issue create --title --body-file --label` | explicit | finding fingerprint |
| `github.update_issue` | `gh issue edit <n> --body-file` | explicit | issue number |
| `github.comment` | `gh issue comment <n> --body-file` | explicit | `<issue>:<content hash>` |
| `github.assign_issue` | `gh issue edit <n> --add-assignee <login>` | explicit **+ named account** | `<issue>:<login>` |
| `github.close_issue` | — | **prohibited by default** | — |
| `github.merge_pr` | — | **prohibited by default** | — |

### Write contract

1. `auth.check(verb)` → must return `allowed: true`.
2. `auth.alreadyWritten(key)` → must return `duplicate: false`.
3. Render the content and read it.
4. Perform the call.
5. `auth.recordWrite(...)` with `confirmed` taken **from the provider response**.
6. Return `{ ok, resultId, url, confirmed }`.

Step 5 is where honesty lives. `confirmed` is not "the command exited 0" — it is "GitHub
returned an identifier for the thing I created". A `gh` command can exit 0 having printed
a warning and created nothing.

## Failure modes

| Condition | `ok` | `confirmed` | Caller does |
| --- | --- | --- | --- |
| Success with an ID | true | true | Record the ID and URL |
| 401 / 403 | false | false | Capability unavailable → `BLOCKED` |
| 404 | false | false | Verify the target; on a private repo this is usually a scope issue |
| 422 validation | false | false | Fix the payload; do not retry unchanged |
| 429 rate limited | false | false | One backoff, then `BLOCKED` |
| Network error mid-write | false | **unknown → false** | **Verify before any retry**; the write may have landed |
| Exit 0, no identifier parsed | false | false | Treat as unconfirmed. Never assume. |

## Rate limits

REST is 5,000 requests/hour authenticated; search is 30/minute. Prefer one `--json` call
returning many fields over several narrow calls. On 429, back off once and then report
`BLOCKED` — an agent that retries into a rate limit gets the user's token throttled.

## Evidence returned

Every operation produces evidence:

```jsonc
{ "kind": "github-object", "summary": "Created issue #412 in owner/repo",
  "epistemic_class": "observed", "artifact": { "uri": "https://github.com/owner/repo/issues/412" } }
```

Classed `observed` only when the provider confirmed it. An attempted-but-unconfirmed write
is recorded, but its evidence is classed `inferred` — because you are inferring that
something happened, not observing that it did.

## Implementing a new provider

Satisfy every verb you claim in `capabilities.json`. Partial support is fine and honest:
list only the verbs you actually implement. A provider that claims a verb and silently
does nothing is the worst possible outcome, because the report will say the write
succeeded.
