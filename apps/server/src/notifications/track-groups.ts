import type { Database, NotificationChannel } from '@taskmoor/db';
import type { Kysely } from 'kysely';
import type { DomainEvent, EventType } from '../events/catalogue';
import { CHANNELS } from './model';

/**
 * Telling a person a track group was shared with them or set on them (T-206; IAM-034,
 * ADR-121). It is a product event, `track_group_shared`, outside notification policies: it
 * reaches the person it is about, in the inbox and by email as their preferences say (per
 * channel for this event, and their email delivery). The item names the group and who shared
 * it, and the role if one came with it; never a track, so it names nothing the person may not
 * see. It shows, and its email goes, only while the person still has the group: a share taken
 * back, a group left or deleted, takes it away.
 */
export const TRACK_GROUP_EVENT = 'track_group_shared';

/** The domain events that tell someone about a group: shared with them, or set on them. */
export const TRACK_GROUP_NOTICES = [
  'track_group.shared',
  'track_group.copied',
] as const satisfies readonly EventType[];

/** What the notification carries: the group by id and name, how it came, and the role. */
export interface TrackGroupNotice {
  type: string;
  groupId: number;
  name: string;
  how: 'shared' | 'set';
  role: string | null;
}

/** The group a notification is about, from its payload; null for any other notification. */
export function noticeGroupId(payload: Record<string, unknown>): number | null {
  const id = payload.groupId;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Writes the notifications one share or copy produces; returns how many it wrote. */
export async function notifyTrackGroup(
  db: Kysely<Database>,
  event: DomainEvent,
  bump: (trx: Kysely<Database>, workspaceId: number, userIds: Iterable<number>) => Promise<void>,
): Promise<number> {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const userId = typeof payload.userId === 'number' ? payload.userId : null;
  const groupId = Number(event.subjectId);
  if (userId === null || !Number.isSafeInteger(groupId) || userId === event.actorId) return 0;
  const ws = event.workspaceId;
  const person = await db
    .selectFrom('app_user as u')
    .leftJoin('user_preference as p', 'p.user_id', 'u.id')
    .select(['u.id', 'p.email_delivery'])
    .where('u.id', '=', userId)
    .where('u.workspace_id', '=', ws)
    .where('u.deactivated_at', 'is', null)
    .where('u.kind', '=', 'person')
    .executeTakeFirst();
  if (!person) return 0;
  const how = event.type === 'track_group.copied' ? 'set' : 'shared';
  // Still theirs when the event is handled: a share taken back meanwhile tells nobody.
  const group = await db
    .selectFrom('track_group as g')
    .select(['g.id', 'g.name'])
    .where('g.id', '=', groupId)
    .where('g.workspace_id', '=', ws)
    .where((eb) =>
      how === 'set'
        ? eb('g.owner_id', '=', userId)
        : eb.exists(
            eb
              .selectFrom('track_group_share as s')
              .select('s.id')
              .whereRef('s.group_id', '=', 'g.id')
              .where('s.user_id', '=', userId),
          ),
    )
    .executeTakeFirst();
  if (!group) return 0;
  const roleId = typeof payload.roleId === 'number' ? payload.roleId : null;
  const role =
    roleId === null
      ? undefined
      : await db
          .selectFrom('role')
          .select('name')
          .where('id', '=', roleId)
          .where('workspace_id', '=', ws)
          .executeTakeFirst();
  const muted = new Set(
    (
      await db
        .selectFrom('notification_preference')
        .select('channel')
        .where('user_id', '=', userId)
        .where('event', '=', TRACK_GROUP_EVENT)
        .where('enabled', '=', false)
        .execute()
    ).map((p) => p.channel),
  );
  const channels = CHANNELS.filter(
    (channel: NotificationChannel) =>
      !muted.has(channel) && !(channel === 'email' && person.email_delivery === 'off'),
  );
  if (channels.length === 0) return 0;
  const notice: TrackGroupNotice = {
    type: event.type,
    groupId: group.id,
    name: group.name,
    how,
    role: role?.name ?? null,
  };
  return db.transaction().execute(async (trx) => {
    const written = await trx
      .insertInto('notification')
      .values(
        channels.map((channel) => ({
          workspace_id: ws,
          user_id: userId,
          channel,
          event: TRACK_GROUP_EVENT,
          ticket_id: null,
          domain_event_id: event.id,
          actor_id: event.actorId,
          payload: JSON.stringify(notice),
          created_at: event.occurredAt,
        })),
      )
      .onConflict((oc) => oc.columns(['domain_event_id', 'user_id', 'channel']).doNothing())
      .returning(['user_id', 'channel'])
      .execute();
    await bump(
      trx,
      ws,
      written.filter((w) => w.channel === 'inbox').map((w) => w.user_id),
    );
    return written.length;
  });
}
