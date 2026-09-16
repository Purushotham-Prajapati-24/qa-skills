# Software Testing Report — {{REPORT_ID}}

> **Do not hand-write this file.** It is rendered by
> `node bin/ast.mjs report generate` from records under `state/`. This template exists so
> you can see the shape and know what each section is for.
>
> The rendering is the mechanism: if a claim is not in the data, no code path puts it in
> the document.

**Status** {{OVERALL}} · **Session** {{SESSION-ID}} · **Generated** {{ISO-8601}}
**Skill version** {{v0.5.0}} · **Report schema** {{v1.0.0}} · **Supersedes** {{REPORT-…}}

---

## 1. Executive summary

{{headline: "N executions run, M defect findings, K items explicitly not tested."}}

- {{key point}}

### What was NOT tested

*This section is not an appendix. Read it before drawing any conclusion from the results
above.*

- {{category}}: {{reason it is not applicable}}
- {{goal}} — BLOCKED: {{reason}}

## 2. Repository context

| Repository | Branch | Commit | PR | Uncommitted changes |
| --- | --- | --- | --- | --- |

## 3. Testing goals

| Goal | Description | Success criterion | Status | Evidence |
| --- | --- | --- | --- | --- |

## 4. Risk assessment

**Score** {{0.00}} ({{level}}) · **Profile** {{…}} · **Assessment confidence** {{0.00}}

| Factor | Value | Weight | Contribution | Basis class | Why |
| --- | --- | --- | --- | --- | --- |

*Excluded for lack of evidence (not scored, not guessed): …*

## 5. Test applicability matrix

| Category | Applicable | Priority | Existing coverage | Score | Reason |
| --- | --- | --- | --- | --- | --- |

## 6. Execution summary

| Status | Count |
| --- | --- |

Total executions {{N}} · Test cases {{M}} · Wall clock {{ms}}

## 7. Detailed results

| Execution | Goal | Category | Method | Status | Failure class | Evidence |
| --- | --- | --- | --- | --- | --- | --- |

## 8. Evidence index

| ID | Kind | Summary | Artifact |
| --- | --- | --- | --- |

## 9. Findings

## 10. External writes

| System | Action | Target | Provider confirmation | Authorised by | Reference |
| --- | --- | --- | --- | --- | --- |

*An unconfirmed write means the agent attempted it and did not receive a success response.
It is reported as attempted, never as done.*

## 11. Blocked work
## 12. Deferred work
## 13. Interrupted work
## 14. Uncertainty register
## 15. Coverage gaps

*"None identified" is not "none exist".*

## 16. Remaining work
## 17. Recommendations
## 18. Decision history

## 19. Evaluation metrics

| Metric | Value | Direction |
| --- | --- | --- |

*Sample sizes printed alongside. A `null` means the denominator was zero — honest, and not
to be replaced with 0 or 1.*

## 20. Report integrity self-audit

| Unevidenced PASSED claims | False confidence rate |
| --- | --- |

**Checks run**
- every PASSED/COMPLETED claim checked against attached evidence
- external writes checked for provider confirmation
- unfinished executions surfaced as INTERRUPTED
- not-applicable categories listed with reasons

---

Produced by the Autonomous Software Testing skill system {{version}}. Every status in this
document is traceable to a record under `state/`.
