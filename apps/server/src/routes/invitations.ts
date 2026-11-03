import type { Database } from '@taskmoor/db';
import {
  checkPassword,
  describePasswordProblem,
  newToken,
  type PasswordHasher,
  tokenHash,
} from '@taskmoor/iam';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { recordRejectedLink } from '../audit/record';
import { requireUser } from '../auth';
import type { Authorizer } from '../authz/authorizer';
import {
  checkGivingCreateTracks,
  giveCreateTracks,
  inviterMayGiveCreateTracks,
} from '../authz/create-tracks';
import {
  inviterStillBacks,
  mayGiveRole,
  roleRunsTrack,
  trackKeepsAdministrator,
} from '../authz/track-admins';
import { validLocale } from '../directory';
import { renderInvitationEmail } from '../email/invitation';
import type { MailTransport } from '../email/transport';
import { emit } from '../events/bus';
import { RateLimiter } from '../ratelimit/limiter';
import { emailDomain, providerForDomain } from '../sso/oidc';
import { lockedUntil, recordFailure, secondsUntil } from '../throttle';
import { keepRole } from '../trackgroups/access';
import { trackInTrash } from '../trash/policy';
import { isExternal, readPolicy } from '../two-factor';

/** How long an invitation's link works: longer than a password link, people read mail late. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Addresses in one request. */
export const MAX_ADDRESSES = 50;
/** Sends per inviter: 100 at once and 100 an hour, every address and every resend counted. */
export const INVITER_LIMITS = { rate: 100 / 3600, burst: 100 };
/** Sends per address, whoever sends them, so nobody's mailbox gets flooded. */
export const ADDRESS_LIMITS = { rate: 5 / 3600, burst: 5 };

/** How invitation emails leave this server; null while no mail server is set up. */
export type InvitationMail = () => Promise<{ transport: MailTransport; from: string } | null>;

const id = z.coerce.number().int().positive();
const delivery = z.enum(['email', 'link']);
const inviteBody = z
  .object({
    addresses: z.array(z.string().max(320)).max(MAX_ADDRESSES).default([]),
    userIds: z.array(id).max(MAX_ADDRESSES).default([]),
    roleId: id,
    delivery,
    /** The role that runs the track comes with the permission to create tracks (IAM-033). */
    createTracks: z.boolean().default(false),
  })
  .strict();
const resendBody = z.object({ delivery }).strict();
const tokenBody = z.object({ token: z.string().min(1).max(200) }).strict();
const redeemBody = z
  .object({
    token: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    password: z.string().max(1024),
    locale: z.string().trim().min(2).max(35).optional(),
  })
  .strict();
const address = z.string().email();

const invalid = (reply: FastifyReply, detail?: string) =>
  reply.code(400).send({ error: 'invalid_request', ...(detail ? { detail } : {}) });

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === '23505';
}

/** An address as stored, or null when it cannot be one: `.invalid` is for accounts we made. */
export function normalisedAddress(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!address.safeParse(email).success) return null;
  return email.endsWith('.invalid') ? null : email;
}

export function invitationUrl(publicUrl: string, token: string, hasAccount = false): string {
  const base = publicUrl.replace(/\/+$/, '');
  return `${base}/#/invite?token=${encodeURIComponent(token)}${hasAccount ? '&account=1' : ''}`;
}

/** What a send needs after the database has committed. */
interface Send {
  to: string;
  invitationId: number | null;
  kind: 'invited' | 'added';
  url: string;
  expiresAt: Date | null;
  locale: string | null;
}

/**
 * Inviting people into a track and giving them a role (IAM-027 to IAM-030; ADR-118).
 *
 * Only someone who runs the track and holds `invite_people` invites, only into that track, and
 * only with a role they may give (`mayGiveRole`). An invitation holds one track and one role; with
 * a role that runs the track it can also hold the permission to create tracks (IAM-033), the one
 * global thing it gives, and only when whoever backs it may give that too, both when it is made
 * and when the role is given. No answer says whether an address has an account: an existing person gets
 * the role at once and a different email, but the inviter sees the same answer and the same open
 * invitation. A link travels only in the email or in the answer that made it; the database keeps
 * its hash. Setting a password never signs anyone in here: the person goes through the ordinary
 * sign-in next, so a required second factor (external people, ADR-078) is asked as always.
 */
