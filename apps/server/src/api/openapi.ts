import { type ZodType, z } from 'zod';
import { SESSION_COOKIE } from '../auth';
import { routeAccess } from '../tokens/scopes';
import { errorBody, type Operation } from './operation';

/** The contract's version: its major number changes only with a breaking change (ADR-067). */
export const API_VERSION = '1.0.0';

type Json = Record<string, unknown>;

/** `/api/v1/tickets/:id` as OpenAPI writes it: `/api/v1/tickets/{id}`. */
export const openApiPath = (path: string) => path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}');

/** The route table's key for an operation. */
export const routeKey = (operation: Pick<Operation, 'method' | 'path'>) =>
  `${operation.method} ${operation.path}`;

/**
 * Turns a zod schema into JSON Schema 2020-12 (OpenAPI 3.1's dialect). Named schemas (those with
 * `.meta({ id })`) go to `components.schemas` and are referred to from there.
 */
function schemaOf(schema: ZodType, io: 'input' | 'output', components: Json): Json {
  const out = z.toJSONSchema(schema, {
    io,
    unrepresentable: 'any',
    target: 'draft-2020-12',
  }) as Json;
  const defs = (out.$defs ?? {}) as Record<string, Json>;
  delete out.$schema;
  delete out.$defs;
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Json).map(([k, v]) => [
        k,
        k === '$ref' && typeof v === 'string'
          ? v.replace('#/$defs/', '#/components/schemas/')
          : rewrite(v),
      ]);
      return Object.fromEntries(entries);
    }
    return value;
  };
  for (const [name, def] of Object.entries(defs)) {
    const { $schema: _drop, ...rest } = def;
    components[name] = rewrite(rest);
  }
  // A schema that is itself named becomes a reference to its component.
  const id = (out.id ?? undefined) as string | undefined;
  if (id) {
    const { id: _id, ...rest } = out;
    components[id] = rewrite(rest);
    return { $ref: `#/components/schemas/${id}` };
  }
  return rewrite(out) as Json;
}

const STANDARD_ERRORS: Record<number, string> = {
  400: 'The request is not valid: see `error` and, for fields, `fields`.',
  401: 'No session or token, or an expired one.',
  403: 'The session or token may not do this (its scope, or the person’s permissions).',
  404: 'There is no such resource, or the caller may not see it.',
  409: 'The resource changed or is in a state that refuses this; read it again.',
};

function security(method: string, path: string): Json[] {
  const access = routeAccess(method, path);
  if (access === 'public') return [];
  if (access === 'session') return [{ session: [] }];
  return [{ session: [] }, { token: [access] }];
}

