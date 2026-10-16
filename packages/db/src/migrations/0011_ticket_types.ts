import { type Kysely, sql } from 'kysely';

/**
 * Ticket types, hierarchy levels and type sets (M1-007; CORE-005, CORE-006, CORE-007; spec 01a
 * section 1.2; ADR-009).
 *
 * - `hierarchy_level`: the levels of a workspace. Three are built in (`kind` subticket,
 *   standard and outcome at ranks -1, 0 and 1); custom levels sit at rank 2 and above. Ranks
 *   are unique per workspace through a deferred constraint, so renumbering the custom levels
 *   when one is inserted, moved or removed happens in one transaction.
 * - `ticket_type`: name, description, icon, colour and level. A type with `owner_track_id`
 *   belongs to one local-mode track (section 1.1); the others are shared.
 * - `type_set`: the ordered ticket types a track offers, with the default one preselected
 *   (CORE-005). A set with `owner_track_id` belongs to one local-mode track. A deferred foreign
 *   key keeps the default type a member of its set.
 * - `type_set_default`: the set new tracks of each track type use (shared mode) or copy (local
 *   mode): business tracks start with To-do, discovery tracks with Idea (section 1.2 rule 1).
 * - `track.type_set_id`: the set a track uses.
 *
 * Every workspace gets the default levels, the types Outcome, Feature, Bug, Chore, To-do, Idea
 * and Subticket, and a software, a business and a discovery type set. Existing shared tracks
 * use the default set of their type; each existing local track gets its own copy of it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE hierarchy_level (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      kind text NOT NULL CHECK (kind IN ('subticket', 'standard', 'outcome', 'custom')),
      rank integer NOT NULL,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT hierarchy_level_rank_check CHECK (
        (kind = 'subticket' AND rank = -1) OR (kind = 'standard' AND rank = 0)
        OR (kind = 'outcome' AND rank = 1) OR (kind = 'custom' AND rank >= 2)),
      CONSTRAINT hierarchy_level_rank_key UNIQUE (workspace_id, rank) DEFERRABLE INITIALLY DEFERRED
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX hierarchy_level_builtin_idx ON hierarchy_level (workspace_id, kind) WHERE kind <> 'custom'`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX hierarchy_level_name_idx ON hierarchy_level (workspace_id, lower(name))`.execute(
    db,
  );

  await sql`
    CREATE TABLE ticket_type (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      icon text,
      color text,
      level_id integer NOT NULL REFERENCES hierarchy_level (id),
      owner_track_id integer REFERENCES track (id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  // Shared types have unique names; a local-mode track's own types are unique within it.
  await sql`CREATE UNIQUE INDEX ticket_type_name_idx ON ticket_type (workspace_id, coalesce(owner_track_id, 0), lower(name))`.execute(
    db,
  );
  await sql`CREATE INDEX ticket_type_level_idx ON ticket_type (level_id)`.execute(db);
  await sql`CREATE INDEX ticket_type_owner_track_idx ON ticket_type (owner_track_id) WHERE owner_track_id IS NOT NULL`.execute(
    db,
  );

  await sql`
    CREATE TABLE type_set (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      default_type_id integer,
      owner_track_id integer REFERENCES track (id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX type_set_name_idx ON type_set (workspace_id, lower(name))`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX type_set_owner_track_idx ON type_set (owner_track_id) WHERE owner_track_id IS NOT NULL`.execute(
    db,
  );

  // A type in use by a set cannot be deleted (no cascade): the API answers 409 first.
  await sql`
    CREATE TABLE type_set_member (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      type_set_id integer NOT NULL REFERENCES type_set (id) ON DELETE CASCADE,
      ticket_type_id integer NOT NULL REFERENCES ticket_type (id),
      sort_order integer NOT NULL,
      PRIMARY KEY (type_set_id, ticket_type_id),
      CONSTRAINT type_set_member_order_key UNIQUE (type_set_id, sort_order)
        DEFERRABLE INITIALLY DEFERRED
    )`.execute(db);
  await sql`CREATE INDEX type_set_member_type_idx ON type_set_member (ticket_type_id)`.execute(db);
  await sql`
    ALTER TABLE type_set ADD CONSTRAINT type_set_default_member_fkey
      FOREIGN KEY (id, default_type_id) REFERENCES type_set_member (type_set_id, ticket_type_id)
      DEFERRABLE INITIALLY DEFERRED`.execute(db);

  await sql`
    CREATE TABLE type_set_default (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      track_type text NOT NULL
        CHECK (track_type IN ('software', 'business', 'service', 'discovery')),
      type_set_id integer NOT NULL REFERENCES type_set (id),
      PRIMARY KEY (workspace_id, track_type)
    )`.execute(db);
  await sql`CREATE INDEX type_set_default_set_idx ON type_set_default (type_set_id)`.execute(db);

  await sql`ALTER TABLE track ADD COLUMN type_set_id integer REFERENCES type_set (id)`.execute(db);
  await sql`CREATE INDEX track_type_set_idx ON track (type_set_id)`.execute(db);

  const { rows } = await sql<{ id: number }>`SELECT id FROM workspace ORDER BY id`.execute(db);
  for (const { id } of rows) await seedWorkspace(db, id);
}

const LEVELS = [
  ['subticket', -1, 'Subticket', 'Parts of a standard ticket; each one sits under a parent'],
  ['standard', 0, 'Standard', 'Everyday work'],
  ['outcome', 1, 'Outcome', 'Results that several standard tickets deliver together'],
] as const;

const TYPES = [
  ['Outcome', 'outcome', 'A result that several tickets deliver together', 'outcome', '#8e7cc3'],
  [
    'Feature',
    'standard',
    'Something new or better for the people who use the product',
    'feature',
    '#5aa469',
  ],
  ['Bug', 'standard', 'Something that does not work as it should', 'bug', '#d9534f'],
  [
    'Chore',
    'standard',
    'Work that has to be done but changes nothing people see',
    'chore',
    '#5b8def',
  ],
  ['To-do', 'standard', 'A piece of work to get done', 'to-do', '#5b8def'],
  [
    'Idea',
    'standard',
    'A possible improvement to explore before committing to it',
    'idea',
    '#e0a526',
  ],
  ['Subticket', 'subticket', 'A smaller part of another ticket', 'subticket', '#6fa8c9'],
] as const;

const SETS = [
  {
    name: 'Software type set',
    description: 'Outcomes, features, bugs, chores and subtickets',
    types: ['Outcome', 'Feature', 'Bug', 'Chore', 'Subticket'],
    preselected: 'Feature',
    defaultFor: ['software'],
  },
  {
    name: 'Business type set',
    description: 'Outcomes, to-dos and subtickets',
    types: ['Outcome', 'To-do', 'Subticket'],
    preselected: 'To-do',
    defaultFor: ['business', 'service'],
  },
  {
    name: 'Discovery type set',
    description: 'Ideas',
    types: ['Idea'],
    preselected: 'Idea',
    defaultFor: ['discovery'],
  },
] as const;

async function seedWorkspace(db: Kysely<unknown>, ws: number): Promise<void> {
  for (const [kind, rank, name, description] of LEVELS) {
    await sql`
      INSERT INTO hierarchy_level (workspace_id, kind, rank, name, description)
      VALUES (${ws}, ${kind}, ${rank}, ${name}, ${description})`.execute(db);
  }
  for (const [name, level, description, icon, color] of TYPES) {
    await sql`
      INSERT INTO ticket_type (workspace_id, name, description, icon, color, level_id)
      SELECT ${ws}, ${name}, ${description}, ${icon}, ${color}, id
        FROM hierarchy_level WHERE workspace_id = ${ws} AND kind = ${level}`.execute(db);
  }
  for (const set of SETS) {
    const created = await sql<{ id: number }>`
      INSERT INTO type_set (workspace_id, name, description)
      VALUES (${ws}, ${set.name}, ${set.description}) RETURNING id`.execute(db);
    const setId = created.rows[0]?.id;
    for (const [i, typeName] of set.types.entries()) {
      await sql`
        INSERT INTO type_set_member (workspace_id, type_set_id, ticket_type_id, sort_order)
        SELECT ${ws}, ${setId}, id, ${i + 1} FROM ticket_type
         WHERE workspace_id = ${ws} AND owner_track_id IS NULL AND name = ${typeName}`.execute(db);
    }
    await sql`
      UPDATE type_set SET default_type_id = (
        SELECT id FROM ticket_type
         WHERE workspace_id = ${ws} AND owner_track_id IS NULL AND name = ${set.preselected})
       WHERE id = ${setId}`.execute(db);
    for (const trackType of set.defaultFor) {
      await sql`
        INSERT INTO type_set_default (workspace_id, track_type, type_set_id)
        VALUES (${ws}, ${trackType}, ${setId})`.execute(db);
    }
  }

  // Shared tracks use the default set of their type.
  await sql`
    UPDATE track t SET type_set_id = d.type_set_id
      FROM type_set_default d
     WHERE t.workspace_id = ${ws} AND t.mode = 'shared'
       AND d.workspace_id = t.workspace_id AND d.track_type = t.type`.execute(db);
  // Local tracks own a copy of it, as they own a copy of the default access policy.
  const local = await sql<{ id: number; key: string; source: number }>`
    SELECT t.id, t.key, d.type_set_id AS source FROM track t
      JOIN type_set_default d ON d.workspace_id = t.workspace_id AND d.track_type = t.type
     WHERE t.workspace_id = ${ws} AND t.mode = 'local' ORDER BY t.id`.execute(db);
  for (const track of local.rows) {
    let copyId: number | undefined;
    // Set names are unique per workspace; the track id settles a clash.
    for (const name of [`${track.key} local type set`, `${track.key} local type set ${track.id}`]) {
      const copy = await sql<{ id: number }>`
        INSERT INTO type_set (workspace_id, name, description, owner_track_id)
        VALUES (${ws}, ${name}, ${`Owned by track ${track.key}; copied from a default type set`},
                ${track.id})
        ON CONFLICT DO NOTHING RETURNING id`.execute(db);
      copyId = copy.rows[0]?.id;
      if (copyId !== undefined) break;
    }
    if (copyId === undefined) throw new Error(`no free name for the type set of ${track.key}`);
    await sql`
      INSERT INTO type_set_member (workspace_id, type_set_id, ticket_type_id, sort_order)
      SELECT workspace_id, ${copyId}, ticket_type_id, sort_order
        FROM type_set_member WHERE type_set_id = ${track.source}`.execute(db);
    await sql`
      UPDATE type_set SET default_type_id = (SELECT default_type_id FROM type_set WHERE id = ${track.source})
       WHERE id = ${copyId}`.execute(db);
    await sql`UPDATE track SET type_set_id = ${copyId} WHERE id = ${track.id}`.execute(db);
  }
}
