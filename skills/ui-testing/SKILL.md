---
name: ui-testing
description: Test user interface behaviour at the component and page level — rendering, state transitions, form validation, loading and error states, empty states, keyboard interaction and visual regression. Use when a UI change needs verifying below full end-to-end level, or when adding component or visual tests.
when_to_use: "test this component", "test the form", "visual regression", "does the UI render correctly", "test the loading state"
allowed-tools: Read, Glob, Grep, Bash, PowerShell, Write, Edit
metadata:
  system_version: 0.10.0
  role: specialist
---

# UI and Component Testing

Between unit tests and E2E. Faster and far more diagnostic than a full journey, and it
catches the states nobody looks at.

## Assert what a user perceives

Query by role, label and visible text. Not by class name, not by component internals.

```ts
// Weak — breaks on any refactor, proves nothing a user cares about
expect(wrapper.find('.btn-primary').props().disabled).toBe(true);

// Strong — describes what the user actually experiences
expect(screen.getByRole('button', { name: 'Pay now' })).toBeDisabled();
```

## The states that get skipped

Most UI defects are in states nobody demoed:

| State | Check |
| --- | --- |
| Loading | Is there an indicator? Is the control disabled so it cannot double-submit? |
| Empty | Does an empty list say something useful, or render a blank void? |
| Error | Is the error visible, specific, and recoverable — or a silent console log? |
| Partial | One of three panels failed: does the rest still work? |
| Long content | A 200-character name, a 4-digit quantity — overflow or layout break? |
| Zero and negative | £0.00, -1, a cart with 0 items |
| Slow network | Does the UI lock up, or double-fire the request? |
| Disabled / read-only | Are controls genuinely non-interactive, not just greyed? |

## Forms

- Each validation rule, at its boundary.
- Errors appear **and are associated** with their field (`aria-describedby`), not floating
  at the top.
- Submitting twice fast does not submit twice.
- Values survive a failed submit — losing a user's input is a real defect.
- Keyboard: tab order is sensible; Enter submits; Escape closes.

## Visual regression

Worth it only when there is a stable baseline and the UI is not changing weekly.
Otherwise the diff noise trains everyone to click "approve".

- Mask timestamps, avatars, ads and anything animated.
- Pin the viewport and disable animations.
- Fix fonts — font loading race conditions cause more false diffs than any real change.
- A diff is not a defect until someone looks at it. Report it as an observation until
  confirmed.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" evidence add --json '{"kind":"screenshot-diff","summary":"Checkout summary panel shifted 4px","epistemicClass":"observed","artifactPath":"__diff__/checkout.png"}'
```

Screenshot diffs are **corroborating** evidence: they show a change, not that a behaviour
is wrong.

## Component versus E2E

| Use component tests | Use E2E |
| --- | --- |
| Rendering and state logic | The journey across pages |
| Every validation branch | The one happy path that must never break |
| Error and empty states | Real integration with the backend |
| Fast feedback | Pre-release confidence |

Pushing every validation branch into E2E is the most common way a suite becomes slow and
gets ignored. Test the branches here; test the journey there.

## Accessibility overlap

Querying by role gets you accessibility checks nearly free: if `getByRole('button', {name})`
cannot find it, a screen reader cannot either. That is a real finding. Deeper conformance
work belongs to `accessibility-testing`.

## Evidence

Component test reports are execution evidence. Screenshots are corroborating. A component
test cannot support a claim about the deployed application — say which it was.

## Common mistakes

- Snapshot tests over everything. They fail on cosmetic change and pass on broken
  behaviour — maximum noise, minimum signal.
- Mocking the component under test.
- Asserting on implementation state rather than rendered output.
- Testing only the happy path when the states above are where the bugs are.
