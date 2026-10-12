/**
 * Serialises a value with object keys sorted at every level, so golden files change only when
 * the content changes. Use it with Vitest file snapshots:
 *
 *   await expect(stableJson(value)).toMatchFileSnapshot('./__golden__/name.json');
 *
 * `pnpm test -u` rewrites golden files; CI never writes them, so a missing one fails there.
 */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}
