# Architecture

## The organising idea

**Bookkeeping is code. Judgement is prose.**

| Deterministic → `bin/ast.mjs`, `engine/` | Judgement → `skills/` |
| --- | --- |
| Allocating IDs | Deciding what is worth testing |
| Validating record shapes | Interpreting a diff |
| Refusing unevidenced claims | Judging whether something is a defect |
| Suppressing duplicate issues | Writing a useful reproduction |
| Computing metrics | Choosing how deep to go |
| Enforcing authorisation | Deciding whether to ask the user |

Bookkeeping done by judgement drifts: an agent that allocates its own IDs will eventually
reuse one, and an agent that decides whether its own claim is evidenced will eventually
decide yes. Judgement encoded as code becomes a checklist bot that runs accessibility scans
on a CLI tool.

Everything else in this document is a consequence of that split.

## Four layers

```
┌─────────────────────────────────────────────────────────────┐
│ TRIGGER      user request · PR event · commit · schedule    │
│              Claude Code hooks (SessionStart, PreToolUse)   │
├─────────────────────────────────────────────────────────────┤
│ ORCHESTRATION    testing-orchestrator                       │
│                  discover → profile → classify → assess     │
│                  → plan → execute → validate → document     │
├─────────────────────────────────────────────────────────────┤
│ SKILL        20 specialists + 4 subagents                   │
│              judgement, expressed as instructions           │
├─────────────────────────────────────────────────────────────┤
│ TOOL / MCP   capability verbs → providers → actual tools    │
└─────────────────────────────────────────────────────────────┘
```

The separation matters because each layer fails differently. A trigger misfires. An
orchestration mistake tests the wrong thing. A skill mistake tests the right thing badly. A
tool failure is an environment problem. Conflating them makes every failure look like the
same failure.

**The trigger layer is not the agent.** Hooks are deterministic shell processes: they cannot
reason, and they run whether or not the agent is paying attention. This system uses two —
`SessionStart` (surface in-progress state) and `PreToolUse` (refuse a small set of
catastrophic commands). The `PreToolUse` guard is a **backstop**, not the authorisation
system; the real gate is `engine/authorization`, which works because the agent consults it.

External triggers — PR opened, deployment finished, nightly schedule — belong to whatever
runs them (GitHub Actions, cron). This system does not claim to own them, and pretending
otherwise would be the same kind of dishonesty it exists to prevent.

## Engines

```
engine/
├── core/                   ids · paths · fsjson · redact · version
├── schema/                 zero-dependency JSON Schema subset validator
├── state-engine/           durable working memory + recovery
├── risk-engine/            explainable scoring        (weights.json)
├── applicability-engine/   what testing applies       (catalog.json)
├── browser-decision/       MCP vs script vs existing  (matrix.json)
├── decision-engine/        decision records + adaptive next action
├── execution-engine/       open-before / close-after
├── evidence-engine/        the false-confidence gate
├── defect-engine/          findings, fingerprints, issue rendering
├── uncertainty-register/   blockers that never stall the session
├── failure-classifier/     red result → cause, with confidence
├── flakiness/              pass/fail history analysis
├── capability-registry/    verb → provider resolution  (capabilities.json)
├── authorization/          the write gate + ledger     (policy.json)
├── traceability/           requirement → … → evidence graph
├── reporting-engine/       renders the report FROM data
└── evaluation-engine/      benchmark runner + metrics
```

Each has one responsibility and a policy file where its opinions live. The engine code
combines configuration with evidence; it does not contain the opinions itself. That is why
"the risk score is wrong" is fixed by editing one number in `weights.json`, not by reading
JavaScript.

## Five mechanisms that carry the weight

### 1. The evidence gate

`PASSED`, `FAILED`, `COMPLETED` and `PARTIAL` all claim something executed, so all four
require evidence. Evidence is classified:

- **Execution evidence** — command output, test report, assertion results, trace, HAR,
  coverage, static analysis, scan, performance metric, database snapshot. Sufficient alone.
- **Corroborating** — screenshots, video, logs, network requests, diffs. Never sufficient.
- **Not evidence of execution** — user statements. Testimony, not verification.

A screenshot shows what a page looked like; it does not show that an assertion held.

`exec finish` applies the gate automatically. A claim that fails is **downgraded** to
`INCONCLUSIVE` with the reason appended. There is no code path that lets an unevidenced
`PASSED` reach the report — which is why the report can state its own false-confidence rate
and mean it.

### 2. Open before, close after

Execution records are created **before** the work starts and finalised after. A session that
dies mid-run leaves a record with no `finished_at`, and recovery marks it `INTERRUPTED`.

Nothing is ever assumed to have passed because the process did not get to write "failed".
That single ordering choice is what makes "continue from the previous session" trustworthy.

### 3. Capability indirection

```
skill asks:       github.create_issue
registry tries:   mcp-github (not authorised) → gh-cli (authenticated) ✓
skill never knows which answered
```

MCP tool names are the least stable thing in this stack. With this indirection, a server
renaming its tools is a one-line change in one JSON file rather than an edit across 21
skills. `scripts/validate-repo.mjs` fails the build if any skill hard-codes an `mcp__*` name.

Three states, and the third is the point: `true`, `false`, and `null` — *nobody declared it*,
treated as unavailable. A capability wrongly assumed present produces a plan whose steps
silently never run.

### 4. Configuration over code

