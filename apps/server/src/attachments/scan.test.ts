import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ClamdScanner, parseClamdTarget, scannerFromSetting } from './scan';

/** A clamd that reads INSTREAM chunks and answers as `verdict` says for what it received. */
async function fakeClamd(verdict: (body: Buffer) => string | null): Promise<Server> {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let command = false;
    const body: Buffer[] = [];
    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (!command) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        expect(buffer.subarray(0, end).toString()).toBe('zINSTREAM');
        buffer = buffer.subarray(end + 1);
        command = true;
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (size === 0) {
          const answer = verdict(Buffer.concat(body));
          if (answer === null) socket.destroy();
          else socket.end(`${answer}\0`);
          return;
        }
        if (buffer.length < 4 + size) return;
        body.push(buffer.subarray(4, 4 + size));
        buffer = buffer.subarray(4 + size);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

describe('the scan hook (CORE-021)', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  const scanner = () =>
    new ClamdScanner({
      host: '127.0.0.1',
      port: (server?.address() as AddressInfo | null)?.port ?? 1,
    });

  it('[CORE-021] streams the file to clamd and reads its verdict', async () => {
    server = await fakeClamd((body) =>
      body.includes('MALWARE') ? 'stream: Test.Signature FOUND' : 'stream: OK',
    );
    const big = Buffer.alloc(300_000, 0x61);
    expect(await scanner().scan(Readable.from([big, Buffer.from('clean end')]))).toEqual({
      result: 'clean',
    });
    expect(await scanner().scan(Readable.from([Buffer.from('xx MALWARE xx')]))).toEqual({
      result: 'infected',
      signature: 'Test.Signature',
    });
  });

  it('[CORE-021] treats a limit, an error or a dropped connection as a failure to retry', async () => {
    server = await fakeClamd(() => 'INSTREAM size limit exceeded. ERROR');
    await expect(scanner().scan(Readable.from(['x']))).rejects.toThrow(/size limit exceeded/);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = await fakeClamd(() => null);
    await expect(scanner().scan(Readable.from(['x']))).rejects.toThrow(/clamd/);
    await expect(
      new ClamdScanner({ host: '127.0.0.1', port: 1 }).scan(Readable.from(['x'])),
    ).rejects.toThrow(/clamd/);
  });

  it('[CORE-021] reads the clamd address and has no scanner by default', () => {
    expect(parseClamdTarget('clamav:3310')).toEqual({ host: 'clamav', port: 3310 });
    expect(parseClamdTarget('tcp://10.0.0.5:3310')).toEqual({ host: '10.0.0.5', port: 3310 });
    expect(parseClamdTarget('[::1]:3310')).toEqual({ host: '::1', port: 3310 });
    expect(parseClamdTarget('unix:/run/clamav/clamd.sock')).toEqual({
      path: '/run/clamav/clamd.sock',
    });
    expect(() => parseClamdTarget('clamav')).toThrow(/TASKMOOR_SCAN_CLAMD/);
    expect(() => parseClamdTarget('unix:relative.sock')).toThrow(/absolute/);
    expect(scannerFromSetting(undefined)).toBeNull();
    expect(scannerFromSetting('clamav:3310')?.name).toBe('clamav');
  });
});
