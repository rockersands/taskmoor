# Ticket templates: task file (branch `claude/ticket-templates`)

Asked for by the user on 2026-11-02 for 1.0 (M1). Requirement IDs reserved: CORE-029 (templates:
what they hold, scope, management) and CORE-030 (creating a ticket from one). ADR number:
ADR-113. Migration: 0085 (0084 is reserved for another session).

## Handoff (2026-11-03, cloud session; resume locally)

**Numbers taken:** ADR-113 (not yet written), migration `0085_ticket_templates`, requirements
CORE-029 (templates: content, scope, management) and CORE-030 (creating a ticket from one).

**Gate steps:** passed: `tsc -b` (typecheck), Biome on `apps/server/src` and `packages/db/src`,
`templates/model.test.ts` (6) and `routes/ticket-templates.test.ts` (7). The schema golden was
regenerated with `pnpm verify --update` (only the `ticket_template` table added, reviewed).
Not run: `events/contract.test.ts`, `tokens/scopes.test.ts`, `audit/*`, `packages/db` after the
golden update, the full `pnpm verify`, `pnpm verify --e2e`. The first commit on this branch has
no "WIP:" subject but is work in progress too.

**Half-done, by file:**
- Server, written and tested: `packages/db/src/migrations/0085_ticket_templates.ts`,
  `packages/db/src/schema.ts` (`TicketTemplateTable`), `packages/db/src/upgrade-fixtures.ts`,
  `packages/db/src/__golden__/schema.json`, `apps/server/src/templates/model.ts`,
  `apps/server/src/routes/ticket-templates.ts` (registered in `app.ts`), their tests.
- Server, written but not run: `events/catalogue.ts` (`ticket_template.*`, optional
  `templateId` on `ticket.created`), `audit/subscriber.ts`, `events/contract.test.ts` (four
  scenarios before `POST /api/v1/tickets`), `tokens/scopes.ts` (comment) and `scopes.test.ts`.
- Small edits elsewhere: `tickets/caller.ts` (`ticketTemplateId`), `routes/tickets.ts` (emits
  `templateId`), `clone/run.ts` (`refusedKeys` exported).
- Not started: web, spec, ADR, manual.

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

**Left before `pnpm verify --e2e` can pass and the branch can merge for 1.0:**
1. Run the unrun suites above and fix what fails.
2. Spec section in `docs/specs/01a-core-work-tracking.md` and rows CORE-029, CORE-030 in
   `requirements-index.csv` (tests already cite them); ADR-113.
3. Web: picker in `apps/web/src/tickets/CreateTicketPage.tsx` (keep it small; the UI overhaul
   branch edits this file) filling the form from `GET /api/v1/ticket-templates/:id?track=KEY`
   (`start`) and posting to `POST /api/v1/ticket-templates/:id/tickets` with `omit` and
   `subtickets`; management page at `#/tracks/KEY/templates` and `#/admin/ticket-templates`;
   strings in `messages.en.ts` and `messages.es.ts`, stories, tests by role and name, phone
   layout, an e2e spec; `pnpm i18n:check` clean.
4. Manual: `docs/manual/use/tickets.md`, `docs/manual/admin/tracks.md`; `progress.csv`.
5. Full `pnpm verify --e2e`, then hand to the main session for the merge.

**Locally (WSL 2):** the embedded Postgres works there when not running as root; no
`TASKMOOR_TEST_DATABASE_URL` needed.

| Task | State | Notes |
|---|---|---|
| TT-1 Data: migration 0085, `schema.ts`, upgrade seed, schema golden | Done, not gated | `ticket_template`; golden regenerated (one table added, reviewed) |
| TT-2 API: list, read, create, update, delete, create-from-template | Done, not gated | `routes/ticket-templates.ts`, `templates/model.ts`; 13 tests pass |
| TT-3 Events, audit decisions, scope classes, contract scenarios | Written, not run | Contract scenarios and scope expectations added; their files were not run after the change |
| TT-4 Spec section (CORE-029, CORE-030) and `requirements-index.csv` rows | To do | Tests already cite the IDs; `pnpm trace` will flag them until the rows exist |
| TT-5 ADR-113 | To do | Content in HANDOFF (2026-11-03 entry); include the DC importer note |
| TT-6 Web: template picker in the create dialog | To do | See HANDOFF for the agreed protocol |
| TT-7 Web: management page (track and every-track) | To do | `#/tracks/KEY/templates`, `#/admin/ticket-templates`; strings en and es, stories, phone layout |
| TT-8 Manual: `use/tickets.md`, `admin/tracks.md` | To do | |
| TT-9 Gate: `pnpm verify --e2e` | To do | Not run on this branch |
