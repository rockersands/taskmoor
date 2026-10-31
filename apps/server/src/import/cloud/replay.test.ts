import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Database } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword, type PepperRing, pepperFromSecret, pepperRing } from '@taskmoor/iam';
import { stableJson } from '@taskmoor/testkit';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app';
import { SESSION_COOKIE } from '../../auth';
import { JobRunner } from '../../events/queue';
import { FieldCatalogs } from '../../fields/catalog';
import { contentSnapshot } from '../../testing/compat-compare';
import { importFormats, registerImportJobs } from '../jobs';
import { type FidelityReport, fidelityReport } from '../report';
import type { CloudRequest, CloudResponse, Transport } from './client';
import { readRecording, replayTransport } from './replay';

// biome-ignore lint/suspicious/noExplicitAny: fixture bodies are read field by field
type Any = any;

const FIXTURE = join(__dirname, '__fixtures__', 'compat-source.json');
const recording = readRecording(FIXTURE);
const TRACKS = ['ALP', 'BET'];

let address = 0;
const nextAddress = () => `100.93.${Math.floor(++address / 250) % 250}.${(address % 250) + 1}`;

/** A target server, its job runner and a signed-in site administrator. */
async function targetOf(
  db: Kysely<Database>,
  transport: () => Transport,
  client: Record<string, unknown> = {},
) {
  const peppers: PepperRing = pepperRing(pepperFromSecret(randomBytes(32)));
  const app = await buildApp({ db, version: 'test', roles: ['api'], peppers });
  const runner = new JobRunner(db, `cloud-replay-${randomBytes(4).toString('hex')}`);
  registerImportJobs(runner, db, new FieldCatalogs(db), {
    batch: 25,
    formats: importFormats({
      peppers,
      transport,
      client: { sleep: async () => {}, ...client },
      detailChunk: 6,
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
    for (let i = 0; i < 2000; i++) {
      if ((await runner.runOnce()) === 0) return;
    }
  };
  /** Starts a Cloud run against the replay with a token made now (the replay ignores it). */
  const start = async (extra: Record<string, unknown> = {}, dryRun = false) => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: {
        dryRun,
        source: {
          format: 'cloud-rest',
          baseUrl: recording.source,
          email: 'ada@example.com',
          token: randomBytes(24).toString('base64url'),
          pageSize: 5,
          ...extra,
        },
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    return res.body.importRun.id as number;
  };
  const report = async (id: number): Promise<FidelityReport> => {
    const res = await call({ method: 'GET', url: `/api/v1/admin/imports/${id}/report` });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return fidelityReport.parse(res.body.report);
  };
  return { app, call, drain, start, report };
}

/** What the source holds, read from the recorded answers themselves. */
function sourceFromFixture() {
  const issues = new Map<string, Any>();
  const comments = new Map<string, number>();
  const worklogs = new Map<string, number>();
  const sprints: Record<string, string[]> = {};
  const keyOf = new Map<string, string>();
  for (const e of recording.exchanges) {
    const r = e.response as Any;
    if (e.path.endsWith('/issue/bulkfetch')) {
      for (const i of r.issues) {
        issues.set(i.key, i);
        keyOf.set(String(i.id), i.key);
      }
    }
  }
  for (const e of recording.exchanges) {
    const r = e.response as Any;
    const m = /^\/rest\/api\/3\/issue\/(\d+)\/(comment|worklog)\?/.exec(e.path);
    if (m) {
      const key = keyOf.get(m[1] as string) as string;
      if (m[2] === 'comment') comments.set(key, r.comments.length);
      else worklogs.set(key, r.worklogs.length);
    }
    const s = /^\/rest\/agile\/1\.0\/sprint\/(\d+)\/issue\?/.exec(e.path);
    if (s) sprints[s[1] as string] = (r.issues as Any[]).map((i) => i.key).sort();
  }
  return { issues, comments, worklogs, sprints };
}

/**
 * The Cloud REST importer from recorded answers (M1-095; IMP-002, IMP-007, IMP-009; ADR-094).
 * The fixture was recorded from Taskmoor's own Jira-compatible API over synthetic data
 * (`cloud.test.ts`, `TASKMOOR_RECORD_CLOUD_FIXTURES=1`); nothing here calls a network.
 */
describe('Cloud REST import from a replay (M1-095)', () => {
  const clean = useMigratedDatabase();
  const faulty = useMigratedDatabase();
  const mapped = useMigratedDatabase();
  let golden: Awaited<ReturnType<typeof contentSnapshot>>;
  const apps: FastifyInstance[] = [];

  afterAll(async () => {
    for (const app of apps) await app.close();
  });

  describe('a clean run', () => {
    let t: Awaited<ReturnType<typeof targetOf>>;
    beforeAll(async () => {
      t = await targetOf(clean.db, () => replayTransport(recording));
      apps.push(t.app);
    }, 60_000);

    it('[IMP-002] imports from the replay, and the target holds what the source answered', async () => {
      const id = await t.start();
      await t.drain();
      const report = await t.report(id);
      expect(report.run.status).toBe('done');
      expect(report.totals.failed).toBe(0);
      expect(
        stableJson({
          entities: report.entities,
          warnings: report.warnings.map((w) => ({
            kind: w.kind,
            code: w.code,
            detail: w.detail,
            count: w.count,
          })),
          unsupported: report.unsupported,
        }),
      ).toMatchFileSnapshot('./__golden__/compat-source.report.json');
      golden = await contentSnapshot(t.call, TRACKS);
      expect(stableJson(golden)).toMatchFileSnapshot('./__golden__/compat-source.target.json');

      // Against the recorded answers: every issue, field by field.
      const source = sourceFromFixture();
      expect(Object.keys(golden.tickets).sort()).toEqual([...source.issues.keys()].sort());
      for (const [key, issue] of source.issues) {
        const got = golden.tickets[key];
        const f = issue.fields;
        expect(got.summary, key).toBe(f.summary);
        expect(got.status.name, key).toBe(f.status.name);
        expect(got.ticketType.name, key).toBe(f.issuetype.name);
        expect(got.assignee?.name ?? null, key).toBe(f.assignee?.displayName ?? null);
        expect(got.requester?.name ?? null, key).toBe(f.reporter?.displayName ?? null);
        expect(got.priority?.name ?? null, key).toBe(f.priority?.name ?? null);
        expect(got.labels, key).toEqual(f.labels);
        expect(got.dueDate, key).toBe(f.duedate);
        expect(got.parent, key).toBe(f.parent?.key ?? null);
        expect(got.createdAt, key).toBe(new Date(f.created.replace('+0000', 'Z')).toISOString());
        expect(
          got.targetReleases.map((r: Any) => r.name),
          key,
        ).toEqual(f.fixVersions.map((r: Any) => r.name));
        expect(
          got.areas.map((a: Any) => a.name),
          key,
        ).toEqual(f.components.map((a: Any) => a.name));
        expect(got.comments.length, key).toBe(source.comments.get(key) ?? 0);
        expect(got.timeEntries.length, key).toBe(source.worklogs.get(key) ?? 0);
      }
      const sprints = golden.boards.flatMap((b) => b.sprints);
      expect(sprints.map((s: Any) => s.tickets).sort()).toEqual(
        Object.values(source.sprints).sort(),
      );
    }, 120_000);

    it('[IMP-009] a second run against the same source changes nothing', async () => {
      const id = await t.start();
      await t.drain();
      const report = await t.report(id);
      const changed = report.entities.filter(
        (e) => e.outcomes.created + e.outcomes.updated + e.outcomes.failed > 0,
      );
      expect(changed).toEqual([]);
      expect(stableJson(await contentSnapshot(t.call, TRACKS))).toBe(stableJson(golden));
    }, 120_000);

    it('[IMP-002] refuses Atlassian hosts in tests, plain http elsewhere, and bad people files', async () => {
      const post = (source: Record<string, unknown>) =>
        t.call({
          method: 'POST',
          url: '/api/v1/admin/imports',
          payload: {
            source: { format: 'cloud-rest', token: randomBytes(12).toString('hex'), ...source },
          },
        });
      const atlassian = await post({ baseUrl: 'https://example.atlassian.net' });
      expect(atlassian.status).toBe(400);
      expect(atlassian.body.message).toMatch(/ADR-003/);
      expect((await post({ baseUrl: 'http://source.example.test' })).status).toBe(400);
      expect((await post({ baseUrl: 'https://user:pw@source.example.test' })).status).toBe(400);
      const csv = await post({
        baseUrl: recording.source,
        people: { mode: 'csv', data: 'source,taskmoor\n2,not-an-address\n' },
      });
      expect(csv.status).toBe(400);
      expect(csv.body).toMatchObject({ error: 'invalid_people_mapping', line: 2 });
    });
  });

  describe('throttling, failures and resume', () => {
    it('[IMP-002] [IMP-009] honours 429 and 503 with Retry-After, retries 5xx and network errors, and resumes after a failed attempt', async () => {
      const inner = replayTransport(recording);
      const waits: number[] = [];
      let clock = Date.UTC(2026, 9, 31, 12, 0, 0);
      const seen = new Map<string, number>();
      const log: string[] = [];
      let searches = 0;
      let bulks = 0;
      let networkDown = true;
      const transport: Transport = async (request: CloudRequest, authorization) => {
        const key = `${request.method} ${request.path} ${JSON.stringify(request.body ?? null)}`;
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        log.push(key);
        const no = (status: number, headers: Record<string, string> = {}): CloudResponse => ({
          status,
          headers,
          body: { errorMessages: ['slow down'], errors: {} },
        });
        if (request.path === '/rest/api/3/field' && n === 1) return no(429, { 'retry-after': '7' });
        if (request.path.endsWith('/search/jql')) {
          searches += 1;
          if (searches === 1) {
            return no(503, { 'retry-after': new Date(clock + 30_000).toUTCString() });
          }
        }
        // Repeated 429s without a Retry-After on one issue's changelog, 5xx on its comments.
        if (/\/issue\/3\/changelog/.test(request.path) && n <= 3) return no(429);
        if (/\/issue\/3\/comment/.test(request.path) && n <= 2) return no(500);
        // The network goes away at the third page's bulk fetch, for every attempt of it.
        if (request.path.endsWith('/issue/bulkfetch')) {
          bulks += 1;
          if (networkDown && bulks >= 3) throw new TypeError('fetch failed');
        }
        return inner(request, authorization);
      };
      const t = await targetOf(faulty.db, () => transport, {
        sleep: async (ms: number) => {
          waits.push(ms);
          clock += ms;
        },
        now: () => clock,
        random: () => 0.5,
        maxAttempts: 4,
      });
      apps.push(t.app);
      const id = await t.start();
      // The first attempt stops at the third page; its retry waits for the job's backoff.
      await t.drain();
      const stopped = await faulty.db
        .selectFrom('import_run')
        .select(['status', 'last_error', 'fetch_state'])
        .where('id', '=', String(id))
        .executeTakeFirstOrThrow();
      expect(stopped.status).toBe('running');
      expect(stopped.last_error).toMatch(/bulkfetch: network error/);
      expect((stopped.fetch_state as Any).search.pages).toBe(2);
      const before = log.length;

      // The network is back; the retry is due at once and resumes from the third page.
      networkDown = false;
      await sql`UPDATE job SET run_at = now() WHERE task = 'import.run' AND done_at IS NULL`.execute(
        faulty.db,
      );
      await t.drain();
      const report = await t.report(id);
      expect(report.run.status).toBe('done');
      expect(report.totals.failed).toBe(0);
      const after = log.slice(before);
      // The search went on with the stored page token: the first pages were not asked again.
      const searched = after.filter((l) => l.includes('/search/jql'));
      expect(searched.length).toBeGreaterThan(0);
      expect(searched.every((l) => l.includes('nextPageToken'))).toBe(true);
      expect(after.some((l) => l.includes('/rest/api/3/field'))).toBe(false);

      // The waits the server asked for, and the backoff: 750, 1,500 and 3,000 ms (jitter 0.5).
      expect(waits).toContain(7000);
      expect(waits).toContain(30_000);
      expect(waits.join(',')).toContain('750,1500,3000');
      const notes = report.warnings
        .filter((w) => w.kind === 'source')
        .map((w) => [w.code, w.count]);
      expect(notes).toEqual(
        expect.arrayContaining([
          ['source_throttled', expect.any(Number)],
          ['source_failures_retried', expect.any(Number)],
        ]),
      );

      // The same target as the clean run.
      expect(stableJson(await contentSnapshot(t.call, TRACKS))).toBe(stableJson(golden));
    }, 180_000);
  });

  describe('people mapping', () => {
    it('[IMP-007] maps people by SCIM or by a CSV file, and reports everyone unmapped', async () => {
      const t = await targetOf(mapped.db, () => replayTransport(recording));
      apps.push(t.app);
      // The target's own people: Cyd provisioned over SCIM, Bea made by hand under another address.
      const cyd = await mapped.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: 'cyd@example.com',
          name: 'Cyd (SCIM)',
          password_hash: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await mapped.db
        .insertInto('scim_user')
        .values({
          user_id: cyd.id,
          workspace_id: 1,
          user_name: 'cyd@example.com',
          external_id: 'idp-cyd',
          attributes: JSON.stringify({}),
        })
        .execute();
      const bea = await mapped.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: 'bea@example.org',
          name: 'Bea (target)',
          password_hash: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await mapped.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: 'ada@example.com',
          name: 'Ada (not SCIM)',
          password_hash: null,
        })
        .execute();

      // SCIM, as a dry run: only Cyd is provisioned; Ada has an account but not over SCIM.
      const dry = await t.start({ people: { mode: 'scim' } }, true);
      await t.drain();
      const scim = await t.report(dry);
      const unmapped = (r: FidelityReport) =>
        r.warnings.find((w) => w.kind === 'user' && w.code === 'person_unmapped');
      expect(unmapped(scim)).toMatchObject({ detail: 'scim', count: 2 });
      expect(scim.entities.find((e) => e.kind === 'user')?.outcomes).toMatchObject({
        linked: 1,
        created: 2,
      });

      // A CSV: Bea's account to the target's Bea, Cyd's to an address nobody has; Ada left out.
      const id = await t.start({
        people: {
          mode: 'csv',
          data: 'source,taskmoor\n2,bea@example.org\ncyd@example.com,nobody@example.org\n',
        },
      });
      await t.drain();
      const report = await t.report(id);
      expect(report.totals.failed).toBe(0);
      expect(unmapped(report)).toMatchObject({ detail: 'existing', count: 2 });
      // Bea's tickets are the target's Bea's; the others' are deactivated placeholders.
      const assignees = await mapped.db
        .selectFrom('ticket as t')
        .innerJoin('app_user as u', 'u.id', 't.assignee_id')
        .select(['u.id', 'u.email', 'u.deactivated_at'])
        .distinct()
        .execute();
      expect(assignees.some((a) => a.id === bea.id)).toBe(true);
      const others = assignees.filter((a) => a.id !== bea.id);
      expect(others.length).toBeGreaterThan(0);
      for (const a of others) {
        expect(a.email).toMatch(/@placeholder\.invalid$/);
        expect(a.deactivated_at).not.toBeNull();
      }
      // The records route lists each person with what became of them.
      const records = await t.call({
        method: 'GET',
        url: `/api/v1/admin/imports/${id}/records?kind=user`,
      });
      expect(
        (records.body.records as Any[])
          .map((r) => [r.label, r.outcome, r.warnings.length > 0])
          .sort(),
      ).toEqual([
        ['Ada Admin', 'created', true],
        ['Bea Builder', 'linked', false],
        ['Cyd Checker', 'created', true],
      ]);
    }, 180_000);
  });
});
