import { type Kysely, sql } from 'kysely';

/**
 * Ticket links, link types, web links, followers and votes (M1-015; CORE-018, CORE-019; spec
 * 01a sections 1.3 and 1.6).
 *
 * - `link_type`: the workspace's link types with a name and the phrase each side reads
 *   (outward "blocks", inward "is blocked by"); shipped with Relates, Duplicates, Blocks and
 *   Copies. `is_copy` marks the one cloning uses (CORE-023 (1)), which can be renamed but not
 *   deleted.
 * - `ticket_link`: a directed link of a type between two tickets, in any tracks. One per type,
 *   source and target; a ticket never links to itself. Links leave with either ticket when the
 *   trash purge removes it.
 * - `link_policy`: the workspace's switch for ticket links (CORE-018: site-wide on/off).
 * - `ticket_web_link`: a link to something outside, with a title, an icon and an optional
 *   global id that integrations use to find and update it (`ticketsWithWebLinksByGlobalId()`).
 * - `ticket_follower` and `ticket_vote`: one row per person and ticket, no cap (CORE-019 (3)).
 * - `user_preference.auto_follow`: whether people follow the tickets they create, edit or
 *   comment on (CORE-019), on by default.
 */
const LINK_TYPES = [
  ['Relates', 'relates to', 'relates to', false],
  ['Duplicates', 'duplicates', 'is duplicated by', false],
  ['Blocks', 'blocks', 'is blocked by', false],
  ['Copies', 'copies', 'is copied by', true],
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE link_type (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL,
      outward text NOT NULL,
      inward text NOT NULL,
      is_copy boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX link_type_name_idx ON link_type (workspace_id, lower(name))`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX link_type_copy_idx ON link_type (workspace_id) WHERE is_copy`.execute(
    db,
  );

  await sql`
    CREATE TABLE ticket_link (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      link_type_id integer NOT NULL REFERENCES link_type (id),
      source_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
      target_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
      created_by integer REFERENCES app_user (id),
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (source_id <> target_id)
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX ticket_link_unique_idx ON ticket_link (source_id, link_type_id, target_id)`.execute(
    db,
  );
  await sql`CREATE INDEX ticket_link_target_idx ON ticket_link (target_id)`.execute(db);
  await sql`CREATE INDEX ticket_link_type_idx ON ticket_link (link_type_id)`.execute(db);

  await sql`
    CREATE TABLE link_policy (
      workspace_id integer PRIMARY KEY REFERENCES workspace (id),
      enabled boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);

  await sql`
    CREATE TABLE ticket_web_link (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      ticket_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
      url text NOT NULL,
      title text NOT NULL,
      summary text NOT NULL DEFAULT '',
      icon_url text,
      relationship text NOT NULL DEFAULT '',
      global_id text,
      created_by integer REFERENCES app_user (id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX ticket_web_link_ticket_idx ON ticket_web_link (ticket_id)`.execute(db);
  await sql`CREATE UNIQUE INDEX ticket_web_link_global_idx ON ticket_web_link (ticket_id, global_id) WHERE global_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX ticket_web_link_global_lookup_idx ON ticket_web_link (workspace_id, global_id) WHERE global_id IS NOT NULL`.execute(
    db,
  );

  for (const table of ['ticket_follower', 'ticket_vote']) {
    await sql`
      CREATE TABLE ${sql.table(table)} (
        workspace_id integer NOT NULL REFERENCES workspace (id),
        ticket_id integer NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
        user_id integer NOT NULL REFERENCES app_user (id),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (ticket_id, user_id)
      )`.execute(db);
    await sql`CREATE INDEX ${sql.raw(`${table}_user_idx`)} ON ${sql.table(table)} (user_id)`.execute(
      db,
    );
  }

  await sql`
    CREATE TABLE user_preference (
      user_id integer PRIMARY KEY REFERENCES app_user (id),
      workspace_id integer NOT NULL REFERENCES workspace (id),
      auto_follow boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);

  const { rows } = await sql<{ id: number }>`SELECT id FROM workspace ORDER BY id`.execute(db);
  for (const { id: ws } of rows) {
    for (const [name, outward, inward, isCopy] of LINK_TYPES) {
      await sql`
        INSERT INTO link_type (workspace_id, name, outward, inward, is_copy)
        VALUES (${ws}, ${name}, ${outward}, ${inward}, ${isCopy})`.execute(db);
    }
    await sql`INSERT INTO link_policy (workspace_id) VALUES (${ws})`.execute(db);
  }
}
