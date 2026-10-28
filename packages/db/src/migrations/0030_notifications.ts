import { type Kysely, sql } from 'kysely';

/**
 * Notification policies, preferences and the notifications they produce (M1-056; NTF-001,
 * NTF-004; spec 01c section 3).
 *
 * - `notification_policy` and `notification_rule`: which recipients each notification event
 *   reaches. One default policy per workspace serves tracks that name none
 *   (`track.notification_policy_id`); a local-mode track's own policy names it in `track_id`.
 * - `notification_preference`: a person's choice per event and channel (email, inbox); no row
 *   means on. `user_preference.notify_own_changes` decides whether people hear of their own
 *   changes (off by default).
 * - `notification`: one row per recipient, channel and domain event, written by the
 *   notification subscriber after it has checked that the recipient may see the ticket. Email
 *   (M1-057) and the inbox (M1-058) deliver and read them.
 */
const EVENTS = [
  'ticket_created',
  'ticket_updated',
  'ticket_assigned',
  'ticket_close_reason_set',
  'ticket_closed',
  'ticket_commented',
  'ticket_reopened',
  'ticket_deleted',
  'ticket_moved',
  'time_entry_added',
  'time_entry_updated',
  'time_entry_deleted',
  'work_started',
  'work_stopped',
  'generic',
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE notification_policy (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      track_id integer REFERENCES track (id) ON DELETE CASCADE,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      is_default boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (NOT is_default OR track_id IS NULL)
    )`.execute(db);
  await sql`
    CREATE UNIQUE INDEX notification_policy_name_idx
      ON notification_policy (workspace_id, coalesce(track_id, 0), lower(name))`.execute(db);
  await sql`
    CREATE UNIQUE INDEX notification_policy_default_idx ON notification_policy (workspace_id)
      WHERE is_default`.execute(db);

  await sql`
    CREATE TABLE notification_rule (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      policy_id integer NOT NULL REFERENCES notification_policy (id) ON DELETE CASCADE,
      event text NOT NULL,
      recipient text NOT NULL CHECK (recipient IN ('assignee', 'requester', 'area_owner',
        'user', 'group', 'role', 'follower', 'track_owner', 'current_user', 'user_field',
        'group_field')),
      user_id integer REFERENCES app_user (id) ON DELETE CASCADE,
      group_id integer REFERENCES user_group (id) ON DELETE CASCADE,
      role_id integer REFERENCES role (id) ON DELETE CASCADE,
      field_key text,
      CHECK ((recipient = 'user') = (user_id IS NOT NULL)),
      CHECK ((recipient = 'group') = (group_id IS NOT NULL)),
      CHECK ((recipient = 'role') = (role_id IS NOT NULL)),
      CHECK ((recipient IN ('user_field', 'group_field')) = (field_key IS NOT NULL))
    )`.execute(db);
  await sql`
    CREATE UNIQUE INDEX notification_rule_unique_idx ON notification_rule (policy_id, event,
      recipient, coalesce(user_id, 0), coalesce(group_id, 0), coalesce(role_id, 0),
      coalesce(field_key, ''))`.execute(db);

  await sql`
    ALTER TABLE track
      ADD COLUMN notification_policy_id integer REFERENCES notification_policy (id)`.execute(db);
  await sql`CREATE INDEX track_notification_policy_idx ON track (notification_policy_id)`.execute(
    db,
  );

  await sql`
    CREATE TABLE notification_preference (
      user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      event text NOT NULL,
      channel text NOT NULL CHECK (channel IN ('email', 'inbox')),
      enabled boolean NOT NULL,
      PRIMARY KEY (user_id, event, channel)
    )`.execute(db);
  await sql`
    ALTER TABLE user_preference
      ADD COLUMN notify_own_changes boolean NOT NULL DEFAULT false`.execute(db);

  await sql`
    CREATE TABLE notification (
      id bigserial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      channel text NOT NULL CHECK (channel IN ('email', 'inbox')),
      event text NOT NULL,
      ticket_id integer REFERENCES ticket (id) ON DELETE CASCADE,
      domain_event_id bigint NOT NULL,
      actor_id integer REFERENCES app_user (id) ON DELETE SET NULL,
      payload jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      read_at timestamptz,
      delivered_at timestamptz
    )`.execute(db);
  await sql`
    CREATE UNIQUE INDEX notification_event_recipient_idx
      ON notification (domain_event_id, user_id, channel)`.execute(db);
  await sql`
    CREATE INDEX notification_user_idx ON notification (user_id, channel, created_at DESC)`.execute(
    db,
  );
  await sql`
    CREATE INDEX notification_undelivered_idx ON notification (created_at)
      WHERE channel = 'email' AND delivered_at IS NULL`.execute(db);
  await sql`CREATE INDEX notification_ticket_idx ON notification (ticket_id)`.execute(db);

  // Each workspace's default policy: the people working on a ticket and those following it
  // hear of everything that happens to it.
  await sql`
    INSERT INTO notification_policy (workspace_id, name, description, is_default)
    SELECT id, 'Default notifications',
           'The assignee, the requester and followers hear of every change.', true
      FROM workspace`.execute(db);
  await sql`
    INSERT INTO notification_rule (workspace_id, policy_id, event, recipient)
    SELECT p.workspace_id, p.id, e.event, r.recipient
      FROM notification_policy p,
           unnest(${EVENTS}::text[]) AS e(event),
           unnest(ARRAY['assignee', 'requester', 'follower']) AS r(recipient)
     WHERE p.is_default`.execute(db);
}
