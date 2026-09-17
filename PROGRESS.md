# Progress

Live implementation status. Kept honest deliberately: a system built around "never claim more
than the evidence supports" would be self-refuting if this page overstated its own
completeness.

**Current phase:** core complete and exercised end to end; integrations specified, bound where
a provider exists.
**Version:** 0.7.0 · **Last validated:** 2026-09-16

## Validation status

```
node --test "tests/*.test.mjs"     125 passed, 0 failed
node bin/ast.mjs eval run          41/41 checks across 15 benchmark cases
node scripts/validate-repo.mjs     0 problems
node scripts/demo-session.mjs      full pipeline exercised end to end
```

## IMPLEMENTED

Working, tested, exercised by the demo session.

| Component | Evidence |
| --- | --- |
| Zero-dependency CLI (50+ subcommands) | `bin/ast.mjs`; every walkthrough command runs |
| JSON Schema subset validator | 11 schemas load; throws on unsupported keywords |
| State engine + recovery | `tests/lifecycle.test.mjs` — interrupted execution marked `INTERRUPTED` |
| Evidence gate | Unevidenced `PASSED` → `INCONCLUSIVE`, verified in tests and the demo |
| Risk engine, 4 profiles | `ast risk score --explain`; unevidenced factors excluded, confidence reported |
| Applicability engine, 47 categories | Every category returned applicable-or-not with a reason |
| Browser decision engine | 5 methods, 4 hard rules, ambiguity gate; 8 benchmark cases |
| Decision engine + adaptive next action | Rejects <2 options, missing reasons, missing confidence |
| Execution engine | Open-before/close-after; `not-executed` records blocked work |
| Defect engine + fingerprinting | Duplicate suppressed across wording changes, verified in demo |
| Uncertainty register + partitioning | 3 of 4 scenarios runnable with a blocker open |
| Failure classifier | Non-product causes outrank `product-defect` on a tie |
| Flakiness analysis | Refuses to label flaky below 3 runs |
| Capability registry | 37 verbs, 13 providers, three-state availability |
| Authorization + write ledger | Prohibited-by-default list; assignment refused without a named account |
| Traceability graph | `what-remains-untested` correctly reports REQ-3 uncovered |
| Reporting engine | Inverted-pyramid report rendered from data; empty sections skipped, findings embedded in full, integrity self-audit |
| Evaluation engine | 15 cases, 41 checks, 14 metrics with stated blind spots |
| Secret redaction | Token shapes and sensitive keys, with a `SAFE_KEYS` allowlist |
| 21 skills | Frontmatter and links validated; all under the 500-line guidance |
| 4 subagents | `agents/*.md` |
| 2 Claude Code hooks | Both tested by hand; `SessionStart` and `PreToolUse` |
| Plugin + marketplace manifests | Match the verified plugin layout |
| **npx installer** | `bin/install.mjs`; 7 tests install into a throwaway repo and assert the CLI runs, every link resolves and no skill still points at the source layout |
| Repository self-check | Catches broken links, hard-coded MCP names, dangling references |
| **GitHub adapter (executable)** | `engine/adapters/github.mjs`; 29 tests assert each gate refuses **before** the provider is called |
| **Enforced write protocol** | `performWrite` is the only path to a ledger entry, and it runs capability -> authorisation -> ledger -> render -> perform -> parse -> record in order |
| **Delegated-write tickets** | An MCP-resolved write cannot be recorded without a single-use, hour-limited ticket proving the gates ran |
| **Provider error classification** | 401/403/404/422/429/network/timeout each map to a status and a stated next action; network errors are never marked retry-safe |

## PARTIALLY IMPLEMENTED

| Component | State | What is missing |
| --- | --- | --- |
| Jira integration | Contract specified; REST fallback probes for env vars | No executable adapter module yet — the agent follows `integrations/jira/adapter.md` by hand. ADF parsing also unimplemented. This is the next obvious piece, now that `performWrite` exists to build on. |
| Change intelligence | Skill written with concrete commands | No `ast change analyse` subcommand; the agent runs `git`/`gh` itself |
| Requirement analysis | Skill written | No structured requirement store beyond what a plan carries |
| Test generation | Guidance in every specialist skill | No scaffolding command; the agent writes tests directly, which is probably correct |
| Flakiness | Analysis implemented | Nothing automatically quarantines or reports a flaky test |

