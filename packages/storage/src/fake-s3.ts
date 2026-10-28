import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An S3-compatible server for tests (no Docker here): path-style buckets with PutObject,
 * multipart uploads (create, upload part, complete, abort, list), GetObject with ranges and
 * response header overrides, HeadObject and DeleteObject. Every request must carry a valid
 * AWS Signature Version 4, in the Authorization header or as a presigned query, so a client
 * that signs wrongly fails here as it would against S3; presigned URLs expire by `now()`,
 * which tests may move forward. The credentials are made at run time.
 *
 * It keeps objects in memory: it is for tests, not for gigabytes.
 */
export interface FakeObject {
  body: Buffer;
  contentType: string;
  etag: string;
  lastModified: Date;
}

interface PendingUpload {
  key: string;
  initiated: Date;
  contentType: string;
  parts: Map<number, { body: Buffer; etag: string }>;
}

export interface FakeS3Request {
  method: string;
  path: string;
  query: string;
  status: number;
  auth: 'header' | 'presigned' | 'none';
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** AWS's URI encoding: unreserved characters stay, everything else is %XX in upper case. */
function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseQuery(raw: string): [string, string][] {
  if (raw === '') return [];
  return raw.split('&').map((pair) => {
    const at = pair.indexOf('=');
    return at < 0 ? [decode(pair), ''] : [decode(pair.slice(0, at)), decode(pair.slice(at + 1))];
  });
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** Decodes an aws-chunked body (streaming uploads); chunk signatures are not checked. */
function decodeAwsChunked(body: Buffer): Buffer {
  const out: Buffer[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = body.indexOf('\r\n', at);
    if (lineEnd < 0) break;
    const size = Number.parseInt(
      body.subarray(at, lineEnd).toString('latin1').split(';')[0] ?? '',
      16,
    );
    if (!Number.isFinite(size) || size === 0) break;
    out.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
    at = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(out);
}

/** A parsed `bytes=` range for an object of `size` bytes, or null to answer 416. */
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, a, b] = match;
  if (a === '' && b === '') return null;
  if (a === '') {
    const n = Number(b);
    return n === 0 ? null : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  return start > end || start >= size ? null : { start, end };
}

export class FakeS3 {
  readonly region = 'us-east-1';
  readonly accessKeyId = `AKIAFAKE${randomBytes(6).toString('hex').toUpperCase()}`;
  readonly secretAccessKey = randomBytes(30).toString('base64url');
  readonly buckets = new Map<string, Map<string, FakeObject>>();
  readonly requests: FakeS3Request[] = [];
  private readonly uploads = new Map<string, PendingUpload>();
  private server: Server | null = null;
  private port = 0;
  /** The clock presigned URLs expire by; tests move it forward. */
  now: () => Date = () => new Date();

  constructor(buckets: readonly string[] = ['taskmoor-test']) {
    for (const name of buckets) this.buckets.set(name, new Map());
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get credentials() {
    return { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey };
  }

  async start(port = 0): Promise<void> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        if (!res.headersSent) this.error(res, 500, 'InternalError', String(error));
        else res.destroy();
      });
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The objects of a bucket, by key. */
  objects(bucket = 'taskmoor-test'): Map<string, FakeObject> {
    const found = this.buckets.get(bucket);
    if (!found) throw new Error(`no bucket ${bucket}`);
    return found;
  }

  /** Multipart uploads begun and neither completed nor aborted. */
  pendingUploads(): { key: string; initiated: Date }[] {
    return [...this.uploads.values()].map((u) => ({ key: u.key, initiated: u.initiated }));
  }

  private error(res: ServerResponse, status: number, code: string, message: string): void {
    res.statusCode = status;
    if (res.req.method === 'HEAD') {
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/xml');
    res.end(
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message><RequestId>fake</RequestId></Error>`,
    );
  }

  private xml(res: ServerResponse, body: string): void {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/xml');
    res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
  }

  /** Checks the request's signature; returns why it fails, or null. */
  private verify(
    req: IncomingMessage,
    path: string,
    query: [string, string][],
    body: Buffer,
  ): { problem: string | null; auth: FakeS3Request['auth'] } {
    const method = req.method ?? 'GET';
    const presigned = query.find(([k]) => k === 'X-Amz-Signature');
    let credential: string;
    let signedHeaders: string;
    let signature: string;
    let amzDate: string;
    let payloadHash: string;
    let canonicalQuery: [string, string][];
    if (presigned) {
      const get = (name: string) => query.find(([k]) => k === name)?.[1] ?? '';
      if (get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') {
        return { problem: 'unsupported algorithm', auth: 'presigned' };
      }
      credential = get('X-Amz-Credential');
      signedHeaders = get('X-Amz-SignedHeaders');
      signature = presigned[1];
      amzDate = get('X-Amz-Date');
      const expires = Number(get('X-Amz-Expires'));
      const signedAt = Date.parse(
        amzDate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'),
      );
      if (!Number.isFinite(signedAt) || !(expires > 0) || expires > 604_800) {
        return { problem: 'bad presigned parameters', auth: 'presigned' };
      }
      if (this.now().getTime() > signedAt + expires * 1000) {
        return { problem: 'Request has expired', auth: 'presigned' };
      }
      payloadHash = 'UNSIGNED-PAYLOAD';
      canonicalQuery = query.filter(([k]) => k !== 'X-Amz-Signature');
    } else {
      const header = req.headers.authorization ?? '';
      const match =
        /^AWS4-HMAC-SHA256 Credential=([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/.exec(
          header,
        );
      if (!match) return { problem: 'missing or malformed Authorization', auth: 'none' };
      [, credential = '', signedHeaders = '', signature = ''] = match;
      amzDate = String(req.headers['x-amz-date'] ?? '');
      payloadHash = String(req.headers['x-amz-content-sha256'] ?? '');
      if (/^[0-9a-f]{64}$/.test(payloadHash) && sha256(body) !== payloadHash) {
        return { problem: 'XAmzContentSHA256Mismatch', auth: 'header' };
      }
      canonicalQuery = query;
    }
    const auth = presigned ? ('presigned' as const) : ('header' as const);
    const [accessKey, date, region, service, terminator] = credential.split('/');
    if (accessKey !== this.accessKeyId) return { problem: 'InvalidAccessKeyId', auth };
    if (service !== 's3' || terminator !== 'aws4_request' || !date || !region) {
      return { problem: 'bad credential scope', auth };
    }
    const names = signedHeaders.split(';');
    if (!names.includes('host')) return { problem: 'host must be signed', auth };
    const headerLines = names.map((name) => {
      const value = req.headers[name];
      const text = Array.isArray(value) ? value.join(',') : (value ?? '');
      return `${name}:${String(text).trim().replace(/\s+/g, ' ')}\n`;
    });
    const sortedQuery = canonicalQuery
      .map(([k, v]) => [awsEncode(k), awsEncode(v)] as const)
      .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const canonical = [
      method,
      path,
      sortedQuery,
      headerLines.join(''),
      signedHeaders,
      payloadHash,
    ].join('\n');
    const scope = `${date}/${region}/${service}/${terminator}`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const key = hmac(
      hmac(hmac(hmac(`AWS4${this.secretAccessKey}`, date), region), service),
      terminator,
    );
    const expected = createHmac('sha256', key).update(toSign).digest();
    const given = Buffer.from(signature, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { problem: 'SignatureDoesNotMatch', auth };
    }
    return { problem: null, auth };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    const q = url.indexOf('?');
    const path = q < 0 ? url : url.slice(0, q);
    const rawQuery = q < 0 ? '' : url.slice(q + 1);
    const query = parseQuery(rawQuery);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: Buffer = Buffer.concat(chunks);
    const log: FakeS3Request = {
      method: req.method ?? '',
      path: decode(path),
      query: rawQuery,
      status: 0,
      auth: 'none',
    };
    this.requests.push(log);
    res.on('finish', () => {
      log.status = res.statusCode;
    });

    const { problem, auth } = this.verify(req, path, query, body);
    log.auth = auth;
    if (problem) {
      const code = problem === 'Request has expired' ? 'AccessDenied' : problem;
      this.error(res, 403, /^[A-Za-z]+$/.test(code) ? code : 'AccessDenied', problem);
      return;
    }
    if (String(req.headers['x-amz-content-sha256'] ?? '').startsWith('STREAMING-')) {
      body = decodeAwsChunked(body);
    }

    const segments = path.split('/').slice(1);
    const bucketName = decode(segments[0] ?? '');
    const key = decode(segments.slice(1).join('/'));
    const bucket = this.buckets.get(bucketName);
    if (!bucket) {
      this.error(res, 404, 'NoSuchBucket', 'The specified bucket does not exist');
      return;
    }
    const has = (name: string) => query.some(([k]) => k === name);
    const param = (name: string) => query.find(([k]) => k === name)?.[1];
    const method = req.method ?? 'GET';

    if (key === '') {
      if (method === 'HEAD') {
        res.end();
        return;
      }
      if (method === 'GET' && has('uploads')) {
        const prefix = param('prefix') ?? '';
        const uploads = [...this.uploads.entries()]
          .filter(([, u]) => u.key.startsWith(prefix))
          .sort(([, a], [, b]) => (a.key < b.key ? -1 : 1))
          .map(
            ([id, u]) =>
              `<Upload><Key>${xmlEscape(u.key)}</Key><UploadId>${id}</UploadId><Initiated>${u.initiated.toISOString()}</Initiated></Upload>`,
          )
          .join('');
        this.xml(
          res,
          `<ListMultipartUploadsResult><Bucket>${xmlEscape(bucketName)}</Bucket><KeyMarker></KeyMarker><UploadIdMarker></UploadIdMarker><MaxUploads>1000</MaxUploads><IsTruncated>false</IsTruncated>${uploads}</ListMultipartUploadsResult>`,
        );
        return;
      }
      this.error(res, 501, 'NotImplemented', 'not supported by the fake');
      return;
    }

    const uploadId = param('uploadId');
    if (method === 'POST' && has('uploads')) {
      const id = randomBytes(12).toString('hex');
      this.uploads.set(id, {
        key,
        initiated: this.now(),
        contentType: String(req.headers['content-type'] ?? 'binary/octet-stream'),
        parts: new Map(),
      });
      this.xml(
        res,
        `<InitiateMultipartUploadResult><Bucket>${xmlEscape(bucketName)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
      return;
    }
    if (uploadId !== undefined) {
      const upload = this.uploads.get(uploadId);
      if (!upload || upload.key !== key) {
        this.error(res, 404, 'NoSuchUpload', 'The specified upload does not exist');
        return;
      }
      if (method === 'PUT') {
        const partNumber = Number(param('partNumber'));
        const etag = `"${createHash('md5').update(body).digest('hex')}"`;
        upload.parts.set(partNumber, { body, etag });
        res.setHeader('etag', etag);
        res.end();
        return;
      }
      if (method === 'DELETE') {
        this.uploads.delete(uploadId);
        res.statusCode = 204;
        res.end();
        return;
      }
      if (method === 'POST') {
        const listed = [...body.toString('utf8').matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map(
          (m) => Number(m[1]),
        );
        const parts = listed.map((n) => upload.parts.get(n));
        if (listed.length === 0 || parts.some((p) => !p)) {
          this.error(res, 400, 'InvalidPart', 'a listed part was not uploaded');
          return;
        }
        const all = Buffer.concat(parts.map((p) => (p as { body: Buffer }).body));
        const etag = `"${createHash('md5').update(all).digest('hex')}-${parts.length}"`;
        bucket.set(key, {
          body: all,
          contentType: upload.contentType,
          etag,
          lastModified: this.now(),
        });
        this.uploads.delete(uploadId);
        this.xml(
          res,
          `<CompleteMultipartUploadResult><Bucket>${xmlEscape(bucketName)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(etag)}</ETag></CompleteMultipartUploadResult>`,
        );
        return;
      }
    }

    if (method === 'PUT') {
      const etag = `"${createHash('md5').update(body).digest('hex')}"`;
      bucket.set(key, {
        body,
        contentType: String(req.headers['content-type'] ?? 'binary/octet-stream'),
        etag,
        lastModified: this.now(),
      });
      res.setHeader('etag', etag);
      res.end();
      return;
    }
    if (method === 'DELETE') {
      bucket.delete(key);
      res.statusCode = 204;
      res.end();
      return;
    }
    if (method === 'GET' || method === 'HEAD') {
      const object = bucket.get(key);
      if (!object) {
        this.error(res, 404, 'NoSuchKey', 'The specified key does not exist.');
        return;
      }
      res.setHeader('accept-ranges', 'bytes');
      res.setHeader('etag', object.etag);
      res.setHeader('last-modified', object.lastModified.toUTCString());
      res.setHeader('content-type', param('response-content-type') ?? object.contentType);
      const disposition = param('response-content-disposition');
      if (disposition !== undefined) res.setHeader('content-disposition', disposition);
      let slice = object.body;
      const range = req.headers.range;
      if (range) {
        const r = parseRange(range, object.body.length);
        if (!r) {
          res.setHeader('content-range', `bytes */${object.body.length}`);
          this.error(res, 416, 'InvalidRange', 'The requested range is not satisfiable');
          return;
        }
        slice = object.body.subarray(r.start, r.end + 1);
        res.statusCode = 206;
        res.setHeader('content-range', `bytes ${r.start}-${r.end}/${object.body.length}`);
      }
      res.setHeader('content-length', String(slice.length));
      res.end(method === 'HEAD' ? undefined : slice);
      return;
    }
    this.error(res, 501, 'NotImplemented', 'not supported by the fake');
  }
}
