import type { Database } from '@taskmoor/db';
import { checkPassword, describePasswordProblem, type PasswordHasher } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { DEFAULT_STORAGE_QUOTA } from '../attachments/quota';
import { DEFAULT_MAX_FILE_SIZE } from '../attachments/records';
import { startSession } from '../auth';
import { emit } from '../events/bus';
import {
  INSTANCE_KEY,
  SETUP_KEY,
  SETUP_TOKEN_KEY,
  SMTP_KEY,
  setupState,
  setupTokenIsValid,
  writeSetting,
} from '../setup';

const setupBody = z.object({
  token: z.string().min(1),
  instanceName: z.string().trim().min(1).max(100),
  admin: z.object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(320),
    password: z.string(),
  }),
  // Mail settings without the password: secrets come from the environment (OPS-004), the
  // wizard keeps configuration. The password is SMTP_PASSWORD on the backend.
  smtp: z
    .object({
      host: z.string().trim().min(1).max(253),
      port: z.coerce.number().int().min(1).max(65535).default(587),
      secure: z.boolean().default(false),
      user: z.string().trim().max(320).optional(),
      from: z.string().trim().email().max(320),
    })
    .optional(),
});

export type SetupBody = z.infer<typeof setupBody>;

/**
 * First-run setup (OPS-003, M0-027): one request, protected by the one-time token, creates the
 * first site administrator, records the instance name and optional mail settings, marks setup
 * complete and signs the admin in. A second request, with any token, is refused.
 */
export function registerSetupRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: { secureCookies: boolean; passwords: PasswordHasher },
): void {
  app.get('/api/v1/setup', async () => {
    const state = await setupState(db);
    return { needed: !state.completed };
  });

  app.post('/api/v1/setup', async (request, reply) => {
    const parsed = setupBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const body = parsed.data;
    const problems = checkPassword(body.admin.password, {
      identity: [body.admin.email, body.admin.name],
    });
    if (problems.length > 0) {
      return reply.code(400).send({
        error: 'weak_password',
        codes: problems,
        problems: problems.map((p) => `admin.password: ${describePasswordProblem(p)}`),
      });
    }
    if ((await setupState(db)).completed) {
      return reply.code(409).send({ error: 'setup_completed' });
    }
    if (!(await setupTokenIsValid(db, body.token))) {
      return reply.code(403).send({ error: 'invalid_setup_token' });
    }

    const passwordHash = await options.passwords.hash(body.admin.password);
    const user = await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto('app_user')
        .values({
          workspace_id: request.workspaceId,
          email: body.admin.email.toLowerCase(),
          name: body.admin.name,
          password_hash: passwordHash,
          password_changed_at: new Date(),
          is_site_admin: true,
        })
        .returning(['id', 'email', 'name', 'time_zone', 'locale'])
        .executeTakeFirstOrThrow();
      await writeSetting(trx, INSTANCE_KEY, { name: body.instanceName });
      if (body.smtp) await writeSetting(trx, SMTP_KEY, body.smtp);
      await writeSetting(trx, SETUP_KEY, {
        completed: true,
        completedAt: new Date().toISOString(),
      });
      // The token has done its one job.
      await trx.deleteFrom('instance_setting').where('key', '=', SETUP_TOKEN_KEY).execute();
      // Site administrators sign in with a second factor from the start (the user's decision of
      // 2026-11-01; ASVS 4.3.1): the administrator enrols at their next sign-in, and the
      // Security page can change it. A workspace that already has a policy keeps it.
      await trx
        .insertInto('two_factor_policy')
        .values({ workspace_id: request.workspaceId, required: 'site_admins' })
        .onConflict((oc) => oc.column('workspace_id').doNothing())
        .execute();
      // Storage quotas start generous on a new workspace (CORE-021, the user's decision of
      // 2026-11-02): 1 TiB in all, 20 GiB a person; the guardrails page changes them.
      await trx
        .insertInto('attachment_setting')
        .values({
          workspace_id: request.workspaceId,
          max_file_size: DEFAULT_MAX_FILE_SIZE,
          workspace_quota: DEFAULT_STORAGE_QUOTA.workspace,
          person_quota: DEFAULT_STORAGE_QUOTA.person,
        })
        // The workspace's row may exist already (its file size limit); quotas an earlier setup
        // attempt or an administrator chose are kept.
        .onConflict((oc) =>
          oc.column('workspace_id').doUpdateSet({
            workspace_quota: sql`coalesce(attachment_setting.workspace_quota, excluded.workspace_quota)`,
            person_quota: sql`coalesce(attachment_setting.person_quota, excluded.person_quota)`,
          }),
        )
        .execute();
      await startSession(trx, request, reply, {
        userId: created.id,
        secure: options.secureCookies,
      });
      await emit(
        trx,
        { workspaceId: request.workspaceId, actorId: created.id },
        {
          type: 'setup.completed',
          subjectId: request.workspaceId,
          payload: { adminId: created.id, instanceName: body.instanceName },
        },
      );
      return created;
    });
    return reply.code(201).send({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isSiteAdmin: true,
        timeZone: user.time_zone,
        locale: user.locale,
        appearance: 'system',
      },
    });
  });
}
