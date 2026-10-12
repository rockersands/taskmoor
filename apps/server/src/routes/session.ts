import type { Database } from '@tracksmith/db';
import { verifyPassword } from '@tracksmith/iam';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { endSession, startSession } from '../auth';

const signInBody = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

/** Who am I, sign in, sign out: the cookie session of ADR-032 (same-site layout). */
export function registerSessionRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: { secureCookies: boolean },
): void {
  app.get('/api/v1/session', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'not_signed_in' });
    return { user: request.user };
  });

  app.post('/api/v1/session', async (request, reply) => {
    const parsed = signInBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { email, password } = parsed.data;
    const user = await db
      .selectFrom('app_user')
      .select(['id', 'email', 'name', 'password_hash', 'is_site_admin'])
      .where('email', '=', email.toLowerCase())
      .where('deactivated_at', 'is', null)
      .executeTakeFirst();
    // One answer for an unknown email and a wrong password, so accounts cannot be enumerated.
    const ok = user?.password_hash ? await verifyPassword(password, user.password_hash) : false;
    if (!user || !ok) return reply.code(401).send({ error: 'invalid_credentials' });
    await startSession(db, reply, user.id, { secure: options.secureCookies });
    return {
      user: { id: user.id, email: user.email, name: user.name, isSiteAdmin: user.is_site_admin },
    };
  });

  app.delete('/api/v1/session', async (request, reply) => {
    await endSession(db, request, reply);
    return reply.code(204).send();
  });
}
