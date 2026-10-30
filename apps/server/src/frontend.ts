import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { Database } from '@taskmoor/db';
import {
  fillRuntimeConfig,
  MANIFEST_FILE,
  parseManifest,
  type RoutingMode,
  readRuntimeConfig,
} from '@taskmoor/webconfig';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import { INSTANCE_KEY, readSetting } from './setup';

export interface FrontendOptions {
  /** The frontend artefact: the folder `pnpm build` writes to apps/web/dist. */
  webDir: string;
  /** This backend's version; the artefact must carry the same one. */
  version: string;
  routing: RoutingMode;
  /** Where browsers reach this instance; its path is the app's base path. */
  publicUrl: string;
  /** For the instance name in the page; without one the page has none. */
  db?: Kysely<Database>;
}

/** The base path browsers see the app under: PUBLIC_URL's path, with a trailing slash. */
export function basePathOf(publicUrl: string): string {
  return new URL(publicUrl).pathname.replace(/\/*$/, '/');
}

/**
 * Reads the artefact in a web directory and checks it can run with this backend: an index.html
 * with the runtime-config slot, and a manifest of this very version (M1-105, ADR-066).
 */
export function checkArtefact(webDir: string, version: string): { template: string } {
  const root = resolve(webDir);
  const index = resolve(root, 'index.html');
  if (!existsSync(index)) throw new Error(`TASKMOOR_WEB_DIR has no index.html: ${root}`);
  const manifestPath = resolve(root, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `TASKMOOR_WEB_DIR has no ${MANIFEST_FILE}, so it is no frontend build: ${root}`,
    );
  }
  const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  if (manifest.version !== version) {
    throw new Error(
      `TASKMOOR_WEB_DIR holds frontend ${manifest.version} but this server is ${version}: ` +
        'serve the frontend built with this version',
    );
  }
  const template = readFileSync(index, 'utf8');
  if (!readRuntimeConfig(template)) {
    throw new Error(`index.html in TASKMOOR_WEB_DIR has no runtime-config slot: ${root}`);
  }
  return { template };
}

/**
 * The static frontend in single-server mode (ADR-021, OPS-017): the artefact built with this
 * backend, its files as they are (hashed assets cached for a year), and index.html with the
 * runtime-config slot filled for this instance (routing mode, base path, the name given at
 * setup). Every other GET for a page is a deep link: with clean URLs it gets the app shell, so
 * /boards/7 loads; with hash routing it is redirected to its hash route, /#/boards/7. API and
 * probe paths, and requests that do not want HTML, keep their JSON 404.
 */
export async function serveFrontend(app: FastifyInstance, options: FrontendOptions): Promise<void> {
  const { template } = checkArtefact(options.webDir, options.version);
  const basePath = basePathOf(options.publicUrl);
  const { db, routing } = options;

  const instanceName = async (): Promise<string> => {
    if (!db) return '';
    try {
      return (await readSetting<{ name?: string }>(db, INSTANCE_KEY))?.name ?? '';
    } catch {
      // The page still loads while the database is away; the name comes back with it.
      return '';
    }
  };
  const shell = async (reply: FastifyReply) => {
    const html = fillRuntimeConfig(template, {
      routing,
      basePath,
      instanceName: await instanceName(),
    });
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(html);
  };

  await app.register(fastifyStatic, {
    root: resolve(options.webDir),
    wildcard: false,
    index: false,
    // index.html only ever goes out filled.
    globIgnore: ['index.html'],
    setHeaders: (reply, path) => {
      const immutable = /[\\/]assets[\\/][^\\/]+$/.test(path);
      reply.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  app.get('/', (_request, reply) => shell(reply));
  app.get('/index.html', (_request, reply) => shell(reply));

  app.setNotFoundHandler((request, reply) => {
    const at = request.url.indexOf('?');
    const path = at < 0 ? request.url : request.url.slice(0, at);
    const query = at < 0 ? '' : request.url.slice(at);
    const isPage =
      request.method === 'GET' &&
      !path.startsWith('/api/') &&
      path !== '/health' &&
      path !== '/ready' &&
      (request.headers.accept ?? '').includes('text/html');
    if (isPage && routing === 'path') return shell(reply);
    if (isPage) return reply.redirect(`${basePath}#${path}${query}`, 302);
    return reply.code(404).send({
      message: `Route ${request.method}:${path} not found`,
      error: 'Not Found',
      statusCode: 404,
    });
  });
}
