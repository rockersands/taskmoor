import type { Database, JsonValue, SecurityEmailKind } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';
import type { Subscriber } from '../events/bus';
import type { DomainEvent, EventType } from '../events/catalogue';
import { bumpInbox } from '../notifications/subscriber';

/**
 * Security notices and alerts (ADR-109), the subscriber that writes what `mailer.ts` sends.
 *
 * - **Notices** (ASVS 2.2.3, 2.5.5): a person hears by email when their password changes (by
 *   themselves or through a reset link; activating an account is not a change), a second factor
 *   is added or removed, their recovery codes are made again, an administrator resets their
 *   second factors, or their email address changes (told to the old address, whoever changed
 *   it: the person, an administrator, SCIM or a directory). Notices are not notifications:
 *   no preference turns them off, no digest or quiet hours hold them.
 * - **Alerts** (ASVS 11.1.7, 11.1.8): a security alert rule's threshold passed
 *   (`security.alert_raised`) or an AI spend limit's alert (`ai_limit.threshold_reached`,
 *   ADR-100). Every active site administrator gets an inbox item (a direct ask, so it shows in
 *   Priority) and an email.
 *
 * Each notice or alert is written once per event, person and kind (delivery is at least once).
 * Nothing secret is written: what changed, when, the address and User-Agent the change came
 * from, and who made it (the person, an administrator or the system), never a password, code,
 * token or link.
 */
const NOTICE_TYPES = [
  'user.password_changed',
  'user.two_factor_enabled',
  'user.two_factor_disabled',
  'user.recovery_codes_regenerated',
  'user.two_factor_reset',
  'user.updated',
  'scim.user_updated',
  'directory.user_updated',
] as const satisfies readonly EventType[];

const ALERT_TYPES = [
  'security.alert_raised',
  'ai_limit.threshold_reached',
] as const satisfies readonly EventType[];

export const SECURITY_SUBSCRIBER_TYPES: readonly EventType[] = [...NOTICE_TYPES, ...ALERT_TYPES];

/** The inbox events of alerts: about no ticket, for site administrators only. */
export const ALERT_INBOX_EVENTS = ['security_alert', 'ai_spend_alert'] as const;

type Db = Kysely<Database>;

/** The kind of notice an event is, and the address it goes to; null for none. */
function noticeOf(
  event: DomainEvent,
  current: { email: string },
): {
  kind: Exclude<SecurityEmailKind, 'alert'>;
  to: string;
  extra: Record<string, JsonValue>;
} | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case 'user.password_changed':
      // Setting the first password through an activation link changes nothing anyone had.
      if (payload.purpose === 'activate') return null;
      return {
        kind: 'password_changed',
        to: current.email,
        extra: { via: payload.via === 'link' ? 'link' : 'self' },
      };
    case 'user.two_factor_enabled':
    case 'user.two_factor_disabled':
      return {
        kind:
          event.type === 'user.two_factor_enabled' ? 'two_factor_enabled' : 'two_factor_disabled',
        to: current.email,
        extra: { method: payload.method === 'webauthn' ? 'webauthn' : 'totp' },
      };
    case 'user.recovery_codes_regenerated':
      return { kind: 'recovery_codes_regenerated', to: current.email, extra: {} };
    case 'user.two_factor_reset':
      return { kind: 'two_factor_reset', to: current.email, extra: {} };
    case 'user.updated':
    case 'scim.user_updated':
    case 'directory.user_updated': {
      const change = (payload.changes as Record<string, { from?: unknown; to?: unknown }>)?.email;
      if (!change || typeof change.from !== 'string' || change.from === '') return null;
      if (String(change.from).toLowerCase() === String(change.to ?? '').toLowerCase()) return null;
      return {
        kind: 'email_changed',
        to: change.from,
        extra: { newAddress: maskAddress(String(change.to ?? '')) },
      };
    }
    default:
      return null;
  }
}

/**
 * An address shown to its old owner: enough to recognise it, not enough to hand a stranger a
 * working address if the old mailbox is someone else's now. `ada.lovelace@example.com` reads
 * `a***@example.com`.
 */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1) return '***';
  return `${address.slice(0, 1)}***${address.slice(at)}`;
}

/** Who made a change, as a notice tells it. */
function madeBy(event: DomainEvent, userId: number): 'self' | 'administrator' | 'system' {
  if (event.actorId === null) return 'system';
  return event.actorId === userId ? 'self' : 'administrator';
}

