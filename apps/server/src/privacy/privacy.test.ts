import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { LocalStore, newObjectKey } from '@taskmoor/storage';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { buildApp } from '../app';
import { storesOf } from '../attachments/stores';
import { verifyChain } from '../audit/chain';
import { searchAudit } from '../audit/query';
import { SESSION_COOKIE } from '../auth';
import { Authorizer } from '../authz/authorizer';
import { EventBus } from '../events/bus';
import { JobRunner } from '../events/queue';
import { registerSubscribers } from '../events/subscribers';
import { erasedEmail, erasedName, registerEraseJobs } from './erase';
import { expirePersonalExports, registerPersonalExportJobs } from './export';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `198.51.100.${(++address % 250) + 1}`;

function sessionCookie(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    (
      list.find(
        (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
      ) ?? ''
    ).split(';')[0] ?? ''
  );
}

const mentionDoc = (id: number, label: string) => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Ask ' },
        { type: 'mention', attrs: { id: String(id), label } },
      ],
    },
  ],
});

async function unzip(body: Buffer): Promise<Record<string, Buffer>> {
  const zip = await yauzl.fromBufferPromise(body, { lazyEntries: true });
  const found: Record<string, Buffer> = {};
  for await (const entry of zip.eachEntry()) {
    const stream = await zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    found[entry.fileName] = Buffer.concat(chunks);
  }
  return found;
}
const lines = (file: Buffer | undefined) =>
  (file?.toString('utf8') ?? '')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('a person’s own data: download and erasure (ASVS 8.3.2, IAM-008)', () => {
  const database = useMigratedDatabase();
  const files = mkdtempSync(join(tmpdir(), 'taskmoor-privacy-'));
  let app: FastifyInstance;
  let store: LocalStore;
  const users: Record<string, { id: number; cookie: string }> = {};

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const post = (who: string, url: string, payload?: Record<string, unknown>) =>
    as(who, { method: 'POST', url, ...(payload ? { payload } : {}) });
  const get = (who: string, url: string) => as(who, { method: 'GET', url });
  const signIn = async (email: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email, password: PASSWORD },
      remoteAddress: nextAddress(),
    });

  /** The worker's part: events to their subscribers (audit), downloads and scrubs. */
  async function work(): Promise<void> {
    const bus = new EventBus(database.db);
    registerSubscribers(bus, { db: database.db });
    const runner = new JobRunner(database.db, 'privacy-test');
    bus.attach(runner);
    registerPersonalExportJobs(runner, database.db, storesOf(store), new Authorizer(database.db));
    registerEraseJobs(runner, database.db);
    for (let i = 0; i < 20; i++) {
      const relayed = await bus.relayOnce();
      const ran = await runner.runOnce();
      if (relayed === 0 && ran === 0) break;
    }
  }

  let track = 0;
  let hidden = 0;
  beforeAll(async () => {
    store = await LocalStore.open(files);
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      attachments: storesOf(store),
    });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['ada', true],
      ['kalo', false],
      ['mi', false],
      ['cy', false],
    ] as const) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name: `${name[0]?.toUpperCase()}${name.slice(1)} Example`,
          password_hash: hash,
          is_site_admin: admin,
          time_zone: 'Europe/Madrid',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      users[name] = { id: row.id, cookie: '' };
    }
    // Cy administers the site through a grant, not the account flag.
    await database.db
      .insertInto('global_grant')
      .values({
        workspace_id: 1,
        permission: 'site_admin',
        grantee: 'user',
        user_id: users.cy?.id as number,
      })
      .execute();
    for (const name of Object.keys(users)) {
      const res = await signIn(`${name}@example.com`);
      expect(res.statusCode, res.body).toBe(200);
      (users[name] as { cookie: string }).cookie = sessionCookie(res);
    }
    const roles = await database.db.selectFrom('role').select(['id', 'name']).execute();
    const members = roles.find((r) => r.name === 'Members')?.id as number;
    for (const [key, people] of [
      ['PRV', ['kalo', 'mi']],
      ['HID', ['mi']],
    ] as const) {
      const res = await post('ada', '/api/v1/tracks', { key, name: key, mode: 'shared' });
      expect(res.statusCode, res.body).toBe(201);
      const id = res.json().track.id as number;
      if (key === 'PRV') track = id;
      else hidden = id;
      for (const who of people) {
        await database.db
          .insertInto('track_role_actor')
          .values({
            workspace_id: 1,
            track_id: id,
            role_id: members,
            user_id: users[who]?.id as number,
          })
          .execute();
      }
    }
    expect(track).toBeGreaterThan(0);
    expect(hidden).toBeGreaterThan(0);
  });
  afterAll(async () => {
    await app.close();
    rmSync(files, { recursive: true, force: true });
  });

  it('[IAM-008] ASVS 8.3.2: a person downloads their own data from a background job', async () => {
    const kalo = users.kalo?.id as number;
    // Kalo reports a ticket, comments, logs time and uploads a file; Mi assigns one to Kalo in
    // a track Kalo cannot see.
    const mine = await post('kalo', '/api/v1/tickets', { track: 'PRV', summary: 'Printer jams' });
    expect(mine.statusCode, mine.body).toBe(201);
    const ticket = mine.json().ticket as { id: number; key: string };
    const comment = await post('kalo', `/api/v1/tickets/${ticket.id}/comments`, {
      body: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Third time today' }] }],
      },
    });
    expect(comment.statusCode, comment.body).toBe(201);
    await database.db
      .insertInto('time_entry')
      .values({
        workspace_id: 1,
        ticket_id: ticket.id,
        author_id: kalo,
        started_at: new Date('2026-11-01T09:00:00Z'),
        duration: 1800,
        description: 'Looked at the tray',
      })
      .execute();
    const key = newObjectKey(1);
    const bytes = Buffer.from('a photo of the tray');
    const put = await store.put(key, Readable.from([bytes]), { maxBytes: 1000 });
    await database.db
      .insertInto('attachment')
      .values({
        workspace_id: 1,
        ticket_id: ticket.id,
        name: 'tray ../photo.jpg',
        declared_type: 'image/jpeg',
        size: put.size,
        sha256: put.sha256,
        storage: 'local',
        storage_key: key,
        scan_state: 'clean',
        scanned_at: new Date(),
        author_id: kalo,
      })
      .execute();
    const secret = await post('mi', '/api/v1/tickets', {
      track: 'HID',
      summary: 'Restricted plan',
    });
    expect(secret.statusCode, secret.body).toBe(201);
    // Assigned to Kalo before Kalo lost access to the track.
    await database.db
      .updateTable('ticket')
      .set({ assignee_id: kalo })
      .where('id', '=', secret.json().ticket.id)
      .execute();
    await work();

    // [CORE-033] The checklist items they wrote travel with the rest of what they wrote.
    const checklist = await database.db
      .insertInto('ticket_checklist')
      .values({
        workspace_id: 1,
        ticket_id: ticket.id,
        name: 'Printer steps',
        position: 0,
        created_by: kalo,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('ticket_checklist_item')
      .values({
        workspace_id: 1,
        checklist_id: checklist.id,
        text: 'Open the tray',
        position: 0,
        created_by: kalo,
      })
      .execute();
    const asked = await post('kalo', '/api/v1/account/data-exports');
    expect(asked.statusCode, asked.body).toBe(202);
    const id = asked.json().export.id as string;
    expect(asked.json().export.state).toBe('queued');
    // One at a time.
    expect((await post('kalo', '/api/v1/account/data-exports')).json()).toEqual({
      error: 'export_in_progress',
    });
    const early = await get('kalo', `/api/v1/account/data-exports/${id}/download`);
    expect(early.statusCode).toBe(409);
    await work();

    const listed = (await get('kalo', '/api/v1/account/data-exports')).json().exports;
    expect(listed).toMatchObject([{ id, state: 'ready', requestedBy: kalo }]);
    expect(listed[0].expiresAt).not.toBeNull();
    const res = await get('kalo', `/api/v1/account/data-exports/${id}/download`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(String(res.headers['content-disposition'])).toMatch(
      new RegExp(
        `^attachment; filename="taskmoor-personal-data-${kalo}-\\d{4}-\\d{2}-\\d{2}\\.zip"$`,
      ),
    );
    const zip = await unzip(res.rawPayload);
    expect(Object.keys(zip)).toEqual([
      'profile.json',
      'preferences.json',
      'tickets.ndjson',
      'comments.ndjson',
      'checklist-items.ndjson',
      'time-entries.ndjson',
      'attachments.ndjson',
      expect.stringMatching(/^attachments\/\d+-tray_\.\._photo\.jpg$/),
      'audit.ndjson',
      'manifest.json',
    ]);
    const profile = JSON.parse(String(zip['profile.json']));
    expect(profile).toMatchObject({
      id: kalo,
      email: 'kalo@example.com',
      name: 'Kalo Example',
      timeZone: 'Europe/Madrid',
      hasPassword: true,
    });
    expect(profile.sessions.length).toBeGreaterThan(0);
    expect(JSON.stringify(profile)).not.toMatch(/password_hash|token_hash|scrypt/);
    const tickets = lines(zip['tickets.ndjson']);
    expect(tickets).toEqual([
      expect.objectContaining({
        key: ticket.key,
        summary: 'Printer jams',
        roles: ['requester', 'creator'],
      }),
      // Assigned in a track Kalo cannot see: the role, never the content.
      {
        id: secret.json().ticket.id,
        roles: ['assignee'],
        visible: false,
        createdAt: expect.any(String),
      },
    ]);
    expect(lines(zip['comments.ndjson'])).toMatchObject([
      { ticketKey: ticket.key, restricted: false },
    ]);
    expect(lines(zip['checklist-items.ndjson'])).toMatchObject([
      { ticketKey: ticket.key, checklist: 'Printer steps', text: 'Open the tray', state: 'open' },
    ]);
    expect(lines(zip['time-entries.ndjson'])).toMatchObject([
      { ticketKey: ticket.key, seconds: 1800, description: 'Looked at the tray' },
    ]);
    const [upload] = lines(zip['attachments.ndjson']);
    expect(upload).toMatchObject({ name: 'tray ../photo.jpg', bytes: bytes.length });
    expect(zip[String(upload?.file)]?.equals(bytes)).toBe(true);
    const audit = lines(zip['audit.ndjson']);
    expect(audit.map((r) => r.action)).toContain('session.started');
    expect(audit.every((r) => r.actorId === kalo || r.ip === null)).toBe(true);
    const manifest = JSON.parse(String(zip['manifest.json']));
    expect(manifest).toMatchObject({ format: 'taskmoor-personal-data', version: 1, person: kalo });
    expect(manifest.files.map((f: { name: string }) => f.name)).toEqual(
      Object.keys(zip).filter((n) => n !== 'manifest.json'),
    );
    // Someone else cannot fetch it, not even a site administrator.
    expect((await get('mi', `/api/v1/account/data-exports/${id}/download`)).statusCode).toBe(404);
    expect((await get('ada', `/api/v1/users/${kalo}/data-exports/${id}/download`)).statusCode).toBe(
      404,
    );
  });

  it('[IAM-008] ASVS 8.3.2: a site administrator downloads anyone’s data; downloads expire', async () => {
    const mi = users.mi?.id as number;
    expect((await post('kalo', `/api/v1/users/${mi}/data-exports`)).statusCode).toBe(403);
    const asked = await post('ada', `/api/v1/users/${mi}/data-exports`);
    expect(asked.statusCode, asked.body).toBe(202);
    const id = asked.json().export.id as string;
    await work();
    expect((await get('ada', `/api/v1/users/${mi}/data-exports`)).json().exports).toMatchObject([
      { id, state: 'ready', requestedBy: users.ada?.id },
    ]);
    const res = await get('ada', `/api/v1/users/${mi}/data-exports/${id}/download`);
    expect(res.statusCode).toBe(200);
    const zip = await unzip(res.rawPayload);
    // An administrator's download shows every ticket in full.
    expect(lines(zip['tickets.ndjson']).map((t) => t.summary)).toEqual(['Restricted plan']);
    // Another administrator's download is theirs.
    expect((await get('cy', `/api/v1/users/${mi}/data-exports/${id}/download`)).statusCode).toBe(
      404,
    );
    const row = await database.db
      .selectFrom('personal_export')
      .select(['storage_key'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(await expirePersonalExports(database.db, new Date(Date.now() + 8 * 86_400_000))).toBe(2);
    expect((await get('ada', `/api/v1/users/${mi}/data-exports`)).json().exports[0].state).toBe(
      'expired',
    );
    const cleanup = await database.db
      .selectFrom('storage_cleanup')
      .select('reason')
      .where('storage_key', '=', row.storage_key as string)
      .executeTakeFirst();
    expect(cleanup?.reason).toBe('deleted');
    expect((await get('ada', `/api/v1/users/${mi}/data-exports/${id}/download`)).statusCode).toBe(
      409,
    );
  });

  it('[IAM-008] ASVS 8.3.2: erasure asks for the email, refuses oneself, the last administrator and managed accounts', async () => {
    const erase = (who: string, id: number, confirmEmail: string) =>
      post(who, `/api/v1/users/${id}/erase`, { confirmEmail });
    const kalo = users.kalo?.id as number;
    const ada = users.ada?.id as number;
    expect((await erase('kalo', ada, 'ada@example.com')).statusCode).toBe(403);
    expect((await erase('ada', kalo, 'someone@example.com')).json()).toEqual({
      error: 'confirmation_mismatch',
    });
    expect((await erase('ada', ada, 'ada@example.com')).json()).toEqual({
      error: 'cannot_erase_self',
    });
    // Cy is an administrator by grant; Ada is the last one by the account flag.
    expect((await erase('cy', ada, 'ada@example.com')).json()).toEqual({ error: 'last_admin' });
    await database.db
      .insertInto('scim_user')
      .values({ user_id: kalo, workspace_id: 1, user_name: 'kalo', attributes: '{}' })
      .execute();
    expect((await erase('ada', kalo, 'kalo@example.com')).json()).toEqual({
      error: 'managed_by_scim',
    });
    await database.db
      .updateTable('scim_user')
      .set({ removed_at: new Date() })
      .where('user_id', '=', kalo)
      .execute();
    expect((await erase('ada', 999_999, 'x@example.com')).statusCode).toBe(404);
  });

  it('[IAM-008] ASVS 8.3.2: erasing replaces the person by a placeholder everywhere and keeps the audit log verifiable', async () => {
    const kalo = users.kalo?.id as number;
    const mi = users.mi?.id as number;
    // Mi mentions Kalo in a comment and a description, and assigns a ticket to Kalo.
    const made = await post('mi', '/api/v1/tickets', {
      track: 'PRV',
      summary: 'Toner',
      description: mentionDoc(kalo, 'Kalo Example'),
      assigneeId: kalo,
    });
    expect(made.statusCode, made.body).toBe(201);
    const ticket = made.json().ticket as { id: number; version: number };
    const said = await post('mi', `/api/v1/tickets/${ticket.id}/comments`, {
      body: mentionDoc(kalo, 'Kalo Example'),
    });
    expect(said.statusCode, said.body).toBe(201);
    // Kalo has a second factor, a token and preferences.
    await database.db
      .insertInto('totp_credential')
      .values({ user_id: kalo, workspace_id: 1, secret_sealed: 'sealed' })
      .execute();
    await database.db
      .insertInto('api_token')
      .values({
        workspace_id: 1,
        user_id: kalo,
        name: 'ci',
        token_hash: randomBytes(32).toString('hex'),
        scopes: ['read'],
        expires_at: new Date(Date.now() + 86_400_000),
      })
      .execute();
    await work();
    const before = await verifyChain(database.db, 1);
    expect(before.ok).toBe(true);

    const res = await post('ada', `/api/v1/users/${kalo}/erase`, {
      confirmEmail: ' KALO@example.com ',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().erased).toMatchObject({ userId: kalo, label: erasedName(kalo) });
    expect(res.json().erased.removed).toMatchObject({ api_token: 1, totp_credential: 1 });
    expect(res.json().erased.endedSessions).toBeGreaterThan(0);
    await work();

    const row = await database.db
      .selectFrom('app_user')
      .selectAll()
      .where('id', '=', kalo)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      email: erasedEmail(kalo),
      name: erasedName(kalo),
      password_hash: null,
      time_zone: null,
      is_site_admin: false,
    });
    expect(row.erased_at).not.toBeNull();
    expect(row.deactivated_at).not.toBeNull();
    for (const table of [
      'user_session',
      'api_token',
      'totp_credential',
      'personal_export',
    ] as const) {
      const left = await database.db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('user_id', '=', kalo)
        .executeTakeFirstOrThrow();
      expect(Number(left.n), table).toBe(0);
    }
    // The old session no longer works and the old email signs nobody in.
    expect((await get('kalo', '/api/v1/session')).json().user ?? null).toBeNull();
    expect((await signIn('kalo@example.com')).statusCode).toBe(401);
    expect((await post('ada', `/api/v1/users/${kalo}/reactivate`)).json()).toEqual({
      error: 'erased',
    });
    expect(
      (
        await post('ada', `/api/v1/users/${kalo}/erase`, { confirmEmail: erasedEmail(kalo) })
      ).json(),
    ).toEqual({ error: 'already_erased' });

    // Tickets, comments and history show the placeholder.
    const view = (await get('mi', `/api/v1/tickets/${ticket.id}`)).json().ticket;
    expect(JSON.stringify(view.description)).toContain(erasedName(kalo));
    expect(JSON.stringify(view)).not.toContain('Kalo Example');
    const comments = (await get('mi', `/api/v1/tickets/${ticket.id}/comments`)).json().comments;
    expect(JSON.stringify(comments)).toContain(erasedName(kalo));
    expect(JSON.stringify(comments)).not.toContain('Kalo Example');
    const history = await get('mi', `/api/v1/tickets/${ticket.id}/history`);
    expect(history.body).toContain(erasedName(kalo));
    expect(history.body).not.toContain('Kalo Example');
    const changes = await database.db
      .selectFrom('ticket_change')
      .select(['from_value', 'to_value', 'from_display', 'to_display'])
      .execute();
    expect(JSON.stringify(changes)).not.toContain('Kalo Example');
    const events = await database.db
      .selectFrom('domain_event')
      .select('payload')
      .where('subject_type', '=', 'user')
      .where('subject_id', '=', String(kalo))
      .execute();
    expect(JSON.stringify(events)).not.toMatch(/kalo@example\.com|Kalo Example/i);

    // The audit log: never rewritten, still verifiable, and read with the person's values masked.
    const after = await verifyChain(database.db, 1);
    expect(after.ok).toBe(true);
    expect(after.head.seq).toBeGreaterThan(before.head.seq);
    const records = await searchAudit(database.db, 1, { subjectId: String(kalo) }, { limit: 200 });
    expect(records.records.map((r) => r.action)).toContain('user.erased');
    expect(JSON.stringify(records.records)).not.toMatch(/kalo@example\.com|Kalo Example/i);
    const session = records.records.find((r) => r.action === 'session.started');
    expect(session?.masked).toBe(true);
    expect(session?.ip).toBeNull();
    const stored = await database.db
      .selectFrom('audit_event')
      .select('ip')
      .where('action', '=', 'session.started')
      .where('subject_id', '=', String(kalo))
      .executeTakeFirstOrThrow();
    expect(stored.ip).not.toBeNull();
    // Others' records are unchanged.
    const ada = await searchAudit(
      database.db,
      1,
      { actorId: users.ada?.id as number },
      { limit: 100 },
    );
    const aboutOthers = ada.records.filter((r) => r.subject?.id !== String(kalo));
    expect(aboutOthers.length).toBeGreaterThan(0);
    expect(aboutOthers.some((r) => r.masked)).toBe(false);
    // Mi is still Mi.
    const people = (await get('ada', '/api/v1/users?status=all')).json().users as {
      id: number;
      name: string;
      erased?: true;
    }[];
    expect(people.find((p) => p.id === mi)).toMatchObject({ name: 'Mi Example' });
    expect(people.find((p) => p.id === kalo)).toMatchObject({
      name: erasedName(kalo),
      erased: true,
    });
  });
});
