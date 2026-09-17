# Workflow: Reporting

Goal: a report whose confidence exactly matches its evidence.

The Markdown report is **rendered from the JSON record**, which is derived from state on
disk. You never hand-write it. That is the mechanism: if a claim is not in the data,
there is no code path that puts it in the document.

## 1. Turn observations into findings

Only things a human should act on. Delegate wording to the `defect-reporting` skill, or:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" finding add --input finding.json
```

Findings are fingerprinted on `(component, normalised title, expected, actual)`, so the
same defect discovered again in a later session is recognised as a duplicate even if you
phrase it differently.

A finding is not automatically an issue. Kind `observation` never becomes one.

## 2. Decide what gets filed externally

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" finding promote FIND-00001 --authorised --quote "yes, open a GitHub issue for that"
```

`may_file: false` means stop and read the blockers. Common ones:

- duplicate fingerprint — comment on the existing issue instead
- the same write already confirmed in the ledger
- no explicit user authorisation in **this** session
- kind is `observation`

Warnings do not block, but they change what you write: low confidence must lead the issue
body, and unverified reproduction must be stated plainly.

## 3. Perform the write through the adapter

**Do not run `gh` yourself.** The adapter runs the whole protocol in order — capability,
authorisation, duplicate ledger, render, perform, parse, record, evidence — and there is no
path to a ledger entry that skips a gate.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" github preflight                                   # scope, not just auth
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" github file-issue FIND-00001 --repo owner/name --dry-run
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" github file-issue FIND-00001 --repo owner/name --authorised --quote "yes, open it" --decision DEC-00011
```

`confirmed: true` is derived by parsing GitHub's own response for an issue number — never
from an exit code. A status of `INCONCLUSIVE` means it ran and no identifier came back:
report it as attempted, not done, and verify the target before any retry.

**Assignment:** never pick the person. Not from CODEOWNERS, not from `git blame`, not from
who seems responsible. The adapter refuses without a user-named account.

**If the capability resolves to an MCP server**, the adapter runs the gates and hands you a
ticket plus the rendered content; you perform the call and finish with
`ast adapter complete --ticket WT-…`. Until then nothing is recorded.

Systems with an executable adapter: `ast adapter systems`. Jira and Google Docs have
written contracts but no module yet — for those, follow
[../../../integrations/jira/adapter.md](../../../integrations/jira/adapter.md) by hand and
record the outcome with `ast write record`.

## 4. Generate the report

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" report generate --input report-context.json
```

Context may carry the plan, the risk assessment, the applicability matrix and your
recommendations. Everything else comes from state.

The report always contains:

- **What was NOT tested** — near the top, not in an appendix
- Every execution with its status and failure classification
- The evidence index, with hashes
- External writes with their confirmation state
- Blocked, deferred and interrupted work as separate sections
- The uncertainty register
- Evaluation metrics with their denominators
- An **integrity self-audit** stating this report's own false-confidence rate

## 5. Validate before you speak

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" validate
```

Fix everything it reports. Dangling evidence references and still-open executions are
real defects in the record, not cosmetic.

## 6. The external documentation layer

If a documents capability resolved, maintain **one canonical testing log** and append to
it — do not create a document per action. If no provider resolved, the fallback is the
versioned Markdown under `state/reports/`, and you say plainly that the external log was
not updated. See [../../../integrations/google/README.md](../../../integrations/google/README.md).

Each reporting cycle records: session, repository, commit/branch/PR, skill version,
timestamp, goals, completed/failed/blocked/deferred/skipped/not-applicable work,
interruptions, uncertainties, decisions, tools used, evidence, findings, issues created,
tests added, coverage change, remaining work, next recommended action.

## 7. What you say to the user

In this order:

1. **What you proved**, with the scenario and the evidence — not "checkout works".
2. **What failed**, with the classification and confidence.
3. **What you could not do**, and what would unblock it.
4. **What remains untested**, including anything the plan deferred.
5. **What you recommend next**, one clear action.

Lead with the limitation. A user who believes you tested more than you did is worse off
than one who knows exactly what you covered.
