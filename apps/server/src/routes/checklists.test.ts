import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { checklistProgress, MAX_ITEMS } from '../tickets/checklists';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.72.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

interface ItemJson {
  id: number;
  text: string;
  state: string;
}
interface ListJson {
  id: number;
  name: string;
  items: ItemJson[];
  progress: { done: number; counted: number; percent: number | null };
}
interface ViewJson {
  checklists: ListJson[];
  progress: { done: number; counted: number; percent: number | null };
  canEdit: boolean;
  lock: unknown;
}

describe('how items make a percentage (CORE-033)', () => {
  const items = (...states: string[]) => states.map((state) => ({ state }));

  it('[CORE-033] (1) leaves a rejected item out: 3 done, 1 open and 1 rejected reads 75%', () => {
    expect(checklistProgress(items('done', 'done', 'done', 'open', 'rejected'))).toEqual({
      done: 3,
      counted: 4,
      percent: 75,
    });
  });

  it('[CORE-033] counts in progress as not done, and rounds to a whole percent', () => {
    expect(checklistProgress(items('done', 'in_progress', 'open'))).toEqual({
      done: 1,
      counted: 3,
      percent: 33,
    });
  });

  it('[CORE-033] has no percentage when nothing counts', () => {
    expect(checklistProgress([]).percent).toBeNull();
    expect(checklistProgress(items('rejected', 'rejected'))).toEqual({
      done: 0,
      counted: 0,
      percent: null,
    });
  });
});

