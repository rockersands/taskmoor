import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

/** Generated per run: no credential is kept in the repository. */
const PASSWORD = randomBytes(18).toString('base64url');
let address = 0;
const nextAddress = () => `100.76.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

function sessionCookie(header: string | string[] | undefined): string {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    (
      list.find(
        (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
      ) ?? ''
    ).split(';')[0] ?? ''
  );
}

const PEOPLE = ['admin', 'alice', 'bob', 'erin'] as const;
type Person = (typeof PEOPLE)[number];

interface SearchJson {
  tickets: { id: number; key: string; summary?: string; fields?: Record<string, unknown> }[];
  next: string | null;
  total?: { count: number; exact: boolean };
  warnings?: string[];
  error?: string;
  message?: string;
}

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/**
 * Running queries (M1-037; QRY-002, QRY-003, QRY-008 to QRY-010): every built system field and
 * every custom field type through `/api/v1/search`, empties and NOT, ordering and keyset pages,
 * refusals, the timeout, explain, archived tracks and the trash.
 */
describe('search (M1-037)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let slowApp: FastifyInstance;
  const users = {} as Record<Person, { id: number; cookie: string }>;
  const tracks: Record<string, number> = {};
  const fields: Record<string, number> = {};
  const keys: Record<string, string> = {};
  const ids: Record<string, number> = {};

  const as = (who: Person | null, options: InjectOptions, on = app) =>
    on.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: who ? users[who].cookie : '' },
    });
  const search = async (who: Person | null, q: string, extra = '&limit=200') => {
    const res = await as(who, {
      method: 'GET',
      url: `/api/v1/search?q=${encodeURIComponent(q)}${extra}`,
    });
    return { status: res.statusCode, body: res.json() as SearchJson };
  };
  /** The names of the tickets a query finds, in result order. */
  const names = async (q: string, who: Person = 'alice') => {
    const { status, body } = await search(who, q);
    expect(status, `${q}: ${JSON.stringify(body)}`).toBe(200);
    const byId = new Map(Object.entries(ids).map(([name, id]) => [id, name]));
    return body.tickets.map((t) => byId.get(t.id) ?? `#${t.id}`);
  };
  const set = async (q: string, who: Person = 'alice') => (await names(q, who)).sort();

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    slowApp = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      queryTimeoutMs: 1,
    });
    const hash = await hashPassword(PASSWORD);
    for (const name of PEOPLE) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name: name[0]?.toUpperCase() + name.slice(1),
          password_hash: hash,
          is_site_admin: name === 'admin',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: `${name}@example.com`, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      users[name] = { id: row.id, cookie: sessionCookie(res.headers['set-cookie']) };
    }
    const support = await database.db
      .insertInto('user_group')
      .values({ workspace_id: 1, name: 'Support' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('group_member')
      .values({ workspace_id: 1, group_id: support.id, user_id: users.bob.id })
      .execute();
    const member = (
      await database.db
        .selectFrom('role')
        .select('id')
        .where('name', '=', 'Members')
        .executeTakeFirstOrThrow()
    ).id;
    for (const [key, who] of [
      ['ABC', ['alice', 'bob']],
      ['DEF', ['alice']],
      ['ARC', ['alice']],
    ] as const) {
      const res = await as('admin', {
        method: 'POST',
        url: '/api/v1/tracks',
        payload: { key, name: `Track ${key}`, mode: 'shared' },
      });
      expect(res.statusCode, res.body).toBe(201);
      tracks[key] = res.json().track.id;
      for (const w of who) {
        await database.db
          .insertInto('track_role_actor')
          .values({
            workspace_id: 1,
            track_id: tracks[key] as number,
            role_id: member,
            user_id: users[w].id,
          })
          .execute();
      }
    }
    const field = async (payload: Record<string, unknown>) => {
      const res = await as('admin', { method: 'POST', url: '/api/v1/fields', payload });
      expect(res.statusCode, res.body).toBe(201);
      const made = res.json().field as {
        id: number;
        contexts: { options?: { id: number; value: string; children?: unknown[] }[] }[];
      };
      fields[payload.name as string] = made.id;
      return made;
    };
    const opts = (values: string[]) => values.map((value) => ({ value }));
    await field({ name: 'Points', type: 'number' });
    await field({ name: 'Due by', type: 'date' });
    await field({ name: 'Deadline', type: 'datetime' });
    await field({
      name: 'Team',
      type: 'select',
      context: { options: opts(['Red', 'Green', 'Blue']) },
    });
    await field({
      name: 'Tags',
      type: 'select',
      multiple: true,
      context: { options: opts(['A', 'B', 'C']) },
    });
    await field({ name: 'Reviewer', type: 'user' });
    await field({ name: 'Notes', type: 'text' });
    await field({ name: 'Topics', type: 'labels' });
    await field({ name: 'Squad', type: 'group' });
    await field({
      name: 'Stack',
      type: 'cascading-select',
      context: {
        options: [
          { value: 'Hardware', children: [{ value: 'Disk' }, { value: 'Fan' }] },
          { value: 'Software', children: [{ value: 'Web' }] },
        ],
      },
    });
    const options = await database.db
      .selectFrom('field_option')
      .select(['id', 'field_id', 'value'])
      .execute();
    const option = (fieldName: string, value: string) =>
      options.find((o) => o.field_id === fields[fieldName] && o.value === value)?.id as number;

    const releases: Record<string, number> = {};
    for (const name of ['1.0', '2.0', '3.0']) {
      const res = await as('admin', {
        method: 'POST',
        url: `/api/v1/tracks/${tracks.ABC}/releases`,
        payload: { name },
      });
      expect(res.statusCode, res.body).toBe(201);
      releases[name] = res.json().release.id;
    }
    const areas: Record<string, number> = {};
    for (const name of ['Backend', 'Frontend']) {
      const res = await as('admin', {
        method: 'POST',
        url: `/api/v1/tracks/${tracks.ABC}/areas`,
        payload: { name },
      });
      expect(res.statusCode, res.body).toBe(201);
      areas[name] = res.json().area.id;
    }
    const types = await database.db
      .selectFrom('ticket_type')
      .select(['id', 'name'])
      .where('owner_track_id', 'is', null)
      .execute();
    const type = (name: string) => types.find((t) => t.name === name)?.id as number;
    const priorities = await database.db.selectFrom('priority').select(['id', 'name']).execute();
    const priority = (name: string) => priorities.find((p) => p.name === name)?.id as number;

    const create = async (name: string, payload: Record<string, unknown>) => {
      const res = await as('admin', { method: 'POST', url: '/api/v1/tickets', payload });
      expect(res.statusCode, res.body).toBe(201);
      const t = res.json().ticket as { id: number; key: string };
      ids[name] = t.id;
      keys[name] = t.key;
    };
    await create('login', {
      track: 'ABC',
      ticketTypeId: type('Bug'),
      summary: 'Login fails on Safari',
      description: doc('The login form freezes after submit'),
      priorityId: priority('High'),
      assigneeId: users.alice.id,
      requesterId: users.bob.id,
      labels: ['security', 'regression'],
      dueDate: '2026-02-01',
      startDate: '2026-01-05',
      targetReleaseIds: [releases['1.0']],
      areaIds: [areas.Backend],
      originalEstimate: 3600,
      fields: {
        [fields.Points as number]: 5,
        [fields['Due by'] as number]: '2026-01-10',
        [fields.Deadline as number]: '2026-01-10T10:00:00Z',
        [fields.Team as number]: option('Team', 'Red'),
        [fields.Tags as number]: [option('Tags', 'A'), option('Tags', 'B')],
        [fields.Reviewer as number]: users.bob.id,
        [fields.Notes as number]: 'check the session cookies',
        [fields.Topics as number]: ['alpha', 'beta'],
        [fields.Squad as number]: support.id,
        [fields.Stack as number]: [option('Stack', 'Hardware'), option('Stack', 'Disk')],
      },
    });
    await create('dashboard', {
      track: 'ABC',
      ticketTypeId: type('Feature'),
      summary: 'Dashboard loads slowly',
      priorityId: priority('Low'),
      assigneeId: users.bob.id,
      requesterId: users.alice.id,
      labels: ['performance'],
      targetReleaseIds: [releases['2.0']],
      foundInReleaseIds: [releases['1.0']],
      areaIds: [areas.Frontend],
      fields: {
        [fields.Points as number]: 3,
        [fields['Due by'] as number]: '2026-03-01',
        [fields.Team as number]: option('Team', 'Green'),
        [fields.Tags as number]: [option('Tags', 'C')],
        [fields.Reviewer as number]: users.alice.id,
        [fields.Notes as number]: 'charts render on the client',
        [fields.Stack as number]: [option('Stack', 'Software')],
      },
    });
    await create('export', {
      track: 'ABC',
      ticketTypeId: type('Subticket'),
      parent: keys.dashboard,
      summary: 'Export to CSV',
      priorityId: null,
      labels: [],
    });
    await create('audit', {
      track: 'DEF',
      ticketTypeId: type('Chore'),
      summary: 'Login audit log',
      environment: doc('Linux servers only'),
      priorityId: priority('Urgent'),
      assigneeId: users.alice.id,
      labels: ['security'],
      fields: {
        [fields.Points as number]: 8,
        [fields.Tags as number]: [option('Tags', 'A')],
        [fields.Topics as number]: ['gamma'],
      },
    });
    await create('closed', {
      track: 'ABC',
      summary: 'Closed thing',
      priorityId: priority('Normal'),
    });
    await create('trashed', { track: 'ABC', summary: 'Trash this login' });
    await create('archived', { track: 'ARC', summary: 'Archived login' });

    // Dates the queries below can count on, newest first: login, dashboard, export, audit,
    // closed (the trashed and archived ones apart).
    const day = (n: number) => new Date(Date.UTC(2026, 0, n, 12)).toISOString();
    for (const [name, n] of [
      ['login', 20],
      ['dashboard', 15],
      ['export', 10],
      ['audit', 5],
      ['closed', 1],
      ['trashed', 25],
      ['archived', 26],
    ] as const) {
      const at = day(n);
      await sql`UPDATE ticket SET created_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
        WHERE id = ${ids[name]}`.execute(database.db);
      for (const table of ['v_text', 'v_number', 'v_date', 'v_time', 'v_user', 'v_option']) {
        await sql`UPDATE ${sql.table(table)} SET created_at = ${at}::timestamptz
          WHERE ticket_id = ${ids[name]}`.execute(database.db);
      }
    }
    const closed = await database.db
      .selectFrom('status')
      .select('id')
      .where('name', '=', 'Closed')
      .executeTakeFirstOrThrow();
    const completed = await database.db
      .selectFrom('close_reason')
      .select('id')
      .where('name', '=', 'Completed')
      .executeTakeFirstOrThrow();
    await database.db
      .updateTable('ticket')
      .set({ status_id: closed.id, closed_at: new Date(day(2)), close_reason_id: completed.id })
      .where('id', '=', ids.closed as number)
      .execute();
    await database.db
      .updateTable('ticket')
      .set({ time_spent: 1800 })
      .where('id', '=', ids.login as number)
      .execute();
    // Followers, votes, a link, an attachment and a time entry, written as their routes would
    // (creators follow what they create; start from none).
    await database.db.deleteFrom('ticket_follower').execute();
    await database.db
      .insertInto('ticket_follower')
      .values([
        { workspace_id: 1, ticket_id: ids.login as number, user_id: users.alice.id },
        { workspace_id: 1, ticket_id: ids.login as number, user_id: users.bob.id },
        { workspace_id: 1, ticket_id: ids.dashboard as number, user_id: users.bob.id },
      ])
      .onConflict((oc) => oc.doNothing())
      .execute();
    await database.db
      .insertInto('ticket_vote')
      .values({ workspace_id: 1, ticket_id: ids.audit as number, user_id: users.bob.id })
      .execute();
    const blocks = await database.db
      .selectFrom('link_type')
      .select('id')
      .where('name', '=', 'Blocks')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('ticket_link')
      .values({
        workspace_id: 1,
        link_type_id: blocks.id,
        source_id: ids.login as number,
        target_id: ids.audit as number,
      })
      .execute();
    await sql`INSERT INTO attachment (workspace_id, ticket_id, name, declared_type, size, sha256,
        storage, storage_key, scan_state, scanned_at)
      VALUES (1, ${ids.dashboard}, 'shot.png', 'image/png', 10, repeat('a', 64), 'local',
        'w1/aa/bb/aabb0000000000000000000000000000', 'clean', now())`.execute(database.db);
    await database.db
      .insertInto('time_entry')
      .values({
        workspace_id: 1,
        ticket_id: ids.login as number,
        author_id: users.alice.id,
        started_at: new Date('2026-01-21T09:00:00Z'),
        duration: 1800,
        description: 'reproduced on macOS',
      })
      .execute();
    // The trash and the archive.
    const trashed = await as('admin', { method: 'DELETE', url: `/api/v1/tickets/${keys.trashed}` });
    expect(trashed.statusCode, trashed.body).toBeLessThan(300);
    const archived = await as('admin', {
      method: 'POST',
      url: `/api/v1/tracks/${tracks.ARC}/archive`,
    });
    expect(archived.statusCode, archived.body).toBeLessThan(300);
  });
  afterAll(async () => {
    await app.close();
    await slowApp.close();
  });

  it('[QRY-003] finds tickets by every built system field, in both vocabularies', async () => {
    const live = ['audit', 'closed', 'dashboard', 'export', 'login'];
    expect(await set('')).toEqual(live);
    expect(await set(`key = ${keys.login}`)).toEqual(['login']);
    expect(await set(`issuekey IN (${keys.login}, ${keys.audit})`)).toEqual(['audit', 'login']);
    expect(await set(`id = ${ids.export}`)).toEqual(['export']);
    expect(await set('track = DEF')).toEqual(['audit']);
    expect(await set('project != DEF')).toEqual(['closed', 'dashboard', 'export', 'login']);
    expect(await set('type = Bug')).toEqual(['login']);
    expect(await set('issuetype IN (Bug, Chore)')).toEqual(['audit', 'login']);
    expect(await set('hierarchyLevel = -1')).toEqual(['export']);
    expect(await set('hierarchyLevel > -1')).toEqual(['audit', 'closed', 'dashboard', 'login']);
    expect(await set('status = Closed')).toEqual(['closed']);
    expect(await set('stage = closed')).toEqual(['closed']);
    expect(await set('statusCategory != Done')).toEqual(['audit', 'dashboard', 'export', 'login']);
    expect(await set('priority = High')).toEqual(['login']);
    expect(await set('priority > High')).toEqual(['audit']);
    expect(await set('priority <= Normal')).toEqual(['closed', 'dashboard']);
    expect(await set('priority IS EMPTY')).toEqual(['export']);
    expect(await set('closeReason = Completed')).toEqual(['closed']);
    expect(await set('resolution IS EMPTY')).toEqual(['audit', 'dashboard', 'export', 'login']);
    expect(await set('summary ~ login')).toEqual(['audit', 'login']);
    expect(await set('summary ~ "login safari"')).toEqual(['login']);
    expect(await set('summary !~ login')).toEqual(['closed', 'dashboard', 'export']);
    expect(await set('description ~ freezes')).toEqual(['login']);
    // The words of the document only, not its structure.
    expect(await set('description ~ paragraph')).toEqual([]);
    expect(await set('description IS EMPTY')).toEqual(['audit', 'closed', 'dashboard', 'export']);
    expect(await set('environment ~ linux')).toEqual(['audit']);
    expect(await set('text ~ cookies')).toEqual(['login']);
    expect(await set('text ~ linux')).toEqual(['audit']);
    expect(await set(`assignee = ${users.alice.id}`)).toEqual(['audit', 'login']);
    expect(await set('assignee = currentUser()')).toEqual(['audit', 'login']);
    expect(await set('assignee = bob@example.com')).toEqual(['dashboard']);
    expect(await set('assignee IS EMPTY')).toEqual(['closed', 'export']);
    expect(await set('reporter = Bob')).toEqual(['login']);
    expect(await set('creator = admin@example.com')).toEqual(live);
    expect(await set('watcher = bob@example.com')).toEqual(['dashboard', 'login']);
    expect(await set('follower IS EMPTY')).toEqual(['audit', 'closed', 'export']);
    expect(await set('followers >= 2')).toEqual(['login']);
    expect(await set('voter = currentUser()')).toEqual([]);
    expect(await set('votes = 1')).toEqual(['audit']);
    expect(await set('labels = security')).toEqual(['audit', 'login']);
    expect(await set('labels IN (performance, regression)')).toEqual(['dashboard', 'login']);
    expect(await set('labels IS EMPTY')).toEqual(['closed', 'export']);
    expect(await set('component = Backend')).toEqual(['login']);
    expect(await set('area IS EMPTY')).toEqual(['audit', 'closed', 'export']);
    expect(await set('fixVersion = "1.0"')).toEqual(['login']);
    expect(await set('targetRelease > "1.0"')).toEqual(['dashboard']);
    expect(await set('affectedVersion = "1.0"')).toEqual(['dashboard']);
    expect(await set(`parent = ${keys.dashboard}`)).toEqual(['export']);
    expect(await set('parent IS EMPTY')).toEqual(['audit', 'closed', 'dashboard', 'login']);
    expect(await set('parentTrack = ABC')).toEqual(['export']);
    expect(await set('created >= 2026-01-10')).toEqual(['dashboard', 'export', 'login']);
    expect(await set('created < "2026/01/06"')).toEqual(['audit', 'closed']);
    expect(await set('updated > 2026-01-16')).toEqual(['login']);
    expect(await set('resolved IS NOT EMPTY')).toEqual(['closed']);
    expect(await set('closed >= 2026-01-02')).toEqual(['closed']);
    expect(await set('due = 2026-02-01')).toEqual(['login']);
    expect(await set('startDate < 2026-01-06')).toEqual(['login']);
    expect(await set('due IS EMPTY')).toEqual(['audit', 'closed', 'dashboard', 'export']);
    expect(await set('attachments IS NOT EMPTY')).toEqual(['dashboard']);
    expect(await set('level IS EMPTY')).toEqual(live);
    expect(await set('originalEstimate = 3600')).toEqual(['login']);
    expect(await set('timeSpent > 0')).toEqual(['login']);
    expect(await set('workRatio = 50')).toEqual(['login']);
    // A new ticket's remaining estimate starts at its original one.
    expect(await set('remainingEstimate IS EMPTY')).toEqual([
      'audit',
      'closed',
      'dashboard',
      'export',
    ]);
    expect(await set(`issueLink = ${keys.login}`)).toEqual(['audit']);
    expect(await set('ticketLinkType = "is blocked by"')).toEqual(['audit']);
    expect(await set('ticketLinkType = Blocks')).toEqual(['audit', 'login']);
    expect(await set('ticketLink IS EMPTY')).toEqual(['closed', 'dashboard', 'export']);
    expect(await set('worklogComment ~ macos')).toEqual(['login']);
    expect(await set('timeEntryDate = 2026-01-21')).toEqual(['login']);
    expect(await set('trackType = software')).toEqual(live);
    expect(await set('trackCategory IS EMPTY')).toEqual(live);
  });

  it('[QRY-002] finds tickets by every custom field type, by name or cf[id]', async () => {
    expect(await set('Points > 4')).toEqual(['audit', 'login']);
    expect(await set(`cf[${fields.Points}] = 3`)).toEqual(['dashboard']);
    expect(await set('Points IS EMPTY')).toEqual(['closed', 'export']);
    expect(await set('Points != 5')).toEqual(['audit', 'dashboard']);
    expect(await set('"Due by" <= 2026-01-31')).toEqual(['login']);
    expect(await set('Deadline > "2026-01-10 09:00"')).toEqual(['login']);
    expect(await set('Team = Red')).toEqual(['login']);
    expect(await set('Team IN (red, green)')).toEqual(['dashboard', 'login']);
    expect(await set('Team != Red')).toEqual(['dashboard']);
    expect(await set('Tags = A')).toEqual(['audit', 'login']);
    expect(await set('Tags != A')).toEqual(['dashboard']);
    expect(await set('Tags NOT IN (A, C)')).toEqual([]);
    expect(await set('Tags IN (B, C)')).toEqual(['dashboard', 'login']);
    expect(await set('Reviewer = currentUser()')).toEqual(['dashboard']);
    expect(await set('Reviewer = bob@example.com')).toEqual(['login']);
    expect(await set('Notes ~ cookies')).toEqual(['login']);
    expect(await set('Notes !~ cookies')).toEqual(['dashboard']);
    expect(await set('Topics = beta')).toEqual(['login']);
    expect(await set('Topics IS EMPTY')).toEqual(['closed', 'dashboard', 'export']);
    expect(await set('Squad = Support')).toEqual(['login']);
    expect(await set('Stack = Hardware')).toEqual(['login']);
    expect(await set('Stack = Disk')).toEqual(['login']);
    expect(await set('Stack = Software')).toEqual(['dashboard']);
  });

  it('[QRY-002] leaves out empty values unless asked, NOT included (spec 01b 1.1)', async () => {
    // NOT turns the clause around: an empty assignee matches neither form.
    expect(await set('assignee != currentUser()')).toEqual(['dashboard']);
    expect(await set('NOT assignee = currentUser()')).toEqual(['dashboard']);
    expect(await set('NOT (assignee = currentUser() OR assignee IS EMPTY)')).toEqual(['dashboard']);
    expect(await set('assignee != currentUser() OR assignee IS EMPTY')).toEqual([
      'closed',
      'dashboard',
      'export',
    ]);
    expect(await set('NOT labels IN (security)')).toEqual(['dashboard']);
    expect(await set('NOT Points > 4')).toEqual(['dashboard']);
    expect(await set('NOT (type = Bug AND priority = High)')).toEqual([
      'audit',
      'closed',
      'dashboard',
      'export',
    ]);
  });

  it('[QRY-009] orders by any sortable field, empties last, ties by id', async () => {
    expect(await names('')).toEqual(['login', 'dashboard', 'export', 'audit', 'closed']);
    expect(await names('ORDER BY created ASC')).toEqual([
      'closed',
      'audit',
      'export',
      'dashboard',
      'login',
    ]);
    expect(await names('ORDER BY priority DESC')).toEqual([
      'audit',
      'login',
      'closed',
      'dashboard',
      'export',
    ]);
    expect(await names('ORDER BY priority ASC')).toEqual([
      'dashboard',
      'closed',
      'login',
      'audit',
      'export',
    ]);
    expect(await names('ORDER BY assignee ASC, created DESC')).toEqual([
      'login',
      'audit',
      'dashboard',
      'export',
      'closed',
    ]);
    expect(await names('Points IS NOT EMPTY ORDER BY Points DESC')).toEqual([
      'audit',
      'login',
      'dashboard',
    ]);
    // Empties last, then by id in the direction of the last key.
    expect(await names('ORDER BY Points ASC')).toEqual([
      'dashboard',
      'login',
      'audit',
      'export',
      'closed',
    ]);
    expect(await names('ORDER BY Team ASC')).toEqual([
      'login',
      'dashboard',
      'export',
      'audit',
      'closed',
    ]);
    expect(await names('ORDER BY Reviewer DESC')).toEqual([
      'login',
      'dashboard',
      'closed',
      'audit',
      'export',
    ]);
    expect(await names('ORDER BY key ASC')).toEqual([
      'login',
      'dashboard',
      'export',
      'closed',
      'audit',
    ]);
    expect(await names('ORDER BY summary ASC')).toEqual([
      'closed',
      'dashboard',
      'export',
      'audit',
      'login',
    ]);
    expect(await names('ORDER BY status ASC, created ASC')).toEqual([
      'audit',
      'export',
      'dashboard',
      'login',
      'closed',
    ]);
    expect(await names('ORDER BY due ASC, created DESC')).toEqual([
      'login',
      'dashboard',
      'export',
      'audit',
      'closed',
    ]);
    expect(await names('ORDER BY fixVersion DESC')).toEqual([
      'dashboard',
      'login',
      'closed',
      'audit',
      'export',
    ]);
  });

  it('[QRY-009] pages through results by cursor, each ticket once, while tickets are added', async () => {
    const made: number[] = [];
    for (let i = 0; i < 23; i++) {
      const res = await as('admin', {
        method: 'POST',
        url: '/api/v1/tickets',
        payload: { track: 'DEF', summary: `Filler ${i}` },
      });
      made.push(res.json().ticket.id);
    }
    // Every filler at one instant, so only the id breaks the ties.
    await sql`UPDATE ticket SET created_at = '2025-06-01T00:00:00Z' WHERE id = ANY(${made}::int[])`.execute(
      database.db,
    );
    // A ticket created meanwhile, which sorts before the cursor, is neither repeated nor does it
    // push one out: newest first it is newer, oldest first it is made older.
    const orders = [
      { q: 'summary ~ filler', lateAt: null, before: 23 },
      {
        q: 'summary ~ filler ORDER BY priority DESC, created ASC',
        lateAt: '2025-01-01',
        before: 24,
      },
    ];
    for (const { q, lateAt, before } of orders) {
      const seen: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await as('alice', {
          method: 'GET',
          url: `/api/v1/search?q=${encodeURIComponent(q)}&limit=5${cursor ? `&cursor=${cursor}` : ''}`,
        });
        expect(res.statusCode, res.body).toBe(200);
        const body = res.json() as SearchJson;
        if (pages === 0) expect(body.total).toEqual({ count: before, exact: true });
        else expect(body.total).toBeUndefined();
        seen.push(...body.tickets.map((t) => t.id));
        cursor = body.next;
        if (pages === 1) {
          const late = await as('admin', {
            method: 'POST',
            url: '/api/v1/tickets',
            payload: { track: 'DEF', summary: 'Late filler' },
          });
          if (lateAt) {
            await sql`UPDATE ticket SET created_at = ${lateAt}::timestamptz
              WHERE id = ${late.json().ticket.id}`.execute(database.db);
          }
        }
        pages++;
      } while (cursor);
      const old = seen.filter((id) => made.includes(id));
      expect(pages, q).toBe(5);
      expect(old.length, q).toBe(seen.length - (before - 23));
      expect([...old].sort((a, b) => a - b)).toEqual([...made].sort((a, b) => a - b));
      expect(new Set(seen).size).toBe(seen.length);
    }
    const q = 'summary ~ filler AND created <= "2025-06-01"';
    const first = (await search('alice', q, '&limit=5')).body;
    expect(first.tickets.map((t) => t.id)).toEqual([...made].sort((a, b) => b - a).slice(0, 5));
    const wrong = await search(
      'alice',
      `${q} ORDER BY created ASC`,
      `&limit=5&cursor=${first.next}`,
    );
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_cursor');
  });

  it('[QRY-008] never returns tickets in the trash, in archived tracks or not browsable', async () => {
    expect(await set('summary ~ login', 'alice')).toEqual(['audit', 'login']);
    // Bob does not browse DEF.
    expect(await set('summary ~ login', 'bob')).toEqual(['login']);
    // Erin browses nothing; anonymous visitors neither.
    expect((await search('erin', '')).body).toMatchObject({ tickets: [], total: { count: 0 } });
    expect((await search(null, '')).body).toMatchObject({ tickets: [] });
    // Only a site administrator searches the archive, and only when asking.
    expect(await set('summary ~ login', 'admin')).toEqual(['audit', 'login']);
    const archive = await search('admin', 'summary ~ login', '&archived=true&limit=200');
    expect(archive.body.tickets.map((t) => t.id).sort()).toEqual(
      [ids.archived, ids.audit, ids.login].sort(),
    );
    const notAdmin = await search('alice', 'summary ~ login', '&archived=true&limit=200');
    expect(notAdmin.body.tickets).toHaveLength(2);
    // A key of a ticket one may not see matches nothing and says so.
    const hidden = await search('bob', `key = ${keys.audit}`);
    expect(hidden.body).toMatchObject({ tickets: [], warnings: [`No ticket ${keys.audit}`] });
  });

  it('[QRY-007] [QRY-008] searches only the comments each person reads (M1-018)', async () => {
    const role = async (name: string) =>
      (
        await database.db
          .selectFrom('role')
          .select('id')
          .where('name', '=', name)
          .executeTakeFirstOrThrow()
      ).id;
    const support = await database.db
      .selectFrom('user_group')
      .select('id')
      .where('name', '=', 'Support')
      .executeTakeFirstOrThrow();
    const comment = (
      name: string,
      author: Person,
      text: string,
      extra: { visible_role_id?: number; visible_group_id?: number; deleted_at?: Date } = {},
    ) => ({
      workspace_id: 1,
      ticket_id: ids[name] as number,
      author_id: users[author].id,
      body: JSON.stringify(doc(text)),
      ...extra,
    });
    await database.db
      .insertInto('ticket_comment')
      .values([
        comment('login', 'bob', 'Reproduced in incognito windows'),
        comment('dashboard', 'admin', 'Ask the vendor about caching', {
          visible_group_id: support.id,
        }),
        comment('export', 'admin', 'Escalate internally', {
          visible_role_id: await role('Administrators'),
        }),
        comment('closed', 'alice', 'Personal reminder note', {
          visible_role_id: await role('Administrators'),
        }),
        comment('audit', 'alice', 'Shred everything', { deleted_at: new Date() }),
      ])
      .execute();
    expect(await set('comment ~ incognito')).toEqual(['login']);
    // A group's comment: bob is in Support, alice is not.
    expect(await set('comment ~ vendor')).toEqual([]);
    expect(await set('comment ~ vendor', 'bob')).toEqual(['dashboard']);
    expect(await set('text ~ vendor', 'bob')).toEqual(['dashboard']);
    expect(await set('text ~ vendor')).toEqual([]);
    // A role's comment: the administrators' role, which the site administrator holds here.
    expect(await set('comment ~ escalate')).toEqual([]);
    expect(await set('comment ~ escalate', 'admin')).toEqual(['export']);
    // Authors read their own restricted comments; deleted comments are nobody's.
    expect(await set('comment ~ reminder')).toEqual(['closed']);
    expect(await set('comment ~ reminder', 'bob')).toEqual([]);
    expect(await set('comment ~ shred', 'admin')).toEqual([]);
    expect(await set('comment ~ shred')).toEqual([]);
    // Empties count only the comments the person reads.
    expect(await set('comment IS NOT EMPTY')).toEqual(['closed', 'login']);
    expect(await set('comment IS NOT EMPTY', 'bob')).toEqual(['dashboard', 'login']);
    expect(await set('comment IS EMPTY AND track = ABC', 'bob')).toEqual(['closed', 'export']);
    expect(await set('comment !~ incognito')).toEqual(['closed']);
  });

  it('[QRY-004] [QRY-006] answers the functions of batch 1 for the person asking (M1-038)', async () => {
    const live = ['audit', 'closed', 'dashboard', 'export', 'login'];
    // The tickets of the fixture only (other tests add their own).
    const set = async (q: string, who: Person = 'alice') =>
      (await names(q, who)).filter((n) => !n.startsWith('#')).sort();
    // Following and votes: bob follows login and dashboard, votes for audit (which he cannot
    // see: DEF is not his).
    expect(await set('key IN followedTickets()', 'bob')).toEqual(['dashboard', 'login']);
    expect(await set('issue IN watchedIssues()', 'alice')).toEqual(['login']);
    expect(await set('key IN votedTickets()', 'alice')).toEqual([]);
    expect(await set('key IN votedTickets()', 'bob')).toEqual([]);
    expect(await set('key NOT IN followedTickets()', 'bob')).toEqual(['closed', 'export']);
    // Recently viewed: what the person opened (the home page's visits).
    const opened = await as('alice', {
      method: 'PUT',
      url: `/api/v1/me/recent-tickets/${ids.dashboard}`,
    });
    expect(opened.statusCode, opened.body).toBe(204);
    expect(await set('key IN ticketHistory()', 'alice')).toEqual(['dashboard']);
    expect(await set('parent IN issueHistory()', 'alice')).toEqual(['export']);
    expect(await set('key IN ticketHistory()', 'bob')).toEqual([]);
    // Links, read from the given ticket's side: login blocks audit.
    expect(await set(`key IN linkedTickets(${keys.login})`, 'alice')).toEqual(['audit']);
    expect(await set(`key IN linkedIssues(${keys.audit}, "is blocked by")`, 'alice')).toEqual([
      'login',
    ]);
    expect(await set(`key IN linkedTickets(${keys.audit}, "blocks")`, 'alice')).toEqual([]);
    expect(await set(`key IN linkedTickets(${keys.login}, Blocks)`, 'alice')).toEqual(['audit']);
    // A ticket bob cannot see links to nothing he can learn of.
    const hidden = await search('bob', `key IN linkedTickets(${keys.audit})`);
    expect(hidden.body).toMatchObject({ tickets: [], warnings: [`No ticket ${keys.audit}`] });
    // People and groups: Support holds bob.
    expect(await set('assignee IN membersOf(Support)', 'alice')).toEqual(['dashboard']);
    expect(await set('assignee NOT IN membersOf(support)', 'alice')).toEqual(['audit', 'login']);
    expect(await set('key IN updatedBy(Admin)', 'alice')).toEqual(live);
    // Comments count where the person reads them: alice's note on closed (in the comment test
    // above) is shown to administrators and its author only; her comment on audit is deleted.
    expect(await set('key IN updatedBy(alice, -1d)', 'alice')).toEqual(['closed']);
    expect(await set('key IN updatedBy(alice, -1d)', 'bob')).toEqual([]);
    expect(await set('key IN updatedBy(erin)', 'alice')).toEqual([]);
    // Tracks by permission, role and owner; types; options of a select and a cascade.
    expect(await set('track IN tracksWhereUserHasPermission("Browse projects")', 'bob')).toEqual([
      'closed',
      'dashboard',
      'export',
      'login',
    ]);
    expect(await set('project IN projectsWhereUserHasRole(Members)', 'alice')).toEqual(live);
    expect(await set('track IN tracksWhereUserHasRole(Members)', 'bob')).toEqual([
      'closed',
      'dashboard',
      'export',
      'login',
    ]);
    expect(await set('track IN tracksOwnedByUser()', 'alice')).toEqual([]);
    expect(await set('type IN subticketTypes()', 'alice')).toEqual(['export']);
    expect(await set('type IN standardIssueTypes()', 'alice')).toEqual(
      live.filter((n) => n !== 'export'),
    );
    expect(await set('Stack IN cascadeOption(Hardware)', 'alice')).toEqual(['login']);
    expect(await set('Stack IN cascadeOption(Hardware, Disk)', 'alice')).toEqual(['login']);
    expect(await set('Stack IN cascadeOption(Hardware, Fan)', 'alice')).toEqual([]);
    expect(await set('Team IN choiceOption(Green, Blue)', 'alice')).toEqual(['dashboard']);
    await database.db
      .updateTable('area')
      .set({ owner_id: users.bob.id })
      .where('name', '=', 'Frontend')
      .execute();
    expect(await set('component IN componentsLeadByUser(bob)', 'alice')).toEqual(['dashboard']);
    expect(await set('area IN areasOwnedByUser()', 'bob')).toEqual(['dashboard']);
    // Sign-ins: every ticket was made before this session started.
    expect(await set('created <= currentLogin()', 'alice')).toEqual(live);
    expect(await set('created > lastLogin()', 'alice')).toEqual([]);
    // Dates on the person's clock: login was made at 12:00 UTC on 20 January, which is 02:00
    // on 21 January at UTC+14.
    expect(await set('created >= "2026-01-21"', 'alice')).toEqual([]);
    await database.db
      .updateTable('app_user')
      .set({ time_zone: 'Pacific/Kiritimati' })
      .where('id', '=', users.alice.id)
      .execute();
    expect(await set('created >= "2026-01-21"', 'alice')).toEqual(['login']);
    await database.db
      .updateTable('app_user')
      .set({ time_zone: null })
      .where('id', '=', users.alice.id)
      .execute();
  });

  it('[QRY-004] refuses functions it cannot answer, naming the argument or module', async () => {
    const refused = async (q: string) => {
      const { status, body } = await search('alice', q);
      expect(status, q).toBe(400);
      return body;
    };
    // Teams since M1-123: an id that names no team is refused like an unknown group.
    expect(await refused('assignee IN membersOf("id:7c1d")')).toMatchObject({
      error: 'invalid_query',
      message: 'No team "7c1d"',
    });
    expect(await refused('assignee IN membersOf(Nobody)')).toMatchObject({
      error: 'invalid_query',
      message: '"group" has no value "Nobody"',
    });
    // Sprint and release functions run since M1-045 (sprint.run.test.ts).
    expect((await refused('track IN tracksWhereUserHasPermission(fly)')).message).toBe(
      'No track permission "fly"',
    );
    expect((await refused('key IN linkedTickets(ABC-1, "unblocks")')).message).toBe(
      'No link type "unblocks"',
    );
    expect(await refused('assignee IN membersOf()')).toMatchObject({
      error: 'invalid_query',
      message: 'membersOf() needs its group (the first argument)',
    });
    expect((await refused('ticketLink IN linkedTickets(ABC-1)')).error).toBe('unsupported_query');
  });

  it('[QRY-002] refuses what cannot run yet, naming the field or module', async () => {
    const refused = async (q: string) => {
      const { status, body } = await search('alice', q);
      expect(status, q).toBe(400);
      return body;
    };
    expect(await refused('journey = 3')).toMatchObject({
      error: 'unsupported_query',
      message: '"journey" belongs to journeys, which this version does not have yet',
    });
    expect((await refused('requestType = x')).message).toContain('service tracks');
    // Saved searches run since M1-063: an unknown one reads as missing.
    expect((await refused('filter = 10')).message).toBe('Saved search "10" does not exist');
    // History runs since M1-039; sprint changes are kept apart and not read by it yet.
    expect((await refused('sprint CHANGED')).message).toContain('do not read sprint changes yet');
    expect((await refused('lastViewed > -1d')).message).toBe('"lastViewed" is not recorded yet');
    expect((await refused('status = Nonsense')).message).toBe('"status" has no value "Nonsense"');
    expect((await refused('Team = Purple')).message).toContain('has no option "Purple"');
    expect((await refused('assignee = nobody@example.com')).message).toBe(
      'No person "nobody@example.com"',
    );
    expect((await refused('ORDER BY track')).message).toBe('Results cannot be ordered by "track"');
    expect(await refused('status = ')).toMatchObject({ error: 'invalid_query', position: 9 });
    expect((await refused('status IN (Closed')).error).toBe('invalid_query');
  });

  it('[QRY-010] shows site administrators the statement with the permission filter and its plan', async () => {
    const forbidden = await as('alice', {
      method: 'GET',
      url: `/api/v1/admin/search/explain?q=${encodeURIComponent('track = ABC')}`,
    });
    expect(forbidden.statusCode).toBe(403);
    const res = await as('admin', {
      method: 'GET',
      url: `/api/v1/admin/search/explain?q=${encodeURIComponent('summary ~ "x; DROP TABLE ticket" AND track = ABC')}&analyze=true`,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { sql: string; parameters: unknown[]; plan: unknown[] };
    expect(body.sql).toContain('k.deleted_at IS NULL');
    // The archive is closed to this search, so the filter names the tracks it may read.
    expect(body.sql).toContain('k.track_id = ANY(');
    expect(body.sql).not.toContain('DROP');
    // A text search is one parameter: its words as tsquery operands (M1-040).
    expect(body.parameters).toContain("'x;' & 'DROP' & 'TABLE' & 'ticket'");
    expect(JSON.stringify(body.plan)).toContain('Actual Rows');
  });

  it('[QRY-002] takes long queries by POST and returns the fields asked for', async () => {
    const res = await as('alice', {
      method: 'POST',
      url: '/api/v1/search',
      payload: {
        q: `key IN (${Array.from({ length: 1000 }, (_, i) => `ABC-${i + 1}`).join(', ')})`,
        fields: ['summary', `cf[${fields.Points}]`],
        limit: 2,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as SearchJson;
    expect(body.total).toEqual({ count: 4, exact: true });
    expect(body.tickets[0]).toEqual({
      id: ids.login,
      key: keys.login,
      summary: 'Login fails on Safari',
      fields: { [String(fields.Points)]: 5 },
    });
    const unknown = await as('alice', {
      method: 'GET',
      url: '/api/v1/search?q=&fields=summary,nonsense',
    });
    expect(unknown.statusCode).toBe(400);
  });
  // Last: it adds 20,000 tickets, enough work that a 1 ms timeout always stops the query, also
  // where the server's timers fire late (Windows: about every 15 ms). Writing them takes a few
  // seconds alone and over a minute while other suites load the machine, hence the long limit.
  it('[QRY-010] stops a query over the timeout with a clear error', {
    timeout: 180_000,
  }, async () => {
    const type = await database.db
      .selectFrom('ticket_type')
      .select('id')
      .where('name', '=', 'Feature')
      .executeTakeFirstOrThrow();
    const status = await database.db
      .selectFrom('status')
      .select('id')
      .where('name', '=', 'New')
      .executeTakeFirstOrThrow();
    await sql`INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, status_id, summary,
        description, rank)
      SELECT 1, ${tracks.DEF}, 1000 + g, ${type.id}, ${status.id}, 'Bulk ' || g,
        jsonb_build_object('type', 'doc', 'content', jsonb_build_array(jsonb_build_object(
          'type', 'paragraph', 'content', jsonb_build_array(jsonb_build_object(
            'type', 'text', 'text', 'Some words about item ' || g))))),
        'zz' || lpad(g::text, 8, '0')
        FROM generate_series(1, 20000) AS g`.execute(database.db);
    // Every ticket matches and the order has no index: the whole track is read and sorted.
    const q = 'summary !~ nothingmatches AND description !~ nothingmatches ORDER BY summary ASC';
    const res = await as(
      'alice',
      { method: 'GET', url: `/api/v1/search?q=${encodeURIComponent(q)}` },
      slowApp,
    );
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json()).toMatchObject({ error: 'query_timeout', timeoutMs: 1 });
  });
});
