import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { CreateMultipartUploadCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidKeyError, isObjectKey, newObjectKey } from './keys';
import { LocalStore } from './local';
import { partSizeFor, S3Store } from './s3';
import { ObjectNotFoundError, type ObjectStore, ObjectTooLargeError } from './store';
import { FakeS3 } from './testing';

const MiB = 1024 * 1024;

/** A body of `size` bytes made as it is read, in 64 KiB chunks, never held whole. */
function generated(size: number, fill = 0x61): Readable {
  let left = size;
  return new Readable({
    read() {
      if (left <= 0) {
        this.push(null);
        return;
      }
      const n = Math.min(left, 64 * 1024);
      left -= n;
      this.push(Buffer.alloc(n, fill));
    },
  });
}

const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function bytesOf(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Keys of every shape an attacker might hand to a store. */
const HOSTILE_KEYS = [
  '../../etc/passwd',
  '/etc/passwd',
  'w1/../../../etc/passwd',
  'C:\\Windows\\win.ini',
  'w1\\aa\\bb\\x',
  `w1/aa/bb/${'a'.repeat(32)}\0.png`,
  `w1/ab/cd/${'0'.repeat(32)}`,
  `w0/00/00/${'0'.repeat(32)}`,
  `W1/00/00/${'0'.repeat(32)}`,
  `w1/00/00/${'0'.repeat(32)}/../../x`,
  '',
  'w1',
];

describe('object keys (ADR-040)', () => {
  it('[CORE-021] makes random keys of one shape and recognises only that shape', () => {
    const keys = new Set(Array.from({ length: 200 }, () => newObjectKey(7)));
    expect(keys.size).toBe(200);
    for (const key of keys) {
      expect(key).toMatch(/^w7\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{32}$/);
      expect(isObjectKey(key)).toBe(true);
    }
    for (const key of HOSTILE_KEYS) expect(isObjectKey(key), key).toBe(false);
    expect(() => newObjectKey(0)).toThrow(RangeError);
  });

  it('[CORE-021] sizes parts to stay under the multipart limit at any file size', () => {
    expect(partSizeFor(1024)).toBe(8 * MiB);
    expect(partSizeFor(1024 * MiB)).toBe(8 * MiB);
    // 3 GB fits in 8 MiB parts; a 1 TB limit needs larger ones, still under 10,000 parts.
    expect(Math.ceil((3 * 1024 * MiB) / partSizeFor(3 * 1024 * MiB))).toBeLessThan(10_000);
    const tera = 1024 * 1024 * MiB;
    expect(Math.ceil(tera / partSizeFor(tera))).toBeLessThan(10_000);
  });
});

interface Backend {
  name: string;
  store: () => ObjectStore;
  /** What the backend holds besides finished objects (unfinished uploads). */
  leftovers: () => number;
  objectCount: () => number;
}

const fake = new FakeS3(['attachments']);
let localRoot = '';
let local: LocalStore;
let s3: S3Store;

beforeAll(async () => {
  localRoot = mkdtempSync(join(tmpdir(), 'taskmoor-store-'));
  local = await LocalStore.open(localRoot);
  await fake.start();
  s3 = new S3Store({
    bucket: 'attachments',
    region: fake.region,
    endpoint: fake.endpoint,
    forcePathStyle: true,
    prefix: 'files/',
    credentials: fake.credentials,
  });
});
afterAll(async () => {
  s3?.destroy();
  await fake.stop();
  await rm(localRoot, { recursive: true, force: true });
});

function countFiles(dir: string): number {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else n += 1;
  }
  return n;
}

const backends: Backend[] = [
  {
    name: 'local disk',
    store: () => local,
    leftovers: () => readdirSync(join(localRoot, '.incoming')).length,
    objectCount: () => countFiles(localRoot) - readdirSync(join(localRoot, '.incoming')).length,
  },
  {
    name: 'S3-compatible',
    store: () => s3,
    leftovers: () => fake.pendingUploads().length,
    objectCount: () => fake.objects('attachments').size,
  },
];

