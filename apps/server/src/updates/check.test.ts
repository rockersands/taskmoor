import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { JobRunner } from '../events/queue';
import { createOutboundGuard, OutboundRefused } from '../outbound/guard';
import {
  CHECK_INTERVAL_MS,
  githubReleases,
  otherFrontends,
  RELEASES_URL,
  type ReleaseSource,
  registerUpdateCheckJobs,
  runUpdateCheck,
  scheduleUpdateCheck,
  UPDATE_TASK,
  updateStatus,
} from './check';

/**
 * The new-version notice (OPS-026, ADR-117). Every source here is a fake: nothing calls the
 * network, and GitHub's real answer is only imitated.
 */
const database = useMigratedDatabase();
const db = () => database.db;
const PASSWORD = 'harbour lantern willow';
const CONFIG = { version: '1.2.0', environmentOff: false };
const answering = (version: string | null): ReleaseSource => vi.fn(async () => version);
const failing: ReleaseSource = async () => {
  throw new Error('no route to host');
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function clearState() {
  await db()
    .deleteFrom('instance_setting')
    .where('key', 'in', ['update_check', 'update_check_result'])
    .execute();
  await db().deleteFrom('job').where('task', '=', UPDATE_TASK).execute();
}

describe('the release source (OPS-026)', () => {
  it('[OPS-026] sends an ordinary request that says nothing about the install', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({ tag_name: 'v1.4.0' }));
    expect(await githubReleases(fetchFn)()).toBe('1.4.0');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RELEASES_URL);
    expect(url).not.toContain('?');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({
      accept: 'application/vnd.github+json',
      'user-agent': 'taskmoor',
    });
  });

  it('[OPS-026] goes through the outbound guard of ADR-110, which refuses a private address', async () => {
    const guard = createOutboundGuard({
      resolve: async () => [{ address: '10.0.0.5', family: 4 }],
    });
    await expect(githubReleases(guard.fetch)()).rejects.toBeInstanceOf(OutboundRefused);
  });

  it('[OPS-026] keeps only a plain version from the answer', async () => {
    const version = (body: unknown) => githubReleases(async () => json(body))();
    expect(await version({ tag_name: '2.0.1' })).toBe('2.0.1');
    // Not published as a release, or nothing published: nothing to tell.
    expect(await version({ tag_name: 'v9.0.0', prerelease: true })).toBeNull();
    expect(await version({ tag_name: 'v9.0.0', draft: true })).toBeNull();
    expect(await githubReleases(async () => json({ message: 'Not Found' }, 404))()).toBeNull();
    // Anything else is a failed check, never text that reaches a command.
    await expect(version({ tag_name: '1.4.0; rm -rf /' })).rejects.toThrow('plain version');
    await expect(version({ tag_name: 'v1.4.0-rc.1' })).rejects.toThrow('plain version');
    await expect(version({})).rejects.toThrow('no tag');
    await expect(githubReleases(async () => json({}, 403))()).rejects.toThrow('403');
    await expect(githubReleases(async () => new Response('<html>'))()).rejects.toThrow();
  });

  it('[OPS-026] stops reading an answer that is far too large', async () => {
    const huge = new Response(new Uint8Array(3 * 1024 * 1024));
    await expect(githubReleases(async () => huge)()).rejects.toThrow('too large');
  });
});

