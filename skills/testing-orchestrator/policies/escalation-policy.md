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
- write the deterministic E2E spec so it is ready the moment credentials arrive
- record `U-00019` (`user-input-required`) and mark payment E2E `BLOCKED`
- note the independent work against the uncertainty so the record shows you did not stall

Then ask — once, at the end, with the context of everything you already did.

```bash
node bin/ast.mjs uncertainty partition --input scenarios.json
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
> against a mock (12/12), and drafted the E2E spec so it is ready either way. One real
> defect so far: `FIND-00003`, order not persisted after successful payment.

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

- Silently drop blocked work. It goes in the report with its status.
- Present a blocker as a completed test.
- Ask permission for something already authorised in this session.
- Stop because one thing failed. Classify it, respond to the classification, continue.
