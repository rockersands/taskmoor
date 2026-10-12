# ADR-024: Internationalisation and accessibility

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-031, M0-032

## Context

Public-sector and enterprise buyers require localised interfaces and WCAG 2.1 AA. Both are
cheap to build in from the first screen and expensive to retrofit, and both can be checked by
machines on every change, which is how this project verifies work.

## Decision

### Internationalisation

- Messages use ICU MessageFormat through `react-intl`. The English catalogue
  (`apps/web/src/i18n/messages.en.ts`) is the source; every user-visible string has a stable ID,
  grouped by screen. Components never contain literal UI text.
- Other locales are catalogues with the same IDs. A missing message is an error, not a
  fallback: the provider throws outside production.
- `en-XA` is a pseudo-locale generated at runtime: letters accented, text lengthened by about a
  third and wrapped in brackets, with ICU arguments, plurals, selects and tags preserved. It is
  selected with `?locale=en-XA` or a saved preference.
- Gates: a component test and a Playwright test render the shell in `en-XA` and fail if any
  visible text, `aria-label` or `title` is not bracketed, or if the provider reported a missing
  message. Right-to-left layout and date, number and list formatting through `Intl` follow when
  the first such screen appears (M1).

### Accessibility

- Target: WCAG 2.1 AA. Semantic HTML first; roles and names are what tests query, so an element
  without an accessible name fails a test before it fails a user.
- Every story in Storybook runs as a browser test through the Vitest addon with the a11y
  addon's axe checks; a serious or critical violation fails `pnpm verify`. New components must
  come with stories.
- Keyboard: every control reachable and operable with the keyboard, visible focus, focus traps
  only in modal dialogs with Escape to close and focus restored afterwards (the shell's drawer
  is the pattern).
- Touch targets of at least 44px on coarse pointers; desktop stays the primary layout (ADR-033).

## Options considered

| Option | For | Against |
|---|---|---|
| react-intl / ICU (chosen) | Standard plural and select rules; extraction tooling; typed IDs | A dependency and a catalogue to maintain |
| i18next | Popular | Its own format; ICU only through a plugin |
| Template strings and a lookup table | No dependency | Plurals and genders by hand; no tooling |
| Storybook + axe (chosen) | Checks the real DOM in a real browser; stories double as documentation | Browser-mode tests cost a few seconds |
| axe in jsdom only | Faster | No colour contrast or layout rules |

## Consequences

Adding a string means adding a catalogue entry; the pseudo-locale test catches the ones that
bypass it. Adding a component means adding a story; the axe check catches the obvious
accessibility mistakes, and manual screen-reader passes remain part of each milestone gate.