describe('the daily check (OPS-026)', () => {
  beforeEach(clearState);

  it('[OPS-026] stores the newest version and offers the exact command', async () => {
    expect(await runUpdateCheck(db(), answering('1.4.0'), CONFIG)).toBe('checked');
    const status = await updateStatus(db(), CONFIG);
    expect(status).toMatchObject({
      version: '1.2.0',
      latest: '1.4.0',
      updateAvailable: true,
      command: 'bash update.sh 1.4.0',
      releaseUrl: 'https://github.com/Rockersands/taskmoor/releases/tag/v1.4.0',
    });
    expect(status.checkedAt).not.toBeNull();
  });

  it('[OPS-026] a kit that updates another way names its own command', async () => {
    await runUpdateCheck(db(), answering('1.4.0'), CONFIG);
    const status = await updateStatus(db(), {
      ...CONFIG,
      command: 'helm upgrade taskmoor deploy/helm/taskmoor --set image.tag={version}',
    });
    expect(status.command).toBe('helm upgrade taskmoor deploy/helm/taskmoor --set image.tag=1.4.0');
  });

  it('[OPS-026] offers nothing when this version is the newest, or newer', async () => {
    for (const version of ['1.2.0', '1.1.9', null]) {
      await runUpdateCheck(db(), answering(version), CONFIG);
      expect(await updateStatus(db(), CONFIG)).toMatchObject({
        updateAvailable: false,
        command: null,
        releaseUrl: null,
      });
    }
  });

  it('[OPS-026] a failed check is quiet, keeps the last answer and is retried a day later', async () => {
    await runUpdateCheck(db(), answering('1.3.0'), CONFIG, {
      now: new Date('2026-11-01T10:00:00Z'),
    });
    const debug = vi.fn();
    expect(
      await runUpdateCheck(db(), failing, CONFIG, {
        now: new Date('2026-11-02T10:00:00Z'),
        debug,
      }),
    ).toBe('failed');
    expect(debug).toHaveBeenCalledOnce();
    const status = await updateStatus(db(), CONFIG);
    expect(status.latest).toBe('1.3.0');
    expect(status.checkedAt).toBe('2026-11-01T10:00:00.000Z');
    // Not within the day; the next day it asks again.
    expect(await scheduleUpdateCheck(db(), CONFIG, new Date('2026-11-02T20:00:00Z'))).toBe(0);
    expect(await scheduleUpdateCheck(db(), CONFIG, new Date('2026-11-03T10:00:01Z'))).toBe(1);
  });

  it('[OPS-026] with no internet from the start, a failed check shows nothing at all', async () => {
    await runUpdateCheck(db(), failing, CONFIG);
    expect(await updateStatus(db(), CONFIG)).toMatchObject({
      latest: null,
      checkedAt: null,
      updateAvailable: false,
      command: null,
    });
  });

  it('[OPS-026] asks at most once a day, across workers and either side of midnight', async () => {
    const source = answering('1.4.0');
    const runner = new JobRunner(db(), 'worker-test', { tasks: [UPDATE_TASK] });
    registerUpdateCheckJobs(runner, db(), source, CONFIG);
    // Two workers on the same tick queue one job.
    const late = new Date('2026-11-01T23:58:00Z');
    expect(await scheduleUpdateCheck(db(), CONFIG, late)).toBe(1);
    expect(await scheduleUpdateCheck(db(), CONFIG, late)).toBe(0);
    expect(await runner.runOnce()).toBe(1);
    expect(source).toHaveBeenCalledTimes(1);
    // The job's attempt stands for "now"; a tick after midnight is still the same day's check.
    const asked = await updateStatus(db(), CONFIG);
    const after = new Date(Date.parse(asked.checkedAt as string) + 2 * 60 * 1000);
    expect(await scheduleUpdateCheck(db(), CONFIG, after)).toBe(0);
    expect(
      await scheduleUpdateCheck(
        db(),
        CONFIG,
        new Date(Date.parse(asked.checkedAt as string) + CHECK_INTERVAL_MS + 1000),
      ),
    ).toBe(1);
  });

  it('[OPS-026] the environment turns it off for good: nothing is asked or shown', async () => {
    await runUpdateCheck(db(), answering('1.4.0'), CONFIG);
    const off = { ...CONFIG, environmentOff: true };
    const source = answering('1.5.0');
    expect(await scheduleUpdateCheck(db(), off, new Date(Date.now() + 2 * CHECK_INTERVAL_MS))).toBe(
      0,
    );
    expect(await runUpdateCheck(db(), source, off)).toBe('off');
    expect(source).not.toHaveBeenCalled();
    expect(await updateStatus(db(), off)).toMatchObject({
      environmentOff: true,
      latest: null,
      updateAvailable: false,
      command: null,
    });
  });

  it('[OPS-026] a development build has no version to compare and asks nothing', async () => {
    const dev = { version: '0.0.0-dev', environmentOff: false };
    const source = answering('1.4.0');
    expect(await scheduleUpdateCheck(db(), dev)).toBe(0);
    expect(await runUpdateCheck(db(), source, dev)).toBe('off');
    expect(source).not.toHaveBeenCalled();
    expect((await updateStatus(db(), dev)).developmentBuild).toBe(true);
  });
});

