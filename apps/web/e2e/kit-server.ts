// Frontend kits on a static host (M1-111): this run's build made into kits with the Builder
// core, each served the way a plain static host serves files, with /api passed to the
// attachments backend (8791) so the kits run on the page's own origin:
//   4178  the zip kit, clean URLs, with the host fallback that sends deep links to index.html
//   4179  the single-file kit: index.html alone, nothing else on the host
//   4180  the zip kit pinned to another instance, which must refuse to run
// and two kits with no /api of their own, calling the cross-origin backend of web-server.ts
// (api.taskmoor.localhost:8794) directly (M1-107, cross-origin.spec.ts):
//   4181  app.taskmoor.localhost, a sibling subdomain: the backend's cookie (auth "session")
//   4182  127.0.0.1, another site: OAuth with PKCE (auth "oauth")
// Playwright starts it after the preview's build and the API servers.
// Started with: tsx apps/web/e2e/kit-server.ts
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleFrontendKit, type KitFiles, kitText } from '@taskmoor/builder-core';
import { DEFAULT_RUNTIME_CONFIG, type RuntimeConfig } from '@taskmoor/webconfig';

export const E2E_KIT_ZIP_PORT = 4178;
export const E2E_KIT_SINGLE_PORT = 4179;
export const E2E_KIT_WRONG_PORT = 4180;
export const E2E_KIT_SIBLING_PORT = 4181;
export const E2E_KIT_CROSS_SITE_PORT = 4182;
const API = { host: '127.0.0.1', port: 8791 };
const TOPOLOGY_API = 'http://api.taskmoor.localhost:8794';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
function files(prefix = ''): Record<string, Uint8Array> {
  return Object.fromEntries(
    readdirSync(join(dist, prefix), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? Object.entries(files(`${prefix}${e.name}/`))
        : [[`${prefix}${e.name}`, new Uint8Array(readFileSync(join(dist, prefix, e.name)))]],
    ),
  );
}

// The backend's own identity, as a kit built for it carries.
const meta = (await (await fetch(`http://${API.host}:${API.port}/api/meta`)).json()) as {
  instance: { id: string; publicKey: string };
};
const web = files();
const config = (pin: { id: string; key: string }, routing: 'path' | 'hash'): RuntimeConfig => ({
  ...DEFAULT_RUNTIME_CONFIG,
  routing,
  instanceId: pin.id,
  instanceKey: pin.key,
});
const own = { id: meta.instance.id, key: meta.instance.publicKey };
// Another instance: an id and a key that are not this backend's.
const stranger = { id: randomUUID(), key: `MCowBQYDK2VwAyEA${'Q'.repeat(43)}` };

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
};

/**
 * A static host: files as they are, and (for clean URLs) unknown paths answered by index.html.
 * With `proxy`, /api and WebSockets go to the attachments backend as a host's rewrite would.
 */
function host(port: number, kit: KitFiles, fallback: boolean, proxy = true) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    if (proxy && path.startsWith('/api/')) {
      const upstream = request(
        {
          ...API,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: `${API.host}:${API.port}` },
        },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      upstream.on('error', () => res.writeHead(502).end());
      req.pipe(upstream);
      return;
    }
    const name = path === '/' ? 'index.html' : path.slice(1);
    const file = kit[name] ?? (fallback && !name.includes('.') ? kit['index.html'] : undefined);
    if (file === undefined) {
      res.writeHead(404).end('not found');
      return;
    }
    const served = file === kit[name] ? name : 'index.html';
    res.writeHead(200, {
      'content-type': TYPES[served.split('.').pop() ?? ''] ?? 'application/octet-stream',
    });
    res.end(typeof file === 'string' ? file : Buffer.from(file));
  });
  // WebSockets (the sync socket, co-editing) pass straight through to the backend.
  server.on('upgrade', (req, socket, head) => {
    if (!proxy) {
      socket.destroy();
      return;
    }
    const upstream = connect(API.port, API.host, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i] ?? '';
        lines.push(
          `${name}: ${name.toLowerCase() === 'host' ? `${API.host}:${API.port}` : req.rawHeaders[i + 1]}`,
        );
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  // Both loopback addresses: app.taskmoor.localhost may resolve to either.
  server.listen(port, proxy ? '0.0.0.0' : '::');
}

const zip = await assembleFrontendKit(web, config(own, 'path'));
const single = await assembleFrontendKit(web, config(own, 'hash'), { singleFile: true });
const wrong = await assembleFrontendKit(web, config(stranger, 'path'));
host(E2E_KIT_ZIP_PORT, zip, true);
host(E2E_KIT_SINGLE_PORT, single, false);
host(E2E_KIT_WRONG_PORT, wrong, true);

// The frontends on other origins, pinned to their backend like a Builder kit for it.
const topology = (await (await fetch(`${TOPOLOGY_API}/api/meta`)).json()) as {
  instance: { id: string; publicKey: string };
};
const topologyPin = { id: topology.instance.id, key: topology.instance.publicKey };
for (const [port, auth] of [
  [E2E_KIT_SIBLING_PORT, 'session'],
  [E2E_KIT_CROSS_SITE_PORT, 'oauth'],
] as const) {
  const kit = await assembleFrontendKit(web, {
    ...config(topologyPin, 'path'),
    apiUrl: TOPOLOGY_API,
    auth,
  });
  host(port, kit, true, false);
}
process.stdout.write(
  `frontend kits on ${E2E_KIT_ZIP_PORT}, ${E2E_KIT_SINGLE_PORT}, ${E2E_KIT_WRONG_PORT}, ${E2E_KIT_SIBLING_PORT} and ${E2E_KIT_CROSS_SITE_PORT} (${kitText(single['index.html']).length} bytes in one file)\n`,
);
