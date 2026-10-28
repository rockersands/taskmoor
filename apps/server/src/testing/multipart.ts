import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

/**
 * A `multipart/form-data` body with one file part, as a browser's FormData sends it, for
 * `app.inject`. `content` may be a stream, so a test can send a large body without holding it.
 */
export function multipartFile(
  filename: string,
  contentType: string,
  content: Buffer | string | Readable,
  field = 'file',
): { payload: Buffer | Readable; headers: Record<string, string> } {
  const boundary = `----taskmoor${randomBytes(12).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  if (content instanceof Readable) {
    const body = Readable.from(
      (async function* () {
        yield head;
        for await (const chunk of content) yield chunk as Buffer;
        yield tail;
      })(),
    );
    return { payload: body, headers };
  }
  const payload = Buffer.concat([head, Buffer.from(content), tail]);
  return { payload, headers: { ...headers, 'content-length': String(payload.length) } };
}
