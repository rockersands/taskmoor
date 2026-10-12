# ADR-033: Desktop-first, responsive UI

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-031, M0-032

## Context

The user's priority: the product is used mainly on PCs, and it must also work on phones. Work
tracking involves dense tables, boards and keyboard-heavy flows that suit large screens, but
people also triage, comment and approve from phones.

## Decision

- Desktop is the primary target. Layouts, density and keyboard shortcuts are designed for
  desktop browsers first, and desktop wins any trade-off.
- The same frontend stays responsive down to 360px wide. Below 768px the sidebar becomes a modal
  drawer; wide tables and boards scroll inside their own container, never the page.
- Touch screens (`pointer: coarse`) get targets of at least 44px and touch drag and drop for
  boards and backlogs.
- Every layout change is tested on both a desktop (1440x900) and a mobile (Pixel 7) Playwright
  project; component tests cover the compact layout with `setViewportWidth()`.
- Native mobile apps stay an M3 item and reuse the same API.

## Consequences

Some screens need a compact variant (for example, a board shows one column at a time on a phone).
That costs extra component work but no separate app.
