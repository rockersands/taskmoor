# ADR-083: Entity properties in a table per entity kind, and declared indexes in typed side tables

- Status: Accepted
- Date: 2026-10-30
- Backlog: M1-129

## Context

API-013 asks for arbitrary JSON properties on tickets, tracks, people, boards and sprints. They
must be readable and writable through the API. Declared properties must be searchable. Its
acceptance criteria:

1. A property set through the compatible API is returned by both APIs.
2. A declared indexed property can be queried.

Integrations use properties to keep their own state next to the data: a review state, a
sync cursor, a build result. The values are documents, not fields. Nobody edits them in
the UI, and most are never searched. Custom fields already have typed side tables
(`v_text`, `v_number`, `v_time`, `v_id`; ADR-008), which the query compiler reads through one
shape.

## Decision

- **One table per entity kind:** `ticket_property`, `track_property`, `user_property`,
  `board_property` and `sprint_property` (migration 0066).
  - Each row holds the owner's id as a foreign key with `ON DELETE CASCADE`, a key of 1 to 255
    characters and a `jsonb` value.
  - Each row also records who changed it last, and when.
  - The primary key is `(owner, key)`.
  - Using real foreign keys means a purged ticket takes its properties with it. A single table
    with an `entity_type` column could not do that.
- **Limits:** a value is at most 32,768 bytes as JSON text, counted in UTF-8. A key has no
  control characters. The server checks both. Fastify's `maxParamLength` is raised to 3,072,
  so a 255-character key still fits in the path once percent-encoded.
- **Rights follow the owner:**
  - Reading needs what seeing the entity needs.
  - Writing needs what changing it needs: edit a ticket, administer a track, be the person
    (or a site administrator), configure a board, manage its sprints.
  - A hidden entity answers 404. An archived track's tickets and the track itself answer 409
    `track_archived` to writes.
- **Events, not audit records:** every write emits `<kind>.property_set` (with `created`) or
  `<kind>.property_deleted`. The events name the key, never the value.
  - Property writes are integration data, so they are not audited (`PROPERTY_DATA`).
  - Declaring and dropping an index changes what is searchable, so that is audited.
  - Webhooks can subscribe to the ticket events.
- **Declared indexes:**
  - A configuration administrator declares an index with `POST /api/v1/admin/property-indexes`:
    a ticket property key, a dot path inside its value (`''` for all of it), a type (`number`,
    `string`, `text`, `date`, `user`) and an optional alias.
  - The values found there become rows of `p_number`, `p_text`, `p_time` and `p_user`. These
    are shaped like the custom field side tables, with the index id in `field_id`, so the
    compiler and the visibility filter read them unchanged.
  - An array anywhere along the path gives one row per element.
  - A value of the wrong type is skipped: an index never fails a write.
  - Text is cut to 255 characters, as custom text is (ADR-008).
  - Dates are ISO days or instants.
  - People are ids or email addresses.
- **Kept in step in the writer's transaction:**
  - A property write rewrites the rows of its key.
  - A new index is filled from the properties already set, 1,000 tickets at a time, in its
    own transaction.
  - Every full rewrite of a ticket's custom field rows also rewrites its property rows: create,
    move, trash, restore and import. So a ticket in the trash is found by no property query, as
    by no field query.
- **Query syntax:**
  - `ticket.property[key].path`; `issue.property[key].path` in the Jira dialect.
  - The alias works as a plain field name, checked against system fields, custom fields and
    other aliases.
  - An undeclared key or path is refused with a message that says so.
  - Index types map to query types: number to number, string to labels, text to text (`~`),
    date to datetime, user to user. History predicates are refused.
- **The compatible API comes later:** the Jira-compatible property endpoints come with the
  compatibility layer (M1-069), over the same tables and rules. Criterion (1) of API-013 is
  met there.

## Options considered

| Option | For | Against |
|---|---|---|
| One `entity_property` table with an entity type column | One set of queries | No foreign keys: purges and deletes would need triggers or sweeps; one hot table for unrelated kinds |
| A table per kind (chosen) | Foreign keys and cascades; each kind's index stays small | Five tables with the same shape; table names chosen at run time in the routes |
| A GIN index on `jsonb` and `@>` / `jsonb_path` queries | No declaration step | No ordering, no ranges on dates and numbers, no words; plans the compiler cannot reason about; visibility filtering would differ from fields |
| Typed side tables per declared index (chosen) | The custom field compiler, ordering and visibility unchanged; predictable plans | A declaration step; rows to keep in step |

## Consequences

- Searching a property costs what searching a custom field costs, and only declared values
  take space.
- Dropping an index removes its rows, through the foreign key on `field_id`. The properties
  themselves stay.
- Upgrade rollback now also drops foreign keys added by a newer migration before restoring
  (`upgrade.ts`). Without that, the restore failed on the first FK added after the backup
  (`user_session_parent_id_fkey`, 0064).
- Possible follow-up: an index on a track or board property. That would need side tables keyed
  by those kinds, which no requirement asks for today.
