# Evidence Policy

The rule the whole system is built around:

> **"I did not observe a failure" is not "it works."**

## Epistemic classes

Every claim carries how you came to hold it. Never promote one to another.

| Class | Meaning | Can support PASSED? |
| --- | --- | --- |
| `verified` | Executed and independently confirmed | Yes |
| `observed` | You saw it happen in this session | Yes |
| `reported-by-user` | Someone told you | No |
| `inferred` | You reasoned to it from other facts | No |
| `expected` | It is what should happen | No |
| `assumed` | You proceeded as if it were true | No |

Inference is legitimate and useful. Reporting an inference as an observation is not.

## What supports a claim

**Execution evidence** — sufficient on its own:
command output · test report · assertion results · trace · HAR · coverage report ·
static analysis · dependency scan · accessibility scan · performance metric ·
database snapshot

**Corroborating evidence** — never sufficient alone:
screenshots · video · console logs · server logs · network requests · screenshot diffs ·
diffs · file contents · GitHub/Jira objects · document revisions · external API responses

**Not execution evidence at all:**
user statements. Testimony, not verification.

A screenshot shows what a page looked like. It does not show that an assertion held.

## The gate

`exec finish` runs this automatically; you can run it directly:

```bash
node bin/ast.mjs evidence verify --json '{"status":"PASSED","evidenceIds":["EV-2026-00031"]}'
```

`PASSED`, `FAILED`, `COMPLETED` and `PARTIAL` all claim something was executed, so all
four require evidence. A claim that fails the gate is downgraded to `INCONCLUSIVE` with
the reason recorded. Do not argue with the downgrade — attach the evidence or accept it.

## What to capture

Whenever available: the exact command · timestamp · commit SHA · branch · environment ·
browser and version · viewport · test framework · logs · screenshots · video · traces ·
network results · console errors · assertion results · generated artefacts · GitHub,
Jira and document references.

Large artefacts stay on disk. State holds a path, a size, a SHA-256 and a redacted
excerpt. Registering an artefact that does not exist is an error — the engine checks.

## Reproducibility

A result nobody can re-run is an anecdote. The `reproducibility` metric counts executions
carrying commit **and** environment **and** command. Supply all three.

## Writing the claim

Language matters because it is what the user remembers.

| Don't | Do |
| --- | --- |
| "Checkout works." | "TC-00014 (guest checkout, card) ran against `abc1234`; all 6 assertions passed — `EV-2026-00031`." |
| "No issues found." | "The 3 scenarios I ran passed. 5 planned scenarios did not run: 2 blocked on credentials, 3 deferred for budget." |
| "Tests pass." | "`npm test` exited 0: 87/87 unit tests at `abc1234` — `EV-2026-00012`. There is no integration or E2E coverage in this repository." |
| "Accessibility is fine." | "Automated axe scan found 0 violations on 4 pages — `EV-2026-00040`. Automated scanning catches roughly a third of WCAG issues; keyboard traps and focus order were not manually checked." |

The engine warns when a status reason contains "works", "fine", "all good" or "no issues"
without naming a scenario or an assertion. Take the warning seriously.

## Self-audit

Every report states its own false-confidence rate:

```
false_confidence_rate = unverified PASSED claims / total PASSED claims
```

The target is 0. Anything above it is a defect in the report, not a performance score.
