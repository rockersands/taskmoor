import { connect, type Socket } from 'node:net';

/**
 * The antivirus hook (CORE-021, ADR-040). A deployment plugs a scanner in by configuration
 * (`TASKMOOR_SCAN_CLAMD`); without one, files count as clean when they arrive. With one, a new
 * file waits as `pending` until the worker has streamed it through the scanner: `clean` files
 * are served, `infected` ones never, and a file the scanner could not judge after every retry
 * is `failed` and is not served either. Only the verdict leaves the scanner; the file stays
 * where it is.
 */
export type ScanVerdict = { result: 'clean' } | { result: 'infected'; signature: string };

export interface Scanner {
  /** For logs and the admin's settings view. */
  readonly name: string;
  scan(body: NodeJS.ReadableStream): Promise<ScanVerdict>;
}

export type ClamdTarget = { host: string; port: number } | { path: string };

/** Reads `host:port`, `tcp://host:port` or `unix:/path/to/clamd.sock`. */
export function parseClamdTarget(value: string): ClamdTarget {
  if (value.startsWith('unix:')) {
    const path = value.slice('unix:'.length);
    if (!path.startsWith('/')) throw new Error('TASKMOOR_SCAN_CLAMD unix: needs an absolute path');
    return { path };
  }
  const bare = value.replace(/^tcp:\/\//, '');
  const match = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(bare);
  const port = Number(match?.[2]);
  if (!match || !(port > 0 && port < 65536)) {
    throw new Error('TASKMOOR_SCAN_CLAMD must be host:port, tcp://host:port or unix:/path');
  }
  return { host: (match[1] as string).replace(/^\[|\]$/g, ''), port };
}

const CHUNK = 64 * 1024;

/**
 * ClamAV's daemon over its INSTREAM command: the file goes in length-prefixed chunks, the
 * answer is "stream: OK" or "stream: <signature> FOUND". Anything else (the stream limit,
 * a broken connection, a timeout) is an error, and the job retries.
 */
export class ClamdScanner implements Scanner {
  readonly name = 'clamav';

  constructor(
    private readonly target: ClamdTarget,
    private readonly timeoutMs = 10 * 60_000,
  ) {}

  scan(body: NodeJS.ReadableStream): Promise<ScanVerdict> {
    return new Promise<ScanVerdict>((resolve, reject) => {
      const socket: Socket =
        'path' in this.target
          ? connect(this.target.path)
          : connect(this.target.port, this.target.host);
      let reply = '';
      let settled = false;
      const finish = (error: Error | null, verdict?: ScanVerdict) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) {
          (body as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
          reject(error);
        } else resolve(verdict as ScanVerdict);
      };
      socket.setTimeout(this.timeoutMs, () => finish(new Error('clamd timed out')));
      socket.on('error', (error) => finish(new Error(`clamd: ${error.message}`)));
      socket.on('data', (data: Buffer) => {
        reply += data.toString('utf8');
        const end = reply.indexOf('\0');
        if (end < 0) return;
        const text = reply.slice(0, end).trim();
        const found = /^stream: (.+) FOUND$/.exec(text);
        if (text === 'stream: OK') finish(null, { result: 'clean' });
        else if (found)
          finish(null, { result: 'infected', signature: (found[1] as string).slice(0, 200) });
        else finish(new Error(`clamd: ${text.slice(0, 200)}`));
      });
      socket.on('close', () =>
        finish(
          new Error(`clamd closed the connection${reply ? `: ${reply.trim().slice(0, 200)}` : ''}`),
        ),
      );
      socket.once('connect', async () => {
        try {
          socket.write('zINSTREAM\0');
          for await (const chunk of body) {
            const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
            for (let at = 0; at < buffer.length; at += CHUNK) {
              const piece = buffer.subarray(at, at + CHUNK);
              const size = Buffer.alloc(4);
              size.writeUInt32BE(piece.length);
              if (settled) return;
              if (!socket.write(Buffer.concat([size, piece]))) {
                await new Promise<void>((done) => socket.once('drain', done));
              }
            }
          }
          if (!settled) socket.write(Buffer.alloc(4));
        } catch (error) {
          finish(error as Error);
        }
      });
    });
  }
}

/** The configured scanner, or null for none (files are clean when they arrive). */
export function scannerFromSetting(value: string | undefined): Scanner | null {
  return value ? new ClamdScanner(parseClamdTarget(value)) : null;
}
