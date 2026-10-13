import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { Database } from '@taskmoor/db';
import {
  generateTotpSecret,
  otpauthUri,
  type PasswordHasher,
  type PepperRing,
  sealSecret,
  throttleKeys,
  verifyTotp,
} from '@taskmoor/iam';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireSiteAdmin, requireUser, startSession } from '../auth';
import type { Authorizer } from '../authz/authorizer';
import { emit } from '../events/bus';
import { clearFailures, lockedUntil, recordFailure, secondsUntil } from '../throttle';
import {
  checkTotp,
  countChallengeFailure,
  endChallenge,
  findChallenge,
  hasSecondFactor,
  openSetup,
  readPolicy,
  removeSecondFactors,
  replaceRecoveryCodes,
  sealSetup,
  secondFactorRequired,
  twoFactorStatus,
  useRecoveryCode,
} from '../two-factor';

const ISSUER = 'Taskmoor';
const id = z.coerce.number().int().positive();
const challengeBody = z.object({ challenge: z.string().min(1).max(200) });
const secondFactorBody = z.discriminatedUnion('method', [
  z.object({
    challenge: z.string().min(1).max(200),
    method: z.literal('totp'),
    code: z.string().max(20),
  }),
  z.object({
    challenge: z.string().min(1).max(200),
    method: z.literal('recovery_code'),
    code: z.string().max(40),
  }),
  z.object({
    challenge: z.string().min(1).max(200),
    method: z.literal('webauthn'),
    response: z.record(z.string(), z.unknown()),
  }),
]);
const confirmTotpBody = z.object({
  setupToken: z.string().min(1).max(4000),
  code: z.string().max(20),
});
const passwordBody = z.object({ password: z.string().min(1).max(1024) });
const policyBody = z
  .object({
    required: z.enum(['none', 'site_admins', 'everyone']),
    groupIds: z.array(id).max(1000).default([]),
  })
  .strict();

export interface TwoFactorOptions {
  secureCookies: boolean;
  passwords: PasswordHasher;
  peppers: PepperRing | undefined;
  authorizer: Authorizer;
  publicUrl: string;
}

/**
 * Two-factor sign-in (M1-084, IAM-001). Sign-in with a second factor is a challenge started
 * by a correct password (routes/session.ts) and finished here; a person whom the policy
 * requires to use a second factor enrols during that challenge before the session starts.
 * Wrong second factors count against the account like wrong passwords, and against the
 * challenge (five tries).
 */