describe('the frontends an update does not reach (OPS-025)', () => {
  it('[OPS-025] lists registered and listed origins, without the backend itself', async () => {
    expect(await otherFrontends(db(), 'https://api.acme.example', [])).toEqual([]);
    expect(
      await otherFrontends(db(), 'https://api.acme.example', ['https://api.acme.example']),
    ).toEqual([]);
    await db()
      .insertInto('frontend_origin')
      .values({ workspace_id: 1, origin: 'https://registered.example', label: 'Second' })
      .execute();
    expect(
      await otherFrontends(db(), 'https://api.acme.example/', [
        'https://listed.example',
        'https://registered.example',
        'https://api.acme.example',
      ]),
    ).toEqual(['https://listed.example', 'https://registered.example']);
  });
});

describe('the notice for site administrators (OPS-026)', () => {
  let app: FastifyInstance;
  let adminCookie = '';
  let memberCookie = '';

  const signIn = async (email: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
    const header = res.headers['set-cookie'];
    const list = Array.isArray(header) ? header : header ? [header] : [];
    return (
      list
        .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`))
        ?.split(';')[0] ?? ''
    );
  };

  beforeAll(async () => {
    app = await buildApp({ db: db(), version: '1.2.0', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    await db()
      .insertInto('app_user')
      .values([
        { workspace_id: 1, email: 'ada@example.com', name: 'Ada', password_hash: hash },
        { workspace_id: 1, email: 'bo@example.com', name: 'Bo', password_hash: hash },
      ])
      .execute();
    await db()
      .updateTable('app_user')
      .set({ is_site_admin: true })
      .where('email', '=', 'ada@example.com')
      .execute();
    adminCookie = await signIn('ada@example.com');
    memberCookie = await signIn('bo@example.com');
  });
  afterAll(() => app.close());
  beforeEach(clearState);

  it('[OPS-026] shows an administrator the new version and the command', async () => {
    await runUpdateCheck(db(), answering('1.4.0'), CONFIG);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/update-check',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().updateCheck).toMatchObject({
      version: '1.2.0',
      enabled: true,
      latest: '1.4.0',
      updateAvailable: true,
      command: 'bash update.sh 1.4.0',
    });
  });

  it('[OPS-026] normal people see nothing: not the route, and not the public meta endpoint', async () => {
    await runUpdateCheck(db(), answering('1.4.0'), CONFIG);
    const member = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/update-check',
      headers: { cookie: memberCookie },
    });
    expect(member.statusCode).toBe(403);
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/admin/update-check' });
    expect(anonymous.statusCode).toBe(401);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/update-check',
      headers: { cookie: memberCookie },
      payload: { enabled: false },
    });
    expect(put.statusCode).toBe(403);
    const meta = await app.inject({ method: 'GET', url: '/api/meta' });
    expect(meta.body).not.toContain('1.4.0');
  });

  it('[OPS-026] the setting stops the checks and hides the notice, and it is audited', async () => {
    await runUpdateCheck(db(), answering('1.4.0'), CONFIG);
    const off = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/update-check',
      headers: { cookie: adminCookie },
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().updateCheck).toMatchObject({
      enabled: false,
      latest: null,
      updateAvailable: false,
    });
    const source = answering('1.5.0');
    expect(await runUpdateCheck(db(), source, CONFIG)).toBe('off');
    expect(source).not.toHaveBeenCalled();
    expect(
      await scheduleUpdateCheck(db(), CONFIG, new Date(Date.now() + 2 * CHECK_INTERVAL_MS)),
    ).toBe(0);
    const events = await db()
      .selectFrom('domain_event')
      .select('payload')
      .where('type', '=', 'update_check.updated')
      .execute();
    expect(events.at(-1)?.payload).toEqual({ changes: { enabled: { from: true, to: false } } });
    // Back on: the same request again changes nothing and records nothing new.
    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/update-check',
      headers: { cookie: adminCookie },
      payload: { enabled: true },
    });
    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/update-check',
      headers: { cookie: adminCookie },
      payload: { enabled: true },
    });
    const after = await db()
      .selectFrom('domain_event')
      .select('id')
      .where('type', '=', 'update_check.updated')
      .execute();
    expect(after.length).toBe(events.length + 1);
  });

  it('[OPS-026] refuses a bad body', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/update-check',
      headers: { cookie: adminCookie },
      payload: { enabled: 'yes' },
    });
    expect(res.statusCode).toBe(400);
  });
});
