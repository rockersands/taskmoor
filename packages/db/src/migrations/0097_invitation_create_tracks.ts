import { type Kysely, sql } from 'kysely';

/**
 * Who may create tracks (IAM-033; ADR-118): giving someone the role that runs a track can also
 * give them the site-wide permission to create tracks. An invitation keeps that choice until the
 * person takes it up, so it is a column here; existing invitations never had it. The permission
 * itself is an ordinary `global_grant` row for the person, and nothing here changes who holds it:
 * a site keeps its grants, and only a new site's setup leaves the permission to its
 * administrators.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE track_invitation
      ADD COLUMN grants_create_tracks boolean NOT NULL DEFAULT false`.execute(db);
}
