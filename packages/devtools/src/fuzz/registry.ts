/**
 * Every `pnpm fuzz` target and the file that defines it, relative to the repository root (M1-118,
 * ADR-104). Files are named by path, not imported: devtools may not import the server, and the
 * runner loads each target in a worker of its own. `query` and `formula` run in process.
 */
export const FUZZ_TARGET_FILES: Record<string, { module?: string; what: string }> = {
  query: { what: 'the query parser (M1-034)' },
  formula: { what: 'the formula language (M1-013)' },
  text: { module: 'packages/devtools/src/fuzz/targets.ts', what: 'the text search syntax' },
  href: { module: 'packages/devtools/src/fuzz/targets.ts', what: 'link targets' },
  wiki: { module: 'packages/devtools/src/fuzz/targets.ts', what: 'wiki markup' },
  markdown: { module: 'packages/devtools/src/fuzz/targets.ts', what: 'Markdown' },
  adf: {
    module: 'packages/devtools/src/fuzz/targets.ts',
    what: 'the Jira-compatible document format',
  },
  csv: { module: 'apps/server/src/fuzz/targets.ts', what: 'the CSV import reader' },
  'dc-xml': { module: 'apps/server/src/fuzz/targets.ts', what: 'the DC backup XML reader' },
  'dc-stage': { module: 'apps/server/src/fuzz/targets.ts', what: 'DC backup staging' },
  scim: { module: 'apps/server/src/fuzz/targets.ts', what: 'SCIM filters and paths' },
  addresses: {
    module: 'apps/server/src/fuzz/targets.ts',
    what: 'webhook, OAuth redirect and frontend origin addresses',
  },
  'rich-text': { module: 'apps/server/src/fuzz/targets.ts', what: 'rich text on the API' },
};
