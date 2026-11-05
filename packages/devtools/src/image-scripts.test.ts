import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importedLinkRoute } from '@taskmoor/webconfig';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SMOKE = readFileSync(join(ROOT, 'tools/image/smoke.sh'), 'utf8');

/**
 * Where the backend sends a page request for `path` when it serves the frontend at the root, by
 * the rules of apps/server/src/frontend.ts: a link from the tracker an import came from goes to
 * its app route (M1-128), any other deep link to its hash route under hash routing (M1-105).
 * With clean URLs only imported links redirect; other paths get the app shell.
 */
function expectedLocation(path: string, routing: 'hash' | 'path'): string | null {
  const link = importedLinkRoute(path, '');
  if (link !== null) return routing === 'path' ? `/${link.slice(2)}` : `/${link}`;
  return routing === 'hash' ? `/#${path}` : null;
}

/** The `redirects_to <path> <location>` probes of tools/image/smoke.sh. */
function probes(): { path: string; location: string }[] {
  return [...SMOKE.matchAll(/^redirects_to (\/\S*) (\/\S*)$/gm)].map((m) => ({
    path: m[1] ?? '',
    location: m[2] ?? '',
  }));
}

// The image smoke script runs only where Docker does, so a change to the server's redirects
// left it expecting the old ones unnoticed (T-023: /browse/ABC-1 had become a ticket link).
describe('tools/image/smoke.sh against the server it probes', () => {
  it('[OPS-013] [IMP-011] expects the redirects the server makes for deep and imported links', () => {
    const found = probes();
    expect(found.map((p) => p.path)).toEqual(
      expect.arrayContaining(['/tickets/ABC-1', '/browse/ABC-1']),
    );
    for (const { path, location } of found) {
      const routing = location.startsWith('/#') ? 'hash' : 'path';
      expect({ path, location }).toEqual({ path, location: expectedLocation(path, routing) });
    }
  });

  it('[IMP-011] checks an imported link in both routing modes', () => {
    const browse = probes().filter((p) => p.path === '/browse/ABC-1');
    expect(browse.map((p) => p.location).sort()).toEqual(['/#/tickets/ABC-1', '/tickets/ABC-1']);
  });
});
