import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';
import type { Subscriber } from '../events/bus';
import type { EventType } from '../events/catalogue';
import { appendAudit } from './chain';

/**
 * The domain events the audit log records (IAM-013: sign-ins, security, permission,
 * configuration, token, export and admin events). Every catalogue type is either here or in
 * NOT_AUDITED with a reason; a test fails when a new type is in neither, so each new event
 * gets a decision. Ticket activity will mostly go to NOT_AUDITED: the ticket history holds it.
 */
export const AUDITED_EVENTS = [
  'setup.completed',
  'session.started',
  'session.ended',
  'session.revoked',
  'user.created',
  'user.updated',
  'user.deactivated',
  'user.reactivated',
  'user.password_changed',
  'user.password_link_created',
  'user.two_factor_enabled',
  'user.two_factor_disabled',
  'user.recovery_codes_regenerated',
  'user.two_factor_reset',
  'two_factor_policy.updated',
  'sso.signed_in',
  'identity_provider.created',
  'identity_provider.updated',
  'identity_provider.deleted',
  'group.created',
  'group.updated',
  'group.deleted',
  'group.member_added',
  'group.member_removed',
  'group.nested',
  'group.unnested',
  'role.created',
  'role.updated',
  'role.deleted',
  'access_policy.created',
  'access_policy.updated',
  'access_policy.deleted',
  'access_grant.added',
  'access_grant.removed',
  'global_grant.added',
  'global_grant.removed',
  'track_role.actor_added',
  'track_role.actor_removed',
  'track.created',
  'track.updated',
  'track.archived',
  'track.restored',
  'track_category.created',
  'track_category.updated',
  'track_category.deleted',
  'hierarchy_level.created',
  'hierarchy_level.updated',
  'hierarchy_level.deleted',
  'ticket_type.created',
  'ticket_type.updated',
  'ticket_type.deleted',
  'type_set.created',
  'type_set.updated',
  'type_set.deleted',
  'audit.settings_updated',
  'token.created',
  'token.revoked',
  'token.rotated',
  'token.bulk_revoked',
  'token_policy.updated',
  'service_account.created',
  'service_account.updated',
  'service_account.deactivated',
  'service_account.reactivated',
] as const satisfies readonly EventType[];

export const NOT_AUDITED: Partial<Record<EventType, string>> = {};

/**
 * The first subscriber of the domain event bus (ADR-015): each audited event becomes one audit
 * record with the event's time, actor, subject, payload and client address. Delivery is at
 * least once; the chain holds each event once (`sourceEventId`).
 */
export function auditSubscriber(db: Kysely<Database>): Subscriber {
  return {
    name: 'audit',
    types: AUDITED_EVENTS,
    handle: async (event) => {
      await appendAudit(db, [
        {
          workspaceId: event.workspaceId,
          action: event.type,
          actorId: event.actorId,
          subjectType: event.subjectType,
          subjectId: event.subjectId,
          details: (event.payload ?? {}) as Record<string, unknown>,
          ip: event.ip,
          occurredAt: event.occurredAt,
          sourceEventId: event.id,
        },
      ]);
    },
  };
}
