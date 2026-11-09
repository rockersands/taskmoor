import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DEV_VERSION, MANIFEST_FILE, parseManifest } from '@taskmoor/webconfig';

/**
 * Whether `pnpm demo` has to build the frontend before serving it (T-211). The build in
 * `apps/web/dist` stays between runs, so a checkout that moved on would serve an older app. It
 * is built again when
 * - there is none (no index.html);
 * - its version stamp (`version.json`, ADR-066) is not the version the server runs with
 *   (TASKMOOR_VERSION, else the development one), a frontend the server would refuse to serve;
 * - a file it is built from is newer than the build: the app's own files (apps/web; tests,
 *   stories, the end-to-end suites and other tools' configuration aside), the sources of the
 *   workspace packages it bundles (its dependencies, and theirs) and the lockfile. A pull or a
 *   branch switch writes every file it changes, so their times move past the build's.
 */
export type FrontendBuild =
  | { reason: 'missing' }
  | { reason: 'version'; built: string | null; wanted: string }
  | { reason: 'sources'; file: string };

/** Folders of the app that never reach the build. */
const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-builder',
  'e2e',
  'e2e-fresh',
  'test-results',
  'playwright-report',
  'storybook-static',
  'coverage',
  '__golden__',
  '__fixtures__',
  '__screenshots__',
  '__snapshots__',
]);

/** Tests, stories and other tools' configuration; dotfiles (.storybook, .DS_Store) too. */
const skippedFile = (name: string) =>
  name.startsWith('.') ||
  /\.(test|spec|stories)\.[cm]?[jt]sx?$/.test(name) ||
  /^(vitest|playwright)\b.*\.config\.[cm]?[jt]s$/.test(name) ||
  // The Builder page has its own build, into dist-builder.
  /^vite\.builder\.config\.[cm]?[jt]s$/.test(name);

interface Newest {
  path: string;
  mtimeMs: number;
}

function newestIn(path: string, found: Newest | null): Newest | null {
  if (!existsSync(path)) return found;
  const stats = statSync(path);
  if (stats.isFile()) {
    return found === null || stats.mtimeMs > found.mtimeMs
      ? { path, mtimeMs: stats.mtimeMs }
      : found;
  }
  if (!stats.isDirectory()) return found;
  let newest = found;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !SKIPPED_DIRS.has(entry.name)) {
        newest = newestIn(join(path, entry.name), newest);
      }
    } else if (entry.isFile() && !skippedFile(entry.name)) {
      newest = newestIn(join(path, entry.name), newest);
    }
  }
  return newest;
}

type Manifest = { name?: string; dependencies?: Record<string, string> };
const readJson = (path: string): Manifest => JSON.parse(readFileSync(path, 'utf8')) as Manifest;

/** The folders of the workspace packages the app bundles: its dependencies, and theirs. */
function bundledPackages(root: string, app: string): string[] {
  const byName = new Map<string, string>();
  for (const group of ['apps', 'packages']) {
    const dir = join(root, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const manifest = join(dir, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      const name = readJson(manifest).name;
      if (name) byName.set(name, join(dir, entry.name));
    }
  }
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const [name, range] of Object.entries(
      readJson(join(dir, 'package.json')).dependencies ?? {},
    )) {
      const found = byName.get(name);
      if (!range.startsWith('workspace:') || found === undefined || out.includes(found)) continue;
      out.push(found);
      visit(found);
    }
  };
  visit(app);
  return out;
}

/** What the build in `apps/web/dist` lacks, or null when it is the checkout's own. */
export function frontendBuildNeeded(
  root: string,
  env: Record<string, string | undefined> = process.env,
): FrontendBuild | null {
  const app = join(root, 'apps', 'web');
  const dist = join(app, 'dist');
  const index = join(dist, 'index.html');
  if (!existsSync(index)) return { reason: 'missing' };
  const wanted = env.TASKMOOR_VERSION?.trim() || DEV_VERSION;
  const manifestPath = join(dist, MANIFEST_FILE);
  let built: string | null = null;
  try {
    built = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8'))).version;
  } catch {
    // No manifest, or one that is not: not a build this server can serve.
  }
  if (built !== wanted) return { reason: 'version', built, wanted };
  const builtAt = Math.min(statSync(index).mtimeMs, statSync(manifestPath).mtimeMs);
  let newest = newestIn(app, null);
  for (const dir of bundledPackages(root, app)) {
    newest = newestIn(join(dir, 'src'), newest);
    newest = newestIn(join(dir, 'package.json'), newest);
  }
  newest = newestIn(join(root, 'pnpm-lock.yaml'), newest);
  if (newest === null || newest.mtimeMs <= builtAt) return null;
  return { reason: 'sources', file: relative(root, newest.path).split(sep).join('/') };
}

/** What `pnpm demo` says before it builds. */
export function buildMessage(build: FrontendBuild): string {
  switch (build.reason) {
    case 'missing':
      return 'Building the frontend (once, about a minute)...';
    case 'version':
      return `Building the frontend again: it was built as ${build.built ?? 'no version'}, the server runs ${build.wanted} (about a minute)...`;
    case 'sources':
      return `Building the frontend again: ${build.file} changed after it was built (about a minute)...`;
  }
}