export function registerInvitationRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: {
    authorizer: Authorizer;
    passwords: PasswordHasher;
    publicUrl: string;
    mail: InvitationMail;
    limiter?: RateLimiter;
  },
): void {
  const { authorizer, publicUrl } = options;
  const limiter = options.limiter ?? new RateLimiter();

  /** The track, for someone who runs it; answers otherwise. */
  async function runningTrack(request: FastifyRequest, reply: FastifyReply, trackId: number) {
    if (!requireUser(request, reply)) return null;
    const track = await db
      .selectFrom('track')
      .select(['id', 'key', 'name'])
      .where('id', '=', trackId)
      .where('workspace_id', '=', request.workspaceId)
      .executeTakeFirst();
    if (!track || (await trackInTrash(db, trackId))) {
      await reply.code(404).send({ error: 'not_found' });
      return null;
    }
    if (!(await request.authz.can('administer_track', trackId))) {
      await reply.code(403).send({ error: 'forbidden' });
      return null;
    }
    return track;
  }

  /** As `runningTrack`, for someone who may also invite into it. */
  async function invitingTrack(request: FastifyRequest, reply: FastifyReply, trackId: number) {
    const track = await runningTrack(request, reply, trackId);
    if (!track) return null;
    if (!(await request.authz.can('invite_people', trackId))) {
      await reply.code(403).send({ error: 'forbidden', permission: 'invite_people' });
      return null;
    }
    return track;
  }

  const refuseRole = (reply: FastifyReply) =>
    reply.code(403).send({ error: 'forbidden', permission: 'appoint_track_admins' });

  /** The tracks the person runs: their way to each track's Manage page (IAM-030). */
  app.get('/api/v1/me/managed-tracks', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const allowed = await request.authz.allowedTracks('administer_track');
    if (allowed !== 'all' && allowed.length === 0) return { tracks: [] };
    let query = db
      .selectFrom('track')
      .select(['id', 'key', 'name', 'mode'])
      .where('workspace_id', '=', request.workspaceId)
      .where('deleted_at', 'is', null)
      .where('archived_at', 'is', null);
    if (allowed !== 'all') query = query.where('id', 'in', allowed);
    return { tracks: await query.orderBy('key').limit(500).execute() };
  });

  /** The roles of a track's Manage page, and which of them the person may give. */
  app.get('/api/v1/tracks/:id/roles', async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    if (!(await runningTrack(request, reply, params.data.id))) return reply;
    const [roles, runs, canAppoint] = await Promise.all([
      db
        .selectFrom('role')
        .select(['id', 'name', 'description'])
        .where('workspace_id', '=', request.workspaceId)
        .orderBy(sql`lower(name)`)
        .execute(),
      db
        .selectFrom('access_grant as g')
        .innerJoin('track as t', 't.access_policy_id', 'g.policy_id')
        .select('g.role_id')
        .where('t.id', '=', params.data.id)
        .where('g.permission', '=', 'administer_track')
        .where('g.grantee', '=', 'role')
        .execute(),
      request.authz.can('appoint_track_admins', params.data.id),
    ]);
    const running = new Set(runs.map((r) => r.role_id));
    return {
      roles: roles.map((r) => ({
        ...r,
        runsTrack: running.has(r.id),
        givable: canAppoint || !running.has(r.id),
      })),
    };
  });

  async function mailReady() {
    try {
      return await options.mail();
    } catch {
      return null;
    }
  }

  app.get('/api/v1/tracks/:id/invitations', async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const trackId = params.data.id;
    if (!(await runningTrack(request, reply, trackId))) return reply;
    const ws = request.workspaceId;
    const rows = await db
      .selectFrom('track_invitation as i')
      .innerJoin('role as r', 'r.id', 'i.role_id')
      .leftJoin('app_user as u', 'u.id', 'i.invited_by')
      .select([
        'i.id',
        'i.email',
        'i.role_id',
        'r.name as role_name',
        'i.invited_by',
        'u.name as inviter_name',
        'i.delivery',
        'i.last_error',
        'i.last_sent_at',
        'i.expires_at',
      ])
      .where('i.track_id', '=', trackId)
      .where('i.workspace_id', '=', ws)
      .where('i.accepted_at', 'is', null)
      .where('i.revoked_at', 'is', null)
      .orderBy('i.last_sent_at', 'desc')
      .orderBy('i.id', 'desc')
      .limit(500)
      .execute();
    const policy = await readPolicy(db, ws);
    const now = new Date();
    const invitations = await Promise.all(
      rows.map(async (r) => {
        const live =
          r.expires_at > now &&
          (await inviterStillBacks(db, authorizer, {
            workspaceId: ws,
            trackId,
            roleId: r.role_id,
            invitedBy: r.invited_by,
          }));
        return {
          id: r.id,
          email: r.email,
          role: { id: r.role_id, name: r.role_name },
          invitedBy: r.inviter_name,
          delivery: r.delivery,
          sendFailed: r.last_error !== null,
          lastSentAt: r.last_sent_at.toISOString(),
          expiresAt: r.expires_at.toISOString(),
          state: live ? ('open' as const) : ('lapsed' as const),
          external: isExternal(r.email, policy.organizationDomains),
        };
      }),
    );
    const given = await db
      .selectFrom('access_grant as g')
      .innerJoin('track as t', 't.access_policy_id', 'g.policy_id')
      .select('g.id')
      .where('t.id', '=', trackId)
      .where('g.permission', '=', 'invite_people')
      .limit(1)
      .executeTakeFirst();
    return {
      invitations,
      canInvite: await request.authz.can('invite_people', trackId),
      invitingGiven: given !== undefined,
      emailAvailable: (await mailReady()) !== null,
    };
  });

  /** Sends one at a time; a failure is kept on the invitation, never told about the address. */
  async function sendAll(
    request: FastifyRequest,
    track: { key: string; name: string },
    roleName: string,
    sends: readonly Send[],
    mail: { transport: MailTransport; from: string } | null,
  ): Promise<Set<string>> {
    const failed = new Set<string>();
    if (!mail) return failed;
    for (const send of sends) {
      const email = renderInvitationEmail(
        send.kind,
        {
          inviterName: request.user?.name ?? '',
          trackKey: track.key,
          trackName: track.name,
          roleName,
          url: send.url,
          expiresAt: send.expiresAt,
        },
        send.locale,
      );
      let error: string | null = null;
      try {
        await mail.transport.send({
          from: mail.from,
          to: send.to,
          subject: email.subject,
          text: email.text,
          html: email.html,
          headers: { 'Auto-Submitted': 'auto-generated' },
        });
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 500) : 'send failed';
        request.log.warn({ invitationId: send.invitationId }, 'invitation email failed');
        failed.add(send.to);
      }
      if (send.invitationId !== null) {
        await db
          .updateTable('track_invitation')
          .set({ last_error: error })
          .where('id', '=', send.invitationId)
          .execute();
      }
    }
    return failed;
  }

  /**
   * The account an address leads to. An active person gets a role at once; a deactivated person
   * or a service account gets nothing at all, no email either, and the inviter the same answer.
   */
  async function accountAt(
    trx: Transaction<Database>,
    workspaceId: number,
    email: string,
  ): Promise<{ person: { id: number; locale: string | null } | null; shut: boolean }> {
    const row = await trx
      .selectFrom('app_user')
      .select(['id', 'locale', 'deactivated_at', 'kind'])
      .where('workspace_id', '=', workspaceId)
      .where(sql<string>`lower(email)`, '=', email)
      .executeTakeFirst();
    if (!row) return { person: null, shut: false };
    if (row.deactivated_at || row.kind !== 'person') return { person: null, shut: true };
    return { person: { id: row.id, locale: row.locale }, shut: false };
  }

  async function giveRole(
    trx: Transaction<Database>,
    workspaceId: number,
    trackId: number,
    roleId: number,
    userId: number,
  ): Promise<boolean> {
    const added = await trx
      .insertInto('track_role_actor')
      .values({ workspace_id: workspaceId, track_id: trackId, role_id: roleId, user_id: userId })
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst();
    if (Number(added.numInsertedOrUpdatedRows ?? 0) > 0) return true;
    // A role only shared track groups held becomes the person's own (IAM-034).
    await keepRole(trx, trackId, roleId, userId);
    return false;
  }

  /** Takes `count` sends from the inviter's bucket; the wait in seconds when it is empty. */
  function inviterWait(userId: number, count: number): number | null {
    for (let i = 0; i < count; i++) {
      const taken = limiter.take(`invitations:by:${userId}`, INVITER_LIMITS);
      if (!taken.allowed) return taken.retryAfterSeconds;
    }
    return null;
  }

  const tooMany = (reply: FastifyReply, wait: number) =>
    reply
      .code(429)
      .header('retry-after', String(wait))
      .send({ error: 'too_many_invitations', retryAfterSeconds: wait });

  app.post('/api/v1/tracks/:id/invitations', async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    const parsed = inviteBody.safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    const body = parsed.data;
    if (body.addresses.length === 0 && body.userIds.length === 0) return invalid(reply);
    const trackId = params.data.id;
    const track = await invitingTrack(request, reply, trackId);
    if (!track) return reply;
    const user = request.user as NonNullable<typeof request.user>;
    const ws = request.workspaceId;
    const role = await db
      .selectFrom('role')
      .select(['id', 'name'])
      .where('id', '=', body.roleId)
      .where('workspace_id', '=', ws)
      .executeTakeFirst();
    if (!role) return reply.code(404).send({ error: 'not_found' });
    if (!(await mayGiveRole(db, request.authz, trackId, role.id))) return refuseRole(reply);
    if (body.createTracks) {
      if (!(await roleRunsTrack(db, trackId, role.id))) {
        return invalid(
          reply,
          'the permission to create tracks comes with a role that runs the track',
        );
      }
      if (!(await checkGivingCreateTracks(request, reply))) return reply;
    }
    const mail = await mailReady();
    if (body.delivery === 'email' && !mail) {
      return reply.code(409).send({ error: 'email_not_set_up' });
    }

    const seen = new Set<string>();
    const refused: Record<string, unknown>[] = [];
    const wanted: string[] = [];
    for (const raw of body.addresses) {
      const email = normalisedAddress(raw);
      if (!email) {
        refused.push({ email: raw.trim(), status: 'invalid' });
      } else if (!seen.has(email)) {
        seen.add(email);
        wanted.push(email);
      }
    }
    const picked = [...new Set(body.userIds)];
    const wait = inviterWait(user.id, wanted.length + picked.length);
    if (wait !== null) return tooMany(reply, wait);

    const policy = await readPolicy(db, ws);
    const sends: Send[] = [];
    const by = { workspaceId: ws, actorId: user.id };
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
    const results = await db.transaction().execute(async (trx) => {
      const done: Record<string, unknown>[] = [];
      for (const email of wanted) {
        if (!limiter.take(`invitations:to:${email}`, ADDRESS_LIMITS).allowed) {
          done.push({ email, status: 'too_many' });
          continue;
        }
        // An open invitation that ran out gives way to the new one.
        await trx
          .updateTable('track_invitation')
          .set({ revoked_at: now })
          .where('track_id', '=', trackId)
          .where('email', '=', email)
          .where('accepted_at', 'is', null)
          .where('revoked_at', 'is', null)
          .where('expires_at', '<=', now)
          .execute();
        const token = newToken();
        const made = await trx
          .insertInto('track_invitation')
          .values({
            workspace_id: ws,
            track_id: trackId,
            role_id: role.id,
            email,
            token_hash: tokenHash(token),
            invited_by: user.id,
            delivery: body.delivery,
            expires_at: expiresAt,
            grants_create_tracks: body.createTracks,
          })
          .onConflict((oc) =>
            oc
              .columns(['track_id', 'email'])
              .where('accepted_at', 'is', null)
              .where('revoked_at', 'is', null)
              .doNothing(),
          )
          .returning('id')
          .executeTakeFirst();
        if (!made) {
          done.push({ email, status: 'already_invited' });
          continue;
        }
        const { person, shut } = await accountAt(trx, ws, email);
        const added = person ? await giveRole(trx, ws, trackId, role.id, person.id) : false;
        let grantId: number | null = null;
        if (person && added) {
          await trx
            .updateTable('track_invitation')
            .set({ granted_user_id: person.id })
            .where('id', '=', made.id)
            .execute();
          // The permission goes with the role, at once too (IAM-033).
          if (body.createTracks) grantId = await giveCreateTracks(trx, ws, person.id);
        }
        // An existing person hears of it by email whichever way the inviter chose; a new one
        // gets an email only when the inviter asked for one. The answer below is the same.
        if (person) {
          sends.push({
            to: email,
            invitationId: made.id,
            kind: 'added',
            url: invitationUrl(publicUrl, token, true),
            expiresAt,
            locale: person.locale,
          });
        } else if (body.delivery === 'email' && !shut) {
          sends.push({
            to: email,
            invitationId: made.id,
            kind: 'invited',
            url: invitationUrl(publicUrl, token),
            expiresAt,
            locale: user.locale,
          });
        }
        await emit(trx, by, {
          type: 'track_invitation.created',
          subjectId: trackId,
          payload: {
            invitationId: made.id,
            roleId: role.id,
            email,
            delivery: body.delivery,
            grantedUserId: person && added ? person.id : null,
            createTracks: body.createTracks,
            ...(grantId !== null ? { createTracksGrantId: grantId } : {}),
          },
        });
        done.push({
          email,
          status: 'invited',
          invitationId: made.id,
          external: isExternal(email, policy.organizationDomains),
          ...(body.delivery === 'link' ? { link: invitationUrl(publicUrl, token) } : {}),
        });
      }
      // People picked by name: nothing to hide, and nothing waits for them.
      for (const userId of picked) {
        const person = await trx
          .selectFrom('app_user')
          .select(['id', 'email', 'name', 'locale'])
          .where('id', '=', userId)
          .where('workspace_id', '=', ws)
          .where('deactivated_at', 'is', null)
          .where('kind', '=', 'person')
          .executeTakeFirst();
        if (!person) {
          done.push({ userId, status: 'invalid' });
          continue;
        }
        const added = await giveRole(trx, ws, trackId, role.id, person.id);
        if (added) {
          const grantId = body.createTracks ? await giveCreateTracks(trx, ws, person.id) : null;
          await emit(trx, by, {
            type: 'track_role.actor_added',
            subjectId: trackId,
            payload: {
              roleId: role.id,
              userId: person.id,
              groupId: null,
              ...(grantId !== null ? { createTracksGrantId: grantId } : {}),
            },
          });
          sends.push({
            to: person.email,
            invitationId: null,
            kind: 'added',
            url: `${publicUrl.replace(/\/+$/, '')}/#/tracks/${encodeURIComponent(track.key)}`,
            expiresAt: null,
            locale: person.locale,
          });
        }
        done.push({ userId, name: person.name, status: added ? 'added' : 'already_holds' });
      }
      return done;
    });
    const failed = await sendAll(request, track, role.name, sends, mail);
    return reply.code(201).send({
      results: [...refused, ...results].map((r) =>
        // A new address and an existing one fail alike: both were to be mailed.
        body.delivery === 'email' && typeof r.email === 'string' && failed.has(r.email)
          ? { ...r, sendFailed: true }
          : r,
      ),
    });
  });

  app.post('/api/v1/tracks/:id/invitations/:invitationId/resend', async (request, reply) => {
    const params = z.object({ id, invitationId: id }).safeParse(request.params);
    const parsed = resendBody.safeParse(request.body ?? {});
    if (!params.success || !parsed.success) return invalid(reply);
    const { id: trackId, invitationId } = params.data;
    const track = await invitingTrack(request, reply, trackId);
    if (!track) return reply;
    const user = request.user as NonNullable<typeof request.user>;
    const ws = request.workspaceId;
    const row = await db
      .selectFrom('track_invitation as i')
      .innerJoin('role as r', 'r.id', 'i.role_id')
      .select(['i.id', 'i.email', 'i.role_id', 'i.grants_create_tracks', 'r.name as role_name'])
      .where('i.id', '=', invitationId)
      .where('i.track_id', '=', trackId)
      .where('i.workspace_id', '=', ws)
      .where('i.accepted_at', 'is', null)
      .where('i.revoked_at', 'is', null)
      .executeTakeFirst();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (!(await mayGiveRole(db, request.authz, trackId, row.role_id))) return refuseRole(reply);
    const mail = await mailReady();
    if (parsed.data.delivery === 'email' && !mail) {
      return reply.code(409).send({ error: 'email_not_set_up' });
    }
    const wait = inviterWait(user.id, 1);
    if (wait !== null) return tooMany(reply, wait);
    if (!limiter.take(`invitations:to:${row.email}`, ADDRESS_LIMITS).allowed) {
      return tooMany(reply, 3600);
    }
    const token = newToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
    const sends: Send[] = [];
    // A resend makes the invitation the sender's: they back the permission from now on.
    const createTracks =
      row.grants_create_tracks && (await inviterMayGiveCreateTracks(authorizer, ws, user.id));
    const found = await db.transaction().execute(async (trx) => {
      const { person, shut } = await accountAt(trx, ws, row.email);
      const added = person ? await giveRole(trx, ws, trackId, row.role_id, person.id) : false;
      const updated = await trx
        .updateTable('track_invitation')
        .set({
          token_hash: tokenHash(token),
          invited_by: user.id,
          delivery: parsed.data.delivery,
          last_sent_at: now,
          last_error: null,
          expires_at: expiresAt,
          ...(person && added ? { granted_user_id: person.id } : {}),
        })
        .where('id', '=', row.id)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!updated) return false;
      const grantId =
        person && added && createTracks ? await giveCreateTracks(trx, ws, person.id) : null;
      if (person) {
        sends.push({
          to: row.email,
          invitationId: row.id,
          kind: 'added',
          url: invitationUrl(publicUrl, token, true),
          expiresAt,
          locale: person.locale,
        });
      } else if (parsed.data.delivery === 'email' && !shut) {
        sends.push({
          to: row.email,
          invitationId: row.id,
          kind: 'invited',
          url: invitationUrl(publicUrl, token),
          expiresAt,
          locale: user.locale,
        });
      }
      await emit(
        trx,
        { workspaceId: ws, actorId: user.id },
        {
          type: 'track_invitation.resent',
          subjectId: trackId,
          payload: {
            invitationId: row.id,
            delivery: parsed.data.delivery,
            ...(grantId !== null ? { createTracksGrantId: grantId } : {}),
          },
        },
      );
      return true;
    });
    if (!found) return reply.code(404).send({ error: 'not_found' });
    const failed = await sendAll(request, track, row.role_name, sends, mail);
    return {
      status: 'invited',
      ...(parsed.data.delivery === 'email' && failed.has(row.email) ? { sendFailed: true } : {}),
      ...(parsed.data.delivery === 'link' ? { link: invitationUrl(publicUrl, token) } : {}),
    };
  });

  app.delete('/api/v1/tracks/:id/invitations/:invitationId', async (request, reply) => {
    const params = z.object({ id, invitationId: id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const { id: trackId, invitationId } = params.data;
    if (!(await invitingTrack(request, reply, trackId))) return reply;
    const ws = request.workspaceId;
    const row = await db
      .selectFrom('track_invitation')
      .select(['role_id', 'granted_user_id'])
      .where('id', '=', invitationId)
      .where('track_id', '=', trackId)
      .where('workspace_id', '=', ws)
      .where('accepted_at', 'is', null)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (!(await mayGiveRole(db, request.authz, trackId, row.role_id))) return refuseRole(reply);
    if (
      row.granted_user_id !== null &&
      (await roleRunsTrack(db, trackId, row.role_id)) &&
      !(await trackKeepsAdministrator(db, ws, trackId, {
        kind: 'actor',
        roleId: row.role_id,
        userId: row.granted_user_id,
        groupId: null,
      }))
    ) {
      return reply.code(409).send({ error: 'last_track_admin' });
    }
    const revoked = await db.transaction().execute(async (trx) => {
      const marked = await trx
        .updateTable('track_invitation')
        .set({ revoked_at: new Date() })
        .where('id', '=', invitationId)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!marked) return false;
      let roleRemoved = false;
      if (row.granted_user_id !== null) {
        const removed = await trx
          .deleteFrom('track_role_actor')
          .where('track_id', '=', trackId)
          .where('role_id', '=', row.role_id)
          .where('user_id', '=', row.granted_user_id)
          .executeTakeFirst();
        roleRemoved = Number(removed.numDeletedRows) > 0;
      }
      await emit(
        trx,
        { workspaceId: ws, actorId: request.user?.id ?? null },
        {
          type: 'track_invitation.revoked',
          subjectId: trackId,
          payload: { invitationId, roleRemoved },
        },
      );
      return true;
    });
    if (!revoked) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  // The invited person's side: the token is the proof, in the body so no log holds it.

  /** A live invitation for this token, still backed by someone who may invite. */
  async function findInvitation(request: FastifyRequest, token: string) {
    const row = await db
      .selectFrom('track_invitation as i')
      .innerJoin('track as t', 't.id', 'i.track_id')
      .innerJoin('role as r', 'r.id', 'i.role_id')
      .leftJoin('app_user as u', 'u.id', 'i.invited_by')
      .select([
        'i.id',
        'i.email',
        'i.track_id',
        'i.role_id',
        'i.invited_by',
        'i.expires_at',
        'i.grants_create_tracks',
        't.key as track_key',
        't.name as track_name',
        'r.name as role_name',
        'u.name as inviter_name',
      ])
      .where('i.token_hash', '=', tokenHash(token))
      .where('i.workspace_id', '=', request.workspaceId)
      .where('i.accepted_at', 'is', null)
      .where('i.revoked_at', 'is', null)
      .where('i.expires_at', '>', new Date())
      .where('t.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!row) return null;
    const backed = await inviterStillBacks(db, authorizer, {
      workspaceId: request.workspaceId,
      trackId: row.track_id,
      roleId: row.role_id,
      invitedBy: row.invited_by,
    });
    return backed ? row : null;
  }

  /**
   * Whether taking up an invitation also gives the permission to create tracks: it was asked
   * for, and whoever backs the invitation may still give it (IAM-033).
   */
  async function invitationGivesCreateTracks(
    workspaceId: number,
    row: { grants_create_tracks: boolean; invited_by: number | null },
  ): Promise<boolean> {
    if (!row.grants_create_tracks) return false;
    return inviterMayGiveCreateTracks(authorizer, workspaceId, row.invited_by);
  }

  async function throttled(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const until = await lockedUntil(db, request.workspaceId, [`ip:${request.ip}`]);
    if (!until) return false;
    const retryAfter = secondsUntil(until);
    await reply
      .code(429)
      .header('retry-after', String(retryAfter))
      .send({ error: 'too_many_attempts', retryAfterSeconds: retryAfter });
    return true;
  }

  async function invalidLink(request: FastifyRequest, reply: FastifyReply) {
    const lock = await recordFailure(db, request.workspaceId, { address: `ip:${request.ip}` });
    await recordRejectedLink(db, {
      workspaceId: request.workspaceId,
      ip: request.ip,
      lockedUntil: lock,
    });
    return reply.code(404).send({ error: 'invalid_link' });
  }

  app.post('/api/v1/invitations/inspect', async (request, reply) => {
    const parsed = tokenBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    if (await throttled(request, reply)) return reply;
    const row = await findInvitation(request, parsed.data.token);
    if (!row) return invalidLink(request, reply);
    const policy = await readPolicy(db, request.workspaceId);
    return {
      email: row.email,
      track: { key: row.track_key, name: row.track_name },
      roleName: row.role_name,
      invitedBy: row.inviter_name,
      expiresAt: row.expires_at.toISOString(),
      // From the address and the site's rules alone; it says nothing about an account.
      secondFactorRequired:
        policy.required === 'everyone' || isExternal(row.email, policy.organizationDomains),
    };
  });

  /**
   * Chooses a name and a password for a new account at the invited address, gives the role and
   * uses the link up. For an address that already has an account nothing changes and the link
   * stays open for `accept`, but the answer is the same; the person signs in next either way.
   */
  app.post('/api/v1/invitations/redeem', async (request, reply) => {
    const parsed = redeemBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    if (await throttled(request, reply)) return reply;
    const body = parsed.data;
    const row = await findInvitation(request, body.token);
    if (!row) return invalidLink(request, reply);
    const ws = request.workspaceId;
    const sso = await providerForDomain(db, ws, emailDomain(row.email));
    if (sso?.enforce_sso) {
      return reply.code(403).send({
        error: 'sso_required',
        provider: { id: sso.id, name: sso.name, protocol: sso.kind },
      });
    }
    if (body.locale !== undefined && !validLocale(body.locale)) return invalid(reply, 'locale');
    const problems = checkPassword(body.password, { identity: [row.email, body.name] });
    if (problems.length > 0) {
      return reply.code(400).send({
        error: 'weak_password',
        codes: problems,
        problems: problems.map((p) => `password: ${describePasswordProblem(p)}`),
      });
    }
    // Hashed whatever comes next, so the answer takes as long for either kind of address.
    const passwordHash = await options.passwords.hash(body.password);
    const createTracks = await invitationGivesCreateTracks(ws, row);
    const now = new Date();
    try {
      await db.transaction().execute(async (trx) => {
        const known = await trx
          .selectFrom('app_user')
          .select('id')
          .where('workspace_id', '=', ws)
          .where(sql<string>`lower(email)`, '=', row.email)
          .executeTakeFirst();
        if (known) return;
        const marked = await trx
          .updateTable('track_invitation')
          .set({ accepted_at: now })
          .where('id', '=', row.id)
          .where('accepted_at', 'is', null)
          .where('revoked_at', 'is', null)
          .returning('id')
          .executeTakeFirst();
        if (!marked) return;
        const person = await trx
          .insertInto('app_user')
          .values({
            workspace_id: ws,
            email: row.email,
            name: body.name,
            password_hash: passwordHash,
            password_changed_at: now,
            ...(body.locale ? { locale: Intl.getCanonicalLocales(body.locale)[0] ?? null } : {}),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await giveRole(trx, ws, row.track_id, row.role_id, person.id);
        const grantId = createTracks ? await giveCreateTracks(trx, ws, person.id) : null;
        await emit(
          trx,
          { workspaceId: ws, actorId: person.id },
          {
            type: 'track_invitation.accepted',
            subjectId: row.track_id,
            payload: {
              invitationId: row.id,
              roleId: row.role_id,
              userId: person.id,
              accountCreated: true,
              ...(grantId !== null ? { createTracksGrantId: grantId } : {}),
            },
          },
        );
      });
    } catch (error) {
      // Someone made the account at this very moment: the same as an account that was there.
      if (!isUniqueViolation(error)) throw error;
    }
    return { status: 'ready', email: row.email, track: { key: row.track_key } };
  });

  /** A signed-in person takes up an invitation for their own address. */
  app.post('/api/v1/invitations/accept', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = tokenBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    if (await throttled(request, reply)) return reply;
    const row = await findInvitation(request, parsed.data.token);
    if (!row) return invalidLink(request, reply);
    if (user.email.toLowerCase() !== row.email) {
      return reply.code(403).send({ error: 'other_account', email: row.email });
    }
    const ws = request.workspaceId;
    const createTracks = await invitationGivesCreateTracks(ws, row);
    const accepted = await db.transaction().execute(async (trx) => {
      const marked = await trx
        .updateTable('track_invitation')
        .set({ accepted_at: new Date() })
        .where('id', '=', row.id)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!marked) return false;
      // A role given when the invitation was made already brought its grant then.
      const added = await giveRole(trx, ws, row.track_id, row.role_id, user.id);
      const grantId = added && createTracks ? await giveCreateTracks(trx, ws, user.id) : null;
      await emit(
        trx,
        { workspaceId: ws, actorId: user.id },
        {
          type: 'track_invitation.accepted',
          subjectId: row.track_id,
          payload: {
            invitationId: row.id,
            roleId: row.role_id,
            userId: user.id,
            accountCreated: false,
            ...(grantId !== null ? { createTracksGrantId: grantId } : {}),
          },
        },
      );
      return true;
    });
    if (!accepted) return invalidLink(request, reply);
    return { track: { id: row.track_id, key: row.track_key } };
  });
}

/**
 * Whether a live invitation lets a provider's sign-in make an account where the provider itself
 * would not (`jit` off): the address is verified by then, and someone who may invite asked for
 * this person. A provider still serves only its own domains (`completeSsoSignIn`).
 */
export async function invitationOpensAccount(
  db: Kysely<Database>,
  authorizer: Authorizer,
  workspaceId: number,
  email: string,
): Promise<boolean> {
  const rows = await db
    .selectFrom('track_invitation')
    .select(['track_id', 'role_id', 'invited_by'])
    .where('workspace_id', '=', workspaceId)
    .where('email', '=', email.toLowerCase())
    .where('accepted_at', 'is', null)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', new Date())
    .execute();
  for (const row of rows) {
    const backed = await inviterStillBacks(db, authorizer, {
      workspaceId,
      trackId: row.track_id,
      roleId: row.role_id,
      invitedBy: row.invited_by,
    });
    if (backed) return true;
  }
  return false;
}