describe.each(backends)('the $name store', (backend) => {
  it('[CORE-021] stores a stream and gives back its bytes, size and SHA-256', async () => {
    const store = backend.store();
    const body = randomBytes(300_000);
    const key = newObjectKey(1);
    const result = await store.put(
      key,
      Readable.from([body.subarray(0, 1000), body.subarray(1000)]),
      {
        maxBytes: 1_000_000,
        contentType: 'application/octet-stream',
      },
    );
    expect(result).toEqual({ size: body.length, sha256: digest(body) });
    expect(await store.size(key)).toBe(body.length);
    expect((await bytesOf(await store.read(key))).equals(body)).toBe(true);
    // A range is inclusive at both ends, as HTTP counts.
    const part = await bytesOf(await store.read(key, { start: 10, end: 19 }));
    expect(part.equals(body.subarray(10, 20))).toBe(true);
    await store.delete(key);
    expect(await store.size(key)).toBeNull();
    await expect(store.read(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
    // Deleting what is gone is not an error: the cleanup may run twice.
    await store.delete(key);
  });

  it('[CORE-021] streams a body larger than one part without holding it whole', async () => {
    const store = backend.store();
    const key = newObjectKey(1);
    const size = 17 * MiB + 123;
    const seen: number[] = [];
    const result = await store.put(key, generated(size), {
      maxBytes: 32 * MiB,
      onChunk: (chunk) => seen.push(chunk.length),
    });
    expect(result.size).toBe(size);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(size);
    expect(Math.max(...seen)).toBeLessThanOrEqual(64 * 1024);
    expect(await store.size(key)).toBe(size);
    expect(result.sha256).toBe(digest(Buffer.alloc(size, 0x61)));
    await store.delete(key);
  });

  it('[CORE-021] refuses a body over the limit as it streams and leaves nothing behind', async () => {
    const store = backend.store();
    const before = backend.objectCount();
    // Scaled down from 2.5 GB against 1 GB: more than two parts pass before the refusal.
    for (const [size, max] of [
      [2500, 1000],
      [25 * MiB, 10 * MiB],
    ] as const) {
      const key = newObjectKey(1);
      let read = 0;
      const body = generated(size);
      body.on('data', (chunk: Buffer) => {
        read += chunk.length;
      });
      const refused = await store.put(key, body, { maxBytes: max }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ObjectTooLargeError);
      expect((refused as ObjectTooLargeError).maxBytes).toBe(max);
      // It stopped soon after the limit, not at the end of the body (one chunk of slack).
      expect(read).toBeLessThanOrEqual(Math.min(size, max + 4 * 64 * 1024));
      expect(await store.size(key)).toBeNull();
    }
    expect(backend.objectCount()).toBe(before);
    expect(backend.leftovers()).toBe(0);
  });

  it('[CORE-021] accepts a body of exactly the limit and an empty one', async () => {
    const store = backend.store();
    const exact = newObjectKey(1);
    expect((await store.put(exact, generated(1000), { maxBytes: 1000 })).size).toBe(1000);
    const empty = newObjectKey(1);
    const result = await store.put(empty, Readable.from([]), { maxBytes: 1000 });
    expect(result).toEqual({ size: 0, sha256: digest(Buffer.alloc(0)) });
    expect(await text(await store.read(empty))).toBe('');
    await store.delete(exact);
    await store.delete(empty);
  });

  it('[CORE-021] cleans up when the upload breaks off half way', async () => {
    const store = backend.store();
    const key = newObjectKey(1);
    let sent = 0;
    const broken = new Readable({
      read() {
        sent += 1;
        if (sent > 200) this.destroy(new Error('client went away'));
        else this.push(Buffer.alloc(64 * 1024, 1));
      },
    });
    await expect(store.put(key, broken, { maxBytes: 100 * MiB })).rejects.toThrow(
      'client went away',
    );
    expect(await store.size(key)).toBeNull();
    expect(backend.leftovers()).toBe(0);
  });

  it('[CORE-021] refuses every key it did not make, so no input reaches a path', async () => {
    const store = backend.store();
    for (const key of HOSTILE_KEYS) {
      await expect(store.put(key, Readable.from(['x']), { maxBytes: 10 }), key).rejects.toThrow(
        InvalidKeyError,
      );
      await expect(store.read(key), key).rejects.toThrow(InvalidKeyError);
      await expect(store.size(key), key).rejects.toThrow(InvalidKeyError);
      await expect(store.delete(key), key).rejects.toThrow(InvalidKeyError);
    }
  });
});

describe('the local disk store', () => {
  it('[CORE-021] keeps files under the root, owner-only, and sweeps abandoned uploads', async () => {
    const key = newObjectKey(3);
    await local.put(key, Readable.from(['hello']), { maxBytes: 10 });
    const path = local.pathOf(key);
    expect(relative(localRoot, path).split(sep)[0]).toBe('w3');
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(localRoot, 'w3')).mode & 0o777).toBe(0o700);
    }
    // A crash mid-upload leaves a .part file; the sweep removes old ones, not current ones.
    const old = join(localRoot, '.incoming', 'deadbeef.part');
    const fresh = join(localRoot, '.incoming', 'cafebabe.part');
    writeFileSync(old, 'partial');
    writeFileSync(fresh, 'partial');
    const dayAgo = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(old, dayAgo, dayAgo);
    expect(await local.sweepIncomplete(new Date(Date.now() - 86_400_000))).toBe(1);
    expect(readdirSync(join(localRoot, '.incoming'))).toEqual(['cafebabe.part']);
    await rm(fresh);
    expect(await local.signedUrl()).toBeNull();
    await local.delete(key);
  });
});

