# Workflow: Discovery

Goal: know enough about this repository to make defensible testing choices. Stop when
more looking would not change a decision.

## 1. Orient

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" session resume        # always first — is work already in progress?
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" caps probe            # what can this environment actually do?
```

Then declare the capabilities only you can see (`caps declare`) — MCP servers, the
in-app browser. Anything undeclared counts as unavailable.

## 1b. Verify the described topology (deployed/black-box targets)

When the user provides URLs and describes what each serves (e.g., "this is the admin portal,
this is the guard interface"), **verify each claim before planning against it.** The user's
description of an unfamiliar system is a hypothesis, not a requirement.

For each provided URL:
1. Navigate to it (or `curl -sI`) and confirm it responds.
2. Check the page title, login form labels, or API root to confirm it matches the described
   role.
3. Record the verified mapping in the profile's `environments` section.

If a URL does not match its described role, surface the discrepancy immediately — do not build
a test plan against an unverified topology. This step prevents wasting an entire testing cycle
against wrong targets.

A discrepancy is an uncertainty, not a failure:

`topology.json`:

```json
{
  "question": "URL guard-tq11.onrender.com appears to serve a visitor portal, not a guard interface as described",
  "status": "user-input-required",
  "impact": "test plan for guard role built against wrong target",
  "nextAction": "confirm correct URL for each role before planning"
}
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" uncertainty raise --input topology.json
```

When there is **no repository** (pure black-box testing), this step replaces "Inspect the
repository" — the URLs themselves are the codebase. Discover API endpoints by watching
network traffic during browser exploration and record them as the profile's surface.

**API endpoint discovery (black-box):** After verifying each URL, open the browser's
network panel (or use the browser MCP's network interception) and perform every action the
UI offers. Record each API call's:

- Method + URL pattern (e.g., `POST /api/v1/visitors`)
- Request headers (especially auth tokens — note the scheme, not the value)
- Request body shape (field names and types)
- Response status and body shape

This produces the API surface map that the security baseline, input edge-case baseline,
and IDOR probes will test against. Without it, those baselines have nothing to probe.

### Build the functionality inventory — the breadth ledger

Enumerate **every distinct feature, page, endpoint and flow** you find, and record it in the
profile's `functionality_inventory`. This is the ledger the whole run is measured against:
planning gives each item a `must-test` scenario, and `validate --final` **fails** if any
`high`/`critical` item has no execution tagged to it. An empty inventory on a site that
plainly has features is itself a discovery gap, not a clean bill.

```json
{
  "functionality_inventory": [
    {"id": "FEAT-login", "name": "Login", "kind": "flow", "criticality": "critical", "roles": ["guest"], "evidence": ["/login form"]},
    {"id": "FEAT-invite", "name": "Create invite", "kind": "flow", "criticality": "high", "roles": ["host"], "evidence": ["POST /api/invites"]},
    {"id": "FEAT-help", "name": "Help page", "kind": "page", "criticality": "low", "evidence": ["nav link"]}
  ]
}
```

Walk the whole UI and every discovered endpoint before deciding an inventory is complete.
A feature you never listed is a feature nobody will notice went untested.

### Deriving signals from a bare URL

`profile signals` turns the profile into applicability signals. For a black-box target, the
signals are only as rich as the profile you built: an `apis` entry or a present frontend now
derives `user-input` (so input and edge-case testing apply), any reachable API or UI makes
`perf-baseline` applicable, and a declared non-production environment with a URL unlocks the
authorised baselines. If a category you expect is missing, the fix is a richer profile
(more `apis`, `declared_signals`, `critical_components`), not overriding the verdict.

Also check the client JavaScript bundle for API base URLs and endpoint paths that the UI
may not exercise during a normal walkthrough — undocumented endpoints are often the ones
missing authorisation checks.

## 2. Inspect the repository, not its filenames

A `package.json` naming `react` establishes React. A directory called `api/` establishes
nothing. Every claim in the profile must cite a file path — the schema enforces it.

**A repository gets the same breadth as a URL.** Build the `functionality_inventory` from
routes and handlers (`repository-intelligence` §16), start the app and declare that local
instance `non-production` (§17), then plan against both: the existing suite *and* the
running-system categories. `validate --final` fails when a profile with a UI or API has no
inventory, so this is not optional on either path.

Work outward:

| Question | Where to look |
| --- | --- |
| Languages, package managers | `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `*.csproj`, `Gemfile` |
| Frameworks | dependency lists, then confirm in source — a dependency can be vestigial |
| Frontend | entry points, router config, component directories, build config |
| Backend | server bootstrap, route registration, middleware chain |
| APIs | route definitions, OpenAPI/GraphQL schemas, client code |
| Data | ORM models, migration directories, `docker-compose.yml` |
| Queues / caches | client construction, connection config |
| Auth | middleware, guards, session/token handling, permission checks |
| External services | SDK imports, base URLs, webhook handlers |
| AI / LLM | model SDKs, prompt files, embedding stores, tool definitions |
| Existing tests | test config files, test globs, CI test steps |
| CI/CD | `.github/workflows`, `.gitlab-ci.yml`, `Jenkinsfile`, `azure-pipelines.yml` |
| Containers / infra | `Dockerfile`, compose files, Terraform, Helm, k8s manifests |
| Observability | logger setup, metrics/tracing initialisation |
| Docs | `README`, `ARCHITECTURE`, `docs/`, ADRs |

