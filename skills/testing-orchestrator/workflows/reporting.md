# Workflow: Reporting

Goal: a report whose confidence exactly matches its evidence.

The Markdown report is **rendered from the JSON record**, which is derived from state on
disk. You never hand-write it. That is the mechanism: if a claim is not in the data,
there is no code path that puts it in the document.

## 1. Turn observations into findings

Only things a human should act on. Delegate wording to the `defect-reporting` skill, or:

```bash
node bin/ast.mjs finding add --input finding.json
```

Findings are fingerprinted on `(component, normalised title, expected, actual)`, so the
same defect discovered again in a later session is recognised as a duplicate even if you
phrase it differently.

A finding is not automatically an issue. Kind `observation` never becomes one.

## 2. Decide what gets filed externally

```bash
node bin/ast.mjs finding promote FIND-00001 --authorised --quote "yes, open a GitHub issue for that"
```

`may_file: false` means stop and read the blockers. Common ones:

- duplicate fingerprint — comment on the existing issue instead
- the same write already confirmed in the ledger
- no explicit user authorisation in **this** session
- kind is `observation`

Warnings do not block, but they change what you write: low confidence must lead the issue
body, and unverified reproduction must be stated plainly.

## 3. Perform the write, then record what actually happened

Check the ledger **before**:

```bash
node bin/ast.mjs write check --json '{"system":"github","action":"github.create_issue","idempotencyKey":"<fingerprint>"}'
```

Render the body, create the issue through the resolved provider, then record the outcome
using the provider's own response:

```bash
node bin/ast.mjs finding render FIND-00001
node bin/ast.mjs write record --json '{
  "system":"github","action":"github.create_issue","idempotencyKey":"<fingerprint>",
  "target":"owner/repo","confirmed":true,"resultId":"#412",
  "url":"https://github.com/owner/repo/issues/412","authorisedBy":"user-explicit","decisionId":"DEC-00011"
}'
```

Set `confirmed: true` **only** when the provider returned an identifier. If the call
errored, timed out, or you cannot tell — record it with `confirmed: false` and the error.
The report prints it as `NOT CONFIRMED`, and that is the correct outcome, not a failure
of the report.

**Assignment:** never pick the person. Not from CODEOWNERS, not from `git blame`, not
from who seems responsible. The user names the account or it stays unassigned.

## 4. Generate the report

```bash
node bin/ast.mjs report generate --input report-context.json
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
node bin/ast.mjs validate
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
