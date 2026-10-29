# ADR-051: Configuration guardrails

- Status: Accepted
- Date: 2026-10-29
- Backlog: M1-055

## Context

CORE-026 asks for the limits of spec 01a section 1.7 as admin-adjustable guardrails: usage shown
against every limit, an addition beyond a limit refused (a bulk one entirely) with existing
configuration untouched, and a raise effective at once with performance guidance. Two limits
were already fixed in code (options per field, levels per visibility policy), each with its own
refusal.

## Decision

- **Ten guardrails, by name** (`apps/server/src/guardrails/model.ts`): fields per track,
  ticket types per track (a type set's size), options per field, visibility levels (per
  policy), grants per permission (per access policy), releases per track (archived ones
  aside), workflows per workflow map (the default and every entry, distinct), statuses per
  workflow (a definition's), areas per track (archived ones aside) and priorities per priority
  set. Defaults are the spec's.
- **A workspace's own limits** live in `guardrail_limit` (migration 0050), one row per changed
  guardrail; a missing row means the default. `PUT /api/v1/admin/guardrails/:name` sets one
  (site administrators, the admin token scope, the `guardrail.changed` event, audited); `GET`
  shows each limit, its default and where it is used most, counted live.
- **One refusal everywhere:** 409 `{ error: 'guardrail_exceeded', guardrail, limit }`. A route
  calls `enforceLimit` with the count an addition would make, inside its transaction (after
  locking the parent row where two additions could race) or before it for a body that carries
  the whole list. `enforceLimit` throws `GuardrailExceeded`, the transaction rolls back, and the
  app's error handler answers; nothing a refused call wrote stays. The old fixed refusals
  (`too_many_options`, `too_many_levels`) are replaced by it.
- **Fields per track** is checked where a field's scopes are written: when a field comes to
  reach tracks it did not reach, the largest count among those tracks (shared fields reaching
  every track included) plus this field must fit.
- **Existing configuration stays:** a lowered limit refuses further additions only; the admin
  page marks usage above its limit.

## Consequences

- A new kind of configuration with a limit adds a name to `GUARDRAILS`, a usage query, a call to
  `enforceLimit` and a string.
- Usage is counted on each visit to the admin page; at 30,000 tracks the fields-per-track count
  (a subquery per track) is the slow one, and the place to add a running count if it shows.
- Not covered: limits on people, groups or tickets (spec 05b section 3 scale targets are
  capacity goals, not guardrails).
