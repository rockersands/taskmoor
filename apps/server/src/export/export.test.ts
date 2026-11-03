import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { LocalStore } from '@taskmoor/storage';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { type AttachmentStores, storesOf } from '../attachments/stores';
import { SESSION_COOKIE } from '../auth';
import { FieldCatalogs } from '../fields/catalog';
import { IMPORT_FORMATS } from '../import/jobs';
import { fidelityReport } from '../import/report';
import { createRun, runImport } from '../import/run';
import { EXPORT_SOURCE, ExportSource } from '../import/taskmoor';
import { multipartFile } from '../testing/multipart';
import type { Manifest } from './format';
import { folderSink } from './sinks';
import { exportWorkspace, translationOf } from './write';

// Made at run time: tests keep no credentials in the repository.
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

/** The files of two manifests that differ, by name. */
function differences(a: Manifest, b: Manifest): string[] {
  const out: string[] = [];
  const names = new Set([...a.files, ...b.files].map((f) => f.name));
  for (const name of names) {
    const x = a.files.find((f) => f.name === name);
    const y = b.files.find((f) => f.name === name);
    if (x?.sha256 !== y?.sha256 || x?.records !== y?.records) out.push(name);
  }
  if (a.attachments.sha256 !== b.attachments.sha256) out.push('attachments/');
  return out;
}

/** The first lines that differ between two files, to name what was lost. */
async function firstDifference(a: string, b: string): Promise<string> {
  const x = (await readFile(a, 'utf8')).split('\n');
  const y = (await readFile(b, 'utf8')).split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return `line ${i + 1}\n  source: ${x[i]}\n  target: ${y[i]}`;
  }
  return 'same lines';
}

/**
 * The full export (M1-098; IMP-014): a workspace built through the API, so its rows are what
 * the routes write (history with transitions, starting values, comment and link entries,
 * mentions, custom values of every reference kind, a workflow and a map, files), is exported,
 * imported into a second, newly migrated database, and exported again with ids translated
 * back through the import's external ids: every file must have the same SHA-256 as before.
 */
