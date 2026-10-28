import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newObjectKey } from './keys';
import { S3Store } from './s3';
import { ObjectNotFoundError, ObjectTooLargeError } from './store';

/**
 * The S3 store against a real S3-compatible service (M1-016). Skipped unless
 * TASKMOOR_S3_TEST_ENDPOINT, TASKMOOR_S3_TEST_ACCESS_KEY_ID and
 * TASKMOOR_S3_TEST_SECRET_ACCESS_KEY are set; `tools/storage/minio-test.sh` sets them for a
 * MinIO it starts with credentials made per run (CI's storage workflow), and they can point at
 * any other store (AWS, R2, Garage) from the environment. Nothing here is ever committed with a
 * value. Each run works under a random prefix and leaves nothing behind.
 */
const endpoint = process.env.TASKMOOR_S3_TEST_ENDPOINT;
const accessKeyId = process.env.TASKMOOR_S3_TEST_ACCESS_KEY_ID;
const secretAccessKey = process.env.TASKMOOR_S3_TEST_SECRET_ACCESS_KEY;
const bucket = process.env.TASKMOOR_S3_TEST_BUCKET ?? 'taskmoor-live-test';
const region = process.env.TASKMOOR_S3_TEST_REGION ?? 'us-east-1';
const MiB = 1024 * 1024;

function generated(size: number): Readable {
  let left = size;
  return new Readable({
    read() {
      if (left <= 0) {
        this.push(null);
        return;
      }
      const n = Math.min(left, 64 * 1024);
      left -= n;
      this.push(Buffer.alloc(n, 0x5a));
    },
  });
}

async function bytesOf(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe.skipIf(!endpoint || !accessKeyId || !secretAccessKey)(
  'the S3 store on a real S3-compatible service',
  () => {
    const prefix = `live-${randomBytes(6).toString('hex')}/`;
    let store: S3Store;
    const made: string[] = [];

    beforeAll(async () => {
      const credentials = {
        accessKeyId: accessKeyId as string,
        secretAccessKey: secretAccessKey as string,
      };
      const admin = new S3Client({
        region,
        endpoint: endpoint as string,
        forcePathStyle: true,
        credentials,
      });
      try {
        await admin.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        await admin.send(new CreateBucketCommand({ Bucket: bucket }));
      } finally {
        admin.destroy();
      }
      store = new S3Store({
        bucket,
        region,
        endpoint: endpoint as string,
        forcePathStyle: true,
        prefix,
        credentials,
      });
    });
    afterAll(async () => {
      for (const key of made) await store?.delete(key);
      store?.destroy();
    });
    const key = () => {
      const k = newObjectKey(1);
      made.push(k);
      return k;
    };

    it('[CORE-021] round-trips an object with ranges, size and deletion', async () => {
      const body = randomBytes(200_000);
      const k = key();
      const result = await store.put(k, Readable.from([body]), { maxBytes: MiB });
      expect(result.size).toBe(body.length);
      expect(await store.size(k)).toBe(body.length);
      expect((await bytesOf(await store.read(k))).equals(body)).toBe(true);
      expect(
        (await bytesOf(await store.read(k, { start: 5, end: 9 }))).equals(body.subarray(5, 10)),
      ).toBe(true);
      await store.delete(k);
      expect(await store.size(k)).toBeNull();
      await expect(store.read(k)).rejects.toBeInstanceOf(ObjectNotFoundError);
      await store.delete(k);
    });

    it('[CORE-021] streams a multipart upload and aborts one over the limit', async () => {
      const k = key();
      expect((await store.put(k, generated(20 * MiB + 1), { maxBytes: 64 * MiB })).size).toBe(
        20 * MiB + 1,
      );
      const refused = key();
      await expect(
        store.put(refused, generated(30 * MiB), { maxBytes: 20 * MiB }),
      ).rejects.toBeInstanceOf(ObjectTooLargeError);
      expect(await store.size(refused)).toBeNull();
      // No parts were left: nothing for the sweep to abort under this run's prefix.
      expect(await store.sweepIncomplete(new Date(Date.now() + 86_400_000))).toBe(0);
    });

    it('[CORE-021] serves through presigned URLs that carry the type and disposition and expire', async () => {
      const k = key();
      await store.put(k, Readable.from(['%PDF-1.7 live']), { maxBytes: 100 });
      const url = await store.signedUrl(k, {
        expiresIn: 2,
        contentType: 'application/pdf',
        contentDisposition: `inline; filename="live.pdf"; filename*=UTF-8''live.pdf`,
      });
      const ok = await fetch(url);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toBe('application/pdf');
      expect(ok.headers.get('content-disposition')).toContain("filename*=UTF-8''live.pdf");
      expect(await ok.text()).toBe('%PDF-1.7 live');
      const bare = new URL(url);
      bare.search = '';
      expect((await fetch(bare)).status).toBe(403);
      await new Promise((resolve) => setTimeout(resolve, 3500));
      expect((await fetch(url)).status).toBe(403);
    });
  },
);
