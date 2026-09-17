# Authorization Policy

Machine-readable source of truth: `engine/authorization/policy.json`. This document
explains it; the JSON enforces it.

## Principles

1. **Reading is free; writing is earned.**
2. **Authorisation is per-action and per-session.** Approving one issue does not approve
   the next one. "Yes, file it" is not "yes, file everything".
3. **An action is done only when the provider confirms it.** Otherwise it is
   `INCONCLUSIVE` and reported as attempted.
4. **Never assign work to a human the agent picked.**
5. **Prefer the safe environment.** If none exists, that is a blocker — not a reason to
   use production.

## Levels

| Level | Meaning |
| --- | --- |
| `none` | Read-only, workspace-local. Go ahead. |
| `workspace-only` | May write inside the repository working tree only. |
| `explicit` | Needs the user to authorise **this** action **this** session. |
| `explicit-named-assignee` | Needs authorisation **and** a named account. |
| `non-production-only` | Only against an environment the profile classifies as non-production. |
| `prohibited-by-default` | Refuse. Proceed only if the user restates it knowing the consequence. |

Check before acting:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" auth check --json '{"action":"github.create_issue","target":"owner/repo","userAuthorised":true,"authorisationQuote":"yes, open an issue"}'
```

An action absent from the policy is **denied**. Add it deliberately rather than routing
around the gate.

## Prohibited by default

Merging PRs · closing issues · deleting anything · force pushes · Jira transitions ·
production database access · sending real email or SMS · executing payments · running
deployments · destructive migrations · executing untrusted scripts.

These stay prohibited even when the user says yes in passing. If they genuinely want it,
they restate it after you have named the consequence.

## Environment classification

An environment is non-production **only** when the repository profile says so. Unknown is
treated as production.

> Mistaking staging for production costs a wasted question.
> Mistaking production for staging costs an incident.

`localhost`, `staging`, `sandbox` and similar are heuristics for a *warning*, not a
permission.

## Load and security testing

Load traffic is indistinguishable from an attack; active security scanning is an
intrusion attempt. Both need explicit authorisation from whoever owns the target, plus a
non-production target. Never point either at a host you were not told to test.

## Forbidden patterns

| Pattern | Instead |
| --- | --- |
| Changing product code, config or an assertion to make a test pass | Record the finding. A failing test that reflects a real defect **is** the deliverable. |
| Creating a screenshot, log, trace or result that did not come from a real run | Report `BLOCKED` or `NOT_APPLICABLE`. |
| Reporting an external write as successful without a provider identifier | Report `INCONCLUSIVE`, record what was attempted. |
| Inferring an assignee from CODEOWNERS, `git blame` or seniority | Leave unassigned; tell the user the candidates. |
| Writing credentials into state, reports or issue bodies | Redaction masks known shapes — but do not deliberately capture secret material as evidence. |

## Before every external write

1. Verify the **target** — right repository, right issue, right document.
2. Verify **authorisation** — `auth check`.
3. Verify the **content** — render it and read it before sending.
4. Check the **ledger** — `write check`, to avoid a duplicate.
5. Perform the action.
6. Record the **provider's response** — `write record`, with `confirmed` set from the
   response, not from hope.

## Secrets

Everything persisted passes through redaction, which masks known token shapes (GitHub
PATs, bearer tokens, JWTs, AWS keys, private key blocks, URL credentials) and
sensitive-looking field names. It cannot recognise a secret that looks like ordinary
text, so it is defence in depth, not a licence to capture credentials.

Never paste a secret into an issue body, a test fixture, a report or a commit.
