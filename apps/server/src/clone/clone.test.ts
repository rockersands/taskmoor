import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { LocalStore } from '@taskmoor/storage';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { type AttachmentStores, storesOf } from '../attachments/stores';
import { SESSION_COOKIE } from '../auth';
import { Authorizer } from '../authz/authorizer';
import { registerBulkJobs } from '../bulk/jobs';
import { JobRunner } from '../events/queue';
import { FieldCatalogs } from '../fields/catalog';
import { multipartFile } from '../testing/multipart';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.75.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface Operation {
  id: number;
  action: string;
  status: string;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  params: Record<string, unknown>;
}
interface Item {
  position: number;
  ref: string;
  key: string | null;
  outcome: string;
  statusCode: number | null;
  error: { error?: string; fields?: Record<string, string> } | null;
  result: {
    ticket: { id: number; key: string };
    attachments: number;
    links: number;
    webLinks: number;
    left: string[];
  } | null;
}
interface Ticket {
  id: number;
  key: string;
  summary: string;
  track: { key: string };
  ticketType: { id: number; name: string };
  parent: { id: number; key: string | null } | null;
  labels: string[];
  description: unknown;
  assignee: { id: number } | null;
  priority: { id: number } | null;
  status: { name: string };
}
interface Link {
  phrase: string;
  type: { name: string };
  ticket: { key: string };
}

/**
 * Clone and deep clone (M1-124; CORE-023): a clone runs as a bulk operation of its own, ticket
 * by ticket through the create route as the person who asked. Alice is a Member of tracks CA,
 * CB and CC and a Viewer of CV; the admin set up the configuration.
 */
