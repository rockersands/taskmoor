# Ticket templates: task file (branch `claude/ticket-templates`)

Asked for by the user on 2026-11-02 for 1.0 (M1). Requirement IDs reserved: CORE-029 (templates:
what they hold, scope, management) and CORE-030 (creating a ticket from one). ADR number:
ADR-113. Migration: 0085 (0084 is reserved for another session).

## Handoff (2026-11-03, local session, Windows)

**Numbers taken:** ADR-113, migration `0085_ticket_templates`, requirements CORE-029 and CORE-030.

**State:** everything in the task table is written and passes the targeted runs below. The only
thing left is the coordinator's whole gate (TT-9) and the merge.

**Targeted runs, all passing:** `templates/model.test.ts`, `routes/ticket-templates.test.ts` (9),
`events/contract.test.ts`, `tokens/scopes.test.ts`, `audit/*`; the web tests in
`apps/web/src/tickets/templates`, `tickets`, `tracks`, `i18n`, `shell`; the stories of
`tickets/templates` and `CreateTicketPage` in both skins; `e2e/ticket-templates.spec.ts` on desktop and
mobile; `pnpm i18n:check`; `pnpm run docs`. The `packages/db` project had 39 of 40 pass: the
`ticket-types.test.ts` migration test hit its 20 s limit with other work on the machine, and passes
alone.

**Web, added:** `apps/web/src/tickets/templates/` (`client.ts`, `start.ts` from a template's `start` to
the form and back to `omit`, `draft.ts` the management form's values, `TemplatePicker.tsx`,
`TemplateForm.tsx`, `TicketTemplatesPage.tsx`, fixtures, stories, tests), `styles/ticket-templates.css`,
routes `#/tracks/KEY/templates` and `#/admin/ticket-templates` in `App.tsx`, a palette command, links on
the track summary and in Settings. The edit to `CreateTicketPage.tsx` is about 50 lines; the logic is
in `tickets/templates`.

**Design decisions so far:**
- One table; `track_id` null = every track; `ticket_type_ids` empty = every type; name unique
  per track ignoring case. Defaults use the create route's body names; dates are day offsets
  (`dueInDays`, `startInDays`) from today in the person's time zone; summary pattern takes
  `{date}`, `{track}`, `{user}`. Subtickets: summary and optional type (else the track's first
  subticket-level type); at most 50. Areas and releases only in track templates.
- Track templates: seen by the track's browsers, managed by "Administer track" or
  configuration/site administrators. Every-track templates: seen by everyone signed in, managed
  by configuration/site administrators. Scope classes read/write by method.
- Creating from a template calls the ticket create route as the person (all checks apply). The
  person's body values win; absent keys take the template's value unless listed in `omit`; a body
  value equal to the template's counts as the template's. Template values the route refuses are
  left out and returned in `left`; the person's own are refused. Subtickets follow, each its own
  create; failures listed, the ticket stays. No template event on apply: one `ticket.created`
  per ticket with `templateId` (N+1 events with N subtickets; the contract scenario uses none).
- DC importer (for the ADR): core backups have no ticket templates; field-context default
  values are already imported; third-party app tables are not read. No import is built.

**Decisions made while building the web:**
- The picker lists the templates for the track and type chosen now, so a choice always fits. Changing
  the type or track lets go of the template and keeps what is typed.
- What the backend will refuse (hidden, off the layout, locked) is never filled in. It stays out of the
  body, the backend leaves it out and the form names it after Create.
- Values on the layout with no control in the form (assignee, areas, releases, other custom types) are
  listed under the picker with a checkbox; turned off, they go in `omit`.
- The management form edits text, number, date, URL, choice and label custom fields. Other types, and
  an assignee on a template for every track, are API-only, and a save keeps them. This follows the
  precedent of the configuration sets page.
- Every-track templates are read-only on a track's page: that form would offer the track's areas and
  releases, which they cannot hold.
- The template's view gained `assignee: { id, name }`, so the form can show who it names.

**Found, not changed:** in the create dialog, Escape does not close the dialog after Create, because the
submit button is disabled while busy and focus falls out of the dialog's key handler
(`CreateTicketDialog.tsx`). It is older than this branch and the UI overhaul edits that area.

| Task | State | Notes |
|---|---|---|
| TT-1 Data: migration 0085, `schema.ts`, upgrade seed, schema golden | Done | Passed in the `packages/db` run (see above) |
| TT-2 API: list, read, create, update, delete, create-from-template | Done | 9 route tests |
| TT-3 Events, audit decisions, scope classes, contract scenarios | Done | Contract, scope and audit suites run and pass |
| TT-4 Spec rows CORE-029, CORE-030 and `requirements-index.csv` | Done | |
| TT-5 ADR-113 | Done | `docs/adr/0113-ticket-templates.md`, with the DC importer note |
| TT-6 Web: template picker in the create dialog | Done | |
| TT-7 Web: management page (track and every-track) | Done | en and es, stories, tests by role and name, phone layout, e2e spec |
| TT-8 Manual: `use/tickets.md`, `admin/tracks.md` | Done | |
| TT-9 Gate: `pnpm verify --e2e` | Coordinator | Not run here, by agreement |
