# Examples

## A note on what these are

**The walkthroughs are illustrative, not records of real runs.** IDs, command outputs and
findings are invented to show the shape of the process. Nothing in them is evidence of
anything.

That disclaimer is not boilerplate. A system built around "never present prose as proof of
execution" would be hypocritical if its own examples read like real results.

Real runs produce records under `state/`, and those records are the evidence. The
[artifacts/](artifacts/) directory holds examples of what those look like — also
illustrative, and labelled as such.

## Walkthroughs

| | Scenario | Read it for |
| --- | --- | --- |
| **[A](walkthroughs/A-test-a-react-app.md)** | "Test this React application" | An open-ended request. What the agent decides **not** to do, and why 23 categories were excluded with reasons. |
| **[B](walkthroughs/B-test-a-pull-request.md)** | "Test PR #412" | Change-aware testing. Base-and-head baselining, disambiguating a capped-confidence classification, and catching a weakened assertion in the diff. |
| **[C](walkthroughs/C-test-a-new-feature.md)** | "Test the new payment feature" | **The blocked-branch case.** A missing credential stopped 2 of 13 scenarios and none of the other 11. |
| **[D](walkthroughs/D-explore-then-automate.md)** | "Explore for UI bugs and create regression tests" | **The reference pattern.** Explore to learn, script to assert. Built around the browser decision engine. |
| **[E](walkthroughs/E-jira-to-test-plan.md)** | "Read SHOP-412 and create a test plan" | An unavailable connector, a requirement hiding in a comment, and an ambiguity handled without guessing. |

If you read one, read **D**. It is the pattern the browser decision engine exists to produce.

## What each demonstrates

Themes worth noticing across all five:

**Honest degradation.** A missing browser (A), missing credentials (C) and an unauthorised
Jira connector (E) each produce `BLOCKED` work that appears in the report — never a quietly
reduced scope.

**One blocker never stops the session.** C is the clearest: eleven of thirteen scenarios ran,
the blocked ones got execution records, and the blocked test was *written* so it is ready the
moment the credential arrives.

**Cheap categories first.** In both A and C the most serious finding came from the cheapest
applicable category — an API authorisation test in A, unit-level arithmetic in C. Neither
needed the expensive tooling.

**Classification before accusation.** B shows a 403 producing a *capped-confidence*
classification that triggers disambiguation rather than a defect report.

**Explore, then assert.** D shows why neither half works alone: exploration leaves nothing
behind; a script written blind encodes guesses about a UI nobody opened.

**A plan is not a result.** E ends with nothing executed and nothing posted, stated plainly.

## Artifacts

[artifacts/](artifacts/) holds example records — a report, an execution log, a decision, a
GitHub issue, a testing strategy document — showing the shape each takes. Same disclaimer:
illustrative, not real.
