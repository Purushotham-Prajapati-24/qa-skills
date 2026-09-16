# Progress

Live implementation status. Kept honest deliberately: a system built around "never claim more
than the evidence supports" would be self-refuting if this page overstated its own
completeness.

**Current phase:** core complete and exercised end to end; integrations specified, bound where
a provider exists.
**Version:** 0.5.0 · **Last validated:** 2026-09-16

## Validation status

```
node --test "tests/*.test.mjs"     61 passed, 0 failed
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
| Reporting engine | 20 sections rendered from data, with integrity self-audit |
| Evaluation engine | 15 cases, 41 checks, 14 metrics with stated blind spots |
| Secret redaction | Token shapes and sensitive keys, with a `SAFE_KEYS` allowlist |
| 21 skills | Frontmatter and links validated; all under the 500-line guidance |
| 4 subagents | `agents/*.md` |
| 2 Claude Code hooks | Both tested by hand; `SessionStart` and `PreToolUse` |
| Plugin + marketplace manifests | Match the verified plugin layout |
| Skill installer | `scripts/install-skills.mjs`, with symlink fallback on Windows |
| Repository self-check | Catches broken links, hard-coded MCP names, dangling references |

## PARTIALLY IMPLEMENTED

| Component | State | What is missing |
| --- | --- | --- |
| GitHub integration | Contract specified; `gh` CLI probed and resolvable | No executable adapter module — the agent runs `gh` directly following `integrations/github/adapter.md`. Works, but the contract is not enforced in code. |
| Jira integration | Contract specified; REST fallback probes for env vars | Same. Additionally, ADF parsing is specified but not implemented. |
| Change intelligence | Skill written with concrete commands | No `ast change analyse` subcommand; the agent runs `git`/`gh` itself |
| Requirement analysis | Skill written | No structured requirement store beyond what a plan carries |
| Test generation | Guidance in every specialist skill | No scaffolding command; the agent writes tests directly, which is probably correct |
| Flakiness | Analysis implemented | Nothing automatically quarantines or reports a flaky test |

## DESIGNED BUT NOT IMPLEMENTED

| Component | Where specified | Why not built |
| --- | --- | --- |
| Google Docs adapter | `integrations/google/docs.md` | No Google MCP server was available. Fallback to `state/reports/` works and is honest. |
| Google Drive adapter | `integrations/google/drive.md` | Same |
| Executable adapter modules | `integrations/*/adapter.md` | The contracts are precise; turning them into code is the obvious next stage |
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

**Turn the adapter contracts into executable modules**, starting with GitHub.

Today the agent follows `integrations/github/adapter.md` and runs `gh` itself. That works,
but the contract — check authorisation, check the ledger, render, perform, record the
provider's actual response — is enforced by the agent remembering to follow it. An executable
`GitHubAdapter` would make the sequence structural rather than behavioural, the same way the
evidence gate is.

Concretely:

1. `engine/adapters/github.mjs` implementing the contract, with the write protocol built in.
2. The same for Jira, including ADF parsing.
3. `ast github create-issue FIND-00001` as the only path to an external write.
4. Tests asserting that an unauthorised write is impossible, not merely discouraged.

After that: derive regression cases from real sessions, which is what will actually calibrate
the policies against reality rather than against my expectations of it.
