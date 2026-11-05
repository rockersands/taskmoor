import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importedLinkRoute } from '@taskmoor/webconfig';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SMOKE = readFileSync(join(ROOT, 'tools/image/smoke.sh'), 'utf8');

/** The bash scripts of the repository's tools and install kits. */
function shellScripts(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.sh'))
    .map((e) => relative(ROOT, join(e.parentPath, e.name)).replaceAll('\\', '/'))
    .filter((path) => !path.includes('node_modules/'))
    .sort();
}

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

// The Builder CLI reads apps/web/dist unless told otherwise, and a checkout has none until
// `pnpm build`: smoke-backend-kit.sh stopped there in a fresh worktree (T-023). The image
// scripts give it the image's own web build, which is also the version the kit pins.
describe('image scripts that make kits', () => {
  it('[OPS-015] give the Builder CLI the web build taken from the image', () => {
    const scripts = shellScripts('tools').filter((path) =>
      readFileSync(join(ROOT, path), 'utf8').includes('packages/devtools/src/cli/builder.ts'),
    );
    expect(scripts).toEqual(
      expect.arrayContaining(['tools/image/fresh-vm.sh', 'tools/image/smoke-backend-kit.sh']),
    );
    for (const script of scripts) {
      const text = readFileSync(join(ROOT, script), 'utf8');
      expect({
        script,
        copiesWeb: /docker cp "\$cid:\/app\/web" "\$WORK\/web"/.test(text),
      }).toEqual({ script, copiesWeb: true });
      expect({ script, passesWeb: /--web "\$WORK\/web"/.test(text) }).toEqual({
        script,
        passesWeb: true,
      });
    }
  });
});

// A Mac's own bash is 3.2, where "${a[@]}" of an empty array is an "unbound variable" under
// set -u: tools/image/smoke-kits.sh stopped there on its first run on a Mac (T-023). An array
// that starts empty is expanded as ${a[@]+"${a[@]}"}, which is the same on every bash.
describe('bash scripts on a Mac', () => {
  it('[OPS-001] expand arrays that can be empty in the form bash 3.2 accepts under set -u', () => {
    const scripts = [...shellScripts('tools'), ...shellScripts('deploy')];
    expect(scripts).toEqual(
      expect.arrayContaining(['tools/image/smoke-kits.sh', 'tools/image/fresh-vm.sh']),
    );
    const unguarded: string[] = [];
    for (const script of scripts) {
      const text = readFileSync(join(ROOT, script), 'utf8');
      if (!/^set -[a-z]*u/m.test(text)) continue;
      const empty = [...text.matchAll(/^\s*([A-Za-z_]\w*)=\(\)\s*$/gm)].map((m) => m[1] ?? '');
      for (const name of empty) {
        const bare = text.split('\n').filter((line) => {
          const guarded = line.replaceAll(`\${${name}[@]+"\${${name}[@]}"}`, '');
          return guarded.includes(`"\${${name}[@]}"`);
        });
        for (const line of bare) unguarded.push(`${script}: ${line.trim()}`);
      }
    }
    expect(unguarded).toEqual([]);
  });
});
