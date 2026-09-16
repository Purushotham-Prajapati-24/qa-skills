# GitHub integration

The testing engine never talks to GitHub directly. It asks the capability registry for a
verb, and the registry resolves it to whichever provider actually exists.

```
skill  →  github.create_issue  →  capability-registry  →  mcp-github  |  gh-cli  |  (none)
```

If none resolve, the capability is **unavailable**. The affected work is reported as
`BLOCKED` — never simulated, never assumed to have happened.

## Providers, in resolution order

**1. `mcp-github`** — the official GitHub MCP server. Richest surface, but it usually
needs an OAuth flow that cannot run in a non-interactive session. Because this module
cannot see your tool list, you must declare it:

```bash
node bin/ast.mjs caps declare mcp-github true --note "mcp__github__* tools present"
```

**2. `gh-cli`** — the GitHub CLI. Probed automatically with `gh auth status`. In practice
this is the provider that works most often, because developers already have it
authenticated.

**Check the token scopes**, not just that auth succeeded. `gh auth status` prints them.
`repo` covers issues and PRs; without it, reads may work while writes fail — and a write
that fails must be recorded `confirmed: false`, not retried until something sticks.

```bash
node bin/ast.mjs caps probe
node bin/ast.mjs caps resolve github.create_issue
```

## Capability surface

| Verb | Write? | Authorisation |
| --- | --- | --- |
| `github.read_repo` | no | none |
| `github.read_pr` | no | none |
| `github.list_changed_files` | no | none |
| `github.search_issues` | no | none |
| `ci.read_runs` | no | none |
| `github.create_issue` | **yes** | explicit, idempotent on the finding fingerprint |
| `github.update_issue` | **yes** | explicit |
| `github.comment` | **yes** | explicit |
| `github.assign_issue` | **yes** | explicit **and** a user-named account |
| `github.close_issue` | **yes** | prohibited by default |
| `github.merge_pr` | **yes** | prohibited by default |

## Assignment — the rule that matters

**The agent never chooses who work is assigned to.** Not from CODEOWNERS, not from
`git blame`, not from who touched the file last, not from seniority.

```bash
# Refused — authorised, but no account named
node bin/ast.mjs auth check --json '{"action":"github.assign_issue","userAuthorised":true,"assignee":null}'
# Allowed — the user named the account
node bin/ast.mjs auth check --json '{"action":"github.assign_issue","userAuthorised":true,"assignee":"octocat"}'
```

Assigning work to a real person on a guess is the kind of mistake that is both wrong and
socially costly. The correct move is to leave it unassigned and tell the user the
candidates you saw.

## The write protocol

Every write, without exception:

```bash
# 1. Verify authorisation
node bin/ast.mjs auth check --json '{"action":"github.create_issue","target":"owner/repo","userAuthorised":true,"authorisationQuote":"yes, open an issue for that"}'

# 2. Check the ledger for a duplicate
node bin/ast.mjs write check --json '{"system":"github","action":"github.create_issue","idempotencyKey":"<finding fingerprint>"}'

# 3. Render and READ the content before sending it
node bin/ast.mjs finding render FIND-00001

# 4. Perform it through the resolved provider
gh issue create --repo owner/repo --title "..." --body-file body.md --label bug

# 5. Record the provider's actual response
node bin/ast.mjs write record --json '{"system":"github","action":"github.create_issue","idempotencyKey":"<fingerprint>","target":"owner/repo","confirmed":true,"resultId":"#412","url":"https://github.com/owner/repo/issues/412","authorisedBy":"user-explicit","decisionId":"DEC-00011"}'
```

`confirmed: true` requires an identifier from GitHub. If the command errored, timed out,
or you cannot tell — `confirmed: false` with the error. The report prints `NOT CONFIRMED`,
which is the honest outcome.

## Idempotency

Keyed on the finding's fingerprint — a hash of `(component, normalised title, expected,
actual)`. Rewording the title in a later session does not create a second issue.

Before creating, also search for an existing human-filed issue:

```bash
gh issue list --repo owner/repo --search "order not persisted in:title" --state all
```

Duplicate issue spam is the fastest way for a team to disable a testing agent.

## Reading a pull request

```bash
gh pr view 412 --json title,body,files,additions,deletions,baseRefName,headRefName,commits
gh pr diff 412
gh run list --branch feat/checkout --limit 5
gh run view <id> --log-failed
```

## Rate limits and failure modes

| Failure | Handling |
| --- | --- |
| 401 / 403 | Capability is unavailable. Report `BLOCKED`. Do not retry with a different credential. |
| 404 on a private repo | Usually a scope problem, not a missing repo. Say which it might be. |
| 429 | Back off once, then report `BLOCKED`. Do not hammer. |
| Network error mid-write | **Do not retry blindly** — the write may have landed. Record `confirmed: false`, then verify by searching before any retry. |

## Adding another provider

1. Add it under `providers` in `engine/capability-registry/capabilities.json` with a probe.
2. Add its name to the `providers` list of each verb it supports, in preference order.
3. Document its authorisation model and failure modes here.

No skill changes. That is the point of the indirection.

See also [adapter.md](adapter.md) for the exact contract.
