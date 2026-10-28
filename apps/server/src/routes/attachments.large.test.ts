import { appendFileSync, mkdtempSync, rmSync, statfsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { LocalStore } from '@taskmoor/storage';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { storesOf } from '../attachments/stores';
import { SESSION_COOKIE } from '../auth';
import { multipartFile } from '../testing/multipart';

/**
 * CORE-021 (1) at full size, on demand: with a 3 GiB limit a 2.5 GiB file uploads over real
 * HTTP to local disk while the process's memory stays flat; with a 1 GiB limit the same file is
 * refused soon after the first gigabyte. It writes gigabytes, so it runs only when asked:
 *
 *   TASKMOOR_LARGE_UPLOAD=1 pnpm verify --only=tests -- apps/server/src/routes/attachments.large.test.ts
 *
 * TASKMOOR_LARGE_UPLOAD_DIR puts the files on another disk; it needs 3 GB free there and
 * deletes what it wrote. TASKMOOR_LARGE_UPLOAD_REPORT names a file the measurements go to.
 */
function report(line: string): void {
  const file = process.env.TASKMOOR_LARGE_UPLOAD_REPORT;
  if (file) appendFileSync(file, `${line}\n`);
}
const GiB = 1024 ** 3;
const SIZE = Math.round(2.5 * GiB);

describe.skipIf(!process.env.TASKMOOR_LARGE_UPLOAD)('a 2.5 GB attachment (CORE-021 (1))', () => {
  const database = useMigratedDatabase();
  const root = mkdtempSync(
    join(process.env.TASKMOOR_LARGE_UPLOAD_DIR ?? tmpdir(), 'taskmoor-large-'),
  );
  let app: FastifyInstance;
  let port = 0;
  let cookie = '';
  let ticketId = 0;

  beforeAll(async () => {
    const free = statfsSync(root);
    if (free.bavail * free.bsize < SIZE + GiB) throw new Error(`not enough free space in ${root}`);
    app = await buildApp({
      db: database.db,
      version: 'test',
      attachments: storesOf(await LocalStore.open(root)),
    });
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'big@example.com',
        name: 'Big',
        password_hash: await hashPassword('ladder violet harbour'),
        is_site_admin: true,
      })
      .execute();
    const session = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'big@example.com', password: 'ladder violet harbour' },
    });
    cookie = [session.headers['set-cookie'] ?? []]
      .flat()
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
      ?.split(';')[0] as string;
    const as = (method: 'POST' | 'PUT', url: string, payload: object) =>
      app.inject({ method, url, payload, headers: { cookie } });
    await as('POST', '/api/v1/tracks', { key: 'BIG', name: 'Big files', mode: 'shared' });
    ticketId = (await as('POST', '/api/v1/tickets', { track: 'BIG', summary: 'Big' })).json().ticket
      .id;
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function send(limit: number) {
    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/attachment-settings',
      payload: { maxFileSize: limit },
      headers: { cookie },
    });
    let sent = 0;
    let left = SIZE;
    const body = multipartFile(
      'disk-image.raw',
      'application/octet-stream',
      new Readable({
        read() {
          if (left <= 0) {
            this.push(null);
            return;
          }
          const n = Math.min(left, 1024 * 1024);
          left -= n;
          sent += n;
          this.push(Buffer.alloc(n, 0x33));
        },
      }),
    );
    const before = process.memoryUsage().rss;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 100);
    const started = Date.now();
    try {
      const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest({
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `/api/v1/tickets/${ticketId}/attachments`,
          headers: { ...body.headers, cookie },
        });
        let answered = false;
        req.on('response', (res) => {
          answered = true;
          let text = '';
          res.on('data', (d: Buffer) => {
            text += d.toString();
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
        });
        req.on('error', (error) => {
          if (!answered) reject(error);
        });
        (body.payload as Readable).pipe(req);
      });
      return { ...answer, sent, growth: peak - before, seconds: (Date.now() - started) / 1000 };
    } finally {
      clearInterval(sampler);
    }
  }

  it('[CORE-021] uploads 2.5 GiB under a 3 GiB limit with flat memory', async () => {
    const result = await send(3 * GiB);
    report(
      `2.5 GiB upload: ${result.status} in ${result.seconds.toFixed(1)} s, peak RSS growth ${(result.growth / 1024 / 1024).toFixed(0)} MiB`,
    );
    expect(result.status, result.body).toBe(201);
    expect(JSON.parse(result.body).attachment.size).toBe(SIZE);
    expect(result.growth).toBeLessThan(256 * 1024 * 1024);
  }, 900_000);

  it('[CORE-021] refuses 2.5 GiB under a 1 GiB limit soon after the limit', async () => {
    const result = await send(GiB);
    report(
      `2.5 GiB against 1 GiB: ${result.status} after ${(result.sent / 1024 / 1024).toFixed(0)} MiB sent, ${result.seconds.toFixed(1)} s`,
    );
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body)).toEqual({ error: 'file_too_large', maxFileSize: GiB });
    expect(result.sent).toBeLessThan(SIZE);
  }, 900_000);
});
