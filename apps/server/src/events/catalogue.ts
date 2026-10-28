import { z } from 'zod';

/**
 * The domain event catalogue (M1-005). Every mutation emits exactly one of these, in its own
 * transaction; subscribers (audit, notifications, webhooks, search, automation) read them. A
 * type's payload never carries secrets: no password, hash, token or link.
 *
 * Changing a payload incompatibly means a new version of the type, never an edit in place:
 * events outlive releases (ADR-022).
 */
const id = z.number().int().positive();
const changes = z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() }));
/** Hierarchy levels a change renumbered, with their rank before and after. */
const shifted = z.array(z.object({ levelId: id, from: z.number().int(), to: z.number().int() }));
/** Tickets that took another type because theirs left a track (CORE-005 (2)). */
const typeMapping = z.array(
  z.object({ fromTypeId: id, toTypeId: id, ticketCount: z.number().int().min(1) }),
);
/** Where a ticket sits: its key, track and type. */
const placement = z.object({ key: z.string(), trackId: id, ticketTypeId: id });

export const EVENT_TYPES = {
  // Instance and sessions
  'setup.completed': {
    subject: 'workspace',
    payload: z.object({ adminId: id, instanceName: z.string() }),
  },
  'session.started': {
    subject: 'user',
    payload: z.object({
      sessionId: id,
      method: z.enum(['password', 'password_link', 'setup', 'totp', 'webauthn', 'recovery_code']),
    }),
  },
  'session.ended': { subject: 'user', payload: z.object({ sessionId: id.nullable() }) },
  'session.revoked': {
    subject: 'user',
    payload: z.object({ count: z.number().int().min(0), by: z.enum(['self', 'admin']) }),
  },

  // People
  'user.created': {
    subject: 'user',
    payload: z.object({
      email: z.string(),
      name: z.string(),
      isSiteAdmin: z.boolean(),
      activationLink: z.boolean(),
    }),
  },
  'user.updated': { subject: 'user', payload: z.object({ changes }) },
  'user.deactivated': {
    subject: 'user',
    payload: z.object({ endedSessions: z.number().int().min(0) }),
  },
  'user.reactivated': { subject: 'user', payload: z.object({}) },
  'user.password_changed': {
    subject: 'user',
    payload: z.object({ via: z.enum(['self', 'link']), endedSessions: z.number().int().min(0) }),
  },
  'user.password_link_created': {
    subject: 'user',
    payload: z.object({ purpose: z.enum(['activate', 'reset']), expiresAt: z.string() }),
  },

  'user.two_factor_enabled': {
    subject: 'user',
    payload: z.object({ method: z.enum(['totp', 'webauthn']), sessionId: id.nullable() }),
  },
  'user.two_factor_disabled': {
    subject: 'user',
    payload: z.object({ method: z.enum(['totp', 'webauthn']) }),
  },
  'user.recovery_codes_regenerated': { subject: 'user', payload: z.object({}) },
  'user.two_factor_reset': { subject: 'user', payload: z.object({}) },
  'two_factor_policy.updated': {
    subject: 'workspace',
    payload: z.object({
      required: z.enum(['none', 'site_admins', 'everyone']),
      groupIds: z.array(id),
    }),
  },

  // Single sign-on
  'sso.signed_in': {
    subject: 'user',
    payload: z.object({
      providerId: id,
      sessionId: id,
      userCreated: z.boolean(),
      groupsAdded: z.array(id),
      groupsRemoved: z.array(id),
    }),
  },
  'identity_provider.created': {
    subject: 'identity_provider',
    payload: z.object({
      name: z.string(),
      issuer: z.string(),
      domains: z.array(z.string()),
      enforceSso: z.boolean(),
      jit: z.boolean(),
      enabled: z.boolean(),
    }),
  },
  'identity_provider.updated': {
    subject: 'identity_provider',
    payload: z.object({
      changes,
      clientSecretChanged: z.boolean(),
      groupMapChanged: z.boolean(),
    }),
  },
  'identity_provider.deleted': {
    subject: 'identity_provider',
    payload: z.object({ name: z.string() }),
  },

  // Groups
  'group.created': { subject: 'group', payload: z.object({ name: z.string() }) },
  'group.updated': { subject: 'group', payload: z.object({ changes }) },
  'group.deleted': { subject: 'group', payload: z.object({ name: z.string() }) },
  'group.member_added': { subject: 'group', payload: z.object({ userId: id }) },
  'group.member_removed': { subject: 'group', payload: z.object({ userId: id }) },
  'group.nested': { subject: 'group', payload: z.object({ childId: id }) },
  'group.unnested': { subject: 'group', payload: z.object({ childId: id }) },

  // Roles, policies and grants
  'role.created': { subject: 'role', payload: z.object({ name: z.string() }) },
  'role.updated': { subject: 'role', payload: z.object({ changes }) },
  'role.deleted': { subject: 'role', payload: z.object({ name: z.string() }) },
  'access_policy.created': {
    subject: 'access_policy',
    payload: z.object({ name: z.string(), copiedFrom: id.nullable() }),
  },
  'access_policy.updated': { subject: 'access_policy', payload: z.object({ changes }) },
  'access_policy.deleted': { subject: 'access_policy', payload: z.object({ name: z.string() }) },
  'access_grant.added': {
    subject: 'access_policy',
    payload: z.object({
      grantId: id,
      permission: z.string(),
      grantee: z.string(),
      roleId: id.nullable(),
      groupId: id.nullable(),
      userId: id.nullable(),
      fieldKey: z.string().nullable(),
    }),
  },
  'access_grant.removed': { subject: 'access_policy', payload: z.object({ grantId: id }) },
  'global_grant.added': {
    subject: 'workspace',
    payload: z.object({
      grantId: id,
      permission: z.string(),
      grantee: z.string(),
      groupId: id.nullable(),
      userId: id.nullable(),
    }),
  },
  'global_grant.removed': { subject: 'workspace', payload: z.object({ grantId: id }) },
  'track_role.actor_added': {
    subject: 'track',
    payload: z.object({ roleId: id, userId: id.nullable(), groupId: id.nullable() }),
  },
  'track_role.actor_removed': {
    subject: 'track',
    payload: z.object({ roleId: id, userId: id.nullable(), groupId: id.nullable() }),
  },

  // Tracks and categories (M1-006)
  'track.created': {
    subject: 'track',
    payload: z.object({
      key: z.string(),
      name: z.string(),
      type: z.enum(['software', 'business', 'service', 'discovery']),
      mode: z.enum(['shared', 'local']),
      ownerId: id.nullable(),
      categoryId: id.nullable(),
      /** For a local-mode track, the policy it owns (a copy of the default, made with it). */
      accessPolicyId: id,
      /** The role the creator joined, the one the policy lets administer the track. */
      administratorRoleId: id.nullable(),
      /** The type set it offers; a local-mode track owns a copy of its type's default. */
      typeSetId: id,
    }),
  },
  /**
   * Field changes; a key change is `changes.key` (the old key keeps resolving). A new type set
   * lists in `mapped` the tickets that took another type because theirs left the track.
   */
  'track.updated': {
    subject: 'track',
    payload: z.object({ changes, mapped: typeMapping.optional() }),
  },
  'track.archived': { subject: 'track', payload: z.object({ key: z.string() }) },
  'track.restored': { subject: 'track', payload: z.object({ key: z.string() }) },
  'track_category.created': { subject: 'track_category', payload: z.object({ name: z.string() }) },
  'track_category.updated': { subject: 'track_category', payload: z.object({ changes }) },
  'track_category.deleted': {
    subject: 'track_category',
    /** Tracks that used it are left without a category. */
    payload: z.object({ name: z.string(), trackCount: z.number().int().min(0) }),
  },

  // Hierarchy levels, ticket types and type sets (M1-007)
  'hierarchy_level.created': {
    subject: 'hierarchy_level',
    payload: z.object({ name: z.string(), rank: z.number().int(), shifted }),
  },
  /** Field changes; a new rank is `changes.rank`, and the levels it renumbered are `shifted`. */
  'hierarchy_level.updated': {
    subject: 'hierarchy_level',
    payload: z.object({ changes, shifted }),
  },
  /** Its ticket types fall to the standard level (rule 7); the levels above move down. */
  'hierarchy_level.deleted': {
    subject: 'hierarchy_level',
    payload: z.object({
      name: z.string(),
      rank: z.number().int(),
      shifted,
      typesToStandard: z.array(id),
    }),
  },
  'ticket_type.created': {
    subject: 'ticket_type',
    payload: z.object({
      name: z.string(),
      levelId: id,
      rank: z.number().int(),
      /** The local-mode track that owns the type; null for a shared type. */
      trackId: id.nullable(),
    }),
  },
  'ticket_type.updated': { subject: 'ticket_type', payload: z.object({ changes }) },
  'ticket_type.deleted': {
    subject: 'ticket_type',
    payload: z.object({ name: z.string(), trackId: id.nullable() }),
  },
  'type_set.created': {
    subject: 'type_set',
    payload: z.object({
      name: z.string(),
      ticketTypeIds: z.array(id),
      defaultTypeId: id.nullable(),
      defaultFor: z.array(z.enum(['software', 'business', 'service', 'discovery'])),
    }),
  },
  /**
   * Field changes: name, description, `ticketTypeIds` (in order), defaultTypeId, defaultFor.
   * `mapped` lists the tickets that took another type because theirs left the set.
   */
  'type_set.updated': {
    subject: 'type_set',
    payload: z.object({ changes, mapped: typeMapping.optional() }),
  },
  'type_set.deleted': { subject: 'type_set', payload: z.object({ name: z.string() }) },

  // Tickets (M1-008). The change history (M1-009) keeps the field-by-field detail.
  'ticket.created': {
    subject: 'ticket',
    payload: z.object({
      key: z.string(),
      trackId: id,
      ticketTypeId: id,
      parentId: id.nullable(),
    }),
  },
  /** Fields as the API names them; rich text changes carry both documents. */
  'ticket.updated': { subject: 'ticket', payload: z.object({ key: z.string(), changes }) },
  /** To another track: a new key there; the old key keeps resolving. Subtickets come along. */
  'ticket.moved': {
    subject: 'ticket',
    payload: z.object({
      from: placement,
      to: placement,
      parentId: id.nullable(),
      subtickets: z.array(z.object({ id, from: z.string(), to: z.string(), ticketTypeId: id })),
    }),
  },
  'ticket.ranked': {
    subject: 'ticket',
    payload: z.object({ key: z.string(), from: z.string(), to: z.string() }),
  },
  /** To the trash, with its subtickets; children above that level lose the link to it. */
  'ticket.deleted': {
    subject: 'ticket',
    payload: z.object({
      key: z.string(),
      subtickets: z.array(id),
      detachedChildren: z.array(id),
    }),
  },
  /**
   * Out of the trash, with the subtickets that went with it and the children that lost their
   * link; `detachedFrom` is a parent still in the trash, whose link waits for its restore.
   */
  'ticket.restored': {
    subject: 'ticket',
    payload: z.object({
      key: z.string(),
      subtickets: z.array(id),
      reattachedChildren: z.array(id),
      detachedFrom: id.nullable(),
    }),
  },
  // Audit log
  'audit.settings_updated': { subject: 'workspace', payload: z.object({ changes }) },
  // API tokens and service accounts (IAM-007). Never the token or its hash.
  'token.created': {
    subject: 'api_token',
    payload: z.object({
      ownerId: id,
      ownerKind: z.enum(['person', 'service']),
      name: z.string(),
      scopes: z.array(z.enum(['read', 'write', 'admin', 'scim'])),
      expiresAt: z.string(),
    }),
  },
  'token.revoked': {
    subject: 'api_token',
    payload: z.object({ ownerId: id, by: z.enum(['self', 'admin']) }),
  },
  'token.rotated': {
    subject: 'api_token',
    payload: z.object({
      ownerId: id,
      replaces: id,
      overlapHours: z.number().int().min(0),
      expiresAt: z.string(),
      by: z.enum(['self', 'admin']),
    }),
  },
  'token.bulk_revoked': {
    subject: 'workspace',
    payload: z.object({
      count: z.number().int().min(1),
      ownerId: id.nullable(),
      createdBefore: z.string().nullable(),
      all: z.boolean(),
    }),
  },
  'token_policy.updated': { subject: 'workspace', payload: z.object({ changes }) },
  // SCIM provisioning (M1-083, IAM-006, ADR-038); the actor is the provisioning service account.
  /** A person provisioned; `revived` when it brings back an account SCIM removed before. */
  'scim.user_created': {
    subject: 'user',
    payload: z.object({
      userName: z.string(),
      email: z.string(),
      externalId: z.string().nullable(),
      active: z.boolean(),
      revived: z.boolean(),
    }),
  },
  /**
   * Changes to the account (`userName`, `externalId`, `email`, `name`, `active`, `locale`,
   * `timeZone`) and the names of the other attributes that changed; deactivating ends sessions.
   */
  'scim.user_updated': {
    subject: 'user',
    payload: z.object({
      changes,
      attributes: z.array(z.string()),
      endedSessions: z.number().int().min(0),
    }),
  },
  /** Deprovisioned: deactivated and out of SCIM's sight; the account and its work stay. */
  'scim.user_removed': {
    subject: 'user',
    payload: z.object({ userName: z.string(), endedSessions: z.number().int().min(0) }),
  },
  'scim.group_created': {
    subject: 'group',
    payload: z.object({
      name: z.string(),
      externalId: z.string().nullable(),
      members: z.array(id),
    }),
  },
  'scim.group_updated': {
    subject: 'group',
    payload: z.object({ changes, added: z.array(id), removed: z.array(id) }),
  },
  'scim.group_deleted': { subject: 'group', payload: z.object({ name: z.string() }) },
  'service_account.created': {
    subject: 'user',
    payload: z.object({ name: z.string(), email: z.string(), description: z.string() }),
  },
  'service_account.updated': { subject: 'user', payload: z.object({ changes }) },
  'service_account.deactivated': { subject: 'user', payload: z.object({}) },
  'service_account.reactivated': { subject: 'user', payload: z.object({}) },
} as const satisfies Record<string, { subject: string; payload: z.ZodType }>;

export type EventType = keyof typeof EVENT_TYPES;
export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_TYPES)[T]['payload']>;

/** What a mutation hands to `emit`. The subject type comes from the catalogue. */
export type DomainEventInput = {
  [T in EventType]: {
    type: T;
    subjectId: number | string;
    payload: EventPayload<T>;
  };
}[EventType];

/** An event as subscribers receive it. */
export interface DomainEvent {
  id: string;
  workspaceId: number;
  type: EventType;
  version: number;
  actorId: number | null;
  subjectType: string;
  subjectId: string;
  payload: unknown;
  occurredAt: Date;
  /** Client address of the request that caused it; null outside a request. */
  ip: string | null;
}

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_TYPES, value);
}

/** The field-by-field changes between two records, for *.updated events. */
export function diff<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, value] of Object.entries(after)) {
    if (value === undefined || before[key] === value) continue;
    // Arrays and objects compare by content, so an unchanged list is not reported.
    if (typeof value === 'object' && JSON.stringify(before[key]) === JSON.stringify(value))
      continue;
    out[key] = { from: before[key] ?? null, to: value };
  }
  return out;
}
