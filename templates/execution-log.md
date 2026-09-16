# Execution Log entry — {{EXECUTION_ID}}

The canonical record is JSON (`schemas/execution.schema.json`, stored in
`state/executions/`). This is the human-readable rendering used in the external testing log.

```jsonc
{
  "execution_id": "EXEC-2026-00142",
  "session_id": "SESSION-0031",
  "decision_id": "DEC-00042",
  "started_at": "2026-09-16T14:02:11Z",
  "finished_at": "2026-09-16T14:02:29Z",
  "duration_ms": 18342,
  "git": { "repository": "shop", "branch": "feat/checkout", "commit": "abc1234", "dirty": false },
  "goal": "Guest checkout with a test card creates an order",
  "test_category": "e2e",
  "method": "playwright-script",
  "command": "npx playwright test checkout --reporter=json --trace=on",
  "environment": "local-docker",
  "status": "FAILED",
  "status_reason": "Order was not persisted after a successful payment.",
  "totals": { "total": 1, "passed": 0, "failed": 1, "skipped": 0, "errored": 0 },
  "evidence": ["EV-2026-00021", "EV-2026-00022"],
  "findings": ["FIND-00003"],
  "failure_classification": {
    "class": "product-defect",
    "confidence": 0.7,
    "signals": ["assertion-mismatch", "data-not-persisted"],
    "evidence_refs": ["EV-2026-00021"]
  },
  "next_action": "Raise a finding. Do not modify product code to make the test pass."
}
```

## Rendered form

### EXEC-2026-00142 — FAILED

**Goal** Guest checkout with a test card creates an order
**Method** playwright-script · **Category** e2e · **Duration** 18.3s
**Commit** `abc1234` on `feat/checkout` · **Environment** local-docker
**Command** `npx playwright test checkout --reporter=json --trace=on`

**Result** Order was not persisted after a successful payment.

**Classification** product-defect (confidence 0.70) — signals: assertion-mismatch,
data-not-persisted

**Evidence**
- `EV-2026-00021` test-report — playwright: 0/1 passed — `sha256:…`
- `EV-2026-00022` trace — `test-results/checkout/trace.zip` — `sha256:…`

**Findings** `FIND-00003`
**Decision** `DEC-00042`
**Next action** Raise a finding. Do not modify product code to make the test pass.

---

## Notes on the fields

**Open before, close after.** The record is created with `exec start` before the work
begins. That is what makes an interrupted session recoverable: a record still saying
`PARTIAL` with no `finished_at` means the run did not complete, and recovery marks it
`INTERRUPTED` rather than inferring an outcome.

**`method: "not-executed"`** is legitimate and important. It is how `BLOCKED`, `SKIPPED`
and `NOT_APPLICABLE` work becomes a first-class record instead of vanishing from the report.

**`status` is checked against `evidence`.** Claiming `PASSED` with no execution evidence
gets downgraded to `INCONCLUSIVE` with the reason appended to `status_reason`.

**Reproducibility** requires `git.commit` **and** `environment` **and** `command`. A result
missing any of the three cannot be re-run by anyone else, and the metric counts it as such.
