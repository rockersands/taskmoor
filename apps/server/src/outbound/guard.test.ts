import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { embeddedIpv4, parseOutboundAllow, refusedReason } from './addresses';
import { createOutboundGuard, OutboundRefused, type Resolver } from './guard';

/**
 * The outbound guard (M1-118; NFR-008; ASVS 5.2.6, 12.6.1; ADR-110). Names resolve through an
 * injected resolver, never DNS; the receivers listen on loopback, which each test allows by an
 * address or range as an operator would.
 */
const table = (answers: Record<string, string[]>): Resolver & { calls: string[] } => {
  const calls: string[] = [];
  const resolve = async (host: string) => {
    calls.push(host);
    const found = answers[host];
    if (!found) throw new Error(`no such host ${host}`);
    return found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return Object.assign(resolve, { calls });
};

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

async function receiver(
  host: string,
  answer: (
    req: IncomingMessage,
    body: string,
  ) => { status: number; headers?: Record<string, string>; body?: string | Buffer },
): Promise<{ server: Server; port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const out = answer(req, body);
      res.writeHead(out.status, out.headers ?? {});
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return { server, port: (server.address() as AddressInfo).port, seen };
}

describe('outbound guard: addresses (ASVS 5.2.6)', () => {
  it('[NFR-008] refuses loopback, private, CGNAT, link-local, unique-local, multicast, reserved and metadata addresses', () => {
    const cases: [string, string | null][] = [
      ['127.0.0.1', 'loopback'],
      ['127.255.0.9', 'loopback'],
      ['0.0.0.0', 'unspecified'],
      ['10.1.2.3', 'private'],
      ['172.16.0.1', 'private'],
      ['172.31.255.254', 'private'],
      ['192.168.0.10', 'private'],
      ['100.64.0.1', 'cgnat'],
      ['169.254.1.1', 'link_local'],
      ['169.254.169.254', 'metadata'],
      ['169.254.170.2', 'metadata'],
      ['100.100.100.200', 'metadata'],
      ['224.0.0.251', 'multicast'],
      ['240.0.0.1', 'reserved'],
      ['255.255.255.255', 'reserved'],
      ['192.0.2.1', 'reserved'],
      ['::', 'unspecified'],
      ['::1', 'loopback'],
      ['fe80::1', 'link_local'],
      ['fe80::1%eth0', 'link_local'],
      ['[fe80::1]', 'link_local'],
      ['fc00::1', 'unique_local'],
      ['fd12:3456::1', 'unique_local'],
      ['fd00:ec2::254', 'metadata'],
      ['fd00:ec2:0:0:0:0:0:254', 'metadata'],
      ['ff02::1', 'multicast'],
      ['2001:db8::1', 'reserved'],
      // IPv4 inside IPv6: judged by the IPv4 address.
      ['::ffff:127.0.0.1', 'loopback'],
      ['::ffff:7f00:1', 'loopback'],
      ['::ffff:a9fe:a9fe', 'metadata'],
      ['::10.0.0.1', 'private'],
      ['64:ff9b::a9fe:a9fe', 'metadata'],
      ['64:ff9b::c0a8:1', 'private'],
      ['2002:c0a8:101::1', 'private'],
      ['2002:7f00:1::', 'loopback'],
      // Public addresses pass.
      ['8.8.8.8', null],
      ['1.1.1.1', null],
      ['172.32.0.1', null],
      ['100.128.0.1', null],
      ['2606:4700:4700::1111', null],
      ['::ffff:8.8.8.8', null],
      ['64:ff9b::808:808', null],
      ['2002:808:808::1', null],
    ];
    for (const [address, reason] of cases) {
      expect(refusedReason(address), address).toBe(reason);
    }
    expect(embeddedIpv4('::ffff:c0a8:10a')).toBe('192.168.1.10');
    expect(embeddedIpv4('2606:4700::1')).toBeNull();
  });

  it('[NFR-008] reads the operator allow list: hosts, domains, addresses and ranges; refuses anything else', () => {
    const allow = parseOutboundAllow(
      ' hooks.corp.example, *.internal.example 10.20.0.0/16,fd00::/8 192.168.5.5 ',
    );
    expect([...allow.hosts]).toEqual(['hooks.corp.example']);
    expect(allow.domains).toEqual(['internal.example']);
    expect(allow.ranges.check('10.20.3.4', 'ipv4')).toBe(true);
    expect(allow.ranges.check('10.21.3.4', 'ipv4')).toBe(false);
    expect(allow.ranges.check('fd12::1', 'ipv6')).toBe(true);
    expect(allow.ranges.check('192.168.5.5', 'ipv4')).toBe(true);
    expect(parseOutboundAllow(undefined).entries).toEqual([]);
    expect(() => parseOutboundAllow('http://hooks.corp.example')).toThrow(/not a host name/);
    expect(() => parseOutboundAllow('10.0.0.0/33')).toThrow(/not a host name/);
  });
});

describe('outbound guard: requests (ASVS 5.2.6, 12.6.1)', () => {
  let main: Awaited<ReturnType<typeof receiver>>;
  let other: Awaited<ReturnType<typeof receiver>> | undefined;
  const guards: { close(): void }[] = [];
  const guard = (options: Parameters<typeof createOutboundGuard>[0]) => {
    const made = createOutboundGuard(options);
    guards.push(made);
    return made;
  };

  beforeAll(async () => {
    main = await receiver('127.0.0.1', (req, body) => {
      if (req.url === '/gzip') {
        return {
          status: 200,
          headers: { 'content-encoding': 'gzip', 'content-type': 'text/plain' },
          body: gzipSync('unpacked'),
        };
      }
      if (req.url === '/to-loopback') {
        return { status: 302, headers: { location: `http://localhost:${main.port}/landed` } };
      }
      if (req.url === '/to-allowed') {
        return { status: 307, headers: { location: `http://hooks.example:${main.port}/landed` } };
      }
      if (req.url === '/empty') return { status: 204 };
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ echo: body }),
      };
    });
  });
  afterEach(() => {
    for (const g of guards.splice(0)) g.close();
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => main.server.close(() => resolve()));
    if (other) await new Promise<void>((resolve) => other?.server.close(() => resolve()));
  });

  it('[NFR-008] refuses an address literal before connecting, and a name that resolves to a private address', async () => {
    const resolve = table({
      'hooks.example': ['10.0.0.5'],
      'mixed.example': ['93.184.215.14', '127.0.0.1'],
    });
    const g = guard({ resolve });
    await expect(g.fetch(`http://127.0.0.1:${main.port}/`)).rejects.toBeInstanceOf(OutboundRefused);
    await expect(g.fetch(`http://[::1]:${main.port}/`)).rejects.toThrow(
      /not a public address \(loopback\)/,
    );
    await expect(g.fetch('https://hooks.example/x')).rejects.toThrow(
      'Refused: hooks.example resolves to 10.0.0.5, which is not a public address (private)',
    );
    // One private answer among public ones refuses the name.
    await expect(g.fetch('https://mixed.example/')).rejects.toThrow(/\(loopback\)/);
    await expect(g.fetch('https://nowhere.example/')).rejects.toThrow(
      'Refused: nowhere.example does not resolve',
    );
    await expect(g.fetch('file:///etc/passwd')).rejects.toThrow(/only http and https/);
    await expect(g.fetch('ftp://hooks.example/')).rejects.toThrow(/only http and https/);
    expect(main.seen).toHaveLength(0);
  });

  it('[NFR-008] lets through what the operator allows, by host, domain or range, with method, headers and body', async () => {
    const resolve = table({
      'hooks.example': ['127.0.0.1'],
      'a.internal.example': ['127.0.0.1'],
      'plain.example': ['127.0.0.1'],
    });
    const byHost = guard({ allow: 'hooks.example,*.internal.example', resolve });
    const res = await byHost.fetch(`http://hooks.example:${main.port}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-check': 'yes' },
      body: JSON.stringify({ hello: 'there' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echo: '{"hello":"there"}' });
    expect(main.seen.at(-1)).toMatchObject({ method: 'POST', url: '/echo' });
    expect(main.seen.at(-1)?.headers['x-check']).toBe('yes');
    expect(main.seen.at(-1)?.headers.host).toBe(`hooks.example:${main.port}`);
    expect((await byHost.fetch(`http://a.internal.example:${main.port}/`)).status).toBe(200);
    // Not named: refused although it resolves to the same address.
    await expect(byHost.fetch(`http://plain.example:${main.port}/`)).rejects.toThrow(/loopback/);

    const byRange = guard({ allow: '127.0.0.0/8', resolve });
    expect((await byRange.fetch(`http://plain.example:${main.port}/`)).status).toBe(200);
    expect((await byRange.fetch(`http://127.0.0.1:${main.port}/`)).status).toBe(200);
    const form = await byRange.fetch(`http://127.0.0.1:${main.port}/form`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code' }),
    });
    expect(await form.json()).toEqual({ echo: 'grant_type=authorization_code' });
    const gz = await byRange.fetch(`http://127.0.0.1:${main.port}/gzip`);
    expect(await gz.text()).toBe('unpacked');
    const empty = await byRange.fetch(`http://127.0.0.1:${main.port}/empty`);
    expect(empty.status).toBe(204);
    expect(empty.body).toBeNull();
  });

  it('[NFR-008] connects to the address it checked: a second answer from DNS cannot swap it (rebinding)', async () => {
    // Linux answers on all of 127/8: the checked address is 127.0.0.2, the swapped one 127.0.0.1.
    other = await receiver('127.0.0.2', () => ({ status: 200, body: 'checked' }));
    let calls = 0;
    const resolve: Resolver = async () => {
      calls += 1;
      return [{ address: calls === 1 ? '127.0.0.2' : '127.0.0.1', family: 4 }];
    };
    const g = guard({ allow: '127.0.0.2', resolve });
    const res = await g.fetch(`http://rebind.example:${other.port}/`);
    expect(await res.text()).toBe('checked');
    expect(calls).toBe(1);
    expect(other.seen).toHaveLength(1);
    // A new connection resolves again, and the swapped answer is refused.
    g.close();
    await expect(
      createOutboundGuard({ allow: '127.0.0.2', resolve }).fetch(
        `http://rebind.example:${other.port}/`,
      ),
    ).rejects.toThrow(/loopback/);
  });

  it('[NFR-008] checks every redirect it follows; manual and error modes do not follow', async () => {
    const resolve = table({ 'hooks.example': ['127.0.0.1'], localhost: ['127.0.0.1'] });
    const g = guard({ allow: 'hooks.example', resolve });
    const start = `http://hooks.example:${main.port}`;
    // To a host the operator did not allow: refused at the hop.
    await expect(g.fetch(`${start}/to-loopback`)).rejects.toThrow(
      /localhost resolves to 127\.0\.0\.1/,
    );
    const manual = await g.fetch(`${start}/to-loopback`, { redirect: 'manual' });
    expect(manual.status).toBe(302);
    await expect(g.fetch(`${start}/to-loopback`, { redirect: 'error' })).rejects.toThrow(
      /redirect/,
    );
    // To an allowed host: followed, method and body kept on a 307.
    const before = main.seen.length;
    const followed = await g.fetch(`${start}/to-allowed`, {
      method: 'POST',
      headers: { authorization: 'Bearer for-this-origin-only' },
      body: 'kept',
    });
    expect(followed.status).toBe(200);
    const landed = main.seen.slice(before);
    expect(landed.map((s) => [s.method, s.url, s.body])).toEqual([
      ['POST', '/to-allowed', 'kept'],
      ['POST', '/landed', 'kept'],
    ]);
  });

  it('[NFR-008] a timeout rejects as fetch does', async () => {
    const slow = await receiver('127.0.0.1', () => ({ status: 200 }));
    slow.server.removeAllListeners('request');
    slow.server.on('request', () => undefined);
    try {
      const g = guard({ allow: '127.0.0.1' });
      const error = await g
        .fetch(`http://127.0.0.1:${slow.port}/`, { signal: AbortSignal.timeout(100) })
        .catch((e: unknown) => e);
      expect((error as Error).name).toBe('TimeoutError');
    } finally {
      slow.server.closeAllConnections();
      await new Promise<void>((resolve) => slow.server.close(() => resolve()));
    }
  });
});
