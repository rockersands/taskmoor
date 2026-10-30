import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { stableJson } from '@taskmoor/testkit';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { AUDITED_EVENTS } from '../audit/subscriber';
import { SESSION_COOKIE } from '../auth';

// Made at run time: tests keep no credentials in the repository.
const PASSWORD = randomBytes(18).toString('base64url');
let address = 0;
const nextAddress = () => `100.77.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

type Side = 'source' | 'target';
type Json = Record<string, unknown>;

/**
 * Workflow files (M1-127; WF-011 (1)). Fixture workflows are exported from one instance (the
 * golden files are those downloads, byte for byte), imported into a second, newly migrated
 * one, and exported again: the documents are identical once the second has the objects the
 * first names. Before it has them, the import maps statuses by name, creates the missing one
 * and reports everything else it could not map, with each part made safe instead of failing.
 */
describe('workflow files (M1-127)', () => {
  const databases = { source: useMigratedDatabase(), target: useMigratedDatabase() };
  const apps = {} as Record<Side, FastifyInstance>;
  const cookies = {} as Record<string, string>;
  const ids = { source: {} as Record<string, number>, target: {} as Record<string, number> };
  /** Fixture workflow name to its id in the source. */
  const fixtures: Record<string, number> = {};

  const call = async (
    side: Side,
    options: InjectOptions,
    status?: number,
    who = 'admin',
  ): Promise<LightMyRequestResponse> => {
    const res = await apps[side].inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: cookies[`${side}:${who}`] ?? '' },
    });
    if (status !== undefined) expect(res.statusCode, `${options.url} ${res.body}`).toBe(status);
    return res;
  };
  const exported = (side: Side, workflowId: number, version?: number) =>
    call(
      side,
      {
        method: 'GET',
        url: `/api/v1/admin/workflows/${workflowId}/export${version ? `?version=${version}` : ''}`,
      },
      200,
    );
  const importNew = (side: Side, document: unknown, extra: Json = {}, status = 201) =>
    call(
      side,
      { method: 'POST', url: '/api/v1/admin/workflows/import', payload: { document, ...extra } },
      status,
    );
  const importDraft = (side: Side, workflowId: number, document: unknown, status = 200) =>
    call(
      side,
      {
        method: 'POST',
        url: `/api/v1/admin/workflows/${workflowId}/import`,
        payload: { document },
      },
      status,
    );

  /** People, and the workspace objects `objects` lists, on one side. */
  async function populate(side: Side, objects: boolean) {
    const db = databases[side].db;
    const hash = await hashPassword(PASSWORD);
    const people: [string, string, boolean][] = [
      ['admin', 'Ada Admin', true],
      ['nora', 'Nora Member', false],
      ...(objects ? ([['mira', 'Mira Member', false]] as [string, string, boolean][]) : []),
    ];
    for (const [who, name, isAdmin] of people) {
      const row = await db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${who}@example.com`,
          name,
          password_hash: hash,
          is_site_admin: isAdmin,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      ids[side][who] = row.id;
      const res = await apps[side].inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: `${who}@example.com`, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      cookies[`${side}:${who}`] = sessionCookie(res.headers['set-cookie']);
    }
    const created = async (url: string, payload: Json, key: string) =>
      (await call(side, { method: 'POST', url, payload }, 201)).json()[key].id as number;
    if (objects) {
      ids[side].reviewers = await created('/api/v1/groups', { name: 'Reviewers' }, 'group');
      ids[side].auditors = await created('/api/v1/roles', { name: 'Auditors' }, 'role');
      const track = await created(
        '/api/v1/tracks',
        { key: 'SRC', name: 'Source', mode: 'shared' },
        'track',
      );
      ids[side].release = await created(
        `/api/v1/tracks/${track}/releases`,
        { name: '1.0' },
        'release',
      );
      ids[side].area = await created(`/api/v1/tracks/${track}/areas`, { name: 'Backend' }, 'area');
    }
    for (const [table, key] of [
      ['status', 'status'],
      ['priority', 'priority'],
      ['close_reason', 'closeReason'],
      ['ticket_type', 'ticketType'],
      ['role', 'role'],
    ] as const) {
      const rows = await db.selectFrom(table).select(['id', 'name']).execute();
      for (const row of rows) ids[side][`${key}:${row.name}`] = row.id;
    }
  }

  const s = (name: string) => ids.source[`status:${name}`] as number;
  const t = (name: string) => String(s(name));

  /** A workflow naming every kind of workspace object the format carries. */
  const everything = () => {
    const group = String(ids.source.reviewers);
    const auditors = String(ids.source.auditors);
    const members = String(ids.source['role:Members']);
    const mira = String(ids.source.mira);
    const high = ids.source['priority:High'] as number;
    return {
      initialStatusId: s('New'),
      statuses: [
        { statusId: s('New'), x: 0, y: 0 },
        { statusId: s('Active'), x: 200, y: 0 },
        { statusId: s('QA'), x: 400, y: 0 },
        { statusId: s('Verify'), x: 600, y: 0 },
        { statusId: s('Closed'), x: 800, y: 0 },
      ],
      transitions: [
        {
          id: 1,
          name: 'Start',
          from: [s('New')],
          to: s('Active'),
          layout: ['assignee', 'priority'],
          guards: {
            all: [
              { type: 'user-in-group', group },
              {
                any: [
                  { type: 'user-in-any-role', roles: [auditors, members] },
                  { type: 'permission', permission: 'transition_tickets' },
                ],
              },
            ],
          },
          effects: [
            { type: 'update-field', field: 'priority', value: high },
            { type: 'assign-to-current-user' },
          ],
          properties: { 'opsbar-sequence': '10' },
          event: 'work-started',
        },
        {
          id: 2,
          name: 'To QA',
          from: [s('Active')],
          to: s('QA'),
          guards: { type: 'value-field', field: 'priority', op: '=', value: String(high) },
          checks: [
            { type: 'field-required', field: 'assignee', message: 'Someone must own it' },
            { type: 'regex', field: 'summary', pattern: '^[A-Z]' },
          ],
          effects: [
            { type: 'update-field', field: 'target-release', value: [ids.source.release] },
            { type: 'update-field', field: 'area', value: [String(ids.source.area)] },
          ],
        },
        {
          id: 3,
          name: 'Verify',
          from: [s('QA')],
          to: s('Verify'),
          guards: { type: 'previous-status', status: t('In Review') },
          checks: [
            { type: 'parent-status', statuses: [t('Active'), t('QA')] },
            { type: 'previous-state', status: t('Active'), mostRecentOnly: true },
            { type: 'permission', permission: 'close_tickets' },
          ],
          effects: [
            { type: 'set-visibility-level-from-role', levels: { [auditors]: 'Staff' } },
            { type: 'webhook', url: 'https://hooks.example.test/verified' },
          ],
        },
        {
          id: 4,
          name: 'Close',
          from: 'any',
          to: s('Closed'),
          layout: ['close-reason'],
          guards: { type: 'subticket-blocking', statuses: [t('Closed'), t('Cancelled')] },
          checks: [{ type: 'field-required', field: 'close-reason' }],
          effects: [
            {
              type: 'update-system-field',
              field: 'close-reason',
              value: String(ids.source['closeReason:Duplicate']),
            },
          ],
          triggers: [{ event: 'pull-request.merged' }],
        },
        {
          id: 5,
          name: 'Reopen',
          from: [s('Closed')],
          to: s('New'),
          guards: { type: 'separation-of-duties', transition: '4' },
          effects: [
            { type: 'clear-field', field: 'close-reason' },
            { type: 'copy-field', from: 'requester', to: 'assignee' },
          ],
        },
      ],
      onCreate: {
        effects: [{ type: 'update-field', field: 'assignee', value: mira }],
        event: 'ticket-opened',
      },
      rules: {
        '1': [
          { type: 'assign', to: { user: mira } },
          { type: 'restrict-who', users: [mira], groups: [group], roles: [auditors] },
        ],
        '2': [
          {
            type: 'restrict-field-value',
            field: 'ticket-type',
            value: String(ids.source['ticketType:Bug']),
          },
        ],
        '3': [
          { type: 'restrict-been-through', status: t('Active') },
          { type: 'validate-permission', permission: 'edit_tickets' },
        ],
      },
      statusPermissions: {
        [t('QA')]: { edit: [{ role: auditors }, { group }], transition: [{ group }] },
      },
    };
  };

  beforeAll(async () => {
    for (const side of ['source', 'target'] as const) {
      apps[side] = await buildApp({ db: databases[side].db, version: 'test', roles: ['api'] });
    }
    await populate('source', true);
    await populate('target', false);
    for (const [name, stage] of [
      ['QA', 'active'],
      ['Verify', 'active'],
    ] as const) {
      await call(
        'source',
        { method: 'POST', url: '/api/v1/statuses', payload: { name, stage } },
        201,
      );
    }
    // The target has a status of the same name in another stage.
    const verify = await call(
      'target',
      { method: 'POST', url: '/api/v1/statuses', payload: { name: 'Verify', stage: 'closed' } },
      201,
    );
    ids.target['status:Verify'] = verify.json().status.id;
    for (const row of await databases.source.db
      .selectFrom('status')
      .select(['id', 'name'])
      .execute()) {
      ids.source[`status:${row.name}`] = row.id;
    }
    const list = await call('source', { method: 'GET', url: '/api/v1/workflows' }, 200);
    fixtures.default = list.json().workflows.find((w: { isDefault: boolean }) => w.isDefault).id;
    for (const [name, definition] of [
      [
        'Simple',
        {
          initialStatusId: s('New'),
          statuses: [{ statusId: s('New') }, { statusId: s('Closed') }],
          transitions: [{ id: 1, name: 'Done', from: 'any', to: s('Closed') }],
        },
      ],
      ['Everything', everything()],
    ] as const) {
      const res = await call(
        'source',
        {
          method: 'POST',
          url: '/api/v1/workflows',
          payload: { name, description: `The ${name.toLowerCase()} fixture`, definition },
        },
        201,
      );
      fixtures[name.toLowerCase()] = res.json().workflow.id;
    }
  });
  afterAll(async () => {
    for (const app of Object.values(apps)) await app.close();
  });

  it('[WF-011] exports each fixture workflow as a versioned, self-describing document (golden)', async () => {
    for (const [name, workflowId] of Object.entries(fixtures)) {
      const res = await exported('source', workflowId);
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(String(res.headers['content-disposition'])).toMatch(
        /^attachment; filename=".+\.workflow\.json"/,
      );
      await expect(res.body).toMatchFileSnapshot(`./__golden__/workflow-file-${name}.json`);
      const document = res.json();
      expect(document.format).toBe('taskmoor-workflow');
      expect(document.version).toBe(1);
      // No database id leaves the workspace: document ids count from 1 per kind.
      expect(document.statuses.map((x: { id: number }) => x.id)).toEqual(
        document.statuses.map((_: unknown, i: number) => i + 1),
      );
    }
    const everything = (await exported('source', fixtures.everything as number)).json();
    expect(everything.statuses.map((x: Json) => `${x.name}:${x.stage}`)).toEqual([
      'New:new',
      'Active:active',
      'QA:active',
      'Verify:active',
      'Closed:closed',
      'In Review:active',
      'Cancelled:closed',
    ]);
    expect(everything.groups).toEqual([{ id: 1, name: 'Reviewers' }]);
    expect(everything.roles).toEqual([
      { id: 1, name: 'Auditors' },
      { id: 2, name: 'Members' },
    ]);
    expect(everything.people).toEqual([{ id: 1, name: 'Mira Member', email: 'mira@example.com' }]);
    expect(everything.releases).toEqual([{ id: 1, name: '1.0', track: 'SRC' }]);
    expect(everything.areas).toEqual([{ id: 1, name: 'Backend', track: 'SRC' }]);
    expect(everything.ticketTypes).toEqual([{ id: 1, name: 'Bug' }]);
    // An id's JSON type is kept: a number stays a number, text stays text.
    expect(everything.definition.transitions[0].effects[0]).toEqual({
      type: 'update-field',
      field: 'priority',
      value: 1,
    });
    expect(everything.definition.transitions[1].guards.value).toBe('1');
  });

  it('[WF-011] imports into the same workspace as an identical workflow', async () => {
    for (const workflowId of Object.values(fixtures)) {
      const document = (await exported('source', workflowId)).json();
      const res = await importDraft('source', workflowId, document);
      const workflow = res.json().workflow;
      expect(workflow.draft.definition).toEqual(workflow.published.definition);
      expect(res.json().report.problems).toEqual([]);
      expect(
        res.json().report.statuses.every((x: { outcome: string }) => x.outcome === 'matched'),
      ).toBe(true);
      await call('source', { method: 'DELETE', url: `/api/v1/workflows/${workflowId}/draft` }, 204);
    }
  });

  it('[WF-011] maps statuses by name into another workspace, creates the missing ones and reports the rest', async () => {
    const document = (await exported('source', fixtures.everything as number)).json();
    // What a file from a later version could name: a field and a permission this one lacks.
    const transitions = document.definition.transitions;
    transitions[1].checks.push({ type: 'field-required', field: 'risk-score' });
    transitions[1].layout = ['risk-score', 'assignee'];
    transitions[4].guards = {
      any: [transitions[4].guards, { type: 'permission', permission: 'approve_budgets' }],
    };
    const res = await importNew('target', document, { name: 'Everything, first try' });
    const { report, workflow } = res.json();
    await expect(stableJson(report)).toMatchFileSnapshot(
      './__golden__/workflow-file-import-report.json',
    );
    const status = (name: string) => report.statuses.find((x: { name: string }) => x.name === name);
    expect(status('New')).toMatchObject({ outcome: 'matched', statusId: ids.target['status:New'] });
    expect(status('QA')).toMatchObject({ outcome: 'created', stage: 'active' });
    expect(status('Verify')).toMatchObject({
      outcome: 'matched',
      stage: 'active',
      stageHere: 'closed',
    });
    const created = await databases.target.db
      .selectFrom('status')
      .select(['name', 'stage', 'description'])
      .where('id', '=', status('QA').statusId)
      .executeTakeFirstOrThrow();
    expect(created).toEqual({ name: 'QA', stage: 'active', description: '' });
    const kinds = new Set(report.problems.map((p: { kind: string }) => p.kind));
    expect([...kinds].sort()).toEqual([
      'area',
      'field',
      'group',
      'permission',
      'release',
      'role',
      'user',
    ]);

    // Nothing that did not map lets more people through.
    const definition = workflow.published.definition;
    const [start, toQa, verify, , reopen] = definition.transitions;
    expect(start.guards.all[0]).toEqual({ type: 'always-false' });
    expect(start.guards.all[1].any[0]).toEqual({
      type: 'user-in-any-role',
      roles: [String(ids.target['role:Members'])],
    });
    // A check on a field this version lacks is gone, so the transition is disabled.
    expect(toQa.guards).toEqual({
      all: [
        { type: 'always-false' },
        {
          type: 'value-field',
          field: 'priority',
          op: '=',
          value: String(ids.target['priority:High']),
        },
      ],
    });
    expect(toQa.layout).toEqual(['assignee']);
    expect(toQa.checks).toHaveLength(2);
    expect(toQa.effects).toEqual([]);
    expect(verify.effects[0]).toEqual({ type: 'set-visibility-level-from-role', levels: {} });
    // An unknown permission is kept: nobody holds it.
    expect(reopen.guards.any[1]).toEqual({ type: 'permission', permission: 'approve_budgets' });
    expect(definition.onCreate.effects).toEqual([]);
    expect(definition.rules['1']).toEqual([
      { type: 'restrict-who', users: [], groups: [], roles: [] },
    ]);
    expect(definition.statusPermissions).toEqual({
      [String(status('QA').statusId)]: { edit: [], transition: [] },
    });
  });

  it('[WF-011] round-trips every fixture identically once the other workspace has what it names', async () => {
    // The objects the source names, made in the target; Verify takes the source's stage.
    await populateNames();
    for (const [name, workflowId] of Object.entries(fixtures)) {
      const source = await exported('source', workflowId);
      const document = source.json();
      let back: LightMyRequestResponse;
      if (name === 'default') {
        // The target has its own default workflow: the file becomes its next draft.
        const list = await call('target', { method: 'GET', url: '/api/v1/workflows' }, 200);
        const target = list.json().workflows.find((w: { isDefault: boolean }) => w.isDefault).id;
        const res = await importDraft('target', target, document);
        expect(res.json().report.problems, name).toEqual([]);
        back = await exported('target', target, res.json().workflow.draft.version);
      } else {
        const res = await importNew('target', document);
        expect(res.json().report.problems, name).toEqual([]);
        back = await exported('target', res.json().workflow.id);
      }
      expect(back.body, name).toBe(source.body);
    }
  });

  async function populateNames() {
    const hash = await hashPassword(PASSWORD);
    await databases.target.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'mira@example.com',
        name: 'Mira Member',
        password_hash: hash,
      })
      .execute();
    for (const [url, payload] of [
      ['/api/v1/groups', { name: 'Reviewers' }],
      ['/api/v1/roles', { name: 'Auditors' }],
    ] as const) {
      await call('target', { method: 'POST', url, payload }, 201);
    }
    const track = (
      await call(
        'target',
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key: 'SRC', name: 'Source', mode: 'shared' },
        },
        201,
      )
    ).json().track.id;
    await call(
      'target',
      { method: 'POST', url: `/api/v1/tracks/${track}/releases`, payload: { name: '1.0' } },
      201,
    );
    await call(
      'target',
      { method: 'POST', url: `/api/v1/tracks/${track}/areas`, payload: { name: 'Backend' } },
      201,
    );
    await call(
      'target',
      {
        method: 'PATCH',
        url: `/api/v1/statuses/${ids.target['status:Verify']}`,
        payload: { stage: 'active' },
      },
      200,
    );
  }

  // After the round trip, which made "Simple" in the target.
  it('[WF-011] refuses what is not a workflow file and keeps nothing of a failed import', async () => {
    const document = (await exported('source', fixtures.simple as number)).json();
    const refused = async (body: unknown, error: string) => {
      const res = await importNew('target', body, {}, 400);
      expect(res.json().error).toBe(error);
      return res;
    };
    await refused({ hello: 'world' }, 'not_a_workflow_document');
    await refused({ ...document, version: 2 }, 'unsupported_version');
    const bad = await refused(
      { ...document, statuses: [{ ...document.statuses[0], stage: 'done' }] },
      'invalid_request',
    );
    expect(bad.json().detail.document[0].path).toBe('statuses.0.stage');
    // The definition names a status the table lacks.
    const unlisted = structuredClone(document);
    unlisted.definition.transitions[0].to = 9;
    const missing = await refused(unlisted, 'invalid_request');
    expect(missing.json().detail.document[0].path).toBe('statuses');
    // Statuses named twice would be one status here.
    await refused(
      {
        ...document,
        statuses: [document.statuses[0], { ...document.statuses[1], name: 'NEW' }],
      },
      'invalid_request',
    );
    // The definition cannot be saved (an effect sets an empty summary): the status it would
    // have made is not made either.
    const before = await databases.target.db.selectFrom('status').select('id').execute();
    const broken = structuredClone(document);
    broken.statuses.push({ id: 3, name: 'Parked', stage: 'new', description: '' });
    broken.definition.statuses.push({ statusId: 3 });
    broken.definition.transitions[0].effects = [
      { type: 'update-system-field', field: 'summary', value: '' },
    ];
    const res = await importNew('target', broken, { name: 'Broken' }, 400);
    expect(res.json().detail).toEqual({
      problem: 'invalid_value',
      transitionId: 1,
      field: 'summary',
    });
    expect(await databases.target.db.selectFrom('status').select('id').execute()).toEqual(before);
    // A name the workspace already has.
    expect((await importNew('target', document, { name: 'Simple' }, 409)).json().error).toBe(
      'name_taken',
    );
    // Only administrators read and write workflow files.
    await call(
      'source',
      { method: 'GET', url: `/api/v1/admin/workflows/${fixtures.simple}/export` },
      403,
      'nora',
    );
    await call(
      'source',
      { method: 'POST', url: '/api/v1/admin/workflows/import', payload: { document } },
      403,
      'nora',
    );
  });

  it('[WF-011] records exports and imports as audited events', async () => {
    const last = async () =>
      databases.source.db
        .selectFrom('domain_event')
        .select(['type', 'subject_id', 'payload'])
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow();
    const document = (await exported('source', fixtures.simple as number)).json();
    expect(await last()).toEqual({
      type: 'workflow.exported',
      subject_id: String(fixtures.simple),
      payload: { version: 1 },
    });
    // A table row nothing names makes no status.
    document.statuses.push({ id: 9, name: 'Unused', stage: 'new', description: '' });
    const copy = (await importNew('source', document, { name: 'Simple copy' })).json().workflow;
    expect(await last()).toEqual({
      type: 'workflow.imported',
      subject_id: String(copy.id),
      payload: { name: 'Simple copy', version: 1, draft: false, createdStatusIds: [], problems: 0 },
    });
    // The audit subscriber records both (IAM-013).
    expect(AUDITED_EVENTS).toEqual(
      expect.arrayContaining(['workflow.exported', 'workflow.imported']),
    );
  });
});
