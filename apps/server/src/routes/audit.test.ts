import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword, LOCKOUT } from '@taskmoor/iam';
import { detectDelimiter } from '@taskmoor/webconfig';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { appendAudit } from '../audit/chain';
import { type AuditView, CSV_COLUMNS } from '../audit/query';
import { AUDIT_ACTIONS } from '../audit/record';
import { AUDITED_EVENTS } from '../audit/subscriber';
import { SESSION_COOKIE } from '../auth';
import { EventBus } from '../events/bus';
import { EVENT_TYPES } from '../events/catalogue';
import { JobRunner } from '../events/queue';
import { registerSubscribers } from '../events/subscribers';
import { records } from '../import/csv';
import { type AuditAbout, NAMED_SUBJECTS } from './audit';

const PASSWORD = 'ladder violet harbour';

function sessionCookie(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  const list = Array.isArray(header) ? header : header ? [header] : [];
  const found = list.find(
    (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
  );
  return (found ?? '').split(';')[0] ?? '';
}

describe('audit log API (M1-003, IAM-013)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let passwordHash: string;
  const ids: Record<string, number> = {};
  const cookies: Record<string, string> = {};
  let address = 0;

  const call = (options: InjectOptions & { cookie?: string; from?: string }) =>
    app.inject({
      ...options,
      remoteAddress: options.from ?? `198.18.1.${++address}`,
      headers: {
        ...(options.headers ?? {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
    });
  const asAdmin = (options: InjectOptions & { from?: string }) =>
    call({ ...options, cookie: cookies.admin ?? '' });

  async function createUser(email: string, admin = false): Promise<number> {
    const row = await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email,
        name: email.split('@')[0] ?? email,
        password_hash: passwordHash,
        is_site_admin: admin,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function signIn(email: string): Promise<string> {
    const res = await call({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return sessionCookie(res);
  }

  /** Runs the worker's part: relay events and deliver them to the subscribers. */
  async function deliverEvents(): Promise<void> {
    const bus = new EventBus(database.db);
    registerSubscribers(bus, { db: database.db });
    const runner = new JobRunner(database.db, 'audit-test');
    bus.attach(runner);
    while ((await bus.relayOnce()) > 0) {}
    while ((await runner.runOnce()) > 0) {}
  }

  // A record as the search answers it: its subject named, a role given or taken named (AD-2, S3-AD-4).
  type Found = Omit<AuditView, 'subject'> & {
    subject: { type: string; id: string | null; name?: string } | null;
    about?: AuditAbout;
  };

  async function search(query: string): Promise<{ records: Found[]; nextCursor: string | null }> {
    const res = await asAdmin({ method: 'GET', url: `/api/v1/audit?${query}` });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    passwordHash = await hashPassword(PASSWORD);
    ids.admin = await createUser('admin@example.com', true);
    ids.member = await createUser('member@example.com');
    ids.target = await createUser('target@example.com');
    cookies.admin = await signIn('admin@example.com');
    cookies.member = await signIn('member@example.com');
  });
  afterAll(async () => {
    await app.close();
  });

  it('[IAM-013] lets only site administrators read the log and set its retention', async () => {
    const routes: InjectOptions[] = [
      { method: 'GET', url: '/api/v1/audit' },
      { method: 'GET', url: '/api/v1/audit/export' },
      { method: 'GET', url: '/api/v1/audit/verify' },
      { method: 'GET', url: '/api/v1/audit/settings' },
      { method: 'PUT', url: '/api/v1/audit/settings', payload: { retentionMonths: 1 } },
    ];
    for (const route of routes) {
      expect((await call(route)).statusCode, `${route.url} anonymous`).toBe(401);
      expect((await call({ ...route, cookie: cookies.member ?? '' })).statusCode).toBe(403);
    }
  });

  it('[IAM-013] records refused sign-ins and the lockout, with the address and without the password', async () => {
    const from = '198.51.100.77';
    for (let i = 0; i < LOCKOUT.freeFailures; i++) {
      const res = await call({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: 'Target@Example.com', password: `secret guess ${i}` },
        from,
      });
      expect(res.statusCode).toBe(401);
    }
    // Locked now: refused without a check, and without a record.
    const locked = await call({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'target@example.com', password: PASSWORD },
      from,
    });
    expect(locked.statusCode).toBe(429);
    // Someone typed the password into the email field.
    await call({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: PASSWORD, password: PASSWORD },
      from,
    });

    const { records } = await search('action=session.');
    const actions = records.map((r) => r.action);
    expect(actions.filter((a) => a === AUDIT_ACTIONS.signInFailed)).toHaveLength(
      LOCKOUT.freeFailures + 1,
    );
    expect(actions.filter((a) => a === AUDIT_ACTIONS.lockedOut)).toHaveLength(1);
    const lockout = records.find((r) => r.action === AUDIT_ACTIONS.lockedOut);
    expect(lockout).toMatchObject({
      actor: null,
      subject: { type: 'user', id: String(ids.target) },
      ip: from,
      details: { email: 'target@example.com', until: expect.any(String) },
    });
    expect(records[0]).toMatchObject({
      action: AUDIT_ACTIONS.signInFailed,
      subject: null,
      details: { emailMalformed: true },
    });
    for (const record of records) expect(record.ip).toBe(from);
    expect(JSON.stringify(records)).not.toMatch(/secret guess|ladder violet/);
  });

  it('[IAM-013] records a refused password check and a rejected password link', async () => {
    const from = '198.51.100.78';
    const wrong = await call({
      method: 'PUT',
      url: '/api/v1/account/password',
      cookie: cookies.member ?? '',
      payload: { currentPassword: 'not it at all', newPassword: 'quiet otter lantern' },
      from,
    });
    expect(wrong.statusCode).toBe(403);
    const link = await call({
      method: 'POST',
      url: '/api/v1/password-links/inspect',
      payload: { token: 'no-such-link' },
      from,
    });
    expect(link.statusCode).toBe(404);
    const [check] = (await search(`action=${AUDIT_ACTIONS.passwordCheckFailed}`)).records;
    expect(check).toMatchObject({
      actor: { id: ids.member, email: 'member@example.com' },
      subject: { type: 'user', id: String(ids.member) },
      ip: from,
    });
    const [rejected] = (await search(`action=${AUDIT_ACTIONS.passwordLinkRejected}`)).records;
    expect(rejected).toMatchObject({ actor: null, subject: null, ip: from, details: {} });
  });

  it('[IAM-013] turns domain events into records with the actor, subject and client address', async () => {
    const created = await asAdmin({
      method: 'POST',
      url: '/api/v1/groups',
      payload: { name: 'Auditors' },
      from: '198.51.100.88',
    });
    expect(created.statusCode).toBeLessThan(300);
    const groupId = created.json().group.id;
    await deliverEvents();
    const { records } = await search('action=group.created');
    const event = await database.db
      .selectFrom('domain_event')
      .select(['id', 'ip'])
      .where('type', '=', 'group.created')
      .executeTakeFirstOrThrow();
    expect(event.ip).toBe('198.51.100.88');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action: 'group.created',
      actor: { id: ids.admin, email: 'admin@example.com', name: 'admin' },
      subject: { type: 'group', id: String(groupId) },
      details: { name: 'Auditors' },
      ip: '198.51.100.88',
      sourceEventId: String(event.id),
    });
    // The subject is named as it is now, not only by its id (AD-2).
    expect(records[0]?.subject).toEqual({ type: 'group', id: String(groupId), name: 'Auditors' });
    // The sign-ins of the setup became records too.
    const signIns = (await search(`action=session.started&actor=${ids.admin}`)).records;
    expect(signIns).toHaveLength(1);
    expect(signIns[0]?.details).toMatchObject({ method: 'password' });
  });

  it('[IAM-013] names a track and a person a record is about, but never an erased person (AD-2)', async () => {
    const policy = await database.db
      .selectFrom('access_policy')
      .select('id')
      .where('workspace_id', '=', 1)
      .executeTakeFirstOrThrow();
    const track = await database.db
      .insertInto('track')
      .values({ workspace_id: 1, key: 'NAMED', name: 'Named track', access_policy_id: policy.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    const gone = await createUser('gone@example.com');
    await database.db
      .updateTable('app_user')
      .set({ erased_at: new Date() })
      .where('id', '=', gone)
      .execute();
    await appendAudit(database.db, [
      {
        workspaceId: 1,
        actorId: null,
        action: 'test.named',
        subjectType: 'track',
        subjectId: track.id,
      },
      {
        workspaceId: 1,
        actorId: null,
        action: 'test.named',
        subjectType: 'user',
        subjectId: ids.target ?? 0,
      },
      { workspaceId: 1, actorId: null, action: 'test.named', subjectType: 'user', subjectId: gone },
    ]);
    const { records } = await search('action=test.named');
    expect(records.map((r) => r.subject)).toEqual([
      { type: 'user', id: String(gone) },
      { type: 'user', id: String(ids.target), name: 'target' },
      { type: 'track', id: String(track.id), name: 'Named track' },
    ]);
  });

  it('[IAM-013] names a ticket by its key, and sprints, plans, track groups, saved searches and areas (AD-2)', async () => {
    const policy = await database.db
      .selectFrom('access_policy')
      .select('id')
      .where('workspace_id', '=', 1)
      .executeTakeFirstOrThrow();
    const track = await database.db
      .insertInto('track')
      .values({ workspace_id: 1, key: 'KEYED', name: 'Keyed track', access_policy_id: policy.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    const type = await database.db
      .selectFrom('ticket_type')
      .select('id')
      .where('workspace_id', '=', 1)
      .executeTakeFirstOrThrow();
    const ticket = await sql<{ id: number }>`
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary, rank)
      VALUES (1, ${track.id}, 41, ${type.id}, 'Named by its key', 'a') RETURNING id`.execute(
      database.db,
    );
    const owner = ids.admin ?? 0;
    const board = await database.db
      .insertInto('board')
      .values({
        workspace_id: 1,
        name: 'Keyed board',
        kind: 'scrum',
        location_track_id: null,
        location_user_id: owner,
        filter_query: 'track = KEYED',
        sub_filter_query: null,
        columns: JSON.stringify([]),
        swimlanes: JSON.stringify({ kind: 'none' }),
        card_rules: JSON.stringify([]),
        created_by: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const named = {
      ticket: ticket.rows[0]?.id ?? 0,
      sprint: (
        await database.db
          .insertInto('sprint')
          .values({ workspace_id: 1, board_id: board.id, name: 'Keyed sprint 4', sequence: 4 })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id,
      plan: (
        await database.db
          .insertInto('plan')
          .values({ workspace_id: 1, owner_id: owner, name: 'Next quarter' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id,
      track_group: (
        await database.db
          .insertInto('track_group')
          .values({ workspace_id: 1, owner_id: owner, name: 'Mobile tracks', position: 0 })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id,
      saved_search: (
        await database.db
          .insertInto('saved_search')
          .values({
            workspace_id: 1,
            owner_id: owner,
            name: 'My open work',
            query: 'status = Open',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id,
      area: (
        await database.db
          .insertInto('area')
          .values({ workspace_id: 1, track_id: track.id, name: 'Payments' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id,
    };
    await appendAudit(
      database.db,
      Object.entries(named).map(([subjectType, subjectId]) => ({
        workspaceId: 1,
        actorId: null,
        action: 'test.keyed',
        subjectType,
        subjectId,
      })),
    );
    const { records } = await search('action=test.keyed');
    expect(Object.fromEntries(records.map((r) => [r.subject?.type, r.subject?.name]))).toEqual({
      ticket: 'KEYED-41',
      sprint: 'Keyed sprint 4',
      plan: 'Next quarter',
      track_group: 'Mobile tracks',
      saved_search: 'My open work',
      area: 'Payments',
    });
  });

  it('[IAM-013] says which role was given or taken, and to whom (S3-AD-4)', async () => {
    const role = await database.db
      .insertInto('role')
      .values({ workspace_id: 1, name: 'Reviewers' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const group = await database.db
      .insertInto('user_group')
      .values({ workspace_id: 1, name: 'Night shift' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const gone = await createUser('gone-role@example.com');
    await database.db
      .updateTable('app_user')
      .set({ erased_at: new Date() })
      .where('id', '=', gone)
      .execute();
    const given = (action: string, userId: number | null, groupId: number | null) => ({
      workspaceId: 1,
      actorId: null,
      action,
      subjectType: 'track',
      subjectId: 1,
      details: { roleId: role.id, userId, groupId },
    });
    await appendAudit(database.db, [
      given('track_role.actor_added', ids.target ?? 0, null),
      given('track_role.actor_removed', null, group.id),
      given('track_role.actor_added', gone, null),
    ]);
    const { records } = await search('action=track_role.');
    expect(records.slice(0, 3).map((r) => [r.action, r.about])).toEqual([
      // An erased person is never named; the role still is.
      ['track_role.actor_added', { role: 'Reviewers' }],
      ['track_role.actor_removed', { role: 'Reviewers', group: 'Night shift' }],
      ['track_role.actor_added', { role: 'Reviewers', person: 'target' }],
    ]);
  });

  it('[IAM-013] names every audited subject whose table has a name (AD-2)', async () => {
    // The audited subjects whose table is not called after them, and those with no table.
    const tableOf: Record<string, string> = {
      user: 'app_user',
      group: 'user_group',
      directory: 'ldap_directory',
    };
    const noTable = new Set(['ai_run']);
    const { rows } = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = current_schema()`.execute(database.db);
    const columns = new Map<string, Set<string>>();
    for (const row of rows) {
      columns.set(row.table_name, (columns.get(row.table_name) ?? new Set()).add(row.column_name));
    }
    const kinds = [...new Set(AUDITED_EVENTS.map((type) => EVENT_TYPES[type].subject))];
    const tableFor = (kind: string) => tableOf[kind] ?? kind;
    expect(
      kinds.filter((kind) => !noTable.has(kind) && !columns.has(tableFor(kind))),
      'audited subjects whose table this test cannot find',
    ).toEqual([]);
    const named = new Map<string, string>(Object.entries(NAMED_SUBJECTS));
    const hasName = (table: string) =>
      ['id', 'workspace_id', 'name'].every((column) => columns.get(table)?.has(column));
    expect(
      kinds.filter((kind) => hasName(tableFor(kind)) && named.get(kind) !== tableFor(kind)),
      'audited subjects with a name that the log leaves as an id',
    ).toEqual([]);
    for (const [kind, table] of named) {
      expect(
        ['id', 'workspace_id'].every((column) => columns.get(table)?.has(column)),
        kind,
      ).toBe(true);
    }
  });

  it('[IAM-013] names priorities, link types, identity providers, tokens, app connections, frontends and field options (AD-2)', async () => {
    const priority = await asAdmin({
      method: 'POST',
      url: '/api/v1/priorities',
      payload: { name: 'Urgent today' },
    });
    expect(priority.statusCode, priority.body).toBe(201);
    const linkType = await asAdmin({
      method: 'POST',
      url: '/api/v1/link-types',
      payload: { name: 'Mirrors', outward: 'mirrors', inward: 'is mirrored by' },
    });
    expect(linkType.statusCode, linkType.body).toBeLessThan(300);
    await deliverEvents();
    expect((await search('action=priority.created')).records[0]?.subject).toEqual({
      type: 'priority',
      id: String(priority.json().priority.id),
      name: 'Urgent today',
    });
    expect((await search('action=link_type.created')).records[0]?.subject?.name).toBe('Mirrors');

    const insert = async (table: string, values: Record<string, unknown>) =>
      (
        await sql<{ id: number | string }>`
          INSERT INTO ${sql.table(table)} (${sql.join(Object.keys(values).map((c) => sql.ref(c)))})
          VALUES (${sql.join(Object.values(values))}) RETURNING id`.execute(database.db)
      ).rows[0]?.id ?? 0;
    const field = await insert('field', { workspace_id: 1, name: 'Shade', type: 'select' });
    const context = await insert('field_context', {
      workspace_id: 1,
      field_id: field,
      name: 'Shade everywhere',
    });
    const subjects: [string, number | string][] = [
      [
        'identity_provider',
        await insert('identity_provider', {
          workspace_id: 1,
          name: 'Staff accounts',
          issuer: 'https://login.example.com',
          client_id: 'taskmoor',
        }),
      ],
      [
        'api_token',
        await insert('api_token', {
          workspace_id: 1,
          user_id: ids.admin ?? 0,
          name: 'Nightly export',
          token_hash: 'not-a-token-hash',
          scopes: sql`ARRAY['read']::text[]`,
          expires_at: new Date('2999-01-01T00:00:00Z'),
        }),
      ],
      [
        // An app connection's id is text.
        'oauth_client',
        await insert('oauth_client', {
          id: 'tmc_auditnamedclient0001',
          workspace_id: 1,
          name: 'Editor plugin',
          redirect_uris: sql`ARRAY['http://127.0.0.1/callback']::text[]`,
        }),
      ],
      [
        'frontend_origin',
        await insert('frontend_origin', {
          workspace_id: 1,
          origin: 'https://board.example.com',
          label: 'Wall board',
        }),
      ],
      [
        'frontend_origin',
        await insert('frontend_origin', { workspace_id: 1, origin: 'https://plain.example.com' }),
      ],
      ['field_context', context],
      [
        'field_option',
        await insert('field_option', {
          workspace_id: 1,
          field_id: field,
          context_id: context,
          value: 'Teal',
          sort_order: 1,
        }),
      ],
    ];
    await appendAudit(
      database.db,
      subjects.map(([subjectType, subjectId]) => ({
        workspaceId: 1,
        actorId: null,
        action: 'test.more_named',
        subjectType,
        subjectId,
      })),
    );
    const { records } = await search('action=test.more_named');
    expect(records.map((r) => [r.subject?.type, r.subject?.name]).reverse()).toEqual([
      ['identity_provider', 'Staff accounts'],
      ['api_token', 'Nightly export'],
      ['oauth_client', 'Editor plugin'],
      ['frontend_origin', 'Wall board'],
      // A frontend with no label is named by its address.
      ['frontend_origin', 'https://plain.example.com'],
      ['field_context', 'Shade everywhere'],
      ['field_option', 'Teal'],
    ]);
  });

  it('[IAM-013] searches by action, actor, subject and time, newest first, a page at a time', async () => {
    await appendAudit(
      database.db,
      Array.from({ length: 5 }, (_, i) => ({
        workspaceId: 1,
        action: 'test.page',
        actorId: ids.member ?? null,
        subjectType: 'group',
        subjectId: 1000 + i,
      })),
    );
    const seen: number[] = [];
    let cursor: string | null = '';
    let pages = 0;
    while (cursor !== null) {
      const page = await search(`action=test.page&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.records.map((r) => r.seq));
      cursor = page.nextCursor;
      pages++;
    }
    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));

    const byActor = await search(`actor=${ids.member}&limit=500`);
    expect(byActor.records.length).toBeGreaterThanOrEqual(5);
    expect(byActor.records.every((r) => r.actor?.id === ids.member)).toBe(true);
    const bySubject = await search('subject=group:1003');
    expect(bySubject.records.map((r) => r.subject)).toEqual([{ type: 'group', id: '1003' }]);
    const byType = await search('subject=group&limit=500');
    expect(byType.records.every((r) => r.subject?.type === 'group')).toBe(true);

    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect((await search(`from=${encodeURIComponent(hourAgo)}`)).records.length).toBeGreaterThan(0);
    expect((await search('from=2999-01-01')).records).toEqual([]);
    expect((await search('to=2000-01-01')).records).toEqual([]);
    expect((await search('action=test.p%25')).records).toEqual([]);

    for (const bad of ['from=yesterday', 'subject=Not%20a%20subject', 'limit=0', 'cursor=abc']) {
      expect((await asAdmin({ method: 'GET', url: `/api/v1/audit?${bad}` })).statusCode).toBe(400);
    }
  });

  it('[IAM-013] exports the log as CSV and JSON Lines, streamed, and records each export', async () => {
    const csv = await asAdmin({ method: 'GET', url: '/api/v1/audit/export?format=csv' });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/^attachment; filename="audit-.*\.csv"$/);
    // The byte-order mark first, once (T-252); then the header.
    expect([...csv.rawPayload.subarray(0, 4)]).toEqual([0xef, 0xbb, 0xbf, 's'.charCodeAt(0)]);
    const lines = csv.body.slice(1).split('\r\n').filter(Boolean);
    expect(lines[0]).toBe(CSV_COLUMNS.join(','));
    // The CSV importer reads the file back as written, the mark taken off.
    const back = [...records(csv.rawPayload, ',')].map((r) => r.fields);
    expect(back[0]).toEqual([...CSV_COLUMNS]);
    expect(back).toHaveLength(lines.length);
    expect(back.at(-1)?.[6]).toBe(AUDIT_ACTIONS.exported);
    const total = await database.db
      .selectFrom('audit_event')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('workspace_id', '=', 1)
      .executeTakeFirstOrThrow();
    // Every record, the export's own record included (it is written before the first line).
    expect(lines.length - 1).toBe(Number(total.n));
    expect(lines[lines.length - 1]).toContain(`,${AUDIT_ACTIONS.exported},`);

    const jsonl = await asAdmin({
      method: 'GET',
      url: '/api/v1/audit/export?format=jsonl&action=session.sign_in_failed',
    });
    expect(jsonl.headers['content-type']).toMatch(/^application\/x-ndjson/);
    const rows = jsonl.body
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditView);
    expect(rows).toHaveLength(LOCKOUT.freeFailures + 1);
    expect(rows.every((r) => r.action === 'session.sign_in_failed')).toBe(true);
    expect(rows.map((r) => r.seq)).toEqual([...rows.map((r) => r.seq)].sort((a, b) => a - b));

    const exports = (await search(`action=${AUDIT_ACTIONS.exported}`)).records;
    expect(exports.map((r) => r.details)).toEqual([
      { format: 'jsonl', filter: { action: 'session.sign_in_failed' } },
      { format: 'csv', filter: {} },
    ]);
    expect(exports[0]?.actor?.id).toBe(ids.admin);
  });

  it('[IAM-013] [NFR-006] exports the log with semicolons when asked, the mark still first and once (T-263)', async () => {
    const csv = await asAdmin({
      method: 'GET',
      url: '/api/v1/audit/export?format=csv&separator=semicolon',
    });
    expect(csv.statusCode).toBe(200);
    expect([...csv.rawPayload.subarray(0, 4)]).toEqual([0xef, 0xbb, 0xbf, 's'.charCodeAt(0)]);
    expect(csv.rawPayload.indexOf(Buffer.from([0xef, 0xbb, 0xbf]), 3)).toBe(-1);
    const lines = csv.body.slice(1).split('\r\n').filter(Boolean);
    expect(lines[0]).toBe(CSV_COLUMNS.join(';'));
    // The importer finds the separator and reads every record back.
    expect(detectDelimiter(csv.rawPayload)).toBe(';');
    const back = [...records(csv.rawPayload, ';')].map((r) => r.fields);
    expect(back[0]).toEqual([...CSV_COLUMNS]);
    expect(back).toHaveLength(lines.length);
    expect(back.at(-1)?.[6]).toBe(AUDIT_ACTIONS.exported);
    const wrong = await asAdmin({ method: 'GET', url: '/api/v1/audit/export?separator=tab' });
    expect(wrong.statusCode).toBe(400);
  });

  it('[IAM-013] streams a large export in batches', async () => {
    await appendAudit(
      database.db,
      Array.from({ length: 2500 }, (_, i) => ({
        workspaceId: 1,
        action: 'test.bulk',
        actorId: null,
        details: { n: i },
      })),
    );
    const res = await asAdmin({
      method: 'GET',
      url: '/api/v1/audit/export?format=jsonl&action=test.bulk',
    });
    const rows = res.body.split('\n').filter(Boolean);
    expect(rows).toHaveLength(2500);
    expect(JSON.parse(rows[2499] ?? '{}').details).toEqual({ n: 2499 });
  });

  it('[IAM-013] sets the retention and emits one event per change', async () => {
    expect((await asAdmin({ method: 'GET', url: '/api/v1/audit/settings' })).json()).toEqual({
      retentionMonths: 12,
    });
    const put = (payload: unknown) =>
      asAdmin({
        method: 'PUT',
        url: '/api/v1/audit/settings',
        payload: payload as object,
        from: '198.51.100.99',
      });
    const changed = await put({ retentionMonths: 84 });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ retentionMonths: 84 });
    expect((await put({ retentionMonths: 84 })).statusCode).toBe(200);
    const events = await database.db
      .selectFrom('domain_event')
      .select(['payload', 'actor_id', 'ip'])
      .where('type', '=', 'audit.settings_updated')
      .execute();
    expect(events).toEqual([
      {
        payload: { changes: { retentionMonths: { from: 12, to: 84 } } },
        actor_id: ids.admin,
        ip: '198.51.100.99',
      },
    ]);
    expect((await asAdmin({ method: 'GET', url: '/api/v1/audit/settings' })).json()).toEqual({
      retentionMonths: 84,
    });
    for (const bad of [
      { retentionMonths: -1 },
      { retentionMonths: 1201 },
      { retentionMonths: 1.5 },
      { retentionMonths: '12' },
      { retentionMonths: 12, extra: true },
    ]) {
      expect((await put(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('[IAM-013] verifies the chain, and reports a record altered behind its back', async () => {
    await deliverEvents();
    const ok = await asAdmin({ method: 'GET', url: '/api/v1/audit/verify' });
    expect(ok.json()).toMatchObject({ ok: true, firstBroken: null, checkpoint: { seq: 0 } });
    const head = ok.json().head.seq as number;
    expect(ok.json().checked).toBe(head);

    await database.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await sql`UPDATE audit_event SET ip = '192.0.2.1' WHERE workspace_id = 1 AND seq = 3`.execute(
        trx,
      );
    });
    const broken = await asAdmin({ method: 'GET', url: '/api/v1/audit/verify' });
    expect(broken.json()).toMatchObject({
      ok: false,
      checked: 2,
      firstBroken: { seq: 3, reason: 'hash' },
    });
  });
});
