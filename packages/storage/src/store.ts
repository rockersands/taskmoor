import { createHash, type Hash } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

/**
 * One storage interface with two implementations (ADR-020, ADR-040): files on local disk, or
 * objects in an S3-compatible bucket. Callers stream in and out; nothing here holds a whole
 * file in memory.
 */
export type StorageKind = 'local' | 's3';

export interface PutOptions {
  /** The most bytes the object may have; a longer body is refused and nothing stays behind. */
  maxBytes: number;
  /** Recorded with S3 objects; local files have no type. */
  contentType?: string;
  /** Sees every chunk as it passes, in order (to sniff the first bytes, to scan). */
  onChunk?: (chunk: Buffer) => void;
}

export interface PutResult {
  size: number;
  /** Lower-case hex SHA-256 of the bytes stored. */
  sha256: string;
}

/** Inclusive byte positions, as HTTP ranges count them. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface SignedUrlOptions {
  /** Seconds the URL stays valid. */
  expiresIn: number;
  /** The Content-Type and Content-Disposition the response must carry. */
  contentType: string;
  contentDisposition: string;
}

export interface ObjectStore {
  readonly kind: StorageKind;
  /** Writes a new object from a stream; the key must be new (keys are random). */
  put(key: string, body: NodeJS.ReadableStream, options: PutOptions): Promise<PutResult>;
  /** The object's bytes, or a range of them. Throws `ObjectNotFoundError`. */
  read(key: string, range?: ByteRange): Promise<NodeJS.ReadableStream>;
  /** The object's size, or null when there is none. */
  size(key: string): Promise<number | null>;
  /** Removes the object; removing one that is gone is not an error. */
  delete(key: string): Promise<void>;
  /**
   * A short-lived URL a browser can fetch the object from, or null when the store has none
   * (local disk, which the API streams itself).
   */
  signedUrl(key: string, options: SignedUrlOptions): Promise<string | null>;
  /** Removes what interrupted uploads left behind before `olderThan`; returns how many. */
  sweepIncomplete(olderThan: Date): Promise<number>;
}

export class ObjectTooLargeError extends Error {
  readonly code = 'too_large';
  constructor(readonly maxBytes: number) {
    super(`object larger than ${maxBytes} bytes`);
  }
}

export class ObjectNotFoundError extends Error {
  readonly code = 'not_found';
  constructor() {
    super('no such object');
  }
}

export function isTooLarge(error: unknown): error is ObjectTooLargeError {
  return error instanceof ObjectTooLargeError;
}

/**
 * Counts and hashes the bytes passing through, hands each chunk to `onChunk`, and fails with
 * `ObjectTooLargeError` as soon as more than `maxBytes` have passed: a 2.5 GB body against a
 * 1 GB limit stops after 1 GB, not at the end.
 */
export class Meter extends Transform {
  private readonly hash: Hash = createHash('sha256');
  private count = 0;
  private digest: string | null = null;

  constructor(
    private readonly maxBytes: number,
    private readonly onChunk?: (chunk: Buffer) => void,
  ) {
    super();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes');
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, done: TransformCallback) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    this.count += bytes.length;
    if (this.count > this.maxBytes) {
      done(new ObjectTooLargeError(this.maxBytes));
      return;
    }
    this.hash.update(bytes);
    try {
      this.onChunk?.(bytes);
    } catch (error) {
      done(error as Error);
      return;
    }
    done(null, bytes);
  }

  override _flush(done: TransformCallback) {
    this.digest = this.hash.digest('hex');
    done();
  }

  /** What passed, once the stream has ended. */
  result(): PutResult {
    if (this.digest === null) throw new Error('the stream has not ended');
    return { size: this.count, sha256: this.digest };
  }
}