| Question | Answered by |
| --- | --- |
| How risky is this? | `risk-engine/weights.json` |
| Which testing applies? | `applicability-engine/catalog.json` |
| Explore or script? | `browser-decision/matrix.json` |
| May I write to GitHub? | `authorization/policy.json` |
| Which tool can do this? | `capability-registry/capabilities.json` |

Every decision cites the policy version that produced it
(`browser-decision.matrix@1.0.0#hybrid_trigger`), so a past decision stays interpretable
after the policy changes underneath it. Without that, every old decision is unfalsifiable.

### 5. Rendered, not written

The Markdown report is rendered from the JSON report, which is derived from records on disk.
Nothing is hand-written. If a claim is not in the data, no code path puts it in the document.

This is what stops polished prose outrunning the evidence — the failure mode that makes
agent-written test reports untrustworthy.

## The loop

```
DISCOVER → PROFILE → UNDERSTAND → CLASSIFY → ASSESS RISK → SELECT TESTS
   → SELECT TOOLS → PLAN → EXECUTE → OBSERVE → VALIDATE → DOCUMENT
   → DECIDE NEXT → (COMPLETE | BLOCK | ESCALATE | CONTINUE)
```

Not walked once. After every meaningful result the agent returns to **DECIDE NEXT** and
re-enters wherever the evidence says it should.

Crucially, a failure does not mean "continue". It means **classify first**: a red result
caused by a missing environment variable and one caused by a real defect demand opposite
responses, and the classifier deliberately ranks non-product causes above `product-defect` on
a tie — because filing a false defect costs more than investigating one more environment
issue.

## Data flow

```
repository ──► repository-intelligence ──► repository-profile.json
                                                   │
                                            signals│
                                                   ▼
git diff ──► change-intelligence ──► risk-engine ──► applicability-engine
tickets  ──► requirement-analysis         │                   │
                                          └────────┬──────────┘
                                                   ▼
                                            testing plan
                                                   │
                                    browser-decision (if UI)
                                                   ▼
                                    execution-engine ──► evidence-engine
                                           │                   │
                                  failure-classifier     evidence gate
                                           │                   │
                                    defect-engine        (downgrade)
                                           │                   │
                                  authorization + ledger        │
                                           │                   │
                                           └────────┬──────────┘
                                                    ▼
                                            reporting-engine
                                                    ▼
                                    report.json ──► report.md
```

## State

```
state/
├── testing-state.json          the session
├── repository-profile.json     what it believes about the repo
├── capabilities-probe.json     what it believes it can do
├── counters.json               ID allocation
├── decisions/  executions/  evidence/  findings/  uncertainties/  reports/
├── external-writes/            the idempotency ledger
├── history/                    archived previous sessions
└── telemetry/                  append-only, redacted event stream
```

Atomic writes (temp file + rename), so an interrupted run never leaves unparseable state.
Everything persisted passes through redaction. All of it is greppable: `grep -r "DEC-00042"
state/` finds every reference.

## Failure modes this design defends against

| Failure mode | Defence |
| --- | --- |
| Confident unevidenced "it works" | Evidence gate; automatic downgrade; report states its own false-confidence rate |
| Silently skipping work | `BLOCKED` / `NOT_APPLICABLE` are first-class execution records and appear in the report |
| Stopping at the first obstacle | Uncertainty register partitions work; `independent_work_continued` records what happened anyway |
| Assuming an interrupted run passed | Open-before/close-after; recovery marks `INTERRUPTED` |
| Duplicate issue spam | Finding fingerprints + external-write ledger |
| Unauthorised external writes | Per-action, per-session authorisation; prohibited-by-default list; `authorization_compliance` metric |
| Assigning work to a guessed person | `explicit-named-assignee` — refused without a user-named account |
| Calling a real defect flaky | Requires ≥3 runs at the same commit; `flaky_identification_quality` metric |
| Weakening a test to get green | Forbidden pattern; rubric Q8 fails the session outright |
| Over-testing to look thorough | Applicability matrix; `unnecessary_test_rate` metric |
| Faking an unavailable integration | Capability registry returns unavailable; work reported `BLOCKED` |
| Policy drift | Benchmark suite; every decision cites its policy version |

## Where subagents fit

Four, used only where the work is genuinely parallel or would flood the main context:
`repository-analyst`, `evidence-auditor`, `browser-explorer`, `test-author`.

Spawning four subagents for a three-file change is theatre. The orchestrator decides;
delegation is an optimisation, not a structure.

## What this architecture does not do

Stated plainly, because a design document that only lists strengths is marketing:

- **It cannot tell whether the agent gathered the right inputs.** The benchmark exercises the
  decision machinery against fixed inputs. Garbage in still produces confident garbage out —
  which is why the repository profile requires evidence for every claim, and why `gaps` is a
  mandatory field.
- **It cannot see requirements nobody wrote down.** The traceability query says so explicitly
  in its own output. Undocumented expectations remain the largest untested surface in any
  system.
- **Decision accuracy is self-assessed** unless a human sets the verdict. Treat the agent's
  own score as weak evidence; that is why `decision_assessment_rate` exists alongside it.
- **The redactor cannot recognise a secret that looks like ordinary text.** It is defence in
  depth, not a guarantee.
- **Nothing here prevents a well-evidenced wrong conclusion.** A test that asserts the wrong
  thing passes the evidence gate. That is what the qualitative rubric and human review are
  for.