describe('the S3-compatible store', () => {
  it('[CORE-021] serves objects through presigned URLs that expire', async () => {
    const key = newObjectKey(1);
    await s3.put(key, Readable.from(['%PDF-1.7 fake']), { maxBytes: 100 });
    const url = await s3.signedUrl(key, {
      expiresIn: 300,
      contentType: 'application/pdf',
      contentDisposition: `inline; filename="report.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`,
    });
    expect(url.startsWith(`${fake.endpoint}/attachments/files/${key}?`)).toBe(true);
    expect(url).toContain('X-Amz-Expires=300');
    const ok = await fetch(url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('application/pdf');
    expect(ok.headers.get('content-disposition')).toContain(
      "filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
    );
    expect(await ok.text()).toBe('%PDF-1.7 fake');

    // A changed signature or another key is refused.
    const tampered = url.replace(
      /X-Amz-Signature=([0-9a-f])/,
      (_m, c: string) => `X-Amz-Signature=${c === '0' ? '1' : '0'}`,
    );
    expect((await fetch(tampered)).status).toBe(403);
    expect((await fetch(url.replace(key, newObjectKey(1)))).status).toBe(403);

    // Five minutes and a second later, the same URL is refused.
    const real = fake.now;
    fake.now = () => new Date(Date.now() + 301_000);
    try {
      const late = await fetch(url);
      expect(late.status).toBe(403);
      expect(await late.text()).toContain('Request has expired');
    } finally {
      fake.now = real;
    }
    await s3.delete(key);
  });

  it('[CORE-021] signs every request: wrong credentials are refused', async () => {
    const wrong = new S3Store({
      bucket: 'attachments',
      region: fake.region,
      endpoint: fake.endpoint,
      forcePathStyle: true,
      prefix: '',
      credentials: { accessKeyId: fake.accessKeyId, secretAccessKey: 'not-the-secret' },
    });
    try {
      await expect(
        wrong.put(newObjectKey(1), Readable.from(['x']), { maxBytes: 10 }),
      ).rejects.toThrow(/SignatureDoesNotMatch|signature/i);
    } finally {
      wrong.destroy();
    }
    expect(fake.requests.some((r) => r.status === 403 && r.auth === 'header')).toBe(true);
    // Everything the real store sent was signed in the header or by a presigned query.
    expect(fake.requests.every((r) => r.auth !== 'none')).toBe(true);
  });

  it('[CORE-021] signs browser URLs for the public endpoint when one is set', async () => {
    const store = new S3Store({
      bucket: 'attachments',
      region: fake.region,
      endpoint: fake.endpoint,
      publicEndpoint: 'https://files.example.com',
      forcePathStyle: true,
      prefix: '',
      credentials: fake.credentials,
    });
    try {
      const url = await store.signedUrl(newObjectKey(1), {
        expiresIn: 60,
        contentType: 'image/png',
        contentDisposition: 'inline',
      });
      expect(url.startsWith('https://files.example.com/attachments/w1/')).toBe(true);
    } finally {
      store.destroy();
    }
  });

  it('[CORE-021] aborts multipart uploads a dead process left behind', async () => {
    // An upload begun two days ago whose process died before completing or aborting it.
    const key = `files/${newObjectKey(1)}`;
    const client = new S3Client({
      region: fake.region,
      endpoint: fake.endpoint,
      forcePathStyle: true,
      credentials: fake.credentials,
    });
    const real = fake.now;
    fake.now = () => new Date(Date.now() - 2 * 86_400_000);
    try {
      await client.send(new CreateMultipartUploadCommand({ Bucket: 'attachments', Key: key }));
    } finally {
      fake.now = real;
      client.destroy();
    }
    const recent = `files/${newObjectKey(1)}`;
    const second = new S3Client({
      region: fake.region,
      endpoint: fake.endpoint,
      forcePathStyle: true,
      credentials: fake.credentials,
    });
    await second.send(new CreateMultipartUploadCommand({ Bucket: 'attachments', Key: recent }));
    second.destroy();
    expect(await s3.sweepIncomplete(new Date(Date.now() - 86_400_000))).toBe(1);
    expect(fake.pendingUploads().map((u) => u.key)).toEqual([recent]);
    expect(await s3.sweepIncomplete(new Date(Date.now() + 1000))).toBe(1);
    expect(fake.pendingUploads()).toEqual([]);
  });
});