/** The whole OpenAPI 3.1 document: the stable operations in full, every other route as internal. */
export function buildOpenApi(stable: readonly Operation[], routeTable: readonly string[]): Json {
  const components: Json = {};
  const paths: Record<string, Record<string, Json>> = {};
  const documented = new Set(stable.map(routeKey));
  const errorRef = schemaOf(errorBody, 'output', components);

  for (const op of stable) {
    const path = openApiPath(op.path);
    const params: Json[] = [];
    for (const name of [...op.path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map(
      (m) => m[1] as string,
    )) {
      params.push({
        name,
        in: 'path',
        required: true,
        description: op.params?.[name] ?? `The ${name}.`,
        schema: { type: 'string' },
      });
    }
    if (op.query) {
      const q = schemaOf(op.query, 'input', components) as {
        properties?: Record<string, Json>;
        required?: string[];
      };
      for (const [name, schema] of Object.entries(q.properties ?? {})) {
        const { description, ...rest } = schema as Json & { description?: string };
        params.push({
          name,
          in: 'query',
          required: (q.required ?? []).includes(name),
          ...(description ? { description } : {}),
          schema: rest,
        });
      }
    }
    const responses: Json = {};
    for (const [status, response] of Object.entries(op.responses)) {
      responses[status] = {
        description: response.description,
        ...(response.schema
          ? {
              content: {
                'application/json': { schema: schemaOf(response.schema, 'output', components) },
              },
            }
          : {}),
      };
    }
    const access = routeAccess(op.method, op.path);
    for (const [status, description] of Object.entries(STANDARD_ERRORS)) {
      const code = Number(status);
      if (code === 400 && !op.query && !op.body && op.method === 'GET') continue;
      if (code === 401 && access === 'public') continue;
      if (code === 404 && params.every((p) => p.in !== 'path')) continue;
      if (code === 409 && op.method === 'GET') continue;
      responses[status] ??= { description, content: { 'application/json': { schema: errorRef } } };
    }
    paths[path] ??= {};
    (paths[path] as Record<string, Json>)[op.method.toLowerCase()] = {
      operationId: op.id,
      tags: [op.tag],
      summary: op.summary,
      ...(op.description ? { description: op.description } : {}),
      ...(params.length > 0 ? { parameters: params } : {}),
      ...(op.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: schemaOf(op.body, 'input', components) } },
            },
          }
        : {}),
      responses,
      security: security(op.method, op.path),
      'x-taskmoor-stability': 'stable',
      'x-taskmoor-access': access,
      ...(op.paged ? { 'x-taskmoor-paging': 'cursor' } : {}),
    };
  }

  // Every other route, so nothing the server answers is missing from the document.
  for (const key of [...routeTable].sort()) {
    if (documented.has(key)) continue;
    const [method, raw] = key.split(' ') as [string, string];
    if (!raw.startsWith('/api/v1/') || method === 'HEAD' || method === 'OPTIONS') continue;
    const path = openApiPath(raw);
    const slug = raw
      .replace('/api/v1/', '')
      .replace(/:([A-Za-z0-9]+)/g, 'by-$1')
      .replace(/[^A-Za-z0-9]+/g, '-');
    paths[path] ??= {};
    (paths[path] as Record<string, Json>)[method.toLowerCase()] = {
      operationId: `internal-${method.toLowerCase()}-${slug}`.replace(/-+$/, ''),
      tags: ['Internal'],
      summary: 'Internal route of the web app; it may change in any release.',
      ...([...raw.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].length > 0
        ? {
            parameters: [...raw.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((m) => ({
              name: m[1],
              in: 'path',
              required: true,
              schema: { type: 'string' },
            })),
          }
        : {}),
      responses: {
        default: {
          description: 'The route’s answer; refusals have the shared error shape.',
          content: { 'application/json': { schema: errorRef } },
        },
      },
      security: security(method, raw),
      'x-taskmoor-stability': 'internal',
      'x-taskmoor-access': routeAccess(method, raw),
    };
  }

  const sortedPaths = Object.fromEntries(
    Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)),
  );
  return {
    openapi: '3.1.0',
    info: {
      title: 'Taskmoor API',
      version: API_VERSION,
      description:
        'The native REST API of Taskmoor. Stable operations keep their meaning within a major version; internal routes serve the web app and may change in any release. See docs/api/README.md.',
      license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
    },
    servers: [
      {
        url: 'http://localhost:8080',
        description: 'A local install; use your own server\u2019s address.',
      },
    ],
    tags: [...new Set(stable.map((o) => o.tag))]
      .sort()
      .map((name) => ({ name }))
      .concat([{ name: 'Internal' }]),
    paths: sortedPaths,
    components: {
      schemas: Object.fromEntries(
        Object.entries(components).sort(([a], [b]) => a.localeCompare(b)),
      ),
      securitySchemes: {
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: SESSION_COOKIE,
          description: 'A browser session, made by `POST /api/v1/session`.',
        },
        token: {
          type: 'http',
          scheme: 'bearer',
          description:
            'An API token of a person or a service account, with scopes `read`, `write`, `admin` or `scim` (ADR-035).',
        },
      },
    },
  };
}
