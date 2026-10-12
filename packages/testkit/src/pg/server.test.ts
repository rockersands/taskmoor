import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runningPort } from './server';

describe('runningPort', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'taskmoor-pg-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the port of a live server from its pid file', async () => {
    // This process stands in for the postmaster; a pid file lists pid, data dir, start time, port.
    await writeFile(
      join(dir, 'postmaster.pid'),
      `${process.pid}\n${dir}\n1791794425\n58568\nlocalhost\n`,
    );
    expect(await runningPort(dir)).toBe(58568);
  });

  it('reports nothing for a dead pid or a missing file', async () => {
    await writeFile(join(dir, 'postmaster.pid'), `${2 ** 22 - 1}\n${dir}\n1\n58568\n`);
    expect(await runningPort(dir)).toBeUndefined();
    await rm(join(dir, 'postmaster.pid'));
    expect(await runningPort(dir)).toBeUndefined();
  });
});
