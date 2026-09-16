# Testing Report · {{REPORT_ID}}

> **Do not hand-write this file.** It is rendered by `node bin/ast.mjs report generate`
> from records under `state/`. This template exists so you can see the shape and know what
> each part is for.
>
> The rendering is the mechanism: if a claim is not in the data, no code path puts it in
> the document.

---

## The shape, and why

The report is an **inverted pyramid**. A reader who stops after thirty seconds should still
come away with an accurate picture.

```
Header      verdict in one line, plus the facts that make it checkable
Verdict     the 3-5 things a human must know
Needs attention   findings, in full, worst first        <- the point of the document
What was proven   passed executions, each with evidence
What was not tested   planned-but-not-run, then grouped not-applicable
Open questions / Remaining work / Recommended next
---
Detail      executions, evidence, external writes, decisions, observations
---
Appendix    risk, applicability matrix, goals, metrics, integrity self-audit
```

Two rules do most of the work:

**An empty section is not rendered.** A heading over nothing trains the reader to skim past
headings, which then hides the sections that do have content. The old format rendered 20
numbered sections of which 7 were routinely empty.

**Findings are rendered with their content, not as identifiers.** The most important
section of a testing report should not be a list of lookups the reader will not perform.

---

## Header

```markdown
# Testing Report · REPORT-2026-00142

**FAILED** — 3 executions run · 7 findings, worst critical · 4 planned items not run.

| Session | Repository | Commit | PR | Generated | Skill |
| --- | --- | --- | --- | --- | --- |
| SESSION-0031 | acme/shop (feat/checkout) | abc1234 | #412 | 2026-09-16 11:16Z | v0.6.0 |

_Supersedes REPORT-2026-00141._
```

One bold verdict line with the numbers that matter, then the facts that let someone check
it. Nothing else competes for the top of the page.

## Needs attention

A severity roll-up table, then each finding in full, worst first:

```markdown
### Critical

#### FIND-00001 — Order is not persisted after a successful payment

`checkout/payment` · reproduced 3/3 (always) · confidence 0.82

Payment is captured but no order row is created, so the customer is charged with no record.

| Expected | Actual |
| --- | --- |
| An order row exists with total_cents = 1250 | `SELECT count(*) FROM orders` returns 0 |

**Impact.** Customer is charged and receives nothing. Requires a manual refund.

**Next.** Check the transaction boundary in `src/orders/create.ts:88`.

_Evidence: EV-2026-00021, EV-2026-00022 · github: https://github.com/acme/shop/issues/418_
```

A finding below 0.6 confidence leads with a blockquote saying so. Observations and
suppressed duplicates are **not** here — they sit in Detail, because they are not asking
anyone to do anything.

## What was proven

Only `PASSED` and `COMPLETED` executions, each with its evidence, and one line making the
boundary explicit: *nothing else in this report is a claim that something works.*

## What was not tested

Two kinds, treated differently because they are different:

- **Planned, not run** — one line each. Specific and actionable.
- **Not applicable** — grouped by reason. Thirty repetitions of "no matching repository
  signal" bury the four lines a reader needs; the full per-category list stays in the
  appendix.
- **Coverage gaps** — where an applicable category has no existing coverage.

## Detail

Executions, evidence index, external writes, decisions, observations, suppressed
duplicates, automation added. Each subsection appears only when it has rows.

External writes show `CONFIRMED` or `NOT CONFIRMED` — an unconfirmed write was attempted
and never acknowledged by the provider, and it is reported as attempted, never as done.

## Appendix

Risk assessment with every contribution itemised, the full applicability matrix, goals,
evaluation metrics, and the integrity self-audit.

The self-audit states the report's own **false-confidence rate**. A report that cannot
audit itself is not trustworthy.
