# Escalation Policy

When to stop and ask — and, more often, when not to.

## Default: keep working

A blocker stops one branch, never the session. The single most common failure mode of an
autonomous testing agent is stopping the moment anything is unclear, when 80% of the work
was still available.

**Worked example.** The payment provider credentials are unclear. Do **not** stop. Do:

- run the unit suite
- run API tests against a mocked provider
- read the checkout implementation and map the code paths
- run the existing regression suite
- write the E2E spec **and run it now** with the provider mocked at the HTTP boundary — the
  whole journey except the one hop that needs the key
- record `U-00019` (`user-input-required`) and mark only the real-provider run `BLOCKED`,
  with `test_files` naming the spec so the hold is traceable
- note the independent work against the uncertainty so the record shows you did not stall

Then ask — once, at the end, with the context of everything you already did.

A test written and not run is a draft, not an asset. `validate --final` fails on any test
file written this session that no execution ran.

## Hold only when no option is left

Before recording anything `BLOCKED`, walk this ladder. Each rung is a way to run the work
anyway; stop at the first that applies and run it.

1. **Start it locally.** A repository can be run. "No running instance" is a reason only
   after you tried to start it and captured why it failed.
2. **Stand in for the missing piece.** Mock or stub the unavailable dependency at its
   boundary; seed your own test data; create your own test account on a non-production
   target.
3. **Take another route.** Admin override, direct API call instead of the UI, a different
   role, a fixture instead of a live upstream.
4. **Shrink it.** Run the read-only half, the single-record version, the happy path without
   the side effect.
5. **Only then hold it** — as `exec not-run` with `BLOCKED`/`NEEDS_USER_INPUT`, linking an
   uncertainty whose status says what is outside your control (`environment-unavailable`,
   `user-input-required`, `external-dependency`, `blocked`), and record which rungs you
   tried in its `independentWork`.

The engine enforces the shape of this. A hold counts toward the coverage floors only while
it links an **open** uncertainty you cannot clear yourself. Your own `deferred` uncertainty
("ran out of time", "later") does not count; neither does a skip with no blocker. A hold you
attribute to the user (`owner: "user"` with a non-blocking status) counts only with
`"user_quote"`: the user's words, found in the session request or a recorded statement.
Labelling your own choice as the user's does not make it theirs. When a
blocker is resolved, every item it held becomes owed again and appears in `ast todo` as
`unblocked-not-rerun` — run it in the same session.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" uncertainty partition --input scenarios.json
```

If `runnable` is non-empty, you are not blocked. You have one blocked branch.

## Escalate immediately when

- **Every** planned scenario is blocked by the same thing.
- The next action is `prohibited-by-default` (merging, deleting, closing, deploying,
  executing a payment, touching production).
- The only way forward touches an environment you cannot confirm is non-production.
- A finding is severity `blocker` and actively harmful — a data leak, an authorisation
  bypass, money moving incorrectly. Surface it before continuing.
- Acting on either reading of an ambiguous requirement would make the work wrong.
- The browser decision engine returns `escalate: true` and the choice materially changes
  the outcome.
- You would have to fabricate something to proceed.

## Do not escalate for

- A question you can answer by reading the repository.
- A preference with an obvious default — pick it, state that you picked it, move on.
- Permission to *read* anything.
- Reassurance. If the evidence supports the claim, make the claim.
- Each item in a batch. Ask once, for the batch.
- **Moving from one planned must-test scenario to the next.** The plan was agreed up front;
  execute them in order. Stop only for a genuine blocker (missing credentials, unreachable
  environment) — record it BLOCKED with a linked uncertainty and its `planScenarioId`, then
  continue to the next scenario. Stopping to ask "shall I proceed to scenario S-03?" after
  completing S-02 is the single largest cause of sessions that plan 15 scenarios and run 2.
- An in-bounds security technique on an authorised non-production target. Sending
  XSS/SQLi-shaped strings, IDOR probes, malformed tokens, mass-assignment payloads and
  the rest of the in-bounds list (`security-testing/SKILL.md` §8) is standard QA — proceed
  and record findings. Only flag-and-stop techniques (§9) require stopping.

## How to ask

Bad: "I need more information to proceed."

Good:

> Payment E2E is blocked: `stripe` is configured from `STRIPE_SECRET_KEY`, which is unset
> here, and I will not transact against a live key. **Which do you want?**
>
> (a) Give me a sandbox key — I run the full payment journey.
> (b) I mock the provider at the HTTP boundary — covers our logic, not the integration.
> (c) Skip it — I record it as a coverage gap.
>
> Meanwhile I have run the unit suite (87/87 at `abc1234`), the API contract tests
> against a mock (12/12), and written and run the E2E spec with the provider mocked (5/5).
> Only the real-provider hop is untested. One real defect so far: `FIND-00003`, order not
> persisted after successful payment.

State the blocker, the options with their consequences, and what you did anyway.

## Severity and urgency

| Finding | Response |
| --- | --- |
| `blocker` — data loss, auth bypass, money wrong | Interrupt. Say it first, before anything else. |
| `critical` — core journey broken | Surface in this turn; keep testing around it. |
| `major` | Report normally. |
| `minor` / `trivial` | Batch into the report. |

## Uncertainty statuses

`unresolved` `blocked` `deferred` `user-input-required` `environment-unavailable`
`ambiguous-requirement` `insufficient-evidence` `external-dependency` `interrupted`
`future-case` `resolved`

Only `user-input-required` implies you should ask. The rest are things to record and work
around. Every entry needs an `affected_scope` and a `next_action` — an uncertainty with
no next action is a shrug, not a record.

## Never

- Leave a test you wrote unexecuted.
- Hold work on your own say-so. A self-owned deferral is a choice, not a blocker.
- Silently drop blocked work. It goes in the report with its status.
- Present a blocker as a completed test.
- Ask permission for something already authorised in this session.
- Stop because one thing failed. Classify it, respond to the classification, continue.