describe('checklists on tickets (CORE-033)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  let trackId = 0;

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const newTicket = async (summary = 'A ticket', track = 'CHK') => {
    const res = await as('alice', {
      method: 'POST',
      url: '/api/v1/tickets',
      payload: { track, summary },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().ticket as { id: number; key: string; version: number; updatedAt: string };
  };
  const lists = (ticket: number) => `/api/v1/tickets/${ticket}/checklists`;
  const addList = async (ticket: number, name: string, items?: string[]) => {
    const res = await as('alice', {
      method: 'POST',
      url: lists(ticket),
      payload: { name, ...(items ? { items } : {}) },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as ViewJson;
  };
  const history = async (ticket: number) =>
    (
      (await as('alice', { method: 'GET', url: `/api/v1/tickets/${ticket}/history?order=asc` }))
        .json().changes as {
        field: string;
        from: { value: string | null; display: string | null };
        to: { value: string | null; display: string | null };
      }[]
    ).filter((c) => c.field.startsWith('checklist'));

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['viewer', false],
      ['nobody', false],
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
      const header = res.headers['set-cookie'];
      const cookies = Array.isArray(header) ? header : header ? [header] : [];
      users[name] = {
        id: row.id,
        cookie: (cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '').split(';')[0] ?? '',
      };
    }
    const track = await as('admin', {
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'CHK', name: 'Checks', mode: 'shared' },
    });
    expect(track.statusCode, track.body).toBe(201);
    trackId = track.json().track.id;
    const roles = await database.db.selectFrom('role').select(['id', 'name']).execute();
    for (const [who, role] of [
      ['alice', 'Members'],
      ['viewer', 'Viewers'],
    ] as const) {
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: trackId,
          role_id: roles.find((r) => r.name === role)?.id as number,
          user_id: users[who]?.id as number,
        })
        .execute();
    }
  });
  afterAll(async () => {
    await app.close();
  });

  it('[CORE-033] holds several named lists, on any ticket type, with progress for each and overall', async () => {
    const ticket = await newTicket();
    expect((await as('alice', { method: 'GET', url: lists(ticket.id) })).json()).toEqual({
      checklists: [],
      progress: { done: 0, counted: 0, percent: null },
      canEdit: true,
      lock: null,
    });
    await addList(ticket.id, 'Before release', ['Write notes', 'Tag it']);
    const view = await addList(ticket.id, 'After release', ['Tell people']);
    expect(view.checklists.map((l) => l.name)).toEqual(['Before release', 'After release']);
    expect(view.checklists[0]?.items.map((i) => [i.text, i.state])).toEqual([
      ['Write notes', 'open'],
      ['Tag it', 'open'],
    ]);
    expect(view.progress).toEqual({ done: 0, counted: 3, percent: 0 });
  });

  it('[CORE-033] (1) has only the four states, and reads 75% for 3 done, 1 open and 1 rejected', async () => {
    const ticket = await newTicket();
    const made = await addList(ticket.id, 'Steps', ['One', 'Two', 'Three', 'Four', 'Five']);
    const list = made.checklists[0] as ListJson;
    const set = (item: ItemJson, state: string) =>
      as('alice', {
        method: 'PATCH',
        url: `${lists(ticket.id)}/${list.id}/items/${item.id}`,
        payload: { state },
      });
    for (const item of list.items.slice(0, 3)) {
      expect((await set(item, 'done')).statusCode).toBe(200);
    }
    const res = await set(list.items[4] as ItemJson, 'rejected');
    const view = res.json() as ViewJson;
    expect(view.checklists[0]?.progress).toEqual({ done: 3, counted: 4, percent: 75 });
    expect(view.progress.percent).toBe(75);
    expect((await set(list.items[3] as ItemJson, 'in_progress')).statusCode).toBe(200);
    expect((await set(list.items[3] as ItemJson, 'blocked')).statusCode).toBe(400);
    expect((await set(list.items[3] as ItemJson, 'closed')).statusCode).toBe(400);
  });

  it('[CORE-033] adds, edits, reorders and removes items and lists, each in the ticket history', async () => {
    const ticket = await newTicket();
    const first = (await addList(ticket.id, 'Plan')).checklists[0] as ListJson;
    const url = `${lists(ticket.id)}/${first.id}`;
    for (const text of ['Alpha', 'Bravo', 'Charlie']) {
      const res = await as('alice', { method: 'POST', url: `${url}/items`, payload: { text } });
      expect(res.statusCode, res.body).toBe(201);
    }
    const read = async () =>
      (
        (await as('alice', { method: 'GET', url: lists(ticket.id) })).json() as ViewJson
      ).checklists.find((l) => l.id === first.id) as ListJson;
    const items = (await read()).items;
    const [a, b, c] = items as [ItemJson, ItemJson, ItemJson];
    expect(
      (
        await as('alice', {
          method: 'PATCH',
          url: `${url}/items/${b.id}`,
          payload: { text: ' Bravo two ' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await as('alice', {
          method: 'PUT',
          url: `${url}/items/order`,
          payload: { ids: [c.id, a.id, b.id] },
        })
      ).statusCode,
    ).toBe(200);
    expect((await read()).items.map((i) => i.text)).toEqual(['Charlie', 'Alpha', 'Bravo two']);
    // An order that does not name exactly the items says the list changed meanwhile.
    const stale = await as('alice', {
      method: 'PUT',
      url: `${url}/items/order`,
      payload: { ids: [c.id, a.id] },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('order_changed');
    expect((await as('alice', { method: 'DELETE', url: `${url}/items/${a.id}` })).statusCode).toBe(
      200,
    );
    expect(
      (await as('alice', { method: 'PATCH', url, payload: { name: 'The plan' } })).statusCode,
    ).toBe(200);

    const second = (await addList(ticket.id, 'Other')).checklists[1] as ListJson;
    expect(
      (
        await as('alice', {
          method: 'PUT',
          url: `${lists(ticket.id)}/order`,
          payload: { ids: [second.id, first.id] },
        })
      ).json().checklists[0].name,
    ).toBe('Other');
    expect((await as('alice', { method: 'DELETE', url })).statusCode).toBe(200);

    const seen = (await history(ticket.id)).map((c) => [c.field, c.from.value, c.to.value]);
    expect(seen).toEqual([
      ['checklist', null, 'Plan'],
      ['checklistItem', null, 'Alpha'],
      ['checklistItem', null, 'Bravo'],
      ['checklistItem', null, 'Charlie'],
      ['checklistItem', 'Bravo', 'Bravo two'],
      ['checklistOrder', 'Alpha, Bravo two, Charlie', 'Charlie, Alpha, Bravo two'],
      ['checklistItem', 'Alpha', null],
      ['checklist', 'Plan', 'The plan'],
      ['checklist', null, 'Other'],
      ['checklistOrder', 'The plan, Other', 'Other, The plan'],
      ['checklist', 'The plan', null],
    ]);
  });

  it('[CORE-033] names the item when its state changes, and records nothing when nothing changed', async () => {
    const ticket = await newTicket();
    const list = (await addList(ticket.id, 'Plan', ['Alpha'])).checklists[0] as ListJson;
    const url = `${lists(ticket.id)}/${list.id}/items/${list.items[0]?.id}`;
    const before = (await history(ticket.id)).length;
    await as('alice', { method: 'PATCH', url, payload: { state: 'done' } });
    await as('alice', { method: 'PATCH', url, payload: { state: 'done' } });
    const after = await history(ticket.id);
    expect(after).toHaveLength(before + 1);
    expect(after[after.length - 1]).toMatchObject({
      field: 'checklistItemState',
      from: { value: 'open', display: 'Alpha' },
      to: { value: 'done', display: 'Alpha' },
    });
  });

  it('[CORE-033] touches the updated time, not the version, so open pages read again', async () => {
    const ticket = await newTicket();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await addList(ticket.id, 'Plan');
    const now = (await as('alice', { method: 'GET', url: `/api/v1/tickets/${ticket.id}` })).json()
      .ticket as { version: number; updatedAt: string };
    expect(now.version).toBe(ticket.version);
    expect(Date.parse(now.updatedAt)).toBeGreaterThan(Date.parse(ticket.updatedAt));
    const logged = await database.db
      .selectFrom('change_log')
      .select('id')
      .where('entity', '=', 'ticket')
      .where('entity_id', '=', ticket.id)
      .execute();
    expect(logged.length).toBeGreaterThanOrEqual(2);
  });

  it('[CORE-033] (2) lets someone without "Edit tickets" read but not change', async () => {
    const ticket = await newTicket();
    const list = (await addList(ticket.id, 'Plan', ['Alpha'])).checklists[0] as ListJson;
    const view = (await as('viewer', { method: 'GET', url: lists(ticket.id) })).json() as ViewJson;
    expect(view.canEdit).toBe(false);
    expect(view.checklists[0]?.items).toHaveLength(1);
    const url = `${lists(ticket.id)}/${list.id}`;
    for (const res of await Promise.all([
      as('viewer', { method: 'POST', url: lists(ticket.id), payload: { name: 'No' } }),
      as('viewer', { method: 'PATCH', url, payload: { name: 'No' } }),
      as('viewer', { method: 'DELETE', url }),
      as('viewer', { method: 'POST', url: `${url}/items`, payload: { text: 'No' } }),
      as('viewer', {
        method: 'PATCH',
        url: `${url}/items/${list.items[0]?.id}`,
        payload: { state: 'done' },
      }),
    ])) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().permission).toBe('edit_tickets');
    }
    // Someone who cannot see the ticket does not learn it exists.
    expect((await as('nobody', { method: 'GET', url: lists(ticket.id) })).statusCode).toBe(404);
    expect(
      (await as('nobody', { method: 'POST', url: lists(ticket.id), payload: { name: 'No' } }))
        .statusCode,
    ).toBe(404);
  });

  it('[CORE-033] refuses a list on another ticket, empty words and more than the limit', async () => {
    const one = await newTicket('One');
    const two = await newTicket('Two');
    const list = (await addList(one.id, 'Plan', ['Alpha'])).checklists[0] as ListJson;
    expect(
      (await as('alice', { method: 'DELETE', url: `${lists(two.id)}/${list.id}` })).statusCode,
    ).toBe(404);
    expect(
      (await as('alice', { method: 'POST', url: lists(one.id), payload: { name: '  ' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await as('alice', {
          method: 'POST',
          url: `${lists(one.id)}/${list.id}/items`,
          payload: { text: 'x'.repeat(1001) },
        })
      ).statusCode,
    ).toBe(400);
    const full = (
      await addList(
        two.id,
        'Full',
        Array.from({ length: MAX_ITEMS }, (_, i) => `Item ${i}`),
      )
    ).checklists[0] as ListJson;
    const over = await as('alice', {
      method: 'POST',
      url: `${lists(two.id)}/${full.id}/items`,
      payload: { text: 'One more' },
    });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toBe('too_many');
  });

  it('[CORE-033] leaves a ticket in the trash alone, and goes when the ticket is purged', async () => {
    const ticket = await newTicket();
    await addList(ticket.id, 'Plan', ['Alpha']);
    expect((await as('admin', { method: 'DELETE', url: `/api/v1/tickets/${ticket.id}` })).statusCode).toBe(
      204,
    );
    expect((await as('alice', { method: 'GET', url: lists(ticket.id) })).statusCode).toBe(404);
    await database.db.deleteFrom('ticket_change').where('ticket_id', '=', ticket.id).execute();
    await database.db.deleteFrom('ticket').where('id', '=', ticket.id).execute();
    const left = await database.db
      .selectFrom('ticket_checklist')
      .select('id')
      .where('ticket_id', '=', ticket.id)
      .execute();
    expect(left).toEqual([]);
  });
});