## DESIGNED BUT NOT IMPLEMENTED

| Component | Where specified | Why not built |
| --- | --- | --- |
| Google Docs adapter | `integrations/google/docs.md` | No Google MCP server was available. Fallback to `state/reports/` works and is honest. |
| Google Drive adapter | `integrations/google/drive.md` | Same |
| Regression suite from real sessions | `evaluation/regression-suite/README.md` | Needs real sessions to derive cases from |
| Decision outcome assessment at scale | `ast decision assess` exists | Nothing prompts the agent to assess past decisions; `decision_assessment_rate` will read low until something does |
| External trigger layer | `ARCHITECTURE.md` | Belongs to CI, not to this system. Documented rather than claimed. |

## REQUIRES EXTERNAL CONFIGURATION

Nothing here is broken — each needs a credential or an authorisation the user must supply.

| Capability | Needs |
| --- | --- |
| `github.*` writes | `gh auth` with `repo` scope, **or** the GitHub MCP server authorised |
| `jira.*` | Atlassian connector authorised, **or** `JIRA_BASE_URL` + `JIRA_EMAIL` + `JIRA_API_TOKEN` |
| `docs.*`, `drive.*` | A Google MCP server. Without one, falls back to local Markdown and says so. |
| `browser.explore` | Playwright MCP or the in-app browser, **declared** via `ast caps declare` |
| `browser.run_deterministic_test` | `npx playwright install chromium` |
| `database.query` | A disposable database, and a profile that classifies it non-production |

## BLOCKED

Nothing.

## Known issues

| Issue | Impact |
| --- | --- |
| The benchmark cannot verify input gathering | It exercises decision machinery against fixed inputs. Garbage in still produces confident garbage out. Mitigated by the profile requiring evidence for every claim. |
| Decision accuracy is self-assessed | Treat the agent's own verdicts as weak evidence. `decision_assessment_rate` exists to expose a small sample. |
| Redaction cannot recognise a secret shaped like ordinary text | Defence in depth, not a guarantee |
| The hook guard is pattern-based | A creative command can evade it. It is a backstop, not the authorisation system. |
| No automatic quarantine of flaky tests | Analysis is implemented; acting on it is manual |
| `traceability` only sees declared requirements | Stated in the query's own output. Undeclared expectations remain the largest untested surface. |

## Next recommended stage

**Calibrate the policies against the benchmark application.**

The previous entry here asked for executable adapter modules starting with GitHub. That
shipped: `engine/adapters/github.mjs`, `performWrite` as the only path to a ledger entry,
delegated-write tickets, and 29 tests asserting each gate refuses before the provider is
called. It is in the IMPLEMENTED table above. Jira is the one piece of that plan still
outstanding, and it is tracked under PARTIALLY IMPLEMENTED rather than here.

What is now possible and was not before: `sample-ecommerce-app/` ships, its eight defects
are no longer labelled in its own source, and the ground truth lives in
`evaluation/benchmark-app/answer-key.json`. Detection can finally be measured rather than
grepped.

Concretely:

1. A scored end-to-end run against the benchmark app, recorded the way any other session is
   — so the detection rate is evidence rather than an anecdote about a previous run.
2. A mutation generator, so eight hand-authored defects become a family of them. Eight
   findable bugs written by the same person who built the detector is a weak sample, and
   the answer key says so.
3. Feed what that run gets wrong back into `evaluation/benchmark-cases/` as regression
   cases. That is what calibrates the policies against reality rather than against my
   expectations of it.

The honest limitation: the benchmark app has no defect that needs load, timing, concurrency
or long-running state to reproduce. Until it does, nothing here measures the categories that
are hardest to test.
