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
/** A link between two tickets, from the ticket the call was made on. */
const ticketLink = z.object({
  key: z.string(),
  linkId: id,
  linkTypeId: id,
  sourceId: id,
  targetId: id,
});
/** A value deleted, and what tickets that had it took instead. */
const replaced = z.object({
  name: z.string(),
  replacementId: id.nullable(),
  ticketCount: z.number().int().min(0),
});

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
      // Added with directories (M1-082): the directory that checked the password.
      directoryId: id.optional(),
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
      // Added with SAML (M1-081); events before it are OpenID Connect sign-ins.
      protocol: z.enum(['oidc', 'saml']).optional(),
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
      // Added with SAML (M1-081); providers before it use OpenID Connect. A SAML provider's
      // issuer is its entity ID.
      protocol: z.enum(['oidc', 'saml']).optional(),
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
    payload: z.object({
      changes,
      mapped: typeMapping.optional(),
      /** Tickets moved to another status by a switch of workflow (M1-023). */
      statusMapped: z.number().int().min(1).optional(),
    }),
  },
  'track.archived': { subject: 'track', payload: z.object({ key: z.string() }) },
  'track.restored': { subject: 'track', payload: z.object({ key: z.string() }) },
  /** To the trash (M1-101), with its tickets, releases and areas; it keeps its keys. */
  'track.deleted': { subject: 'track', payload: z.object({ key: z.string() }) },
  /** Out of the trash, as it was. */
  'track.undeleted': { subject: 'track', payload: z.object({ key: z.string() }) },
  /** Deleted for good: by the retention purge or a site administrator, with its tickets. */
  'track.purged': {
    subject: 'track',
    payload: z.object({
      key: z.string(),
      name: z.string(),
      tickets: z.number().int().min(0),
      reason: z.enum(['retention', 'admin']),
    }),
  },
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
  /** With the event the create transition fires and the webhook effects it queued (WF-005). */
  'ticket.created': {
    subject: 'ticket',
    payload: z.object({
      key: z.string(),
      trackId: id,
      ticketTypeId: id,
      parentId: id.nullable(),
      event: z.string(),
      webhookCount: z.number().int().min(0),
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
  /**
   * Deleted for good from the trash (M1-101), by the retention purge or a site administrator,
   * with the subtickets in the trash that cannot outlive it; children elsewhere lost the link.
   */
  'ticket.purged': {
    subject: 'ticket',
    payload: z.object({
      key: z.string(),
      subtickets: z.array(id),
      detachedChildren: z.array(id),
      reason: z.enum(['retention', 'admin']),
    }),
  },
  /** The trash retention in days (M1-101, CORE-025 (3)). */
  'trash_policy.updated': { subject: 'workspace', payload: z.object({ changes }) },
  // Priorities, close reasons, labels, releases and areas (M1-014). Tickets a change rewrites
  // record it in their own history.
  'priority.created': { subject: 'priority', payload: z.object({ name: z.string() }) },
  'priority.updated': { subject: 'priority', payload: z.object({ changes }) },
  /** Tickets and priority sets that had it take the replacement. */
  'priority.deleted': { subject: 'priority', payload: replaced },
  'priority.reordered': { subject: 'workspace', payload: z.object({ priorityIds: z.array(id) }) },
  'priority_set.created': {
    subject: 'priority_set',
    payload: z.object({
      name: z.string(),
      priorityIds: z.array(id),
      defaultPriorityId: id.nullable(),
    }),
  },
  'priority_set.updated': { subject: 'priority_set', payload: z.object({ changes }) },
  /** Tracks that used it offer the default set. */
  'priority_set.deleted': {
    subject: 'priority_set',
    payload: z.object({ name: z.string(), trackCount: z.number().int().min(0) }),
  },
  'close_reason.created': { subject: 'close_reason', payload: z.object({ name: z.string() }) },
  'close_reason.updated': { subject: 'close_reason', payload: z.object({ changes }) },
  'close_reason.deleted': { subject: 'close_reason', payload: replaced },
  'close_reason.reordered': {
    subject: 'workspace',
    payload: z.object({ closeReasonIds: z.array(id) }),
  },
  /** Labels merged into one (a rename is a merge of one label into a new name). */
  'label.merged': {
    subject: 'workspace',
    payload: z.object({
      labels: z.array(z.string()),
      into: z.string(),
      ticketCount: z.number().int().min(0),
    }),
  },
  'release.created': {
    subject: 'release',
    payload: z.object({ trackId: id, name: z.string() }),
  },
  'release.updated': { subject: 'release', payload: z.object({ changes }) },
  'release.reordered': { subject: 'track', payload: z.object({ releaseIds: z.array(id) }) },
  /** Its open tickets (target release, not closed) moved to `movedTo`, or stayed. */
  'release.shipped': {
    subject: 'release',
    payload: z.object({
      name: z.string(),
      releaseDate: z.string(),
      openTickets: z.number().int().min(0),
      movedTo: id.nullable(),
    }),
  },
  'release.unshipped': { subject: 'release', payload: z.object({ name: z.string() }) },
  'release.archived': { subject: 'release', payload: z.object({ name: z.string() }) },
  'release.restored': { subject: 'release', payload: z.object({ name: z.string() }) },
  /** Its tickets point at `into` instead, in both roles; the release is gone. */
  'release.merged': {
    subject: 'release',
    payload: z.object({ name: z.string(), into: id, ticketCount: z.number().int().min(0) }),
  },
  /** Gone; tickets that had it lost it. */
  'release.deleted': {
    subject: 'release',
    payload: z.object({ name: z.string(), ticketCount: z.number().int().min(0) }),
  },
  'release.approvers_set': {
    subject: 'release',
    payload: z.object({ added: z.array(id), removed: z.array(id) }),
  },
  'release.approval_decided': {
    subject: 'release',
    payload: z.object({ decision: z.enum(['approved', 'declined']), comment: z.string() }),
  },
  'area.created': { subject: 'area', payload: z.object({ trackId: id, name: z.string() }) },
  'area.updated': { subject: 'area', payload: z.object({ changes }) },
  'area.archived': { subject: 'area', payload: z.object({ name: z.string() }) },
  'area.restored': { subject: 'area', payload: z.object({ name: z.string() }) },
  /** Tickets that had it take the replacement, or lose it when there is none. */
  'area.deleted': { subject: 'area', payload: replaced },
  // Links, web links, followers and votes (M1-015). Link changes are also ticket history.
  'link_type.created': {
    subject: 'link_type',
    payload: z.object({ name: z.string(), outward: z.string(), inward: z.string() }),
  },
  'link_type.updated': { subject: 'link_type', payload: z.object({ changes }) },
  /** Its links took the replacement. */
  'link_type.deleted': {
    subject: 'link_type',
    payload: z.object({
      name: z.string(),
      replacementId: id.nullable(),
      linkCount: z.number().int().min(0),
    }),
  },
  'link_policy.updated': { subject: 'workspace', payload: z.object({ changes }) },

  // Custom fields (M1-010)
  'field.created': {
    subject: 'field',
    payload: z.object({
      name: z.string(),
      type: z.string(),
      multiple: z.boolean(),
      /** The local-mode track that owns it; null when shared. */
      trackId: id.nullable(),
      contextId: id,
      optionCount: z.number().int().min(0),
    }),
  },
  'field.updated': { subject: 'field', payload: z.object({ changes }) },
  'field.deleted': { subject: 'field', payload: z.object({ name: z.string(), type: z.string() }) },
  'field_context.created': {
    subject: 'field_context',
    payload: z.object({ fieldId: id, name: z.string(), optionCount: z.number().int().min(0) }),
  },
  'field_context.updated': {
    subject: 'field_context',
    payload: z.object({ fieldId: id, changes }),
  },
  'field_context.deleted': {
    subject: 'field_context',
    payload: z.object({ fieldId: id, name: z.string() }),
  },
  'field_option.created': {
    subject: 'field_option',
    payload: z.object({ fieldId: id, contextId: id, parentId: id.nullable(), value: z.string() }),
  },
  'field_option.updated': {
    subject: 'field_option',
    payload: z.object({ fieldId: id, contextId: id, changes }),
  },
  /** The subject is the context; the options under one parent in their new order. */
  'field_option.reordered': {
    subject: 'field_context',
    payload: z.object({ fieldId: id, parentId: id.nullable(), optionIds: z.array(id) }),
  },
  // Field rule sets and layout sets (M1-012); `trackIds` names every track a save reaches.
  'field_rule_set.created': {
    subject: 'field_rule_set',
    payload: z.object({ name: z.string(), trackId: id.nullable(), count: z.number().int().min(0) }),
  },
  'field_rule_set.updated': {
    subject: 'field_rule_set',
    payload: z.object({ changes, trackIds: z.array(id) }),
  },
  'field_rule_set.deleted': { subject: 'field_rule_set', payload: z.object({ name: z.string() }) },
  'layout_set.created': {
    subject: 'layout_set',
    payload: z.object({ name: z.string(), trackId: id.nullable(), count: z.number().int().min(0) }),
  },
  'layout_set.updated': {
    subject: 'layout_set',
    payload: z.object({ changes, trackIds: z.array(id) }),
  },
  'layout_set.deleted': { subject: 'layout_set', payload: z.object({ name: z.string() }) },
  'field_option.deleted': {
    subject: 'field_option',
    payload: z.object({ fieldId: id, contextId: id, value: z.string() }),
  },
  'ticket.linked': { subject: 'ticket', payload: ticketLink },
  'ticket.unlinked': { subject: 'ticket', payload: ticketLink },
  /** A URL can carry a token in its query, so web link events name fields, never URLs. */
  'ticket.web_link_added': {
    subject: 'ticket',
    payload: z.object({
      key: z.string(),
      webLinkId: id,
      title: z.string(),
      globalId: z.string().nullable(),
    }),
  },
  'ticket.web_link_updated': {
    subject: 'ticket',
    payload: z.object({ key: z.string(), webLinkId: id, fields: z.array(z.string()) }),
  },
  'ticket.web_link_removed': {
    subject: 'ticket',
    payload: z.object({ key: z.string(), webLinkId: id }),
  },
  'ticket.followed': { subject: 'ticket', payload: z.object({ key: z.string(), userId: id }) },
  'ticket.unfollowed': { subject: 'ticket', payload: z.object({ key: z.string(), userId: id }) },
  'ticket.voted': { subject: 'ticket', payload: z.object({ key: z.string() }) },
  'ticket.unvoted': { subject: 'ticket', payload: z.object({ key: z.string() }) },
  'user.preferences_updated': { subject: 'user', payload: z.object({ changes }) },
  // Statuses and workflows (M1-023). Status changes of tickets are also their history.
  'status.created': {
    subject: 'status',
    payload: z.object({ name: z.string(), stage: z.enum(['new', 'active', 'closed']) }),
  },
  'status.updated': { subject: 'status', payload: z.object({ changes }) },
  'status.reordered': { subject: 'workspace', payload: z.object({ statusIds: z.array(id) }) },
  'status.deleted': { subject: 'status', payload: z.object({ name: z.string() }) },
  'workflow.created': {
    subject: 'workflow',
    payload: z.object({
      name: z.string(),
      statusIds: z.array(id),
      transitionCount: z.number().int().min(0),
    }),
  },
  'workflow.updated': { subject: 'workflow', payload: z.object({ changes }) },
  /** A draft saved, or an earlier version (`restoredFrom`) brought back as the draft. */
  'workflow.draft_saved': {
    subject: 'workflow',
    payload: z.object({ version: z.number().int().positive(), restoredFrom: id.nullable() }),
  },
  'workflow.draft_discarded': {
    subject: 'workflow',
    payload: z.object({ version: z.number().int().positive() }),
  },
  /** The draft is current; tickets in statuses it dropped moved as `statusMapping` says. */
  'workflow.published': {
    subject: 'workflow',
    payload: z.object({
      version: z.number().int().positive(),
      removedStatuses: z.array(id),
      statusMapping: z.record(z.string(), id),
      ticketCount: z.number().int().min(0),
    }),
  },
  'workflow.deleted': { subject: 'workflow', payload: z.object({ name: z.string() }) },
  /**
   * Along a workflow transition (M1-024): the workflow version that ran it, the event it fired
   * (generic or custom, WF-006) and how many webhook effects it queued; webhook addresses stay
   * in the workflow, as they can carry tokens.
   */
  'ticket.transitioned': {
    subject: 'ticket',
    payload: z.object({
      key: z.string(),
      transitionId: id,
      from: id,
      to: id,
      workflowId: id,
      version: z.number().int().positive(),
      event: z.string(),
      webhookCount: z.number().int().min(0),
      channel: z.enum(['ui', 'rest', 'automation']),
    }),
  },
  // Time tracking (M1-019). Durations in seconds; the ticket history keeps the detail.
  'time_tracking.settings_updated': { subject: 'workspace', payload: z.object({ changes }) },
  'time_entry.created': {
    subject: 'time_entry',
    payload: z.object({
      key: z.string(),
      ticketId: id,
      duration: z.number().int().positive(),
      startedAt: z.string(),
    }),
  },
  /** The names of the fields that changed; a description can be long and restricted. */
  'time_entry.updated': {
    subject: 'time_entry',
    payload: z.object({ key: z.string(), ticketId: id, fields: z.array(z.string()) }),
  },
  'time_entry.deleted': {
    subject: 'time_entry',
    payload: z.object({ key: z.string(), ticketId: id, duration: z.number().int().positive() }),
  },
  // Audit log
  'audit.settings_updated': { subject: 'workspace', payload: z.object({ changes }) },
  /** The schedule, retention and verification of scheduled backups (M1-101, OPS-008). */
  'backup_schedule.updated': { subject: 'workspace', payload: z.object({ changes }) },
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
  // LDAP and Active Directory (M1-082, IAM-005, ADR-019). Administration events name the
  // administrator; a sync's own changes have no actor and name the directory and the run.
  'directory.created': {
    subject: 'directory',
    payload: z.object({
      name: z.string(),
      kind: z.enum(['active_directory', 'openldap', 'generic']),
      url: z.string(),
      mode: z.enum(['read_only', 'read_write']),
      enabled: z.boolean(),
      position: z.number().int().min(1),
    }),
  },
  /** Changed settings (never the bind password itself, only that it changed). */
  'directory.updated': {
    subject: 'directory',
    payload: z.object({
      changes,
      bindPasswordChanged: z.boolean(),
      caCertificatesChanged: z.boolean(),
    }),
  },
  /** The directory's accounts are deactivated; its groups stay as Taskmoor groups. */
  'directory.deleted': {
    subject: 'directory',
    payload: z.object({
      name: z.string(),
      deactivatedUsers: z.number().int().min(0),
      releasedGroups: z.number().int().min(0),
    }),
  },
  /** Precedence: the directories in their new order, first wins. */
  'directory.reordered': { subject: 'workspace', payload: z.object({ ids: z.array(id) }) },
  /** A run asked for by an administrator; `coalesced` when one was already waiting. */
  'directory.sync_requested': {
    subject: 'directory',
    payload: z.object({
      runId: id,
      mode: z.enum(['full', 'incremental']),
      confirmRemovals: z.boolean(),
      coalesced: z.boolean(),
    }),
  },
  /** A run that changed something or failed; runs that changed nothing are in its history. */
  'directory.synced': {
    subject: 'directory',
    payload: z.object({
      runId: id,
      mode: z.enum(['full', 'incremental']),
      trigger: z.enum(['schedule', 'manual']),
      status: z.enum(['succeeded', 'failed']),
      stats: z.record(z.string(), z.number()),
      warnings: z.number().int().min(0),
      error: z.string().nullable(),
    }),
  },
  /** An account the directory created, or an existing one it linked (`linked`). */
  'directory.user_created': {
    subject: 'user',
    payload: z.object({
      directoryId: id,
      runId: id,
      email: z.string(),
      username: z.string(),
      dn: z.string(),
      linked: z.boolean(),
      takenFromDirectoryId: id.nullable(),
      active: z.boolean(),
    }),
  },
  /** Changes to the account (`email`, `name`, `active`) and its entry (`dn`, `username`, ...). */
  'directory.user_updated': {
    subject: 'user',
    payload: z.object({
      directoryId: id,
      runId: id,
      changes,
      endedSessions: z.number().int().min(0),
    }),
  },
  /** The entry left the directory or its filter: deactivated, unless protected. */
  'directory.user_removed': {
    subject: 'user',
    payload: z.object({
      directoryId: id,
      runId: id,
      username: z.string(),
      dn: z.string(),
      deactivated: z.boolean(),
      endedSessions: z.number().int().min(0),
    }),
  },
  /** Member and child ids are listed up to 1,000; the counts are complete. */
  'directory.group_created': {
    subject: 'group',
    payload: z.object({
      directoryId: id,
      runId: id,
      name: z.string(),
      dn: z.string(),
      members: z.array(id),
      memberCount: z.number().int().min(0),
      children: z.array(id),
    }),
  },
  'directory.group_updated': {
    subject: 'group',
    payload: z.object({
      directoryId: id,
      runId: id,
      changes,
      added: z.array(id),
      removed: z.array(id),
      addedCount: z.number().int().min(0),
      removedCount: z.number().int().min(0),
      nested: z.array(id),
      unnested: z.array(id),
    }),
  },
  'directory.group_deleted': {
    subject: 'group',
    payload: z.object({ directoryId: id, runId: id, name: z.string() }),
  },
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
