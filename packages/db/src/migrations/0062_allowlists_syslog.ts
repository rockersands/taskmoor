import { type Kysely, sql } from 'kysely';

/**
 * IP allowlists and audit forwarding to syslog (M1-085; IAM-015, IAM-013; ADR-078).
 *
 * - `ip_allowlist`: per workspace, whether the list is on and the groups whose members may
 *   connect from anywhere. Off until a site administrator turns it on.
 * - `ip_allowlist_entry`: the addresses and ranges (IPv4 or IPv6, a single address or a CIDR
 *   range), with a note. No cap on entries.
 * - `organization_domain`: the email domains of the organization (IAM-004). Once a workspace
 *   names one, a person whose email is at any other domain is external and must sign in with a
 *   second factor (the user's decision of 2026-10-30).
 * - `audit_syslog`: where audit records are forwarded (host, port, transport) and how far the
 *   forwarding has got (`last_seq`), so a receiver that was down gets what it missed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE ip_allowlist (
      workspace_id integer PRIMARY KEY REFERENCES workspace (id),
      enabled boolean NOT NULL DEFAULT false,
      exempt_group_ids integer[] NOT NULL DEFAULT '{}',
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`
    CREATE TABLE ip_allowlist_entry (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      range inet NOT NULL,
      note text NOT NULL DEFAULT '' CHECK (length(note) <= 200),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, range)
    )`.execute(db);
  await sql`
    CREATE TABLE organization_domain (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      domain text NOT NULL CHECK (domain = lower(domain) AND length(domain) BETWEEN 3 AND 253),
      PRIMARY KEY (workspace_id, domain)
    )`.execute(db);
  await sql`
    CREATE TABLE audit_syslog (
      workspace_id integer PRIMARY KEY REFERENCES workspace (id),
      enabled boolean NOT NULL DEFAULT false,
      host text NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
      port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
      transport text NOT NULL CHECK (transport IN ('udp', 'tcp', 'tls')),
      last_seq bigint NOT NULL DEFAULT 0,
      last_sent_at timestamptz,
      last_error text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
}
