---
name: browser-testing
description: Choose and run the right browser testing method — agent-driven exploration through a browser MCP, a deterministic committed script, the repository's existing browser suite, or explore-then-automate. Use when testing a web UI, exploring an application for bugs, deciding between Playwright MCP and Playwright scripts, converting an exploratory finding into a regression test, or capturing browser evidence such as screenshots, traces, console errors and network activity.
when_to_use: "explore the app for UI bugs", "test this page", "should I use Playwright MCP or a script", "create regression tests for this flow", "capture a trace", "the UI is broken"
allowed-tools: Read, Glob, Grep, Bash, PowerShell, Write, Edit
metadata:
  system_version: 0.7.0
  role: specialist
---

# Browser Testing

The tempting default — *we have a browser MCP, so use the browser MCP* — is wrong most of
the time. An agent-driven session is not reproducible, so it cannot be a CI gate and it
leaves no regression asset behind. Equally, writing selectors for a UI nobody has looked
at just encodes guesses.

So: **decide, then act.**

## Decide first

```bash
node bin/ast.mjs browser decide --input factors.json
```

Factors, each in [0,1]:

| Factor | High means |
| --- | --- |
| `ui_known` | You have already seen this UI's structure |
| `repeatability` | This exact scenario will be re-run often |
| `determinism_required` | The answer must be identical run to run |
| `exploratory_value` | Open-ended poking is likely to find something |
| `ci_suitability` | It must run unattended and produce an exit code |
| `business_criticality` | Breaking this hurts |
| `assertion_complexity` | Precise DOM/network/numeric checks needed |
| `execution_frequency` | Many runs per month |
| `maintenance_cost_tolerance` | The team will happily maintain another spec |
| `existing_automation` | Existing browser tests already cover this |
| `environment_stability` | The target does not flap |
| `evidence_requirements` | Trace/video/screenshot artefacts are needed |
| `network_mocking_required` | Requests must be intercepted or stubbed |
| `tool_reliability` | The automation stack behaves here |

Full matrix and rationale: [browser-decision.md](browser-decision.md).

## The five methods

| | Method | Reproducible | Leaves an asset | Use for |
| --- | --- | --- | --- | --- |
| **A** | Agent-driven session ([playwright-mcp.md](playwright-mcp.md)) | No | No | Discovery, exploration, investigating one-off weirdness |
| **B** | Deterministic script ([playwright-script.md](playwright-script.md)) | Yes | Yes | Regression, CI gates, precise assertions |
| **C** | The repository's existing browser tests | Yes | No (already exists) | Cheapest reliable evidence when coverage exists |
| **D** | Hybrid: explore, then automate the stable path | Partly | Yes | Unknown UI + recurring scenario — **the most common right answer** |
| **E** | The repository's own stack (Cypress, WebdriverIO, Selenium) | Yes | Yes | When the team already standardised; do not introduce a second framework |

## Hard rules the engine enforces

- **`ci_suitability >= 0.8` forbids method A.** A gate must be reproducible and produce an
  exit code. An agent session is neither.
- **`ui_known <= 0.25` forbids method B.** Explore before you write selectors.
- **`existing_automation <= 0.15` forbids C and E.** There is nothing to run.
- **Production forbids A and D.** Open-ended agent interaction with production can trigger
  real side effects. Overriding this needs explicit user authorisation.
- **A missing capability removes its method.** Never simulate a browser you do not have.

## Capabilities, not tool names

```bash
node bin/ast.mjs caps declare mcp-playwright true --note "browser_navigate, browser_snapshot, browser_click present"
node bin/ast.mjs caps resolve browser.explore
```

Verbs: `browser.explore`, `browser.screenshot`, `browser.resize`, `browser.read_console`,
`browser.read_network`, `browser.run_deterministic_test`, `browser.trace`.

Providers today: `mcp-playwright`, `builtin-browser` (the in-app browser pane — fine for
exploration and evidence, **not** a test runner), `playwright-cli`.

## The automation lifecycle

```
DISCOVER  →  VALIDATE  →  STABILIZE  →  AUTOMATE  →  REGRESS  →  EVOLVE
 explore     confirm      find the      commit a     run it     update as
 behaviour   expected     repeatable    deterministic every      behaviour
             behaviour    path          test         time       changes
```

Exploration that leaves nothing behind was half a job. After exploring, ask:

```bash
node bin/ast.mjs browser should-automate --json '{"factors":{"repeatability":0.8,"business_criticality":0.9,"environment_stability":0.8,"expected_runtime_minutes":3}}'
```

Converts only when the scenario is repeatable, valuable, stable **and** fast. Thresholds
live in `engine/browser-decision/matrix.json#script_conversion`.

## Evidence from a browser

| Capture | Counts as |
| --- | --- |
| Playwright trace | **Execution evidence** — assertions and timeline |
| JSON test report | **Execution evidence** |
| Screenshot | Corroborating only |
| Video | Corroborating only |
| Console errors | Corroborating — but a strong defect signal |
| Network log / HAR | Corroborating |

Always capture console errors and failed requests during exploration. They are the
highest-yield, lowest-cost browser signal and they routinely reveal defects the UI hides.

## Reference pattern: a changed checkout flow

The canonical worked example, end to end, is
[../../examples/walkthroughs/D-explore-then-automate.md](../../examples/walkthroughs/D-explore-then-automate.md).
In short:

1. Discover existing Playwright config and specs → coverage is **partial**.
2. `browser decide` → `ui_known` low, `repeatability` high → **hybrid**. Record `DEC-…`.
3. Explore with the MCP: navigate, snapshot, click through, read console and network.
4. Find a stable, valuable path. `should-automate` → yes.
5. Write a spec matching the repository's existing conventions and fixtures.
6. Run it. Capture trace + JSON report as evidence.
7. Update coverage; file an issue **only if** a real defect was found and authorised.
8. Record why MCP was used first and why a script was written afterwards.

That ordering — explore to learn, script to assert — is the pattern to reach for whenever
a UI is unfamiliar and the scenario will recur.
