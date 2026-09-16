---
name: test-reporting
description: Produce the testing report and maintain the versioned testing log — executive summary, evidence index, findings, blocked, deferred and interrupted work, coverage gaps, traceability, evaluation metrics and an integrity self-audit. Use when testing is finished or paused, when the user asks what was tested, or when the external testing documentation needs updating.
when_to_use: "write the test report", "summarise the testing", "what did you test", "update the testing log", "what remains untested"
allowed-tools: Read, Glob, Grep, Bash, PowerShell, Write
metadata:
  system_version: 0.5.0
  role: specialist
---

# Test Reporting

The report is **rendered from the JSON record**, never hand-written. That is the mechanism
that stops prose outrunning evidence: if a claim is not in the data, no code path puts it
in the document.

```bash
node bin/ast.mjs report generate --input report-context.json
node bin/ast.mjs validate
```

## Structure

1. Executive summary · 2. Repository context · 3. Testing goals · 4. Risk assessment ·
5. Applicable categories · 6. Execution summary · 7. Detailed results · 8. Evidence index ·
9. Findings · 10. External writes · 11. Blocked · 12. Deferred · 13. Interrupted ·
14. Uncertainty register · 15. Coverage gaps · 16. Remaining work · 17. Recommendations ·
18. Decision history · 19. Evaluation metrics · 20. Integrity self-audit

Section 20 is the one that matters most. A report that cannot state its own
false-confidence rate is not trustworthy.

## "What was NOT tested" goes near the top

Not in an appendix. A reader who stops after the summary must still know the boundary of
what you covered. It is assembled automatically from the not-applicable categories and
every `BLOCKED` / `SKIPPED` / `DEFERRED` / `NOT_APPLICABLE` execution — which is why those
must be recorded as executions rather than dropped.

## Writing the summary

| Don't | Do |
| --- | --- |
| "Testing complete, everything passes." | "6 of 11 planned scenarios executed. 5 passed, 1 failed (`FIND-00003`, critical). 3 blocked on payment credentials, 2 deferred for budget." |
| "No issues found." | "The 3 scenarios I ran found no failures. That covers the guest checkout happy path only — declined cards, saved cards and the logged-in path were not tested." |
| "Coverage improved." | "Added 4 Playwright specs covering the checkout happy path and 3 error branches. Line coverage of `src/checkout` went from 34% to 61% (`EV-2026-00033`)." |

The engine warns when a status reason says "works", "fine" or "no issues" without naming a
scenario or assertion. Take the warning seriously.

## The metrics section

Every metric prints with its denominator. A ratio over a sample of 2 is noise, and a null
means the denominator was zero — which is honest and must not be replaced with 0 or 1.

Metrics that indicate a **problem**, not a score:

- `false_confidence_rate > 0` — a claim in this report is not supported by its evidence.
  Fix it before delivering.
- `authorization_compliance < 1` — a write was performed without explicit authorisation.
  That is a policy violation.
- `flaky_identification_quality < 1` — something was called flaky on fewer than three runs.

## The external testing log

If a documents capability resolved, maintain **one canonical log** and append to it. Do not
create a document per action. If none resolved, the fallback is the versioned Markdown under
`state/reports/`, and you say plainly that the external log was not updated.

Each cycle appends: session ID · repository · commit/branch/PR · skill version · timestamp ·
goals · completed / failed / blocked / deferred / skipped / not-applicable work ·
interruptions · uncertainties · decisions · tools used · evidence references · findings ·
issues created · tests added or modified · coverage change · remaining work · next
recommended action.

Recommended documents, if the connector supports it: Testing Strategy · Testing Goals ·
Baseline · Execution Log · Findings · Evidence Index · Final Report · Decision History ·
Uncertainty Register · Future Testing Backlog. See
[../../integrations/google/README.md](../../integrations/google/README.md).

## Versioning

`REPORT-2026-00142`. A new report supersedes rather than overwrites, and carries
`supersedes` pointing at the previous one. Every report records the skill version that
produced it, so a behavioural change in the agent can be traced to the reports it affected.

## Before you deliver

```bash
node bin/ast.mjs validate
```

Fix everything it reports. Dangling evidence references and still-open executions are real
defects in the record.

Then check by hand:

- Does every `PASSED` name a scenario and cite evidence?
- Is every blocked item present with a next action?
- Is every external write marked confirmed or not, truthfully?
- Does "what was not tested" actually list what you did not test?
- Would a reader come away with an accurate picture of your confidence?

## Speaking to the user

In this order: what you proved · what failed · what you could not do · what remains
untested · what you recommend next.

**Lead with the limitation.** A user who believes you tested more than you did is worse off
than one who knows exactly what you covered.
