# Regression suite

Benchmark cases derived from **real sessions where the agent got something wrong**.

The benchmark cases in [../benchmark-cases/](../benchmark-cases/) are designed. These are
discovered — and discovered cases are more valuable, because nobody imagined them.

## The loop

1. A live session produces a bad decision: the wrong browser method, an over-scoped plan, a
   category wrongly excluded, a failure misclassified, a false-confidence claim.
2. Capture the **inputs** that produced it — the signals, factors and capabilities — into a
   case file here, using the same shape as a benchmark case.
3. Assert the outcome that *should* have happened.
4. Run it. It fails. That failure is the point: a regression case you never saw fail proves
   nothing.
5. Fix the **policy** — `weights.json`, `catalog.json`, `matrix.json`, `policy.json` — not
   the engine code, unless the engine is genuinely wrong.
6. Re-run the whole suite. Fixing one case must not break another.

## Case shape

Identical to a benchmark case, plus provenance:

```jsonc
{
  "id": "reg-001",
  "title": "Selected MCP exploration for a scenario that needed a CI gate",
  "context": "Session SESSION-0042 on repo shop, 2026-08-14.",
  "observed_failure": "browser decide returned playwright-mcp although ci_suitability was 0.85. The hard rule did not fire because ci_suitability was supplied as a string rather than a number.",
  "source_session": "SESSION-0042",
  "source_decision": "DEC-00113",
  "given": { "browser_factors": { "...": 0 } },
  "expect": { "browser_method": "playwright-script" },
  "reasoning_notes": ["..."]
}
```

`observed_failure` and `source_decision` are what make these readable in six months. A
regression case without the story behind it becomes an arbitrary assertion nobody dares
change.

## Running

`ast eval run` loads these alongside `benchmark-cases/`; each result carries `suite: "regression"`.
A case goes in only after it has been run against the engine version that produced the field
failure and seen to fail there -- say which version in `reasoning_notes`.

A case may supply `given.profile` instead of `given.signals`. The signals are then derived
by `signalsFromProfile` (checked with `expect.profile_signals_include`), so a gap in the
profile-to-signal mapping is caught, not only a gap in the matrix.

## Cases

| Case | Source | What went wrong |
| --- | --- | --- |
| reg-001 | Field trial 3, AgentDesk | Production URL, environment omitted as in the `--example` -> `browser decide` chose MCP exploration of production |
| reg-002 | Field trial 3, AgentDesk | Production + unseen UI must escalate; an `environment` field was silently ignored |
| reg-003 | Field trial 3, AgentDesk | Profile could not express responsive / deploy-config / rag, so those categories were N/A |
| reg-004 | Field trial 2, Madhubala (G-09) | Dependency-scan finding with no runtime signal had no class to go to |
| reg-005 | Field trial 3, AgentDesk | A runner invoked wrongly had no signal token; unknown tokens were dropped silently |

## Fix the policy, not the case

If a case fails, the first question is whether the **expectation** is right — as happened
with four of the designed cases (see [../README.md](../README.md)). If it is right, fix the
policy. Changing an expectation to make a test pass is only legitimate when the expectation
was wrong, and you must record why in `reasoning_notes`.

That is the same rule this system applies to the software it tests. It applies to itself too.
