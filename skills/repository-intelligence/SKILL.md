---
name: repository-intelligence
description: Build a structured, evidence-backed profile of a repository — languages, frameworks, architecture, APIs, databases, queues, caches, auth, external integrations, AI/LLM systems, existing test frameworks and coverage, CI/CD, containers, infrastructure and observability. Use before planning any testing, when asked what a codebase does or how it is structured, or when an existing repository profile is missing or stale.
when_to_use: "what does this repo do", "analyse this codebase", "profile the repository", "what testing exists here", "what stack is this"
allowed-tools: Read, Glob, Grep, Bash, PowerShell
metadata:
  system_version: 0.7.0
  role: specialist
---

# Repository Intelligence

Produce a `repository-profile.json` that every later decision can rest on. The profile is
only as good as its evidence, so the schema requires a file path for every technology
claim.

## The rule

**Read contents, not filenames.** A directory called `api/` establishes nothing. A
`package.json` listing `react` establishes that React is a declared dependency — and you
still confirm it is actually imported, because dependency lists accumulate corpses.

## Sweep

Work outward from the manifests.

**1. Languages and package managers** — `package.json`, `pyproject.toml` / `requirements.txt`,
`go.mod`, `Cargo.toml`, `pom.xml` / `build.gradle`, `*.csproj`, `Gemfile`, `composer.json`.
Note lockfiles: they tell you which manager is actually in use.

**2. Frameworks** — from dependencies, then confirmed in source. Record the version.

**3. Frontend** — entry point, router, component directories, build tooling, state
management, styling. Does it render server-side? Is there more than one app?

**4. Backend** — server bootstrap, route registration, middleware chain, background jobs,
scheduled tasks.

**5. APIs** — route definitions, OpenAPI/GraphQL/proto schemas, generated clients. Count
routes. Sample a few. Note which require auth.

**6. Data** — ORM models, migration directories, raw SQL, connection config,
`docker-compose.yml`. Are there multiple datastores?

**7. Queues, caches, workers** — client construction and connection config.

**8. Auth and authz** — middleware, guards, session or token handling, permission checks,
role definitions. This drives the security signals, so be precise.

**9. External integrations** — SDK imports, base URLs, webhook handlers. For each: can it
be reached from a test environment, and does calling it have irreversible side effects?
Payment, email and SMS providers matter most.

**10. AI / LLM** — model SDKs, prompt files or templates, embedding stores, retrieval
code, tool/function definitions, agent loops.

**11. Existing tests** — config files, test globs, helper and fixture directories, the run
command, and whether CI actually runs it.

**12. CI/CD** — workflow files, which jobs run tests, what gates a merge.

**13. Containers and infrastructure** — Dockerfiles, compose, Terraform, Helm, k8s.

**14. Observability** — logger setup, metrics, tracing, error reporting.

**15. Documentation** — README, ARCHITECTURE, ADRs, `docs/`.

## Prove the test suite runs

Do not take a README's word for it:

```bash
npm test            # or the repository's actual command
```

Set `verified_runnable` from what happened. A documented command that does not execute is
a finding, not coverage.

## Coverage, honestly

If you counted test files, say so:

```jsonc
"existing_coverage": {
  "test_file_count": 42,
  "measured": false,
  "by_category": { "unit": "substantial", "integration": "minimal", "e2e": "none" }
}
```

`measured: false` means these are counts, not a coverage run. Never present a file count
as a coverage percentage.

## Critical components

For each, state **why** it is critical, plus business criticality and data sensitivity.
These feed the risk engine directly, so vagueness here degrades everything downstream.

```jsonc
{ "name": "checkout", "paths": ["src/checkout/**"], "why": "only revenue path; calls Stripe",
  "business_criticality": "critical", "data_sensitivity": "financial" }
```

## Gaps are mandatory

An empty `gaps` array asserts "nothing is unknown". That is almost never true. Write down
what you could not determine and why — it is the most useful part of the profile for the
next session.

## Save and derive signals

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" profile save --input profile.json
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" profile signals
```

Signals are the sole input to test applicability. If a signal looks wrong, fix the
profile rather than overriding the applicability verdict.

## Large repositories

If the file listings would swamp your context, delegate the sweep to the
`repository-analyst` subagent and take back the structured profile rather than the raw
output. In a monorepo, profile the workspace the change touches — and say which workspaces
you did not look at.