Delegate the heavy sweep to the `repository-intelligence` skill, or to the
`repository-analyst` subagent when the repository is large enough that the raw file
listings would swamp your context.

## 3. Establish existing coverage honestly

Counting test files is not measuring coverage. If you count files, set
`existing_coverage.measured: false` and say so.

Before claiming a suite is usable, **run it once**. A test command in the README that
does not execute is not coverage. Set `verified_runnable` accordingly.

`exec.json`:

```json
{"goal":"Verify the existing suite runs at all","method":"existing-suite","testCategory":"smoke"}
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" exec start --input exec.json
```

## 4. Record what you could not determine

The `gaps` array is not optional decoration. An empty `gaps` array asserts "nothing is
unknown", which is almost never true. Typical honest entries:

- "No coverage report produced; percentages are unavailable."
- "Cannot tell whether `payments/` calls the live Stripe API or a stub — the client is
  constructed from an env var that is unset here."
- "Repository has no CI; no evidence about what normally runs."

## 5. Save it

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" profile save --input profile.json
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" profile signals          # derives applicability signals from the profile
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" session phase profile --note "repository profiled"
```

`profile save --example` prints a valid profile. Two fields deserve attention:

- **`environments`** — every environment you will touch, with `class` (`production` or
  `non-production`) and `evidence` (the user's words, a deploy manifest). This is the only way
  anything becomes non-production for `auth check` and `browser decide`; a URL that merely
  looks like staging stays unknown, and unknown is treated as production. A deployed URL the
  user names is `production` unless they say otherwise.
- **`declared_signals`** — signals no other field can express (`responsive`, `i18n`,
  `multi-browser`, `perf-sensitive`, …), each with evidence. Without them `profile signals`
  cannot know a site is responsive, and applicability marks those categories not applicable.
  `rag` and `deploy-config` are derived for you (an LLM plus a vector store; a declared
  environment with a URL).

## Empty or unfamiliar repositories

- **Empty repository** → there is nothing to test. Say so and offer to design a testing
  strategy for what is planned. Do not manufacture a test plan for code that does not exist.
- **No test infrastructure** → that is a finding of kind `coverage-gap`, and the first
  recommendation is usually to establish a runnable harness before writing any test.
- **Unfamiliar stack** → say which parts you could not assess rather than guessing at the
  conventions. A confidently wrong profile poisons every decision downstream.

## Exit criteria

You may leave discovery when you can answer all of these from evidence:

- What does this software do, and for whom?
- Which parts would hurt most if broken?
- What testing already exists, and does it run?
- What can this environment execute right now?
- What could you not determine?

→ Next: [planning.md](planning.md)
