import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { type AdfNode, adfDoc, canonicalAdf } from '@taskmoor/richtext';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.77.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

const PEOPLE = ['admin', 'alice', 'victor', 'nora', 'gone'] as const;
type Person = (typeof PEOPLE)[number];

/** A document in the Jira-compatible format with a node the editor keeps whole. */
const ADF: AdfNode = adfDoc([
  {
    type: 'heading',
    attrs: { level: 2, localId: 'h-1' },
    content: [{ type: 'text', text: 'Imported' }],
  },
  {
    type: 'paragraph',
    content: [
      { type: 'mention', attrs: { id: 'acc-7', text: '@Riley', accessLevel: 'CONTAINER' } },
      { type: 'text', text: ' please see ' },
      {
        type: 'text',
        text: 'the notes',
        marks: [{ type: 'link', attrs: { href: 'https://example.test/n', title: 'Notes' } }],
      },
    ],
  },
  {
    type: 'expand',
    attrs: { title: 'Details' },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Folded away.' }] }],
  },
]);

/**
 * Rich text on the API (M1-017; API-011, API-004, IMP-008, NTF-005): `?format=` on ticket
 * reads and writes, the originals of documents written in the Jira-compatible format, and the
 * people an editor offers for mentions.
 */
describe('rich text formats and mentions (M1-017)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users = {} as Record<Person, { id: number; cookie: string }>;

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

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const name of PEOPLE) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name: name === 'alice' ? 'Alice Moreau' : name,
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
      payload: { key: 'RT', name: 'Rich text', mode: 'shared' },
    });
    const trackId = track.json().track.id as number;
    for (const [who, role] of [
      ['alice', 'Members'],
      ['victor', 'Viewers'],
    ] as const) {
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
    await database.db
      .updateTable('app_user')
      .set({ deactivated_at: new Date() })
      .where('id', '=', users.gone.id)
      .execute();
  });

  afterAll(async () => {
    await app.close();
  });

  it('[API-011] writing Markdown and reading the Jira-compatible format gives the same content', async () => {
    const created = await as('alice', {
      method: 'POST',
      url: '/api/v1/tickets?format=markdown',
      payload: {
        track: 'RT',
        summary: 'Markdown in',
        description: '## Steps\n\n1. Open **Filters**\n2. Save\n\n- [x] checked\n',
        environment: 'Firefox `143`',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    // The answer speaks the format it was asked in.
    expect(created.json().ticket.environment).toBe('Firefox `143`\n');
    const key = created.json().ticket.key as string;
    const adf = await as('alice', { method: 'GET', url: `/api/v1/tickets/${key}?format=adf` });
    expect(adf.json().ticket.description).toEqual(
      adfDoc([
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Steps' }] },
        {
          type: 'orderedList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'Open ' },
                    { type: 'text', text: 'Filters', marks: [{ type: 'strong' }] },
                  ],
                },
              ],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Save' }] }],
            },
          ],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { state: 'DONE' },
              content: [{ type: 'text', text: 'checked' }],
            },
          ],
        },
      ]),
    );
    // The stored document is the editor's; Markdown reads back as written.
    const doc = await as('alice', { method: 'GET', url: `/api/v1/tickets/${key}` });
    expect(doc.json().ticket.description.type).toBe('doc');
    const md = await as('alice', {
      method: 'GET',
      url: `/api/v1/tickets?track=RT&format=markdown`,
    });
    expect(md.json().tickets[0].description).toBe(
      '## Steps\n\n1. Open **Filters**\n2. Save\n\n- [x] checked\n',
    );
  });

  it('[API-011] writing wiki markup and reading the other formats gives the same content', async () => {
    const wiki =
      'h2. Steps\n\n# Open *Filters*\n# Save\n\n* \\[x] checked\n\n{code:sql}\nSELECT 1;\n{code}';
    const created = await as('alice', {
      method: 'POST',
      url: '/api/v1/tickets?format=wiki',
      payload: {
        track: 'RT',
        summary: 'Wiki in',
        description: wiki,
        environment: 'Firefox {{143}}',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().ticket.description).toBe(wiki);
    expect(created.json().ticket.environment).toBe('Firefox {{143}}');
    const key = created.json().ticket.key as string;
    const md = await as('alice', { method: 'GET', url: `/api/v1/tickets/${key}?format=markdown` });
    expect(md.json().ticket.description).toBe(
      '## Steps\n\n1. Open **Filters**\n2. Save\n\n- [x] checked\n\n```sql\nSELECT 1;\n```\n',
    );
    // API-011 (2): plain text strips the formatting, for exports and ETL.
    const text = await as('alice', { method: 'GET', url: `/api/v1/tickets/${key}?format=text` });
    expect(text.json().ticket.description).toBe(
      'Steps\n\nOpen Filters\nSave\n\nchecked\n\nSELECT 1;',
    );
    expect(text.json().ticket.environment).toBe('Firefox 143');
    const listed = await as('alice', {
      method: 'GET',
      url: '/api/v1/tickets?track=RT&format=wiki',
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().tickets.find((t: { key: string }) => t.key === key).description).toBe(
      wiki,
    );
    // Comments take the same formats.
    const comment = await as('alice', {
      method: 'POST',
      url: `/api/v1/tickets/${key}/comments?format=wiki`,
      payload: { body: `Looks *good* to [~accountid:${users.alice.id}]` },
    });
    expect(comment.statusCode, comment.body).toBe(201);
    const comments = await as('alice', {
      method: 'GET',
      url: `/api/v1/tickets/${key}/comments?format=text`,
    });
    expect(comments.json().comments[0].body).toBe(`Looks good to @${users.alice.id}`);
  });

  it('[IMP-008] keeps the original of a document written in the Jira-compatible format', async () => {
    const created = await as('alice', {
      method: 'POST',
      url: '/api/v1/tickets?format=adf',
      payload: { track: 'RT', summary: 'Imported through the API', description: ADF },
    });
    expect(created.statusCode, created.body).toBe(201);
    const key = created.json().ticket.key as string;
    // API-004 (2): what was written reads back identically, unknown node included.
    expect(canonicalAdf(created.json().ticket.description)).toEqual(canonicalAdf(ADF));
    const original = await as('alice', {
      method: 'GET',
      url: `/api/v1/tickets/${key}/rich-text/description/original`,
    });
    expect(original.statusCode, original.body).toBe(200);
    expect(original.json()).toMatchObject({
      field: 'description',
      format: 'adf',
      original: ADF,
      writtenBy: { id: users.alice.id, name: 'Alice Moreau' },
      current: true,
    });
    expect(
      (
        await as('alice', {
          method: 'GET',
          url: `/api/v1/tickets/${key}/rich-text/environment/original`,
        })
      ).statusCode,
    ).toBe(404);

    // Edited in the editor's format: the original stays, no longer current.
    const edited = await as('alice', {
      method: 'PATCH',
      url: `/api/v1/tickets/${key}`,
      payload: {
        description: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rewritten' }] }],
        },
      },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const stale = await as('victor', {
      method: 'GET',
      url: `/api/v1/tickets/${key}/rich-text/description/original`,
    });
    expect(stale.json()).toMatchObject({ original: ADF, current: false });

    // Written again in that format: replaced; cleared: gone.
    const again = adfDoc([{ type: 'paragraph', content: [{ type: 'text', text: 'Second' }] }]);
    await as('alice', {
      method: 'PATCH',
      url: `/api/v1/tickets/${key}?format=adf`,
      payload: { description: again },
    });
    expect(
      (
        await as('alice', {
          method: 'GET',
          url: `/api/v1/tickets/${key}/rich-text/description/original`,
        })
      ).json(),
    ).toMatchObject({ original: again, current: true });
    const cleared = await as('alice', {
      method: 'PATCH',
      url: `/api/v1/tickets/${key}?format=adf`,
      payload: { description: null },
    });
    expect(cleared.json().ticket.description).toBeNull();
    // The other format's empty document is no text either.
    const empty = await as('alice', {
      method: 'PATCH',
      url: `/api/v1/tickets/${key}?format=adf`,
      payload: { environment: adfDoc([]) },
    });
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json().ticket.environment).toBeNull();
    expect(
      (
        await as('alice', {
          method: 'GET',
          url: `/api/v1/tickets/${key}/rich-text/description/original`,
        })
      ).statusCode,
    ).toBe(404);

    // Someone who cannot see the ticket learns nothing of it.
    expect(
      (
        await as('nora', {
          method: 'GET',
          url: `/api/v1/tickets/${key}/rich-text/description/original`,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('[API-011] refuses unknown formats and values that do not read in theirs', async () => {
    const write = (format: string, description: unknown) =>
      as('alice', {
        method: 'POST',
        url: `/api/v1/tickets?format=${format}`,
        payload: { track: 'RT', summary: 'Bad', description },
      });
    expect((await write('html', '<h1>Title</h1>')).statusCode).toBe(400);
    for (const [format, value] of [
      ['adf', 'not a document'],
      ['adf', { type: 'paragraph' }],
      ['markdown', { type: 'doc' }],
      ['wiki', { type: 'doc' }],
      // Plain text is for reading only.
      ['text', 'Title'],
      // The other format's own node, which the stored form does not have.
      ['doc', adfDoc([{ type: 'rule' }])],
    ] as const) {
      const res = await write(format, value);
      expect(res.statusCode, `${format} ${JSON.stringify(value)}`).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_fields', fields: { description: 'invalid' } });
    }
    const huge = await write('markdown', 'x'.repeat(120_000));
    expect(huge.json().fields).toEqual({ description: 'too_long' });
    expect(
      (await as('alice', { method: 'GET', url: '/api/v1/tickets?format=html' })).statusCode,
    ).toBe(400);
  });

  it('[NTF-014] [NTF-007] holds only safe text colours: an import keeps another aside, a save takes it off (T-318)', async () => {
    const unsafe = 'red; position: fixed; inset: 0';
    const coloured = (text: string, color: string, marks: { type: string }[] = []) => ({
      type: 'text',
      text,
      marks: [...marks, { type: 'textColor', attrs: { color } }],
    });
    const adf = adfDoc([
      { type: 'paragraph', content: [coloured('green', '#36b37e'), coloured('odd', unsafe)] },
    ]);
    const created = await as('alice', {
      method: 'POST',
      url: '/api/v1/tickets?format=adf',
      payload: { track: 'RT', summary: 'Coloured import', description: adf },
    });
    expect(created.statusCode, created.body).toBe(201);
    const key = created.json().ticket.key as string;
    const stored = await as('alice', { method: 'GET', url: `/api/v1/tickets/${key}` });
    const [green, odd] = stored.json().ticket.description.content[0].content;
    expect(green.marks).toMatchObject([{ type: 'textColor', attrs: { color: '#36b37e' } }]);
    // Not a colour the document shows: kept whole, only to be written back.
    expect(odd.marks).toEqual([
      { type: 'unknownMark', attrs: { type: 'textColor', attrs: { color: unsafe } } },
    ]);
    const back = await as('alice', { method: 'GET', url: `/api/v1/tickets/${key}?format=adf` });
    expect(canonicalAdf(back.json().ticket.description)).toEqual(canonicalAdf(adf));

    // The editor's own form, as a document stored before colours were checked holds it: saved,
    // not refused, with the colour taken off and the text and its other marks kept.
    const saved = await as('alice', {
      method: 'PATCH',
      url: `/api/v1/tickets/${key}`,
      payload: {
        description: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                coloured('kept', '#36b37e'),
                { type: 'text', text: ' and ' },
                coloured('plain', unsafe, [{ type: 'bold' }]),
              ],
            },
          ],
        },
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().ticket.description.content[0].content).toEqual([
      {
        type: 'text',
        text: 'kept',
        marks: [{ type: 'textColor', attrs: { color: '#36b37e', adfAttrs: null } }],
      },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'plain', marks: [{ type: 'bold' }] },
    ]);
  });

  it('[NTF-005] offers people to mention, saying who can see the ticket', async () => {
    const created = await as('alice', {
      method: 'POST',
      url: '/api/v1/tickets',
      payload: { track: 'RT', summary: 'Mentions' },
    });
    const key = created.json().ticket.key as string;
    const res = await as('alice', {
      method: 'GET',
      url: `/api/v1/people/mentionable?ticket=${key}&q=`,
    });
    expect(res.statusCode, res.body).toBe(200);
    const people = res.json().people as { id: number; name: string; canView: boolean }[];
    // Those who can see it first; deactivated people never.
    expect(people.map((p) => [p.name, p.canView])).toEqual([
      ['admin', true],
      ['Alice Moreau', true],
      ['victor', true],
      ['nora', false],
    ]);
    const search = await as('alice', {
      method: 'GET',
      url: '/api/v1/people/mentionable?track=RT&q=@ali',
    });
    expect(search.json().people).toEqual([
      { id: users.alice.id, name: 'Alice Moreau', canView: true },
    ]);
    const byEmail = await as('alice', {
      method: 'GET',
      url: '/api/v1/people/mentionable?track=RT&q=nora@',
    });
    expect(byEmail.json().people).toEqual([{ id: users.nora.id, name: 'nora', canView: false }]);
    // The caller must see the track or ticket, and name one of them.
    expect(
      (await as('nora', { method: 'GET', url: `/api/v1/people/mentionable?ticket=${key}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await as('alice', { method: 'GET', url: '/api/v1/people/mentionable?q=a' })).statusCode,
    ).toBe(400);
  });

  it('[CORE-008] [IAM-010] offers only people who may be assigned in the track, for an assignee picker', async () => {
    const res = await as('alice', {
      method: 'GET',
      url: '/api/v1/people/mentionable?track=RT&q=&assignable=true',
    });
    expect(res.statusCode, res.body).toBe(200);
    const names = (res.json().people as { name: string }[]).map((p) => p.name);
    // Victor only views the track and Nora has no role in it: neither holds "Assignable user".
    expect(names).toContain('Alice Moreau');
    expect(names).not.toContain('victor');
    expect(names).not.toContain('nora');
    const everyone = await as('alice', {
      method: 'GET',
      url: '/api/v1/people/mentionable?track=RT&q=&assignable=false',
    });
    expect((everyone.json().people as { name: string }[]).map((p) => p.name)).toContain('victor');
    expect(
      (
        await as('alice', {
          method: 'GET',
          url: '/api/v1/people/mentionable?track=RT&assignable=yes',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('[CORE-008] [IAM-010] finds the few who may be assigned however many matching names sort before them', async () => {
    // 130 people whose names match "an" and sort first, none of them in the track, then one
    // member who may be assigned: more than any single page the search reads.
    const crowd = await database.db
      .insertInto('app_user')
      .values(
        Array.from({ length: 130 }, (_, i) => ({
          workspace_id: 1,
          email: `crowd${i}@example.com`,
          name: `Ana ${String(i).padStart(3, '0')}`,
          password_hash: null,
        })),
      )
      .returning('id')
      .execute();
    const dan = await database.db
      .insertInto('app_user')
      .values({ workspace_id: 1, email: 'dan@example.com', name: 'Dan Ortiz', password_hash: null })
      .returning('id')
      .executeTakeFirstOrThrow();
    const track = await database.db
      .selectFrom('track')
      .select('id')
      .where('key', '=', 'RT')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: track.id,
        role_id: await roleId('Members'),
        user_id: dan.id,
      })
      .execute();
    try {
      const res = await as('alice', {
        method: 'GET',
        url: '/api/v1/people/mentionable?track=RT&q=an&assignable=true&limit=8',
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().people).toEqual([{ id: dan.id, name: 'Dan Ortiz', canView: true }]);
    } finally {
      await database.db.deleteFrom('track_role_actor').where('user_id', '=', dan.id).execute();
      await database.db
        .deleteFrom('app_user')
        .where(
          'id',
          'in',
          [...crowd, dan].map((r) => r.id),
        )
        .execute();
    }
  });

  it('[NTF-005] offers no one to people without "Browse users and groups"', async () => {
    await database.db.deleteFrom('global_grant').where('permission', '=', 'browse_users').execute();
    try {
      const res = await as('alice', {
        method: 'GET',
        url: '/api/v1/people/mentionable?track=RT',
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await database.db
        .insertInto('global_grant')
        .values({ workspace_id: 1, permission: 'browse_users', grantee: 'any_user' })
        .execute();
    }
  });
});
