# Debugging the agent

When the agent does something you disagree with, the answer is always in a file. Nothing
here is hidden state.

## Start here

```bash
node bin/ast.mjs session show        # where it thinks it is
node bin/ast.mjs validate            # schema + referential integrity across all records
node bin/ast.mjs metrics             # the honesty numbers
node bin/ast.mjs decision list       # every choice it made, with reasons
```

`ast validate` is the first thing to run. Dangling evidence references and still-open
executions are real defects in the record, and they explain a surprising number of odd
behaviours downstream.

## "It tested the wrong things"

Applicability comes from **signals**, which come from the **profile**. Work backwards:

```bash
node bin/ast.mjs profile signals                                   # what it believes about the repo
node bin/ast.mjs applicability eval --input applicability.json     # what it did with that
```

Read the `reason` on the row you disagree with. It will say either "no signal for this
category" or which signals matched.

- **Wrong signal** → fix the profile. Do not override the applicability verdict; that hides
  the error and it recurs next session.
- **Right signal, wrong weight** → the category's `cost` or `addresses` in
  `engine/applicability-engine/catalog.json`.
- **Category missing entirely** → add it to the catalog. See [extending.md](extending.md).

## "The risk score is wrong"

```bash
node bin/ast.mjs risk score --input factors.json --explain
```

The explanation itemises every contribution. Three usual causes:

1. **Wrong profile.** `balanced` on a payments repository under-weights irreversibility.
   Check `weights_profile` in the output.
2. **Low confidence.** If `confidence` is 0.3, the score reflects a third of the picture.
   The fix is more evidence, not a different number.
3. **A factor you care about is in `unscored_factors`.** It had no evidence, so it was
   excluded rather than guessed. That is working as designed — supply it.

## "It picked the wrong browser method"

```bash
node bin/ast.mjs browser decide --input factors.json
```

The output contains every candidate with its score, its eligibility, and every hard rule
that fired. Read `blocked_because` before `score` — a method may have been removed
entirely rather than out-scored.

`escalate: true` means the top two were within 0.05 and the engine refused to guess —
`selected` is `null` whenever this fires, on purpose. If you see a real value in `selected`,
the engine did not escalate; do not treat `top_candidate` (present only while escalating) as
an answer to use instead.

If the decision was made in a past session:

```bash
node bin/ast.mjs trace query why-this-method EXEC-2026-00003
```

## "It claimed something passed that didn't"

This is the failure the system exists to prevent, so it leaves a trail:

```bash
node bin/ast.mjs evidence verify --json '{"status":"PASSED","evidenceIds":["EV-2026-00031"]}'
node bin/ast.mjs metrics | grep false_confidence
```

Any `false_confidence_rate` above 0 is a defect in the report. Find the offending claim in
the report's integrity section — it lists violations by execution ID.

If the claim got through the gate, the gate has a bug. That is worth a test in
`tests/lifecycle.test.mjs`.

For an adversarial second opinion, the `evidence-auditor` subagent exists to look for
exactly this.

## "The report doesn't look like it was actually rendered"

```bash
node bin/ast.mjs report verify state/reports/REPORT-2026-00001.md
```

`rendered: false` and a `reason` naming which of three things went wrong:

- **No title line found** — this text was not produced by this renderer at all (hand-written).
- **No stored record**, or **digest does not match its own content** — the `report_id` in
  the title does not resolve in this state directory, or the stored record was edited on
  disk after being written.
- **Does not reproduce this text byte for byte**, with a `first_diff_line` — the text was
  edited after rendering. Diff that line against `ast report show <ID>` re-rendered fresh.

A digest mismatch on a report you are certain you never touched by hand is worth checking
against `engine/core/redact.mjs`'s `SAFE_KEYS` first: a field name that collides with
`KEY_HINTS` gets silently mangled by `redact()` on every write, which changes the stored
record without anyone editing anything. That is exactly how `authorization_compliance`
was found — `report verify`'s own first real run caught it.

## "It stopped too early"

Check whether it genuinely had nothing to do:

```bash
node bin/ast.mjs uncertainty list
node bin/ast.mjs uncertainty partition --input scenarios.json
```

If `runnable` is non-empty and it stopped anyway, it ignored
[escalation-policy.md](../skills/testing-orchestrator/policies/escalation-policy.md). The
`independent_work_continued` field on each uncertainty is the evidence of whether it kept
going.

## "It wrote to GitHub/Jira when it shouldn't have"

```bash
node bin/ast.mjs write list
node bin/ast.mjs metrics | grep authorization_compliance
```

Anything below 1.0 is a policy violation. Each ledger entry records `authorised_by`; an
entry saying `policy-default` or `not-authorised` for a write that happened is the bug.

Check the guard hook is actually installed:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 1"}}' | node scripts/hooks/guard-destructive.mjs
```

It should print a `deny` decision.

## "It created a duplicate issue"

```bash
node bin/ast.mjs finding list | grep fingerprint
node bin/ast.mjs write check --json '{"system":"github","action":"github.create_issue","idempotencyKey":"<fingerprint>"}'
```

Duplicates mean the fingerprint differed. It hashes `(component, normalised title, expected,
actual)` — so a changed `component` or a materially different `expected`/`actual` produces a
new identity. Usually that means the two findings genuinely are different, and the real
question is which description is right.

## "It lost its place after an interruption"

```bash
node bin/ast.mjs session resume
```

Everything durable is on disk. If something important existed only in the conversation, that
is a bug in how the session was run — write it into state now.

Check `state/telemetry/*.jsonl` for the event stream: decisions, executions, evidence,
findings, reports, with timestamps. Redacted, no payload bodies.

```bash
cat state/telemetry/$(date +%F).jsonl | python -m json.tool --json-lines 2>/dev/null | head -40
```

## Reading state directly

```
state/
├── testing-state.json          the session
├── repository-profile.json     what it believes about the repo
├── capabilities-probe.json     what it believes it can do
├── counters.json               ID allocation
├── decisions/DEC-*.json
├── executions/EXEC-*.json
├── evidence/EV-*.json          + blobs/ for captured output
├── findings/FIND-*.json
├── uncertainties/U-*.json
├── reports/REPORT-*.json|.md
├── external-writes/*.json      the write ledger
├── history/SESSION-*.json      archived previous sessions
└── telemetry/*.jsonl
```

All greppable. `grep -r "DEC-00042" state/` finds everything referencing that decision.

## When the CLI itself errors

```bash
node bin/ast.mjs <command> --debug        # prints the stack
```

Errors are deliberate, not accidental, in these cases:

| Message | It is working as designed |
| --- | --- |
| `A decision needs at least two candidate options` | One option is not a decision; record an assumption instead |
| `Risk factor "x" has a value but no basis` | An unexplained number is not a risk assessment |
| `Unknown repository signal` | Declare it in the catalog rather than removing the check |
| `Evidence artifact does not exist` | Never register an artefact that was not produced |
| `An uncertainty must name what it affects` | "Something might be wrong" is not actionable |

## After changing any policy

```bash
node bin/ast.mjs eval run && node --test "tests/*.test.mjs" && node scripts/validate-repo.mjs
```

All three green. The benchmark is how you find out that tuning a risk weight silently
changed an unrelated browser decision.