async function writeNotice(db: Db, event: DomainEvent): Promise<void> {
  const userId = Number(event.subjectId);
  if (!Number.isInteger(userId)) return;
  const user = await db
    .selectFrom('app_user')
    .select(['id', 'email', 'deactivated_at', 'kind'])
    .where('id', '=', userId)
    .where('workspace_id', '=', event.workspaceId)
    .executeTakeFirst();
  // Service accounts have no mailbox; a deactivated account has no one to warn.
  if (user?.kind !== 'person' || user.deactivated_at) return;
  const notice = noticeOf(event, user);
  if (!notice) return;
  await db
    .insertInto('security_email')
    .values({
      workspace_id: event.workspaceId,
      user_id: user.id,
      kind: notice.kind,
      domain_event_id: event.id,
      to_address: notice.to,
      details: JSON.stringify({
        ...notice.extra,
        at: event.occurredAt.toISOString(),
        ip: event.ip,
        userAgent: event.userAgent ?? null,
        by: madeBy(event, user.id),
      }),
    })
    .onConflict((oc) => oc.columns(['domain_event_id', 'user_id', 'kind']).doNothing())
    .execute();
}

/**
 * The active site administrators of a workspace: by the account flag, or the site_admin global
 * grant to them, to everyone, or to a group they are in (nested groups included). At most 200.
 */
export async function siteAdministrators(
  db: Db,
  workspaceId: number,
): Promise<{ id: number; email: string }[]> {
  const { rows } = await sql<{ id: number; email: string }>`
    WITH RECURSIVE admin_groups(id) AS (
      SELECT group_id FROM global_grant
       WHERE workspace_id = ${workspaceId} AND permission = 'site_admin' AND grantee = 'group'
      UNION
      SELECT n.child_id FROM group_nesting n JOIN admin_groups a ON n.parent_id = a.id
       WHERE n.workspace_id = ${workspaceId}
    )
    SELECT u.id, u.email FROM app_user u
     WHERE u.workspace_id = ${workspaceId} AND u.deactivated_at IS NULL AND u.kind = 'person'
       AND (u.is_site_admin
            OR EXISTS (SELECT 1 FROM global_grant g
                        WHERE g.workspace_id = ${workspaceId} AND g.permission = 'site_admin'
                          AND (g.grantee = 'any_user' OR (g.grantee = 'user' AND g.user_id = u.id)))
            OR EXISTS (SELECT 1 FROM group_member m
                        WHERE m.user_id = u.id AND m.group_id IN (SELECT id FROM admin_groups)))
     ORDER BY u.id
     LIMIT 200`.execute(db);
  return rows;
}

/** What an alert's inbox item and email say: the rule and whom it is about, by name. */
async function alertPayload(db: Db, event: DomainEvent): Promise<Record<string, JsonValue>> {
  const payload = { ...((event.payload ?? {}) as Record<string, JsonValue>) };
  const userId = typeof payload.userId === 'number' ? payload.userId : null;
  if (userId !== null) {
    const person = await db
      .selectFrom('app_user')
      .select(['name', 'email'])
      .where('id', '=', userId)
      .where('workspace_id', '=', event.workspaceId)
      .executeTakeFirst();
    if (person) {
      payload.userName = person.name;
      payload.userEmail = person.email;
    }
  }
  if (event.type === 'ai_limit.threshold_reached') payload.rule = 'ai_spend';
  return payload;
}

async function fanOutAlert(db: Db, event: DomainEvent): Promise<void> {
  const admins = await siteAdministrators(db, event.workspaceId);
  if (admins.length === 0) return;
  const payload = await alertPayload(db, event);
  const inboxEvent =
    event.type === 'ai_limit.threshold_reached' ? 'ai_spend_alert' : 'security_alert';
  await db.transaction().execute(async (trx) => {
    const written = await trx
      .insertInto('notification')
      .values(
        admins.map((a) => ({
          workspace_id: event.workspaceId,
          user_id: a.id,
          channel: 'inbox' as const,
          event: inboxEvent,
          ticket_id: null,
          domain_event_id: event.id,
          actor_id: null,
          payload: JSON.stringify(payload),
          // For the Priority tab: an administrator is asked to look.
          direct: true,
        })),
      )
      .onConflict((oc) => oc.columns(['domain_event_id', 'user_id', 'channel']).doNothing())
      .returning('user_id')
      .execute();
    await trx
      .insertInto('security_email')
      .values(
        admins.map((a) => ({
          workspace_id: event.workspaceId,
          user_id: a.id,
          kind: 'alert' as const,
          domain_event_id: event.id,
          to_address: a.email,
          details: JSON.stringify({ ...payload, at: event.occurredAt.toISOString() }),
        })),
      )
      .onConflict((oc) => oc.columns(['domain_event_id', 'user_id', 'kind']).doNothing())
      .execute();
    await bumpInbox(
      trx,
      event.workspaceId,
      written.map((w) => w.user_id),
    );
  });
}

export function securitySubscriber(db: Db): Subscriber {
  return {
    name: 'security',
    types: SECURITY_SUBSCRIBER_TYPES,
    handle: async (event) => {
      if ((ALERT_TYPES as readonly string[]).includes(event.type)) await fanOutAlert(db, event);
      else await writeNotice(db, event);
    },
  };
}
