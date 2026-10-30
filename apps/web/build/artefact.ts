import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Plugin } from 'vite';
// By path, not by package name: Vite loads its config with Node, which cannot run a workspace
// package's TypeScript, and bundles only relative imports (the boundary rules allow it here).
import { scanText } from '../../../packages/devtools/src/secrets';
import {
  ARTEFACT_NAME,
  type ArtefactManifest,
  buildVersion,
  DEFAULT_RUNTIME_CONFIG,
  MANIFEST_FILE,
  readRuntimeConfig,
} from '../../../packages/webconfig/src/index';

/**
 * The frontend build as a versioned artefact (M1-105, ADR-065). Every production build of the
 * app goes through this plugin, which
 * - refuses to bundle server code: no module from a server-side workspace package, none of the
 *   third-party packages only they depend on, no Node built-in;
 * - writes `version.json`: the version stamped from TASKMOOR_VERSION, the backend's own, and
 *   every file with its size and SHA-256;
 * - checks what it wrote: known file types only, nothing that looks like a secret, and an
 *   index.html whose runtime-config slot is there and still empty, for the deploy to fill.
 */

/** Workspace packages that run on the server or in tooling, never in the browser. */
export const SERVER_SIDE = [
  'apps/server',
  'packages/ai',
  'packages/db',
  'packages/devtools',
  'packages/iam',
  'packages/spikes',
  'packages/storage',
  'packages/testkit',
];

/** File types a static host serves; anything else in the output is a mistake. */
const SHIPPED = /\.(html|js|css|json|svg|png|ico|webp|woff2?|txt)$/;
const TEXT = /\.(html|js|css|json|svg|txt)$/;

export interface ServerCode {
  /** Folders of server-side packages, absolute, with forward slashes and a trailing one. */
  dirs: string[];
  /** Third-party packages only server-side packages depend on. */
  packages: Set<string>;
}

type Manifest = { name: string; dependencies?: object; devDependencies?: object };

/** What must never reach the bundle, read from the workspace's package manifests. */
export function serverCode(root: string): ServerCode {
  const workspace = ['apps', 'packages'].flatMap((dir) =>
    readdirSync(join(root, dir), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(root, dir, e.name, 'package.json')))
      .map((e) => `${dir}/${e.name}`),
  );
  const manifest = (dir: string): Manifest =>
    JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  const serverSide = workspace.filter((d) => SERVER_SIDE.includes(d));
  const browserSide = workspace.filter((d) => !SERVER_SIDE.includes(d));
  const own = new Set(workspace.map((d) => manifest(d).name));
  const allowed = new Set(browserSide.flatMap((d) => Object.keys(manifest(d).dependencies ?? {})));
  const packages = new Set(
    serverSide
      .flatMap((d) => {
        const m = manifest(d);
        return [...Object.keys(m.dependencies ?? {}), ...Object.keys(m.devDependencies ?? {})];
      })
      .filter((name) => !allowed.has(name) && !own.has(name)),
  );
  const dirs = serverSide.map((d) => `${resolve(root, d).replaceAll('\\', '/')}/`);
  return { dirs, packages };
}

/** The package a module id belongs to, by its last node_modules segment. */
function packageOf(id: string): string | null {
  const at = id.lastIndexOf('/node_modules/');
  if (at < 0) return null;
  const [scope = '', name = ''] = id.slice(at + '/node_modules/'.length).split('/');
  return scope.startsWith('@') ? `${scope}/${name}` : scope;
}

/** The modules of a build graph that are server code. */
export function serverModules(ids: Iterable<string>, code: ServerCode): string[] {
  const found: string[] = [];
  for (const raw of ids) {
    const id = (raw.replace(/^\0/, '').split('?')[0] ?? '').replaceAll('\\', '/');
    const builtin = id.startsWith('node:') || id.startsWith('__vite-browser-external');
    const pkg = packageOf(id);
    if (builtin || code.dirs.some((d) => id.startsWith(d)) || (pkg && code.packages.has(pkg))) {
      found.push(id);
    }
  }
  return found;
}

function filesOf(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).replaceAll('\\', '/'))
    .sort();
}

/** Writes `version.json` for the files in `dir` and returns it. */
export function writeManifest(dir: string, version: string): ArtefactManifest {
  const files = filesOf(dir)
    .filter((path) => path !== MANIFEST_FILE)
    .map((path) => {
      const bytes = readFileSync(join(dir, path));
      return {
        path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    });
  const manifest: ArtefactManifest = { name: ARTEFACT_NAME, version, files };
  writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** What is wrong with a built artefact: unexpected files, secrets, an unusable slot. */
export function scanArtefact(dir: string): string[] {
  const problems: string[] = [];
  for (const path of filesOf(dir)) {
    if (!SHIPPED.test(path)) {
      problems.push(`unexpected file ${path}`);
      continue;
    }
    if (!TEXT.test(path)) continue;
    for (const finding of scanText(path, readFileSync(join(dir, path), 'utf8'))) {
      problems.push(`text that looks like a secret (${finding.rule}) in ${path}:${finding.line}`);
    }
  }
  const index = join(dir, 'index.html');
  const slot = existsSync(index) ? readRuntimeConfig(readFileSync(index, 'utf8')) : null;
  if (!slot) {
    problems.push('index.html has no runtime-config slot');
  } else if (JSON.stringify(slot.config) !== JSON.stringify(DEFAULT_RUNTIME_CONFIG)) {
    problems.push('index.html ships with its runtime-config slot filled');
  }
  return problems;
}

export function taskmoorArtefact(options: { root: string; env?: NodeJS.ProcessEnv }): Plugin {
  const env = options.env ?? process.env;
  let enabled = false;
  let outDir = '';
  let version = '';
  let code: ServerCode = { dirs: [], packages: new Set() };
  return {
    name: 'taskmoor-artefact',
    configResolved(config) {
      // The app's own build only: Storybook's build names its own entry page.
      enabled = config.command === 'build' && config.build.rollupOptions.input === undefined;
      outDir = resolve(config.root, config.build.outDir);
    },
    buildStart() {
      if (!enabled) return;
      version = buildVersion(env);
      code = serverCode(options.root);
    },
    // As each module is read, before linking: a Node built-in would otherwise fail the link
    // with a message that does not say where it came from.
    moduleParsed(info) {
      if (!enabled) return;
      const [found] = serverModules([info.id], code);
      if (found === undefined) return;
      const by = info.importers[0] ?? this.getModuleInfo(info.id)?.importers[0];
      this.error(
        `the frontend bundle would include server code:\n  ${found}${by ? `\n  imported by ${by}` : ''}`,
      );
    },
    closeBundle() {
      if (!enabled) return;
      writeManifest(outDir, version);
      const problems = scanArtefact(outDir);
      if (problems.length > 0) {
        throw new Error(`the frontend artefact is not shippable:\n  ${problems.join('\n  ')}`);
      }
    },
  };
}