describe('clone and deep clone (M1-124)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let runner: JobRunner;
  let stores: AttachmentStores;
  let files: string;
  const users: Record<string, { id: number; cookie: string }> = {};
  const roles: Record<string, number> = {};
  const types: Record<string, number> = {};

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const post = (who: string, url: string, payload?: Record<string, unknown>) =>
    as(who, { method: 'POST', url, ...(payload ? { payload } : {}) });
  const get = (who: string, url: string) => as(who, { method: 'GET', url });

  async function track(key: string, members: [string, string][], extra: object = {}) {
    const res = await post('admin', '/api/v1/tracks', { key, name: key, mode: 'shared', ...extra });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().track.id as number;
    for (const [who, role] of members) {
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: id,
          role_id: roles[role] as number,
          user_id: users[who]?.id as number,
        })
        .execute();
    }
    return id;
  }
  async function ticket(who: string, body: Record<string, unknown>): Promise<Ticket> {
    const res = await post(who, '/api/v1/tickets', body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().ticket;
  }
  const read = async (key: string) =>
    (await get('alice', `/api/v1/tickets/${key}`)).json().ticket as Ticket;
  const links = async (key: string) =>
    (await get('alice', `/api/v1/tickets/${key}/links`)).json() as {
      links: Link[];
      webLinks: { url: string; title: string }[];
    };
  /** Runs queued jobs until none is left, as a worker would. */
  async function drain() {
    for (let i = 0; i < 100; i++) {
      if ((await runner.runOnce()) === 0) return;
    }
  }
  async function clone(who: string, key: string, body: Record<string, unknown> = {}) {
    const res = await post(who, `/api/v1/tickets/${key}/clone`, body);
    expect(res.statusCode, res.body).toBe(202);
    const op = res.json().bulkOperation as Operation;
    await drain();
    const done = (await get(who, `/api/v1/bulk-operations/${op.id}`)).json()
      .bulkOperation as Operation;
    const items = (await get(who, `/api/v1/bulk-operations/${op.id}/items`)).json().items as Item[];
    return { op: done, items };
  }
  const copyOf = (items: Item[], ref: string) => {
    const item = items.find((i) => i.ref === ref);
    expect(item?.outcome, JSON.stringify(item)).toBe('done');
    return item?.result?.ticket.key as string;
  };

  beforeAll(async () => {
    files = mkdtempSync(join(tmpdir(), 'taskmoor-clone-'));
    stores = storesOf(await LocalStore.open(files));
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      attachments: stores,
    });
    runner = new JobRunner(database.db, 'clone-test');
    registerBulkJobs(
      runner,
      database.db,
      new Authorizer(database.db),
      new FieldCatalogs(database.db),
      {
        stores,
      },
    );
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['bob', false],
    ] as const) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
          password_hash: hash,
          is_site_admin: admin,
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
    for (const role of await database.db.selectFrom('role').select(['id', 'name']).execute()) {
      roles[role.name] = role.id;
    }
    // A level above Outcome, so a tree three levels deep hangs under one ticket (CORE-006).
    const level = await post('admin', '/api/v1/hierarchy-levels', { name: 'Objective' });
    expect(level.statusCode, level.body).toBe(201);
    const objective = await post('admin', '/api/v1/ticket-types', {
      name: 'Objective',
      levelId: level.json().level.id,
    });
    expect(objective.statusCode, objective.body).toBe(201);
    const all = (await get('admin', '/api/v1/ticket-types')).json().ticketTypes as {
      id: number;
      name: string;
    }[];
    for (const t of all) types[t.name] = t.id;
    const set = await post('admin', '/api/v1/type-sets', {
      name: 'Clone types',
      ticketTypeIds: ['Objective', 'Outcome', 'Feature', 'Bug', 'Chore', 'Subticket'].map(
        (name) => types[name] as number,
      ),
      defaultTypeId: types.Feature,
    });
    expect(set.statusCode, set.body).toBe(201);
    const typeSetId = set.json().typeSet.id as number;
    await track(
      'CA',
      [
        ['alice', 'Members'],
        ['bob', 'Members'],
      ],
      { typeSetId },
    );
    await track('CB', [['alice', 'Members']], { typeSetId });
    await track('CV', [['alice', 'Viewers']], { typeSetId });
    // A business track offers none of the software types but Subticket.
    await track('CC', [['alice', 'Members']], { type: 'business' });
  });
  afterAll(async () => {
    await app.close();
    rmSync(files, { recursive: true, force: true });
  });

  it('[CORE-033] (3) copies the checklists with every item open again, and leaves the original alone', async () => {
    const source = await ticket('alice', { track: 'CA', summary: 'With a checklist' });
    const made = await post('alice', `/api/v1/tickets/${source.key}/checklists`, {
      name: 'Steps',
      items: ['First', 'Second', 'Third'],
    });
    expect(made.statusCode, made.body).toBe(201);
    const list = made.json().checklists[0] as { id: number; items: { id: number }[] };
    for (const [i, state] of ['done', 'rejected'].entries()) {
      const res = await as('alice', {
        method: 'PATCH',
        url: `/api/v1/tickets/${source.key}/checklists/${list.id}/items/${list.items[i]?.id}`,
        payload: { state },
      });
      expect(res.statusCode, res.body).toBe(200);
    }
    const { items } = await clone('alice', source.key);
    const copyKey = copyOf(items, source.key);
    const copy = (await get('alice', `/api/v1/tickets/${copyKey}/checklists`)).json();
    expect(copy.checklists).toMatchObject([
      {
        name: 'Steps',
        items: [
          { text: 'First', state: 'open' },
          { text: 'Second', state: 'open' },
          { text: 'Third', state: 'open' },
        ],
      },
    ]);
    expect(copy.progress).toEqual({ done: 0, counted: 3, percent: 0 });
    const original = (await get('alice', `/api/v1/tickets/${source.key}/checklists`)).json();
    expect(original.progress).toEqual({ done: 1, counted: 2, percent: 50 });
  });

  it('[CORE-023] (1) clones a ticket with its subtickets, attachments and links, each copy linked to its original by Copies', async () => {
    const other = await ticket('alice', { track: 'CA', summary: 'Payments API is down' });
    const priority = (await get('alice', '/api/v1/priorities')).json().priorities[0].id as number;
    const description = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Steps to reproduce' }] }],
    };
    const source = await ticket('alice', {
      track: 'CA',
      summary: 'Refunds fail',
      description,
      labels: ['payments', 'urgent'],
      assigneeId: users.alice?.id,
      priorityId: priority,
    });
    const subs = [
      await ticket('alice', {
        track: 'CA',
        summary: 'Find the cause',
        parent: source.key,
        ticketTypeId: types.Subticket,
      }),
      await ticket('alice', {
        track: 'CA',
        summary: 'Write the fix',
        parent: source.key,
        ticketTypeId: types.Subticket,
      }),
    ];
    // A subticket in the trash stays behind.
    const trashed = await ticket('alice', {
      track: 'CA',
      summary: 'Abandoned idea',
      parent: source.key,
      ticketTypeId: types.Subticket,
    });
    expect(
      (await as('admin', { method: 'DELETE', url: `/api/v1/tickets/${trashed.key}` })).statusCode,
    ).toBe(204);
    const blocks = (await get('alice', '/api/v1/link-types'))
      .json()
      .linkTypes.find((t: { name: string }) => t.name === 'Blocks').id as number;
    expect(
      (
        await post('alice', `/api/v1/tickets/${source.key}/links`, {
          linkTypeId: blocks,
          ticket: other.key,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await post('alice', `/api/v1/tickets/${source.key}/web-links`, {
          url: 'https://status.example.com/incidents/42',
          title: 'Incident 42',
        })
      ).statusCode,
    ).toBe(201);
    const upload = multipartFile('trace.txt', 'text/plain', 'refund trace: card expired\n');
    const attached = await as('alice', {
      method: 'POST',
      url: `/api/v1/tickets/${subs[0]?.key}/attachments`,
      ...upload,
    });
    expect(attached.statusCode, attached.body).toBe(201);
    const onSource = await as('alice', {
      method: 'POST',
      url: `/api/v1/tickets/${source.key}/attachments`,
      ...multipartFile('screen.txt', 'text/plain', 'what the person saw'),
    });
    expect(onSource.statusCode, onSource.body).toBe(201);

    const { op, items } = await clone('alice', source.key);
    expect(op).toMatchObject({
      action: 'clone',
      status: 'done',
      total: 3,
      succeeded: 3,
      failed: 0,
    });
    expect(op.params).toMatchObject({
      key: source.key,
      trackKey: 'CA',
      subtickets: true,
      attachments: true,
      links: true,
    });
    expect(items.map((i) => i.ref)).toEqual([source.key, subs[0]?.key, subs[1]?.key]);

    const copyKey = copyOf(items, source.key);
    const copy = await read(copyKey);
    expect(copy).toMatchObject({
      summary: 'Refunds fail',
      track: { key: 'CA' },
      ticketType: { id: source.ticketType.id },
      parent: null,
      labels: ['payments', 'urgent'],
      description,
      assignee: { id: users.alice?.id },
      priority: { id: priority },
    });
    expect(items[0]?.result).toMatchObject({ attachments: 1, links: 1, webLinks: 1, left: [] });
    const copied = await links(copyKey);
    expect(copied.links.map((l) => `${l.phrase} ${l.ticket.key}`).sort()).toEqual(
      [`blocks ${other.key}`, `copies ${source.key}`].sort(),
    );
    expect(copied.webLinks).toMatchObject([
      { url: 'https://status.example.com/incidents/42', title: 'Incident 42' },
    ]);
    // The original reads the link from its side.
    expect((await links(source.key)).links.map((l) => `${l.phrase} ${l.ticket.key}`)).toContain(
      `is copied by ${copyKey}`,
    );
    // The subtickets' copies sit under the copy, each copying its own original, with its file.
    for (const sub of subs) {
      const subCopy = await read(copyOf(items, sub.key));
      expect(subCopy.parent?.key).toBe(copyKey);
      expect(subCopy.summary).toBe(sub.summary);
      expect((await links(subCopy.key)).links.map((l) => `${l.phrase} ${l.ticket.key}`)).toEqual([
        `copies ${sub.key}`,
      ]);
    }
    const subCopyKey = copyOf(items, subs[0]?.key as string);
    const fileList = (await get('alice', `/api/v1/tickets/${subCopyKey}/attachments`)).json()
      .attachments as { id: number; name: string; sha256: string; scan: string }[];
    expect(fileList).toMatchObject([
      { name: 'trace.txt', sha256: attached.json().attachment.sha256, scan: 'clean' },
    ]);
    const bytes = await get(
      'alice',
      `/api/v1/tickets/${subCopyKey}/attachments/${fileList[0]?.id}/content`,
    );
    expect(bytes.body).toBe('refund trace: card expired\n');
    // Separate files: deleting the copy's leaves the original's.
    expect(
      (
        await as('alice', {
          method: 'DELETE',
          url: `/api/v1/tickets/${subCopyKey}/attachments/${fileList[0]?.id}`,
        })
      ).statusCode,
    ).toBe(204);
    const original = await get(
      'alice',
      `/api/v1/tickets/${subs[0]?.key}/attachments/${attached.json().attachment.id}/content`,
    );
    expect(original.body).toBe('refund trace: card expired\n');
    // The copy's history shows what came with it, as Alice's changes.
    const history = (
      await get('alice', `/api/v1/tickets/${copyKey}/history?order=asc&limit=200`)
    ).json().changes as { field: string; actor: { id: number }; to: { display: string | null } }[];
    expect(
      history
        .filter((c) => c.field === 'link')
        .map((c) => c.to.display)
        .sort(),
    ).toEqual([`blocks ${other.key}`, `copies ${source.key}`].sort());
    expect(history.find((c) => c.field === 'attachment')?.to.display).toBe('screen.txt');
    expect(history.every((c) => c.actor?.id === users.alice?.id)).toBe(true);
    // A new ticket in its workflow's first status.
    expect(copy.status.name).toBe((await read(source.key)).status.name);
  });

  it('[CORE-023] (2) deep-clones a ticket and three levels below it into another track, links between copies kept', async () => {
    const objective = await ticket('alice', {
      track: 'CA',
      summary: 'Grow card payments',
      ticketTypeId: types.Objective,
    });
    const outcome = await ticket('alice', {
      track: 'CA',
      summary: 'Checkout in one step',
      ticketTypeId: types.Outcome,
      parent: objective.key,
    });
    const features = [
      await ticket('alice', {
        track: 'CA',
        summary: 'Saved cards',
        ticketTypeId: types.Feature,
        parent: outcome.key,
      }),
      await ticket('alice', {
        track: 'CA',
        summary: 'Wallet buttons',
        ticketTypeId: types.Feature,
        parent: outcome.key,
      }),
    ];
    const subtickets = [
      await ticket('alice', {
        track: 'CA',
        summary: 'Card vault',
        ticketTypeId: types.Subticket,
        parent: features[0]?.key,
      }),
      await ticket('alice', {
        track: 'CA',
        summary: 'Wallet SDK',
        ticketTypeId: types.Subticket,
        parent: features[1]?.key,
      }),
    ];
    const relates = (await get('alice', '/api/v1/link-types'))
      .json()
      .linkTypes.find((t: { name: string }) => t.name === 'Relates').id as number;
    await post('alice', `/api/v1/tickets/${features[0]?.key}/links`, {
      linkTypeId: relates,
      ticket: features[1]?.key,
    });

    const { op, items } = await clone('alice', objective.key, { descendants: true, track: 'CB' });
    expect(op).toMatchObject({ status: 'done', total: 6, succeeded: 6, failed: 0 });
    // Parents before children, children in rank order, depth first.
    expect(items.map((i) => i.ref)).toEqual([
      objective.key,
      outcome.key,
      features[0]?.key,
      subtickets[0]?.key,
      features[1]?.key,
      subtickets[1]?.key,
    ]);
    const copies = items.map((i) => i.result?.ticket.key as string);
    for (const key of copies) expect(key).toMatch(/^CB-\d+$/);
    const [o, e, f1, s1, f2, s2] = await Promise.all(copies.map(read));
    expect(o?.parent).toBeNull();
    expect(e?.parent?.key).toBe(o?.key);
    expect(f1?.parent?.key).toBe(e?.key);
    expect(f2?.parent?.key).toBe(e?.key);
    expect(s1?.parent?.key).toBe(f1?.key);
    expect(s2?.parent?.key).toBe(f2?.key);
    expect([o, e, f1, s1, f2, s2].map((t) => t?.ticketType.name)).toEqual([
      'Objective',
      'Outcome',
      'Feature',
      'Subticket',
      'Feature',
      'Subticket',
    ]);
    // The copies relate to each other, not to the originals; each copies its own original.
    expect(
      (await links(f1?.key as string)).links.map((l) => `${l.phrase} ${l.ticket.key}`).sort(),
    ).toEqual([`copies ${features[0]?.key}`, `relates to ${f2?.key}`].sort());
    expect(
      (await links(f2?.key as string)).links.map((l) => `${l.phrase} ${l.ticket.key}`).sort(),
    ).toEqual([`copies ${features[1]?.key}`, `relates to ${f1?.key}`].sort());
    // The originals stay as they were.
    expect((await read(outcome.key)).parent?.key).toBe(objective.key);

    // An outcome alone takes its features and their subtickets.
    const again = await clone('alice', outcome.key, {
      descendants: true,
      track: 'CB',
      summary: 'Checkout, again',
    });
    expect(again.op).toMatchObject({ status: 'done', total: 5, succeeded: 5 });
    const outcomeCopy = await read(copyOf(again.items, outcome.key));
    expect(outcomeCopy.summary).toBe('Checkout, again');
    // It keeps its place: under the original objective, which may parent across tracks.
    expect(outcomeCopy.parent?.key).toBe(objective.key);
  });

  it('[CORE-023] clones only what is asked for, and leaves out values the person may not set', async () => {
    const source = await ticket('alice', {
      track: 'CA',
      summary: 'Plain copy',
      assigneeId: users.bob?.id,
    });
    await ticket('alice', {
      track: 'CA',
      summary: 'Its part',
      parent: source.key,
      ticketTypeId: types.Subticket,
    });
    await as('alice', {
      method: 'POST',
      url: `/api/v1/tickets/${source.key}/attachments`,
      ...multipartFile('notes.txt', 'text/plain', 'notes'),
    });
    // Bob can no longer be assigned: the copy is made without him.
    await database.db
      .updateTable('app_user')
      .set({ deactivated_at: new Date() })
      .where('id', '=', users.bob?.id as number)
      .execute();
    try {
      const { op, items } = await clone('alice', source.key, {
        subtickets: false,
        attachments: false,
        links: false,
      });
      expect(op).toMatchObject({ total: 1, succeeded: 1 });
      expect(items[0]?.result).toMatchObject({
        attachments: 0,
        links: 0,
        webLinks: 0,
        left: ['assigneeId'],
      });
      const copyKey = copyOf(items, source.key);
      expect((await read(copyKey)).assignee).toBeNull();
      // Without links asked for, the Copies link is still made.
      expect((await links(copyKey)).links.map((l) => l.phrase)).toEqual(['copies']);
      expect((await get('alice', `/api/v1/tickets?parent=${copyKey}`)).json().tickets).toEqual([]);
      expect(
        (await get('alice', `/api/v1/tickets/${copyKey}/attachments`)).json().attachments,
      ).toEqual([]);
    } finally {
      await database.db
        .updateTable('app_user')
        .set({ deactivated_at: null })
        .where('id', '=', users.bob?.id as number)
        .execute();
    }
  });

  it('[CORE-023][CORE-015][CORE-016] copies a custom release or area field without its archived values, as the system fields (T-282)', async () => {
    const made = async (url: string, payload: Record<string, unknown> = {}) => {
      const res = await post('admin', url, payload);
      expect(res.statusCode, res.body).toBeLessThan(300);
      return res.json();
    };
    const ca = (
      await database.db
        .selectFrom('track')
        .select('id')
        .where('key', '=', 'CA')
        .executeTakeFirstOrThrow()
    ).id;
    const open = (await made(`/api/v1/tracks/${ca}/releases`, { name: 'C1' })).release;
    const old = (await made(`/api/v1/tracks/${ca}/releases`, { name: 'C0' })).release;
    const legacy = (await made(`/api/v1/tracks/${ca}/areas`, { name: 'Old wing' })).area;
    const shippedIn = (
      await made('/api/v1/fields', { name: 'Shipped in', type: 'release', multiple: true })
    ).field.id as number;
    const keptBy = (await made('/api/v1/fields', { name: 'Kept by', type: 'area' })).field
      .id as number;
    const source = await ticket('alice', {
      track: 'CA',
      summary: 'Shipped twice',
      targetReleaseIds: [open.id, old.id],
      fields: { [shippedIn]: [open.id, old.id], [keptBy]: legacy.id },
    });
    await made(`/api/v1/releases/${old.id}/archive`);
    await made(`/api/v1/areas/${legacy.id}/archive`);
    const { op, items } = await clone('alice', source.key, {
      subtickets: false,
      attachments: false,
      links: false,
    });
    expect(op).toMatchObject({ total: 1, succeeded: 1 });
    // The archived ones are left out quietly, as from Target releases; the open one is copied.
    expect(items[0]?.result?.left).toEqual([]);
    const copy = (await get('alice', `/api/v1/tickets/${copyOf(items, source.key)}`)).json()
      .ticket as {
      targetReleases: { id: number }[];
      fields: Record<string, unknown>;
    };
    expect(copy.targetReleases.map((r) => r.id)).toEqual([open.id]);
    expect(copy.fields[shippedIn]).toEqual([{ id: open.id, name: 'C1' }]);
    expect(copy.fields).not.toHaveProperty(String(keptBy));
  });

  it('[CORE-023] refuses a clone the person may not make, and one over the workspace limit', async () => {
    const source = await ticket('alice', { track: 'CA', summary: 'Guarded' });
    const sub = await ticket('alice', {
      track: 'CA',
      summary: 'Guarded part',
      parent: source.key,
      ticketTypeId: types.Subticket,
    });
    const adminsOwn = await ticket('admin', { track: 'CA', summary: 'The admin wrote it' });
    expect((await post('alice', '/api/v1/tickets/CA-999999/clone', {})).statusCode).toBe(404);
    // Viewers of CV may not create there.
    const viewer = await post('alice', `/api/v1/tickets/${source.key}/clone`, { track: 'CV' });
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json()).toEqual({ error: 'forbidden', permission: 'create_tickets' });
    // A track Bob may not browse is not found.
    expect(
      (await post('bob', `/api/v1/tickets/${source.key}/clone`, { track: 'CB' })).json(),
    ).toEqual({
      error: 'invalid_fields',
      fields: { track: 'not_found' },
    });
    // A subticket stays in its parent's track; a summary is checked as for a new ticket.
    expect(
      (await post('alice', `/api/v1/tickets/${sub.key}/clone`, { track: 'CB' })).json(),
    ).toEqual({
      error: 'invalid_fields',
      fields: { track: 'subticket' },
    });
    expect(
      (await post('alice', `/api/v1/tickets/${source.key}/clone`, { summary: ' ' })).json().fields,
    ).toEqual({
      summary: 'required',
    });
    expect(
      (await post('alice', `/api/v1/tickets/${source.key}/clone`, { deep: true })).json().fields,
    ).toEqual({
      deep: 'unknown',
    });
    // Bob, a Member of CA, clones without the global "Make bulk changes".
    await database.db.deleteFrom('global_grant').where('permission', '=', 'bulk_change').execute();
    expect((await post('bob', `/api/v1/tickets/${adminsOwn.key}/clone`, {})).statusCode).toBe(202);
    await drain();
    await database.db
      .insertInto('guardrail_limit')
      .values({ workspace_id: 1, name: 'tickets_per_bulk_operation', value: 1 })
      .execute();
    try {
      const over = await post('alice', `/api/v1/tickets/${source.key}/clone`, {});
      expect(over.statusCode).toBe(400);
      expect(over.json()).toEqual({
        error: 'too_many_tickets',
        max: 1,
        guardrail: 'tickets_per_bulk_operation',
      });
      expect(
        (await post('alice', `/api/v1/tickets/${source.key}/clone`, { subtickets: false }))
          .statusCode,
      ).toBe(202);
      await drain();
    } finally {
      await database.db
        .deleteFrom('guardrail_limit')
        .where('name', '=', 'tickets_per_bulk_operation')
        .execute();
    }
  });

  it('[CORE-023] fails a copy the target track refuses, and the tickets below it with it', async () => {
    const feature = await ticket('alice', {
      track: 'CA',
      summary: 'Software only',
      ticketTypeId: types.Feature,
    });
    const part = await ticket('alice', {
      track: 'CA',
      summary: 'Its part',
      parent: feature.key,
      ticketTypeId: types.Subticket,
    });
    const res = await post('alice', `/api/v1/tickets/${feature.key}/clone`, {
      track: 'CC',
      descendants: true,
    });
    expect(res.statusCode, res.body).toBe(202);
    await drain();
    const id = res.json().bulkOperation.id as number;
    expect(
      (await get('alice', `/api/v1/bulk-operations/${id}`)).json().bulkOperation,
    ).toMatchObject({
      status: 'done',
      succeeded: 0,
      failed: 2,
    });
    const items = (await get('alice', `/api/v1/bulk-operations/${id}/items`)).json()
      .items as Item[];
    expect(items.map((i) => [i.ref, i.statusCode, i.error?.error])).toEqual([
      [feature.key, 400, 'invalid_fields'],
      [part.key, 409, 'parent_not_cloned'],
    ]);
    expect(items[0]?.error?.fields).toEqual({ ticketTypeId: 'not_in_track' });
    expect(items.every((i) => i.result === null)).toBe(true);
  });

  it('[CORE-023] an item cut short after its copy was made goes on from that copy', async () => {
    const source = await ticket('alice', { track: 'CA', summary: 'Interrupted', labels: ['once'] });
    const res = await post('alice', `/api/v1/tickets/${source.key}/clone`, { subtickets: false });
    const id = String(res.json().bulkOperation.id);
    // As if a worker died right after the create route made the copy.
    const made = await ticket('alice', { track: 'CA', summary: 'Interrupted', labels: ['once'] });
    await database.db
      .updateTable('bulk_item')
      .set({ result_ticket_id: made.id, result: JSON.stringify({ left: ['dueDate'] }) })
      .where('operation_id', '=', id)
      .execute();
    const before = await database.db
      .selectFrom('ticket')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    await drain();
    const after = await database.db
      .selectFrom('ticket')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(after.n)).toBe(Number(before.n));
    const items = (await get('alice', `/api/v1/bulk-operations/${id}/items`)).json()
      .items as Item[];
    expect(items[0]).toMatchObject({
      outcome: 'done',
      result: { ticket: { key: made.key }, left: ['dueDate'] },
    });
    expect((await links(made.key)).links.map((l) => `${l.phrase} ${l.ticket.key}`)).toEqual([
      `copies ${source.key}`,
    ]);
  });
});
