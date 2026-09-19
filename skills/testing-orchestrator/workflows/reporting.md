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

## 4. Run the evidence-auditor before you generate the report

**Required, not optional.** `ast report generate` (below) computes `false_confidence_rate`
from evidence *kind and attachment* — it cannot tell a test report with a real failure
apart from one that asserts nothing, or catch a status reason that says "works" without
naming a scenario. That is exactly what `evidence-auditor` is for, and skipping it is
easiest exactly when a report is about to overstate something.

Launch it (Task tool, `evidence-auditor`) before every report generation. Then record that
it ran, so the omission is visible on any session that skips it instead of looking identical
to one that didn't:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" evidence add --input '{
  "kind": "evidence-audit",
  "summary": "evidence-auditor reviewed N claims; found <M issues | nothing unsupported>",
  "epistemicClass": "observed",
  "excerpt": "<the auditor'"'"'s findings, verbatim>"
}'
```

Recorded the audit under the wrong `kind` (e.g. `other`) and only noticed after
`evidence_auditor_run` came back `false`? Fix the existing record — `ast evidence amend
<id> --kind evidence-audit` — rather than adding a second, correctly-typed one. Two records
for one audit both render in the final report as if two audits happened.

If the auditor flagged a claim, downgrade it (`ast exec update` / re-file the finding)
**before** generating the report — the report renders from state, so a claim fixed after
the report is generated does not retroactively fix the report.

A report generated without this record still gets produced — `report generate` does not
block on it, because nothing in this codebase can force a subagent launch — but its
`integrity.evidence_auditor_run` will read `false` and `audit_coverage` will read `0`. Both
are counted as a report defect. Do not treat a missing-audit report as equivalent to one
with a clean audit.

## 5. Generate the report

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

## 6. Validate before you speak

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" validate --final
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" report verify <the markdown_path report generate just printed>
```

Fix everything `validate` reports. Dangling evidence references and still-open executions
are real defects in the record, not cosmetic. `--final` additionally turns a blocking
process gap — no decision records anywhere in the session; blocked work never raised as an
uncertainty — into a failure instead of a warning. Both are real at this point in the
session: there is no "still in progress" excuse left once you are about to speak.

`report verify` proves the exact file you are about to hand the user is the one this
renderer produced — not your summary of it, not an edited copy. Rule 4 (this skill's
overriding rules) exists because that distinction is the entire point of rendering from
state in the first place: a report a hand could have written is a report a hand should be
suspected of having written, until this check says otherwise.

## 7. The external documentation layer

If a documents capability resolved, maintain **one canonical testing log** and append to
it — do not create a document per action. If no provider resolved, the fallback is the
versioned Markdown under `state/reports/`, and you say plainly that the external log was
not updated. See [../../../integrations/google/README.md](../../../integrations/google/README.md).

Each reporting cycle records: session, repository, commit/branch/PR, skill version,
timestamp, goals, completed/failed/blocked/deferred/skipped/not-applicable work,
interruptions, uncertainties, decisions, tools used, evidence, findings, issues created,
tests added, coverage change, remaining work, next recommended action.

## 8. What you say to the user

In this order:

1. **What you proved**, with the scenario and the evidence — not "checkout works".
2. **What failed**, with the classification and confidence.
3. **What you could not do**, and what would unblock it.
4. **What remains untested**, including anything the plan deferred.
5. **What you recommend next**, one clear action.

Lead with the limitation. A user who believes you tested more than you did is worse off
than one who knows exactly what you covered.
