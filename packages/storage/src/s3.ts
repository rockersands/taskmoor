import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertObjectKey } from './keys';
import {
  type ByteRange,
  Meter,
  ObjectNotFoundError,
  type ObjectStore,
  type PutOptions,
  type PutResult,
  type SignedUrlOptions,
} from './store';

export interface S3StoreConfig {
  bucket: string;
  region: string;
  /** For S3-compatible stores (MinIO, Garage, Ceph, R2, ...); AWS when absent. */
  endpoint?: string;
  /**
   * The address browsers reach the store at, when it differs from `endpoint` (a store on an
   * internal network behind a public name). Signed URLs are made for it.
   */
  publicEndpoint?: string;
  /** Bucket in the path rather than the host name; most S3-compatible stores want it. */
  forcePathStyle: boolean;
  /** Prepended to every key: '' or a folder ending in '/'. */
  prefix: string;
  /** From the environment only; absent, the SDK's default chain (role, IRSA, profile) applies. */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  serverSideEncryption?: 'AES256' | 'aws:kms';
  kmsKeyId?: string;
}

const MiB = 1024 * 1024;
/** S3 allows 10,000 parts; staying under 9,000 leaves room for a body slightly over its size. */
const MAX_PARTS = 9000;

/** Part size for an upload of at most `maxBytes`: 8 MiB, more when needed to fit the parts. */
export function partSizeFor(maxBytes: number): number {
  return Math.min(5 * 1024 * MiB, Math.max(8 * MiB, Math.ceil(maxBytes / MAX_PARTS)));
}

function errorName(error: unknown): string {
  return (error as { name?: string })?.name ?? '';
}

/**
 * Objects in an S3-compatible bucket (ADR-020, ADR-040). Uploads stream through a multipart
 * upload whose parts are the only thing held in memory (at most four parts of 8 MiB for limits
 * up to 70 GB); a refused or failed upload is aborted, so no parts stay behind. Browsers get
 * objects through presigned GET URLs that name the response's type and disposition.
 *
 * Checksums are sent only when an operation requires them: newer AWS SDKs add trailing CRC
 * checksums by default, which many S3-compatible stores refuse.
 */
export class S3Store implements ObjectStore {
  readonly kind = 's3' as const;
  private readonly client: S3Client;
  private readonly signer: S3Client;

  constructor(private readonly config: S3StoreConfig) {
    if (config.prefix !== '' && !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/$/.test(config.prefix)) {
      throw new Error('the S3 key prefix must be empty or folder names ending in "/"');
    }
    const base: S3ClientConfig = {
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...(config.credentials ? { credentials: config.credentials } : {}),
    };
    this.client = new S3Client({
      ...base,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    });
    this.signer = config.publicEndpoint
      ? new S3Client({ ...base, endpoint: config.publicEndpoint })
      : this.client;
  }

  private objectKey(key: string): string {
    assertObjectKey(key);
    return `${this.config.prefix}${key}`;
  }

  async put(key: string, body: NodeJS.ReadableStream, options: PutOptions): Promise<PutResult> {
    const Key = this.objectKey(key);
    const meter = new Meter(options.maxBytes, options.onChunk);
    body.on('error', (error) => meter.destroy(error));
    body.pipe(meter);
    const partSize = partSizeFor(options.maxBytes);
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.config.bucket,
        Key,
        Body: meter,
        ...(options.contentType ? { ContentType: options.contentType } : {}),
        ...(this.config.serverSideEncryption
          ? { ServerSideEncryption: this.config.serverSideEncryption }
          : {}),
        ...(this.config.kmsKeyId ? { SSEKMSKeyId: this.config.kmsKeyId } : {}),
      },
      partSize,
      queueSize: partSize > 64 * MiB ? 1 : 4,
      leavePartsOnError: false,
    });
    try {
      await upload.done();
    } catch (error) {
      // Stop reading the request, and report the meter's own error (too large, a broken
      // request), which says more than the SDK's.
      (body as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      throw meter.errored ?? error;
    }
    if (meter.errored) {
      await this.delete(key);
      throw meter.errored;
    }
    return meter.result();
  }

  async read(key: string, range?: ByteRange): Promise<NodeJS.ReadableStream> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: this.objectKey(key),
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
      );
      if (!response.Body) throw new ObjectNotFoundError();
      return response.Body as NodeJS.ReadableStream;
    } catch (error) {
      if (errorName(error) === 'NoSuchKey' || errorName(error) === 'NotFound') {
        throw new ObjectNotFoundError();
      }
      throw error;
    }
  }

  async size(key: string): Promise<number | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: this.objectKey(key) }),
      );
      return head.ContentLength ?? null;
    } catch (error) {
      if (errorName(error) === 'NotFound' || errorName(error) === 'NoSuchKey') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.config.bucket, Key: this.objectKey(key) }),
      );
    } catch (error) {
      if (errorName(error) !== 'NoSuchKey' && errorName(error) !== 'NotFound') throw error;
    }
  }

  async signedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: this.objectKey(key),
        ResponseContentType: options.contentType,
        ResponseContentDisposition: options.contentDisposition,
      }),
      { expiresIn: options.expiresIn },
    );
  }

  /**
   * Aborts multipart uploads under the prefix begun before `olderThan`: what a process that
   * died mid-upload left. A bucket lifecycle rule (abort incomplete uploads after a day) does
   * the same and is recommended as well.
   */
  async sweepIncomplete(olderThan: Date): Promise<number> {
    let aborted = 0;
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    for (;;) {
      const page = await this.client.send(
        new ListMultipartUploadsCommand({
          Bucket: this.config.bucket,
          Prefix: `${this.config.prefix}w`,
          ...(keyMarker ? { KeyMarker: keyMarker } : {}),
          ...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {}),
        }),
      );
      for (const upload of page.Uploads ?? []) {
        if (!upload.Key || !upload.UploadId || !upload.Initiated) continue;
        if (upload.Initiated >= olderThan) continue;
        await this.client.send(
          new AbortMultipartUploadCommand({
            Bucket: this.config.bucket,
            Key: upload.Key,
            UploadId: upload.UploadId,
          }),
        );
        aborted += 1;
      }
      if (!page.IsTruncated) return aborted;
      keyMarker = page.NextKeyMarker;
      uploadIdMarker = page.NextUploadIdMarker;
      if (!keyMarker && !uploadIdMarker) return aborted;
    }
  }

  destroy(): void {
    this.client.destroy();
    if (this.signer !== this.client) this.signer.destroy();
  }
}