describe('the full export (M1-098)', () => {
  const source = useMigratedDatabase();
  const target = useMigratedDatabase();
  let app: FastifyInstance;
  let dir = '';
  let sourceStores: AttachmentStores;
  let targetStores: AttachmentStores;
  const users: Record<string, { id: number; cookie: string }> = {};

  const as = async (who: string, options: InjectOptions, status?: number) => {
    const res = await app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
    if (status !== undefined) expect(res.statusCode, `${options.url} ${res.body}`).toBe(status);
    return res;
  };
  const admin = (options: InjectOptions, status = 200) => as('admin', options, status);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'taskmoor-export-'));
    sourceStores = storesOf(await LocalStore.open(join(dir, 'files-source')));
    targetStores = storesOf(await LocalStore.open(join(dir, 'files-target')));
    app = await buildApp({
      db: source.db,
      version: 'test',
      roles: ['api'],
      attachments: sourceStores,
    });
    const hash = await hashPassword(PASSWORD);
    for (const [name, isAdmin] of [
      ['admin', true],
      ['mira', false],
    ] as const) {
      const row = await source.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name: name === 'admin' ? 'Ada Admin' : 'Mira Member',
          password_hash: hash,
          is_site_admin: isAdmin,
          time_zone: name === 'mira' ? 'Europe/Madrid' : null,
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
    const mira = users.mira?.id as number;

    // Configuration: a group, a role, a status, a priority, a close reason, a link type.
    const group = (
      await admin({ method: 'POST', url: '/api/v1/groups', payload: { name: 'Reviewers' } }, 201)
    ).json().group.id;
    for (const member of [mira, users.admin?.id as number]) {
      await admin({ method: 'PUT', url: `/api/v1/groups/${group}/members/${member}` }, 204);
    }
    await admin({ method: 'POST', url: '/api/v1/roles', payload: { name: 'Auditors' } }, 201);
    const qa = (
      await admin(
        { method: 'POST', url: '/api/v1/statuses', payload: { name: 'QA', stage: 'active' } },
        201,
      )
    ).json().status.id;
    const blocker = (
      await admin(
        {
          method: 'POST',
          url: '/api/v1/priorities',
          payload: { name: 'Blocker', icon: 'priority-blocker' },
        },
        201,
      )
    ).json().priority.id;
    const obsolete = (
      await admin(
        { method: 'POST', url: '/api/v1/close-reasons', payload: { name: 'Obsolete' } },
        201,
      )
    ).json().closeReason.id;
    const causes = (
      await admin(
        {
          method: 'POST',
          url: '/api/v1/link-types',
          payload: { name: 'Causes', outward: 'causes', inward: 'is caused by' },
        },
        201,
      )
    ).json().linkType.id;

    // Tracks, releases, areas.
    const track = (
      await admin(
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key: 'RT', name: 'Round trip', mode: 'shared' },
        },
        201,
      )
    ).json().track.id;
    const ops = (
      await admin(
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key: 'OPS', name: 'Operations', mode: 'shared' },
        },
        201,
      )
    ).json().track.id;
    const members = await source.db
      .selectFrom('role')
      .select('id')
      .where('name', '=', 'Members')
      .executeTakeFirstOrThrow();
    for (const t of [track, ops]) {
      await admin(
        { method: 'PUT', url: `/api/v1/tracks/${t}/roles/${members.id}/users/${mira}` },
        204,
      );
    }
    const r1 = (
      await admin(
        {
          method: 'POST',
          url: `/api/v1/tracks/${track}/releases`,
          payload: { name: '1.0', releaseDate: '2026-12-01' },
        },
        201,
      )
    ).json().release.id;
    const r2 = (
      await admin(
        { method: 'POST', url: `/api/v1/tracks/${track}/releases`, payload: { name: '2.0' } },
        201,
      )
    ).json().release.id;
    const area = (
      await admin(
        {
          method: 'POST',
          url: `/api/v1/tracks/${track}/areas`,
          payload: { name: 'API', ownerId: mira, defaultAssignee: 'area_owner' },
        },
        201,
      )
    ).json().area.id;

    // Custom fields of every kind that names other objects, and a formula over one.
    const field = async (payload: Record<string, unknown>) =>
      (await admin({ method: 'POST', url: '/api/v1/fields', payload }, 201)).json().field;
    const severity = await field({
      name: 'Severity',
      type: 'select',
      context: {
        options: [
          { value: 'S1' },
          { value: 'S2', default: true },
          { value: 'Old', disabled: true },
        ],
      },
    });
    const region = await field({
      name: 'Region',
      type: 'cascading-select',
      context: {
        options: [{ value: 'Europe', children: [{ value: 'Madrid' }, { value: 'Lisbon' }] }],
      },
    });
    const tags = await field({
      name: 'Tags',
      type: 'select',
      multiple: true,
      context: { options: [{ value: 'a' }, { value: 'b' }] },
    });
    const points = await field({ name: 'Pts', type: 'number' });
    const reviewer = await field({ name: 'Reviewer', type: 'user' });
    const team = await field({ name: 'Team', type: 'group' });
    const topics = await field({ name: 'Topics', type: 'labels' });
    const notes = await field({ name: 'Notes', type: 'paragraph' });
    const ships = await field({ name: 'Ships in', type: 'release', multiple: true });
    await field({
      name: 'Double points',
      type: 'formula',
      config: { expression: '{Pts} * 2', output: 'number' },
    });
    const optionId = (
      f: {
        contexts: {
          options: { id: number; value: string; children?: { id: number; value: string }[] }[];
        }[];
      },
      value: string,
    ) => {
      for (const o of f.contexts[0]?.options ?? []) {
        if (o.value === value) return o.id;
        for (const c of o.children ?? []) if (c.value === value) return c.id;
      }
      throw new Error(value);
    };

    // A workflow with the new status, mapped to the second track.
    const statuses = (await admin({ method: 'GET', url: '/api/v1/statuses' })).json().statuses as {
      id: number;
      name: string;
    }[];
    const statusId = (n: string) => statuses.find((s) => s.name === n)?.id as number;
    const workflow = (
      await admin(
        {
          method: 'POST',
          url: '/api/v1/workflows',
          payload: {
            name: 'QA flow',
            definition: {
              initialStatusId: statusId('New'),
              statuses: [
                { statusId: statusId('New') },
                { statusId: qa },
                { statusId: statusId('Closed') },
              ],
              transitions: [
                {
                  id: 1,
                  name: 'Test',
                  from: [statusId('New')],
                  to: qa,
                  guards: { type: 'user-in-group', group: String(group) },
                },
                {
                  id: 2,
                  name: 'Done',
                  from: 'any',
                  to: statusId('Closed'),
                  layout: ['close-reason'],
                },
              ],
            },
          },
        },
        201,
      )
    ).json().workflow.id;
    const map = (
      await admin(
        {
          method: 'POST',
          url: '/api/v1/workflow-maps',
          payload: { name: 'QA map', defaultWorkflowId: workflow },
        },
        201,
      )
    ).json().workflowMap.id;
    await admin({ method: 'PATCH', url: `/api/v1/tracks/${ops}`, payload: { workflowMapId: map } });

    // Tickets: a parent and a subticket, every system field, custom values, a mention.
    const subtype = (
      await source.db
        .selectFrom('ticket_type as t')
        .innerJoin('hierarchy_level as l', 'l.id', 't.level_id')
        .select('t.id')
        .where('l.kind', '=', 'subticket')
        .executeTakeFirstOrThrow()
    ).id;
    const ticket = async (payload: Record<string, unknown>) =>
      (await admin({ method: 'POST', url: '/api/v1/tickets', payload }, 201)).json().ticket
        .id as number;
    const mention = (id: number, text: string) => ({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text },
            { type: 'mention', attrs: { id: String(id), label: 'Mira' } },
          ],
        },
      ],
    });
    const parent = await ticket({
      track: 'RT',
      summary: 'Parent with everything',
      description: mention(mira, 'Ask '),
      assigneeId: mira,
      startDate: '2026-11-01',
      dueDate: '2026-11-30',
      priorityId: blocker,
      labels: ['round-trip', 'export'],
      targetReleaseIds: [r1],
      foundInReleaseIds: [r2],
      areaIds: [area],
      originalEstimate: 7200,
      fields: {
        [severity.id]: optionId(severity, 'S1'),
        [region.id]: [optionId(region, 'Europe'), optionId(region, 'Madrid')],
        [tags.id]: [optionId(tags, 'b'), optionId(tags, 'a')],
        [points.id]: 5,
        [reviewer.id]: mira,
        [team.id]: group,
        [topics.id]: ['x', 'y'],
        [notes.id]: mention(mira, 'Notes for '),
        [ships.id]: [r2, r1],
      },
    });
    const child = await ticket({
      track: 'RT',
      summary: 'A subticket',
      ticketTypeId: subtype,
      parent: parent,
    });
    const other = await ticket({ track: 'OPS', summary: 'In the QA flow' });
    const gone = await ticket({ track: 'RT', summary: 'Into the trash' });

    // History: edits, a transition with its id, a close reason; comments, a link, time, a file.
    await admin({
      method: 'PATCH',
      url: `/api/v1/tickets/${parent}`,
      payload: { summary: 'Parent, renamed', fields: { [points.id]: 8 } },
    });
    await admin({
      method: 'POST',
      url: `/api/v1/tickets/${other}/transitions`,
      payload: { transitionId: 2 },
    });
    await admin({
      method: 'PATCH',
      url: `/api/v1/tickets/${other}`,
      payload: { closeReasonId: obsolete },
    });
    await admin(
      {
        method: 'POST',
        url: `/api/v1/tickets/${parent}/comments?format=markdown`,
        payload: { body: 'Reproduced on **staging**' },
      },
      201,
    );
    await admin(
      {
        method: 'POST',
        url: `/api/v1/tickets/${parent}/comments`,
        payload: { body: mention(mira, 'Only reviewers, '), visibility: { groupId: group } },
      },
      201,
    );
    await admin(
      {
        method: 'POST',
        url: `/api/v1/tickets/${parent}/links`,
        payload: { linkTypeId: causes, ticket: other },
      },
      201,
    );
    await admin(
      {
        method: 'POST',
        url: `/api/v1/tickets/${child}/time-entries`,
        payload: { duration: '1h 30m', description: 'Investigation' },
      },
      201,
    );
    await admin({ method: 'PUT', url: `/api/v1/tickets/${parent}/followers/${mira}` }, 204);
    await as('mira', { method: 'PUT', url: `/api/v1/tickets/${parent}/votes` });
    await admin(
      {
        method: 'POST',
        url: `/api/v1/tickets/${parent}/attachments`,
        ...multipartFile('notes.txt', 'text/plain', 'Investigation notes'),
      },
      201,
    );
    await admin(
      {
        method: 'POST',
        url: `/api/v1/tickets/${child}/attachments`,
        ...multipartFile('data.bin', 'application/octet-stream', randomBytes(70_000)),
      },
      201,
    );
    // [CORE-033] A checklist with an item in each state, in its own order.
    const steps = (
      await admin(
        {
          method: 'POST',
          url: `/api/v1/tickets/${parent}/checklists`,
          payload: { name: 'Steps', items: ['First', 'Second', 'Third', 'Fourth'] },
        },
        201,
      )
    ).json().checklists[0] as { id: number; items: { id: number }[] };
    for (const [i, state] of ['done', 'in_progress', 'rejected'].entries()) {
      await admin(
        {
          method: 'PATCH',
          url: `/api/v1/tickets/${parent}/checklists/${steps.id}/items/${steps.items[i]?.id}`,
          payload: { state },
        },
        200,
      );
    }
    await admin(
      {
        method: 'PUT',
        url: `/api/v1/tickets/${parent}/checklists/${steps.id}/items/order`,
        payload: { ids: [...steps.items.map((item) => item.id)].reverse() },
      },
      200,
    );
    await admin({ method: 'DELETE', url: `/api/v1/tickets/${gone}` }, 204);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const exportTo = async (
    name: string,
    db = source.db,
    stores = sourceStores,
    translate = null as Awaited<ReturnType<typeof translationOf>> | null,
  ) => {
    const out = join(dir, name);
    const { manifest } = await exportWorkspace(db, {
      workspaceId: 1,
      sink: folderSink(out),
      stores,
      catalogs: new FieldCatalogs(db),
      translate,
    });
    return { out, manifest };
  };

  const importInto = async (path: string, system: string, dryRun = false) => {
    const run = await createRun(target.db, {
      workspaceId: 1,
      userId: null,
      importSource: EXPORT_SOURCE,
      system,
      name: '',
      source: { format: EXPORT_SOURCE, path },
      dryRun,
    });
    const deps = {
      db: target.db,
      catalogs: new FieldCatalogs(target.db),
      formats: IMPORT_FORMATS,
      stores: targetStores,
    };
    expect(await runImport(deps, run.id, { until: Date.now() + 600_000, batch: 7 })).toBe(
      'finished',
    );
    const row = await target.db
      .selectFrom('import_run')
      .selectAll()
      .where('id', '=', run.id)
      .executeTakeFirstOrThrow();
    expect(row.status, row.last_error ?? '').toBe('done');
    return fidelityReport.parse(row.report);
  };

  it('[IMP-014] exports every kind of record with a manifest of counts and checksums', async () => {
    const { out, manifest } = await exportTo('a');
    const counts = Object.fromEntries(manifest.files.map((f) => [f.kind, f.records]));
    expect(counts).toMatchObject({
      ticket: 4,
      comment: 2,
      link: 1,
      time_entry: 1,
      attachment: 2,
      checklist: 1,
      workflow_map: 2,
    });
    expect(counts.history).toBeGreaterThan(8);
    expect(manifest.attachments.files).toBe(2);
    // Each file's checksum is the file's.
    const { createHash } = await import('node:crypto');
    for (const f of manifest.files) {
      const bytes = await readFile(join(out, f.name));
      expect(createHash('sha256').update(bytes).digest('hex'), f.name).toBe(f.sha256);
      expect(bytes.length).toBe(f.bytes);
    }
    // Every line is canonical JSON with an id.
    const tickets = (await readFile(join(out, 'tickets.ndjson'), 'utf8')).trim().split('\n');
    for (const line of tickets) {
      const record = JSON.parse(line);
      expect(typeof record.id).toBe('string');
      expect(Object.keys(record)).toEqual([...Object.keys(record)].sort());
    }
    // [CORE-033] A checklist item's times keep their microseconds, as the checklist's do.
    const [list] = (await readFile(join(out, 'checklists.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map(
        (l) =>
          JSON.parse(l) as {
            createdAt: string;
            items: { text: string; createdAt: string; updatedAt: string }[];
          },
      );
    const micro = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
    expect(list?.createdAt).toMatch(micro);
    const stored = await source.db
      .selectFrom('ticket_checklist_item')
      .select([
        'text',
        sql<string>`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'created',
        ),
        sql<string>`to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'updated',
        ),
      ])
      .execute();
    expect(list?.items).toHaveLength(4);
    for (const item of list?.items ?? []) {
      expect(item.createdAt, item.text).toMatch(micro);
      const row = stored.find((s) => s.text === item.text);
      expect({ createdAt: item.createdAt, updatedAt: item.updatedAt }, item.text).toEqual({
        createdAt: row?.created,
        updatedAt: row?.updated,
      });
    }
    // Parents come before their children.
    const order = tickets.map((l) => JSON.parse(l) as { id: string; parent: string | null });
    for (const [i, t] of order.entries()) {
      if (t.parent) expect(order.findIndex((p) => p.id === t.parent)).toBeLessThan(i);
    }
  });

  it('[IMP-009][IMP-014] a dry run of the export plans every record and writes nothing', async () => {
    const { out, manifest } = await exportTo('dry');
    const report = await importInto(out, manifest.system, true);
    expect(report.totals.failed, JSON.stringify(report.failures)).toBe(0);
    const tickets = await target.db.selectFrom('ticket').select('id').execute();
    expect(tickets).toHaveLength(0);
  });

  it('[IMP-014][IMP-010] an import of the export reproduces it exactly (per-file checksums)', async () => {
    const { out, manifest } = await exportTo('b');
    const report = await importInto(out, manifest.system);
    expect(report.totals.failed, JSON.stringify(report.failures)).toBe(0);
    expect(report.totals.fidelity).toBe(1);
    expect(
      report.sampleSummary.mismatched,
      JSON.stringify(report.samples.filter((s) => !s.match)),
    ).toBe(0);
    const translation = await translationOf(target.db, 1, EXPORT_SOURCE, manifest.system);
    const again = await exportTo('b-again', target.db, targetStores, translation);
    const differ = differences(manifest, again.manifest);
    const details: string[] = [];
    for (const name of differ.filter((d) => d.endsWith('.ndjson'))) {
      details.push(`${name}: ${await firstDifference(join(out, name), join(again.out, name))}`);
    }
    const detail = details.join('\n');
    expect(differ, detail).toEqual([]);
    // The side tables of custom values were written with the tickets.
    const sideRows = await target.db.selectFrom('v_option').select('ticket_id').execute();
    expect(sideRows.length).toBeGreaterThan(0);
  });

  it('[IMP-009] importing the same export again changes nothing', async () => {
    const { out, manifest } = await exportTo('c');
    const before = await target.db.selectFrom('ticket_change').select('id').execute();
    const report = await importInto(out, manifest.system);
    expect(report.totals.failed).toBe(0);
    for (const e of report.entities) expect(e.outcomes.created, e.kind).toBe(0);
    const after = await target.db.selectFrom('ticket_change').select('id').execute();
    expect(after.length).toBe(before.length);
  });

  it('[IMP-014] downloads the export as a ZIP that imports as the folder does', async () => {
    const forbidden = await as('mira', { method: 'GET', url: '/api/v1/admin/export' });
    expect(forbidden.statusCode).toBe(403);
    const res = await admin({ method: 'GET', url: '/api/v1/admin/export' });
    expect(res.headers['content-type']).toBe('application/zip');
    const zip = join(dir, 'download.zip');
    await writeFile(zip, res.rawPayload);
    const folder = await exportTo('d');
    const read = new ExportSource(zip);
    const kinds = await read.kinds();
    expect(kinds).toEqual(folder.manifest.files.map((f) => f.kind));
    for (const kind of kinds) {
      const fromZip = await read.read(kind, null, 10_000);
      const fromFolder = await new ExportSource(folder.out).read(kind, null, 10_000);
      expect(
        fromZip.map((r) => r.data),
        kind,
      ).toEqual(fromFolder.map((r) => r.data));
    }
    // Chosen tracks: one, or none (configuration only); an unknown key is refused.
    const one = await admin({ method: 'GET', url: '/api/v1/admin/export?tracks=OPS' });
    expect(one.headers['content-type']).toBe('application/zip');
    const none = await admin({ method: 'GET', url: '/api/v1/admin/export?tracks=' });
    expect(none.headers['content-type']).toBe('application/zip');
    await as('admin', { method: 'GET', url: '/api/v1/admin/export?tracks=NOPE' }, 400);
    const audited = await source.db
      .selectFrom('domain_event')
      .select(['type', 'actor_id', 'payload'])
      .where('type', '=', 'workspace.exported')
      .orderBy('id')
      .execute();
    expect(audited.map((e) => e.payload)).toEqual([
      { tracks: null },
      { tracks: ['OPS'] },
      { tracks: [] },
    ]);
    expect(audited.every((e) => e.actor_id === users.admin?.id)).toBe(true);
  });
});
