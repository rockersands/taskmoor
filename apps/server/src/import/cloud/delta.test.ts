import { randomBytes } from 'node:crypto';
import type { Database } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword, type PepperRing, pepperFromSecret, pepperRing } from '@taskmoor/iam';
import type { InjectOptions } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app';
import { SESSION_COOKIE } from '../../auth';
import { JobRunner } from '../../events/queue';
import { FieldCatalogs } from '../../fields/catalog';
import { contentSnapshot } from '../../testing/compat-compare';
import { buildCompatSource, type CompatSource, SOURCE_URL } from '../../testing/compat-source';
import { importFormats, registerImportJobs } from '../jobs';
import { type FidelityReport, fidelityReport } from '../report';
import type { CloudRequest, Transport } from './client';

// biome-ignore lint/suspicious/noExplicitAny: native bodies are read field by field
type Any = any;
const TRACKS = ['ALP', 'BET'];

let address = 0;
const nextAddress = () => `100.96.${Math.floor(++address / 250) % 250}.${(address % 250) + 1}`;

/** A target server with its job runner and a signed-in site administrator. */
async function targetOf(db: Kysely<Database>, transport: () => Transport) {
  const peppers: PepperRing = pepperRing(pepperFromSecret(randomBytes(32)));
  const app = await buildApp({ db, version: 'test', roles: ['api'], peppers });
  const runner = new JobRunner(db, `cloud-delta-${randomBytes(4).toString('hex')}`);
  registerImportJobs(runner, db, new FieldCatalogs(db), {
    batch: 20,
    formats: importFormats({
      peppers,
      transport,
      client: { sleep: async () => {} },
      detailChunk: 7,
      // The source was filled seconds ago: only edits since the earlier fetch count.
      deltaOverlapMs: 0,
    }),
  });
  const password = randomBytes(18).toString('base64url');
  await db
    .insertInto('app_user')
    .values({
      workspace_id: 1,
      email: 'root@example.org',
      name: 'Target admin',
      password_hash: await hashPassword(password),
      is_site_admin: true,
    })
    .execute();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/session',
    payload: { email: 'root@example.org', password },
    remoteAddress: nextAddress(),
  });
  const set = [res.headers['set-cookie']].flat().filter(Boolean) as string[];
  const cookie = (set.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '').split(';')[0] ?? '';
  const call = async (options: InjectOptions) => {
    const r = await app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie },
    });
    let body: Any = null;
    try {
      body = r.body ? JSON.parse(r.body) : null;
    } catch {
      body = r.body;
    }
    return { status: r.statusCode, body };
  };
  const drain = async () => {
    for (let i = 0; i < 3000; i++) {
      if ((await runner.runOnce()) === 0) return;
    }
  };
  /** Starts a run, runs it to the end and returns its report. */
  const run = async (payload: Record<string, unknown>) => {
    const started = await call({ method: 'POST', url: '/api/v1/admin/imports', payload });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const id = started.body.importRun.id as number;
    await drain();
    const view = (await call({ method: 'GET', url: `/api/v1/admin/imports/${id}` })).body;
    expect(view.importRun.status, view.importRun.lastError ?? '').toBe('done');
    const report = fidelityReport.parse(
      (await call({ method: 'GET', url: `/api/v1/admin/imports/${id}/report` })).body.report,
    );
    return { id, report };
  };
  return { app, db, call, drain, run };
}

const outcomes = (report: FidelityReport, kind: string) =>
  report.entities.find((e) => e.kind === kind)?.outcomes;
const deleted = (report: FidelityReport) =>
  Object.fromEntries(
    report.warnings
      .filter((w) => w.code === 'deleted_in_source')
      .map((w) => [w.kind, { count: w.count, examples: w.examples }]),
  );

/** Rows of the product's own tables a run would change, as counts and sums. */
async function productState(db: Kysely<Database>) {
  const { rows } = await sql<Record<string, string>>`
    SELECT (SELECT count(*) FROM ticket) AS tickets,
           (SELECT coalesce(sum(version), 0) FROM ticket) AS versions,
           (SELECT max(updated_at)::text FROM ticket) AS updated,
           (SELECT count(*) FROM ticket_change) AS changes,
           (SELECT count(*) FROM ticket_comment) AS comments,
           (SELECT max(updated_at)::text FROM ticket_comment) AS comment_updated,
           (SELECT count(*) FROM time_entry) AS time_entries,
           (SELECT count(*) FROM change_log) AS change_log,
           (SELECT count(*) FROM board) AS boards,
           (SELECT count(*) FROM sprint) AS sprints`.execute(db);
  return rows[0];
}

/**
 * Delta runs of the Cloud REST importer (M1-096; IMP-009 (3); ADR-102): a first run, edits in
 * the source (a rename with an edited comment, a transition, a new comment, new time, a new
 * ticket and a deleted one) and in the target, then a delta run from the first run. The delta
 * fetches only the tickets updated since the first fetch began, and the target then holds
 * exactly what a fresh full import of the edited source holds, apart from what ADR-102 keeps:
 * the deleted ticket (reported, not removed) and the target's own edits. A second delta with no
 * changes in the source reports nothing created or updated and writes nothing.
 */
