import openapiTS, { astToString } from 'openapi-typescript';

type Json = Record<string, unknown>;

/**
 * Makes the SDK's generated files from the API document (M1-065; ADR-067): the types of the
 * stable operations (`generated/schema.ts`, by openapi-typescript) and a table of their methods
 * and paths (`generated/operations.ts`). Internal routes are left out: the SDK only offers what
 * keeps its meaning within API v1. `generate.test.ts` checks the committed files are current;
 * `pnpm verify --update` rewrites them after the document changes.
 */
export async function generateSdk(spec: Json): Promise<{ schema: string; operations: string }> {
  const paths: Record<string, Json> = {};
  const table: Record<string, { method: string; path: string; paged: boolean }> = {};
  for (const [path, item] of Object.entries(spec.paths as Record<string, Json>)) {
    for (const [method, operation] of Object.entries(item as Record<string, Json>)) {
      if (operation['x-taskmoor-stability'] !== 'stable') continue;
      paths[path] ??= {};
      (paths[path] as Json)[method] = operation;
      table[operation.operationId as string] = {
        method: method.toUpperCase(),
        path,
        paged: operation['x-taskmoor-paging'] === 'cursor',
      };
    }
  }
  const stable = {
    ...spec,
    paths,
    tags: (spec.tags as Json[]).filter((t) => t.name !== 'Internal'),
  };
  const ast = await openapiTS(stable as never, { exportType: false, alphabetize: true });
  const header =
    '// Generated from docs/api/openapi.json by packages/sdk/src/generate.ts. Do not edit.\n';
  const schema = `${header}${astToString(ast)}`;
  const entries = Object.entries(table)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, o]) => `  ${id}: { method: '${o.method}', path: '${o.path}', paged: ${o.paged} },`)
    .join('\n');
  const operations = `${header}/** Each stable operation's method and path, by operation id. */
export const OPERATIONS = {
${entries}
} as const;

export type OperationId = keyof typeof OPERATIONS;
`;
  return { schema, operations };
}
