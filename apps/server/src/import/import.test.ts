import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { JobRunner } from '../events/queue';
import { FieldCatalogs } from '../fields/catalog';
import { IMPORT_FORMATS, registerImportJobs } from './jobs';
import type { ImportFormat } from './model';
import { type FidelityReport, fidelityReport } from './report';
import { SyntheticSource, syntheticFixture, syntheticFormat } from './synthetic';

// Made at run time: tests keep no credentials in the repository.
const PASSWORD = randomBytes(18).toString('base64url');
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

interface RunView {
  id: number;
  status: string;
  dryRun: boolean;
  currentKind: string | null;
  progress: { kind: string; read: number; created: number; failed: number }[];
  lastError: string | null;
}

/** Records per kind in a synthetic file, by parsing it as the source does. */
async function sourceCounts(text: string): Promise<Record<string, number>> {
  const source = new SyntheticSource(text);
  const out: Record<string, number> = {};
  for (const kind of await source.kinds()) {
    out[kind] = (await source.read(kind, null, 1_000_000)).length;
  }
  return out;
}

/**
 * The importer framework end to end (M1-086): a site administrator uploads a synthetic file,
 * the job imports it, the fidelity report accounts for every record, a second run updates
 * instead of duplicating, a dry run writes nothing and reports the same, a cancel ends a run.
 */
