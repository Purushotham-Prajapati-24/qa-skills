---
name: accessibility-testing
description: Test a user interface for accessibility — automated WCAG scanning, keyboard navigation, focus management, screen reader semantics, colour contrast, form labelling, and the manual checks automation cannot perform. Use when a web UI changed, when accessibility conformance is required, or when asked to check a11y or WCAG compliance.
when_to_use: "accessibility testing", "a11y", "WCAG", "is this screen reader friendly", "keyboard navigation test", "contrast check"
allowed-tools: Read, Glob, Grep, Bash, PowerShell, Write, Edit
metadata:
  system_version: 0.6.0
  role: specialist
---

# Accessibility Testing

The number that governs everything here: **automated scanners detect roughly a third of
WCAG issues.** A clean axe run is a starting point, not a conformance claim. Never report
"accessible" on the basis of a passing scan.

## Automated pass

```bash
npm ls @axe-core/playwright axe-core jest-axe 2>/dev/null
npx playwright test --grep @a11y
```

If the repository has no a11y tooling, wire axe into the existing browser or component
test setup rather than introducing a parallel stack.

Scan every distinct page or view state — including the states nobody demoes: empty,
loading, error, modal open, validation failed.

## What automation reliably catches

Missing `alt`, unlabelled form controls, insufficient colour contrast, missing document
language, duplicate IDs, invalid ARIA attributes, empty headings and links, missing landmarks.

## What it cannot catch, and you must check manually

This list is the actual value of this skill.

**Keyboard** — every interactive element reachable by Tab; visible focus indicator at all
times; **no focus traps** (open a modal, can you Escape and get back?); logical tab order
matching visual order; a skip link before the navigation.

**Focus management** — opening a modal moves focus into it; closing returns focus to the
trigger; route changes move focus to the new heading; a validation error moves focus to
the first invalid field.

**Semantics** — headings form a real outline (no h1→h4 jumps); a list is a list; a button
is a `<button>`, not a clickable `<div>`; tables have proper headers; landmarks are used
once each.

**Alt text quality** — a scanner sees `alt` exists. Only a human sees that `alt="image"`
is useless, that a decorative image should be `alt=""`, or that an alt describing a chart
should convey its data.

**Dynamic content** — live regions announce updates; loading states are announced, not
just spun; errors are announced when they appear.

**Contrast in context** — text over an image or gradient; focus indicators against their
background; disabled states that are still readable.

**Motion and zoom** — `prefers-reduced-motion` respected; usable at 200% zoom and at 320px
width without horizontal scrolling.

## Running the manual checks

Keyboard checks are automatable enough to be worth scripting:

```ts
await page.keyboard.press('Tab');
await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
// open modal, then:
await page.keyboard.press('Escape');
await expect(page.getByRole('button', { name: 'Open settings' })).toBeFocused();
```

For screen-reader semantics, read the accessibility tree rather than guessing — it is what
assistive technology actually consumes.

## Reporting

Cite the **success criterion**, not just "a11y issue":

> **WCAG 2.2 AA — 2.4.7 Focus Visible (Level AA)**
> The "Pay now" button shows no focus indicator when reached by keyboard; the custom
> `:focus` rule sets `outline: none` without a replacement (`checkout.css:88`).
> Impact: keyboard users cannot tell what is focused on the payment step.
> Evidence: `EV-2026-00044` (screenshot), `EV-2026-00045` (axe report).

Severity by user impact: a keyboard trap that blocks checkout is `critical`; a
low-contrast footer link is `minor`.

## Evidence

Axe JSON output is an `accessibility-scan` — **execution evidence**. Screenshots are
corroborating. Manual findings are `observed` when you performed the check, and you must
say which checks you performed and which you did not.

## The honest claim

> Automated axe scan: 0 violations across 4 page states (`EV-2026-00044`). Manual keyboard
> traversal, focus management and heading structure checked on the checkout flow only.
> **Not checked:** screen reader announcement behaviour, 200% zoom, reduced motion, and the
> account pages. Automated scanning detects roughly a third of WCAG issues, so this is not
> a conformance statement.
