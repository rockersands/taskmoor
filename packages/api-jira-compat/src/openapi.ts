import { z } from 'zod';
import { COMPAT_OPERATIONS, type CompatOperation, type Version } from './operations';
import { jiraError } from './schemas';

/**
 * Taskmoor's own OpenAPI 3.1 document of the Jira-compatible API (M1-068; ADR-085), made from
 * `operations.ts`: one path per operation and version, its summary and description in our own
 * words, and its sources and open questions as `x-sources` and `x-verify`. It is a description
 * of what Taskmoor serves for compatibility, written from public pages; it is not Atlassian's
 * document and copies nothing from it (ADR-003).
 */
type Json = Record<string, unknown>;

function schemaOf(schema: z.ZodType, components: Json): Json {
  const out = z.toJSONSchema(schema, { unrepresentable: 'any', target: 'draft-2020-12' }) as Json;
  const defs = (out.$defs ?? {}) as Record<string, Json>;
  delete out.$schema;
  delete out.$defs;
  for (const [name, def] of Object.entries(defs)) components[name] = def;
  return JSON.parse(JSON.stringify(out).replaceAll('#/$defs/', '#/components/schemas/')) as Json;
}

const pick = (
  schema: z.ZodType | ((version: Version) => z.ZodType),
  version: Version,
): z.ZodType => (schema instanceof z.ZodType ? schema : schema(version));

function operationDoc(o: CompatOperation, version: Version, components: Json): Json {
  const params = [...o.path.matchAll(/\{([A-Za-z]+)\}/g)]
    .map((m) => m[1] as string)
    .filter((name) => name !== 'v')
    .map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } }));
  const responses: Json = {};
  for (const [status, response] of Object.entries(o.responses)) {
    responses[status] = {
      description: response.description,
      ...(response.schema
        ? {
            content: {
              'application/json': { schema: schemaOf(pick(response.schema, version), components) },
            },
          }
        : {}),
    };
  }
  responses.default = {
    description: 'A refusal, as a Jira-compatible error.',
    content: { 'application/json': { schema: schemaOf(jiraError, components) } },
  };
  return {
    operationId: o.versions.length > 1 ? `${o.id}V${version}` : o.id,
    tags: [o.family],
    summary: o.summary,
    ...(o.description ? { description: o.description } : {}),
    ...(params.length > 0 ? { parameters: params } : {}),
    ...(o.body
      ? {
          requestBody: {
            content: {
              'application/json': { schema: schemaOf(pick(o.body, version), components) },
            },
          },
        }
      : {}),
    responses,
    'x-sources': o.sources,
    ...(o.verify ? { 'x-verify': o.verify } : {}),
  };
}

export function buildCompatOpenApi(
  operations: readonly CompatOperation[] = COMPAT_OPERATIONS,
): Json {
  const components: Json = {};
  const paths: Record<string, Json> = {};
  for (const o of operations) {
    for (const version of o.versions) {
      const path = o.path.replace('{v}', version);
      paths[path] ??= {};
      (paths[path] as Json)[o.method.toLowerCase()] = operationDoc(o, version, components);
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Taskmoor Jira-compatible API',
      version: '1.0.0',
      description:
        'What Taskmoor serves for scripts and tools written for Jira (ADR-016, ADR-085), in its own words and from public pages, which each operation names under `x-sources`. `x-verify` marks what those pages left open. Rich text is wiki markup on version 2 and the Jira-compatible document format on version 3.',
    },
    paths,
    components: { schemas: components },
  };
}
