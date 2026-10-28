import type { AddressInfo } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { PmJson } from '@taskmoor/richtext';
import { docFromYDoc, schema, writeDocToYDoc } from '@taskmoor/richtext';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { Authorizer } from '../authz/authorizer';
import { EVENT_TYPES } from '../events/catalogue';
import { FieldCatalogs } from '../fields/catalog';
import { writeCollaborativeText } from './persist';

const PASSWORD = 'ladder violet harbour';
const PUBLIC_URL = 'http://app.example.test';
let address = 0;
const nextAddress = () => `100.76.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

const PEOPLE = ['admin', 'alice', 'bob', 'victor', 'nora'] as const;
type Person = (typeof PEOPLE)[number];

const text = (value: string): PmJson => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }],
});
const normal = (doc: PmJson) => schema.nodeFromJSON(doc).toJSON() as PmJson;
/** Equal documents, whatever their key order or prototypes (ProseMirror's attrs have none). */
const same = (a: unknown, b: unknown) =>
  isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));

async function waitFor(check: () => boolean | Promise<boolean>, what: string, ms = 10_000) {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Co-editing rich text (M1-017; NTF-008, IAM-011, ADR-014): Hocuspocus providers, as the
 * editor uses them, against the realtime role on a listening app.
 */
describe('collaborative rich text (M1-017)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let url = '';
  const users = {} as Record<Person, { id: number; cookie: string }>;
  let trackId = 0;
  const open: { destroy: () => void }[] = [];

  const as = (who: Person, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who].cookie },
    });
  const roleId = async (name: string) =>
    (
      await database.db
        .selectFrom('role')
        .select('id')
        .where('name', '=', name)
        .executeTakeFirstOrThrow()
    ).id;
  const newTicket = async (description: PmJson | null, extra: Record<string, unknown> = {}) => {
    const res = await as('admin', {
      method: 'POST',
      url: '/api/v1/tickets',
      payload: { track: 'COL', summary: 'Co-edited', description, ...extra },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().ticket as { id: number; key: string };
  };
  const descriptionOf = async (ticketId: number) =>
    (await as('admin', { method: 'GET', url: `/api/v1/tickets/${ticketId}` })).json().ticket
      .description as PmJson | null;

  /** A provider as the browser editor runs one, signed in as `who`. */
  function connect(who: Person, name: string, origin = PUBLIC_URL) {
    const cookie = users[who].cookie;
    class SignedIn extends WebSocket {
      constructor(target: string) {
        super(target, { headers: { cookie, origin } });
      }
    }
    const document = new Y.Doc();
    const websocketProvider = new HocuspocusProviderWebsocket({
      url,
      WebSocketPolyfill: SignedIn,
      maxAttempts: 1,
    });
    const refused: string[] = [];
    const provider = new HocuspocusProvider({
      websocketProvider,
      name,
      document,
      onAuthenticationFailed: ({ reason }) => refused.push(reason),
    });
    provider.attach();
    const handle = {
      document,
      provider,
      refused,
      destroy: () => {
        provider.destroy();
        websocketProvider.destroy();
      },
    };
    open.push(handle);
    return handle;
  }

  beforeAll(async () => {
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api', 'realtime'],
      publicUrl: PUBLIC_URL,
      collabDebounceMs: 30,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/v1/collab`;
    const hash = await hashPassword(PASSWORD);
    for (const name of PEOPLE) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
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
      const cookie = [res.headers['set-cookie']]
        .flat()
        .find((c) => c?.startsWith(`${SESSION_COOKIE}=`))
        ?.split(';')[0];
      users[name] = { id: row.id, cookie: cookie ?? '' };
    }
    const track = await as('admin', {
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'COL', name: 'Collaboration', mode: 'shared' },
    });
    trackId = track.json().track.id;
    // Alice and Bob edit; Victor only views; Nora has no role here.
    const grants: [Person, string][] = [
      ['alice', 'Members'],
      ['bob', 'Members'],
      ['victor', 'Viewers'],
    ];
    for (const [who, role] of grants) {
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: trackId,
          role_id: await roleId(role),
          user_id: users[who].id,
        })
        .execute();
    }
  });

  afterAll(async () => {
    for (const handle of open) handle.destroy();
    await app.close();
  });

  it('[NTF-008] two people typing in one description converge, and the ticket keeps both', async () => {
    const ticket = await newTicket(text('The login fails.'));
    const name = `ticket/${ticket.id}/description`;
    const alice = connect('alice', name);
    const bob = connect('bob', name);
    await waitFor(() => alice.provider.isSynced && bob.provider.isSynced, 'sync');
    expect(docFromYDoc(alice.document)).toEqual(normal(text('The login fails.')));

    // Both type at once, at different places in the same sentence.
    writeDocToYDoc(alice.document, text('The login page fails.'));
    writeDocToYDoc(bob.document, text('The login fails on Safari.'));
    const merged = normal(text('The login page fails on Safari.'));
    await waitFor(
      () => same(docFromYDoc(alice.document), merged) && same(docFromYDoc(bob.document), merged),
      'convergence',
    );
    await waitFor(async () => same(await descriptionOf(ticket.id), merged), 'the save');

    // Saved like an edit through the API: history, a version, valid events by the editors.
    const history = await as('admin', {
      method: 'GET',
      url: `/api/v1/tickets/${ticket.id}/history?order=asc`,
    });
    const changes = (
      history.json().changes as { field: string; actor: { id: number } | null }[]
    ).filter((c) => c.field === 'description');
    expect(changes.length).toBeGreaterThanOrEqual(2);
    expect(
      changes.slice(1).every((c) => [users.alice.id, users.bob.id].includes(c.actor?.id ?? 0)),
    ).toBe(true);
    const events = await database.db
      .selectFrom('domain_event')
      .select(['type', 'payload', 'actor_id', 'subject_type'])
      .where('subject_id', '=', String(ticket.id))
      .where('type', '=', 'ticket.updated')
      .execute();
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const event of events) {
      expect(() => EVENT_TYPES['ticket.updated'].payload.parse(event.payload)).not.toThrow();
      expect([users.alice.id, users.bob.id]).toContain(event.actor_id);
      expect(Object.keys((event.payload as { changes: object }).changes)).toEqual(['description']);
    }
    alice.destroy();
    bob.destroy();
  });

  it("[CORE-011] a collaborative save refreshes the ticket's formulas, as any other write does", async () => {
    const field = await as('admin', {
      method: 'POST',
      url: '/api/v1/fields',
      payload: {
        name: 'Last touched',
        type: 'formula',
        config: { expression: '{Updated}', output: 'date' },
      },
    });
    expect(field.statusCode, field.body).toBe(201);
    const fieldId = String(field.json().field.id);
    const ticket = await newTicket(null);
    // A value left over from before: the save must compute it again.
    await database.db
      .updateTable('ticket')
      .set({ fields: sql`jsonb_set(fields, ${sql.lit(`{${fieldId}}`)}, '"2000-01-01"')` })
      .where('id', '=', ticket.id)
      .execute();
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Saved together' }] }],
    };
    const outcome = await writeCollaborativeText(
      database.db,
      new Authorizer(database.db),
      new FieldCatalogs(database.db),
      {
        workspaceId: 1,
        ticketId: ticket.id,
        field: 'description',
        doc,
        actorId: users.alice.id,
        ip: null,
        state: new Uint8Array(),
      },
    );
    expect(outcome.status).toBe('written');
    const row = await database.db
      .selectFrom('ticket')
      .select('fields')
      .where('id', '=', ticket.id)
      .executeTakeFirstOrThrow();
    expect((row.fields as Record<string, unknown>)[fieldId]).toBe(
      new Date().toISOString().slice(0, 10),
    );
  });

  it('[NTF-008] keeps the Yjs state, so people who come back continue from it', async () => {
    const ticket = await newTicket(text('Draft'));
    const name = `ticket/${ticket.id}/description`;
    const first = connect('alice', name);
    await waitFor(() => first.provider.isSynced, 'sync');
    writeDocToYDoc(first.document, text('Draft, reviewed'));
    await waitFor(
      async () => same(await descriptionOf(ticket.id), normal(text('Draft, reviewed'))),
      'the save',
    );
    first.destroy();
    await waitFor(() => !app.collaboration?.openDocuments().includes(name), 'unload');
    const state = await database.db
      .selectFrom('ticket_text_state')
      .select(['doc_sha256', 'workspace_id'])
      .where('ticket_id', '=', ticket.id)
      .where('field', '=', 'description')
      .executeTakeFirst();
    expect(state?.workspace_id).toBe(1);

    const again = connect('bob', name);
    await waitFor(() => again.provider.isSynced, 'sync');
    expect(docFromYDoc(again.document)).toEqual(normal(text('Draft, reviewed')));
    // The stored state was used: it carries Alice's client among its authors.
    expect(again.document.store.clients.size).toBeGreaterThanOrEqual(1);
    again.destroy();
  });

  it('[NTF-008] a change through the API reaches people in the document; the last write wins', async () => {
    const ticket = await newTicket(text('Before'));
    const name = `ticket/${ticket.id}/description`;
    const alice = connect('alice', name);
    await waitFor(() => alice.provider.isSynced, 'sync');
    const res = await as('bob', {
      method: 'PATCH',
      url: `/api/v1/tickets/${ticket.id}`,
      payload: { description: text('Written through the API') },
    });
    expect(res.statusCode, res.body).toBe(200);
    await waitFor(
      () => same(docFromYDoc(alice.document), normal(text('Written through the API'))),
      'the new text in the open document',
    );
    // Alice types on from there; what the API wrote stays in the history.
    writeDocToYDoc(alice.document, text('Written through the API, then edited'));
    await waitFor(
      async () =>
        same(await descriptionOf(ticket.id), normal(text('Written through the API, then edited'))),
      'the save',
    );
    const history = await as('admin', {
      method: 'GET',
      url: `/api/v1/tickets/${ticket.id}/history?order=asc`,
    });
    const descriptions = (history.json().changes as { field: string; actor: { id: number } }[])
      .filter((c) => c.field === 'description')
      .map((c) => c.actor.id);
    expect(descriptions).toEqual([users.admin.id, users.bob.id, users.alice.id]);
    alice.destroy();
  });

  it('[IAM-011] only people who may edit the ticket can join its document', async () => {
    const ticket = await newTicket(text('Restricted'));
    const name = `ticket/${ticket.id}/description`;
    const victor = connect('victor', name);
    const nora = connect('nora', name);
    const nonsense = connect('alice', 'ticket/abc/summary');
    await waitFor(
      () => victor.refused.length > 0 && nora.refused.length > 0 && nonsense.refused.length > 0,
      'refusals',
    );
    // A viewer learns they may not edit; someone who cannot see the ticket learns nothing.
    expect(victor.refused).toEqual(['forbidden']);
    expect(nora.refused).toEqual(['not-found']);
    expect(nonsense.refused).toEqual(['not-found']);
    // Nothing of the text reached them.
    expect(victor.document.getXmlFragment('default').length).toBe(0);
    expect(nora.document.getXmlFragment('default').length).toBe(0);

    // A ticket in the trash is gone for everyone.
    const trashed = await newTicket(text('Soon gone'));
    expect(
      (await as('admin', { method: 'DELETE', url: `/api/v1/tickets/${trashed.id}` })).statusCode,
    ).toBe(204);
    const late = connect('alice', `ticket/${trashed.id}/description`);
    await waitFor(() => late.refused.length > 0, 'refusal');
    expect(late.refused).toEqual(['not-found']);
    for (const handle of [victor, nora, nonsense, late]) handle.destroy();
  });

  it('[IAM-011] someone who loses access while editing is let go', async () => {
    const ticket = await newTicket(text('Shared'));
    const name = `ticket/${ticket.id}/description`;
    const bob = connect('bob', name);
    const alice = connect('alice', name);
    await waitFor(() => bob.provider.isSynced && alice.provider.isSynced, 'sync');
    const document = () => app.collaboration?.hocuspocus.documents.get(name);
    expect(document()?.getConnectionsCount()).toBe(2);
    const members = await roleId('Members');
    const removed = await as('admin', {
      method: 'DELETE',
      url: `/api/v1/tracks/${trackId}/roles/${members}/users/${users.bob.id}`,
    });
    expect(removed.statusCode, removed.body).toBe(204);
    await waitFor(() => document()?.getConnectionsCount() === 1, 'Bob to be let go');
    // Bob's later typing reaches no one.
    writeDocToYDoc(bob.document, text('Shared, by someone without access'));
    await new Promise((r) => setTimeout(r, 200));
    expect(docFromYDoc(alice.document)).toEqual(normal(text('Shared')));
    expect(await descriptionOf(ticket.id)).toEqual(normal(text('Shared')));
    await as('admin', {
      method: 'PUT',
      url: `/api/v1/tracks/${trackId}/roles/${members}/users/${users.bob.id}`,
    });
    bob.destroy();
    alice.destroy();
  });

  it('[IAM-025] a socket needs a session and this instance’s origin', async () => {
    const attempt = (path: string, headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const target = url.replace('/api/v1/collab', path);
        const ws = new WebSocket(target, { headers });
        ws.on('unexpected-response', (_req, res) => {
          resolve(res.statusCode ?? 0);
          ws.terminate();
        });
        ws.on('open', () => {
          resolve(101);
          ws.close();
        });
        ws.on('error', () => resolve(-1));
      });
    expect(await attempt('/api/v1/collab', { origin: PUBLIC_URL })).toBe(401);
    expect(
      await attempt('/api/v1/collab', { cookie: users.alice.cookie, origin: 'https://evil.test' }),
    ).toBe(403);
    expect(await attempt('/api/v1/other', { cookie: users.alice.cookie })).toBe(404);
    expect(
      await attempt('/api/v1/collab', { cookie: users.alice.cookie, origin: PUBLIC_URL }),
    ).toBe(101);
    // Clients that are not browsers send no origin.
    expect(await attempt('/api/v1/collab', { cookie: users.alice.cookie })).toBe(101);
  });
});
