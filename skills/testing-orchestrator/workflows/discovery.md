# Workflow: Discovery

Goal: know enough about this repository to make defensible testing choices. Stop when
more looking would not change a decision.

## 1. Orient

```bash
node bin/ast.mjs session resume        # always first — is work already in progress?
node bin/ast.mjs caps probe            # what can this environment actually do?
```

Then declare the capabilities only you can see (`caps declare`) — MCP servers, the
in-app browser. Anything undeclared counts as unavailable.

## 2. Inspect the repository, not its filenames

A `package.json` naming `react` establishes React. A directory called `api/` establishes
nothing. Every claim in the profile must cite a file path — the schema enforces it.

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

```bash
node bin/ast.mjs exec start --json '{"goal":"Verify the existing suite runs at all","method":"existing-suite","testCategory":"smoke"}'
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
node bin/ast.mjs profile save --input profile.json
node bin/ast.mjs profile signals          # derives applicability signals from the profile
node bin/ast.mjs session phase profile --note "repository profiled"
```

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