describe('imports (M1-086)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let runner: JobRunner;
  const users: Record<string, { id: number; cookie: string }> = {};

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  async function start(body: Record<string, unknown>, who = 'admin') {
    const res = await as(who, { method: 'POST', url: '/api/v1/admin/imports', payload: body });
    expect(res.statusCode, res.body).toBe(202);
    return res.json().importRun as RunView;
  }
  async function drain() {
    for (let i = 0; i < 500; i++) {
      if ((await runner.runOnce()) === 0) return;
    }
  }
  const view = async (id: number) =>
    (await as('admin', { method: 'GET', url: `/api/v1/admin/imports/${id}` })).json()
      .importRun as RunView;
  async function report(id: number): Promise<FidelityReport> {
    const res = await as('admin', { method: 'GET', url: `/api/v1/admin/imports/${id}/report` });
    expect(res.statusCode, res.body).toBe(200);
    return fidelityReport.parse(res.json().report);
  }
  const entity = (r: FidelityReport, kind: string) => r.entities.find((e) => e.kind === kind);
  const count = async (table: 'ticket' | 'app_user' | 'track' | 'ticket_comment' | 'time_entry') =>
    Number(
      (
        await database.db
          .selectFrom(table)
          .select((eb) => eb.fn.countAll().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    );

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    runner = new JobRunner(database.db, 'import-test');
    registerImportJobs(runner, database.db, new FieldCatalogs(database.db), { batch: 25 });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['carol', false],
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
  });
  afterAll(async () => {
    await app.close();
  });

  const fixture = syntheticFixture({ seed: 11, prefix: 'AB', tickets: 30 });

  it('[IMP-009][IMP-010] imports an uploaded file and accounts for every record in the report', async () => {
    const run = await start({ name: 'First', source: { format: 'synthetic', data: fixture } });
    expect(run.status).toBe('queued');
    await drain();
    const done = await view(run.id);
    expect(done.status, done.lastError ?? '').toBe('done');
    const r = await report(run.id);
    const counts = await sourceCounts(fixture);
    for (const e of r.entities) {
      expect(e.source, e.kind).toBe(counts[e.kind]);
      const o = e.outcomes;
      expect(o.created + o.updated + o.unchanged + o.linked + o.failed + o.skipped, e.kind).toBe(
        e.source,
      );
    }
    // Kinds without an importer are reported, never dropped silently (IMP-004, IMP-010).
    expect(r.unsupported).toEqual([
      { kind: 'board', count: counts.board, reason: 'no_importer_for_kind' },
      { kind: 'dashboard', count: counts.dashboard, reason: 'no_importer_for_kind' },
    ]);
    const codes = r.warnings.map((w) => `${w.kind}:${w.code}:${w.detail ?? ''}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        'user:unsupported_field:avatar',
        'user:placeholder_email:',
        'group:missing_reference:members',
        'status:status_not_in_workflow:ABDoing',
        'ticket:unknown_priority:Blocker',
        'ticket:type_not_offered:t1',
        'link:link_type_created:ABClones',
      ]),
    );
    expect(r.failures).toEqual([]);
    // Every ticket, comment and the rest reached the target, and the samples read back equal.
    for (const kind of ['user', 'group', 'track', 'ticket', 'comment', 'history', 'time_entry']) {
      expect(entity(r, kind)?.fidelity, kind).toBe(1);
    }
    expect(r.sampleSummary.compared).toBeGreaterThan(20);
    expect(r.samples.filter((s) => s.match === false)).toEqual([]);
    expect(r.totals.fidelity).toBe(1);

    // Keys are kept (IMP-011): AB SYN tickets keep their source numbers, gaps included, and the
    // track's counter continues after the highest.
    const tickets = await database.db
      .selectFrom('ticket as k')
      .innerJoin('track as t', 't.id', 'k.track_id')
      .select(['t.key', 'k.number', 'k.summary', 'k.id', 'k.time_spent'])
      .where('t.key', '=', 'ABSYN')
      .orderBy('k.number')
      .execute();
    const lines = fixture
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => JSON.parse(l));
    const sourceSyn = lines.filter((l) => l.kind === 'ticket' && l.track === 'p1');
    expect(tickets.map((t) => t.number)).toEqual(sourceSyn.map((l) => l.number));
    const created = await as('admin', {
      method: 'POST',
      url: '/api/v1/tickets',
      payload: { track: 'ABSYN', summary: 'After the import' },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().ticket.key).toBe(
      `ABSYN-${Math.max(...sourceSyn.map((l) => l.number)) + 1}`,
    );
    // The API reads imported tickets like any other, with their history and time spent.
    const first = sourceSyn[0];
    const read = await as('admin', { method: 'GET', url: `/api/v1/tickets/ABSYN-${first.number}` });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().ticket.summary).toBe(first.summary);
    const worked = lines
      .filter((l) => l.kind === 'time_entry' && l.ticket === first.id)
      .reduce((n, l) => n + l.seconds, 0);
    expect(tickets[0]?.time_spent).toBe(worked);
    const hist = await as('admin', {
      method: 'GET',
      url: `/api/v1/tickets/ABSYN-${first.number}/history`,
    });
    expect(hist.statusCode, hist.body).toBe(200);
    const fields = (hist.json().changes as { field: string; at: string }[]).map((c) => c.field);
    expect(fields).toEqual(expect.arrayContaining(['key', 'summary', 'status']));
    const createdAt = (hist.json().changes as { field: string; at: string }[]).find(
      (c) => c.field === 'key',
    )?.at;
    expect(createdAt).toBe(new Date(first.created).toISOString());
    // People the source hid or deleted are placeholders, deactivated, so attribution stays
    // (IMP-007).
    const hidden = await database.db
      .selectFrom('app_user')
      .select(['email', 'deactivated_at'])
      .where('name', 'in', ['ABPerson 7', 'ABPerson 8'])
      .orderBy('name')
      .execute();
    expect(hidden[0]?.email).toMatch(/^imported-[0-9a-f]{20}@placeholder\.invalid$/);
    expect(hidden[1]?.deactivated_at).not.toBeNull();
  });

  it('[IMP-009] a second run updates what changed and creates no duplicates', async () => {
    const before = {
      tickets: await count('ticket'),
      users: await count('app_user'),
      comments: await count('ticket_comment'),
      entries: await count('time_entry'),
    };
    const again = await start({ source: { format: 'synthetic', data: fixture } });
    await drain();
    const r = await report(again.id);
    for (const e of r.entities) {
      expect(e.outcomes.created, e.kind).toBe(0);
      expect(e.outcomes.unchanged, e.kind).toBe(e.source);
    }
    expect({
      tickets: await count('ticket'),
      users: await count('app_user'),
      comments: await count('ticket_comment'),
      entries: await count('time_entry'),
    }).toEqual(before);

    // An edit in the source reaches the ticket as an update, with a history entry.
    const lines = fixture.trim().split('\n');
    const index = lines.findIndex((l) => l.includes('"kind":"ticket"'));
    const edited = JSON.parse(lines[index] as string);
    lines[index] = JSON.stringify({ ...edited, summary: 'Edited in the source' });
    const third = await start({ source: { format: 'synthetic', data: `${lines.join('\n')}\n` } });
    await drain();
    const r3 = await report(third.id);
    expect(entity(r3, 'ticket')?.outcomes).toMatchObject({ updated: 1, created: 0 });
    expect(await count('ticket')).toBe(before.tickets);
    const ticket = await database.db
      .selectFrom('ticket')
      .select('id')
      .where('summary', '=', 'Edited in the source')
      .executeTakeFirstOrThrow();
    const change = await database.db
      .selectFrom('ticket_change')
      .select(['from_value', 'to_value', 'actor_id'])
      .where('ticket_id', '=', ticket.id)
      .where('field', '=', 'summary')
      .where('to_value', '=', 'Edited in the source')
      .executeTakeFirst();
    expect(change).toEqual({
      from_value: edited.summary,
      to_value: 'Edited in the source',
      actor_id: null,
    });
  });

  it('[IMP-009] a dry run writes nothing and reports what the real run then does', async () => {
    const other = syntheticFixture({ seed: 12, prefix: 'CD', tickets: 16 });
    const before = {
      tickets: await count('ticket'),
      users: await count('app_user'),
      tracks: await count('track'),
      comments: await count('ticket_comment'),
    };
    const dry = await start({ dryRun: true, source: { format: 'synthetic', data: other } });
    expect(dry.dryRun).toBe(true);
    await drain();
    const dryReport = await report(dry.id);
    expect({
      tickets: await count('ticket'),
      users: await count('app_user'),
      tracks: await count('track'),
      comments: await count('ticket_comment'),
    }).toEqual(before);
    expect(dryReport.totals.target).toBeNull();
    expect(dryReport.samples.every((s) => s.match === null && s.targetChecksum === null)).toBe(
      true,
    );

    const real = await start({ source: { format: 'synthetic', data: other } });
    await drain();
    const realReport = await report(real.id);
    const outcomes = (x: FidelityReport) =>
      x.entities.map((e) => ({ kind: e.kind, ...e.outcomes }));
    expect(outcomes(dryReport)).toEqual(outcomes(realReport));
    expect(dryReport.warnings).toEqual(realReport.warnings);
    expect(dryReport.unsupported).toEqual(realReport.unsupported);
    expect(dryReport.failures).toEqual(realReport.failures);
    expect(dryReport.samples.map((s) => [s.kind, s.sourceId])).toEqual(
      realReport.samples.map((s) => [s.kind, s.sourceId]),
    );
  });

  it('[IMP-010] the report downloads as HTML, escaped and self-contained', async () => {
    const run = await start({
      name: '<b>Escaped</b>',
      source: { format: 'synthetic', generate: { seed: 3, prefix: 'EF', tickets: 4 } },
    });
    await drain();
    const res = await as('admin', {
      method: 'GET',
      url: `/api/v1/admin/imports/${run.id}/report?format=html`,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.body).toContain('<h2>Entities</h2>');
    expect(res.body).toContain('<td>ticket</td>');
    expect(res.body).not.toMatch(/<script|src=|href=/);
  });

  it('[IMP-013] a cancel ends the run with a report of what it did', async () => {
    const run = await start({
      source: { format: 'synthetic', generate: { seed: 4, prefix: 'GH', tickets: 6 } },
    });
    const cancel = await as('admin', {
      method: 'POST',
      url: `/api/v1/admin/imports/${run.id}/cancel`,
    });
    expect(cancel.statusCode, cancel.body).toBe(202);
    await drain();
    const r = await report(run.id);
    expect(r.run.status).toBe('cancelled');
    expect((await view(run.id)).status).toBe('cancelled');
    const again = await as('admin', {
      method: 'POST',
      url: `/api/v1/admin/imports/${run.id}/cancel`,
    });
    expect(again.statusCode).toBe(409);
    const finished = await database.db
      .selectFrom('domain_event')
      .select(['type', 'actor_id', 'payload'])
      .where('subject_type', '=', 'import_run')
      .where('subject_id', '=', String(run.id))
      .orderBy('id')
      .execute();
    expect(finished.map((e) => e.type)).toEqual([
      'import_run.created',
      'import_run.cancelled',
      'import_run.finished',
    ]);
    expect(finished[2]?.actor_id).toBeNull();
    expect(finished[2]?.payload).toMatchObject({
      status: 'cancelled',
      requestedBy: users.admin?.id,
    });
  });

  it('[IMP-009] only site administrators import; a bad file is refused with its line', async () => {
    const refused = await as('carol', {
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: { source: { format: 'synthetic', data: fixture } },
    });
    expect(refused.statusCode).toBe(403);
    expect((await as('carol', { method: 'GET', url: '/api/v1/admin/imports' })).statusCode).toBe(
      403,
    );
    const bad = await as('admin', {
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: {
        source: {
          format: 'synthetic',
          data: '{"format":"taskmoor-synthetic","version":1,"system":"x"}\n{"kind":"user"}\n',
        },
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'invalid_source', line: 2 });
    expect(
      (await as('admin', { method: 'GET', url: '/api/v1/admin/imports/999999' })).statusCode,
    ).toBe(404);
    const list = await as('admin', { method: 'GET', url: '/api/v1/admin/imports' });
    expect(list.statusCode).toBe(200);
    expect(list.json().importRuns.length).toBeGreaterThan(3);
  });

  it('[IMP-007] links people by email and never changes an account it did not create', async () => {
    const file = (name: string, active: boolean) =>
      [
        { format: 'taskmoor-synthetic', version: 1, system: 'linking' },
        { kind: 'user', id: 'carol-source', email: 'Carol@Example.com', name, active },
        { kind: 'group', id: 'g', name: 'Linked people', members: ['carol-source'] },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n');
    const first = await start({ source: { format: 'synthetic', data: file('Carol S.', true) } });
    await drain();
    expect(entity(await report(first.id), 'user')?.outcomes).toMatchObject({ linked: 1 });
    const second = await start({ source: { format: 'synthetic', data: file('Renamed', false) } });
    await drain();
    expect(entity(await report(second.id), 'user')?.outcomes).toMatchObject({ linked: 1 });
    const carol = await database.db
      .selectFrom('app_user')
      .select(['id', 'name', 'deactivated_at'])
      .where('email', '=', 'carol@example.com')
      .executeTakeFirstOrThrow();
    expect(carol).toEqual({ id: users.carol?.id, name: 'carol', deactivated_at: null });
    // Content keeps pointing at the existing account.
    const member = await database.db
      .selectFrom('group_member as m')
      .innerJoin('user_group as g', 'g.id', 'm.group_id')
      .select('m.user_id')
      .where('g.name', '=', 'Linked people')
      .execute();
    expect(member).toEqual([{ user_id: users.carol?.id }]);
  });

  it('[IMP-009] a job that fails mid-run resumes from its checkpoint on the retry', async () => {
    // A source that loses its connection once, on its fourth page.
    let pages = 0;
    const flaky: ImportFormat = {
      ...syntheticFormat,
      open: (source) => {
        const inner = syntheticFormat.open(source);
        return {
          importSource: inner.importSource,
          system: inner.system,
          kinds: () => inner.kinds(),
          read: async (kind, after, limit) => {
            if (++pages === 4) throw new Error('connection lost');
            return inner.read(kind, after, limit);
          },
        };
      },
    };
    const flakyRunner = new JobRunner(database.db, 'import-flaky', { tasks: ['import.run'] });
    registerImportJobs(flakyRunner, database.db, new FieldCatalogs(database.db), {
      batch: 10,
      formats: { ...IMPORT_FORMATS, synthetic: flaky },
    });
    const run = await start({
      source: { format: 'synthetic', generate: { seed: 5, prefix: 'IJ', tickets: 8 } },
    });
    await flakyRunner.runOnce();
    const failed = await view(run.id);
    expect(failed.status).toBe('running');
    expect(failed.lastError).toBe('connection lost');
    // The retry waits for its backoff; here it is due at once.
    await sql`UPDATE job SET run_at = now() WHERE task = 'import.run' AND done_at IS NULL`.execute(
      database.db,
    );
    for (let i = 0; i < 50; i++) if ((await flakyRunner.runOnce()) === 0) break;
    const r = await report(run.id);
    expect(r.run.status).toBe('done');
    expect(r.failures).toEqual([]);
    expect(entity(r, 'ticket')).toMatchObject({ source: 8, target: 8, fidelity: 1 });
  });
});
