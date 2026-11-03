# Ticket templates: task file (branch `claude/ticket-templates`)

Asked for by the user on 2026-11-02 for 1.0 (M1). Requirement IDs reserved: CORE-029 (templates:
what they hold, scope, management) and CORE-030 (creating a ticket from one). ADR number:
ADR-113. Migration: 0085 (0084 is reserved for another session).

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
