import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.73.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface FormJson {
  layout: {
    operation: string;
    tabs: {
      name: string | null;
      sections: {
        kind: string;
        hideWhenEmpty: boolean;
        fields: { key: string; required: boolean; description: string | null }[];
      }[];
    }[];
  };
  customFields: { id: number; name: string }[];
}

/**
 * Field rule sets and layout sets through the API (M1-012; CORE-003, CORE-008, CORE-013).
 */
describe('field rules and layouts (M1-012)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const types: Record<string, number> = {};
  const tracks: Record<string, number> = {};
  let trackCount = 0;

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const get = (who: string, url: string) => as(who, { method: 'GET', url });
  const post = (who: string, url: string, payload: Record<string, unknown>) =>
    as(who, { method: 'POST', url, payload });
  const patch = (who: string, url: string, payload: Record<string, unknown>) =>
    as(who, { method: 'PATCH', url, payload });
  const errorsOf = (res: LightMyRequestResponse) => res.json().fields as Record<string, string>;
  const keysOf = (form: FormJson) =>
    form.layout.tabs.flatMap((t) => t.sections.flatMap((s) => s.fields.map((f) => f.key)));

  /** A shared track whose members are Alice and Bob; Carol administers it. */
  async function track(
    extra: Record<string, unknown> = {},
    key = `L${++trackCount}`,
  ): Promise<string> {
    const res = await post('admin', '/api/v1/tracks', { key, name: key, mode: 'shared', ...extra });
    expect(res.statusCode, res.body).toBe(201);
    tracks[key] = res.json().track.id;
    const roles = await database.db.selectFrom('role').select(['id', 'name']).execute();
    for (const [who, role] of [
      ['alice', 'Members'],
      ['bob', 'Members'],
      ['carol', 'Administrators'],
    ] as const) {
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: tracks[key] as number,
          role_id: roles.find((r) => r.name === role)?.id as number,
          user_id: users[who]?.id as number,
        })
        .execute();
    }
    return key;
  }
  async function ruleSet(rules: Record<string, unknown>[], name = `Rules ${trackCount}`) {
    const res = await post('admin', '/api/v1/field-rule-sets', { name, rules });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().fieldRuleSet as { id: number; usedBy: { key: string }[] };
  }
  async function layoutSet(layouts: Record<string, unknown>[], name = `Layouts ${trackCount}`) {
    const res = await post('admin', '/api/v1/layout-sets', { name, layouts });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().layoutSet as { id: number };
  }
  async function use(key: string, sets: { fieldRuleSetId?: number; layoutSetId?: number }) {
    const res = await patch('admin', `/api/v1/tracks/${tracks[key]}`, sets);
    expect(res.statusCode, res.body).toBe(200);
  }
  const create = (key: string, body: Record<string, unknown>, who = 'alice') =>
    post(who, '/api/v1/tickets', { track: key, summary: 'Work', ...body });
  const form = async (key: string, typeId: number, operation = 'create') =>
    (
      await get(
        'alice',
        `/api/v1/tracks/${key}/layout?ticketTypeId=${typeId}&operation=${operation}`,
      )
    ).json() as FormJson;

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['bob', false],
      ['carol', false],
      ['dana', false],
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
    for (const t of await database.db.selectFrom('ticket_type').select(['id', 'name']).execute()) {
      types[t.name] = t.id;
    }
  });
  afterAll(async () => {
    await app.close();
  });

  it('[CORE-013] enforces a field required for Bug and optional for Chore only on Bugs', async () => {
    const key = await track();
    const severity = (
      await post('admin', '/api/v1/fields', {
        name: `Severity ${key}`,
        type: 'select',
        context: { options: [{ value: 'High' }, { value: 'Low' }] },
      })
    ).json().field;
    const high = severity.contexts[0].options[0].id as number;
    const rules = await ruleSet([
      { ticketTypeId: types.Bug, field: 'dueDate', required: true },
      { ticketTypeId: types.Bug, field: `cf[${severity.id}]`, required: true },
    ]);
    await use(key, { fieldRuleSetId: rules.id });
    // Missing required fields block creation, each named (CORE-008 (3)).
    const bug = await create(key, { ticketTypeId: types.Bug });
    expect(bug.statusCode).toBe(400);
    expect(errorsOf(bug)).toEqual({ dueDate: 'required', [`fields.${severity.id}`]: 'required' });
    // Nothing was written: the next ticket still gets the track's first number.
    const chore = await create(key, { ticketTypeId: types.Chore });
    expect(chore.statusCode, chore.body).toBe(201);
    expect(chore.json().ticket.key).toBe(`${key}-1`);
    const ok = await create(key, {
      ticketTypeId: types.Bug,
      dueDate: '2026-12-01',
      fields: { [severity.id]: high },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    const id = ok.json().ticket.id as number;
    // An edit may not empty a required field, and changes nothing when refused.
    const cleared = await patch('alice', `/api/v1/tickets/${id}`, {
      dueDate: null,
      summary: 'Renamed',
    });
    expect(cleared.statusCode).toBe(400);
    expect(errorsOf(cleared)).toEqual({ dueDate: 'required' });
    const unchanged = (await get('alice', `/api/v1/tickets/${id}`)).json().ticket;
    expect(unchanged).toMatchObject({ summary: 'Work', dueDate: '2026-12-01' });
    // A Chore that becomes a Bug needs a Bug's required fields.
    const retype = await patch('alice', `/api/v1/tickets/${chore.json().ticket.id}`, {
      ticketTypeId: types.Bug,
    });
    expect(errorsOf(retype)).toEqual({
      dueDate: 'required',
      [`fields.${severity.id}`]: 'required',
    });
    // The create form marks them for Bugs only.
    const required = (f: FormJson) =>
      f.layout.tabs.flatMap((t) => t.sections.flatMap((s) => s.fields.filter((x) => x.required)));
    expect(required(await form(key, types.Bug as number)).map((f) => f.key)).toEqual([
      'summary',
      'dueDate',
      `cf[${severity.id}]`,
    ]);
    expect(required(await form(key, types.Chore as number)).map((f) => f.key)).toEqual(['summary']);
  });

  it('[CORE-013] does not show or take a hidden field, and keeps its stored value', async () => {
    const key = await track();
    const notes = (
      await post('admin', '/api/v1/fields', { name: `Notes ${key}`, type: 'text' })
    ).json().field;
    const made = await create(key, {
      ticketTypeId: types.Feature,
      environment: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Linux' }] }],
      },
      fields: { [notes.id]: 'Kept' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json().ticket.id as number;
    const rules = await ruleSet([
      { ticketTypeId: null, field: 'environment', hidden: true, description: null },
      { ticketTypeId: null, field: `cf[${notes.id}]`, hidden: true },
    ]);
    await use(key, { fieldRuleSetId: rules.id });
    for (const operation of ['create', 'edit', 'view']) {
      const keys = keysOf(await form(key, types.Feature as number, operation));
      expect(keys).not.toContain('environment');
      expect(keys).not.toContain(`cf[${notes.id}]`);
      expect(keys).toContain('summary');
    }
    const write = await patch('alice', `/api/v1/tickets/${id}`, {
      fields: { [notes.id]: 'Changed' },
    });
    expect(write.statusCode).toBe(400);
    expect(errorsOf(write)).toEqual({ [`fields.${notes.id}`]: 'hidden' });
    expect(
      errorsOf(await create(key, { ticketTypeId: types.Feature, environment: null })),
    ).toBeUndefined();
    const created = await create(key, {
      ticketTypeId: types.Feature,
      environment: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'macOS' }] }],
      },
    });
    expect(errorsOf(created)).toEqual({ environment: 'hidden' });
    // The stored values stay; other edits go through.
    const renamed = await patch('alice', `/api/v1/tickets/${id}`, { summary: 'Renamed' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().ticket.fields[notes.id]).toBe('Kept');
    expect(renamed.json().ticket.environment).not.toBeNull();
    // Rules check: never the summary, never required and hidden together, known fields only.
    for (const rules of [
      [{ field: 'summary', hidden: true }],
      [{ field: 'dueDate', required: true, hidden: true }],
      [{ field: 'cf[999999]', required: true }],
      [{ field: 'nonsense', required: true }],
    ]) {
      expect(
        (await post('admin', '/api/v1/field-rule-sets', { name: 'Bad', rules })).statusCode,
      ).toBe(400);
    }
  });

  it('[CORE-008] arranges forms in tabs and sections per type and operation; required fields always appear', async () => {
    const key = await track();
    const area = (
      await post('admin', '/api/v1/fields', { name: `Region ${key}`, type: 'text' })
    ).json().field;
    const layouts = await layoutSet([
      {
        ticketTypeId: types.Bug,
        operation: 'create',
        definition: {
          tabs: [
            {
              name: 'Report',
              sections: [
                { kind: 'main', fields: ['summary', 'description', `cf[${area.id}]`] },
                { kind: 'context', hideWhenEmpty: true, fields: ['assignee', 'priority'] },
              ],
            },
          ],
          others: 'omit',
        },
      },
    ]);
    const rules = await ruleSet([
      { ticketTypeId: types.Bug, field: 'dueDate', required: true },
      { ticketTypeId: null, field: `cf[${area.id}]`, description: 'Where it happens' },
    ]);
    await use(key, { layoutSetId: layouts.id, fieldRuleSetId: rules.id });
    const bug = await form(key, types.Bug as number);
    expect(bug.layout.tabs.map((t) => t.name)).toEqual(['Report', null]);
    expect(bug.layout.tabs[0]?.sections.map((s) => [s.kind, s.hideWhenEmpty])).toEqual([
      ['main', false],
      ['context', true],
    ]);
    expect(bug.layout.tabs[0]?.sections[0]?.fields[2]).toEqual({
      key: `cf[${area.id}]`,
      required: false,
      description: 'Where it happens',
    });
    // The layout leaves the required due date out; it gets a section of its own.
    expect(bug.layout.tabs[1]?.sections[0]?.fields.map((f) => f.key)).toEqual(['dueDate']);
    expect(bug.customFields.map((f) => f.id)).toEqual([area.id]);
    // A field the layout leaves out is not written through the create form's API either.
    const off = await create(key, {
      ticketTypeId: types.Bug,
      dueDate: '2026-12-01',
      labels: ['x'],
    });
    expect(off.statusCode).toBe(400);
    expect(errorsOf(off)).toEqual({ labels: 'not_on_layout' });
    // Types without a layout of their own get every field.
    expect(keysOf(await form(key, types.Chore as number))).toContain('labels');
    // An administrator's change is what the next form shows (CORE-008 (2)).
    const changed = await patch('admin', `/api/v1/layout-sets/${layouts.id}`, {
      layouts: [
        {
          ticketTypeId: types.Bug,
          operation: 'create',
          definition: {
            tabs: [{ name: 'Short', sections: [{ fields: ['summary', 'labels'] }] }],
            others: 'omit',
          },
        },
      ],
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(keysOf(await form(key, types.Bug as number))).toEqual(['summary', 'labels', 'dueDate']);
    const ticket = await create(key, {
      ticketTypeId: types.Bug,
      dueDate: '2026-12-01',
      labels: ['x'],
    });
    expect(ticket.statusCode, ticket.body).toBe(201);
    // A ticket's own forms follow its type.
    const own = (
      await get('alice', `/api/v1/tickets/${ticket.json().ticket.id}/layout?operation=view`)
    ).json() as FormJson;
    expect(keysOf(own)).toContain('dueDate');
    // A layout names each field once.
    const twice = await patch('admin', `/api/v1/layout-sets/${layouts.id}`, {
      layouts: [
        {
          ticketTypeId: null,
          operation: 'view',
          definition: { tabs: [{ name: 'A', sections: [{ fields: ['summary', 'summary'] }] }] },
        },
      ],
    });
    expect(twice.statusCode).toBe(400);
  });

  describe('the layout editor’s preview (UI-T15)', () => {
    interface PreviewJson {
      source: 'type' | 'every_type' | 'none';
      layout: FormJson['layout'];
      leftOut: { field: string; reason: string }[];
      customFields: { id: number; name: string }[];
    }
    const preview = async (who: string, setId: number, body: Record<string, unknown>) =>
      post(who, `/api/v1/layout-sets/${setId}/preview`, body);
    const keysIn = (p: PreviewJson) =>
      p.layout.tabs.flatMap((t) => t.sections.flatMap((s) => s.fields.map((f) => f.key)));

    it('[CORE-008] shows the form a draft would give, per type and operation, and stores nothing', async () => {
      const key = await track();
      const rules = await ruleSet([
        { ticketTypeId: null, field: 'environment', hidden: true },
        { ticketTypeId: types.Bug, field: 'dueDate', required: true },
      ]);
      await use(key, { fieldRuleSetId: rules.id });
      const set = await layoutSet([], `Preview ${key}`);
      const draft = [
        {
          ticketTypeId: null,
          operation: 'create',
          definition: {
            tabs: [
              {
                name: 'Details',
                sections: [
                  { kind: 'main', fields: ['summary', 'environment', 'labels'] },
                  { kind: 'context', hideWhenEmpty: true, fields: ['priority'] },
                ],
              },
            ],
            others: 'omit',
          },
        },
        {
          ticketTypeId: types.Chore,
          operation: 'create',
          definition: { tabs: [{ name: 'Short', sections: [{ fields: ['summary'] }] }] },
        },
      ];
      const bug = await preview('admin', set.id, {
        ticketTypeId: types.Bug,
        operation: 'create',
        trackId: tracks[key],
        layouts: draft,
      });
      expect(bug.statusCode, bug.body).toBe(200);
      const shown = bug.json().preview as PreviewJson;
      // The layout for every type; the hidden field stays off, the required one is added.
      expect(shown.source).toBe('every_type');
      expect(shown.layout.tabs.map((t) => t.name)).toEqual(['Details', null]);
      expect(shown.layout.tabs[0]?.sections.map((s) => [s.kind, s.hideWhenEmpty])).toEqual([
        ['main', false],
        ['context', true],
      ]);
      expect(keysIn(shown)).toEqual(['summary', 'labels', 'priority', 'dueDate']);
      expect(shown.layout.tabs[1]?.sections[0]?.fields).toEqual([
        { key: 'dueDate', required: true, description: null },
      ]);
      expect(shown.leftOut).toEqual([{ field: 'environment', reason: 'hidden' }]);
      // A type's own layout wins; with `others: show`, the rest follows it.
      const chore = (
        await preview('admin', set.id, {
          ticketTypeId: types.Chore,
          operation: 'create',
          trackId: tracks[key],
          layouts: draft,
        })
      ).json().preview as PreviewJson;
      expect(chore.source).toBe('type');
      expect(chore.layout.tabs[0]?.name).toBe('Short');
      expect(keysIn(chore)).toContain('labels');
      expect(keysIn(chore)).not.toContain('environment');
      // No layout for the operation: every field in one tab.
      const view = (
        await preview('admin', set.id, {
          ticketTypeId: types.Bug,
          operation: 'view',
          trackId: tracks[key],
          layouts: draft,
        })
      ).json().preview as PreviewJson;
      expect(view.source).toBe('none');
      expect(view.layout.tabs).toHaveLength(1);
      // Nothing was saved, and nothing was announced.
      const saved = (await get('admin', `/api/v1/layout-sets/${set.id}`)).json().layoutSet;
      expect(saved.layouts).toEqual([]);
      const events = await database.db
        .selectFrom('domain_event')
        .select('type')
        .where('type', '=', 'layout_set.updated')
        .where('subject_id', '=', String(set.id))
        .execute();
      expect(events).toEqual([]);
    });

    it('[CORE-013] checks a draft as a save would, and answers only about what the person sees', async () => {
      const key = await track();
      const notes = (
        await post('admin', '/api/v1/fields', { name: `Preview notes ${key}`, type: 'text' })
      ).json().field;
      const set = await layoutSet(
        [
          {
            ticketTypeId: null,
            operation: 'edit',
            definition: {
              tabs: [{ name: 'Saved', sections: [{ fields: ['summary', `cf[${notes.id}]`] }] }],
              others: 'omit',
            },
          },
        ],
        `Judged ${key}`,
      );
      // Without a draft, the saved layouts; a member who reads sets may ask, of a track they see.
      const saved = await preview('alice', set.id, {
        ticketTypeId: types.Feature,
        operation: 'edit',
        trackId: tracks[key],
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().preview.layout.tabs[0].name).toBe('Saved');
      expect(saved.json().preview.customFields).toEqual([
        { id: notes.id, name: `Preview notes ${key}` },
      ]);
      // Without a track: the fields every track has and the default rules.
      const anywhere = await preview('admin', set.id, {
        ticketTypeId: types.Feature,
        operation: 'edit',
        trackId: null,
      });
      expect(keysIn(anywhere.json().preview as PreviewJson)).toEqual([
        'summary',
        `cf[${notes.id}]`,
      ]);
      const twice = await preview('admin', set.id, {
        ticketTypeId: types.Feature,
        operation: 'edit',
        layouts: [
          {
            ticketTypeId: null,
            operation: 'edit',
            definition: { tabs: [{ name: 'A', sections: [{ fields: ['summary', 'summary'] }] }] },
          },
        ],
      });
      expect(twice.statusCode).toBe(400);
      expect(twice.json().detail).toContain('each field once');
      const unknown = await preview('admin', set.id, {
        ticketTypeId: types.Feature,
        operation: 'edit',
        layouts: [
          {
            ticketTypeId: null,
            operation: 'edit',
            definition: { tabs: [{ name: 'A', sections: [{ fields: ['cf[999999]'] }] }] },
          },
        ],
      });
      expect(unknown.json()).toEqual({
        error: 'invalid_request',
        detail: 'unknown field cf[999999]',
      });
      const pairs = await preview('admin', set.id, {
        ticketTypeId: types.Feature,
        operation: 'edit',
        layouts: [
          { ticketTypeId: null, operation: 'edit', definition: { tabs: [] } },
          { ticketTypeId: null, operation: 'edit', definition: { tabs: [] } },
        ],
      });
      expect(pairs.statusCode).toBe(400);
      // The places the layout editor tells its reasons by (`apps/web/src/layouts/refusal.ts`).
      const detailOf = async (definition: Record<string, unknown>) =>
        (
          await preview('admin', set.id, {
            ticketTypeId: types.Feature,
            operation: 'edit',
            layouts: [{ ticketTypeId: null, operation: 'edit', definition }],
          })
        ).json().detail as string;
      expect(await detailOf({ tabs: [{ name: ' ', sections: [] }] })).toMatch(
        /^layouts\.0\.definition\.tabs\.0\.name: /,
      );
      const many = Array.from({ length: 21 }, (_, i) => i);
      expect(await detailOf({ tabs: many.map((i) => ({ name: `T${i}`, sections: [] })) })).toMatch(
        /^layouts\.0\.definition\.tabs: /,
      );
      expect(
        await detailOf({ tabs: [{ name: 'A', sections: many.map(() => ({ fields: [] })) }] }),
      ).toMatch(/^layouts\.0\.definition\.tabs\.0\.sections: /);
      expect(
        await detailOf({ tabs: [{ name: 'A', sections: [{ fields: ['labels', 'labels'] }] }] }),
      ).toBe('layouts.0.definition: each field once');
      expect(
        (await preview('admin', set.id, { ticketTypeId: 999999, operation: 'edit' })).json(),
      ).toEqual({ error: 'unknown_ticket_type' });
      // A track the person does not see, and a set that is not there, are not found.
      const hidden = await track();
      await database.db
        .deleteFrom('track_role_actor')
        .where('track_id', '=', tracks[hidden] as number)
        .where('user_id', '=', users.bob?.id as number)
        .execute();
      expect(
        (
          await preview('bob', set.id, {
            ticketTypeId: types.Feature,
            operation: 'edit',
            trackId: tracks[hidden],
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (await preview('admin', 999999, { ticketTypeId: types.Feature, operation: 'edit' }))
          .statusCode,
      ).toBe(404);
      // Signed out: refused.
      const out = await app.inject({
        method: 'POST',
        url: `/api/v1/layout-sets/${set.id}/preview`,
        payload: { ticketTypeId: types.Feature, operation: 'edit' },
        remoteAddress: nextAddress(),
      });
      expect(out.statusCode).toBe(401);
    });

    it('[CORE-013] tells nobody about the fields and types of a track they do not see', async () => {
      // SECRET is a local-mode track Bob is not in, with a field and a ticket type of its own.
      const secret = await track({ mode: 'local' }, 'PSECRET');
      await database.db
        .deleteFrom('track_role_actor')
        .where('track_id', '=', tracks[secret] as number)
        .where('user_id', '=', users.bob?.id as number)
        .execute();
      const field = await post('admin', '/api/v1/fields', {
        name: `Secret notes ${secret}`,
        type: 'text',
        trackId: tracks[secret],
      });
      expect(field.statusCode, field.body).toBe(201);
      const fieldId = field.json().field.id as number;
      const level = await database.db
        .selectFrom('hierarchy_level')
        .select('id')
        .where('kind', '=', 'standard')
        .executeTakeFirstOrThrow();
      const made = await post('admin', '/api/v1/ticket-types', {
        name: `Secret type ${secret}`,
        levelId: level.id,
        trackId: tracks[secret],
      });
      expect(made.statusCode, made.body).toBe(201);
      const typeId = made.json().ticketType.id as number;
      const set = await layoutSet([], `Probed ${secret}`);
      const draftWith = (key: string) => ({
        ticketTypeId: types.Feature,
        operation: 'edit',
        layouts: [
          {
            ticketTypeId: null,
            operation: 'edit',
            definition: { tabs: [{ name: 'A', sections: [{ fields: [key] }] }] },
          },
        ],
      });
      // A draft is judged as a save is, so only those who could save the set send one: Bob's
      // answer is the same for SECRET's field and for a field that does not exist.
      const hidden = await preview('bob', set.id, draftWith(`cf[${fieldId}]`));
      const missing = await preview('bob', set.id, draftWith('cf[999999]'));
      expect([hidden.statusCode, hidden.json()]).toEqual([403, { error: 'forbidden' }]);
      expect([missing.statusCode, missing.json()]).toEqual([403, { error: 'forbidden' }]);
      // Carol administers tracks, but a shared set is for site and configuration administrators.
      expect((await preview('carol', set.id, draftWith('summary'))).statusCode).toBe(403);
      // The administrators who may change the set hear the verdict.
      expect((await preview('admin', set.id, draftWith(`cf[${fieldId}]`))).json()).toEqual({
        error: 'invalid_request',
        detail: `cf[${fieldId}] belongs to another track`,
      });
      // A local-mode track's administrators preview drafts of its own set.
      const own = await track({ mode: 'local' }, 'POWN');
      const ownSet = await post('admin', '/api/v1/layout-sets', {
        name: `Own ${own}`,
        trackId: tracks[own],
      });
      expect(ownSet.statusCode, ownSet.body).toBe(201);
      const carols = await preview('carol', ownSet.json().layoutSet.id, draftWith('summary'));
      expect(carols.statusCode, carols.body).toBe(200);
      // SECRET's own type is unknown to Bob, as a type that does not exist is; not to admin.
      const saved = (ticketTypeId: number) => ({ ticketTypeId, operation: 'edit' });
      const hiddenType = await preview('bob', set.id, saved(typeId));
      const missingType = await preview('bob', set.id, saved(999999));
      expect([hiddenType.statusCode, hiddenType.json()]).toEqual([
        400,
        { error: 'unknown_ticket_type' },
      ]);
      expect([missingType.statusCode, missingType.json()]).toEqual([
        400,
        { error: 'unknown_ticket_type' },
      ]);
      expect((await preview('admin', set.id, saved(typeId))).statusCode).toBe(200);
      // Alice is in SECRET, so its type is hers to preview.
      expect((await preview('alice', set.id, saved(typeId))).statusCode).toBe(200);
    });
  });

  it('[CORE-003] a shared set names every track it reaches; defaults and sets in use stay', async () => {
    const one = await track();
    const two = await track();
    const rules = await ruleSet(
      [{ ticketTypeId: null, field: 'priority', required: true }],
      'Shared',
    );
    await use(one, { fieldRuleSetId: rules.id });
    await use(two, { fieldRuleSetId: rules.id });
    const read = (await get('alice', `/api/v1/field-rule-sets/${rules.id}`)).json().fieldRuleSet;
    expect(read.usedBy.map((t: { key: string }) => t.key)).toEqual([one, two]);
    const saved = await patch('admin', `/api/v1/field-rule-sets/${rules.id}`, {
      rules: [{ ticketTypeId: null, field: 'labels', required: true }],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const event = await database.db
      .selectFrom('domain_event')
      .select('payload')
      .where('type', '=', 'field_rule_set.updated')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect((event.payload as { trackIds: number[] }).trackIds).toEqual([tracks[one], tracks[two]]);
    // Both tracks follow at once.
    for (const key of [one, two]) {
      expect(errorsOf(await create(key, { ticketTypeId: types.Feature }))).toEqual({
        labels: 'required',
      });
    }
    expect(
      (await as('admin', { method: 'DELETE', url: `/api/v1/field-rule-sets/${rules.id}` })).json(),
    ).toEqual({ error: 'in_use', trackCount: 2 });
    const defaults = (await get('alice', '/api/v1/field-rule-sets')).json().fieldRuleSets as {
      id: number;
      isDefault: boolean;
    }[];
    const fallback = defaults.find((s) => s.isDefault) as { id: number };
    expect(
      (
        await as('admin', { method: 'DELETE', url: `/api/v1/field-rule-sets/${fallback.id}` })
      ).json(),
    ).toEqual({ error: 'default' });
    // Members read sets; only administrators change shared ones.
    expect(
      (await patch('alice', `/api/v1/field-rule-sets/${rules.id}`, { name: 'Mine' })).statusCode,
    ).toBe(403);
    // A track's administrator may not put a shared set on the track.
    const other = await ruleSet([], 'Other');
    expect(
      (await patch('carol', `/api/v1/tracks/${tracks[one]}`, { fieldRuleSetId: other.id }))
        .statusCode,
    ).toBe(403);
  });

  it('[CORE-013] applies rules to transition layouts: hidden fields take no value, required ones need one', async () => {
    const statuses = (await get('admin', '/api/v1/statuses')).json().statuses as {
      id: number;
      name: string;
    }[];
    const s = (name: string) => statuses.find((x) => x.name === name)?.id as number;
    const workflow = await post('admin', '/api/v1/workflows', {
      name: 'Plan flow',
      definition: {
        initialStatusId: s('New'),
        statuses: [{ statusId: s('New') }, { statusId: s('Active') }],
        transitions: [
          {
            id: 1,
            name: 'Plan',
            from: [s('New')],
            to: s('Active'),
            layout: ['due-date', 'labels'],
          },
        ],
      },
    });
    expect(workflow.statusCode, workflow.body).toBe(201);
    const key = await track();
    await use(key, {});
    // Every type of the track uses it, through a workflow map (M1-028).
    const map = await post('admin', '/api/v1/workflow-maps', {
      name: `Map ${key}`,
      defaultWorkflowId: workflow.json().workflow.id,
    });
    expect(map.statusCode, map.body).toBe(201);
    expect(
      (
        await patch('admin', `/api/v1/tracks/${tracks[key]}`, {
          workflowMapId: map.json().workflowMap.id,
        })
      ).statusCode,
    ).toBe(200);
    const rules = await ruleSet([
      { ticketTypeId: null, field: 'dueDate', required: true },
      { ticketTypeId: null, field: 'labels', hidden: true },
    ]);
    // The ticket is made before the rules apply, so it has no due date yet.
    const ticket = (await create(key, { ticketTypeId: types.Feature })).json().ticket;
    await use(key, { fieldRuleSetId: rules.id });
    const run = (fields: Record<string, unknown>) =>
      post('alice', `/api/v1/tickets/${ticket.id}/transitions`, { transitionId: 1, fields });
    expect(errorsOf(await run({ labels: ['x'] }))).toEqual({ labels: 'hidden' });
    expect(errorsOf(await run({}))).toEqual({ 'due-date': 'required' });
    const done = await run({ 'due-date': '2026-12-01' });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().ticket).toMatchObject({ status: { name: 'Active' }, dueDate: '2026-12-01' });
  });

  /**
   * The pages of a local-mode track's own sets (T-163a; ADR-114 section 8) let whoever runs the
   * track use them; the server stays the judge. Dana runs MINE and is a member of NEAR, both in
   * local mode; THEIRS is a local-mode track she is not in. She is no administrator.
   */
  describe('a local-mode track’s own administrators (T-163a)', () => {
    const del = (who: string, url: string) => as(who, { method: 'DELETE', url });
    const status = async (res: Promise<LightMyRequestResponse>) => (await res).statusCode;
    let mine = '';
    let near = '';
    let theirs = '';

    async function holds(who: string, key: string, role: string) {
      const roleId = (
        await database.db
          .selectFrom('role')
          .select('id')
          .where('name', '=', role)
          .executeTakeFirstOrThrow()
      ).id;
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: tracks[key] as number,
          role_id: roleId,
          user_id: users[who]?.id as number,
        })
        .execute();
    }

    beforeAll(async () => {
      mine = await track({ mode: 'local' }, 'TMINE');
      near = await track({ mode: 'local' }, 'TNEAR');
      theirs = await track({ mode: 'local' }, 'TTHEIRS');
      await holds('dana', mine, 'Administrators');
      await holds('dana', near, 'Members');
    });

    it('[IAM-030] lists only the tracks she runs, with their mode, for the web app to scope to', async () => {
      const session = (await get('dana', '/api/v1/session')).json().user;
      expect(session).toMatchObject({ isSiteAdmin: false, isConfigAdmin: false });
      expect(session.managesTracks).toBe(true);
      const runs = (await get('dana', '/api/v1/me/managed-tracks')).json().tracks;
      expect(runs).toEqual([{ id: tracks[mine], key: mine, name: mine, mode: 'local' }]);
    });

    for (const [path, one, plural] of [
      ['layout-sets', 'layoutSet', 'layoutSets'],
      ['field-rule-sets', 'fieldRuleSet', 'fieldRuleSets'],
    ] as const) {
      it(`[CORE-013] changes her own track’s ${path} and cannot read or change another track’s, nor change a shared one`, async () => {
        const url = `/api/v1/${path}`;
        const madeBy = async (who: string, body: Record<string, unknown>) => {
          const res = await post(who, url, body);
          expect(res.statusCode, res.body).toBe(201);
          return res.json()[one].id as number;
        };
        // Her own track's: made, read, renamed, listed, used by the track, and deleted unused.
        const own = await madeBy('dana', { name: `Dana ${path}`, trackId: tracks[mine] });
        expect(await status(get('dana', `${url}/${own}`))).toBe(200);
        expect(await status(patch('dana', `${url}/${own}`, { name: `Dana’s ${path}` }))).toBe(200);
        const listed = (await get('dana', `${url}?trackId=${tracks[mine]}`)).json()[plural] as {
          id: number;
          trackId: number | null;
        }[];
        expect(listed.filter((s) => s.trackId !== null).map((s) => s.id)).toEqual([own]);
        const column = path === 'layout-sets' ? 'layoutSetId' : 'fieldRuleSetId';
        expect(
          await status(patch('dana', `/api/v1/tracks/${tracks[mine]}`, { [column]: own })),
        ).toBe(200);
        const spare = await madeBy('dana', { name: `Spare ${path}`, trackId: tracks[mine] });
        expect(await status(del('dana', `${url}/${spare}`))).toBe(204);

        // A shared set: read as everyone signed in reads it, and never made, changed or deleted.
        const shared = await madeBy('admin', { name: `Shared ${path} for Dana` });
        expect(await status(get('dana', `${url}/${shared}`))).toBe(200);
        expect(await status(post('dana', url, { name: `Dana’s shared ${path}` }))).toBe(403);
        expect(await status(patch('dana', `${url}/${shared}`, { name: 'Taken' }))).toBe(403);
        expect(await status(del('dana', `${url}/${shared}`))).toBe(403);
        // Nor does she put a shared set on her track, or take the track back to the default.
        expect(
          await status(patch('dana', `/api/v1/tracks/${tracks[mine]}`, { [column]: shared })),
        ).toBe(403);
        expect(
          await status(patch('dana', `/api/v1/tracks/${tracks[mine]}`, { [column]: null })),
        ).toBe(403);

        // Another track's, one she is not in: as if it did not exist, in every answer.
        const other = await madeBy('admin', { name: `Theirs ${path}`, trackId: tracks[theirs] });
        expect(await status(get('dana', `${url}/${other}`))).toBe(404);
        expect(await status(patch('dana', `${url}/${other}`, { name: 'Taken' }))).toBe(404);
        expect(await status(del('dana', `${url}/${other}`))).toBe(404);
        expect(await status(post('dana', url, { name: 'In', trackId: tracks[theirs] }))).toBe(404);
        expect(await status(get('dana', `${url}?trackId=${tracks[theirs]}`))).toBe(404);
        const all = (await get('dana', url)).json()[plural] as { id: number }[];
        expect(all.map((s) => s.id)).not.toContain(other);
        expect(all.map((s) => s.id)).toContain(own);
        // Nor may her track use it.
        expect(
          await status(patch('dana', `/api/v1/tracks/${tracks[mine]}`, { [column]: other })),
        ).toBe(400);

        // A track she is a member of but does not run: she reads its sets and changes none.
        const nearby = await madeBy('admin', { name: `Near ${path}`, trackId: tracks[near] });
        expect(await status(get('dana', `${url}/${nearby}`))).toBe(200);
        expect(await status(patch('dana', `${url}/${nearby}`, { name: 'Taken' }))).toBe(403);
        expect(await status(del('dana', `${url}/${nearby}`))).toBe(403);
        expect(await status(post('dana', url, { name: 'In', trackId: tracks[near] }))).toBe(403);

        // Nothing she was refused changed: each set keeps its name.
        for (const [id, name] of [
          [shared, `Shared ${path} for Dana`],
          [other, `Theirs ${path}`],
          [nearby, `Near ${path}`],
        ] as const) {
          expect((await get('admin', `${url}/${id}`)).json()[one].name).toBe(name);
        }
      });
    }

    it('[CORE-008] previews drafts of her own track’s layout sets only, with its fields and types', async () => {
      const draft = {
        ticketTypeId: types.Feature,
        operation: 'create',
        layouts: [
          {
            ticketTypeId: null,
            operation: 'create',
            definition: { tabs: [{ name: 'A', sections: [{ fields: ['summary'] }] }] },
          },
        ],
      };
      const preview = (setId: number, body: Record<string, unknown>) =>
        status(post('dana', `/api/v1/layout-sets/${setId}/preview`, body));
      const made = async (body: Record<string, unknown>) =>
        (await post('admin', '/api/v1/layout-sets', body)).json().layoutSet.id as number;
      const own = await made({ name: 'Previewed by Dana', trackId: tracks[mine] });
      const shared = await made({ name: 'Shared, previewed' });
      const other = await made({ name: 'Theirs, previewed', trackId: tracks[theirs] });
      const nearby = await made({ name: 'Near, previewed', trackId: tracks[near] });
      expect(await preview(own, { ...draft, trackId: tracks[mine] })).toBe(200);
      // A draft of any other set is refused; one of a track she does not see is not found.
      expect(await preview(shared, draft)).toBe(403);
      expect(await preview(nearby, draft)).toBe(403);
      expect(await preview(other, draft)).toBe(404);
      // Her own set with another track's fields and rules: a track she does not see is not found.
      expect(await preview(own, { ...draft, trackId: tracks[theirs] })).toBe(404);
    });

    it('[CORE-005] reads and changes her own track’s type set, and no other', async () => {
      const typeSetOf = async (key: string) =>
        (await get('admin', `/api/v1/tracks/${tracks[key]}`)).json().track.typeSetId as number;
      const own = await typeSetOf(mine);
      const read = await get('dana', `/api/v1/type-sets/${own}`);
      expect(read.statusCode, read.body).toBe(200);
      const ids = (read.json().typeSet.ticketTypes as { id: number }[]).map((t) => t.id);
      expect(
        await status(patch('dana', `/api/v1/type-sets/${own}`, { ticketTypeIds: ids })),
      ).toBe(200);
      // Every type set at once, a new one and deleting her own are for administrators.
      expect(await status(get('dana', '/api/v1/type-sets'))).toBe(403);
      expect(
        await status(post('dana', '/api/v1/type-sets', { name: 'Dana', ticketTypeIds: ids })),
      ).toBe(403);
      expect(await status(del('dana', `/api/v1/type-sets/${own}`))).toBe(403);
      // Another track's: not found when she is not in it, refused when she only works in it.
      const other = await typeSetOf(theirs);
      expect(await status(get('dana', `/api/v1/type-sets/${other}`))).toBe(404);
      expect(
        await status(patch('dana', `/api/v1/type-sets/${other}`, { ticketTypeIds: ids })),
      ).toBe(404);
      const nearby = await typeSetOf(near);
      expect(await status(get('dana', `/api/v1/type-sets/${nearby}`))).toBe(403);
      expect(
        await status(patch('dana', `/api/v1/type-sets/${nearby}`, { ticketTypeIds: ids })),
      ).toBe(403);
      // A shared one, such as the default for software tracks.
      const shared = (await get('admin', '/api/v1/type-sets')).json().typeSets.find(
        (s: { trackId: number | null; defaultFor: string[] }) =>
          s.trackId === null && s.defaultFor.includes('software'),
      ) as { id: number; ticketTypes: { id: number }[] };
      expect(
        await status(
          patch('dana', `/api/v1/type-sets/${shared.id}`, {
            ticketTypeIds: shared.ticketTypes.map((t) => t.id),
          }),
        ),
      ).toBe(403);
    });
  });
});
