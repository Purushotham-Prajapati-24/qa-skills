# Extending the system

Every extension point is configuration or a new file. None requires changing the engine.

## Add a testing skill

**1. Add the category to the catalog** — this is what makes it reachable.
`engine/applicability-engine/catalog.json`:

```jsonc
"mutation": {
  "label": "Mutation testing",
  "requires": ["existing-tests"],        // signals that make it relevant; "any" for always
  "match": "any",                        // or "all"
  "cost": 45,                            // typical minutes
  "automation": "high",
  "skill": "mutation-testing",           // must match a skill name
  "capability": "shell.run",             // optional; unavailable capability => BLOCKED
  "addresses": ["coverage_deficit"],     // risk factors it attacks
  "prerequisites": ["a runnable test suite"]
}
```

If you need a new signal, declare it under `signals` in the same file and teach
`signalsFromProfile` in `engine/applicability-engine/index.mjs` how to derive it. An
undeclared signal is rejected, not ignored.

**2. Add the category to the schema** — `schemas/common.schema.json`, the `testCategory`
enum. Without this, execution records for it will not validate.

**3. Write the skill** — `skills/mutation-testing/SKILL.md`:

```yaml
---
name: mutation-testing          # must match the directory name
description: …                  # what it does AND when to use it — this is how Claude picks it
when_to_use: "mutation testing", "are these tests any good"
allowed-tools: Read, Glob, Grep, Bash, Write, Edit
metadata:
  system_version: 0.10.0
  role: specialist
---
```

Keep it under 500 lines. Put detail in supporting files the skill links to.

**4. Add it to the orchestrator's delegation table** in
`skills/testing-orchestrator/SKILL.md`.

**5. Add a benchmark case** asserting it becomes applicable when its signals are present —
and, just as importantly, that it does **not** when they are absent.

**6. Verify.**

```bash
node scripts/validate-repo.mjs      # checks the skill exists, name matches, links resolve
node bin/ast.mjs eval run
```

## Add an MCP integration

**Never name an MCP tool inside a skill.** `validate-repo.mjs` fails the build if you do.

**1. Declare the provider** — `engine/capability-registry/capabilities.json`:

```jsonc
"providers": {
  "mcp-sentry": { "kind": "mcp", "probe": { "type": "agent-declared" },
                  "notes": "Sentry MCP. Requires a project token." }
}
```

Probe types: `always`, `command` (runs it), `env` (checks variables), `agent-declared`
(only you can see your tool list).

**2. Bind capabilities**, in preference order:

```jsonc
"observability.read_errors": { "providers": ["mcp-sentry", "shell"], "write": false }
```

Write verbs need an `authorization` level and usually an `idempotency` key.

**3. Add the write action to the authorization policy** —
`engine/authorization/policy.json`. Anything missing is denied by default, which is the
correct failure mode but a confusing one to debug.

**4. Write the adapter contract** — `integrations/<system>/adapter.md`: operations, failure
modes, rate limits, evidence returned, idempotency. Document what happens on a partial write
specifically; that is where duplicates come from.

**5. Optionally add the server** to `.mcp.json`.

```bash
node bin/ast.mjs caps declare mcp-sentry true --note "sentry tools present"
node bin/ast.mjs caps resolve observability.read_errors
```

## Add an executable adapter

`integrations/<system>/adapter.md` specifies a contract. Turning it into a module means the
write protocol is enforced rather than remembered.

1. `engine/adapters/<system>.mjs` exporting a factory that takes `{ exec }` so tests never
   shell out.
2. Reads go through `performRead`; writes go through `performWrite`. **Never write to the
   ledger directly** — `performWrite` is the only thing that should, because it is the only
   thing that runs the gates first.
3. Write a `parseResult(raw)` that returns `{ confirmed, result_id, url }`. It must derive
   confirmation from a real identifier in the provider's response, never from an exit code.
   No identifier means `confirmed: false`, and that is the correct answer.
4. Register it in `engine/adapters/index.mjs`.
5. Add CLI commands in `bin/ast.mjs`.
6. Test that each gate refuses **before** the provider is called — assert the fake exec
   recorded zero calls. That is the property worth protecting.

For an MCP-resolved provider, `performWrite` issues a ticket automatically; you only need
to supply the parser that `completeWrite` will use.

## Change how decisions are made

| To change | Edit |
| --- | --- |
| Risk weighting | `engine/risk-engine/weights.json` — add a profile rather than arguing with a score |
| Risk thresholds | same file, `levels` |
| What testing applies | `engine/applicability-engine/catalog.json` |
| Browser method choice | `engine/browser-decision/matrix.json` |
| Hard prohibitions on browser methods | same file, `hard_rules` |
| When to convert exploration into a test | same file, `thresholds.script_conversion` |
| What needs authorisation | `engine/authorization/policy.json` |
| Failure classification | `engine/failure-classifier/index.mjs` — `RULES` |
| Metric definitions | `engine/evaluation-engine/metrics.mjs` |

After **any** of these:

```bash
node bin/ast.mjs eval run && node --test "tests/*.test.mjs"
```

Bump the policy file's own `version`, and note in `CHANGELOG.md` which benchmark cases
moved. Decisions reference `policy_refs` like `browser-decision.matrix@1.0.0#hybrid_trigger`
— that is how a past decision stays interpretable after you change the policy underneath it.

## Add a risk profile

```jsonc
"profiles": {
  "medical-device": {
    "description": "Regulated software where a defect can harm someone.",
    "weights": { "security_sensitivity": 1.5, "data_sensitivity": 2.0, "irreversibility": 2.0, "...": 1.0 }
  }
}
```

Weight **every** declared factor. `validate-repo.mjs` warns about any you miss, because an
unweighted factor is silently never scored under that profile.

## Add a browser method

```jsonc
"methods": {
  "visual-diff-service": {
    "label": "F. Hosted visual diffing service",
    "capability": "browser.screenshot",
    "produces_regression_asset": true,
    "deterministic": true,
    "affinity": { "repeatability": 0.8, "exploratory_value": -0.6, "...": 0 }
  }
}
```

Affinities are in [-1, 1]: `+1` means "at its best when this factor is high". Only declare
factors that genuinely bear on the method — unsupplied factors are excluded from scoring,
never assumed.

## Add a subagent

`agents/<name>.md` with `name`, `description`, `tools`, `model`. Restrict `tools` to the
minimum: a subagent with `Write` that only needs to read is an unnecessary risk.

Add one only when the work is genuinely parallel or would flood the main context.

## Add a metric

`engine/evaluation-engine/metrics.mjs`. Every metric must declare `formula`, `direction`
and — the one people skip — **`blind_spot`**. A metric without a stated blind spot gets
misused, and misused metrics drive worse behaviour than no metrics.

Then set a threshold in `evaluation/scoring/rubric.json` and say whether missing it is a
*score* or an *alarm*.

## Add a benchmark case

`evaluation/benchmark-cases/case-NN.json`. Include `reasoning_notes` explaining what it is
really checking, and `not_covered` for what it cannot. A case without those becomes
uninterpretable within a month.

Prefer `one_of` and `at_least` over exact values where the meaningful assertion is a
direction — pinning an exact score turns the case into a test of `weights.json` instead of
a test of the reasoning.

## The rule for all of it

If an extension requires changing `engine/*/index.mjs`, stop and ask whether the
configuration is missing an expressive dimension instead. Engine changes need new tests;
configuration changes need a benchmark case. The second is cheaper and safer, and the design
is meant to make it sufficient almost always.
