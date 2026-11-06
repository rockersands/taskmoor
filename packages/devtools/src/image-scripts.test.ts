import { execFileSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importedLinkRoute } from '@taskmoor/webconfig';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SMOKE = readFileSync(join(ROOT, 'tools/image/smoke.sh'), 'utf8');
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

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

// smoke.sh held `docker image inspect`'s Size to the 400 MB limit of ADR-021. With the
// containerd image store (Docker 29) that is the compressed download: 96 MB on the T-023 Mac for
// an image of about 365 MB, so the limit was never checked there (T-023 review). The scripts
// measure the image's files inside it instead, the same on every image store.
describe('the image size the smoke scripts report', () => {
  it('[OPS-013] is the unpacked size, measured inside the image', () => {
    for (const script of ['tools/image/smoke.sh', 'tools/image/smoke-kits.sh']) {
      const text = readFileSync(join(ROOT, script), 'utf8');
      expect({ script, dockerSize: text.includes('{{.Size}}') }).toEqual({
        script,
        dockerSize: false,
      });
      expect({
        script,
        measured:
          /--entrypoint node "\$\w+" --input-type=module - \\\n\s*<tools\/image\/unpacked-size\.mjs\)/.test(
            text,
          ),
      }).toEqual({ script, measured: true });
    }
    expect(SMOKE).toMatch(/^if \[ "\$size" -gt 400000000 \]; then echo "image over 400 MB"/m);
  });

  it('[OPS-013] counts each file and link once, without the mounts a container adds', () => {
    const root = mkdtempSync(join(tmpdir(), 'taskmoor-image-'));
    dirs.push(root);
    mkdirSync(join(root, 'app/lib'), { recursive: true });
    writeFileSync(join(root, 'app/lib/a.js'), 'a'.repeat(1000));
    writeFileSync(join(root, 'app/b.json'), 'b'.repeat(234));
    // A hard link is the same bytes once; a symbolic link holds its target's path.
    linkSync(join(root, 'app/b.json'), join(root, 'app/b-again.json'));
    const symlinks = process.platform !== 'win32';
    if (symlinks) symlinkSync('lib/a.js', join(root, 'app/c.js'));
    // What Docker mounts into a container: /proc, a volume (here with a space), /etc/hosts.
    mkdirSync(join(root, 'proc'));
    writeFileSync(join(root, 'proc/kcore'), 'k'.repeat(5000));
    mkdirSync(join(root, 'data dir'));
    writeFileSync(join(root, 'data dir/x'), 'x'.repeat(700));
    writeFileSync(join(root, 'hosts'), 'h'.repeat(50));
    const mount = (path: string) => join(root, path).replaceAll(' ', '\\040');
    const table = join(root, '..', `${root.split(/[\\/]/).pop()}.mounts`);
    dirs.push(table);
    writeFileSync(
      table,
      [
        'overlay / overlay rw 0 0',
        `proc ${mount('proc')} proc rw 0 0`,
        `/dev/vda1 ${mount('data dir')} ext4 rw 0 0`,
        `/dev/vda1 ${mount('hosts')} ext4 rw 0 0`,
        '',
      ].join('\n'),
    );
    const out = execFileSync(
      process.execPath,
      [join(ROOT, 'tools/image/unpacked-size.mjs'), root, table],
      { encoding: 'utf8' },
    );
    expect(Number(out.trim())).toBe(1000 + 234 + (symlinks ? 'lib/a.js'.length : 0));
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

// A container removed with `docker rm` keeps the anonymous volumes of the image's VOLUME lines
// (Taskmoor's /data, PostgreSQL's data directory), even one started with --rm: the T-023 runs
// left 20 behind. The image and air-gap scripts remove them with the container.
describe('image and air-gap scripts', () => {
  it('[OPS-001] remove their containers with their anonymous volumes', () => {
    const scripts = [...shellScripts('tools/image'), ...shellScripts('tools/airgap')];
    expect(scripts).toEqual(
      expect.arrayContaining(['tools/image/smoke.sh', 'tools/airgap/bundle.sh']),
    );
    const keeping = scripts.flatMap((script) =>
      readFileSync(join(ROOT, script), 'utf8')
        .split('\n')
        .filter((line) => /\bdocker rm\b/.test(line) && !/\bdocker rm (-f )?-v\b/.test(line))
        .map((line) => `${script}: ${line.trim()}`),
    );
    expect(keeping).toEqual([]);
  });

  // smoke-kits.sh removed its network before the external kit's container that was still on it;
  // Docker refuses that, so every run left a network behind (T-023 found six).
  it('[OPS-001] remove their containers before the networks they were on', () => {
    const checked: string[] = [];
    const early: string[] = [];
    for (const script of [...shellScripts('tools/image'), ...shellScripts('tools/airgap')]) {
      const body = /^cleanup\(\) \{\n([\s\S]*?)^\}/m.exec(
        readFileSync(join(ROOT, script), 'utf8'),
      )?.[1];
      if (!body) continue;
      checked.push(script);
      const lines = body.split('\n');
      const lastRm = lines.reduce((last, line, i) => (/\bdocker rm\b/.test(line) ? i : last), -1);
      lines.forEach((line, i) => {
        if (/\bdocker network rm\b/.test(line) && i < lastRm)
          early.push(`${script}: ${line.trim()}`);
      });
    }
    expect(checked).toEqual(expect.arrayContaining(['tools/image/smoke-kits.sh']));
    expect(early).toEqual([]);
  });

  // fresh-vm.sh tagged the image as the version its kit pins and left the tag, so every run
  // kept the build before it alive once smoke.sh replaced taskmoor:dev (T-023). A tag made on
  // fresh-vm.sh's own machine (`docker exec "$VM" docker tag`) goes with that machine.
  it('[OPS-001] remove the tags they add', () => {
    const scripts = [...shellScripts('tools/image'), ...shellScripts('tools/airgap')];
    const tagging: string[] = [];
    const left: string[] = [];
    for (const script of scripts) {
      const text = readFileSync(join(ROOT, script), 'utf8');
      const here = text
        .split('\n')
        .filter((line) => !/\bdocker exec\b.*\bdocker tag\b/.test(line))
        .join('\n');
      for (const [, name = ''] of here.matchAll(/\bdocker tag \S+ "\$(\w+)"/g)) {
        tagging.push(script);
        // The tag's own variable, or one the script copies it into for its clean-up.
        const names = [
          name,
          ...[...text.matchAll(new RegExp(`^\\s*(\\w+)=\\$${name}\\s*$`, 'gm'))].map(
            (m) => m[1] ?? '',
          ),
        ];
        const removed = text
          .split('\n')
          .some(
            (line) => /\bdocker rmi\b/.test(line) && names.some((n) => line.includes(`"$${n}"`)),
          );
        if (!removed) left.push(`${script}: ${name}`);
      }
    }
    expect(tagging).toEqual(expect.arrayContaining(['tools/airgap/test-offline.sh']));
    expect(left).toEqual([]);
  });

  // The clean-up of fresh-vm.sh removed the name its kit pins, which can be the image under
  // test itself (TAG=ghcr.io/rockersands/taskmoor:1.0.0) or one pulled before the run: Docker
  // then deleted that image (T-023 review). A script removes only names it made up for its own
  // run from its process id, which nothing else can have held before.
  it('[OPS-001] remove only names made up for the run', () => {
    const scripts = [...shellScripts('tools/image'), ...shellScripts('tools/airgap')];
    const removing: string[] = [];
    const shared: string[] = [];
    for (const script of scripts) {
      const text = readFileSync(join(ROOT, script), 'utf8');
      // The run's id: $$, or a variable that holds it.
      const ids = ['$$', ...[...text.matchAll(/^\s*(\w+)=\$\$\s*$/gm)].map((m) => `$${m[1]}`)];
      for (const line of text.split('\n').filter((l) => /\bdocker rmi\b/.test(l))) {
        removing.push(script);
        for (const [, name = ''] of line.matchAll(/"\$\{?(\w+)\}?"/g)) {
          const values = [...text.matchAll(new RegExp(`^\\s*${name}=(\\S+)`, 'gm'))].map(
            (m) => m[1] ?? '',
          );
          const own = values.length > 0 && values.every((v) => ids.some((id) => v.includes(id)));
          if (!own) shared.push(`${script}: ${name}`);
        }
      }
    }
    expect(removing).toEqual(expect.arrayContaining(['tools/airgap/test-offline.sh']));
    expect(shared).toEqual([]);
  });

  it('[OPS-015] fresh-vm.sh tags the stand-in for the pinned image on the fresh machine only', () => {
    const lines = readFileSync(join(ROOT, 'tools/image/fresh-vm.sh'), 'utf8').split('\n');
    const tags = lines.filter((line) => /\bdocker tag\b/.test(line)).map((line) => line.trim());
    expect(tags).toEqual(['docker exec "$VM" docker tag "$TAG" "$pinned"']);
    expect(lines.filter((line) => /\bdocker rmi\b/.test(line))).toEqual([]);
  });
});
