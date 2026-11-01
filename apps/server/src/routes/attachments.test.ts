import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { LocalStore, type ObjectStore, S3Store } from '@taskmoor/storage';
import { FakeS3 } from '@taskmoor/storage/testing';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { buildApp } from '../app';
import { SWEEP_TASK, sweepStorage } from '../attachments/cleanup';
import { PROCESS_TASK, processAttachment } from '../attachments/jobs';
import type { AttachmentView } from '../attachments/records';
import { type AttachmentStores, storesOf } from '../attachments/stores';
import { MAX_LISTED } from '../attachments/zip';
import { SESSION_COOKIE } from '../auth';
import { testJpeg, testPng } from '../testing/images';
import { multipartFile } from '../testing/multipart';
import { craftZip } from '../testing/zip';
import { purgeExpired } from '../trash/purge';

const PASSWORD = 'ladder violet harbour';
const KEY_PATH = /^w\d+\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{32}$/;
let address = 0;
const nextAddress = () => `100.71.${Math.floor(++address / 250)}.${(address % 250) + 1}`;
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

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

/** A body made as it is read, never held whole; `onRead` counts what was taken. */
function generated(size: number, onRead: (n: number) => void = () => {}): Readable {
  let left = size;
  return new Readable({
    read() {
      if (left <= 0) {
        this.push(null);
        return;
      }
      const n = Math.min(left, 64 * 1024);
      left -= n;
      onRead(n);
      this.push(Buffer.alloc(n, 0x41));
    },
  });
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

interface TicketJson {
  id: number;
  key: string;
  version: number;
}

describe('attachments (M1-016)', () => {
  const database = useMigratedDatabase();
  const fake = new FakeS3(['taskmoor-files']);
  const scratch = mkdtempSync(join(tmpdir(), 'taskmoor-attach-'));
  const filesRoot = join(scratch, 'data', 'files');
  let local: LocalStore;
  let s3: S3Store;
  const apps: Record<'local' | 's3', FastifyInstance> = {} as never;
  const stores: Record<'local' | 's3', AttachmentStores> = {} as never;
  const users: Record<string, { id: number; cookie: string }> = {};

  const as = (app: FastifyInstance, who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const get = (who: string, url: string, backend: 'local' | 's3' = 'local') =>
    as(apps[backend], who, { method: 'GET', url });

  async function upload(
    who: string,
    ticket: TicketJson,
    name: string,
    type: string,
    content: Buffer | string | Readable,
    backend: 'local' | 's3' = 'local',
  ): Promise<LightMyRequestResponse> {
    return as(apps[backend], who, {
      method: 'POST',
      url: `/api/v1/tickets/${ticket.id}/attachments`,
      ...multipartFile(name, type, content),
    });
  }
  async function attach(
    who: string,
    ticket: TicketJson,
    name: string,
    type: string,
    content: Buffer | string,
    backend: 'local' | 's3' = 'local',
  ): Promise<AttachmentView> {
    const res = await upload(who, ticket, name, type, content, backend);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().attachment as AttachmentView;
  }
  async function createTicket(summary = 'Attachments'): Promise<TicketJson> {
    const res = await as(apps.local, 'alice', {
      method: 'POST',
      url: '/api/v1/tickets',
      payload: { track: 'ATT', summary },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().ticket as TicketJson;
  }
  const list = async (who: string, ticket: TicketJson) => {
    const res = await get(who, `/api/v1/tickets/${ticket.id}/attachments`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as {
      attachments: AttachmentView[];
      maxFileSize: number;
      canCreate: boolean;
    };
  };
  const contentUrl = (ticket: TicketJson, a: AttachmentView, query = '') =>
    `/api/v1/tickets/${ticket.id}/attachments/${a.id}/content${query}`;
  const setLimit = async (bytes: number) => {
    const res = await as(apps.local, 'admin', {
      method: 'PUT',
      url: '/api/v1/admin/attachment-settings',
      payload: { maxFileSize: bytes },
    });
    expect(res.statusCode, res.body).toBe(200);
  };
  const objectCount = () => filesUnder(filesRoot).filter((f) => !f.includes('.incoming')).length;
  const rowsOf = (table: 'storage_cleanup' | 'attachment') =>
    database.db.selectFrom(table).selectAll().execute();

  beforeAll(async () => {
    await fake.start();
    local = await LocalStore.open(filesRoot);
    s3 = new S3Store({
      bucket: 'taskmoor-files',
      region: fake.region,
      endpoint: fake.endpoint,
      forcePathStyle: true,
      prefix: 'attachments/',
      credentials: fake.credentials,
    });
    stores.local = storesOf(local, { others: [s3] });
    stores.s3 = storesOf(s3, { others: [local] });
    apps.local = await buildApp({ db: database.db, version: 'test', attachments: stores.local });
    apps.s3 = await buildApp({ db: database.db, version: 'test', attachments: stores.s3 });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['bob', false],
      ['carol', false],
      ['dave', false],
      ['erin', false],
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
      const res = await apps.local.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: `${name}@example.com`, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      users[name] = { id: row.id, cookie: sessionCookie(res.headers['set-cookie']) };
    }
    const roles = Object.fromEntries(
      (await database.db.selectFrom('role').select(['id', 'name']).execute()).map((r) => [
        r.name,
        r.id,
      ]),
    );
    const track = await as(apps.local, 'admin', {
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'ATT', name: 'Attachments', mode: 'shared' },
    });
    expect(track.statusCode, track.body).toBe(201);
    // Alice and Dave are members, Bob views, Carol administers; Erin is not in the track.
    for (const [who, role] of [
      ['alice', 'Members'],
      ['dave', 'Members'],
      ['bob', 'Viewers'],
      ['carol', 'Administrators'],
    ] as const) {
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: track.json().track.id,
          role_id: roles[role] as number,
          user_id: users[who]?.id as number,
        })
        .execute();
    }
  });
  afterAll(async () => {
    await apps.local?.close();
    await apps.s3?.close();
    s3?.destroy();
    await fake.stop();
    rmSync(scratch, { recursive: true, force: true });
  });

  describe.each(['local', 's3'] as const)('stored on %s', (backend) => {
    it(`[CORE-021] uploads through the API and downloads the same bytes (${backend})`, async () => {
      const ticket = await createTicket();
      const notes = 'Steps to reproduce:\n1. Open the board\n2. Résumé ✓\n';
      const binary = randomBytes(200_000);
      const text = await attach('alice', ticket, 'notes.txt', 'text/plain', notes, backend);
      const blob = await attach(
        'alice',
        ticket,
        'dump.bin',
        'application/octet-stream',
        binary,
        backend,
      );
      expect(text).toMatchObject({
        name: 'notes.txt',
        size: Buffer.byteLength(notes),
        contentType: 'text/plain; charset=utf-8',
        declaredType: 'text/plain',
        kind: 'text',
        sha256: sha256(Buffer.from(notes)),
        scan: 'clean',
        thumbnail: false,
        canDelete: true,
        author: { id: users.alice?.id, name: 'alice' },
      });
      expect(blob).toMatchObject({ kind: 'other', size: binary.length, sha256: sha256(binary) });
      const listed = await list('bob', ticket);
      expect(listed.attachments.map((a) => a.name)).toEqual(['notes.txt', 'dump.bin']);
      expect(listed.attachments.every((a) => a.canDelete === false)).toBe(true);
      const stored = await database.db
        .selectFrom('attachment')
        .select(['storage', 'storage_key'])
        .where('ticket_id', '=', ticket.id)
        .execute();
      expect(stored.every((s) => s.storage === backend && KEY_PATH.test(s.storage_key))).toBe(true);

      for (const [attachment, bytes, inline] of [
        [text, Buffer.from(notes), true],
        [blob, binary, false],
      ] as const) {
        const res = await get(
          'bob',
          contentUrl(ticket, attachment, '?disposition=inline'),
          backend,
        );
        let body: Buffer;
        let headers: Record<string, string | null>;
        if (backend === 's3') {
          // Never through the API: a redirect to a URL that lives five minutes.
          expect(res.statusCode).toBe(302);
          expect(res.body).toBe('');
          const location = String(res.headers.location);
          expect(location.startsWith(`${fake.endpoint}/taskmoor-files/attachments/w1/`)).toBe(true);
          expect(location).toContain('X-Amz-Expires=300');
          expect(res.headers['cache-control']).toBe('no-store');
          const signed = await fetch(location);
          expect(signed.status).toBe(200);
          body = Buffer.from(await signed.arrayBuffer());
          headers = {
            'content-type': signed.headers.get('content-type'),
            'content-disposition': signed.headers.get('content-disposition'),
          };
        } else {
          expect(res.statusCode).toBe(200);
          body = res.rawPayload;
          headers = {
            'content-type': String(res.headers['content-type']),
            'content-disposition': String(res.headers['content-disposition']),
          };
          expect(res.headers['x-content-type-options']).toBe('nosniff');
          expect(String(res.headers['content-security-policy'])).toContain('sandbox');
          expect(res.headers.etag).toBe(`"${attachment.sha256}"`);
        }
        expect(body.equals(bytes)).toBe(true);
        expect(headers['content-type']).toBe(attachment.contentType);
        expect(headers['content-disposition']).toBe(
          `${inline ? 'inline' : 'attachment'}; filename="${attachment.name}"; filename*=UTF-8''${attachment.name}`,
        );
      }
      const one = await get('bob', `/api/v1/tickets/${ticket.id}/attachments/${text.id}`, backend);
      expect(one.json().attachment).toMatchObject({ id: text.id, name: 'notes.txt' });
      const preview = await get(
        'bob',
        `/api/v1/tickets/${ticket.id}/attachments/${text.id}/text`,
        backend,
      );
      expect(preview.json()).toEqual({ text: notes, truncated: false });
    });

    it(`[CORE-021] admits a file under the limit and refuses one over it, keeping nothing (${backend})`, async () => {
      const ticket = await createTicket();
      const objects = backend === 's3' ? () => fake.objects('taskmoor-files').size : objectCount;
      const before = objects();
      // CORE-021 (1), scaled from bytes to gigabytes: with a "3 GB" limit a "2.5 GB" file uploads...
      await setLimit(3000);
      const big = Buffer.alloc(2500, 0x42);
      expect(
        (await attach('alice', ticket, 'big.bin', 'application/octet-stream', big, backend)).size,
      ).toBe(2500);
      expect(objects()).toBe(before + 1);
      // ...with a "1 GB" limit it is refused with a clear message, by its length...
      await setLimit(1000);
      const refused = await upload(
        'alice',
        ticket,
        'big.bin',
        'application/octet-stream',
        big,
        backend,
      );
      expect(refused.statusCode).toBe(413);
      expect(refused.json()).toEqual({ error: 'file_too_large', maxFileSize: 1000 });
      // ...and while streaming when no length is given.
      await setLimit(1024 * 1024);
      const streamed = generated(25 * 1024 * 1024);
      const chunked = await upload(
        'alice',
        ticket,
        'huge.bin',
        'application/octet-stream',
        streamed,
        backend,
      );
      expect(chunked.statusCode, chunked.body).toBe(413);
      expect(chunked.json()).toEqual({ error: 'file_too_large', maxFileSize: 1024 * 1024 });
      expect(objects()).toBe(before + 1);
      expect(fake.pendingUploads()).toEqual([]);
      expect((await rowsOf('storage_cleanup')).filter((r) => r.reason === 'upload')).toEqual([]);
      expect((await list('alice', ticket)).attachments.map((a) => a.name)).toEqual(['big.bin']);
      await setLimit(1024 ** 3);
    });
  });

  it('[CORE-021] stops reading an upload over the limit soon after the limit, over HTTP', async () => {
    const ticket = await createTicket();
    await setLimit(1024 * 1024);
    const server = await buildApp({ db: database.db, version: 'test', attachments: stores.local });
    try {
      await server.listen({ port: 0, host: '127.0.0.1' });
      const port = (server.server.address() as AddressInfo).port;
      let sent = 0;
      const total = 256 * 1024 * 1024;
      const body = multipartFile(
        'huge.bin',
        'application/octet-stream',
        generated(total, (n) => {
          sent += n;
        }),
      );
      // Windows resets a connection the server closes while the client still writes, and the
      // reset can arrive before the answer is read: there only the server's side is checked.
      const answer = await new Promise<{ status: number; body: string } | 'reset'>(
        (resolve, reject) => {
          const req = httpRequest({
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: `/api/v1/tickets/${ticket.id}/attachments`,
            headers: { ...body.headers, cookie: users.alice?.cookie ?? '' },
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
          // The server closes the connection once it has answered; writing on is refused.
          req.on('error', (error: NodeJS.ErrnoException) => {
            if (answered) return;
            if (process.platform === 'win32' && error.code === 'ECONNRESET') resolve('reset');
            else reject(error);
          });
          (body.payload as Readable).pipe(req);
        },
      );
      if (answer !== 'reset') {
        expect(answer.status).toBe(413);
        expect(JSON.parse(answer.body)).toEqual({
          error: 'file_too_large',
          maxFileSize: 1024 * 1024,
        });
      }
      // A quarter gigabyte offered, a few megabytes taken (socket buffers), nothing kept.
      expect(sent).toBeLessThan(64 * 1024 * 1024);
      expect((await list('alice', ticket)).attachments).toEqual([]);
    } finally {
      await server.close();
      await setLimit(1024 ** 3);
    }
  });

  it('[CORE-021] streams an upload of many megabytes to disk in chunks', async () => {
    const ticket = await createTicket();
    const size = 48 * 1024 * 1024 + 7;
    const res = await upload(
      'alice',
      ticket,
      'capture.raw',
      'application/octet-stream',
      generated(size),
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().attachment.size).toBe(size);
    expect(res.json().attachment.sha256).toBe(sha256(Buffer.alloc(size, 0x41)));
    const ranged = await as(apps.local, 'alice', {
      method: 'GET',
      url: contentUrl(ticket, res.json().attachment),
      headers: { range: 'bytes=1000-1009' },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['content-range']).toBe(`bytes 1000-1009/${size}`);
    expect(ranged.body).toBe('AAAAAAAAAA');
    const gone = await as(apps.local, 'alice', {
      method: 'DELETE',
      url: `/api/v1/tickets/${ticket.id}/attachments/${res.json().attachment.id}`,
    });
    expect(gone.statusCode).toBe(204);
  });

  it('[CORE-021] never lets a file name reach the file system', async () => {
    const ticket = await createTicket();
    const outside = join(scratch, 'etc');
    const names: [string, string][] = [
      ['../../etc/passwd', 'passwd'],
      ['../../../../../../tmp/evil.sh', 'evil.sh'],
      ['/etc/shadow', 'shadow'],
      ['C:\\Windows\\System32\\evil.dll', 'evil.dll'],
      ['..\\..\\boot.ini', 'boot.ini'],
      ['report\u0000.pdf.exe', 'report.pdf.exe'],
      ['invoice\u202efdp.exe', 'invoicefdp.exe'],
      ['..', 'attachment'],
      ['CON', '_CON'],
    ];
    for (const [given, expected] of names) {
      const res = await upload('alice', ticket, given, 'text/plain', `contents of ${expected}`);
      expect(res.statusCode, `${given}: ${res.body}`).toBe(201);
      expect(res.json().attachment.name, given).toBe(expected);
    }
    // Every stored file sits under the root at a random key; nothing landed beside it.
    for (const file of filesUnder(filesRoot)) {
      const path = relative(filesRoot, file).split(sep).join('/');
      expect(path.startsWith('.incoming/') || KEY_PATH.test(path), path).toBe(true);
    }
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(scratch, 'data', 'etc'))).toBe(false);
    // A download names the file safely in both header forms.
    const first = (await list('alice', ticket)).attachments[0] as AttachmentView;
    const res = await get('alice', contentUrl(ticket, first));
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="passwd"; filename*=UTF-8''passwd`,
    );
    // An id that is not this ticket's, or not an id, finds nothing.
    expect(
      (await get('alice', `/api/v1/tickets/${ticket.id}/attachments/..%2F..%2Fetc/content`))
        .statusCode,
    ).toBe(400);
    const other = await createTicket();
    expect((await get('alice', contentUrl(other, first))).statusCode).toBe(404);
  });

  it('[CORE-021] follows create and delete own/all attachment permissions', async () => {
    const ticket = await createTicket();
    const mine = await attach('alice', ticket, 'alice.txt', 'text/plain', 'from alice');
    const daves = await attach('dave', ticket, 'dave.txt', 'text/plain', 'from dave');
    // Bob views: he lists and downloads, but neither uploads nor deletes.
    expect((await list('bob', ticket)).canCreate).toBe(false);
    expect((await get('bob', contentUrl(ticket, mine))).statusCode).toBe(200);
    const refused = await upload('bob', ticket, 'bob.txt', 'text/plain', 'x');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'forbidden', permission: 'create_attachments' });
    const del = (who: string, a: AttachmentView) =>
      as(apps.local, who, {
        method: 'DELETE',
        url: `/api/v1/tickets/${ticket.id}/attachments/${a.id}`,
      });
    expect((await del('bob', mine)).json()).toEqual({
      error: 'forbidden',
      permission: 'delete_all_attachments',
    });
    // Dave deletes his own but not Alice's; Carol administers the track and deletes any.
    const forDave = (await list('dave', ticket)).attachments;
    expect(forDave.map((a) => [a.name, a.canDelete])).toEqual([
      ['alice.txt', false],
      ['dave.txt', true],
    ]);
    expect((await del('dave', mine)).statusCode).toBe(403);
    expect((await del('dave', daves)).statusCode).toBe(204);
    expect((await list('carol', ticket)).attachments.every((a) => a.canDelete)).toBe(true);
    expect((await del('carol', mine)).statusCode).toBe(204);
    // Erin cannot browse the track: the ticket and its files do not exist for her.
    const again = await attach('alice', ticket, 'again.txt', 'text/plain', 'again');
    expect((await get('erin', `/api/v1/tickets/${ticket.id}/attachments`)).statusCode).toBe(404);
    expect((await get('erin', contentUrl(ticket, again))).statusCode).toBe(404);
    expect((await get('erin', contentUrl(ticket, again), 's3')).statusCode).toBe(404);
    expect((await upload('erin', ticket, 'x.txt', 'text/plain', 'x')).statusCode).toBe(404);
    const anonymous = await apps.local.inject({
      method: 'GET',
      url: `/api/v1/tickets/${ticket.id}/attachments`,
      remoteAddress: nextAddress(),
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('[CORE-022] records adding and removing attachments in the history and the version', async () => {
    const ticket = await createTicket();
    const added = await attach('alice', ticket, 'trace.log', 'text/plain', 'trace');
    const view = async () => (await get('alice', `/api/v1/tickets/${ticket.id}`)).json().ticket;
    expect((await view()).version).toBe(ticket.version + 1);
    await as(apps.local, 'alice', {
      method: 'DELETE',
      url: `/api/v1/tickets/${ticket.id}/attachments/${added.id}`,
    });
    expect((await view()).version).toBe(ticket.version + 2);
    const changes = (await get('alice', `/api/v1/tickets/${ticket.id}/history?order=asc`)).json()
      .changes as {
      field: string;
      actor: { name: string };
      from: { value: string | null; display: string | null };
      to: { value: string | null; display: string | null };
    }[];
    expect(
      changes
        .filter((c) => c.field === 'attachment')
        .map((c) => [c.actor.name, c.from.value, c.from.display, c.to.value, c.to.display]),
    ).toEqual([
      ['alice', null, null, String(added.id), 'trace.log'],
      ['alice', String(added.id), 'trace.log', null, null],
    ]);
  });

  it('[CORE-025] keeps attachments through the trash and deletes their files when the purge comes', async () => {
    const ticket = await createTicket();
    const onDisk = await attach('alice', ticket, 'disk.txt', 'text/plain', 'on disk');
    const inBucket = await attach(
      'alice',
      ticket,
      'bucket.png',
      'image/png',
      testPng(10, 10),
      's3',
    );
    const keys = await database.db
      .selectFrom('attachment')
      .select(['storage', 'storage_key'])
      .where('ticket_id', '=', ticket.id)
      .orderBy('id')
      .execute();
    expect(keys.map((k) => k.storage)).toEqual(['local', 's3']);
    const trash = () =>
      as(apps.local, 'alice', { method: 'DELETE', url: `/api/v1/tickets/${ticket.id}` });
    // Alice may not delete tickets; Carol may.
    expect((await trash()).statusCode).toBe(403);
    const deleted = await as(apps.local, 'carol', {
      method: 'DELETE',
      url: `/api/v1/tickets/${ticket.id}`,
    });
    expect(deleted.statusCode, deleted.body).toBeLessThan(300);
    expect((await get('alice', `/api/v1/tickets/${ticket.id}/attachments`)).statusCode).toBe(404);
    expect((await get('alice', contentUrl(ticket, onDisk))).statusCode).toBe(404);
    // CORE-025 (3): restored, the ticket has its attachments, and they download.
    const restored = await as(apps.local, 'carol', {
      method: 'POST',
      url: `/api/v1/tickets/${ticket.id}/restore`,
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect((await list('alice', ticket)).attachments.map((a) => a.name)).toEqual([
      'disk.txt',
      'bucket.png',
    ]);
    expect((await get('alice', contentUrl(ticket, onDisk))).body).toBe('on disk');
    expect((await get('alice', contentUrl(ticket, inBucket), 's3')).statusCode).toBe(302);
    // Deleted again and past the retention, the purge removes the rows and queues the sweep,
    // which deletes the objects from both stores.
    await as(apps.local, 'carol', { method: 'DELETE', url: `/api/v1/tickets/${ticket.id}` });
    expect(await local.size(keys[0]?.storage_key as string)).not.toBeNull();
    const report = await purgeExpired(database.db, {
      now: new Date(Date.now() + 400 * 86_400_000),
    });
    expect(report.tickets).toBeGreaterThanOrEqual(1);
    expect(
      (
        await database.db
          .selectFrom('attachment')
          .select('id')
          .where('ticket_id', '=', ticket.id)
          .execute()
      ).length,
    ).toBe(0);
    const queued = await database.db
      .selectFrom('job')
      .select('task')
      .where('task', '=', SWEEP_TASK)
      .where('done_at', 'is', null)
      .execute();
    expect(queued.length).toBeGreaterThan(0);
    const cleanup = (await rowsOf('storage_cleanup')).map((r) => r.storage_key);
    for (const k of keys) expect(cleanup).toContain(k.storage_key);
    const swept = await sweepStorage(database.db, stores.local);
    expect(swept.failed).toBe(0);
    expect(await local.size(keys[0]?.storage_key as string)).toBeNull();
    expect(await s3.size(keys[1]?.storage_key as string)).toBeNull();
    expect((await rowsOf('storage_cleanup')).map((r) => r.storage_key)).not.toContain(
      keys[0]?.storage_key,
    );
    // Sweeping again finds nothing to do.
    expect((await sweepStorage(database.db, stores.local)).deleted).toBe(0);
  });

  it('[CORE-021] serves S3 objects only through short-lived signed URLs after the browse check', async () => {
    const ticket = await createTicket();
    const pdf = await attach(
      'alice',
      ticket,
      'spec.pdf',
      'application/pdf',
      '%PDF-1.7 synthetic',
      's3',
    );
    expect(pdf.kind).toBe('pdf');
    const res = await get('bob', contentUrl(ticket, pdf, '?disposition=inline'), 's3');
    const url = String(res.headers.location);
    const query = new URL(url).searchParams;
    expect(query.get('X-Amz-Expires')).toBe('300');
    expect(query.get('response-content-type')).toBe('application/pdf');
    expect(query.get('response-content-disposition')).toBe(
      `inline; filename="spec.pdf"; filename*=UTF-8''spec.pdf`,
    );
    // The bucket is private: the object without a signature is refused.
    const bare = new URL(url);
    bare.search = '';
    expect((await fetch(bare)).status).toBe(403);
    // Five minutes later the URL is dead; a new request makes a new one.
    const real = fake.now;
    fake.now = () => new Date(Date.now() + 301_000);
    try {
      expect((await fetch(url)).status).toBe(403);
    } finally {
      fake.now = real;
    }
    expect(
      (await fetch(String((await get('bob', contentUrl(ticket, pdf), 's3')).headers.location)))
        .status,
    ).toBe(200);
    // Someone who cannot browse the ticket gets no URL at all.
    const outsider = await get('erin', contentUrl(ticket, pdf), 's3');
    expect(outsider.statusCode).toBe(404);
    expect(outsider.headers.location).toBeUndefined();
  });

  it('[CORE-021] shows only harmless kinds inline and the rest as downloads', async () => {
    const ticket = await createTicket();
    const html = await attach(
      'alice',
      ticket,
      'page.html',
      'text/html',
      '<script>alert(1)</script>',
    );
    const png = await attach('alice', ticket, 'shot', 'application/octet-stream', testPng(4, 4));
    const fakePng = await attach(
      'alice',
      ticket,
      'evil.png',
      'image/png',
      Buffer.from([0, 1, 2, 3, 0xff]),
    );
    const svg = await attach(
      'alice',
      ticket,
      'logo.svg',
      'image/svg+xml',
      '<svg onload="alert(1)"/>',
    );
    const inline = async (a: AttachmentView) =>
      get('alice', contentUrl(ticket, a, '?disposition=inline'));
    // HTML and SVG are shown as plain text, never rendered.
    for (const a of [html, svg]) {
      const res = await inline(a);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(String(res.headers['content-security-policy'])).toContain('sandbox');
    }
    // A PNG is a PNG whatever it was called; bytes calling themselves PNG are not.
    expect((await inline(png)).headers['content-type']).toBe('image/png');
    expect(String((await inline(png)).headers['content-disposition'])).toMatch(/^inline;/);
    expect(fakePng.kind).toBe('other');
    expect(String((await inline(fakePng)).headers['content-disposition'])).toMatch(/^attachment;/);
  });

  it('[CORE-021] lists ZIP contents, streams one entry and guards against bombs and zip slip', async () => {
    const ticket = await createTicket();
    const readme = Buffer.from('Read me first.\n'.repeat(100));
    const zip = craftZip([
      { name: 'docs/' },
      { name: 'docs/readme.txt', data: readme },
      { name: 'image.png', data: testPng(8, 8), method: 0 },
      { name: '../../etc/cron.d/evil', data: Buffer.from('* * * * * root id') },
      { name: '/absolute.txt', data: Buffer.from('absolute') },
      // A bomb: its header claims 5 GB.
      { name: 'bomb.bin', data: Buffer.alloc(1000), declaredSize: 4_000_000_000 },
      // A liar: claims 10 bytes, holds a megabyte.
      { name: 'liar.bin', data: Buffer.alloc(1024 * 1024, 7), declaredSize: 10 },
    ]);
    const archive = await attach('alice', ticket, 'bundle.zip', 'application/zip', zip);
    expect(archive.kind).toBe('zip');
    const entriesUrl = `/api/v1/tickets/${ticket.id}/attachments/${archive.id}/entries`;
    for (const backend of ['local'] as const) {
      const listing = (await get('bob', entriesUrl, backend)).json();
      expect(listing.total).toBe(7);
      expect(listing.truncated).toBe(false);
      expect(
        listing.entries.map(
          (e: { path: string; size: number; directory: boolean; unsafe: boolean }) => [
            e.path,
            e.size,
            e.directory,
            e.unsafe,
          ],
        ),
      ).toEqual([
        ['docs/', 0, true, false],
        ['docs/readme.txt', readme.length, false, false],
        ['image.png', testPng(8, 8).length, false, false],
        ['../../etc/cron.d/evil', 17, false, true],
        ['/absolute.txt', 8, false, true],
        ['bomb.bin', 4_000_000_000, false, false],
        ['liar.bin', 10, false, false],
      ]);
    }
    const entry = (index: number) =>
      get('bob', `/api/v1/tickets/${ticket.id}/attachments/${archive.id}/entries/${index}/content`);
    const one = await entry(1);
    expect(one.statusCode).toBe(200);
    expect(one.rawPayload.equals(readme)).toBe(true);
    expect(one.headers['content-disposition']).toBe(
      `attachment; filename="readme.txt"; filename*=UTF-8''readme.txt`,
    );
    expect(one.headers['content-type']).toBe('application/octet-stream');
    // Zip slip: the entry downloads under its last segment only.
    expect((await entry(3)).headers['content-disposition']).toBe(
      `attachment; filename="evil"; filename*=UTF-8''evil`,
    );
    expect((await entry(0)).json()).toEqual({ error: 'entry_directory' });
    expect((await entry(99)).statusCode).toBe(404);
    // The bomb is refused by its declared size, against the workspace's limit.
    const bomb = await entry(5);
    expect(bomb.statusCode).toBe(413);
    expect(bomb.json()).toEqual({ error: 'entry_too_large', maxFileSize: 1024 ** 3 });
    // The liar stops where its header says it ends: its megabyte never comes out.
    const liar = await entry(6).catch(() => null);
    expect(liar?.rawPayload.includes(Buffer.alloc(11, 7)) ?? false).toBe(false);
    // Not a ZIP: refused.
    const text = await attach('alice', ticket, 'plain.txt', 'text/plain', 'x');
    expect(
      (await get('bob', `/api/v1/tickets/${ticket.id}/attachments/${text.id}/entries`)).json(),
    ).toEqual({ error: 'not_zip' });
  });

  it('[CORE-021] lists at most 10,000 entries of a large archive and reads it from S3 by ranges', async () => {
    const ticket = await createTicket();
    const many = craftZip(
      Array.from({ length: MAX_LISTED + 5 }, (_, i) => ({
        name: `f/${i}.txt`,
        data: Buffer.from(String(i)),
        method: 0 as const,
      })),
    );
    const archive = await attach('alice', ticket, 'many.zip', 'application/zip', many, 's3');
    const before = fake.requests.length;
    const listing = (
      await get('bob', `/api/v1/tickets/${ticket.id}/attachments/${archive.id}/entries`, 's3')
    ).json();
    expect(listing.total).toBe(MAX_LISTED + 5);
    expect(listing.entries).toHaveLength(MAX_LISTED);
    expect(listing.truncated).toBe(true);
    // A few block reads, not one request per entry.
    expect(fake.requests.length - before).toBeLessThan(10);
    const last = await get(
      'bob',
      `/api/v1/tickets/${ticket.id}/attachments/${archive.id}/entries/${MAX_LISTED + 4}/content`,
      's3',
    );
    expect(last.body).toBe(String(MAX_LISTED + 4));
  });

  it('[CORE-021] downloads all attachments as one ZIP with unique names', async () => {
    const ticket = await createTicket();
    await attach('alice', ticket, 'same.txt', 'text/plain', 'first');
    await attach('alice', ticket, 'same.txt', 'text/plain', 'second', 's3');
    await attach('alice', ticket, 'pic.png', 'image/png', testPng(16, 16));
    const res = await get('bob', `/api/v1/tickets/${ticket.id}/attachments/archive`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="${ticket.key}-attachments.zip"; filename*=UTF-8''${ticket.key}-attachments.zip`,
    );
    const zip = await yauzl.fromBufferPromise(res.rawPayload, { lazyEntries: true });
    const found: Record<string, string> = {};
    for await (const entry of zip.eachEntry()) {
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      found[entry.fileName] = Buffer.concat(chunks).toString('latin1');
    }
    expect(Object.keys(found)).toEqual(['same.txt', 'same (2).txt', 'pic.png']);
    expect([found['same.txt'], found['same (2).txt']]).toEqual(['first', 'second']);
    expect(Buffer.from(found['pic.png'] as string, 'latin1').equals(testPng(16, 16))).toBe(true);
    const empty = await createTicket();
    expect((await get('bob', `/api/v1/tickets/${empty.id}/attachments/archive`)).statusCode).toBe(
      404,
    );
  });

  it('[CORE-021] serves nothing a scan has not cleared', async () => {
    let verdict: 'clean' | 'infected' | 'error' = 'clean';
    const scanned = await buildApp({
      db: database.db,
      version: 'test',
      attachments: {
        ...stores.local,
        scanner: {
          name: 'test',
          scan: async (body) => {
            for await (const _ of body) {
              // read it all, as a scanner does
            }
            if (verdict === 'error') throw new Error('scanner down');
            return verdict === 'clean'
              ? { result: 'clean' }
              : { result: 'infected', signature: 'Test.Sig' };
          },
        },
      },
    });
    try {
      const ticket = await createTicket();
      const send = async (name: string) => {
        const res = await as(scanned, 'alice', {
          method: 'POST',
          url: `/api/v1/tickets/${ticket.id}/attachments`,
          ...multipartFile(name, 'text/plain', `content of ${name}`),
        });
        expect(res.statusCode, res.body).toBe(201);
        return res.json().attachment as AttachmentView;
      };
      const content = (a: AttachmentView) =>
        as(scanned, 'alice', { method: 'GET', url: contentUrl(ticket, a) });
      const good = await send('good.txt');
      expect(good.scan).toBe('pending');
      expect((await content(good)).json()).toEqual({ error: 'scan_pending' });
      const job = await database.db
        .selectFrom('job')
        .select('payload')
        .where('task', '=', PROCESS_TASK)
        .where('key', '=', `${PROCESS_TASK}:${good.id}`)
        .executeTakeFirst();
      expect(job?.payload).toEqual({ attachmentId: good.id });
      const scanner = {
        name: 'test',
        scan: async () =>
          verdict === 'error'
            ? Promise.reject(new Error('scanner down'))
            : verdict === 'clean'
              ? ({ result: 'clean' } as const)
              : ({ result: 'infected', signature: 'Test.Sig' } as const),
      };
      await processAttachment(database.db, { ...stores.local, scanner }, good.id);
      expect((await content(good)).body).toBe('content of good.txt');

      const bad = await send('bad.txt');
      verdict = 'infected';
      await processAttachment(database.db, { ...stores.local, scanner }, bad.id);
      expect((await content(bad)).json()).toEqual({ error: 'scan_infected' });

      const unsure = await send('unsure.txt');
      verdict = 'error';
      await expect(
        processAttachment(database.db, { ...stores.local, scanner }, unsure.id),
      ).rejects.toThrow('scanner down');
      expect((await content(unsure)).json()).toEqual({ error: 'scan_pending' });
      await processAttachment(database.db, { ...stores.local, scanner }, unsure.id, {
        lastAttempt: true,
      });
      expect((await content(unsure)).json()).toEqual({ error: 'scan_failed' });
      const states = await database.db
        .selectFrom('attachment')
        .select(['name', 'scan_state', 'scan_detail'])
        .where('ticket_id', '=', ticket.id)
        .orderBy('id')
        .execute();
      expect(states).toEqual([
        { name: 'good.txt', scan_state: 'clean', scan_detail: null },
        { name: 'bad.txt', scan_state: 'infected', scan_detail: 'Test.Sig' },
        { name: 'unsure.txt', scan_state: 'failed', scan_detail: 'scanner down' },
      ]);
      // The archive leaves out what is not clean.
      const all = await as(scanned, 'alice', {
        method: 'GET',
        url: `/api/v1/tickets/${ticket.id}/attachments/archive`,
      });
      const zip = await yauzl.fromBufferPromise(all.rawPayload, { lazyEntries: true });
      const names: string[] = [];
      for await (const entry of zip.eachEntry()) names.push(entry.fileName);
      expect(names).toEqual(['good.txt']);
    } finally {
      await scanned.close();
    }
  });

  it('[CORE-021] makes thumbnails of PNG and JPEG images in the worker', async () => {
    const ticket = await createTicket();
    const png = await attach('alice', ticket, 'wide.png', 'image/png', testPng(1000, 500), 's3');
    const jpeg = await attach('alice', ticket, 'photo.jpg', 'image/jpeg', testJpeg(640, 480, 6));
    const gif = await attach(
      'alice',
      ticket,
      'anim.gif',
      'image/gif',
      Buffer.from('GIF89a\x01\0\x01\0'),
    );
    const bomb = testPng(10, 10);
    bomb.writeUInt32BE(100_000, 16);
    bomb.writeUInt32BE(100_000, 20);
    const huge = await attach('alice', ticket, 'bomb.png', 'image/png', bomb);
    expect([png.thumbnail, jpeg.thumbnail, gif.thumbnail]).toEqual([false, false, false]);
    for (const a of [png, jpeg, gif, huge])
      await processAttachment(database.db, stores.local, a.id);
    const after = (await list('alice', ticket)).attachments;
    expect(after.map((a) => [a.name, a.kind, a.thumbnail, a.width, a.height])).toEqual([
      ['wide.png', 'image', true, 1000, 500],
      ['photo.jpg', 'image', true, 480, 640],
      ['anim.gif', 'image', false, null, null],
      ['bomb.png', 'image', false, null, null],
    ]);
    const thumbUrl = (a: AttachmentView) =>
      `/api/v1/tickets/${ticket.id}/attachments/${a.id}/thumbnail`;
    const s3Thumb = await get('bob', thumbUrl(png), 's3');
    expect(s3Thumb.statusCode).toBe(302);
    const fetched = Buffer.from(
      await (await fetch(String(s3Thumb.headers.location))).arrayBuffer(),
    );
    const decoded = PNG.sync.read(fetched);
    expect([decoded.width, decoded.height]).toEqual([400, 200]);
    const localThumb = await get('bob', thumbUrl(jpeg));
    expect(localThumb.statusCode).toBe(200);
    expect(localThumb.headers['content-type']).toBe('image/jpeg');
    expect(String(localThumb.headers['content-disposition'])).toMatch(/^inline;/);
    expect((await get('bob', thumbUrl(gif))).statusCode).toBe(404);
    // Deleting the attachment deletes its thumbnail too.
    const thumbKey = (
      await database.db
        .selectFrom('attachment')
        .select('thumbnail_key')
        .where('id', '=', jpeg.id)
        .executeTakeFirstOrThrow()
    ).thumbnail_key as string;
    expect(await local.size(thumbKey)).not.toBeNull();
    await as(apps.local, 'alice', {
      method: 'DELETE',
      url: `/api/v1/tickets/${ticket.id}/attachments/${jpeg.id}`,
    });
    expect(await local.size(thumbKey)).toBeNull();
  });

  it('[CORE-021] lets site administrators set the maximum file size, with no ceiling', async () => {
    const read = await get('admin', '/api/v1/admin/attachment-settings');
    expect(read.json()).toEqual({
      maxFileSize: 1024 ** 3,
      storage: 'local',
      scanner: null,
      signedUrlSeconds: 300,
    });
    const put = (who: string, payload: unknown) =>
      as(apps.local, who, {
        method: 'PUT',
        url: '/api/v1/admin/attachment-settings',
        payload: payload as object,
      });
    // 10 TB is fine: there is no fixed ceiling.
    expect((await put('admin', { maxFileSize: 10 * 1024 ** 4 })).json().maxFileSize).toBe(
      10 * 1024 ** 4,
    );
    expect((await put('admin', { maxFileSize: 0 })).statusCode).toBe(400);
    expect((await put('admin', { maxFileSize: 1.5 })).statusCode).toBe(400);
    expect((await put('carol', { maxFileSize: 5 })).statusCode).toBe(403);
    expect((await get('carol', '/api/v1/admin/attachment-settings')).statusCode).toBe(403);
    await setLimit(1024 ** 3);
    // Members see the limit with the list, so the page can warn before uploading.
    const ticket = await createTicket();
    expect((await list('alice', ticket)).maxFileSize).toBe(1024 ** 3);
  });

  it('[CORE-021] answers HEAD without a body and a missing file without failing', async () => {
    const ticket = await createTicket();
    const a = await attach('alice', ticket, 'gone.txt', 'text/plain', 'soon gone');
    const b = await attach('alice', ticket, 'kept.txt', 'text/plain', 'kept');
    const head = await as(apps.local, 'alice', { method: 'HEAD', url: contentUrl(ticket, a) });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe('9');
    expect(head.body).toBe('');
    // The row stays, the file goes (a database restored without its files).
    const { storage_key } = await database.db
      .selectFrom('attachment')
      .select('storage_key')
      .where('id', '=', a.id)
      .executeTakeFirstOrThrow();
    await local.delete(storage_key);
    const missing = await get('alice', contentUrl(ticket, a));
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'file_missing' });
    // Not the file's own disposition: only the generic one of every JSON answer (M1-118).
    expect(missing.headers['content-disposition']).toBe('attachment; filename="api.json"');
    // The archive breaks off rather than the server; the next request is served.
    await as(apps.local, 'alice', {
      method: 'GET',
      url: `/api/v1/tickets/${ticket.id}/attachments/archive`,
    }).catch(() => null);
    expect((await get('alice', contentUrl(ticket, b))).body).toBe('kept');
  });

  it('[CORE-021] answers 503 when no store is configured', async () => {
    const bare = await buildApp({ db: database.db, version: 'test' });
    try {
      const ticket = await createTicket();
      const res = await as(bare, 'alice', {
        method: 'POST',
        url: `/api/v1/tickets/${ticket.id}/attachments`,
        ...multipartFile('a.txt', 'text/plain', 'a'),
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'storage_unavailable' });
      const listed = await as(bare, 'alice', {
        method: 'GET',
        url: `/api/v1/tickets/${ticket.id}/attachments`,
      });
      expect(listed.json()).toMatchObject({ attachments: [], canCreate: false, available: false });
    } finally {
      await bare.close();
    }
  });

  it('[CORE-021] removes the file of an upload that is refused after it was stored', async () => {
    const ticket = await createTicket();
    const before = objectCount();
    // The ticket goes to the trash while its upload streams: the file is not kept.
    const store: ObjectStore = {
      ...local,
      kind: 'local',
      put: async (key, body, options) => {
        const result = await local.put(key, body, options);
        await database.db
          .updateTable('ticket')
          .set({ deleted_at: new Date() })
          .where('id', '=', ticket.id)
          .execute();
        return result;
      },
      read: (key, range) => local.read(key, range),
      size: (key) => local.size(key),
      delete: (key) => local.delete(key),
      signedUrl: () => Promise.resolve(null),
      sweepIncomplete: (d) => local.sweepIncomplete(d),
    };
    const racing = await buildApp({
      db: database.db,
      version: 'test',
      attachments: storesOf(store),
    });
    try {
      const res = await as(racing, 'alice', {
        method: 'POST',
        url: `/api/v1/tickets/${ticket.id}/attachments`,
        ...multipartFile('late.txt', 'text/plain', 'late'),
      });
      expect(res.statusCode).toBe(404);
      expect(objectCount()).toBe(before);
      expect((await rowsOf('storage_cleanup')).filter((r) => r.reason === 'upload')).toEqual([]);
    } finally {
      await racing.close();
    }
  });
});
