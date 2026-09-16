---
name: compatibility-testing
description: Test across browsers, viewports, devices, locales and runtime versions — cross-browser behaviour, responsive layout, mobile viewports, localisation and internationalisation, and dependency or runtime version compatibility. Use when a support matrix exists, when a UI must work on more than one browser or screen size, or when localisation is in scope.
when_to_use: "cross browser testing", "responsive testing", "does this work on mobile", "test the translations", "i18n testing", "does it work on Node 18"
allowed-tools: Read, Glob, Grep, Bash, PowerShell, Write, Edit
metadata:
  system_version: 0.7.0
  role: specialist
---

# Compatibility Testing

## Establish the support matrix first

Without a stated matrix this is unbounded. Look for `browserslist`, a support statement in
the README, analytics data, or `engines` in `package.json`. If none exists, that absence is
a `requirement-ambiguity` — testing "all browsers" is not a scope.

```bash
npx browserslist
grep -A5 '"engines"' package.json
ls src/locales src/i18n public/locales 2>/dev/null
```

## Cross-browser

Test where engines genuinely differ — Chromium, Gecko, WebKit. Three Chromium-based
browsers are largely one test.

Where real differences still bite: date and number input controls, `Intl` formatting,
scroll and overscroll behaviour, focus handling, form validation UI, CSS features at
different support levels, Safari's stricter cookie and storage policies, and font
rendering affecting layout.

Run the critical journeys on each engine; run the long tail on one.

## Responsive and viewport

Test the breakpoints the CSS actually declares, plus the extremes:

| Viewport | Why |
| --- | --- |
| 320 × 568 | Smallest realistically supported. Where layouts break. |
| 375 × 812 | Common phone |
| 768 × 1024 | Tablet, and often an untested middle |
| 1280 × 800 | Laptop |
| 1920 × 1080 | Desktop |

Check: no horizontal scrolling; touch targets ≥ 44px; content not hidden behind fixed
bars; modals fit and scroll; tables degrade rather than overflow; images do not force
overflow.

A mobile **viewport** is not a mobile **device**. Emulation gets you layout; it does not
get you real touch behaviour, real network conditions or real device performance. Say which
you tested.

## Localisation and internationalisation

The highest-yield checks, in order:

1. **Long translations.** German and Finnish routinely run 30–40% longer than English.
   Buttons and navigation break first.
2. **RTL.** If Arabic or Hebrew is supported: does the layout mirror, do icons flip, are
   numbers still LTR?
3. **Missing keys.** Do untranslated strings fall back sensibly, or render `checkout.title`
   to the user?
4. **Dates, numbers, currency.** `1,000.50` vs `1.000,50`; `MM/DD` vs `DD/MM`. Ambiguous
   dates cause real user error.
5. **Pluralisation.** Languages with more than two plural forms break naive `n === 1` logic.
6. **Concatenation.** Sentences built by joining fragments are untranslatable and usually
   wrong.
7. **Sorting and collation** for non-ASCII alphabets.
8. **Input** — non-Latin names, accented characters, emoji. Round-trip them through storage
   and back; encoding bugs surface here.

## Runtime and dependency versions

- Does it run on the minimum declared Node/Python/JVM version, not just yours?
- Does a lockfile-free install still resolve to something that works?
- Test the **oldest** supported version, not only the newest. That is the one that breaks.

```bash
docker run --rm -v "$PWD:/app" -w /app node:18 npm test
```

## Running

```bash
node bin/ast.mjs caps resolve browser.run_deterministic_test
npx playwright test --project=chromium --project=firefox --project=webkit
node bin/ast.mjs caps resolve browser.resize
```

If only one engine is installed, that is a genuine limitation. Report cross-browser as
`BLOCKED` for the missing engines — never as covered.

## Evidence

Per-configuration test reports are execution evidence. Screenshots per viewport and locale
are corroborating. Always record which browser, which version, which viewport, which locale
— a result without its configuration is not a compatibility result.

## The honest claim

> Critical journeys ran on Chromium 131 and Firefox 133 (`EV-2026-00071`, `EV-2026-00072`).
> **WebKit was not tested** — not installed in this environment (`U-00024`, blocked).
> Viewports 375, 768 and 1280 checked; 320px was not. Locales: `en-GB` only; the repository
> ships `de-DE` and `ar-EG`, which remain untested — `de-DE` is the higher risk because
> longer strings are the most common layout break.
