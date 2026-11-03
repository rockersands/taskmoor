import type { Database } from '@taskmoor/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { startSession } from '../auth';
import type { Authorizer } from '../authz/authorizer';
import { emit } from '../events/bus';
import { invitationOpensAccount } from '../routes/invitations';
import { emailDomain, syncGroups } from './oidc';

/**
 * Finishing a single sign-on, whatever the protocol (M1-080 OpenID Connect, M1-081 SAML;
 * IAM-002, IAM-003, ADR-019): the provider has vouched for a person, and Taskmoor decides
 * whether that person may sign in, to which account, with which groups.
 */
export interface SsoIdentity {
  /** The provider's stable identifier for the person. */
  subject: string;
  email: string | null;
  /** Whether the provider vouches for the address (always so for SAML: see ADR-019). */
  emailVerified: boolean;
  name: string | null;
  /** Values of the provider's group claim or attribute. */
  groups: string[];
}

export type SsoRefusal =
  | 'email_unverified'
  | 'domain_not_allowed'
  | 'no_account'
  | 'account_deactivated';

export interface SsoProviderRules {
  id: number;
  protocol: 'oidc' | 'saml';
  domains: string[];
  jit: boolean;
}

/**
 * Links or creates the account, syncs the mapped groups and starts the session, all in one
 * transaction with its `sso.signed_in` event. The subject identifies the person after the
 * first sign-in; that first sign-in links an existing account or creates one only for a
 * verified address of a domain the provider serves. Service accounts and deactivated accounts
 * stay out. A provider that makes no accounts still makes one for a verified address with a
 * live invitation (IAM-029; ADR-118): someone who may invite asked for that person.
 */
export async function completeSsoSignIn(
  db: Kysely<Database>,
  request: FastifyRequest,
  reply: FastifyReply,
  provider: SsoProviderRules,
  identity: SsoIdentity,
  options: { secureCookies: boolean; authorizer: Authorizer },
): Promise<{ error: null } | { error: SsoRefusal; userId?: number }> {
  const ws = request.workspaceId;
  // Read before the transaction, which never waits for a second pooled connection.
  const invited =
    !provider.jit && identity.email && identity.emailVerified
      ? await invitationOpensAccount(db, options.authorizer, ws, identity.email)
      : false;
  return db.transaction().execute(async (trx) => {
    const linked = await trx
      .selectFrom('user_identity as i')
      .innerJoin('app_user as u', 'u.id', 'i.user_id')
      .select(['u.id', 'u.deactivated_at', 'u.kind'])
      .where('i.provider_id', '=', provider.id)
      .where('i.subject', '=', identity.subject)
      .executeTakeFirst();
    let userId = linked?.id;
    let created = false;
    // Service accounts never sign in, through a provider or otherwise (IAM-007).
    if (linked?.kind === 'service') return { error: 'no_account' as const };
    if (linked?.deactivated_at) return { error: 'account_deactivated' as const, userId: linked.id };
    if (!userId) {
      // A first sign-in: only a verified email of a domain this provider serves may be linked
      // to an account or create one, so a provider cannot claim someone else's address.
      if (!identity.email || !identity.emailVerified) return { error: 'email_unverified' as const };
      if (!provider.domains.includes(emailDomain(identity.email))) {
        return { error: 'domain_not_allowed' as const };
      }
      const existing = await trx
        .selectFrom('app_user')
        .select(['id', 'deactivated_at', 'kind'])
        .where('workspace_id', '=', ws)
        .where(sql<string>`lower(email)`, '=', identity.email)
        .executeTakeFirst();
      if (existing?.kind === 'service') return { error: 'no_account' as const };
      if (existing?.deactivated_at) {
        return { error: 'account_deactivated' as const, userId: existing.id };
      }
      if (existing) {
        userId = existing.id;
      } else {
        if (!provider.jit && !invited) return { error: 'no_account' as const };
        const row = await trx
          .insertInto('app_user')
          .values({
            workspace_id: ws,
            email: identity.email,
            name: identity.name ?? identity.email,
            password_hash: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        userId = row.id;
        created = true;
      }
      await trx
        .insertInto('user_identity')
        .values({
          workspace_id: ws,
          provider_id: provider.id,
          subject: identity.subject,
          user_id: userId,
          email: identity.email,
        })
        .execute();
    }
    const groups = await syncGroups(trx, ws, provider.id, userId, identity.groups);
    const now = new Date();
    await trx
      .updateTable('user_identity')
      .set({ last_sign_in_at: now, ...(identity.email ? { email: identity.email } : {}) })
      .where('provider_id', '=', provider.id)
      .where('subject', '=', identity.subject)
      .execute();
    await trx
      .updateTable('app_user')
      .set({ last_sign_in_at: now })
      .where('id', '=', userId)
      .execute();
    const sessionId = await startSession(trx, request, reply, {
      userId,
      secure: options.secureCookies,
    });
    await emit(
      trx,
      { workspaceId: ws, actorId: userId },
      {
        type: 'sso.signed_in',
        subjectId: userId,
        payload: {
          providerId: provider.id,
          protocol: provider.protocol,
          sessionId,
          userCreated: created,
          groupsAdded: groups.added,
          groupsRemoved: groups.removed,
        },
      },
    );
    return { error: null };
  });
}