export function registerTwoFactorRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: TwoFactorOptions,
): void {
  const { peppers, passwords } = options;
  const site = new URL(options.publicUrl);
  const rpID = site.hostname;
  const origin = site.origin;

  async function userOf(userId: number) {
    return db
      .selectFrom('app_user')
      .select(['id', 'email', 'name', 'is_site_admin', 'time_zone', 'locale'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
  }

  const view = (u: Awaited<ReturnType<typeof userOf>>, isSiteAdmin: boolean) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    isSiteAdmin,
    timeZone: u.time_zone,
    locale: u.locale,
  });

  /** Answers 429 when the account or the address is locked; true when the caller stopped. */
  async function throttled(request: FastifyRequest, reply: FastifyReply, email: string) {
    const keys = throttleKeys(email, request.ip);
    const until = await lockedUntil(db, request.workspaceId, [keys.account, keys.address]);
    if (!until) return false;
    const retryAfter = secondsUntil(until);
    await reply
      .code(429)
      .header('retry-after', String(retryAfter))
      .send({ error: 'too_many_attempts', retryAfterSeconds: retryAfter });
    return true;
  }

  async function signedInAnswer(request: FastifyRequest, userId: number) {
    const user = await userOf(userId);
    const global = await options.authorizer.globalPermissions(request.workspaceId, userId);
    return view(user, global.has('site_admin'));
  }

  /** Re-authentication for changes to one's own factors (ASVS 3.7.1). */
  async function reauthenticated(
    request: FastifyRequest,
    reply: FastifyReply,
    userId: number,
    email: string,
  ) {
    const parsed = passwordBody.safeParse(request.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: 'invalid_request' });
      return false;
    }
    if (await throttled(request, reply, email)) return false;
    const row = await db
      .selectFrom('app_user')
      .select('password_hash')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    if (!row.password_hash || !(await passwords.verify(parsed.data.password, row.password_hash))) {
      await recordFailure(db, request.workspaceId, throttleKeys(email, request.ip));
      await reply.code(403).send({ error: 'wrong_password' });
      return false;
    }
    return true;
  }

  // ---- Sign-in: the second step ----

  app.post('/api/v1/session/second-factor/webauthn', async (request, reply) => {
    const parsed = challengeBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const challenge = await findChallenge(
      db,
      request.workspaceId,
      parsed.data.challenge,
      'second_factor',
    );
    if (!challenge) return reply.code(401).send({ error: 'invalid_challenge' });
    const keys = await db
      .selectFrom('webauthn_credential')
      .select(['credential_id', 'transports'])
      .where('user_id', '=', challenge.userId)
      .execute();
    if (keys.length === 0) return reply.code(409).send({ error: 'no_security_key' });
    const authOptions = await generateAuthenticationOptions({
      rpID,
      allowCredentials: keys.map((k) => ({
        id: k.credential_id,
        transports: k.transports as AuthenticatorTransportName[],
      })),
      userVerification: 'preferred',
    });
    await db
      .updateTable('sign_in_challenge')
      .set({ webauthn_challenge: authOptions.challenge })
      .where('id', '=', challenge.id)
      .execute();
    return { options: authOptions };
  });

  app.post('/api/v1/session/second-factor', async (request, reply) => {
    const parsed = secondFactorBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    const challenge = await findChallenge(db, ws, parsed.data.challenge, 'second_factor');
    if (!challenge) return reply.code(401).send({ error: 'invalid_challenge' });
    const user = await userOf(challenge.userId);
    if (await throttled(request, reply, user.email)) return reply;
    const keys = throttleKeys(user.email, request.ip);
    const body = parsed.data;

    const sessionId = await db.transaction().execute(async (trx) => {
      let ok = false;
      if (body.method === 'totp') ok = await checkTotp(trx, peppers, user.id, body.code);
      else if (body.method === 'recovery_code') ok = await useRecoveryCode(trx, user.id, body.code);
      else ok = await checkSecurityKey(trx, user.id, challenge.webauthnChallenge, body.response);
      if (!ok) return null;
      await endChallenge(trx, challenge.id);
      await trx
        .updateTable('app_user')
        .set({ last_sign_in_at: new Date() })
        .where('id', '=', user.id)
        .execute();
      const started = await startSession(trx, request, reply, {
        userId: user.id,
        secure: options.secureCookies,
      });
      await emit(
        trx,
        { workspaceId: ws, actorId: user.id },
        {
          type: 'session.started',
          subjectId: user.id,
          payload: { sessionId: started, method: body.method },
        },
      );
      return started;
    });
    if (sessionId === null) {
      await countChallengeFailure(db, challenge.id);
      await recordFailure(db, ws, keys);
      return reply.code(401).send({ error: 'invalid_second_factor' });
    }
    await clearFailures(db, ws, keys.account);
    return { status: 'signed_in', user: await signedInAnswer(request, user.id) };
  });

  async function checkSecurityKey(
    trx: Parameters<typeof checkTotp>[0],
    userId: number,
    expectedChallenge: string | null,
    response: Record<string, unknown>,
  ): Promise<boolean> {
    if (!expectedChallenge) return false;
    const credentialId = typeof response.id === 'string' ? response.id : '';
    const key = await trx
      .selectFrom('webauthn_credential')
      .select(['id', 'credential_id', 'public_key', 'counter', 'transports'])
      .where('user_id', '=', userId)
      .where('credential_id', '=', credentialId)
      .forUpdate()
      .executeTakeFirst();
    if (!key) return false;
    try {
      const result = await verifyAuthenticationResponse({
        response: response as unknown as AuthenticationResponseJSON,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: key.credential_id,
          publicKey: new Uint8Array(Buffer.from(key.public_key, 'base64url')),
          counter: Number(key.counter),
          transports: key.transports as AuthenticatorTransportName[],
        },
        requireUserVerification: false,
      });
      if (!result.verified) return false;
      await trx
        .updateTable('webauthn_credential')
        .set({ counter: result.authenticationInfo.newCounter, last_used_at: new Date() })
        .where('id', '=', key.id)
        .execute();
      return true;
    } catch {
      return false;
    }
  }

  // ---- Sign-in: enrolment the policy requires ----

  app.post('/api/v1/session/enroll/totp', async (request, reply) => {
    const parsed = challengeBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const challenge = await findChallenge(
      db,
      request.workspaceId,
      parsed.data.challenge,
      'enrollment',
    );
    if (!challenge) return reply.code(401).send({ error: 'invalid_challenge' });
    const user = await userOf(challenge.userId);
    const secret = generateTotpSecret();
    return {
      secret,
      uri: otpauthUri(ISSUER, user.email, secret),
      setupToken: sealSetup(peppers, { userId: user.id, kind: 'totp', secret }),
    };
  });

  app.post('/api/v1/session/enroll/totp/confirm', async (request, reply) => {
    const parsed = challengeBody.merge(confirmTotpBody).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    const challenge = await findChallenge(db, ws, parsed.data.challenge, 'enrollment');
    if (!challenge) return reply.code(401).send({ error: 'invalid_challenge' });
    const user = await userOf(challenge.userId);
    if (await throttled(request, reply, user.email)) return reply;
    const secret = openSetup(peppers, parsed.data.setupToken, { userId: user.id, kind: 'totp' });
    const step = secret ? verifyTotp(secret, parsed.data.code, new Date()) : null;
    if (!secret || step === null) {
      await countChallengeFailure(db, challenge.id);
      await recordFailure(db, ws, throttleKeys(user.email, request.ip));
      return reply.code(401).send({ error: 'invalid_second_factor' });
    }
    const result = await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('totp_credential')
        .values({
          user_id: user.id,
          workspace_id: ws,
          secret_sealed: sealSecret(secret, peppers?.active),
          last_step: String(step),
        })
        .onConflict((oc) =>
          oc.column('user_id').doUpdateSet({
            secret_sealed: sealSecret(secret, peppers?.active),
            last_step: String(step),
          }),
        )
        .execute();
      const recoveryCodes = await replaceRecoveryCodes(trx, ws, user.id);
      await endChallenge(trx, challenge.id);
      await trx
        .updateTable('app_user')
        .set({ last_sign_in_at: new Date() })
        .where('id', '=', user.id)
        .execute();
      const sessionId = await startSession(trx, request, reply, {
        userId: user.id,
        secure: options.secureCookies,
      });
      await emit(
        trx,
        { workspaceId: ws, actorId: user.id },
        {
          type: 'user.two_factor_enabled',
          subjectId: user.id,
          payload: { method: 'totp', sessionId },
        },
      );
      return { recoveryCodes };
    });
    await clearFailures(db, ws, throttleKeys(user.email, request.ip).account);
    return {
      status: 'signed_in',
      user: await signedInAnswer(request, user.id),
      recoveryCodes: result.recoveryCodes,
    };
  });

  // ---- The signed-in person's own factors ----

  app.get('/api/v1/account/two-factor', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const [status, keys, required] = await Promise.all([
      twoFactorStatus(db, user.id),
      db
        .selectFrom('webauthn_credential')
        .select(['id', 'name', 'created_at', 'last_used_at'])
        .where('user_id', '=', user.id)
        .orderBy('created_at')
        .execute(),
      secondFactorRequired(db, options.authorizer, request.workspaceId, user.id),
    ]);
    return {
      totp: status.totp,
      securityKeys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        createdAt: k.created_at.toISOString(),
        lastUsedAt: k.last_used_at?.toISOString() ?? null,
      })),
      recoveryRemaining: status.recoveryRemaining,
      required,
    };
  });

  app.post('/api/v1/account/two-factor/totp', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const secret = generateTotpSecret();
    return {
      secret,
      uri: otpauthUri(ISSUER, user.email, secret),
      setupToken: sealSetup(peppers, { userId: user.id, kind: 'totp', secret }),
    };
  });

  app.post('/api/v1/account/two-factor/totp/confirm', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = confirmTotpBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const secret = openSetup(peppers, parsed.data.setupToken, { userId: user.id, kind: 'totp' });
    if (!secret) return reply.code(400).send({ error: 'setup_expired' });
    const step = verifyTotp(secret, parsed.data.code, new Date());
    if (step === null) return reply.code(400).send({ error: 'invalid_code' });
    const ws = request.workspaceId;
    const recoveryCodes = await db.transaction().execute(async (trx) => {
      const before = await twoFactorStatus(trx, user.id);
      await trx
        .insertInto('totp_credential')
        .values({
          user_id: user.id,
          workspace_id: ws,
          secret_sealed: sealSecret(secret, peppers?.active),
          last_step: String(step),
        })
        .onConflict((oc) =>
          oc.column('user_id').doUpdateSet({
            secret_sealed: sealSecret(secret, peppers?.active),
            last_step: String(step),
          }),
        )
        .execute();
      // The first factor comes with recovery codes; later ones keep the existing codes.
      const codes = hasSecondFactor(before) ? null : await replaceRecoveryCodes(trx, ws, user.id);
      await emit(
        trx,
        { workspaceId: ws, actorId: user.id },
        {
          type: 'user.two_factor_enabled',
          subjectId: user.id,
          payload: { method: 'totp', sessionId: null },
        },
      );
      return codes;
    });
    return reply.code(201).send({ recoveryCodes });
  });

  app.post('/api/v1/account/two-factor/totp/disable', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    if (!(await reauthenticated(request, reply, user.id, user.email))) return reply;
    const status = await twoFactorStatus(db, user.id);
    if (!status.totp) return reply.code(404).send({ error: 'not_found' });
    if (
      status.webauthn === 0 &&
      (await secondFactorRequired(db, options.authorizer, request.workspaceId, user.id))
    ) {
      return reply.code(409).send({ error: 'two_factor_required' });
    }
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('totp_credential').where('user_id', '=', user.id).execute();
      if (status.webauthn === 0)
        await trx.deleteFrom('recovery_code').where('user_id', '=', user.id).execute();
      await emit(
        trx,
        { workspaceId: request.workspaceId, actorId: user.id },
        { type: 'user.two_factor_disabled', subjectId: user.id, payload: { method: 'totp' } },
      );
    });
    return reply.code(204).send();
  });

  app.post('/api/v1/account/two-factor/webauthn/options', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const existing = await db
      .selectFrom('webauthn_credential')
      .select(['credential_id', 'transports'])
      .where('user_id', '=', user.id)
      .execute();
    const registration = await generateRegistrationOptions({
      rpName: ISSUER,
      rpID,
      userName: user.email,
      userDisplayName: user.name,
      userID: new TextEncoder().encode(`taskmoor-user-${user.id}`),
      attestationType: 'none',
      excludeCredentials: existing.map((k) => ({
        id: k.credential_id,
        transports: k.transports as AuthenticatorTransportName[],
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    return {
      options: registration,
      registrationToken: sealSetup(peppers, {
        userId: user.id,
        kind: 'webauthn',
        secret: registration.challenge,
      }),
    };
  });

  app.post('/api/v1/account/two-factor/webauthn', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = z
      .object({
        registrationToken: z.string().min(1).max(4000),
        name: z.string().trim().min(1).max(100),
        response: z.record(z.string(), z.unknown()),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const challenge = openSetup(peppers, parsed.data.registrationToken, {
      userId: user.id,
      kind: 'webauthn',
    });
    if (!challenge) return reply.code(400).send({ error: 'setup_expired' });
    let info: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      info = await verifyRegistrationResponse({
        response: parsed.data.response as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
      });
    } catch {
      return reply.code(400).send({ error: 'invalid_registration' });
    }
    if (!info.verified) return reply.code(400).send({ error: 'invalid_registration' });
    const credential = info.registrationInfo.credential;
    const ws = request.workspaceId;
    const result = await db.transaction().execute(async (trx) => {
      const before = await twoFactorStatus(trx, user.id);
      const row = await trx
        .insertInto('webauthn_credential')
        .values({
          workspace_id: ws,
          user_id: user.id,
          credential_id: credential.id,
          public_key: Buffer.from(credential.publicKey).toString('base64url'),
          counter: credential.counter,
          transports: credential.transports ?? [],
          name: parsed.data.name,
        })
        .returning(['id', 'name', 'created_at'])
        .executeTakeFirstOrThrow();
      const codes = hasSecondFactor(before) ? null : await replaceRecoveryCodes(trx, ws, user.id);
      await emit(
        trx,
        { workspaceId: ws, actorId: user.id },
        {
          type: 'user.two_factor_enabled',
          subjectId: user.id,
          payload: { method: 'webauthn', sessionId: null },
        },
      );
      return { row, codes };
    });
    return reply.code(201).send({
      securityKey: {
        id: result.row.id,
        name: result.row.name,
        createdAt: result.row.created_at.toISOString(),
      },
      recoveryCodes: result.codes,
    });
  });

  app.post('/api/v1/account/two-factor/webauthn/:id/remove', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    if (!(await reauthenticated(request, reply, user.id, user.email))) return reply;
    const status = await twoFactorStatus(db, user.id);
    const last = !status.totp && status.webauthn === 1;
    if (
      last &&
      (await secondFactorRequired(db, options.authorizer, request.workspaceId, user.id))
    ) {
      return reply.code(409).send({ error: 'two_factor_required' });
    }
    const removed = await db.transaction().execute(async (trx) => {
      const result = await trx
        .deleteFrom('webauthn_credential')
        .where('id', '=', params.data.id)
        .where('user_id', '=', user.id)
        .executeTakeFirst();
      if (Number(result.numDeletedRows) === 0) return false;
      if (last) await trx.deleteFrom('recovery_code').where('user_id', '=', user.id).execute();
      await emit(
        trx,
        { workspaceId: request.workspaceId, actorId: user.id },
        { type: 'user.two_factor_disabled', subjectId: user.id, payload: { method: 'webauthn' } },
      );
      return true;
    });
    if (!removed) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  app.post('/api/v1/account/two-factor/recovery-codes', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    if (!(await reauthenticated(request, reply, user.id, user.email))) return reply;
    if (!hasSecondFactor(await twoFactorStatus(db, user.id))) {
      return reply.code(409).send({ error: 'no_second_factor' });
    }
    const recoveryCodes = await db.transaction().execute(async (trx) => {
      const codes = await replaceRecoveryCodes(trx, request.workspaceId, user.id);
      await emit(
        trx,
        { workspaceId: request.workspaceId, actorId: user.id },
        { type: 'user.recovery_codes_regenerated', subjectId: user.id, payload: {} },
      );
      return codes;
    });
    return reply.code(201).send({ recoveryCodes });
  });

  // ---- Administration ----

  app.post('/api/v1/users/:id/two-factor/reset', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const target = await db
      .selectFrom('app_user')
      .select('id')
      .where('id', '=', params.data.id)
      .where('workspace_id', '=', request.workspaceId)
      .executeTakeFirst();
    if (!target) return reply.code(404).send({ error: 'not_found' });
    await db.transaction().execute(async (trx) => {
      await removeSecondFactors(trx, target.id);
      await emit(
        trx,
        { workspaceId: request.workspaceId, actorId: admin.id },
        { type: 'user.two_factor_reset', subjectId: target.id, payload: {} },
      );
    });
    return reply.code(204).send();
  });

  app.get('/api/v1/security/two-factor', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    return readPolicy(db, request.workspaceId);
  });

  app.put('/api/v1/security/two-factor', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = policyBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    const groupIds = [...new Set(parsed.data.groupIds)].sort((a, b) => a - b);
    if (groupIds.length > 0) {
      const found = await db
        .selectFrom('user_group')
        .select('id')
        .where('workspace_id', '=', ws)
        .where('id', 'in', groupIds)
        .execute();
      if (found.length !== groupIds.length) return reply.code(404).send({ error: 'not_found' });
    }
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('two_factor_policy')
        .values({ workspace_id: ws, required: parsed.data.required, updated_at: new Date() })
        .onConflict((oc) =>
          oc
            .column('workspace_id')
            .doUpdateSet({ required: parsed.data.required, updated_at: new Date() }),
        )
        .execute();
      await trx.deleteFrom('two_factor_policy_group').where('workspace_id', '=', ws).execute();
      if (groupIds.length > 0) {
        await trx
          .insertInto('two_factor_policy_group')
          .values(groupIds.map((g) => ({ workspace_id: ws, group_id: g })))
          .execute();
      }
      await emit(
        trx,
        { workspaceId: ws, actorId: admin.id },
        {
          type: 'two_factor_policy.updated',
          subjectId: ws,
          payload: { required: parsed.data.required, groupIds },
        },
      );
    });
    return { required: parsed.data.required, groupIds };
  });
}

type AuthenticatorTransportName =
  | 'ble'
  | 'cable'
  | 'hybrid'
  | 'internal'
  | 'nfc'
  | 'smart-card'
  | 'usb';
