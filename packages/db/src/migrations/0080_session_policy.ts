import { type Kysely, sql } from 'kysely';

/**
 * How long a sign-in lasts, per workspace (the user's decision of 2026-11-01; ASVS 3.3.2;
 * ADR-104 Changes): the absolute lifetime and the idle timeout, both in minutes. No row means
 * the defaults (14 days, 3 days idle); a site administrator changes them on the Security page.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE session_policy (
    workspace_id integer PRIMARY KEY REFERENCES workspace (id) ON DELETE CASCADE,
    lifetime_minutes integer NOT NULL CHECK (lifetime_minutes BETWEEN 60 AND 129600),
    idle_minutes integer NOT NULL CHECK (idle_minutes BETWEEN 5 AND 129600),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (idle_minutes <= lifetime_minutes)
  )`.execute(db);
}
