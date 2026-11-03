import type { Database } from '@taskmoor/db';
import { checkPassword, describePasswordProblem, type PasswordHasher } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { requireGlobal, requireSiteAdmin, revokeUserSessions } from '../auth';
import {
  activeAdminCount,
  canonicalTimeZone,
  createPasswordLink,
  effectiveGroupIds,
  passwordLinkUrl,
  toUserView,
  USER_COLUMNS,
  validLocale,
  validTimeZone,
} from '../directory';
import { diff, emit } from '../events/bus';
import {
  type DirectoryGateway,
  directoryFailure,
  directoryManaged,
  readOnly,
} from '../ldap/gateway';

const listQuery = z.object({
  query: z.string().trim().max(200).optional(),
  status: z.enum(['active', 'deactivated', 'all']).default('active'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const lookupQuery = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(8),
});

const createBody = z
  .object({
    email: z.string().trim().email().max(320),
    name: z.string().trim().min(1).max(200),
    isSiteAdmin: z.boolean().default(false),
    /** Without a password the response carries a one-time activation link instead. */
    password: z.string().max(1024).optional(),
    timeZone: z.string().trim().min(1).max(64).optional(),
    locale: z.string().trim().min(2).max(35).optional(),
  })
  .strict();

const updateBody = z
  .object({
    email: z.string().trim().email().max(320).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    isSiteAdmin: z.boolean().optional(),
    breakGlass: z.boolean().optional(),
    timeZone: z.string().trim().min(1).max(64).nullable().optional(),
    locale: z.string().trim().min(2).max(35).nullable().optional(),
  })
  .strict();

const idParams = z.object({ id: z.coerce.number().int().positive() });

/** Postgres unique_violation: the email is taken in this workspace. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === '23505';
}

/**
 * User administration for site administrators (IAM-008): list and search, create, edit,
 * deactivate and reactivate, one-time password links, and signing a person out everywhere.
 * Deactivation keeps the row, so everything the person did stays attributed to them. The last
 * active site administrator can be neither demoted nor deactivated.
 */
export function registerUserRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: { publicUrl: string; passwords: PasswordHasher; directories: DirectoryGateway },
): void {
  app.get('/api/v1/users', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { query, status, limit, offset } = parsed.data;
    let base = db
      .selectFrom('app_user')
      .where('workspace_id', '=', request.workspaceId)
      // Service accounts are not users (IAM-007): they have their own list.
      .where('kind', '=', 'person');
    if (status === 'active') base = base.where('deactivated_at', 'is', null);
    if (status === 'deactivated') base = base.where('deactivated_at', 'is not', null);
    if (query) {
      const like = `%${query.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      base = base.where((eb) =>
        eb.or([eb(sql`lower(name)`, 'like', like), eb(sql`lower(email)`, 'like', like)]),
      );
    }
    const [rows, total] = await Promise.all([
      base
        .select([...USER_COLUMNS])
        .orderBy(sql`lower(name)`)
        .orderBy('id')
        .limit(limit)
        .offset(offset)
        .execute(),
      base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { users: rows.map(toUserView), total: Number(total.n) };
  });

  // Finding someone to give a track's role to (ADR-114): a name and an id, nothing else, for those
  // who set tracks up. The list above, with addresses and account details, stays with site
  // administrators.
  app.get('/api/v1/people/lookup', async (request, reply) => {
    if (!(await requireGlobal(request, reply, 'site_admin', 'configuration_admin'))) return reply;
    const parsed = lookupQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const text = parsed.data.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
    const people = await db
      .selectFrom('app_user')
      .select(['id', 'name'])
      .where('workspace_id', '=', request.workspaceId)
      .where('deactivated_at', 'is', null)
      .where('kind', '=', 'person')
      .where((eb) =>
        eb.or([
          sql<boolean>`lower(name) LIKE ${`%${text}%`}`,
          sql<boolean>`lower(email) LIKE ${`${text}%`}`,
        ]),
      )
      .orderBy(sql`lower(name)`)
      .orderBy('id')
      .limit(parsed.data.limit)
      .execute();
    return { people };
  });

  app.post('/api/v1/users', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const body = parsed.data;
    if (body.timeZone && !validTimeZone(body.timeZone)) {
      return reply.code(400).send({ error: 'invalid_time_zone' });
    }
    if (body.locale && !validLocale(body.locale)) {
      return reply.code(400).send({ error: 'invalid_locale' });
    }
    if (body.password !== undefined) {
      const problems = checkPassword(body.password, { identity: [body.email, body.name] });
      if (problems.length > 0) {
        return reply.code(400).send({
          error: 'weak_password',
          codes: problems,
          problems: problems.map((p) => `password: ${describePasswordProblem(p)}`),
        });
      }
    }
    const passwordHash =
      body.password !== undefined ? await options.passwords.hash(body.password) : null;
    try {
      const result = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('app_user')
          .values({
            workspace_id: request.workspaceId,
            email: body.email.toLowerCase(),
            name: body.name,
            is_site_admin: body.isSiteAdmin,
            password_hash: passwordHash,
            password_changed_at: passwordHash ? new Date() : null,
            time_zone: body.timeZone ? canonicalTimeZone(body.timeZone) : null,
            locale: body.locale ? (Intl.getCanonicalLocales(body.locale)[0] ?? null) : null,
          })
          .returning([...USER_COLUMNS])
          .executeTakeFirstOrThrow();
        const link = passwordHash
          ? null
          : await createPasswordLink(trx, {
              workspaceId: request.workspaceId,
              userId: row.id,
              purpose: 'activate',
              createdBy: admin.id,
            });
        await emit(
          trx,
          { workspaceId: request.workspaceId, actorId: admin.id },
          {
            type: 'user.created',
            subjectId: row.id,
            payload: {
              email: row.email,
              name: row.name,
              isSiteAdmin: row.is_site_admin,
              activationLink: link !== null,
            },
          },
        );
        return { row, link };
      });
      return reply.code(201).send({
        user: toUserView(result.row),
        ...(result.link
          ? {
              activationLink: passwordLinkUrl(options.publicUrl, result.link.token),
              activationLinkExpiresAt: result.link.expiresAt.toISOString(),
            }
          : {}),
      });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'email_taken' });
      throw error;
    }
  });

  app.get('/api/v1/users/:id', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const row = await db
      .selectFrom('app_user')
      .select([...USER_COLUMNS])
      .where('id', '=', parsed.data.id)
      .where('workspace_id', '=', request.workspaceId)
      .where('kind', '=', 'person')
      .executeTakeFirst();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const direct = await db
      .selectFrom('group_member as m')
      .innerJoin('user_group as g', 'g.id', 'm.group_id')
      .select(['g.id', 'g.name'])
      .where('m.user_id', '=', row.id)
      .where('m.workspace_id', '=', request.workspaceId)
      .orderBy(sql`lower(g.name)`)
      .execute();
    const effective = await effectiveGroupIds(db, request.workspaceId, row.id);
    const managed = await options.directories.account(request.workspaceId, row.id);
    return {
      user: toUserView(row),
      groups: direct,
      effectiveGroupIds: effective,
      // M1-082: the directory that manages the account, if one does.
      directory: managed
        ? {
            id: managed.directory.id,
            name: managed.directory.name,
            dn: managed.dn,
            mode: managed.directory.mode,
          }
        : null,
    };
  });

  app.patch('/api/v1/users/:id', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = idParams.safeParse(request.params);
    const parsed = updateBody.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const body = parsed.data;
    if (body.timeZone && !validTimeZone(body.timeZone)) {
      return reply.code(400).send({ error: 'invalid_time_zone' });
    }
    if (body.locale && !validLocale(body.locale)) {
      return reply.code(400).send({ error: 'invalid_locale' });
    }
    // M1-082: a directory owns the name and address of the accounts it manages; a read-write
    // one takes changes made here. A break-glass account must not depend on a directory.
    const managed = await options.directories.account(request.workspaceId, params.data.id);
    if (managed) {
      if (body.breakGlass === true) return directoryManaged(reply, managed.directory);
      // Only values that change count: sending the current name or address back is fine.
      const current = await db
        .selectFrom('app_user')
        .select(['name', 'email'])
        .where('id', '=', managed.userId)
        .executeTakeFirstOrThrow();
      const profile = {
        ...(body.name !== undefined && body.name !== current.name ? { name: body.name } : {}),
        ...(body.email !== undefined && body.email.toLowerCase() !== current.email.toLowerCase()
          ? { email: body.email.toLowerCase() }
          : {}),
      };
      if (Object.keys(profile).length > 0) {
        if (readOnly(managed.directory.mode)) return directoryManaged(reply, managed.directory);
        if (profile.email !== undefined) {
          const holder = await db
            .selectFrom('app_user')
            .select('id')
            .where('workspace_id', '=', request.workspaceId)
            .where(sql<string>`lower(email)`, '=', profile.email)
            .where('id', '!=', managed.userId)
            .executeTakeFirst();
          if (holder) return reply.code(409).send({ error: 'email_taken' });
        }
        const failure = await options.directories.writeProfile(managed, profile);
        if (failure) return directoryFailure(reply, failure);
      }
    }
    try {
      const outcome = await db.transaction().execute(async (trx) => {
        const current = await trx
          .selectFrom('app_user')
          .select([
            'id',
            'email',
            'name',
            'is_site_admin',
            'break_glass',
            'time_zone',
            'locale',
            'deactivated_at',
            'erased_at',
          ])
          .where('id', '=', params.data.id)
          .where('workspace_id', '=', request.workspaceId)
          .where('kind', '=', 'person')
          .forUpdate()
          .executeTakeFirst();
        if (!current) return 'not_found' as const;
        // An erased account stays a placeholder (ADR-111).
        if (current.erased_at !== null) return 'erased' as const;
        const demoting = body.isSiteAdmin === false && current.is_site_admin;
        if (demoting && current.deactivated_at === null) {
          if ((await activeAdminCount(trx, request.workspaceId)) <= 1) return 'last_admin' as const;
        }
        const next = {
          ...(body.email !== undefined ? { email: body.email.toLowerCase() } : {}),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.isSiteAdmin !== undefined ? { isSiteAdmin: body.isSiteAdmin } : {}),
          ...(body.breakGlass !== undefined ? { breakGlass: body.breakGlass } : {}),
          ...(body.timeZone !== undefined
            ? { timeZone: body.timeZone ? canonicalTimeZone(body.timeZone) : null }
            : {}),
          ...(body.locale !== undefined
            ? { locale: body.locale ? (Intl.getCanonicalLocales(body.locale)[0] ?? null) : null }
            : {}),
        };
        const row = await trx
          .updateTable('app_user')
          .set({
            ...(next.email !== undefined ? { email: next.email } : {}),
            ...(next.name !== undefined ? { name: next.name } : {}),
            ...(next.isSiteAdmin !== undefined ? { is_site_admin: next.isSiteAdmin } : {}),
            ...(next.breakGlass !== undefined ? { break_glass: next.breakGlass } : {}),
            ...(next.timeZone !== undefined ? { time_zone: next.timeZone } : {}),
            ...(next.locale !== undefined ? { locale: next.locale } : {}),
            updated_at: new Date(),
          })
          .where('id', '=', current.id)
          .returning([...USER_COLUMNS])
          .executeTakeFirstOrThrow();
        const changes = diff(
          {
            email: current.email,
            name: current.name,
            isSiteAdmin: current.is_site_admin,
            breakGlass: current.break_glass,
            timeZone: current.time_zone,
            locale: current.locale,
          },
          next,
        );
        if (Object.keys(changes).length > 0) {
          await emit(
            trx,
            { workspaceId: request.workspaceId, actorId: admin.id },
            { type: 'user.updated', subjectId: current.id, payload: { changes } },
          );
        }
        return row;
      });
      if (outcome === 'not_found') return reply.code(404).send({ error: 'not_found' });
      if (outcome === 'last_admin') return reply.code(409).send({ error: 'last_admin' });
      if (outcome === 'erased') return reply.code(409).send({ error: 'erased' });
      return { user: toUserView(outcome) };
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'email_taken' });
      throw error;
    }
  });

  app.post('/api/v1/users/:id/deactivate', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    if (params.data.id === admin.id)
      return reply.code(409).send({ error: 'cannot_deactivate_self' });
    const outcome = await db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('app_user')
        .select(['id', 'is_site_admin', 'deactivated_at'])
        .where('id', '=', params.data.id)
        .where('workspace_id', '=', request.workspaceId)
        .where('kind', '=', 'person')
        .forUpdate()
        .executeTakeFirst();
      if (!current) return 'not_found' as const;
      if (current.is_site_admin && current.deactivated_at === null) {
        if ((await activeAdminCount(trx, request.workspaceId)) <= 1) return 'last_admin' as const;
      }
      const row = await trx
        .updateTable('app_user')
        .set((eb) => ({
          deactivated_at: eb.fn.coalesce('deactivated_at', sql<Date>`now()`),
          updated_at: new Date(),
        }))
        .where('id', '=', current.id)
        .returning([...USER_COLUMNS])
        .executeTakeFirstOrThrow();
      const ended = await trx
        .deleteFrom('user_session')
        .where('user_id', '=', current.id)
        .executeTakeFirst();
      await trx
        .deleteFrom('password_link')
        .where('user_id', '=', current.id)
        .where('used_at', 'is', null)
        .execute();
      if (current.deactivated_at === null) {
        await emit(
          trx,
          { workspaceId: request.workspaceId, actorId: admin.id },
          {
            type: 'user.deactivated',
            subjectId: current.id,
            payload: { endedSessions: Number(ended.numDeletedRows) },
          },
        );
      }
      return row;
    });
    if (outcome === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (outcome === 'last_admin') return reply.code(409).send({ error: 'last_admin' });
    return { user: toUserView(outcome) };
  });

  app.post('/api/v1/users/:id/reactivate', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const row = await db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom('app_user')
        .select(['deactivated_at', 'erased_at'])
        .where('id', '=', params.data.id)
        .where('workspace_id', '=', request.workspaceId)
        .where('kind', '=', 'person')
        .forUpdate()
        .executeTakeFirst();
      if (!before) return undefined;
      // An erased account never signs in again (ADR-111).
      if (before.erased_at !== null) return 'erased' as const;
      const updated = await trx
        .updateTable('app_user')
        .set({ deactivated_at: null, updated_at: new Date() })
        .where('id', '=', params.data.id)
        .returning([...USER_COLUMNS])
        .executeTakeFirstOrThrow();
      if (before.deactivated_at !== null) {
        await emit(
          trx,
          { workspaceId: request.workspaceId, actorId: admin.id },
          { type: 'user.reactivated', subjectId: updated.id, payload: {} },
        );
      }
      return updated;
    });
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row === 'erased') return reply.code(409).send({ error: 'erased' });
    return { user: toUserView(row) };
  });

  // A one-time link the administrator hands over (email delivery arrives with M1-057).
  app.post('/api/v1/users/:id/password-link', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const row = await db
      .selectFrom('app_user')
      .select(['id', 'password_hash', 'deactivated_at'])
      .where('id', '=', params.data.id)
      .where('workspace_id', '=', request.workspaceId)
      .where('kind', '=', 'person')
      .executeTakeFirst();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.deactivated_at) return reply.code(409).send({ error: 'user_deactivated' });
    // A directory checks this person's password (M1-082): a local one would never be asked for.
    const managed = await options.directories.account(request.workspaceId, row.id);
    if (managed) return directoryManaged(reply, managed.directory);
    const purpose = row.password_hash ? 'reset' : 'activate';
    const link = await db.transaction().execute(async (trx) => {
      const created = await createPasswordLink(trx, {
        workspaceId: request.workspaceId,
        userId: row.id,
        purpose,
        createdBy: admin.id,
      });
      await emit(
        trx,
        { workspaceId: request.workspaceId, actorId: admin.id },
        {
          type: 'user.password_link_created',
          subjectId: row.id,
          payload: { purpose, expiresAt: created.expiresAt.toISOString() },
        },
      );
      return created;
    });
    return reply.code(201).send({
      purpose,
      link: passwordLinkUrl(options.publicUrl, link.token),
      expiresAt: link.expiresAt.toISOString(),
    });
  });

  app.delete('/api/v1/users/:id/sessions', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const revoked = await db.transaction().execute(async (trx) => {
      const count = await revokeUserSessions(trx, request.workspaceId, params.data.id);
      if (count > 0) {
        await emit(
          trx,
          { workspaceId: request.workspaceId, actorId: admin.id },
          { type: 'session.revoked', subjectId: params.data.id, payload: { count, by: 'admin' } },
        );
      }
      return count;
    });
    return { revoked };
  });
}