describe('Cloud REST delta runs (M1-096)', () => {
  const sourceDb = useMigratedDatabase();
  const targetDb = useMigratedDatabase();
  const freshDb = useMigratedDatabase();
  let source: CompatSource;
  let target: Awaited<ReturnType<typeof targetOf>>;
  let fresh: Awaited<ReturnType<typeof targetOf>>;
  const requests: CloudRequest[] = [];

  const first = () => ({
    name: 'First run',
    source: {
      format: 'cloud-rest',
      baseUrl: SOURCE_URL,
      email: source.email,
      token: source.token,
      pageSize: 5,
    },
  });

  beforeAll(async () => {
    source = await buildCompatSource(sourceDb.db);
    // The source's work is older than the first run: a delta finds only what changes after it.
    await sql`UPDATE ticket SET created_at = created_at - interval '2 days',
                                updated_at = updated_at - interval '2 days'`.execute(sourceDb.db);
    const logged: Transport = (request, authorization) => {
      requests.push(request);
      return source.transport(request, authorization);
    };
    target = await targetOf(targetDb.db, () => logged);
    fresh = await targetOf(freshDb.db, () => source.transport);
  }, 180_000);

  afterAll(async () => {
    await source?.app.close();
    await target?.app.close();
    await fresh?.app.close();
  });

  const must = async (options: InjectOptions, status = 200): Promise<Any> => {
    const res = await source.admin(options);
    expect(res.status, `${options.method} ${options.url}: ${JSON.stringify(res.body)}`).toBe(
      status,
    );
    return res.body;
  };
  const sourceId = async (key: string) =>
    String((await must({ method: 'GET', url: `/api/v1/tickets/${key}` })).ticket.id);

  it('[IMP-009] a delta run after edits in the source ends as a fresh import of the edited source', async () => {
    const one = await target.run(first());
    expect(one.report.failures).toEqual([]);
    expect(outcomes(one.report, 'ticket')?.created).toBe(22);

    // Edits in the target between the runs: one ticket the source leaves alone, one it changes.
    for (const key of ['ALP-2', 'ALP-7']) {
      const res = await target.call({
        method: 'PATCH',
        url: `/api/v1/tickets/${key}`,
        payload: { labels: ['edited-in-taskmoor'] },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }

    // Edits in the source.
    await must({
      method: 'PATCH',
      url: '/api/v1/tickets/ALP-7',
      payload: { summary: 'ALP-7 renamed after the first run', assigneeId: source.people.cyd },
    });
    const alp7Comments = (await must({ method: 'GET', url: '/api/v1/tickets/ALP-7/comments' }))
      .comments as Any[];
    expect(alp7Comments).toHaveLength(1);
    await must({
      method: 'PATCH',
      url: `/api/v1/tickets/ALP-7/comments/${alp7Comments[0].id}`,
      payload: {
        body: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Edited at cutover' }] }],
        },
      },
    });
    const transitions = (await must({ method: 'GET', url: '/api/v1/tickets/ALP-8/transitions' }))
      .transitions as { id: number; name: string }[];
    await must({
      method: 'POST',
      url: '/api/v1/tickets/ALP-8/transitions',
      payload: { transitionId: transitions.find((x) => x.name === 'Active')?.id },
    });
    await must(
      {
        method: 'POST',
        url: '/api/v1/tickets/ALP-9/comments',
        payload: {
          body: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Added at cutover' }] }],
          },
        },
      },
      201,
    );
    await must(
      {
        method: 'POST',
        url: '/api/v1/tickets/BET-2/time-entries',
        payload: { duration: '45m', description: 'Cutover work' },
      },
      201,
    );
    const types = (await must({ method: 'GET', url: '/api/v1/tickets/BET-1' })).ticket;
    await must(
      {
        method: 'POST',
        url: '/api/v1/tickets',
        payload: {
          track: 'BET',
          ticketTypeId: types.ticketType.id,
          summary: 'Filed after the first run',
        },
      },
      201,
    );
    const gone = await sourceId('ALP-11');
    await must({ method: 'DELETE', url: '/api/v1/tickets/ALP-11' }, 204);

    // The delta run: from the first run, with its settings and token.
    requests.length = 0;
    const two = await target.run({ name: 'Delta', deltaFrom: one.id });
    expect(two.report.failures).toEqual([]);
    expect(two.report.run.deltaFrom).toBe(one.id);
    // Only the changed tickets were fetched, then the site's ids were listed.
    const searches = requests.filter((r) => r.path.endsWith('/search/jql'));
    const deltaQuery = String((searches[0]?.body as Any)?.jql);
    expect(deltaQuery).toMatch(
      /^\(project in \(ALP, BET\)\) AND updated >= -\d+m ORDER BY key ASC$/,
    );
    const details = requests.filter((r) => /\/issue\/[^/]+\/changelog/.test(r.path));
    expect(details).toHaveLength(5);
    expect(outcomes(two.report, 'ticket')).toMatchObject({
      created: 1,
      updated: 4,
      unchanged: 0,
      failed: 0,
    });
    expect(outcomes(two.report, 'comment')).toMatchObject({ created: 1, updated: 1, failed: 0 });
    expect(outcomes(two.report, 'time_entry')).toMatchObject({ created: 1, failed: 0 });
    expect(two.report.entities.find((e) => e.kind === 'ticket')?.source).toBe(5);
    // The deleted ticket is reported, and the target keeps it.
    expect(deleted(two.report)).toEqual({ ticket: { count: 1, examples: [gone] } });
    const records = (
      await target.call({
        method: 'GET',
        url: `/api/v1/admin/imports/${two.id}/records?outcome=deleted`,
      })
    ).body.records as Any[];
    expect(records.map((r) => [r.kind, r.sourceId])).toEqual([['ticket', gone]]);
    expect((await target.call({ method: 'GET', url: '/api/v1/tickets/ALP-11' })).status).toBe(200);
    // ALP-7 was edited on both sides: the source's version won, and the record says so.
    const edited = two.report.warnings.find((w) => w.code === 'edited_in_target');
    expect(edited).toMatchObject({ kind: 'ticket', count: 1, examples: [await sourceId('ALP-7')] });

    // A fresh full import of the edited source, to compare with.
    const full = await fresh.run(first());
    expect(full.report.failures).toEqual([]);
    const want = await contentSnapshot(fresh.call, TRACKS);
    const got = await contentSnapshot(target.call, TRACKS);
    // What ADR-102 keeps: the ticket the source deleted, and the target's own edits.
    expect(Object.keys(got.tickets)).toContain('ALP-11');
    expect(Object.keys(want.tickets)).not.toContain('ALP-11');
    delete got.tickets['ALP-11'];
    expect(got.tickets['ALP-2'].labels).toEqual(['edited-in-taskmoor']);
    expect(want.tickets['ALP-2'].labels).not.toContain('edited-in-taskmoor');
    delete got.tickets['ALP-2'];
    delete want.tickets['ALP-2'];
    // ALP-7's labels went back to the source's: its history shows the edit and the way back.
    const own = (h: Any) => h.from === 'edited-in-taskmoor' || h.to === 'edited-in-taskmoor';
    expect(
      got.tickets['ALP-7'].history.filter(own).map((h: Any) => [h.field, h.from, h.to]),
    ).toEqual([
      ['labels', null, 'edited-in-taskmoor'],
      ['labels', 'edited-in-taskmoor', null],
    ]);
    got.tickets['ALP-7'].history = got.tickets['ALP-7'].history.filter((h: Any) => !own(h));
    expect(Object.keys(got.tickets)).toEqual(Object.keys(want.tickets));
    for (const key of Object.keys(want.tickets)) {
      expect(got.tickets[key], key).toEqual(want.tickets[key]);
    }
    expect(got.boards).toEqual(want.boards);
    // Not an empty comparison: the edits are there.
    expect(want.tickets['ALP-7'].summary).toBe('ALP-7 renamed after the first run');
    expect(want.tickets['BET-8'].summary).toBe('Filed after the first run');

    // A second delta with nothing changed: nothing created or updated, nothing written.
    const before = await productState(targetDb.db);
    const three = await target.run({ name: 'Delta again', deltaFrom: two.id });
    for (const e of three.report.entities) {
      expect(e.outcomes.created + e.outcomes.updated + e.outcomes.failed, e.kind).toBe(0);
    }
    expect(deleted(three.report)).toEqual({ ticket: { count: 1, examples: [gone] } });
    expect(await productState(targetDb.db)).toEqual(before);
  }, 600_000);

  it('[IMP-009] refuses a delta from a run it cannot start from, and a second run at once', async () => {
    const post = (payload: Record<string, unknown>) =>
      target.call({ method: 'POST', url: '/api/v1/admin/imports', payload });
    expect((await post({ deltaFrom: 999999 })).body.error).toBe('unknown_delta_run');
    expect((await post({ name: 'No source' })).body.error).toBe('invalid_fields');
    const dry = await post({ ...first(), dryRun: true });
    expect(dry.status).toBe(202);
    await target.drain();
    expect((await post({ deltaFrom: dry.body.importRun.id })).body.error).toBe(
      'delta_from_dry_run',
    );
    const done = (
      await target.call({ method: 'GET', url: '/api/v1/admin/imports' })
    ).body.importRuns.find((r: Any) => r.name === 'First run' && !r.dryRun);
    // Another site's settings do not make a delta of this one.
    const other = await post({
      deltaFrom: done.id,
      source: { ...first().source, baseUrl: 'https://other.example.test' },
    });
    expect(other.body.error).toBe('delta_source_mismatch');
    const queued = await post({ deltaFrom: done.id, dryRun: true });
    expect(queued.status).toBe(202);
    expect(queued.body.importRun.deltaFrom).toBe(done.id);
    const again = await post({ deltaFrom: done.id });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'run_in_progress', importRunId: queued.body.importRun.id });
    await target.drain();
  }, 300_000);
});
